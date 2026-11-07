// MCP2515 — the SPI CAN controller, as its register file and command set.
//
// The bus underneath this is the bit-level one in canBus.ts, which arbitrates
// on the wire. This file is the part firmware actually touches: the SPI
// commands every library uses, the transmit and receive buffers, the interrupt
// flags, and the mode machine that will not let a sketch transmit until it has
// left configuration mode.
//
// The bitrate is COMPUTED from CNF1-3 and the crystal, not taken from a
// property, because a wrong bit-timing calculation is one of the two things
// that stop an MCP2515 project working (the other being forgetting to leave
// config mode). A node whose CNF registers give a different bitrate from the
// rest of the bus is desynchronised, decodes nothing, and wrecks whatever it
// transmits into — which is what happens on a bench.
//
// NOT MODELLED, and recorded rather than implied:
//
//   acceptance filters      RXM0/RXM1 and RXF0-5 are stored and read back, but
//   and masks               every frame is accepted. A sketch that relies on
//                           filtering will see traffic it would not see on
//                           hardware. This is the largest gap here.
//   error counters          TEC and REC do not exist, so EFLG's error-passive
//                           and bus-off bits never set.
//   one-shot mode           OSM is stored and ignored.
//   sleep and wake          Sleep mode is accepted and behaves as standby.
//   the CLKOUT pin          Not modelled.
//   RXnBF and TXnRTS pins   The dedicated buffer-full and request-to-send pins
//                           are not wired; use INT and the SPI commands.

import type { ControlPinReader, DeviceSnapshot, SpiDevice, SpiMode } from './types';
import type { CanBus, CanFrame, CanNodeState } from './canBus';

/** The crystal on essentially every MCP2515 breakout sold. */
export const DEFAULT_CRYSTAL_HZ = 16_000_000;

export const MCP_CMD = {
  RESET: 0xc0,
  READ: 0x03,
  READ_RX: 0x90,
  WRITE: 0x02,
  LOAD_TX: 0x40,
  RTS: 0x80,
  READ_STATUS: 0xa0,
  RX_STATUS: 0xb0,
  BIT_MODIFY: 0x05,
} as const;

export const MCP_REG = {
  CANSTAT: 0x0e,
  CANCTRL: 0x0f,
  CNF3: 0x28,
  CNF2: 0x29,
  CNF1: 0x2a,
  CANINTE: 0x2b,
  CANINTF: 0x2c,
  EFLG: 0x2d,
  TXB0CTRL: 0x30,
  TXB1CTRL: 0x40,
  TXB2CTRL: 0x50,
  RXB0CTRL: 0x60,
  RXB1CTRL: 0x70,
} as const;

/** CANCTRL REQOP values. */
export const MCP_MODE = {
  NORMAL: 0,
  SLEEP: 1,
  LOOPBACK: 2,
  LISTEN_ONLY: 3,
  CONFIG: 4,
} as const;

/** CANINTF bits. */
export const INT_RX0 = 0x01;
export const INT_RX1 = 0x02;
export const INT_TX0 = 0x04;
export const INT_TX1 = 0x08;
export const INT_TX2 = 0x10;

const TXREQ = 0x08;

type Phase = 'command' | 'address' | 'data' | 'bit-modify-mask' | 'bit-modify-data';

export class Mcp2515Device implements SpiDevice {
  readonly instanceId: string;
  readonly csPinId: string | null;
  readonly supportedModes: readonly SpiMode[] = [0];

  private readonly bus: CanBus;
  private readonly node: CanNodeState;
  readonly crystalHz: number;

  private regs = new Uint8Array(0x80);

  private selected = false;
  private phase: Phase = 'command';
  private command = -1;
  private address = 0;
  private modifyMask = 0;

  private resets = 0;
  private log: string[] = [];

  constructor(instanceId: string, csPinId: string | null, bus: CanBus, crystalHz = DEFAULT_CRYSTAL_HZ) {
    this.instanceId = instanceId;
    this.csPinId = csPinId;
    this.bus = bus;
    this.crystalHz = crystalHz;
    this.node = bus.addNode(instanceId, 0);
    this.applyReset();
  }

  private applyReset(): void {
    this.regs.fill(0);
    // The chip comes up in configuration mode, which is why a sketch that
    // never asks for normal mode transmits nothing at all.
    this.regs[MCP_REG.CANCTRL] = MCP_MODE.CONFIG << 5;
    this.regs[MCP_REG.CANSTAT] = MCP_MODE.CONFIG << 5;
    this.node.listenOnly = true;
    this.node.queue.length = 0;
    this.resets++;
  }

