// Shared base for register-mapped I2C devices (BMP280, MPU-6050, …).
//
// Almost every I2C sensor speaks the same shape of protocol:
//
//   write [addr+W] [reg] [data…]   -> set the pointer, optionally write bytes
//   write [addr+W] [reg], restart, read [addr+R] [byte…]  -> burst read
//
// with the pointer auto-incrementing on every byte. That handshake lives here
// so each device only has to describe its register map. Reads come from the
// device's own state — never from a canned response.

import type { DeviceSnapshot, I2cDevice } from './types';

export abstract class RegisterI2cDevice implements I2cDevice {
  readonly instanceId: string;
  protected readonly address: number;

  /** Auto-incrementing register pointer, as on real hardware. */
  protected pointer = 0;
  private pointerSet = false;
  private reading = false;
  protected log: string[] = [];
  protected unknownWrites: number[] = [];
  protected unknownReads: number[] = [];

  constructor(instanceId: string, address: number) {
    this.instanceId = instanceId;
    this.address = address;
  }

  matchesAddress(address: number): boolean {
    return address === this.address;
  }

  start(_address: number, write: boolean): void {
    this.reading = !write;
    // A write transaction always begins with the register pointer.
    if (write) this.pointerSet = false;
  }

  stop(): void {
    this.pointerSet = false;
  }

  writeByte(value: number): boolean {
    if (this.reading) return false;
    if (!this.pointerSet) {
      this.pointer = value & 0xff;
      this.pointerSet = true;
      return true;
    }
    const ok = this.writeRegister(this.pointer, value & 0xff);
    if (!ok) this.unknownWrites.push(this.pointer);
    this.pointer = (this.pointer + 1) & 0xff;
    return true; // the device ACKs the byte; unknown registers are recorded
  }

  readByte(): number {
    const value = this.readRegister(this.pointer);
    if (value === null) {
      this.unknownReads.push(this.pointer);
      this.pointer = (this.pointer + 1) & 0xff;
      // Unmapped registers read back as 0 on these parts, not as invented data.
      return 0x00;
    }
    this.pointer = (this.pointer + 1) & 0xff;
    return value & 0xff;
  }

  protected note(text: string): void {
    this.log.push(text);
    if (this.log.length > 60) this.log.shift();
  }

  /** Returns the byte at `reg`, or null when the register is not mapped. */
  protected abstract readRegister(reg: number): number | null;
  /** Returns true when the write was understood. */
  protected abstract writeRegister(reg: number, value: number): boolean;

  abstract reset(): void;
  abstract snapshot(): DeviceSnapshot;

  get unhandledRegisters(): { reads: number[]; writes: number[] } {
    return { reads: [...new Set(this.unknownReads)], writes: [...new Set(this.unknownWrites)] };
  }
}
