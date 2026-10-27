// The SAMD21's USB device controller, and a host on the other end of the cable.
//
// On every SAMD21 board in the catalogue `Serial` is the native USB port, so
// without this a sketch's Serial.println() went nowhere and `while (!Serial);`
// never returned. The model is of the controller as the datasheet describes it
// (DS40001882, chapter 32) and as the Arduino core's USBCore.cpp drives it,
// unmodified: endpoint buffers live in SRAM, found through a descriptor table
// whose address firmware writes to DESCADD, and a bank changes hands through
// its ready bit — firmware sets BK1RDY to send what it put in an IN buffer and
// clears BK0RDY to say an OUT buffer may be filled.
//
// The host does what a computer does when the board is plugged in: reset,
// descriptors, address, configuration, line coding, DTR. Then it takes what
// firmware sends on the CDC data IN endpoint and delivers what is typed on the
// OUT one. Everything is scheduled on the chip's simulated clock.
//
// Simplified: a single bank per direction (the host takes an IN bank the
// moment it is released, so the hardware's ping-pong mode is never needed),
// no suspend or resume, no remote wakeup, no isochronous transfers, and only
// the CDC data endpoints are serviced after enumeration — a HID sketch
// enumerates, but nothing reads its reports.

import { RegisterBlock } from './registerBlock';

const CTRLA = 0x00;
const SYNCBUSY = 0x02;
const CTRLB = 0x08;
const FNUM = 0x10;
const INTENCLR = 0x14;
const INTENSET = 0x18;
const INTFLAG = 0x1c;
const EPINTSMRY = 0x20;
const DESCADD = 0x24;
const EP_BASE = 0x100;
const EP_STRIDE = 0x20;
const EPCFG = 0x00;
const EPSTATUSCLR = 0x04;
const EPSTATUSSET = 0x05;
const EPSTATUS = 0x06;
const EPINTFLAG = 0x07;
const EPINTENCLR = 0x08;
const EPINTENSET = 0x09;

// INTFLAG
const SOF = 1 << 2;
const EORST = 1 << 3;
// EPSTATUS
const STALLRQ0 = 1 << 4;
const STALLRQ1 = 1 << 5;
const BK0RDY = 1 << 6;
const BK1RDY = 1 << 7;
// EPINTFLAG
const TRCPT0 = 1 << 0;
const TRCPT1 = 1 << 1;
const RXSTP = 1 << 4;

const ENDPOINTS = 8;
const PACKET = 64;

export interface UsbChipAccess {
  readRam(address: number): number;
  writeRam(address: number, value: number): void;
  setInterrupt(pending: boolean): void;
  /** Runs fn after `ns` of simulated time. */
  after(ns: number, fn: () => void): void;
}

interface Control {
  setup: number[];
  data?: number[];
  done: (ok: boolean, data: number[]) => void;
}

const setupPacket = (type: number, request: number, value: number, index: number, length: number) => [
  type, request, value & 0xff, value >> 8, index & 0xff, index >> 8, length & 0xff, length >> 8,
];

export class Samd21Usb {
  readonly block = new RegisterBlock('USB', 0x41005000, 0x1000);
  /** Bytes the firmware sent on the CDC data endpoint. */
  onSerialData: ((byte: number) => void) | null = null;

  private intflag = 0;
  private inten = 0;
  private frame = 0;
  private readonly epStatus = new Uint8Array(ENDPOINTS);
  private readonly epIntflag = new Uint8Array(ENDPOINTS);
  private readonly epInten = new Uint8Array(ENDPOINTS);
  private attached = false;
  private session = 0;

  private control: Control | null = null;
  private phase: 'setup' | 'data-in' | 'data-out' | 'status' = 'setup';
  private received: number[] = [];
  private queue: Control[] = [];
  private outDeliveryToken = 0;
  private cdcIn = -1;
  private cdcOut = -1;
  private cdcInterface = 0;
  private open = false;
  private hostOut: number[] = [];

