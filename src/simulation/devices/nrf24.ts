// nRF24L01+ — the register file, the FIFOs, and the radio behind them.
//
// This is a real SPI peripheral, not a message pipe with a datasheet taped to
// it. Firmware talks to it exactly as it talks to the chip: a command byte,
// STATUS returned on every transfer, registers that mean what the datasheet
// says they mean, two FIFOs with real depth, and CE and CSN as the two
// separate signals they are. A sketch that never pulls CE high transmits
// nothing here, because that is what the silicon does.
//
// The packet leaves through the shared RF medium. Nothing addresses another
// module: a transmission has a channel, an address, a start and an end on the
// simulated clock, and any radio listening on the same channel with a matching
// address picks it up. Two radios that key up together destroy each other.
//
// CE AND CSN ARE NOT THE SAME PIN, and conflating them is the classic nRF24
// wiring error. CSN selects the chip for an SPI transaction; CE is the radio's
// own enable, and its rising edge is what actually launches a packet. Both are
// read from the real circuit — CE on its own pin listener, because RF24's
// write() pulses it for ten microseconds and a per-slice sample would miss it
// entirely.
//
// AUTO-ACK is modelled, because every common library depends on it: a PRX with
// EN_AA sends an acknowledgement back through the same medium, and a PTX that
// does not hear one within the ARD retransmits up to ARC times and then raises
// MAX_RT. The ack is a real transmission with real airtime, not a flag.
//
// NOT MODELLED, and not claimed:
//
//   RPD / RSSI            The register exists and reads 0. The medium has no
//                         signal strength, so there is nothing to report and a
//                         plausible number would be a lie.
//   OBSERVE_TX PLOS_CNT   Counted; ARC_CNT is counted too, but neither is
//                         cleared by an RF_CH write as the hardware does.
//   ack payloads          W_ACK_PAYLOAD is accepted and stored so a sketch
//                         does not hang, but the payload does not ride back on
//                         the acknowledgement yet.
//   REUSE_TX_PL           Accepted; the reuse flag is tracked but a reused
//                         payload is sent once, not held.
//   CRC                   The length is configurable and included in airtime;
//                         no checksum is computed, because nothing in the
//                         medium corrupts individual bits — a collision
//                         destroys a whole packet instead.
//   ranges, distance      There is no geometry. See rfMedium.ts.

import type { ControlPinReader, DeviceSnapshot, SpiDevice, SpiMode } from './types';
import { RF_BAND, type RfMedium, type RfTransmission } from './rfMedium';

/** The modulation this family uses, so only its own kind can demodulate it. */
export const NRF24_MODULATION = 'gfsk';
/** Channel 0 sits at 2400 MHz and each step is 1 MHz. */
export const NRF24_BASE_KHZ = 2_400_000;

export const NRF_REG = {
  CONFIG: 0x00,
  EN_AA: 0x01,
  EN_RXADDR: 0x02,
  SETUP_AW: 0x03,
  SETUP_RETR: 0x04,
  RF_CH: 0x05,
  RF_SETUP: 0x06,
  STATUS: 0x07,
  OBSERVE_TX: 0x08,
  RPD: 0x09,
  RX_ADDR_P0: 0x0a,
  RX_ADDR_P1: 0x0b,
  RX_ADDR_P2: 0x0c,
  RX_ADDR_P3: 0x0d,
  RX_ADDR_P4: 0x0e,
  RX_ADDR_P5: 0x0f,
  TX_ADDR: 0x10,
  RX_PW_P0: 0x11,
  FIFO_STATUS: 0x17,
  DYNPD: 0x1c,
  FEATURE: 0x1d,
} as const;

const CMD = {
  R_REGISTER: 0x00,
  W_REGISTER: 0x20,
  R_RX_PAYLOAD: 0x61,
  W_TX_PAYLOAD: 0xa0,
  FLUSH_TX: 0xe1,
  FLUSH_RX: 0xe2,
  REUSE_TX_PL: 0xe3,
  R_RX_PL_WID: 0x60,
  W_ACK_PAYLOAD: 0xa8,
  W_TX_PAYLOAD_NOACK: 0xb0,
  NOP: 0xff,
} as const;

/** STATUS bits. */
const RX_DR = 0x40;
const TX_DS = 0x20;
const MAX_RT = 0x10;
const TX_FULL_STATUS = 0x01;

