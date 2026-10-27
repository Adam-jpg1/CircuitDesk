// The ESP32-C3 and ESP32-C6 UART, as the ESP-IDF driver behind Serial uses it.
//
// Arduino-ESP32's HardwareSerial goes through the IDF UART driver, which runs
// on the FIFO and three interrupts: TXFIFO_EMPTY to refill the transmitter,
// RXFIFO_FULL and RXFIFO_TOUT to drain the receiver, TX_DONE for flush(). So
// that is what is modelled, register by register, from the IDF's own
// uart_struct.h for each chip — the two parts share the design and differ in
// where fields sit, which is the `layout` below.
//
// Bytes leave the transmitter one at a time at the baud rate the firmware
// programmed (ten bit-times each), on the machine's simulated clock, so a
// sketch that prints faster than the line can carry fills the FIFO and waits,
// as it does on the chip. Received bytes enter the FIFO as they are queued.
//
// NOT modelled: parity, framing and break errors (nothing on the other end can
// produce them), hardware and software flow control, RS485, IrDA, autobaud,
// AT-command detection, and the low-power wakeup.

import type { InterruptingPeripheral, Peripheral, SimulatedClock } from './peripheral';

const FIFO = 0x00;
const INT_RAW = 0x04;
const INT_ST = 0x08;
const INT_ENA = 0x0c;
const INT_CLR = 0x10;
const CLKDIV = 0x14;
const STATUS = 0x1c;
const CONF0 = 0x20;
const CONF1 = 0x24;

const RXFIFO_FULL = 1 << 0;
const TXFIFO_EMPTY = 1 << 1;
const RXFIFO_TOUT = 1 << 8;
const TX_DONE = 1 << 14;

const FIFO_LEN = 128;
/** What a line runs at before the firmware sets a rate: the boot ROM's 115200. */
const DEFAULT_BAUD = 115200;

/**
 * The UART's source clock, from the register that selects and divides it.
 *
 * Both parts encode it the same way — sel 1 is the 80 MHz clock (APB on the C3,
 * PLL_F80M on the C6), 2 the RC oscillator, 3 the 40 MHz crystal, divided by
 * num + 1 + a/b — and keep it in different places: the C3 in the UART's own
 * CLK_CONF, the C6 in PCR. Arduino-ESP32 chooses the crystal on both, so
 * assuming the 80 MHz clock reads every baud rate as double what it is.
 */
export function uartSourceClockHz(conf: number): number {
  const sel = (conf >>> 20) & 3;
  const base = sel === 3 ? 40_000_000 : sel === 2 ? 17_500_000 : 80_000_000;
  const a = conf & 0x3f;
  const b = (conf >>> 6) & 0x3f;
  const num = (conf >>> 12) & 0xff;
  return base / (num + 1 + (b > 0 ? a / b : 0));
}

/** Where each chip keeps the fields the model needs. */
export interface UartLayout {
  /** STATUS: RX count in bits [rxCountBits-1:0], TX count from bit 16. */
  countBits: number;
  conf0RxfifoRst: number;
  conf0TxfifoRst: number;
  conf1FieldBits: number;
  /** Where the receive-timeout enable lives: CONF1's bit on the C3, its own register on the C6. */
  toutEnable: { offset: number; bit: number };
  /** Offset of the receive-timeout threshold register, if separate. */
  toutThreshold?: { offset: number; shift: number };
  /** Registers that firmware sets and spins on until hardware clears them. */
  selfClearing: number[];
  fsmStatus: number;
  /** The UART's own clock-configuration register, where the chip keeps it there. */
  clockConf?: number;
}

export const ESP32C3_UART_LAYOUT: UartLayout = {
  countBits: 10,
  conf0RxfifoRst: 17,
  conf0TxfifoRst: 18,
  conf1FieldBits: 9,
  toutEnable: { offset: CONF1, bit: 21 },
  selfClearing: [],
  fsmStatus: 0x6c,
  clockConf: 0x78,
};

export const ESP32C6_UART_LAYOUT: UartLayout = {
  countBits: 8,
  conf0RxfifoRst: 22,
  conf0TxfifoRst: 23,
  conf1FieldBits: 8,
  toutEnable: { offset: 0x64, bit: 0 },
  toutThreshold: { offset: 0x64, shift: 2 },
  // REG_UPDATE: the C6 latches configuration into the UART's own clock domain
  // when this is set, and firmware waits for it to read back zero.
  selfClearing: [0x98],
  fsmStatus: 0x70,
};

export class EspUart implements Peripheral, InterruptingPeripheral {
  /** Each byte as it finishes leaving the transmitter. */
  onByte: ((byte: number) => void) | null = null;

  private readonly registers = new Map<number, number>();
  private tx: number[] = [];
  /** When the byte at the head of the TX FIFO finishes, in simulated ns. */
  private txHeadDoneAt = 0;
  private rx: number[] = [];
  private lastRxAt = 0;
  private raw = 0;

  constructor(
    readonly name: string,
    readonly base: number,
    private readonly clock: SimulatedClock,
    private readonly interruptSource: number,
    private readonly layout: UartLayout,
    /** Reads the clock-configuration register, where it is not in this block (the C6's PCR). */
    private readonly externalClockConf?: () => number,
    readonly size = 0x100,
  ) {
    this.reset();
  }