  constructor(private readonly chip: UsbChipAccess) {
    const b = this.block;
    b.on(CTRLA, { width: 1, write: (v) => (v & 1 ? this.softwareReset() : this.checkAttach()) });
    b.on(SYNCBUSY, { width: 1, read: () => 0 });
    b.on(CTRLB, { width: 2, write: () => this.checkAttach() });
    b.on(FNUM, { width: 2, read: () => (this.frame & 0x7ff) << 3 });
    b.on(INTENCLR, { width: 2, read: () => this.inten, write: (v) => this.update(() => (this.inten &= ~v)) });
    b.on(INTENSET, { width: 2, read: () => this.inten, write: (v) => this.update(() => (this.inten |= v)) });
    b.on(INTFLAG, { width: 2, read: () => this.intflag, write: (v) => this.update(() => (this.intflag &= ~v)) });
    b.on(EPINTSMRY, { width: 2, read: () => this.summary() });
    for (let n = 0; n < ENDPOINTS; n++) {
      const at = EP_BASE + n * EP_STRIDE;
      b.on(at + EPSTATUSCLR, { width: 1, read: () => 0, write: (v) => this.statusClear(n, v) });
      b.on(at + EPSTATUSSET, { width: 1, read: () => 0, write: (v) => this.statusSet(n, v) });
      b.on(at + EPSTATUS, { width: 1, read: () => this.epStatus[n] });
      b.on(at + EPINTFLAG, { width: 1, read: () => this.epIntflag[n], write: (v) => this.update(() => (this.epIntflag[n] &= ~v)) });
      b.on(at + EPINTENCLR, { width: 1, read: () => this.epInten[n], write: (v) => this.update(() => (this.epInten[n] &= ~v)) });
      b.on(at + EPINTENSET, { width: 1, read: () => this.epInten[n], write: (v) => this.update(() => (this.epInten[n] |= v)) });
    }
  }

  // ------------------------------------------------------------ outside world

  /** Typed into the monitor, for Serial.read(). Dropped if no port is open. */
  sendSerial(bytes: Iterable<number>): void {
    if (!this.open) return;
    for (const b of bytes) this.hostOut.push(b & 0xff);
    this.deliverOut();
  }

  get portOpen(): boolean {
    return this.open;
  }

  // ---------------------------------------------------------- the descriptor

  private descriptor(ep: number, bank: number): number {
    return (this.block.peek(DESCADD, 4) + ep * 32 + bank * 16) >>> 0;
  }

  private read32(address: number): number {
    return (this.chip.readRam(address) | (this.chip.readRam(address + 1) << 8) | (this.chip.readRam(address + 2) << 16) | (this.chip.readRam(address + 3) << 24)) >>> 0;
  }

  private write32(address: number, value: number): void {
    for (let i = 0; i < 4; i++) this.chip.writeRam(address + i, (value >>> (8 * i)) & 0xff);
  }

  private bankAddress(ep: number, bank: number): number {
    return this.read32(this.descriptor(ep, bank));
  }

  private byteCount(ep: number, bank: number): number {
    return this.read32(this.descriptor(ep, bank) + 4) & 0x3fff;
  }

  private setByteCount(ep: number, bank: number, count: number): void {
    const at = this.descriptor(ep, bank) + 4;
    this.write32(at, ((this.read32(at) & ~0x3fff) | (count & 0x3fff)) >>> 0);
  }

  /** What firmware put in an IN bank, as the hardware would send it. */
  private takeIn(ep: number): number[] {
    const address = this.bankAddress(ep, 1);
    const count = this.byteCount(ep, 1);
    const out: number[] = [];
    for (let i = 0; i < count; i++) out.push(this.chip.readRam(address + i));
    return out;
  }

  /** Writes a packet into an OUT bank and marks it full. */
  private fillOut(ep: number, bytes: number[], flag: number): void {
    const address = this.bankAddress(ep, 0);
    bytes.forEach((b, i) => this.chip.writeRam(address + i, b));
    this.setByteCount(ep, 0, bytes.length);
    this.epStatus[ep] |= BK0RDY;
    this.epIntflag[ep] |= flag;
    this.evaluate();
  }

