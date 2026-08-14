// A UART link between a board pad and a device, built once.
//
// The temptation with UART modules is to skip the wire. A GPS is on the canvas,
// a board has a serial peripheral, so the GPS calls `runner.queueSerialInput`
// and everything appears to work. That is the shortcut this file exists to
// avoid, because with it:
//
//   • a GPS wired to the wrong pins still works;
//   • a GPS with no wires at all still works;
//   • two boards each with their own GPS get each other's sentences;
//   • a baud mismatch produces perfect text instead of rubbish;
//   • and a board with no UART peripheral appears to have one.
//
// So a link exists only when TX and RX are genuinely on nets that reach the
// board's own UART pads, and it is owned by a board INSTANCE — two identical
// Picos with identical pin numbering get two independent links.
//
// FIDELITY, STATED PLAINLY. This is a byte-level endpoint with modelled
// timing, not a bit-level one. The MCU's UART peripheral already frames and
// deframes bytes internally; re-deriving them from a sampled line would mean
// modelling the peripheral's own shift register twice and would buy nothing
// that firmware can observe. What IS modelled, because firmware can observe it:
//
//   • byte time, from the configured baud, data bits, parity and stop bits, so
//     a device cannot deliver faster than the wire allows;
//   • baud agreement — a device and a peripheral running at different rates do
//     NOT exchange clean bytes, they exchange framing errors;
//   • idle line state, so a receiver knows the difference between silence and
//     a stream of zeros;
//   • drive contention, when two things drive one RX net at once.
//
// A bit-level model would add start-bit edges to that list. It is a deliberate
// gap, recorded here and in the coverage matrix as `uart-bit-level`, not a
// claim silently avoided.

/** Line settings both ends have to agree on for bytes to survive. */
export interface UartConfig {
  baud: number;
  dataBits: 5 | 6 | 7 | 8 | 9;
  parity: 'none' | 'even' | 'odd';
  stopBits: 1 | 2;
}

export const DEFAULT_UART: UartConfig = { baud: 9600, dataBits: 8, parity: 'none', stopBits: 1 };

/**
 * Microseconds one byte occupies on the wire.
 *
 * Start bit, data bits, optional parity, stop bits. This is what stops a device
 * emitting a hundred NMEA sentences in a millisecond because nothing was
 * counting.
 */
export function byteTimeUs(config: UartConfig): number {
  const bits = 1 + config.dataBits + (config.parity === 'none' ? 0 : 1) + config.stopBits;
  return (bits / config.baud) * 1_000_000;
}

/**
 * How badly two ends disagree about baud.
 *
 * A UART tolerates a few percent — the receiver resamples in the middle of each
 * bit and drifts by less than half a bit over a frame. Past roughly 3% the last
 * bits of a frame land in the wrong slots and the byte is corrupt. Modelled as
 * a threshold rather than as per-bit sampling because the observable outcome is
 * binary: firmware either gets its byte or gets a framing error.
 */
export const BAUD_TOLERANCE = 0.03;

export function baudCompatible(a: number, b: number): boolean {
  if (a <= 0 || b <= 0) return false;
  return Math.abs(a - b) / Math.max(a, b) <= BAUD_TOLERANCE;
}

/** What a device does with a byte from the board, and what it sends back. */
export interface UartPeripheral {
  readonly instanceId: string;
  /** Called for every byte the board transmits that this device receives. */
  onByteFromBoard(byte: number, atUs: number): void;
  /** Bytes this device wants to send, drained by the link as the wire allows. */
  takeBytesForBoard(atUs: number): number[];
  /** The device's own line settings. A mismatch corrupts traffic. */
  uartConfig(): UartConfig;
  reset(): void;
}

/**
 * One TX/RX pair between a board instance and one device.
 *
 * The link is the only thing that touches the runner. A device never sees a
 * board, which is what keeps a device from reaching the wrong one.
 */
export class UartLink {
  readonly boardInstanceId: string;
  readonly device: UartPeripheral;
  /** Board settings, updated from the peripheral each poll. */
  private boardConfig: UartConfig = { ...DEFAULT_UART };

