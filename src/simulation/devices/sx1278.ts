// SX1278 — the LoRa transceiver, as a register file and a FIFO.
//
// Same shape as the nRF24 and deliberately so: this is a real SPI peripheral
// whose firmware-visible behaviour is the register map, and the packet goes
// out through the same shared medium every other radio uses. Nothing here is a
// transport of its own.
//
// The SX127x SPI convention is one address byte — bit 7 set means write — and
// then any number of data bytes, with register 0x00 being the FIFO and reads
// and writes of it advancing RegFifoAddrPtr. Libraries rely on exactly that,
// so it is what happens.
//
// AIRTIME IS THE POINT OF LORA and it is computed properly, from the datasheet
// formula: the symbol time is 2^SF/BW, the preamble is (n + 4.25) symbols, and
// the payload symbol count comes from the payload length, the spreading
// factor, the coding rate, the CRC and the header mode. A packet at SF12/125k
// takes over a second; the same packet at SF7 takes tens of milliseconds. That
// difference is the entire engineering tradeoff of LoRa, and a model that let
// packets arrive instantly would hide it.
//
// COMPATIBILITY is enforced rather than assumed. Two modules talk only when
// their frequency, spreading factor, bandwidth and sync word agree. Mismatched
// settings are the commonest LoRa failure and this reproduces it, with an
// explanation available for the inspector rather than silence.
//
// NOT MODELLED, and not claimed:
//
//   RSSI, SNR, link budget    RegPktRssiValue and RegPktSnrValue read as the
//   sensitivity, range        register's reset value. The medium has no signal
//                             strength and no geometry, so any number here
//                             would be invented, and range is the number
//                             people would most want to trust.
//   FSK/OOK mode              LongRangeMode must be set; the FSK register bank
//                             is not implemented, and a sketch that clears the
//                             bit is told so rather than quietly continuing.
//   CAD                       Channel activity detection is not implemented.
//   frequency hopping         RegHopPeriod is stored and ignored.
//   implicit-header CRC       The header mode affects airtime; the CRC itself
//                             is not computed, because the medium corrupts
//                             whole packets rather than individual bits.
//   low-data-rate optimise    RegModemConfig3 bit 3 is stored and included in
//                             the airtime formula, but nothing else uses it.

import { RF_BAND, type RfMedium } from './rfMedium';
import type { ControlPinReader, DeviceSnapshot, SpiDevice, SpiMode } from './types';

export const LORA_MODULATION = 'lora';

export const SX_REG = {
  FIFO: 0x00,
  OP_MODE: 0x01,
  FRF_MSB: 0x06,
  FRF_MID: 0x07,
  FRF_LSB: 0x08,
  PA_CONFIG: 0x09,
  FIFO_ADDR_PTR: 0x0d,
  FIFO_TX_BASE_ADDR: 0x0e,
  FIFO_RX_BASE_ADDR: 0x0f,
  FIFO_RX_CURRENT_ADDR: 0x10,
  IRQ_FLAGS_MASK: 0x11,
  IRQ_FLAGS: 0x12,
  RX_NB_BYTES: 0x13,
  PKT_SNR_VALUE: 0x19,
  PKT_RSSI_VALUE: 0x1a,
  MODEM_CONFIG_1: 0x1d,
  MODEM_CONFIG_2: 0x1e,
  SYMB_TIMEOUT_LSB: 0x1f,
  PREAMBLE_MSB: 0x20,
  PREAMBLE_LSB: 0x21,
  PAYLOAD_LENGTH: 0x22,
  MAX_PAYLOAD_LENGTH: 0x23,
  HOP_PERIOD: 0x24,
  MODEM_CONFIG_3: 0x26,
  SYNC_WORD: 0x39,
  DIO_MAPPING_1: 0x40,
  VERSION: 0x42,
} as const;

/** RegOpMode modes, low three bits. */
export const SX_MODE = {
  SLEEP: 0,
  STANDBY: 1,
  FSTX: 2,
  TX: 3,
  FSRX: 4,
  RX_CONTINUOUS: 5,
  RX_SINGLE: 6,
  CAD: 7,
} as const;

/** RegIrqFlags bits. */
export const IRQ_RX_TIMEOUT = 0x80;
export const IRQ_RX_DONE = 0x40;
export const IRQ_CRC_ERROR = 0x20;
export const IRQ_TX_DONE = 0x08;

const LONG_RANGE_MODE = 0x80;
const FIFO_SIZE = 256;
/** The crystal every SX127x module is built around. */
const FXOSC = 32_000_000;

/** RegModemConfig1's four-bit bandwidth field, in hertz. */
const BANDWIDTHS = [
  7_800, 10_400, 15_600, 20_800, 31_250, 41_700, 62_500, 125_000, 250_000, 500_000,
];

