// ESP-01 — the AT modem a board talks to, on the canvas's own network.
//
// An ESP-01 on a project is, from the board's side, a serial device that
// answers AT commands. That part is modelled properly: the command parser, the
// echo, the mode and association state machine, the multi-line responses real
// firmware emits, and ERROR for anything unrecognised.
//
// Behind it is a simulated network, and only that. Every ESP-01 on the canvas
// that joins the same simulated access point is on one LAN with its own
// address (192.168.4.2, .3, …), and they can talk TCP to each other with the
// standard AT socket commands: AT+CIPSERVER to listen, AT+CIPSTART to connect,
// AT+CIPSEND to send, +IPD to receive, AT+CIPCLOSE to hang up — single and
// multiplexed connections both. So two boards can be a client and a server,
// for real, and a sketch's protocol code runs exactly as it would on a bench.
//
// What is NOT behind it is the internet. There is no DNS, no route out, and no
// host beyond the canvas: AT+CIPSTART to a name or to an address no module
// holds FAILS — with the DNS Fail, ERROR and CLOSED a real module gives —
// rather than answering CONNECT to a server that does not exist. A canned
// success would be worse than useless: a sketch would appear to post to a
// server, print its own hopeful log line, and behave completely differently
// the moment it ran on a bench.
//
// The access point is simulated and configured on the part: SSID and password
// are set by the user, joining works when the credentials match and fails when
// they do not. Nothing scans a real radio and nothing touches a real network
// interface. There is no nested ESP8266 running inside this: the module does
// not execute Espressif firmware; it answers the protocol that firmware speaks.
//
// NOT modelled beyond the above: UDP, SSL, passthrough mode (AT+CIPMODE=1),
// SmartConfig, sleep modes, the 74880-baud boot log, and per-command timing (a
// real AT+CWJAP takes seconds; here it answers at once).

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

/**
 * The canvas's LAN: every ESP-01 that has joined an access point, by address.
 *
 * Shared by all the modules in one simulation, as the infrared medium is.
 * A connection is a pair of ends, one on each module, with the link id each
 * side numbers it by.
 */
export class Esp01Network {
  private readonly modules = new Set<Esp01Device>();

  attach(device: Esp01Device): void {
    this.modules.add(device);
  }

  detach(device: Esp01Device): void {
    this.modules.delete(device);
  }

  /** The joined module holding this address on this access point, if any. */
  find(ssid: string, ip: string): Esp01Device | undefined {
    for (const m of this.modules) if (m.isJoined && m.ssid === ssid && m.address === ip) return m;
    return undefined;
  }
}

/** One end of a TCP connection. */
interface Link {
  peer: Esp01Device;
  /** The link id the peer numbers this connection by. */
  peerLink: number;
}