  attachControls(_read: ControlPinReader): void {
    // INT is an output; RESET is handled through the SPI RESET command, which
    // is what every library uses.
  }

  select(active: boolean): void {
    this.selected = active;
    if (!active) {
      this.phase = 'command';
      this.command = -1;
    }
  }

  transfer(mosi: number): number | null {
    if (!this.selected) return null;

    if (this.phase === 'command') {
      this.command = mosi;
      if (mosi === MCP_CMD.RESET) {
        this.applyReset();
        this.note('RESET');
        return 0;
      }
      if (mosi === MCP_CMD.READ_STATUS) {
        this.phase = 'data';
        return this.readStatus();
      }
      if (mosi === MCP_CMD.RX_STATUS) {
        this.phase = 'data';
        return this.rxStatus();
      }
      if ((mosi & 0xf8) === MCP_CMD.RTS) {
        // Request to send, one bit per transmit buffer.
        for (let b = 0; b < 3; b++) if (mosi & (1 << b)) this.requestSend(b);
        this.phase = 'data';
        return 0;
      }
      if ((mosi & 0xf8) === MCP_CMD.READ_RX) {
        // The library's shortcut for reading a receive buffer, which also
        // clears its interrupt flag on deselect.
        this.address = (mosi & 0x04) === 0 ? MCP_REG.RXB0CTRL + 1 : MCP_REG.RXB1CTRL + 1;
        if (mosi & 0x02) this.address += 5; // straight to the data bytes
        this.regs[MCP_REG.CANINTF] &= ~((mosi & 0x04) === 0 ? INT_RX0 : INT_RX1);
        this.phase = 'data';
        return 0;
      }
      if ((mosi & 0xf8) === MCP_CMD.LOAD_TX) {
        const buffer = (mosi >> 1) & 0x03;
        this.address = (MCP_REG.TXB0CTRL + buffer * 0x10) + 1 + (mosi & 0x01 ? 5 : 0);
        this.phase = 'data';
        return 0;
      }
      this.phase = 'address';
      return 0;
    }

    if (this.phase === 'address') {
      this.address = mosi & 0x7f;
      this.phase = this.command === MCP_CMD.BIT_MODIFY ? 'bit-modify-mask' : 'data';
      return 0;
    }

    if (this.phase === 'bit-modify-mask') {
      this.modifyMask = mosi;
      this.phase = 'bit-modify-data';
      return 0;
    }

    if (this.phase === 'bit-modify-data') {
      const previous = this.regs[this.address];
      this.writeRegister(this.address, (previous & ~this.modifyMask) | (mosi & this.modifyMask));
      this.phase = 'command';
      this.command = -1;
      return 0;
    }

    // Data phase. READ walks forward through the register file; WRITE and the
    // load/read shortcuts do the same, which is what makes a burst work.
    if (this.command === MCP_CMD.READ || (this.command & 0xf8) === MCP_CMD.READ_RX) {
      const value = this.readRegister(this.address);
      this.address = (this.address + 1) & 0x7f;
      return value;
    }
    if (this.command === MCP_CMD.WRITE || (this.command & 0xf8) === MCP_CMD.LOAD_TX) {
      this.writeRegister(this.address, mosi);
      this.address = (this.address + 1) & 0x7f;
      return 0;
    }
    return this.readStatus();
  }

  private readRegister(address: number): number {
    if (address === MCP_REG.CANSTAT) return (this.mode << 5) | (this.regs[MCP_REG.CANSTAT] & 0x0e);
    return this.regs[address];
  }

  private writeRegister(address: number, value: number): void {
    // CANSTAT is read-only; the mode lives in CANCTRL.
    if (address === MCP_REG.CANSTAT) return;
    this.regs[address] = value;
    if (address === MCP_REG.CANCTRL) this.onModeWrite();
    if ((address & 0x0f) === 0 && address >= MCP_REG.TXB0CTRL && address <= MCP_REG.TXB2CTRL) {
      if (value & TXREQ) this.requestSend((address - MCP_REG.TXB0CTRL) >> 4);
    }
  }