export class Sx1278Device implements SpiDevice {
  readonly instanceId: string;
  readonly csPinId: string | null;
  readonly supportedModes: readonly SpiMode[] = [0];

  private readonly medium: RfMedium;
  private readonly nowUs: () => number;

  private regs = new Uint8Array(0x80);
  private fifo = new Uint8Array(FIFO_SIZE);

  private selected = false;
  private address = -1;
  private writing = false;

  private txEndsUs = -1;
  private rxCursor = 0;
  private sentPackets = 0;
  private receivedPackets = 0;
  private corrupted = 0;
  private log: string[] = [];

  constructor(instanceId: string, csPinId: string | null, medium: RfMedium, nowUs: () => number) {
    this.instanceId = instanceId;
    this.csPinId = csPinId;
    this.medium = medium;
    this.nowUs = nowUs;
    this.applyResetDefaults();
  }

  private applyResetDefaults(): void {
    this.regs.fill(0);
    this.regs[SX_REG.OP_MODE] = 0x01; // FSK standby, exactly as the chip wakes
    // 434 MHz, the SX1278 reset default.
    this.regs[SX_REG.FRF_MSB] = 0x6c;
    this.regs[SX_REG.FRF_MID] = 0x80;
    this.regs[SX_REG.FRF_LSB] = 0x00;
    this.regs[SX_REG.PA_CONFIG] = 0x4f;
    this.regs[SX_REG.MODEM_CONFIG_1] = 0x72; // BW 125 kHz, CR 4/5, explicit header
    this.regs[SX_REG.MODEM_CONFIG_2] = 0x70; // SF7, CRC off
    this.regs[SX_REG.PREAMBLE_LSB] = 0x08;
    this.regs[SX_REG.PAYLOAD_LENGTH] = 0x01;
    this.regs[SX_REG.MAX_PAYLOAD_LENGTH] = 0xff;
    this.regs[SX_REG.SYNC_WORD] = 0x12;
    this.regs[SX_REG.VERSION] = 0x12; // what every library checks first
    this.fifo.fill(0);
  }

  attachControls(_read: ControlPinReader): void {
    // The SX1278's RESET and DIO lines are read from the circuit elsewhere;
    // nothing about a transaction depends on them.
  }

  select(active: boolean): void {
    this.selected = active;
    if (!active) {
      this.address = -1;
      this.writing = false;
    }
  }

  transfer(mosi: number): number | null {
    if (!this.selected) return null;
    if (this.address < 0) {
      this.writing = (mosi & 0x80) !== 0;
      this.address = mosi & 0x7f;
      return 0;
    }
    const value = this.writing ? this.writeRegister(this.address, mosi) : this.readRegister(this.address);
    // Burst access walks forward through the register file, except at the FIFO
    // where the chip stays put and the FIFO pointer moves instead.
    if (this.address !== SX_REG.FIFO) this.address = (this.address + 1) & 0x7f;
    return value;
  }

  private readRegister(reg: number): number {
    if (reg === SX_REG.FIFO) {
      const ptr = this.regs[SX_REG.FIFO_ADDR_PTR];
      this.regs[SX_REG.FIFO_ADDR_PTR] = (ptr + 1) & 0xff;
      return this.fifo[ptr];
    }
    return this.regs[reg];
  }

  private writeRegister(reg: number, value: number): number {
    if (reg === SX_REG.FIFO) {
      const ptr = this.regs[SX_REG.FIFO_ADDR_PTR];
      this.fifo[ptr] = value;
      this.regs[SX_REG.FIFO_ADDR_PTR] = (ptr + 1) & 0xff;
      return 0;
    }
    if (reg === SX_REG.IRQ_FLAGS) {
      // Write-one-to-clear, like every interrupt-flag register worth the name.
      this.regs[SX_REG.IRQ_FLAGS] &= ~value;
      return 0;
    }
    if (reg === SX_REG.VERSION || reg === SX_REG.FIFO_RX_CURRENT_ADDR || reg === SX_REG.RX_NB_BYTES) {
      return 0; // read-only on the hardware
    }
    const previous = this.regs[reg];
    this.regs[reg] = value;
    if (reg === SX_REG.OP_MODE) this.onModeWrite(previous, value);
    return 0;
  }

  private onModeWrite(previous: number, value: number): void {
    const wasTx = (previous & 0x07) === SX_MODE.TX;
    const isTx = (value & 0x07) === SX_MODE.TX;
    if (!(value & LONG_RANGE_MODE)) {
      this.note('LongRangeMode is clear: the FSK/OOK register bank is not implemented');
      return;
    }
    if (isTx && !wasTx) this.beginTransmit();
  }