  // ------------------------------------------------------------ device side

  private softwareReset(): void {
    this.block.bytes.fill(0);
    this.intflag = 0;
    this.inten = 0;
    this.epStatus.fill(0);
    this.epIntflag.fill(0);
    this.epInten.fill(0);
    this.checkAttach();
  }

  private update(fn: () => void): void {
    fn();
    this.evaluate();
  }

  private summary(): number {
    let v = 0;
    for (let n = 0; n < ENDPOINTS; n++) if (this.epIntflag[n] & this.epInten[n]) v |= 1 << n;
    return v;
  }

  private evaluate(): void {
    this.chip.setInterrupt((this.intflag & this.inten) !== 0 || this.summary() !== 0);
  }

  private statusSet(ep: number, value: number): void {
    const wasReady = this.epStatus[ep] & BK1RDY;
    this.epStatus[ep] |= value & (BK0RDY | BK1RDY | STALLRQ0 | STALLRQ1);
    if (value & (STALLRQ0 | STALLRQ1) && ep === 0 && this.control) {
      // EP0 answers a request it does not support with a STALL.
      this.finishControl(false);
    }
    if (value & BK1RDY && !wasReady) {
      // The host is always polling: an armed IN bank goes at once.
      const packet = this.takeIn(ep);
      this.epStatus[ep] &= ~BK1RDY;
      this.epIntflag[ep] |= TRCPT1;
      if (ep === 0) this.controlIn(packet);
      else if (ep === this.cdcIn && this.open) for (const b of packet) this.onSerialData?.(b);
    }
    this.evaluate();
  }

  private statusClear(ep: number, value: number): void {
    this.epStatus[ep] &= ~(value & (BK0RDY | BK1RDY | STALLRQ0 | STALLRQ1));
    if (value & BK0RDY) {
      if (ep === 0 && this.phase === 'data-out') this.scheduleControlData();
      if (ep === this.cdcOut) this.chip.after(20_000, () => this.deliverOut());
    }
    this.evaluate();
  }

  // -------------------------------------------------------------- host side

  private checkAttach(): void {
    const enabled = (this.block.peek(CTRLA, 1) & 0x02) !== 0;
    const detached = (this.block.peek(CTRLB, 2) & 0x01) !== 0;
    const attached = enabled && !detached;
    if (attached === this.attached) return;
    this.attached = attached;
    this.session++;
    this.open = false;
    this.control = null;
    this.queue = [];
    if (attached) this.later(2_000_000, () => this.busReset());
  }

  private later(ns: number, fn: () => void): void {
    const session = this.session;
    this.chip.after(ns, () => {
      if (session === this.session) fn();
    });
  }

  private busReset(): void {
    this.intflag |= EORST;
    this.evaluate();
    this.later(1_000_000, () => this.frameTick());
    this.later(1_000_000, () => this.waitForEp0());
  }

  private frameTick(): void {
    this.frame = (this.frame + 1) & 0x7ff;
    this.intflag |= SOF;
    this.deliverOut();
    this.evaluate();
    this.later(1_000_000, () => this.frameTick());
  }

  private waitForEp0(): void {
    const ep0Configured = (this.block.peek(EP_BASE + EPCFG, 1) & 0x07) !== 0 && (this.epInten[0] & RXSTP) !== 0;
    if (!ep0Configured) {
      this.later(1_000_000, () => this.waitForEp0());
      return;
    }
    this.enumerate();
  }

  private request(setup: number[], data: number[] | undefined, done: Control['done']): void {
    this.queue.push({ setup, data, done });
    if (!this.control) this.later(1_000_000, () => this.nextControl());
  }