  reset(): void {
    this.registers.clear();
    this.tx = [];
    this.rx = [];
    this.raw = 0;
    // CONF1's documented reset: RX-full at 96 bytes, TX-empty at 96 bytes.
    const bits = this.layout.conf1FieldBits;
    this.registers.set(CONF1, 0x60 | (0x60 << bits));
  }

  /** Bytes typed into the monitor, for Serial.read(). */
  receive(bytes: Iterable<number>): void {
    this.drain();
    for (const b of bytes) if (this.rx.length < FIFO_LEN) this.rx.push(b & 0xff);
    this.lastRxAt = this.clock.nanos;
    this.updateRx();
  }

  /** The rate the firmware programmed, read back from the divider. */
  get baudRate(): number {
    const div = this.registers.get(CLKDIV);
    if (div === undefined) return DEFAULT_BAUD;
    const integer = div & 0xfff;
    const fraction = (div >>> 20) & 0xf;
    const divider = integer + fraction / 16;
    if (divider <= 0) return DEFAULT_BAUD;
    const conf =
      this.layout.clockConf !== undefined ? this.registers.get(this.layout.clockConf) ?? 0 : this.externalClockConf?.() ?? 0;
    return uartSourceClockHz(conf) / divider;
  }

  private get byteNanos(): number {
    return (10 * 1e9) / this.baudRate;
  }

  private field(value: number, index: number): number {
    const bits = this.layout.conf1FieldBits;
    return (value >>> (index * bits)) & ((1 << bits) - 1);
  }

  /** Lets bytes whose time has come leave the transmitter. */
  private drain(): void {
    const now = this.clock.nanos;
    while (this.tx.length > 0 && this.txHeadDoneAt <= now) {
      const byte = this.tx.shift()!;
      const finished = this.txHeadDoneAt;
      this.onByte?.(byte);
      if (this.tx.length > 0) this.txHeadDoneAt = finished + this.byteNanos;
      else this.raw |= TX_DONE;
    }
    this.updateTx();
  }

  private updateTx(): void {
    const threshold = this.field(this.registers.get(CONF1) ?? 0, 1);
    if (this.tx.length < Math.max(1, threshold)) this.raw |= TXFIFO_EMPTY;
  }

  private updateRx(): void {
    const conf1 = this.registers.get(CONF1) ?? 0;
    const full = this.field(conf1, 0);
    if (this.rx.length > 0 && this.rx.length >= Math.max(1, full)) this.raw |= RXFIFO_FULL;
    if (this.rx.length > 0 && this.timeoutEnabled() && this.clock.nanos >= this.timeoutAt()) this.raw |= RXFIFO_TOUT;
  }

  private timeoutEnabled(): boolean {
    const { offset, bit } = this.layout.toutEnable;
    return ((this.registers.get(offset) ?? 0) >>> bit) & 1 ? true : false;
  }

  private timeoutAt(): number {
    const t = this.layout.toutThreshold;
    const symbols = t ? ((this.registers.get(t.offset) ?? 0) >>> t.shift) & 0x3ff : 10;
    return this.lastRxAt + Math.max(1, symbols) * this.byteNanos;
  }

  readUint32(offset: number): number {
    this.drain();
    this.updateRx();
    switch (offset) {
      case FIFO:
        return this.rx.shift() ?? 0;
      case INT_RAW:
        return this.raw >>> 0;
      case INT_ST:
        return (this.raw & (this.registers.get(INT_ENA) ?? 0)) >>> 0;
      case STATUS: {
        const mask = (1 << this.layout.countBits) - 1;
        // RXD and TXD idle high; the counts are what the FIFOs hold.
        return ((Math.min(this.rx.length, mask)) | (1 << 15) | (Math.min(this.tx.length, mask) << 16) | (1 << 31)) >>> 0;
      }
      default:
        if (offset === this.layout.fsmStatus) return 0;
        if (this.layout.selfClearing.includes(offset)) return 0;
        return this.registers.get(offset) ?? 0;
    }
  }

  writeUint32(offset: number, value: number): void {
    this.drain();
    switch (offset) {
      case FIFO: {
        if (this.tx.length >= FIFO_LEN) return; // a full FIFO drops it, as the chip does
        if (this.tx.length === 0) this.txHeadDoneAt = this.clock.nanos + this.byteNanos;
        this.tx.push(value & 0xff);
        this.raw &= ~TX_DONE;
        this.updateTx();
        return;
      }
      case INT_CLR:
        this.raw &= ~value;
        this.updateTx();
        this.updateRx();
        return;
      case INT_RAW:
      case INT_ST:
      case STATUS:
        return;
      case CONF0:
        if ((value >>> this.layout.conf0RxfifoRst) & 1) this.rx = [];
        if ((value >>> this.layout.conf0TxfifoRst) & 1) this.tx = [];
        this.registers.set(offset, value >>> 0);
        return;
      default:
        this.registers.set(offset, value >>> 0);
    }
  }

  assertedInterruptSources(): number[] {
    this.drain();
    this.updateRx();
    return this.raw & (this.registers.get(INT_ENA) ?? 0) ? [this.interruptSource] : [];
  }

  nextInterruptChangeNanos(): number | undefined {
    if (this.tx.length > 0) return this.txHeadDoneAt;
    if (this.rx.length > 0 && this.timeoutEnabled() && (this.raw & RXFIFO_TOUT) === 0) return this.timeoutAt();
    return undefined;
  }

  /** Lets the transmitter catch up with simulated time; call between slices. */
  sync(): void {
    this.drain();
  }
}
