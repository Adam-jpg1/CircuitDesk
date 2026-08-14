// ESP-01 — the AT modem a board talks to, and nothing behind it.
//
// An ESP-01 on a project is, from the board's side, a serial device that
// answers AT commands. That part is modelled properly: the command parser, the
// echo, the mode and association state machine, the multi-line responses real
// firmware emits, and ERROR for anything unrecognised.
//
// What is NOT here, stated first because the part exists to do it: there is no
// network. No TCP, no UDP, no DNS, no HTTP, no packets, no host to reach.
// AT+CIPSTART therefore FAILS — deliberately, with the ERROR and CLOSED a real
// module gives when it cannot open a socket — rather than answering CONNECT
// and OK to a connection that does not exist. A canned success would be worse
// than useless: a sketch would appear to post to a server, print its own
// hopeful log line, and behave completely differently the moment it ran on a
// bench. The coverage matrix records `network-stack` as the blocker, and this
// will only change when a virtual network exists for it to attach to.
//
// The association state is simulated and configured on the part: the module
// knows about one simulated access point, whose SSID and password the user
// sets. Joining it works when the credentials match and fails when they do
// not, which is enough to exercise the retry logic every ESP-01 sketch has.
// Nothing scans a real radio and nothing touches a real network interface.
//
// There is no nested ESP8266 running inside this. The module does not execute
// Espressif firmware; it answers the protocol that firmware speaks.
//
// NOT modelled beyond the above: the SDK's binary +IPD path, passthrough mode,
// SSL, SmartConfig, sleep modes, the 74880-baud boot log, and per-command
// timing (a real AT+CWJAP takes seconds; here it answers at once).

import { DEFAULT_UART, type UartConfig, type UartPeripheral } from './uartEndpoint';
import type { DeviceSnapshot } from './types';

export type Esp01Mode = 1 | 2 | 3; // station, soft-AP, both

/** The one access point this module can see. Simulated, never scanned. */
export interface SimulatedAccessPoint {
  ssid: string;
  password: string;
}

export const DEFAULT_ACCESS_POINT: SimulatedAccessPoint = {
  ssid: 'SimulatedAP',
  password: 'simulated',
};

export class Esp01Device implements UartPeripheral {
  readonly instanceId: string;
  private config: UartConfig;

  /** CH_PD low holds the module in reset; it answers nothing at all. */
  private enabled = false;
  private mode: Esp01Mode = 1;
  private echo = true;
  private joined = false;
  private multiplex = false;

  private ap: SimulatedAccessPoint = { ...DEFAULT_ACCESS_POINT };
  /** A simulated address, handed out on join. Not on any real network. */
  private readonly ip = '192.168.4.2';
  private readonly mac = '5c:cf:7f:00:00:01';

  private outbound: number[] = [];
  private lineBuffer = '';

  private commands = 0;
  private unknownCommands: string[] = [];
  /** Connection attempts that could not succeed, for the inspector to explain. */
  private refusedConnections = 0;
  private log: string[] = [];

  constructor(instanceId: string, baud = 115200) {
    this.instanceId = instanceId;
    this.config = { ...DEFAULT_UART, baud };
  }

  uartConfig(): UartConfig {
    return this.config;
  }
  setBaud(baud: number): void {
    this.config = { ...this.config, baud };
  }

  /**
   * Whether the module is running, from the solved circuit.
   *
   * CH_PD high and RST not held low. Both are real wires and both are the
   * classic ESP-01 mistake: a module with CH_PD left floating answers nothing,
   * and a sketch that gets no reply to `AT` is looking at a wiring fault, not
   * at a firmware one. Releasing either emits the `ready` banner a real module
   * prints on boot, which is what libraries wait for.
   */
  setChipEnable(high: boolean): void {
    if (high === this.enabled) return;
    this.enabled = high;
    this.lineBuffer = '';
    if (high) {
      this.mode = 1;
      this.echo = true;
      this.reply('ready');
      this.note('powered up');
    } else {
      this.outbound = [];
      this.joined = false;
      this.note('held in reset — CH_PD low or RST asserted');
    }
  }