  private onModeWrite(): void {
    this.regs[MCP_REG.CANSTAT] = (this.mode << 5) | (this.regs[MCP_REG.CANSTAT] & 0x0e);
    // Bit timing is only meaningful once the CNF registers have been written,
    // which the chip only allows in configuration mode.
    // A chip in configuration mode has no meaningful bit clock and is not on
    // the bus at all, so it must not be counted when nodes are compared.
    this.bus.noteBitrate(this.node, this.mode === MCP_MODE.CONFIG ? 0 : this.bitrate);
    // Anything but normal or loopback means this node does not drive the bus.
    this.node.listenOnly = this.mode !== MCP_MODE.NORMAL;
    this.note(`mode ${['normal', 'sleep', 'loopback', 'listen-only', 'config'][this.mode] ?? '?'}, ${this.bitrate} bit/s`);
  }

  get mode(): number {
    return (this.regs[MCP_REG.CANCTRL] >> 5) & 0x07;
  }

  /**
   * The bitrate, from CNF1-3 and the crystal.
   *
   * Tq is 2 x (BRP + 1) / Fosc, and a bit is SyncSeg + PropSeg + PS1 + PS2
   * quanta. Getting this wrong is one of the two reasons an MCP2515 project
   * does not work, so it is computed rather than declared.
   */
  get bitrate(): number {
    const brp = this.regs[MCP_REG.CNF1] & 0x3f;
    const propSeg = (this.regs[MCP_REG.CNF2] & 0x07) + 1;
    const phaseSeg1 = ((this.regs[MCP_REG.CNF2] >> 3) & 0x07) + 1;
    const phaseSeg2 = (this.regs[MCP_REG.CNF3] & 0x07) + 1;
    const quanta = 1 + propSeg + phaseSeg1 + phaseSeg2;
    const tqHz = this.crystalHz / (2 * (brp + 1));
    return Math.round(tqHz / quanta);
  }

  /** Turns a transmit buffer's registers into a frame and queues it. */
  private requestSend(buffer: number): void {
    const base = MCP_REG.TXB0CTRL + buffer * 0x10;
    if (this.mode === MCP_MODE.CONFIG || this.mode === MCP_MODE.LISTEN_ONLY) {
      // The chip will not transmit here, and a sketch that forgot to leave
      // configuration mode deserves to find that out.
      this.regs[base] &= ~TXREQ;
      this.note('a send was requested in a mode that cannot transmit');
      return;
    }
    const sidh = this.regs[base + 1];
    const sidl = this.regs[base + 2];
    const extended = (sidl & 0x08) !== 0;
    const dlcReg = this.regs[base + 5];
    const dlc = Math.min(8, dlcReg & 0x0f);
    const data = new Uint8Array(dlc);
    for (let i = 0; i < dlc; i++) data[i] = this.regs[base + 6 + i];

    const id = extended
      ? ((sidh << 21) | ((sidl & 0xe0) << 13) | ((sidl & 0x03) << 16) | (this.regs[base + 3] << 8) | this.regs[base + 4]) >>> 0
      : (sidh << 3) | (sidl >> 5);
    const frame: CanFrame = { id, extended, rtr: (dlcReg & 0x40) !== 0, data };

    this.regs[base] |= TXREQ;
    if (this.mode === MCP_MODE.LOOPBACK) {
      // Loopback never reaches the wire: the chip hands the frame straight to
      // its own receive path, which is what the mode is for.
      this.regs[base] &= ~TXREQ;
      this.deliver(frame);
      this.regs[MCP_REG.CANINTF] |= buffer === 0 ? INT_TX0 : buffer === 1 ? INT_TX1 : INT_TX2;
      return;
    }
    this.bus.send(this.instanceId, frame);
  }