/** CONFIG bits. */
const PRIM_RX = 0x01;
const PWR_UP = 0x02;
const CRCO = 0x04;
const EN_CRC = 0x08;
const MASK_MAX_RT = 0x10;
const MASK_TX_DS = 0x20;
const MASK_RX_DR = 0x40;

/** How long after a packet ends before its acknowledgement starts. */
const ACK_TURNAROUND_US = 130;

const FIFO_DEPTH = 3;
const MAX_PAYLOAD = 32;

type Phase = 'idle' | 'transmitting' | 'awaiting-ack';

interface Packet {
  payload: Uint8Array;
  /** False for W_TX_PAYLOAD_NOACK, which never waits for an acknowledgement. */
  wantsAck: boolean;
}

interface RxEntry {
  pipe: number;
  payload: Uint8Array;
}

/** Bytes of a pipe address as the hex string the medium matches on. */
function addressKey(bytes: readonly number[], width: number): string {
  return bytes
    .slice(0, width)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export class Nrf24Device implements SpiDevice {
  readonly instanceId: string;
  readonly csPinId: string | null;
  readonly supportedModes: readonly SpiMode[] = [0];

  private readonly medium: RfMedium;
  /** Simulated microseconds, from the board this radio is wired to. */
  private readonly nowUs: () => number;

  private regs = new Uint8Array(0x20);
  /** Five-byte address registers, kept apart from the one-byte ones. */
  private rxAddrP0 = [0xe7, 0xe7, 0xe7, 0xe7, 0xe7];
  private rxAddrP1 = [0xc2, 0xc2, 0xc2, 0xc2, 0xc2];
  private txAddr = [0xe7, 0xe7, 0xe7, 0xe7, 0xe7];

  private txFifo: Packet[] = [];
  private rxFifo: RxEntry[] = [];
  /** Stored by W_ACK_PAYLOAD. Kept so a sketch does not hang; not sent yet. */
  private ackPayloads = new Map<number, Uint8Array>();

  private ce = false;
  private readControl: ControlPinReader | null = null;

  private phase: Phase = 'idle';
  private inFlight: { packet: Packet; sent: RfTransmission; retries: number } | null = null;
  private ackDeadlineUs = 0;
  /** Where this radio has read up to in the medium, so nothing repeats. */
  private rxCursor = 0;
  private ackCursor = 0;

  private selected = false;
  private command = -1;
  private byteIndex = 0;
  private scratch: number[] = [];

  private sentPackets = 0;
  private receivedPackets = 0;
  private lostPackets = 0;
  private log: string[] = [];

  constructor(instanceId: string, csPinId: string | null, medium: RfMedium, nowUs: () => number) {
    this.instanceId = instanceId;
    this.csPinId = csPinId;
    this.medium = medium;
    this.nowUs = nowUs;
    this.applyPowerOnDefaults();
  }

  private applyPowerOnDefaults(): void {
    this.regs.fill(0);
    this.regs[NRF_REG.CONFIG] = 0x08; // EN_CRC
    this.regs[NRF_REG.EN_AA] = 0x3f;
    this.regs[NRF_REG.EN_RXADDR] = 0x03;
    this.regs[NRF_REG.SETUP_AW] = 0x03; // five-byte addresses
    this.regs[NRF_REG.SETUP_RETR] = 0x03;
    this.regs[NRF_REG.RF_CH] = 0x02;
    this.regs[NRF_REG.RF_SETUP] = 0x0e; // 2 Mbps, 0 dBm
    this.regs[NRF_REG.STATUS] = 0x0e; // RX_P_NO = 7, meaning empty
    this.regs[NRF_REG.RX_ADDR_P2] = 0xc3;
    this.regs[NRF_REG.RX_ADDR_P3] = 0xc4;
    this.regs[NRF_REG.RX_ADDR_P4] = 0xc5;
    this.regs[NRF_REG.RX_ADDR_P5] = 0xc6;
    for (let p = 0; p < 6; p++) this.regs[NRF_REG.RX_PW_P0 + p] = 0;
    this.regs[NRF_REG.FIFO_STATUS] = 0x11; // both FIFOs empty
  }

  attachControls(read: ControlPinReader): void {
    this.readControl = read;
  }

  /**
   * CE, from a pin listener rather than a per-slice sample.
   *
   * RF24's write() raises CE for ten microseconds and drops it again. A model
   * that only looked at CE when the slice ended would see it low both times
   * and never transmit anything at all.
   */
  setCe(high: boolean): void {
    if (high === this.ce) return;
    this.ce = high;
    if (high) this.startPendingTransmission();
  }

  get ceHigh(): boolean {
    return this.ce;
  }

  select(active: boolean): void {
    this.selected = active;
    if (!active) {
      this.command = -1;
      this.byteIndex = 0;
      this.scratch = [];
    }
  }

  // ------------------------------------------------------------------ SPI --

  transfer(mosi: number): number | null {
    if (!this.selected) return null;
    if (this.command < 0) {
      this.command = mosi;
      this.byteIndex = 0;
      this.scratch = [];
      // A new command ends the previous payload write, so the next
      // W_TX_PAYLOAD appends a packet rather than rewriting the last one.
      this.pendingWrite = null;
      this.beginCommand(mosi);
      // Every transaction answers with STATUS on the command byte.
      return this.status();
    }
    const out = this.commandByte(mosi, this.byteIndex);
    this.byteIndex++;
    return out;
  }

  private beginCommand(cmd: number): void {
    if (cmd === CMD.FLUSH_TX) {
      this.txFifo = [];
      this.note('FLUSH_TX');
    } else if (cmd === CMD.FLUSH_RX) {
      this.rxFifo = [];
      this.setRxPipe(7);
      this.note('FLUSH_RX');
    } else if (cmd === CMD.REUSE_TX_PL) {
      this.note('REUSE_TX_PL (accepted; the payload is not held for reuse)');
    }
  }

  private commandByte(mosi: number, index: number): number {
    const cmd = this.command;

    if (cmd >= CMD.W_REGISTER && cmd < 0x40) return this.writeRegisterByte(cmd & 0x1f, mosi, index);
    if (cmd < 0x20) return this.readRegisterByte(cmd & 0x1f, index);

    switch (true) {
      case cmd === CMD.R_RX_PAYLOAD:
        return this.readPayloadByte(index);
      case cmd === CMD.W_TX_PAYLOAD || cmd === CMD.W_TX_PAYLOAD_NOACK:
        this.scratch.push(mosi);
        this.commitTxPayload(cmd === CMD.W_TX_PAYLOAD);
        return this.status();
      case (cmd & 0xf8) === CMD.W_ACK_PAYLOAD:
        this.scratch.push(mosi);
        this.ackPayloads.set(cmd & 0x07, Uint8Array.from(this.scratch));
        return this.status();
      case cmd === CMD.R_RX_PL_WID:
        return this.rxFifo[0]?.payload.length ?? 0;
      default:
        // NOP and anything unrecognised: STATUS, which is what the chip does.
        return this.status();
    }
  }

  /**
   * A payload is committed on every byte, so the FIFO holds whatever the
   * sketch actually clocked out. A library that writes a short payload with
   * static widths gets a short packet, which is exactly the bug people hit.
   */
  private commitTxPayload(wantsAck: boolean): void {
    if (this.txFifo.length > FIFO_DEPTH) return;
    const payload = Uint8Array.from(this.scratch.slice(0, MAX_PAYLOAD));
    const existing = this.txFifo[this.txFifo.length - 1];
    if (existing && existing === this.pendingWrite) {
      this.txFifo[this.txFifo.length - 1] = { payload, wantsAck };
      this.pendingWrite = this.txFifo[this.txFifo.length - 1];
      return;
    }
    if (this.txFifo.length >= FIFO_DEPTH) {
      this.note('TX FIFO full — payload dropped');
      return;
    }
    const packet = { payload, wantsAck };
    this.txFifo.push(packet);
    this.pendingWrite = packet;
  }
  private pendingWrite: Packet | null = null;

  private readRegisterByte(reg: number, index: number): number {
    if (reg === NRF_REG.RX_ADDR_P0) return this.rxAddrP0[index] ?? 0;
    if (reg === NRF_REG.RX_ADDR_P1) return this.rxAddrP1[index] ?? 0;
    if (reg === NRF_REG.TX_ADDR) return this.txAddr[index] ?? 0;
    if (reg === NRF_REG.STATUS) return this.status();
    if (reg === NRF_REG.FIFO_STATUS) return this.fifoStatus();
    return this.regs[reg];
  }

  private writeRegisterByte(reg: number, value: number, index: number): number {
    if (reg === NRF_REG.RX_ADDR_P0) {
      this.rxAddrP0[index] = value;
      return this.status();
    }
    if (reg === NRF_REG.RX_ADDR_P1) {
      this.rxAddrP1[index] = value;
      return this.status();
    }
    if (reg === NRF_REG.TX_ADDR) {
      this.txAddr[index] = value;
      return this.status();
    }
    if (reg === NRF_REG.STATUS) {
      // Write-one-to-clear on the three interrupt bits, as the datasheet says.
      this.regs[NRF_REG.STATUS] &= ~(value & (RX_DR | TX_DS | MAX_RT));
      return this.status();
    }
    if (reg === NRF_REG.OBSERVE_TX || reg === NRF_REG.RPD || reg === NRF_REG.FIFO_STATUS) {
      // Read-only on the hardware. Silently ignored, not stored.
      return this.status();
    }
    this.regs[reg] = value;
    if (reg === NRF_REG.CONFIG) this.onConfigWrite();
    return this.status();
  }

  private onConfigWrite(): void {
    if (!(this.regs[NRF_REG.CONFIG] & PWR_UP)) {
      // Power down stops everything mid-flight, as pulling PWR_UP low does.
      this.phase = 'idle';
      this.inFlight = null;
    }
  }

  // ------------------------------------------------------------- registers --

  private status(): number {
    let s = this.regs[NRF_REG.STATUS] & (RX_DR | TX_DS | MAX_RT);
    s |= (this.rxFifo.length > 0 ? (this.rxFifo[0].pipe & 0x07) : 0x07) << 1;
    if (this.txFifo.length >= FIFO_DEPTH) s |= TX_FULL_STATUS;
    return s;
  }

  private setRxPipe(_pipe: number): void {
    // RX_P_NO is derived in status() from the FIFO head, so there is only one
    // place that can be wrong.
  }

  private fifoStatus(): number {
    let v = 0;
    if (this.rxFifo.length === 0) v |= 0x01;
    if (this.rxFifo.length >= FIFO_DEPTH) v |= 0x02;
    if (this.txFifo.length === 0) v |= 0x10;
    if (this.txFifo.length >= FIFO_DEPTH) v |= 0x20;
    return v;
  }

  private readPayloadByte(index: number): number {
    const entry = this.rxFifo[0];
    if (!entry) return 0;
    const width = this.payloadWidthFor(entry);
    const byte = entry.payload[index] ?? 0;
    if (index + 1 >= width) {
      this.rxFifo.shift();
      if (this.rxFifo.length === 0) this.regs[NRF_REG.STATUS] &= ~RX_DR;
    }
    return byte;
  }

  /**
   * How many bytes a read returns.
   *
   * With dynamic payloads it is the packet's own length. With static widths it
   * is RX_PW_Pn — and a sketch whose RX_PW is set wrong reads the wrong number
   * of bytes here just as it would on hardware.
   */
  private payloadWidthFor(entry: RxEntry): number {
    if (this.regs[NRF_REG.FEATURE] & 0x04 && this.regs[NRF_REG.DYNPD] & (1 << entry.pipe)) {
      return entry.payload.length;
    }
    const configured = this.regs[NRF_REG.RX_PW_P0 + entry.pipe];
    return configured > 0 ? Math.min(configured, MAX_PAYLOAD) : entry.payload.length;
  }

  // ------------------------------------------------------------------ radio --

  private get poweredUp(): boolean {
    return (this.regs[NRF_REG.CONFIG] & PWR_UP) !== 0;
  }
  private get isReceiver(): boolean {
    return (this.regs[NRF_REG.CONFIG] & PRIM_RX) !== 0;
  }
  private get addressWidth(): number {
    return Math.min(5, (this.regs[NRF_REG.SETUP_AW] & 0x03) + 2);
  }
  private get crcBytes(): number {
    if (!(this.regs[NRF_REG.CONFIG] & EN_CRC)) return 0;
    return this.regs[NRF_REG.CONFIG] & CRCO ? 2 : 1;
  }
  /** Bits per second, from RF_SETUP. RF_DR_LOW wins, as on the hardware. */
  get dataRate(): number {
    const setup = this.regs[NRF_REG.RF_SETUP];
    if (setup & 0x20) return 250_000;
    return setup & 0x08 ? 2_000_000 : 1_000_000;
  }
  get channel(): number {
    return this.regs[NRF_REG.RF_CH] & 0x7f;
  }
  /** The centre frequency, which is what the medium actually keys on. */
  get frequencyKhz(): number {
    return NRF24_BASE_KHZ + this.channel * 1000;
  }

  /** Airtime of a packet: preamble, address, packet control field, payload, CRC. */
  private airtimeUs(payloadBytes: number): number {
    const bits = 8 * (1 + this.addressWidth + payloadBytes + this.crcBytes) + 9;
    return (bits / this.dataRate) * 1_000_000;
  }

  private get autoRetransmitDelayUs(): number {
    return (((this.regs[NRF_REG.SETUP_RETR] >> 4) & 0x0f) + 1) * 250;
  }
  private get autoRetransmitCount(): number {
    return this.regs[NRF_REG.SETUP_RETR] & 0x0f;
  }

  /**
   * Launches the head of the TX FIFO, if everything the hardware needs is
   * true: powered, in transmit mode, CE raised, and something to send.
   */
  private startPendingTransmission(): void {
    if (this.phase !== 'idle') return;
    if (!this.poweredUp || this.isReceiver || !this.ce) return;
    // MAX_RT blocks the radio until it is cleared. The datasheet is explicit
    // about this and it is why a sketch that ignores the flag ends up with a
    // module that has simply stopped — one of the most common nRF24 faults
    // there is, and one a forgiving model would hide.
    if (this.regs[NRF_REG.STATUS] & MAX_RT) return;
    const packet = this.txFifo[0];
    if (!packet) return;
    this.launch(packet, 0);
  }

  private launch(packet: Packet, retries: number): void {
    const start = this.nowUs();
    const sent = this.medium.transmit({
      transmitterId: this.instanceId,
      band: RF_BAND,
      channel: this.frequencyKhz,
      startUs: start,
      endUs: start + this.airtimeUs(packet.payload.length),
      payload: packet.payload,
      match: {
        modulation: NRF24_MODULATION,
        address: addressKey(this.txAddr, this.addressWidth),
        rate: this.dataRate,
        ack: 0,
      },
    });
    this.inFlight = { packet, sent, retries };
    this.phase = 'transmitting';
    this.pendingWrite = null;
  }

  /**
   * The receiving half of a slice of radio time.
   *
   * Deliberately separate from the transmitting half, and run first across
   * every radio on the canvas. On hardware an acknowledgement leaves about
   * 130 microseconds after the packet it answers, long before the sender's
   * retransmit delay expires; polling once per slice would let a transmitter
   * evaluate its timeout before the receiver had even looked, and it would
   * retransmit a packet that had in fact arrived. Two passes make the order
   * match the hardware's instead of the scheduler's.
   */
  radioReceive(): void {
    if (this.readControl) {
      const level = this.readControl('ce');
      if (level !== undefined && level !== this.ce) this.setCe(level);
    }
    if (!this.poweredUp || !this.isReceiver) return;
    this.pollForPackets(this.nowUs());
  }

  /**
   * The transmitting half. Packet-level rather than bit-level: a 32-byte
   * payload at 1 Mbps is about 350 microseconds of air, well inside a slice,
   * so a packet begins and ends between two calls. The medium holds the real
   * start and end, so overlap between two radios is judged on the true times
   * even though the polling is coarser.
   */
  radioTransmit(): void {
    if (!this.poweredUp || this.isReceiver) return;
    this.advanceTransmit(this.nowUs());
  }

  private advanceTransmit(now: number): void {
    const flight = this.inFlight;
    if (this.phase === 'transmitting' && flight) {
      if (now < flight.sent.endUs) return;
      const wantsAck = flight.packet.wantsAck && this.autoAckEnabledForTx();
      if (!wantsAck) {
        this.finishTransmit(true);
        return;
      }
      this.phase = 'awaiting-ack';
      this.ackDeadlineUs = flight.sent.endUs + ACK_TURNAROUND_US + this.autoRetransmitDelayUs + this.airtimeUs(0);
      // Falls through: the receiver's pass has already run this slice, so an
      // acknowledgement that is genuinely in the air is found now rather than
      // a slice later.
    }

    if (this.phase === 'awaiting-ack' && flight) {
      const acks = this.medium.completed(
        {
          band: RF_BAND,
          channel: this.frequencyKhz,
          match: { modulation: NRF24_MODULATION, address: addressKey(this.txAddr, this.addressWidth), ack: 1 },
        },
        this.ackCursor,
        now,
      );
      for (const reception of acks) {
        this.ackCursor = Math.max(this.ackCursor, reception.transmission.id);
        if (reception.collided) continue;
        this.finishTransmit(true);
        return;
      }
      if (now < this.ackDeadlineUs) return;

      // No acknowledgement in time. Retransmit, or give up the way the chip
      // gives up: MAX_RT, and the payload STAYS in the FIFO until flushed.
      if (flight.retries < this.autoRetransmitCount) {
        this.bumpArc();
        this.launch(flight.packet, flight.retries + 1);
        return;
      }
      this.finishTransmit(false);
      return;
    }

    if (this.phase === 'idle') this.startPendingTransmission();
  }

  private autoAckEnabledForTx(): boolean {
    // A PTX asks for an acknowledgement when auto-ack is on for pipe 0, which
    // is the pipe the ack comes back on.
    return (this.regs[NRF_REG.EN_AA] & 0x01) !== 0;
  }

  private bumpArc(): void {
    const observe = this.regs[NRF_REG.OBSERVE_TX];
    const arc = Math.min(15, (observe & 0x0f) + 1);
    this.regs[NRF_REG.OBSERVE_TX] = (observe & 0xf0) | arc;
  }

  private finishTransmit(delivered: boolean): void {
    this.phase = 'idle';
    this.inFlight = null;
    if (delivered) {
      this.txFifo.shift();
      this.regs[NRF_REG.STATUS] |= TX_DS;
      this.regs[NRF_REG.OBSERVE_TX] &= 0xf0;
      this.sentPackets++;
    } else {
      // The payload is deliberately left in the FIFO: the hardware keeps it,
      // and a sketch that ignores MAX_RT without flushing gets a stuck radio,
      // which is a real and very common bug.
      this.regs[NRF_REG.STATUS] |= MAX_RT;
      const plos = Math.min(15, (this.regs[NRF_REG.OBSERVE_TX] >> 4) + 1);
      this.regs[NRF_REG.OBSERVE_TX] = (plos << 4) | (this.regs[NRF_REG.OBSERVE_TX] & 0x0f);
      this.lostPackets++;
      this.note('MAX_RT — no acknowledgement');
    }
    // Anything still queued goes out while CE is held high.
    if (this.ce) this.startPendingTransmission();
  }

  /** Every pipe this radio is listening on, as medium listeners. */
  private enabledPipes(): { pipe: number; address: string }[] {
    const width = this.addressWidth;
    const enabled = this.regs[NRF_REG.EN_RXADDR];
    const pipes: { pipe: number; address: string }[] = [];
    if (enabled & 0x01) pipes.push({ pipe: 0, address: addressKey(this.rxAddrP0, width) });
    if (enabled & 0x02) pipes.push({ pipe: 1, address: addressKey(this.rxAddrP1, width) });
    for (let p = 2; p <= 5; p++) {
      if (!(enabled & (1 << p))) continue;
      // Pipes 2..5 share the upper bytes of pipe 1 and carry only their own
      // least significant byte, exactly as the datasheet describes.
      const bytes = [this.regs[NRF_REG.RX_ADDR_P0 + p], ...this.rxAddrP1.slice(1)];
      pipes.push({ pipe: p, address: addressKey(bytes, width) });
    }
    return pipes;
  }

  private pollForPackets(now: number): void {
    // CE low in receive mode is standby: the radio is not listening at all.
    if (!this.ce) return;

    for (const { pipe, address } of this.enabledPipes()) {
      const received = this.medium.completed(
        {
          band: RF_BAND,
          channel: this.frequencyKhz,
          match: { modulation: NRF24_MODULATION, address, rate: this.dataRate, ack: 0 },
        },
        this.rxCursor,
        now,
      );
      for (const reception of received) {
        this.rxCursor = Math.max(this.rxCursor, reception.transmission.id);
        if (reception.collided) {
          // Two radios keyed up together. A real receiver's CRC fails and the
          // packet never reaches the FIFO — so it does not here either.
          this.note('a packet was destroyed by a collision');
          continue;
        }
        if (this.rxFifo.length >= FIFO_DEPTH) {
          this.note('RX FIFO full — packet dropped');
          continue;
        }
        this.rxFifo.push({ pipe, payload: reception.transmission.payload });
        this.regs[NRF_REG.STATUS] |= RX_DR;
        this.receivedPackets++;
        if (this.regs[NRF_REG.EN_AA] & (1 << pipe)) this.sendAck(reception.transmission, now);
      }
    }
  }

  /** The acknowledgement, as a real transmission with real airtime. */
  private sendAck(to: RfTransmission, now: number): void {
    this.medium.transmit({
      transmitterId: this.instanceId,
      band: RF_BAND,
      channel: this.frequencyKhz,
      // Timed from the packet it answers, not from when this radio happened
      // to be polled: the hardware turns the acknowledgement round in about
      // 130 microseconds regardless of anything the simulator is doing.
      startUs: Math.max(now, to.endUs) + ACK_TURNAROUND_US,
      endUs: Math.max(now, to.endUs) + ACK_TURNAROUND_US + this.airtimeUs(0),
      payload: new Uint8Array(0),
      match: { modulation: NRF24_MODULATION, address: String(to.match.address), rate: this.dataRate, ack: 1 },
    });
  }

  // ------------------------------------------------------------ inspection --

  /** True while any interrupt the CONFIG mask allows is asserted. */
  get irqAsserted(): boolean {
    const config = this.regs[NRF_REG.CONFIG];
    const status = this.regs[NRF_REG.STATUS];
    if (status & RX_DR && !(config & MASK_RX_DR)) return true;
    if (status & TX_DS && !(config & MASK_TX_DS)) return true;
    if (status & MAX_RT && !(config & MASK_MAX_RT)) return true;
    return false;
  }

  get statusByte(): number {
    return this.status();
  }
  get txQueued(): number {
    return this.txFifo.length;
  }
  get rxQueued(): number {
    return this.rxFifo.length;
  }
  get sentCount(): number {
    return this.sentPackets;
  }
  get receivedCount(): number {
    return this.receivedPackets;
  }
  get lostCount(): number {
    return this.lostPackets;
  }
  get transmitAddress(): string {
    return addressKey(this.txAddr, this.addressWidth);
  }
  registerValue(reg: number): number {
    return reg === NRF_REG.STATUS ? this.status() : reg === NRF_REG.FIFO_STATUS ? this.fifoStatus() : this.regs[reg];
  }

  private note(text: string): void {
    this.log.push(text);
    if (this.log.length > 40) this.log.shift();
  }

  reset(): void {
    this.applyPowerOnDefaults();
    this.rxAddrP0 = [0xe7, 0xe7, 0xe7, 0xe7, 0xe7];
    this.rxAddrP1 = [0xc2, 0xc2, 0xc2, 0xc2, 0xc2];
    this.txAddr = [0xe7, 0xe7, 0xe7, 0xe7, 0xe7];
    this.txFifo = [];
    this.rxFifo = [];
    this.ackPayloads.clear();
    this.phase = 'idle';
    this.inFlight = null;
    this.rxCursor = 0;
    this.ackCursor = 0;
    this.ce = false;
    this.sentPackets = 0;
    this.receivedPackets = 0;
    this.lostPackets = 0;
    this.log = [];
  }

  snapshot(): DeviceSnapshot {
    const mode = !this.poweredUp ? 'powered down' : this.isReceiver ? 'receiving' : 'transmitting';
    return {
      status:
        `nRF24L01+ — ${mode}, channel ${this.channel}, ${this.dataRate / 1000} kbps, ` +
        `CE ${this.ce ? 'high' : 'low'}, TX addr ${this.transmitAddress}, ` +
        `${this.sentPackets} sent, ${this.receivedPackets} received` +
        (this.lostPackets ? `, ${this.lostPackets} gave up (MAX_RT)` : ''),
      log: [...this.log],
    };
  }
}
