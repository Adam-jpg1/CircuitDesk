// HC-05 — the UART half of a Bluetooth module, and only that half.
//
// What this is: a module that answers AT commands on a serial port and, in data
// mode, passes bytes between that port and a link. Everything a sketch does
// with an HC-05 goes through those two behaviours, and both are real here.
//
// What this is NOT, stated plainly because the part's name invites the
// assumption: there is no Bluetooth. No radio, no pairing handshake, no
// inquiry, no RFCOMM, no profile negotiation, no addressing beyond the strings
// the AT commands store. A sketch that pairs a phone to this is pairing a phone
// to nothing. The coverage matrix records it as behavioral with the blocker
// `bluetooth-channel` for the same reason.
//
// The AT/data split is modelled because it is the thing people actually get
// wrong. The module only answers AT commands while its KEY/EN pin is held high
// at power-up; in normal operation it is transparent, and every byte a sketch
// sends goes to the far end instead of being interpreted. A model that always
// answered AT would make a sketch that "works" here fail on a bench, and vice
// versa.
//
// NOT modelled beyond the above: the 38400-baud AT-mode default being separate
// from the data-mode baud (both use the configured rate), flow control, and the
// STATE pin.

import { DEFAULT_UART, type UartConfig, type UartPeripheral } from './uartEndpoint';
import type { DeviceSnapshot } from './types';

export type Hc05Mode = 'data' | 'at';

export class Hc05Device implements UartPeripheral {
  readonly instanceId: string;
  private config: UartConfig;

  /** AT mode only while KEY is held high — otherwise the module is transparent. */
  private mode: Hc05Mode = 'data';

  private name = 'HC-05';
  private pin = '1234';
  private role = 0; // 0 = slave, 1 = master
  private uartSetting = '9600,0,0';

  /** Bytes waiting to go to the board. */
  private outbound: number[] = [];
  /** The AT command being assembled, until CR/LF. */
  private lineBuffer = '';
  /** Bytes the sketch sent in data mode, which would have gone over the air. */
  private dataOut: number[] = [];

  private commands = 0;
  private unknownCommands: string[] = [];
  private log: string[] = [];

  constructor(instanceId: string, baud = 9600) {
    this.instanceId = instanceId;
    this.config = { ...DEFAULT_UART, baud };
  }

  uartConfig(): UartConfig {
    return this.config;
  }
  setBaud(baud: number): void {
    this.config = { ...this.config, baud };
  }

  /** KEY/EN high at power-up selects AT mode; low is transparent data mode. */
  setKeyPin(high: boolean): void {
    const next: Hc05Mode = high ? 'at' : 'data';
    if (next === this.mode) return;
    this.mode = next;
    this.lineBuffer = '';
    this.note(`entered ${next === 'at' ? 'AT' : 'data'} mode`);
  }

  get currentMode(): Hc05Mode {
    return this.mode;
  }

  onByteFromBoard(byte: number): void {
    if (this.mode === 'data') {
      // Transparent. On real hardware this goes over the air; here it is
      // recorded so the inspector can show what a sketch sent, and so a future
      // Bluetooth channel has a place to attach.
      this.dataOut.push(byte);
      return;
    }
    const ch = String.fromCharCode(byte);
    if (ch === '\r') return;
    if (ch === '\n') {
      this.handleCommand(this.lineBuffer.trim());
      this.lineBuffer = '';
      return;
    }
    this.lineBuffer += ch;
    if (this.lineBuffer.length > 120) this.lineBuffer = '';
  }

  takeBytesForBoard(): number[] {
    const out = this.outbound;
    this.outbound = [];
    return out;
  }

  private reply(text: string): void {
    for (const ch of `${text}\r\n`) this.outbound.push(ch.charCodeAt(0));
  }

  /**
   * The AT subset a sketch actually uses.
   *
   * Unrecognised commands answer ERROR rather than OK, because a module that
   * said OK to everything would make a sketch that is talking nonsense look
   * like one that is working.
   */
  private handleCommand(line: string): void {
    if (line.length === 0) return;
    this.commands++;
    const upper = line.toUpperCase();

    if (upper === 'AT') {
      this.reply('OK');
      return;
    }
    if (upper === 'AT+RESET' || upper === 'AT+RESET?') {
      this.reply('OK');
      this.note('reset');
      return;
    }
    if (upper === 'AT+VERSION?') {
      this.reply('+VERSION:2.0-20100601');
      this.reply('OK');
      return;
    }
    if (upper === 'AT+NAME?') {
      this.reply(`+NAME:${this.name}`);
      this.reply('OK');
      return;
    }
    if (upper.startsWith('AT+NAME=')) {
      this.name = line.slice(8);
      this.reply('OK');
      return;
    }
    if (upper === 'AT+PSWD?' || upper === 'AT+PIN?') {
      this.reply(`+PIN:${this.pin}`);
      this.reply('OK');
      return;
    }
    if (upper.startsWith('AT+PSWD=') || upper.startsWith('AT+PIN=')) {
      this.pin = line.slice(line.indexOf('=') + 1);
      this.reply('OK');
      return;
    }
    if (upper === 'AT+ROLE?') {
      this.reply(`+ROLE:${this.role}`);
      this.reply('OK');
      return;
    }
    if (upper.startsWith('AT+ROLE=')) {
      this.role = Number(line.slice(8)) === 1 ? 1 : 0;
      this.reply('OK');
      return;
    }
    if (upper === 'AT+UART?') {
      this.reply(`+UART:${this.uartSetting}`);
      this.reply('OK');
      return;
    }
    if (upper.startsWith('AT+UART=')) {
      this.uartSetting = line.slice(8);
      const baud = Number(this.uartSetting.split(',')[0]);
      if (Number.isFinite(baud) && baud > 0) this.setBaud(baud);
      this.reply('OK');
      return;
    }
    if (upper === 'AT+ADDR?') {
      // A stable synthetic address. It is not a real Bluetooth address and is
      // not claimed to be — nothing can be paired with it.
      this.reply('+ADDR:98d3:31:fb1234');
      this.reply('OK');
      return;
    }

    this.unknownCommands.push(line);
    this.reply('ERROR:(0)');
  }

  // ---- inspection ----

  get deviceName(): string {
    return this.name;
  }
  get pairingPin(): string {
    return this.pin;
  }
  get roleValue(): number {
    return this.role;
  }
  get commandCount(): number {
    return this.commands;
  }
  get unknown(): string[] {
    return [...new Set(this.unknownCommands)];
  }
  /** Bytes a sketch sent in data mode — where a Bluetooth channel would attach. */
  get transparentBytes(): number[] {
    return [...this.dataOut];
  }

  private note(text: string): void {
    this.log.push(text);
    if (this.log.length > 40) this.log.shift();
  }

  reset(): void {
    this.outbound = [];
    this.lineBuffer = '';
    this.dataOut = [];
    this.commands = 0;
    this.unknownCommands = [];
    this.log = [];
  }

  snapshot(): DeviceSnapshot {
    return {
      status:
        `HC-05 — ${this.mode === 'at' ? 'AT mode' : 'data mode'}, name "${this.name}", ` +
        `role ${this.role === 1 ? 'master' : 'slave'}, ${this.config.baud} baud, ` +
        `${this.commands} command(s)` +
        (this.dataOut.length ? `, ${this.dataOut.length} byte(s) sent transparently` : ''),
      log: [...this.log],
    };
  }
}