  // ----------------------------------------------------------- modem state --

  get loraMode(): boolean {
    return (this.regs[SX_REG.OP_MODE] & LONG_RANGE_MODE) !== 0;
  }
  get mode(): number {
    return this.regs[SX_REG.OP_MODE] & 0x07;
  }
  /** Centre frequency in hertz, from the three Frf registers. */
  get frequencyHz(): number {
    const frf =
      (this.regs[SX_REG.FRF_MSB] << 16) | (this.regs[SX_REG.FRF_MID] << 8) | this.regs[SX_REG.FRF_LSB];
    return Math.round((frf * FXOSC) / 2 ** 19);
  }
  get frequencyKhz(): number {
    return Math.round(this.frequencyHz / 1000);
  }
  get spreadingFactor(): number {
    return (this.regs[SX_REG.MODEM_CONFIG_2] >> 4) & 0x0f;
  }
  get bandwidthHz(): number {
    const index = (this.regs[SX_REG.MODEM_CONFIG_1] >> 4) & 0x0f;
    return BANDWIDTHS[index] ?? 125_000;
  }
  /** 4/5 through 4/8, as the denominator's offset: 1..4. */
  get codingRate(): number {
    return (this.regs[SX_REG.MODEM_CONFIG_1] >> 1) & 0x07;
  }
  get implicitHeader(): boolean {
    return (this.regs[SX_REG.MODEM_CONFIG_1] & 0x01) !== 0;
  }
  get crcOn(): boolean {
    return (this.regs[SX_REG.MODEM_CONFIG_2] & 0x04) !== 0;
  }
  get lowDataRateOptimise(): boolean {
    return (this.regs[SX_REG.MODEM_CONFIG_3] & 0x08) !== 0;
  }
  get syncWord(): number {
    return this.regs[SX_REG.SYNC_WORD];
  }
  get preambleSymbols(): number {
    return (this.regs[SX_REG.PREAMBLE_MSB] << 8) | this.regs[SX_REG.PREAMBLE_LSB];
  }

  /**
   * Time on air, from the datasheet formula.
   *
   * This is the number that makes LoRa what it is: the same 16-byte payload is
   * about 37 ms at SF7/125k and about 1.15 s at SF12/125k. Instant delivery
   * would hide the entire tradeoff the technology exists for.
   */
  airtimeUs(payloadBytes: number): number {
    const sf = Math.min(12, Math.max(6, this.spreadingFactor));
    const symbolUs = ((2 ** sf) / this.bandwidthHz) * 1_000_000;
    const de = this.lowDataRateOptimise ? 1 : 0;
    const numerator = 8 * payloadBytes - 4 * sf + 28 + (this.crcOn ? 16 : 0) - (this.implicitHeader ? 20 : 0);
    const denominator = 4 * (sf - 2 * de);
    const payloadSymbols = 8 + Math.max(Math.ceil(numerator / denominator) * (this.codingRate + 4), 0);
    return (this.preambleSymbols + 4.25 + payloadSymbols) * symbolUs;
  }

  /** Everything two modules must agree on before one can hear the other. */
  private modemMatch(): Record<string, string | number> {
    return {
      modulation: LORA_MODULATION,
      sf: this.spreadingFactor,
      bw: this.bandwidthHz,
      sync: this.syncWord,
    };
  }

  private beginTransmit(): void {
    const length = this.regs[SX_REG.PAYLOAD_LENGTH];
    const base = this.regs[SX_REG.FIFO_TX_BASE_ADDR];
    const payload = this.fifo.slice(base, base + length);
    const start = this.nowUs();
    const airtime = this.airtimeUs(length);
    this.medium.transmit({
      transmitterId: this.instanceId,
      band: RF_BAND,
      channel: this.frequencyKhz,
      startUs: start,
      endUs: start + airtime,
      payload,
      match: this.modemMatch(),
    });
    this.txEndsUs = start + airtime;
    this.sentPackets++;
    this.note(`transmitting ${length} byte(s), ${(airtime / 1000).toFixed(1)} ms on air`);
  }

