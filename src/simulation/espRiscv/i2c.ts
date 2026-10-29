// The I2C controller of the ESP32-C3 and ESP32-C6, in master mode — Wire.
//
// Arduino-ESP32 3.3's Wire runs on ESP-IDF's i2c_master driver, which works
// the controller the way the hardware intends: it loads up to eight commands
// (RSTART, WRITE n, READ n, STOP, END) into COMD0-7 and the bytes to send into
// the TX FIFO, sets CTR.TRANS_START, and sleeps until the controller's
// interrupt says the commands are done (TRANS_COMPLETE after a STOP,
// END_DETECT after an END, which keeps the bus for the next batch) or failed
// (NACK when an acknowledge check does not match). Its interrupt handler then
// reads what arrived out of the RX FIFO. Unmodelled, no interrupt ever came
// and every Wire call timed out.
//
// Here TRANS_START executes the command list against the shared I2C device
// bus — the same device models every other board drives — and raises the
// interrupt when the bytes would have finished crossing the wire, at the bus
// speed the SCL period registers set. The first byte written after a start is
// the address. Register positions are from each chip's i2c_reg.h and the
// command encoding from its i2c_ll.h; the two chips share both and differ in
// base address, interrupt source and matrix signal numbers. Not modelled:
// 10-bit addressing, slave mode, clock stretching and arbitration.

import type { Peripheral, InterruptingPeripheral } from './peripheral';
import type { Spi2Bus } from './spi2';

export interface EspI2cLayout {
  base: number;
  interruptSource: number;
  /** Matrix signals of SCL and SDA (in and out share a number). */
  sclSignal: number;
  sdaSignal: number;
}

export const ESP32C3_I2C0: EspI2cLayout = { base: 0x60013000, interruptSource: 29, sclSignal: 53, sdaSignal: 54 };
export const ESP32C6_I2C0: EspI2cLayout = { base: 0x60004000, interruptSource: 50, sclSignal: 45, sdaSignal: 46 };

const SCL_LOW_PERIOD = 0x00;
const CTR = 0x04;
const SR = 0x08;
const FIFO_CONF = 0x18;
const DATA = 0x1c;
const INT_RAW = 0x20;
const INT_CLR = 0x24;
const INT_ENA = 0x28;
const INT_STATUS = 0x2c;
const SCL_HIGH_PERIOD = 0x38;
const CLK_CONF = 0x54;
const COMD0 = 0x58;
const COMMANDS = 8;
const SCL_SP_CONF = 0x80;

const CTR_TRANS_START = 1 << 5;
const CTR_FSM_RST = 1 << 10;
const CTR_CONF_UPGATE = 1 << 11;
const FIFO_RX_RST = 1 << 12;
const FIFO_TX_RST = 1 << 13;
const SCL_RST_SLV_EN = 1;

const INT_END_DETECT = 1 << 3;
const INT_TRANS_COMPLETE = 1 << 7;
const INT_NACK = 1 << 10;

const OP_WRITE = 1;
const OP_STOP = 2;
const OP_READ = 3;
const OP_END = 4;
const OP_RSTART = 6;
const CMD_DONE = 1 << 31;

const FIFO_DEPTH = 32;
/** The controller's clock source when nothing says otherwise: the 40 MHz crystal. */
const SOURCE_HZ = 40_000_000;

export interface EspI2cBus {
  start(repeated: boolean): void;
  /** True when a device acknowledged the address. */
  connect(address: number, write: boolean): boolean;
  /** True when the device acknowledged the byte. */
  writeByte(value: number): boolean;
  readByte(ack: boolean): number;
  stop(): void;
}

/**
 * Where the chip's bus controllers reach the device models. The runner fills
 * these in; until it does, the I2C bus has nothing on it and SPI reads idle.
 */
export interface EspBusPorts {
  i2c: EspI2cBus | null;
  spi: Spi2Bus | null;
}

export class EspI2c implements Peripheral, InterruptingPeripheral {
  readonly name = 'i2c0';
  readonly size = 0x1000;
  readonly base: number;
  private readonly registers = new Map<number, number>();
  private tx: number[] = [];
  private rx: number[] = [];
  private raw = 0;
  /** Interrupts the running batch raises when it finishes, and when that is. */
  private pending = 0;
  private finishAt: number | undefined;
  /** The bus is ours between a start and a stop, across END-separated batches. */
  private owned = false;
  /** The last acknowledge received was a NACK (SR.RESP_REC). */
  private nacked = false;

  constructor(
    private readonly layout: EspI2cLayout,
    private readonly clock: { readonly nanos: number },
    private readonly bus: () => EspI2cBus | null,
  ) {
    this.base = layout.base;
  }

  reset(): void {
    this.registers.clear();
    this.tx = [];
    this.rx = [];
    this.raw = 0;
    this.pending = 0;
    this.finishAt = undefined;
    this.owned = false;
    this.nacked = false;
  }

  private peek(offset: number): number {
    return (this.registers.get(offset) ?? 0) >>> 0;
  }