  /** Puts a received frame into the first free receive buffer. */
  private deliver(frame: CanFrame): void {
    const free = !(this.regs[MCP_REG.CANINTF] & INT_RX0)
      ? 0
      : !(this.regs[MCP_REG.CANINTF] & INT_RX1)
        ? 1
        : -1;
    if (free < 0) {
      // Both buffers full. A real chip sets an overflow bit in EFLG and drops
      // the frame; so does this, and the frame is gone.
      this.regs[MCP_REG.EFLG] |= 0x40;
      this.note('both receive buffers were full: a frame was dropped');
      return;
    }
    const base = free === 0 ? MCP_REG.RXB0CTRL : MCP_REG.RXB1CTRL;
    if (frame.extended) {
      this.regs[base + 1] = (frame.id >>> 21) & 0xff;
      this.regs[base + 2] = (((frame.id >>> 18) & 0x07) << 5) | 0x08 | ((frame.id >>> 16) & 0x03);
      this.regs[base + 3] = (frame.id >>> 8) & 0xff;
      this.regs[base + 4] = frame.id & 0xff;
    } else {
      this.regs[base + 1] = (frame.id >> 3) & 0xff;
      this.regs[base + 2] = (frame.id & 0x07) << 5;
      this.regs[base + 3] = 0;
      this.regs[base + 4] = 0;
    }
    this.regs[base + 5] = (frame.rtr ? 0x40 : 0) | frame.data.length;
    for (let i = 0; i < frame.data.length; i++) this.regs[base + 6 + i] = frame.data[i];
    this.regs[MCP_REG.CANINTF] |= free === 0 ? INT_RX0 : INT_RX1;
  }

  /**
   * Moves whatever the bus has done into the register file.
   *
   * Called once per settle, after the bus has stepped its bits for this slice.
   */
  settle(): void {
    while (this.node.received.length > 0) {
      const frame = this.node.received.shift();
      if (frame) this.deliver(frame);
    }
    // A completed transmission clears TXREQ and raises the buffer's flag,
    // which is how a library knows it may load the next one.
    while (this.node.sentCount > this.reportedSends) {
      this.reportedSends++;
      for (let b = 0; b < 3; b++) {
        const base = MCP_REG.TXB0CTRL + b * 0x10;
        if (!(this.regs[base] & TXREQ)) continue;
        this.regs[base] &= ~TXREQ;
        this.regs[MCP_REG.CANINTF] |= b === 0 ? INT_TX0 : b === 1 ? INT_TX1 : INT_TX2;
        break;
      }
    }
  }
  private reportedSends = 0;

  private readStatus(): number {
    let status = 0;
    if (this.regs[MCP_REG.CANINTF] & INT_RX0) status |= 0x01;
    if (this.regs[MCP_REG.CANINTF] & INT_RX1) status |= 0x02;
    if (this.regs[MCP_REG.TXB0CTRL] & TXREQ) status |= 0x04;
    if (this.regs[MCP_REG.CANINTF] & INT_TX0) status |= 0x08;
    if (this.regs[MCP_REG.TXB1CTRL] & TXREQ) status |= 0x10;
    if (this.regs[MCP_REG.CANINTF] & INT_TX1) status |= 0x20;
    if (this.regs[MCP_REG.TXB2CTRL] & TXREQ) status |= 0x40;
    if (this.regs[MCP_REG.CANINTF] & INT_TX2) status |= 0x80;
    return status;
  }

  private rxStatus(): number {
    if (this.regs[MCP_REG.CANINTF] & INT_RX0) return 0x40;
    if (this.regs[MCP_REG.CANINTF] & INT_RX1) return 0x80;
    return 0;
  }

  // ------------------------------------------------------------ inspection --

  /** INT is active low while any enabled interrupt flag is set. */
  get irqAsserted(): boolean {
    return (this.regs[MCP_REG.CANINTF] & this.regs[MCP_REG.CANINTE]) !== 0;
  }
  get interruptFlags(): number {
    return this.regs[MCP_REG.CANINTF];
  }
  get sentCount(): number {
    return this.node.sentCount;
  }
  get receivedCount(): number {
    return this.node.receivedCount;
  }
  get arbitrationLosses(): number {
    return this.node.arbitrationLosses;
  }
  get resetCount(): number {
    return this.resets;
  }
  registerValue(address: number): number {
    return this.readRegister(address);
  }

  private note(text: string): void {
    this.log.push(text);
    if (this.log.length > 40) this.log.shift();
  }

  reset(): void {
    this.applyReset();
    this.selected = false;
    this.phase = 'command';
    this.command = -1;
    this.reportedSends = 0;
    this.log = [];
  }

  snapshot(): DeviceSnapshot {
    const modeName = ['normal', 'sleep', 'loopback', 'listen-only', 'config'][this.mode] ?? 'unknown';
    return {
      status:
        `MCP2515: ${modeName} mode, ${this.bitrate} bit/s from CNF1-3, ` +
        `${this.node.sentCount} frame(s) sent, ${this.node.receivedCount} received` +
        (this.node.arbitrationLosses ? `, ${this.node.arbitrationLosses} arbitration loss(es)` : ''),
      log: [...this.log],
    };
  }
}