  /** Bytes waiting to go to the board, with the earliest time each may arrive. */
  private inbound: { byte: number; readyAtUs: number }[] = [];
  private nextSlotUs = 0;

  private bytesToDevice = 0;
  private bytesToBoard = 0;
  private framingErrors = 0;
  private contentionBytes = 0;

  constructor(boardInstanceId: string, device: UartPeripheral) {
    this.boardInstanceId = boardInstanceId;
    this.device = device;
  }

  /** The board's current line settings, read from its peripheral. */
  setBoardConfig(config: Partial<UartConfig>): void {
    this.boardConfig = { ...this.boardConfig, ...config };
  }

  get boardBaud(): number {
    return this.boardConfig.baud;
  }

  /**
   * A byte the board transmitted.
   *
   * Corrupted rather than dropped when the two ends disagree about baud: a real
   * receiver sees a byte, it is simply the wrong one, and a device that
   * silently received nothing would look like a wiring fault instead of a
   * configuration one.
   */
  boardTransmitted(byte: number, atUs: number): void {
    const deviceConfig = this.device.uartConfig();
    if (!baudCompatible(this.boardConfig.baud, deviceConfig.baud)) {
      this.framingErrors++;
      this.device.onByteFromBoard(corrupt(byte), atUs);
      return;
    }
    this.bytesToDevice++;
    this.device.onByteFromBoard(byte, atUs);
  }

  /**
   * Collects whatever the device wants to send and schedules it on the wire.
   *
   * Bytes are released at one byte time apart, so a device that hands over a
   * whole NMEA sentence delivers it over the milliseconds it would really take
   * rather than instantly. That matters: a sketch reading with a timeout
   * behaves differently against a burst than against a stream.
   */
  poll(nowUs: number): void {
    const produced = this.device.takeBytesForBoard(nowUs);
    if (produced.length > 0) {
      const deviceConfig = this.device.uartConfig();
      const spacing = byteTimeUs(deviceConfig);
      let at = Math.max(nowUs, this.nextSlotUs);
      for (const byte of produced) {
        this.inbound.push({ byte, readyAtUs: at });
        at += spacing;
      }
      this.nextSlotUs = at;
    }
  }

  /**
   * Bytes that have arrived by `nowUs`, ready for the board's UART.
   *
   * A baud mismatch corrupts these the same way it corrupts the other
   * direction, so a sketch running at the wrong rate reads rubbish rather than
   * clean text.
   */
  drainToBoard(nowUs: number): number[] {
    const deviceConfig = this.device.uartConfig();
    const compatible = baudCompatible(this.boardConfig.baud, deviceConfig.baud);
    const out: number[] = [];
    while (this.inbound.length > 0 && this.inbound[0].readyAtUs <= nowUs) {
      const { byte } = this.inbound.shift()!;
      if (compatible) {
        out.push(byte);
        this.bytesToBoard++;
      } else {
        out.push(corrupt(byte));
        this.framingErrors++;
      }
    }
    return out;
  }

  /** Records that something else drove this RX net at the same time. */
  noteContention(count = 1): void {
    this.contentionBytes += count;
  }

  get stats(): {
    toDevice: number;
    toBoard: number;
    framingErrors: number;
    contentionBytes: number;
    pending: number;
  } {
    return {
      toDevice: this.bytesToDevice,
      toBoard: this.bytesToBoard,
      framingErrors: this.framingErrors,
      contentionBytes: this.contentionBytes,
      pending: this.inbound.length,
    };
  }

  reset(): void {
    this.inbound = [];
    this.nextSlotUs = 0;
    this.bytesToDevice = 0;
    this.bytesToBoard = 0;
    this.framingErrors = 0;
    this.contentionBytes = 0;
  }
}

/**
 * What a byte looks like after being sampled at the wrong rate.
 *
 * Not random: a deterministic mangling, so a test can assert that firmware got
 * something other than what was sent without the result changing between runs.
 * The specific value is not meaningful and is not meant to be — the point is
 * that it is not the byte that was transmitted.
 */
function corrupt(byte: number): number {
  return (byte ^ 0x55) & 0xff;
}
