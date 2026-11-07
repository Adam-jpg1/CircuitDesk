// MCP4725 12-bit I2C DAC.
//
// Unlike every other device in this folder so far, this one is an *output* to
// the analog world: the code it receives sets a real voltage on its VOUT pin,
// which is driven onto the net through the AnalogDevice interface. Wire VOUT
// to an ADC input and firmware genuinely reads back what it wrote.
//
// Both write formats a driver library uses are implemented:
//
//   fast mode      [PD1 PD0 D11..D8] [D7..D0]
//   register write [0x40|PD] [D11..D4] [D3..D0 x x x x]     (DAC register)
//                  [0x60|PD] ...                            (DAC + EEPROM)
//
// Power-down modes are honoured: the datasheet's three PD settings disconnect
// VOUT and tie it to ground through 1 k, 100 k or 500 k, so the output really
// does stop driving its programmed voltage.
//
// The EEPROM shadow is modelled to the extent that it survives a reset and is
// reloaded as the power-on code, which is the observable part. The EEPROM
// write time is not modelled and the busy bit always reads ready.

import type { AnalogDevice, DeviceSnapshot, I2cDevice } from './types';

/** A0 strapping gives 0x60..0x67 on common breakout boards. */
export const MCP4725_ADDRESSES = [0x60, 0x61, 0x62, 0x63, 0x64, 0x65, 0x66, 0x67] as const;

export const MCP4725_MAX_CODE = 4095;

/** Pull-down resistance for power-down modes 1..3, in ohms. */
const PULLDOWN_OHMS = [0, 1_000, 100_000, 500_000];

export class Mcp4725Device implements I2cDevice, AnalogDevice {
  readonly instanceId: string;
  private readonly address: number;
  /** Supply voltage, which is also the DAC's reference. */
  private readonly supplyVolts: number;

  private code = 0;
  private eepromCode = 0;
  /** 0 = normal, 1..3 = power-down with the matching pull-down. */
  private powerDown = 0;
  private eepromPowerDown = 0;

  private buffer: number[] = [];
  private reading = false;
  private readIndex = 0;
  private writes = 0;
  private log: string[] = [];

  constructor(instanceId: string, address: number = MCP4725_ADDRESSES[0], supplyVolts = 5) {
    this.instanceId = instanceId;
    this.address = address;
    this.supplyVolts = supplyVolts;
    this.code = this.eepromCode; // powers up with the stored code
  }

  matchesAddress(address: number): boolean {
    return address === this.address;
  }

  start(_address: number, write: boolean): void {
    this.reading = !write;
    if (write) this.buffer = [];
    else this.readIndex = 0;
  }

  stop(): void {
    this.applyBuffer();
    this.buffer = [];
  }

  writeByte(value: number): boolean {
    if (this.reading) return false;
    this.buffer.push(value & 0xff);
    // Fast-mode writes are two bytes and take effect immediately; the longer
    // command forms are applied on STOP.
    if (this.buffer.length === 2 && (this.buffer[0] & 0xc0) === 0) this.applyBuffer();
    return true;
  }

  /** Read-back format: status byte, DAC register (2 bytes), EEPROM (2 bytes). */
  readByte(): number {
    const bytes = [
      // Bit 7 = RDY (always ready here), bits 2:1 = power-down mode.
      0x80 | ((this.powerDown & 0x03) << 1),
      (this.code >> 4) & 0xff,
      (this.code << 4) & 0xf0,
      ((this.eepromPowerDown & 0x03) << 5) | ((this.eepromCode >> 8) & 0x0f),
      this.eepromCode & 0xff,
    ];
    return bytes[Math.min(this.readIndex++, bytes.length - 1)];
  }

  private applyBuffer(): void {
    const b = this.buffer;
    if (b.length === 0) return;

    if ((b[0] & 0xc0) === 0) {
      // Fast mode: bits 7:6 are 00 and bits 5:4 carry the power-down code.
      if (b.length < 2) return;
      this.powerDown = (b[0] >> 4) & 0x03;
      this.setCode(((b[0] & 0x0f) << 8) | b[1]);
      this.buffer = [];
      return;
    }

    const command = b[0] & 0xe0;
    if ((command === 0x40 || command === 0x60) && b.length >= 3) {
      this.powerDown = (b[0] >> 1) & 0x03;
      this.setCode((b[1] << 4) | ((b[2] >> 4) & 0x0f));
      if (command === 0x60) {
        // "Write DAC and EEPROM": the stored code survives a power cycle.
        this.eepromCode = this.code;
        this.eepromPowerDown = this.powerDown;
        this.note(`stored code ${this.code} in EEPROM`);
      }
      this.buffer = [];
    }
  }

  private setCode(next: number): void {
    this.code = Math.max(0, Math.min(MCP4725_MAX_CODE, next));
    this.writes++;
  }

  // ---- inspection ----

  get dacCode(): number {
    return this.code;
  }

  get storedCode(): number {
    return this.eepromCode;
  }

  get powerDownMode(): number {
    return this.powerDown;
  }

  get writeCounter(): number {
    return this.writes;
  }

  /** Volts the DAC is programmed to present, ignoring power-down. */
  get programmedVolts(): number {
    return (this.code / (MCP4725_MAX_CODE + 1)) * this.supplyVolts;
  }

  /**
   * Volts driven onto VOUT. In a power-down mode the output amplifier is
   * disconnected and the pin is pulled to ground, so it stops presenting the
   * programmed voltage entirely.
   */
  analogOut(pinId: string): number | null {
    if (pinId !== 'vout') return null;
    if (this.powerDown !== 0) return 0;
    return this.programmedVolts;
  }

  /** Pull-down resistance presented while powered down, or null when driving. */
  get pullDownOhms(): number | null {
    return this.powerDown === 0 ? null : PULLDOWN_OHMS[this.powerDown];
  }

  private note(text: string): void {
    this.log.push(text);
    if (this.log.length > 40) this.log.shift();
  }

  reset(): void {
    this.code = this.eepromCode;
    this.powerDown = this.eepromPowerDown;
    this.buffer = [];
    this.readIndex = 0;
    this.writes = 0;
    this.log = [];
  }

  snapshot(): DeviceSnapshot {
    return {
      status:
        `MCP4725 @0x${this.address.toString(16)}: code ${this.code}/4095, ` +
        (this.powerDown === 0
          ? `${this.programmedVolts.toFixed(3)} V on VOUT`
          : `powered down (${PULLDOWN_OHMS[this.powerDown] / 1000} k pull-down)`),
      log: [...this.log],
    };
  }
}
