// Sensirion SHT31 — temperature and humidity on I2C.
//
// Unlike the Bosch parts this one has no register map at all. It takes
// sixteen-bit commands and answers with data blocks, each pair of bytes
// followed by a CRC-8 that the driver checks and rejects on. So the CRC is
// computed with the real polynomial rather than stubbed — a wrong checksum
// makes every reading fail, which is exactly what would happen on hardware,
// and getting that right is most of what makes this part real.
//
// NOT modelled: the heater's effect on the reading (the bit is stored and
// reported, but it does not warm the sensor), clock stretching, ART mode,
// periodic-measurement timing (a periodic fetch answers immediately), and
// alert thresholds.

import type { DeviceSnapshot, I2cDevice } from './types';

export const SHT31_ADDRESSES = [0x44, 0x45] as const;

const CMD_MEASURE_HIGH = 0x2400; // single shot, high repeatability, no stretch
const CMD_MEASURE_MED = 0x240b;
const CMD_MEASURE_LOW = 0x2416;
const CMD_STRETCH_HIGH = 0x2c06; // single shot with clock stretching
const CMD_STRETCH_MED = 0x2c0d;
const CMD_STRETCH_LOW = 0x2c10;
const CMD_FETCH = 0xe000;
const CMD_STATUS = 0xf32d;
const CMD_CLEAR_STATUS = 0x3041;
const CMD_HEATER_ON = 0x306d;
const CMD_HEATER_OFF = 0x3066;
const CMD_SOFT_RESET = 0x30a2;
const CMD_BREAK = 0x3093;

const SINGLE_SHOT = new Set([
  CMD_MEASURE_HIGH, CMD_MEASURE_MED, CMD_MEASURE_LOW,
  CMD_STRETCH_HIGH, CMD_STRETCH_MED, CMD_STRETCH_LOW,
]);

/**
 * Sensirion's CRC-8: polynomial 0x31, initial value 0xFF.
 *
 * Real, because the driver checks it. A stubbed checksum would make every
 * library reject every reading, which is a worse failure than no part at all.
 */
export function sht31Crc(bytes: number[]): number {
  let crc = 0xff;
  for (const byte of bytes) {
    crc ^= byte & 0xff;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x80 ? ((crc << 1) ^ 0x31) & 0xff : (crc << 1) & 0xff;
    }
  }
  return crc & 0xff;
}

export class Sht31Device implements I2cDevice {
  readonly instanceId: string;
  private readonly address: number;

  /** The environment, as the user set it. */
  temperatureC = 22;
  humidityPct = 45;

  private heater = false;
  private periodic = false;
  private commandBytes: number[] = [];
  private outgoing: number[] = [];
  private log: string[] = [];
  private unhandled: number[] = [];

  constructor(instanceId: string, address: number) {
    this.instanceId = instanceId;
    this.address = address;
  }

  matchesAddress(address: number): boolean {
    return address === this.address;
  }

  start(_address: number, write: boolean): void {
    if (write) this.commandBytes = [];
  }

  stop(): void {
    this.commandBytes = [];
  }

  writeByte(value: number): boolean {
    this.commandBytes.push(value & 0xff);
    if (this.commandBytes.length < 2) return true;
    const command = ((this.commandBytes[0] << 8) | this.commandBytes[1]) & 0xffff;
    this.commandBytes = [];
    return this.handleCommand(command);
  }

  readByte(): number {
    // Nothing queued means the driver is reading when the part has nothing to
    // say. Real hardware leaves the line released, which the master reads as
    // 0xFF — so that is what comes back, rather than a fabricated value.
    return this.outgoing.shift() ?? 0xff;
  }

  private handleCommand(command: number): boolean {
    if (SINGLE_SHOT.has(command)) {
      this.outgoing = this.measurementBlock();
      this.log.push(`measure 0x${command.toString(16)}`);
      return true;
    }
    switch (command) {
      case CMD_FETCH:
        // A periodic fetch with no periodic mode running returns nothing,
        // which is what makes a driver report NACK rather than a bad reading.
        this.outgoing = this.periodic ? this.measurementBlock() : [];
        return true;
      case CMD_STATUS: {
        // Bit 13 is the heater, as the datasheet lays out the status word.
        const status = this.heater ? 0x2000 : 0x0000;
        this.outgoing = this.withCrc([(status >> 8) & 0xff, status & 0xff]);
        return true;
      }
      case CMD_CLEAR_STATUS:
        this.log.push('clear status');
        return true;
      case CMD_HEATER_ON:
        this.heater = true;
        return true;
      case CMD_HEATER_OFF:
        this.heater = false;
        return true;
      case CMD_SOFT_RESET:
        this.reset();
        return true;
      case CMD_BREAK:
        this.periodic = false;
        return true;
      default:
        // Periodic measurement commands share a high byte; accepting the mode
        // without pretending to honour its rate is the honest halfway house.
        if ((command >> 8) === 0x20 || (command >> 8) === 0x21 || (command >> 8) === 0x22 || (command >> 8) === 0x23 || (command >> 8) === 0x27) {
          this.periodic = true;
          this.log.push(`periodic 0x${command.toString(16)}`);
          return true;
        }
        this.unhandled.push(command);
        return false;
    }
  }

  /** Temperature and humidity words with their real checksums. */
  private measurementBlock(): number[] {
    // Datasheet conversions, inverted: T = -45 + 175 × raw/65535,
    // RH = 100 × raw/65535. The driver runs them forwards.
    const rawT = Math.round(((this.temperatureC + 45) / 175) * 65535);
    const rawH = Math.round((this.humidityPct / 100) * 65535);
    const t = Math.min(65535, Math.max(0, rawT));
    const h = Math.min(65535, Math.max(0, rawH));
    return [
      ...this.withCrc([(t >> 8) & 0xff, t & 0xff]),
      ...this.withCrc([(h >> 8) & 0xff, h & 0xff]),
    ];
  }

  private withCrc(pair: number[]): number[] {
    return [...pair, sht31Crc(pair)];
  }

  reset(): void {
    this.heater = false;
    this.periodic = false;
    this.outgoing = [];
    this.log.push('soft reset');
  }

  snapshot(): DeviceSnapshot {
    return {
      status: `${this.temperatureC.toFixed(1)} °C · ${this.humidityPct.toFixed(0)} %RH${this.heater ? ' · heater on' : ''}`,
      log: [...this.log.slice(-18), ...(this.unhandled.length ? [`${this.unhandled.length} unhandled command(s)`] : [])],
    };
  }

  get heaterOn(): boolean {
    return this.heater;
  }
}
