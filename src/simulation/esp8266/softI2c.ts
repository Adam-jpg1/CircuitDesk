// I2C as the ESP8266 does it: in software. The chip has no I2C controller;
// the Arduino core's Wire (core_esp8266_si2c.cpp) toggles SDA and SCL as
// open-drain GPIOs — driving a pad low by enabling its output, releasing it
// to the pull-up by disabling it — and reads the lines back.
//
// So the devices on the canvas are reached by watching those two pads. This
// is the target side of the bus, bit by bit: a START or STOP is SDA moving
// while SCL is high; a bit is SDA when SCL rises; the target (here, whichever
// device answers the address) changes SDA only while SCL is low — to
// acknowledge, and to shift out the bytes the master reads. Each whole byte
// goes to the same device bus the other boards' I2C controllers use.

import type { EspI2cBus } from '../espRiscv/i2c';

export interface OpenDrainPads {
  /** The level on a pad, everything that drives it considered. */
  level(pin: number): 0 | 1 | undefined;
  /** The target pulls a pad low (0) or lets it go (undefined). */
  pull(pin: number, level: 0 | undefined): void;
  onChange(listener: (pin: number) => void): void;
}

type Phase = 'idle' | 'address' | 'write' | 'read';

export class SoftI2cTarget {
  private phase: Phase = 'idle';
  private sda: 0 | 1 = 1;
  private scl: 0 | 1 = 1;
  private bits = 0;
  private shift = 0;
  /** In the ninth clock, the acknowledge slot. */
  private ackSlot = false;
  private acked = false;
  private readByteValue = 0;
  private masterAck = false;
  private started = false;

  constructor(
    private readonly pads: OpenDrainPads,
    readonly sdaPin: number,
    readonly sclPin: number,
    private readonly bus: () => EspI2cBus | null,
  ) {
    pads.onChange((pin) => {
      if (pin === sdaPin || pin === sclPin) this.update();
    });
  }

  private line(pin: number): 0 | 1 {
    return this.pads.level(pin) === 0 ? 0 : 1;
  }

  private drive(level: 0 | 1): void {
    this.pads.pull(this.sdaPin, level === 0 ? 0 : undefined);
  }

  private update(): void {
    const sda = this.line(this.sdaPin);
    const scl = this.line(this.sclPin);
    const prevSda = this.sda;
    const prevScl = this.scl;
    this.sda = sda;
    this.scl = scl;
    if (scl === 1 && prevScl === 1 && sda !== prevSda) {
      if (sda === 0) this.onStart();
      else this.onStop();
      return;
    }
    if (scl === 1 && prevScl === 0) this.onRise(sda);
    else if (scl === 0 && prevScl === 1) this.onFall();
  }

  private onStart(): void {
    const bus = this.bus();
    bus?.start(this.started);
    this.started = true;
    this.phase = 'address';
    this.bits = 0;
    this.shift = 0;
    this.ackSlot = false;
    this.drive(1);
  }

  private onStop(): void {
    if (this.started) this.bus()?.stop();
    this.started = false;
    this.phase = 'idle';
    this.ackSlot = false;
    this.drive(1);
  }

  private onRise(sda: 0 | 1): void {
    if (this.phase === 'idle') return;
    if (this.ackSlot) {
      if (this.phase === 'read') this.masterAck = sda === 0;
      return;
    }
    if (this.phase === 'read') {
      this.bits++;
      return;
    }
    this.shift = ((this.shift << 1) | sda) & 0xff;
    this.bits++;
  }

  private onFall(): void {
    if (this.phase === 'idle') return;
    const bus = this.bus();
    if (this.ackSlot) {
      // The ninth clock is over.
      this.ackSlot = false;
      this.bits = 0;
      this.shift = 0;
      if (this.phase === 'read') {
        if (this.masterAck) this.loadReadByte();
        else {
          this.phase = 'idle';
          this.drive(1);
        }
      } else if (!this.acked) {
        this.phase = 'idle';
        this.drive(1);
      } else this.drive(1);
      return;
    }
    if (this.phase === 'read') {
      if (this.bits < 8) this.drive(((this.readByteValue >> (7 - this.bits)) & 1) as 0 | 1);
      else {
        this.drive(1);
        this.ackSlot = true;
      }
      return;
    }
    if (this.bits < 8) return;
    // A whole byte from the master: the target answers in the ninth clock.
    const byte = this.shift;
    if (this.phase === 'address') {
      const write = (byte & 1) === 0;
      this.acked = bus ? bus.connect(byte >> 1, write) : false;
      if (this.acked && !write) {
        this.phase = 'read';
        this.ackSlot = true;
        // The acknowledge; the first data bit goes out when the ninth clock falls.
        this.drive(0);
        return;
      }
      this.phase = 'write';
    } else {
      this.acked = bus ? bus.writeByte(byte) : false;
    }
    this.ackSlot = true;
    this.drive(this.acked ? 0 : 1);
  }

  private loadReadByte(): void {
    this.readByteValue = this.bus()?.readByte(true) ?? 0xff;
    this.bits = 0;
    this.drive(((this.readByteValue >> 7) & 1) as 0 | 1);
  }
}