  readUint32(offset: number): number {
    this.settle();
    switch (offset) {
      case CTR:
        return this.peek(CTR) & ~(CTR_TRANS_START | CTR_FSM_RST | CTR_CONF_UPGATE);
      case SR:
        return (
          (this.nacked ? 1 : 0) |
          ((this.finishAt !== undefined || this.owned ? 1 : 0) << 4) |
          (Math.min(this.rx.length, 63) << 8) |
          (Math.min(this.tx.length, 63) << 18)
        ) >>> 0;
      case DATA:
        return this.rx.shift() ?? 0;
      case INT_RAW:
        return this.raw >>> 0;
      case INT_STATUS:
        return (this.raw & this.peek(INT_ENA)) >>> 0;
      case SCL_SP_CONF:
        // Sending the bus-clear pulses finishes at once: the enable clears itself.
        return this.peek(SCL_SP_CONF) & ~SCL_RST_SLV_EN;
      default:
        return this.peek(offset);
    }
  }

  writeUint32(offset: number, value: number): void {
    const v = value >>> 0;
    switch (offset) {
      case DATA:
        if (this.tx.length < FIFO_DEPTH) this.tx.push(v & 0xff);
        return;
      case INT_CLR:
        this.raw &= ~v;
        return;
      case INT_RAW:
      case INT_STATUS:
        return;
      case FIFO_CONF:
        this.registers.set(offset, v);
        if (v & FIFO_TX_RST) this.tx = [];
        if (v & FIFO_RX_RST) this.rx = [];
        return;
      case CTR:
        this.registers.set(offset, v);
        if (v & CTR_FSM_RST) this.abort();
        if (v & CTR_TRANS_START) this.execute();
        return;
      default:
        this.registers.set(offset, v);
    }
  }

  /** One SCL period, from the high and low periods and the source divider. */
  private bitNs(): number {
    const low = (this.peek(SCL_LOW_PERIOD) & 0x1ff) + 1;
    const high = (this.peek(SCL_HIGH_PERIOD) & 0x1ff) + 1;
    const div = (this.peek(CLK_CONF) & 0xff) + 1;
    const ns = ((low + high) * div * 1e9) / SOURCE_HZ;
    // An unconfigured controller is taken to run at 100 kHz.
    return ns >= 1000 && ns <= 1_000_000 ? ns : 10_000;
  }

  /** FSM reset: whatever was running stops, and the bus is let go. */
  private abort(): void {
    if (this.owned) this.bus()?.stop();
    this.owned = false;
    this.finishAt = undefined;
    this.pending = 0;
  }

  /**
   * Runs COMD0-7 against the device bus, in order, until a STOP or an END —
   * or until an acknowledge check fails, which ends the batch with NACK as the
   * controller does.
   */
  private execute(): void {
    const bus = this.bus();
    let bits = 0;
    let raised = 0;
    let addressNext = false;
    for (let i = 0; i < COMMANDS; i++) {
      const at = COMD0 + i * 4;
      const command = this.peek(at);
      const op = (command >>> 11) & 0x7;
      const count = command & 0xff;
      const checkAck = (command & (1 << 8)) !== 0;
      const expectNack = (command & (1 << 9)) !== 0;
      const sendNack = (command & (1 << 10)) !== 0;
      let failed = false;
      if (op === OP_RSTART) {
        bus?.start(this.owned);
        this.owned = true;
        addressNext = true;
        bits += 2;
      } else if (op === OP_WRITE) {
        for (let n = 0; n < count; n++) {
          const byte = this.tx.shift() ?? 0xff;
          const ack = addressNext ? (bus?.connect(byte >> 1, (byte & 1) === 0) ?? false) : (bus?.writeByte(byte) ?? false);
          addressNext = false;
          bits += 9;
          this.nacked = !ack;
          if (checkAck && !ack !== expectNack) {
            failed = true;
            break;
          }
        }
      } else if (op === OP_READ) {
        for (let n = 0; n < count; n++) {
          // The acknowledge sent after each byte is the command's ACK value.
          const byte = bus?.readByte(!sendNack) ?? 0xff;
          if (this.rx.length < FIFO_DEPTH) this.rx.push(byte & 0xff);
          bits += 9;
        }
      } else if (op === OP_STOP) {
        bus?.stop();
        this.owned = false;
        bits += 2;
        raised |= INT_TRANS_COMPLETE;
      } else if (op === OP_END) {
        raised |= INT_END_DETECT;
      }
      if (failed) {
        // The controller abandons the batch and releases the bus.
        bus?.stop();
        this.owned = false;
        raised |= INT_NACK;
        break;
      }
      this.registers.set(at, (command | CMD_DONE) >>> 0);
      if (op === OP_STOP || op === OP_END) break;
    }
    this.pending = raised;
    this.finishAt = this.clock.nanos + Math.max(1, bits) * this.bitNs();
  }

  /** Raises the running batch's interrupts once its time has come. */
  private settle(): void {
    if (this.finishAt === undefined || this.clock.nanos < this.finishAt) return;
    this.raw |= this.pending;
    this.pending = 0;
    this.finishAt = undefined;
  }

  nextInterruptChangeNanos(): number | undefined {
    return this.finishAt;
  }

  assertedInterruptSources(): number[] {
    this.settle();
    return this.raw & this.peek(INT_ENA) ? [this.layout.interruptSource] : [];
  }
}