/** A multiplexed module numbers its connections 0..4, as the firmware does. */
const MAX_LINKS = 5;
/** The largest AT+CIPSEND the firmware accepts. */
const MAX_SEND = 2048;

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
  /** A simulated address on the canvas's LAN, handed out on join. */
  private ip = '192.168.4.2';
  private mac = '5c:cf:7f:00:00:01';

  private network: Esp01Network | null = null;
  /** Open connections by this module's link id (0 when not multiplexed). */
  private links = new Map<number, Link>();
  /** The port AT+CIPSERVER listens on, or null. */
  private serverPort: number | null = null;
  /** Bytes still to come for an AT+CIPSEND in progress, and where they go. */
  private sending: { link: number; remaining: number; data: number[] } | null = null;
  private bytesSent = 0;
  private bytesReceived = 0;

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
      this.leave();
      this.note('held in reset — CH_PD low or RST asserted');
    }
  }

  /**
   * Puts the module on the canvas's network at an address of its own.
   *
   * The address is fixed by the binding (by canvas order), so it is the same
   * every run and a sketch can hard-code its peer's, as people do on a bench
   * with a DHCP reservation.
   */
  setNetwork(network: Esp01Network, index: number): void {
    if (this.network && this.network !== network) this.network.detach(this);
    this.network = network;
    network.attach(this);
    this.ip = `192.168.4.${2 + index}`;
    this.mac = `5c:cf:7f:00:00:${(1 + index).toString(16).padStart(2, '0')}`;
  }

  setAccessPoint(ap: Partial<SimulatedAccessPoint>): void {
    const next = { ...this.ap, ...ap };
    if (next.ssid === this.ap.ssid && next.password === this.ap.password) return;
    this.ap = next;
    // Changing the AP out from under a joined module drops it, as moving out
    // of range would.
    if (this.joined) {
      this.leave();
      this.note('the access point changed — association dropped');
    }
  }

  onByteFromBoard(byte: number): void {
    if (!this.enabled) return;
    if (this.sending) {
      // AT+CIPSEND's payload is raw: no echo, no line ending, exactly the
      // number of bytes announced.
      this.sending.data.push(byte);
      if (--this.sending.remaining === 0) this.finishSend();
      return;
    }
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
      this.leave();
      this.multiplex = false;
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
      this.leave();
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
      if (upper.includes('=')) {
        const want = line.slice(line.indexOf('=') + 1).trim() === '1';
        // The firmware refuses to change it with connections open or a server up.
        if (want !== this.multiplex && (this.links.size > 0 || this.serverPort !== null)) {
          this.reply('link is builded');
          return this.reply('ERROR');
        }
        this.multiplex = want;
      } else this.reply(`+CIPMUX:${this.multiplex ? 1 : 0}`);
      return this.reply('OK');
    }

    if (upper === 'AT+CIPSTATUS') {
      // 2 = got an address, 3 = connected, 4 = disconnected, 5 = no AP.
      this.reply(`STATUS:${!this.joined ? 5 : this.links.size > 0 ? 3 : 2}`);
      for (const [id, link] of this.links) {
        this.reply(`+CIPSTATUS:${id},"TCP","${link.peer.address}",${link.peer.serverPort ?? 0},0,0`);
      }
      return this.reply('OK');
    }

    if (upper.startsWith('AT+CIPSERVER')) return this.cipserver(line);
    if (upper.startsWith('AT+CIPSTART')) return this.cipstart(line);
    if (upper.startsWith('AT+CIPSEND')) return this.cipsend(line);
    if (upper.startsWith('AT+CIPCLOSE')) return this.cipclose(line);

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
    if (this.mode === 2) this.leave(); // soft-AP only cannot be a station
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
      this.leave();
      this.reply('+CWJAP:3');
      this.note(`no access point called "${ssid}"`);
      return this.reply('FAIL');
    }
    if (password !== this.ap.password) {
      this.leave();
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

  /** Drops off the network: every connection closes, the server stops. */
  private leave(): void {
    for (const id of [...this.links.keys()]) this.dropLink(id, true);
    this.serverPort = null;
    this.sending = null;
    this.joined = false;
  }

  /** Quoted strings and bare numbers, in order, from a command's arguments. */
  private args(line: string): string[] {
    const eq = line.indexOf('=');
    if (eq < 0) return [];
    return [...line.slice(eq + 1).matchAll(/"([^"]*)"|([^,\s]+)/g)].map((m) => m[1] ?? m[2]);
  }

  /** AT+CIPSERVER=1,<port> starts listening; AT+CIPSERVER=0 stops. */
  private cipserver(line: string): void {
    const [mode, port] = this.args(line);
    // The firmware only serves multiplexed: a server takes several clients.
    if (!this.multiplex) {
      this.note('AT+CIPSERVER needs AT+CIPMUX=1 first');
      return this.reply('ERROR');
    }
    if (mode === '0') {
      this.serverPort = null;
      for (const id of [...this.links.keys()]) this.dropLink(id, true);
      return this.reply('OK');
    }
    if (mode !== '1') return this.reply('ERROR');
    const p = port === undefined ? 333 : Number(port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) return this.reply('ERROR');
    if (this.serverPort !== null && this.serverPort !== p) {
      this.reply('no change');
      return this.reply('OK');
    }
    this.serverPort = p;
    this.note(`listening on port ${p}`);
    return this.reply('OK');
  }

  /**
   * Opens a TCP connection to another module on the canvas's LAN.
   *
   * The far end has to be joined to the same access point and listening on
   * that port. A host name, or an address nothing holds, fails as an
   * unreachable host does — there is no network beyond the canvas.
   */
  private cipstart(line: string): void {
    const a = this.args(line);
    let id = 0;
    if (this.multiplex) {
      id = Number(a.shift());
      if (!Number.isInteger(id) || id < 0 || id >= MAX_LINKS) return this.reply('ERROR');
    }
    const [type, host, portText] = a;
    const port = Number(portText);
    if (!this.joined) {
      this.refusedConnections++;
      this.note('AT+CIPSTART with no access point joined');
      this.reply('ERROR');
      return this.reply('CLOSED');
    }
    if (this.links.has(id)) {
      this.reply('ALREADY CONNECTED');
      return this.reply('ERROR');
    }
    if ((type ?? '').toUpperCase() !== 'TCP') {
      this.refusedConnections++;
      this.note(`AT+CIPSTART "${type}" — only TCP is simulated`);
      return this.reply('ERROR');
    }
    if (!host || !/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
      this.refusedConnections++;
      this.note(`"${host}" cannot be resolved: the simulated network has no DNS and no route to the internet`);
      this.reply('DNS Fail');
      this.reply('ERROR');
      return this.reply('CLOSED');
    }
    const peer = this.network?.find(this.ap.ssid, host);
    if (!peer || peer === this || peer.serverPort !== port) {
      this.refusedConnections++;
      this.note(
        peer && peer !== this
          ? `${host} is on the network but not listening on port ${port}`
          : `no module at ${host} — only ESP-01s on this canvas, joined to "${this.ap.ssid}", are reachable`,
      );
      this.reply('ERROR');
      return this.reply('CLOSED');
    }
    const peerLink = peer.accept(this, id);
    if (peerLink === null) {
      this.refusedConnections++;
      this.note(`${host} has no free connection`);
      this.reply('ERROR');
      return this.reply('CLOSED');
    }
    this.links.set(id, { peer, peerLink });
    this.reply(this.multiplex ? `${id},CONNECT` : 'CONNECT');
    this.note(`connected to ${host}:${port}`);
    return this.reply('OK');
  }

  /** The listening side of a new connection: returns its link id, or null when full. */
  private accept(from: Esp01Device, fromLink: number): number | null {
    let id = 0;
    while (this.links.has(id)) id++;
    if (id >= MAX_LINKS) return null;
    this.links.set(id, { peer: from, peerLink: fromLink });
    this.reply(`${id},CONNECT`);
    this.note(`${from.address} connected as link ${id}`);
    return id;
  }

  /** AT+CIPSEND=<length>, or <link>,<length> when multiplexed. */
  private cipsend(line: string): void {
    const a = this.args(line).map(Number);
    const id = this.multiplex ? a[0] : 0;
    const length = this.multiplex ? a[1] : a[0];
    if (!this.links.has(id)) {
      this.reply('link is not valid');
      return this.reply('ERROR');
    }
    if (!Number.isInteger(length) || length < 1 || length > MAX_SEND) return this.reply('ERROR');
    this.sending = { link: id, remaining: length, data: [] };
    this.reply('OK');
    // The prompt has no line ending: the payload follows it directly.
    this.outbound.push(...[...'> '].map((c) => c.charCodeAt(0)));
  }

  private finishSend(): void {
    const send = this.sending!;
    this.sending = null;
    const link = this.links.get(send.link);
    this.reply('');
    this.reply(`Recv ${send.data.length} bytes`);
    if (!link) {
      this.reply('SEND FAIL');
      return;
    }
    link.peer.receive(link.peerLink, send.data);
    this.bytesSent += send.data.length;
    this.reply('SEND OK');
  }

  /** Data arriving on one of this module's connections, reported as +IPD. */
  private receive(id: number, data: number[]): void {
    if (!this.enabled) return;
    this.bytesReceived += data.length;
    const head = this.multiplex ? `+IPD,${id},${data.length}:` : `+IPD,${data.length}:`;
    this.outbound.push(...[...`\r\n${head}`].map((c) => c.charCodeAt(0)), ...data);
  }

  /** AT+CIPCLOSE, or AT+CIPCLOSE=<link> when multiplexed (5 closes them all). */
  private cipclose(line: string): void {
    const [arg] = this.args(line);
    const id = this.multiplex ? Number(arg) : 0;
    if (this.multiplex && id === MAX_LINKS) {
      for (const open of [...this.links.keys()]) this.dropLink(open, true);
      return this.reply('OK');
    }
    if (!this.links.has(id)) {
      this.reply('link is not valid');
      return this.reply('ERROR');
    }
    this.dropLink(id, true);
    return this.reply('OK');
  }

  /** Closes one connection on this side and, when `notifyPeer`, on the far one. */
  private dropLink(id: number, notifyPeer: boolean): void {
    const link = this.links.get(id);
    if (!link) return;
    this.links.delete(id);
    this.reply(this.multiplex ? `${id},CLOSED` : 'CLOSED');
    if (notifyPeer) link.peer.dropLink(link.peerLink, false);
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
  get ssid(): string {
    return this.ap.ssid;
  }
  get openConnections(): number {
    return this.links.size;
  }
  get listeningPort(): number | null {
    return this.serverPort;
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
    this.leave();
    this.outbound = [];
    this.lineBuffer = '';
    this.bytesSent = 0;
    this.bytesReceived = 0;
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
        ? `joined "${this.ap.ssid}" as ${this.ip}` +
          (this.serverPort !== null ? `, listening on ${this.serverPort}` : '') +
          (this.links.size ? `, ${this.links.size} connection(s), ${this.bytesSent} B sent, ${this.bytesReceived} B received` : '')
        : 'not associated';
    return {
      status:
        `ESP-01 — ${state}, mode ${this.mode}, ${this.config.baud} baud, ` +
        `${this.commands} AT command(s)` +
        (this.refusedConnections
          ? `, ${this.refusedConnections} connection attempt(s) refused — only modules on this canvas are reachable`
          : ''),
      log: [...this.log],
    };
  }
}