  /** The receiving half of a slice. See the nRF24 for why the passes split. */
  radioReceive(): void {
    if (!this.loraMode) return;
    if (this.mode !== SX_MODE.RX_CONTINUOUS && this.mode !== SX_MODE.RX_SINGLE) return;

    const now = this.nowUs();
    const received = this.medium.completed(
      { band: RF_BAND, channel: this.frequencyKhz, match: this.modemMatch() },
      this.rxCursor,
      now,
    );
    for (const reception of received) {
      this.rxCursor = Math.max(this.rxCursor, reception.transmission.id);
      if (reception.collided) {
        // Something else was on this frequency at the same moment. A real
        // modem loses the packet or flags a CRC error; it does not get clean
        // data out of two overlapping chirps.
        this.corrupted++;
        this.regs[SX_REG.IRQ_FLAGS] |= IRQ_RX_DONE | IRQ_CRC_ERROR;
        this.note('a packet collided: CRC error raised');
        continue;
      }
      const payload = reception.transmission.payload;
      const base = this.regs[SX_REG.FIFO_RX_BASE_ADDR];
      this.fifo.set(payload.slice(0, FIFO_SIZE - base), base);
      this.regs[SX_REG.FIFO_RX_CURRENT_ADDR] = base;
      this.regs[SX_REG.FIFO_ADDR_PTR] = base;
      this.regs[SX_REG.RX_NB_BYTES] = payload.length;
      this.regs[SX_REG.IRQ_FLAGS] |= IRQ_RX_DONE;
      this.receivedPackets++;
      if (this.mode === SX_MODE.RX_SINGLE) this.regs[SX_REG.OP_MODE] = (this.regs[SX_REG.OP_MODE] & 0xf8) | SX_MODE.STANDBY;
    }
  }

  /** The transmitting half of a slice. */
  radioTransmit(): void {
    if (this.txEndsUs < 0 || this.nowUs() < this.txEndsUs) return;
    this.txEndsUs = -1;
    this.regs[SX_REG.IRQ_FLAGS] |= IRQ_TX_DONE;
    // The chip drops to standby when a packet has gone, which is why a
    // library's send() can return and the next send() re-enters TX.
    this.regs[SX_REG.OP_MODE] = (this.regs[SX_REG.OP_MODE] & 0xf8) | SX_MODE.STANDBY;
  }

  /** Why this module cannot hear that one — for the inspector, not for luck. */
  explainDeafnessTo(other: Sx1278Device): string | null {
    if (this.frequencyKhz !== other.frequencyKhz) {
      return `different frequency (${this.frequencyKhz} kHz vs ${other.frequencyKhz} kHz)`;
    }
    if (this.spreadingFactor !== other.spreadingFactor) {
      return `different spreading factor (SF${this.spreadingFactor} vs SF${other.spreadingFactor})`;
    }
    if (this.bandwidthHz !== other.bandwidthHz) {
      return `different bandwidth (${this.bandwidthHz / 1000} kHz vs ${other.bandwidthHz / 1000} kHz)`;
    }
    if (this.syncWord !== other.syncWord) {
      return `different sync word (0x${this.syncWord.toString(16)} vs 0x${other.syncWord.toString(16)})`;
    }
    return null;
  }

  // ------------------------------------------------------------ inspection --

  /** True while an unmasked interrupt flag is set — what DIO0 follows. */
  get irqAsserted(): boolean {
    return (this.regs[SX_REG.IRQ_FLAGS] & ~this.regs[SX_REG.IRQ_FLAGS_MASK] & 0xff) !== 0;
  }
  get irqFlags(): number {
    return this.regs[SX_REG.IRQ_FLAGS];
  }
  get sentCount(): number {
    return this.sentPackets;
  }
  get receivedCount(): number {
    return this.receivedPackets;
  }
  get corruptedCount(): number {
    return this.corrupted;
  }
  get transmitting(): boolean {
    return this.txEndsUs >= 0;
  }
  registerValue(reg: number): number {
    return this.regs[reg];
  }
  fifoByte(index: number): number {
    return this.fifo[index & 0xff];
  }

  private note(text: string): void {
    this.log.push(text);
    if (this.log.length > 40) this.log.shift();
  }

  reset(): void {
    this.applyResetDefaults();
    this.selected = false;
    this.address = -1;
    this.writing = false;
    this.txEndsUs = -1;
    this.rxCursor = 0;
    this.sentPackets = 0;
    this.receivedPackets = 0;
    this.corrupted = 0;
    this.log = [];
  }

  snapshot(): DeviceSnapshot {
    if (!this.loraMode) {
      return { status: 'SX1278: FSK/OOK mode, which is not implemented', log: [...this.log] };
    }
    const modeName =
      ['sleep', 'standby', 'FSTX', 'transmitting', 'FSRX', 'receiving', 'receiving (single)', 'CAD'][this.mode] ??
      'unknown';
    return {
      status:
        `SX1278: ${modeName}, ${(this.frequencyHz / 1e6).toFixed(3)} MHz, SF${this.spreadingFactor}, ` +
        `BW ${this.bandwidthHz / 1000} kHz, CR 4/${this.codingRate + 4}, sync 0x${this.syncWord.toString(16)}, ` +
        `${this.sentPackets} sent, ${this.receivedPackets} received` +
        (this.corrupted ? `, ${this.corrupted} corrupted` : ''),
      log: [...this.log],
    };
  }
}