  setAccessPoint(ap: Partial<SimulatedAccessPoint>): void {
    const next = { ...this.ap, ...ap };
    if (next.ssid === this.ap.ssid && next.password === this.ap.password) return;
    this.ap = next;
    // Changing the AP out from under a joined module drops it, as moving out
    // of range would.
    if (this.joined) {
      this.joined = false;
      this.note('the access point changed — association dropped');
    }
  }

  onByteFromBoard(byte: number): void {
    if (!this.enabled) return;
    const ch = String.fromCharCode(byte);
    if (ch === '\r') return;
    if (ch === '\n') {
      this.handleCommand(this.lineBuffer);
      this.lineBuffer = '';
      return;
    }
    this.lineBuffer += ch;
    if (this.lineBuffer.length > 240) {
      this.lineBuffer = '';
      this.reply('ERROR');
    }
  }

  takeBytesForBoard(): number[] {
    const out = this.outbound;
    this.outbound = [];
    return out;
  }

  private reply(text: string): void {
    for (const ch of `${text}\r\n`) this.outbound.push(ch.charCodeAt(0));
  }

  private handleCommand(raw: string): void {
    const line = raw.trim();
    if (line.length === 0) return;
    // A real module echoes the command back before answering unless ATE0 has
    // turned it off, and every library has to cope with that. Modelling it
    // means a parser written against this one still works on a bench.
    if (this.echo) this.reply(line);
    this.commands++;
    const upper = line.toUpperCase();

    if (upper === 'AT') return this.reply('OK');

    if (upper === 'ATE0' || upper === 'ATE1') {
      this.echo = upper.endsWith('1');
      return this.reply('OK');
    }

    if (upper === 'AT+RST') {
      this.reply('OK');
      this.joined = false;
      this.reply('ready');
      return;
    }

    if (upper === 'AT+GMR') {
      this.reply('AT version:1.7.4.0');
      this.reply('SDK version:3.0.4');
      return this.reply('OK');
    }

    if (upper.startsWith('AT+CWMODE')) return this.cwmode(line, upper);
    if (upper === 'AT+CWLAP') return this.cwlap();
    if (upper.startsWith('AT+CWJAP')) return this.cwjap(line, upper);
    if (upper === 'AT+CWQAP') {
      this.joined = false;
      this.reply('WIFI DISCONNECT');
      return this.reply('OK');
    }

    if (upper === 'AT+CIFSR') {
      if (!this.joined) return this.reply('ERROR');
      this.reply(`+CIFSR:STAIP,"${this.ip}"`);
      this.reply(`+CIFSR:STAMAC,"${this.mac}"`);
      return this.reply('OK');
    }

    if (upper.startsWith('AT+CIPMUX')) {
      if (upper.includes('=')) this.multiplex = line.slice(line.indexOf('=') + 1).trim() === '1';
      else this.reply(`+CIPMUX:${this.multiplex ? 1 : 0}`);
      return this.reply('OK');
    }

    if (upper === 'AT+CIPSTATUS') {
      // 2 = got an address, 5 = not connected. There is deliberately no state
      // 3 ("connected to a server") because nothing can be.
      this.reply(`STATUS:${this.joined ? 2 : 5}`);
      return this.reply('OK');
    }

    if (upper.startsWith('AT+CIPSTART')) return this.cipstart();
    if (upper.startsWith('AT+CIPSEND') || upper.startsWith('AT+CIPCLOSE')) {
      // Nothing was ever open, so these fail the way they fail with no link.
      this.reply('link is not valid');
      return this.reply('ERROR');
    }

    this.unknownCommands.push(line);
    this.reply('ERROR');
  }

  private cwmode(line: string, upper: string): void {
    if (upper.includes('?')) {
      this.reply(`+CWMODE:${this.mode}`);
      return this.reply('OK');
    }
    const value = Number(line.slice(line.indexOf('=') + 1).trim());
    if (value !== 1 && value !== 2 && value !== 3) return this.reply('ERROR');
    this.mode = value as Esp01Mode;
    if (this.mode === 2) this.joined = false; // soft-AP only cannot be a station
    return this.reply('OK');
  }