  private nextControl(): void {
    if (this.control) return;
    const next = this.queue.shift();
    if (!next) return;
    this.control = next;
    this.received = [];
    const deviceToHost = (next.setup[0] & 0x80) !== 0;
    this.phase = deviceToHost ? 'data-in' : next.data?.length ? 'data-out' : 'status';
    this.epStatus[0] &= ~(STALLRQ0 | STALLRQ1);
    this.fillOut(0, next.setup, RXSTP);
    const control = next;
    this.later(50_000_000, () => {
      if (this.control === control) this.finishControl(false);
    });
  }

  private finishControl(ok: boolean): void {
    const control = this.control;
    if (!control) return;
    this.control = null;
    control.done(ok, this.received);
    // A frame between transfers, as a host leaves.
    this.later(1_000_000, () => this.nextControl());
  }

  /**
   * The data stage of a control write, once firmware is waiting for it.
   *
   * Firmware clears EP0's BK0RDY twice before it waits — once acknowledging
   * the SETUP, once arming the receive, which also zeroes the byte count — so
   * the data goes in a moment after the last clear, not after the first.
   */
  private scheduleControlData(): void {
    const token = ++this.outDeliveryToken;
    this.later(100_000, () => {
      if (token !== this.outDeliveryToken || this.phase !== 'data-out' || !this.control?.data) return;
      this.phase = 'status';
      this.fillOut(0, this.control.data, TRCPT0);
    });
  }

  private controlIn(packet: number[]): void {
    if (!this.control) return;
    if (this.phase === 'data-in') {
      // The hardware sends BYTE_COUNT bytes as however many packets it takes;
      // the host keeps what the request asked for.
      const wLength = this.control.setup[6] | (this.control.setup[7] << 8);
      this.received.push(...packet.slice(0, Math.max(0, wLength - this.received.length)));
      this.finishControl(true);
    } else if (this.phase === 'status') {
      this.finishControl(true);
    }
  }

  private enumerate(): void {
    const get = (type: number, length: number) => setupPacket(0x80, 6, type << 8, 0, length);
    this.request(get(1, 18), undefined, () => {
      this.request(setupPacket(0x00, 5, 1, 0, 0), undefined, () => {
        this.request(get(2, 9), undefined, (ok, head) => {
          const total = ok && head.length >= 4 ? head[2] | (head[3] << 8) : 9;
          this.request(get(2, total), undefined, (okFull, config) => {
            if (okFull) this.findCdc(config);
            this.request(setupPacket(0x00, 9, 1, 0, 0), undefined, () => {
              if (this.cdcIn < 0) return;
              const lineCoding = [0x00, 0xc2, 0x01, 0x00, 0, 0, 8];
              this.request(setupPacket(0x21, 0x20, 0, this.cdcInterface, 7), lineCoding, () => {
                this.request(setupPacket(0x21, 0x22, 0x0003, this.cdcInterface, 0), undefined, () => {
                  this.open = true;
                  this.deliverOut();
                });
              });
            });
          });
        });
      });
    });
  }

  private findCdc(config: number[]): void {
    let i = 0;
    let inData = false;
    while (i + 1 < config.length && config[i] >= 2) {
      const len = config[i];
      const type = config[i + 1];
      if (type === 4 && len >= 9) {
        const cls = config[i + 5];
        if (cls === 0x02) this.cdcInterface = config[i + 2];
        inData = cls === 0x0a;
      }
      if (type === 5 && len >= 7 && inData && (config[i + 3] & 3) === 2) {
        const address = config[i + 2];
        if (address & 0x80) this.cdcIn = address & 0x0f;
        else this.cdcOut = address & 0x0f;
      }
      i += len;
    }
  }

  /** Hands queued host bytes to the CDC OUT endpoint once firmware has armed it. */
  private deliverOut(): void {
    if (!this.open || this.cdcOut < 0 || this.hostOut.length === 0) return;
    const ep = this.cdcOut;
    if (this.epStatus[ep] & BK0RDY) return; // still full: firmware has not taken it
    if (this.bankAddress(ep, 0) === 0) return;
    this.fillOut(ep, this.hostOut.splice(0, PACKET), TRCPT0);
  }
}
