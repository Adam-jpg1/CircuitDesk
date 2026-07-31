// Shared I2C bus.
//
// Sits between avr8js's TWI controller (which reports what the firmware's Wire
// calls actually do) and the device models attached to the canvas. The bus owns
// address decoding and acknowledgement: if no attached device claims the
// address the transfer is NACKed, which is what real hardware does and what
// makes "wrong address" a genuine failure rather than a silent no-op.

import type { I2cDevice } from './types';

/** Subset of avr8js's AVRTWI that the bus needs; keeps this file engine-neutral. */
export interface TwiController {
  completeStart(): void;
  completeStop(): void;
  completeConnect(ack: boolean): void;
  completeWrite(ack: boolean): void;
  completeRead(value: number): void;
}

export interface I2cBusEvent {
  kind: 'start' | 'address' | 'write' | 'read' | 'stop';
  address?: number;
  value?: number;
  ack?: boolean;
  /** True when no attached device claimed the address. */
  unclaimed?: boolean;
}

const MAX_LOG = 200;

export class I2cBus {
  private devices: I2cDevice[] = [];
  private active: I2cDevice | null = null;
  private log: I2cBusEvent[] = [];
  /** Counts transfers addressed to nobody — surfaced so it is visible, not hidden. */
  unclaimedAddressCount = 0;

  attach(device: I2cDevice): void {
    if (!this.devices.includes(device)) this.devices.push(device);
  }

  detachAll(): void {
    this.devices = [];
    this.active = null;
  }

  /** Devices kept across re-binds so a wiring edit does not wipe display RAM. */
  private byInstance = new Map<string, I2cDevice>();

  /**
   * Attaches exactly the given instances, creating any that are new and
   * dropping any that were unwired. Existing devices keep their state, because
   * re-binding the circuit (a wiring edit) is not a power cycle.
   */
  sync(wanted: { instanceId: string; create: () => I2cDevice }[]): I2cDevice[] {
    const keep = new Set(wanted.map((w) => w.instanceId));
    for (const id of [...this.byInstance.keys()]) {
      if (!keep.has(id)) this.byInstance.delete(id);
    }
    const devices = wanted.map((w) => {
      const existing = this.byInstance.get(w.instanceId);
      if (existing) return existing;
      const created = w.create();
      this.byInstance.set(w.instanceId, created);
      return created;
    });
    this.devices = devices;
    if (this.active && !devices.includes(this.active)) this.active = null;
    return devices;
  }

  deviceFor(instanceId: string): I2cDevice | undefined {
    return this.byInstance.get(instanceId);
  }

  get attachedCount(): number {
    return this.devices.length;
  }

  recentEvents(limit = 20): I2cBusEvent[] {
    return this.log.slice(-limit);
  }

  private record(event: I2cBusEvent): void {
    this.log.push(event);
    if (this.log.length > MAX_LOG) this.log.splice(0, this.log.length - MAX_LOG);
  }

  /**
   * Wires this bus to a TWI controller. The returned object is avr8js's
   * TWIEventHandler shape; every callback must complete the controller
   * operation or the firmware's Wire call would hang forever.
   */
  handler(twi: TwiController) {
    return {
      start: (repeated: boolean) => {
        if (!repeated) this.active = null;
        this.record({ kind: 'start' });
        twi.completeStart();
      },
      stop: () => {
        this.active?.stop();
        this.active = null;
        this.record({ kind: 'stop' });
        twi.completeStop();
      },
      connectToSlave: (address: number, write: boolean) => {
        const device = this.devices.find((d) => d.matchesAddress(address)) ?? null;
        this.active = device;
        if (device) {
          device.start(address, write);
        } else {
          this.unclaimedAddressCount++;
        }
        this.record({ kind: 'address', address, ack: Boolean(device), unclaimed: !device });
        // NACK when nothing answers on that address — Wire.endTransmission()
        // then reports error 2, exactly as on real hardware.
        twi.completeConnect(Boolean(device));
      },
      writeByte: (value: number) => {
        const ack = this.active ? this.active.writeByte(value) : false;
        this.record({ kind: 'write', value, ack });
        twi.completeWrite(ack);
      },
      readByte: (_ack: boolean) => {
        // An unaddressed read returns the idle bus level (0xFF), never invented data.
        const value = this.active ? this.active.readByte() : 0xff;
        this.record({ kind: 'read', value });
        twi.completeRead(value);
      },
    };
  }
}