  /**
   * The scan.
   *
   * One access point, the simulated one, because that is the only thing that
   * exists. Nothing here touches a radio or a host's network interfaces — a
   * scan that listed the user's real neighbours would be both a privacy
   * problem and a lie about what the module is doing.
   */
  private cwlap(): void {
    this.reply(`+CWLAP:(3,"${this.ap.ssid}",-58,"5c:cf:7f:00:00:00",1)`);
    this.reply('OK');
  }

  private cwjap(line: string, upper: string): void {
    if (upper.includes('?')) {
      if (!this.joined) {
        this.reply('No AP');
        return this.reply('OK');
      }
      this.reply(`+CWJAP:"${this.ap.ssid}","5c:cf:7f:00:00:00",1,-58`);
      return this.reply('OK');
    }
    if (this.mode === 2) {
      // Not a station, so it cannot join anything.
      this.reply('+CWJAP:3');
      return this.reply('FAIL');
    }
    const args = line.slice(line.indexOf('=') + 1);
    const quoted = [...args.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
    const ssid = quoted[0] ?? '';
    const password = quoted[1] ?? '';

    if (ssid !== this.ap.ssid) {
      // 3 is "connection failed"; a real module gives 3 for an AP it cannot
      // find, and there is exactly one to find here.
      this.joined = false;
      this.reply('+CWJAP:3');
      this.note(`no access point called "${ssid}"`);
      return this.reply('FAIL');
    }
    if (password !== this.ap.password) {
      this.joined = false;
      this.reply('+CWJAP:1'); // wrong password
      this.note('wrong password');
      return this.reply('FAIL');
    }
    this.joined = true;
    this.reply('WIFI CONNECTED');
    this.reply('WIFI GOT IP');
    this.note(`joined "${ssid}"`);
    return this.reply('OK');
  }

  /**
   * A socket the simulator cannot open.
   *
   * This is the honest half of the model. There is no network behind this
   * modem, so a connection cannot be established, and answering CONNECT/OK
   * would make a sketch believe it had reached a server. It fails the way a
   * real module fails an unreachable host, and the inspector says why.
   */
  private cipstart(): void {
    this.refusedConnections++;
    this.note('AT+CIPSTART refused: this simulator has no network to connect to');
    this.reply('ERROR');
    this.reply('CLOSED');
  }

  // ---- inspection ----

  get isEnabled(): boolean {
    return this.enabled;
  }
  get isJoined(): boolean {
    return this.joined;
  }
  get wifiMode(): Esp01Mode {
    return this.mode;
  }
  get echoOn(): boolean {
    return this.echo;
  }
  get address(): string | null {
    return this.joined ? this.ip : null;
  }
  get commandCount(): number {
    return this.commands;
  }
  get unknown(): string[] {
    return [...new Set(this.unknownCommands)];
  }
  get refusedConnectionCount(): number {
    return this.refusedConnections;
  }

  private note(text: string): void {
    this.log.push(text);
    if (this.log.length > 40) this.log.shift();
  }

  reset(): void {
    this.outbound = [];
    this.lineBuffer = '';
    this.joined = false;
    this.mode = 1;
    this.echo = true;
    this.multiplex = false;
    this.commands = 0;
    this.unknownCommands = [];
    this.refusedConnections = 0;
    this.log = [];
  }

  snapshot(): DeviceSnapshot {
    const state = !this.enabled
      ? 'held in reset (CH_PD low)'
      : this.joined
        ? `joined "${this.ap.ssid}" as ${this.ip}`
        : 'not associated';
    return {
      status:
        `ESP-01 — ${state}, mode ${this.mode}, ${this.config.baud} baud, ` +
        `${this.commands} AT command(s)` +
        (this.refusedConnections
          ? `, ${this.refusedConnections} connection attempt(s) refused — no network exists`
          : ''),
      log: [...this.log],
    };
  }
}
