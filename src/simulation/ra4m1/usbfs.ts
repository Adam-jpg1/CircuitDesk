// The RA4M1's USBFS device controller (RUSB2), and a host on the other end.
//
// On the Uno R4 Minima `Serial` is native USB: TinyUSB's CDC class over the
// RUSB2 driver (dcd_rusb2.c), unmodified. This models the controller as that
// driver uses it — pipes with FIFO buffers reached through the CFIFO and
// D0FIFO ports, the control-transfer stage machine (CTSQ, VALID, CCPL) with
// SET_ADDRESS handled in hardware, and the BRDY, BEMP, CTRT and DVST status
// behind the one USBFS interrupt.
//
// The host does what a computer does when the board is plugged in: bus
// reset, descriptors, address, configuration, line coding, DTR. Then it
// takes what firmware sends on the CDC bulk IN pipe and delivers what is
// typed on the bulk OUT one. Everything runs on the chip's clock.
//
// Simplified: single buffering (the host takes an IN buffer as soon as it is
// complete), no suspend/resume, no isochronous pipes, strings not requested.

import type { McuUsbSerial } from '../armv7m/armRunner';

export interface UsbChip {
  /** Schedules on the chip's clock, in microseconds. */
  afterUs(us: number, fn: () => void): void;
  /** The interrupt line's level changed. */
  setInterrupt(active: boolean): void;
}

interface Pipe {
  buf: number[];
  /** IN: complete and waiting for the host. */
  full: boolean;
  cfg: number;
  maxp: number;
  ctr: number;
}

const INTSTS0 = {
  VALID: 1 << 3, VBSTS: 1 << 7, BRDY: 1 << 8, NRDY: 1 << 9, BEMP: 1 << 10, CTRT: 1 << 11, DVST: 1 << 12,
  SOFR: 1 << 13, RESM: 1 << 14, VBINT: 1 << 15,
};

interface Control {
  setup: number[];
  out?: number[];
  done: (data: number[]) => void;
}

const setupPacket = (type: number, request: number, value: number, index: number, length: number) => [
  type, request, value & 0xff, value >> 8, index & 0xff, index >> 8, length & 0xff, length >> 8,
];

export class RaUsbFs implements McuUsbSerial {
  onSerialData: ((byte: number) => void) | null = null;
  private readonly regs = new Map<number, number>();
  private readonly pipes: Pipe[] = Array.from({ length: 10 }, () => ({ buf: [], full: false, cfg: 0, maxp: 64, ctr: 0 }));
  private intsts0 = INTSTS0.VBSTS;
  private brdysts = 0;
  private bempsts = 0;
  private dvsq = 0;
  private ctsq = 0;
  private attached = false;
  private control: Control | null = null;
  private controlIn: number[] = [];
  private controlOutAt = 0;
  private readonly controls: Control[] = [];
  private dataIn = -1;
  private dataOut = -1;
  private cdcInterface = 0;
  private readonly outgoing: number[] = [];
  private level = false;
  /** True once the host has opened the port (DTR set). */
  portOpen = false;

  constructor(private readonly chip: UsbChip) {}

  sendSerial(bytes: Iterable<number>): void {
    for (const b of bytes) this.outgoing.push(b & 0xff);
    this.pumpOut();
  }

  // ------------------------------------------------------------ registers

  read(offset: number, width: 1 | 2 | 4): number {
    if (width === 4) return this.read(offset, 2) | (this.read(offset + 2, 2) << 16);
    switch (offset & ~1) {
      case 0x04:
        return 0x0002; // SYSSTS0.LNST: J state (full speed)
      case 0x08:
        return (this.get(0x08) & ~7) | 2; // DVSTCTR0.RHST: full speed
      case 0x14:
        return this.fifoRead(0, width);
      case 0x18:
        return this.fifoRead(this.get(0x28) & 0xf, width);
      case 0x22:
        return this.fifoCtr(0);
      case 0x2a:
        return this.fifoCtr(this.get(0x28) & 0xf);
      case 0x40: {
        let v = (this.intsts0 & ~0x70 & ~7) | (this.dvsq << 4) | this.ctsq;
        if (this.brdysts & this.get(0x36)) v |= INTSTS0.BRDY;
        if (this.bempsts & this.get(0x3a)) v |= INTSTS0.BEMP;
        return v;
      }
      case 0x46:
        return this.brdysts;
      case 0x4a:
        return this.bempsts;
      case 0x60:
        return this.dcpCtr();
      case 0x6c:
        return this.pipes[this.get(0x64) & 0xf]?.maxp ?? 0;
      case 0x68:
        return this.pipes[this.get(0x64) & 0xf]?.cfg ?? 0;
      default:
        if (offset >= 0x70 && offset < 0x82) {
          const num = ((offset - 0x70) >> 1) + 1;
          const p = this.pipes[num];
          return (p.ctr & ~0xc000) | (p.full ? 0x4000 : 0) | (this.bufferReady(num) ? 0x8000 : 0);
        }
        return this.get(offset & ~1);
    }
  }

  write(offset: number, value: number, width: 1 | 2 | 4): void {
    if (width === 4) {
      this.write(offset, value & 0xffff, 2);
      this.write(offset + 2, value >>> 16, 2);
      return;
    }
    const reg = offset & ~1;
    value &= 0xffff;
    switch (reg) {
      case 0x00: {
        const before = this.get(0x00);
        this.set(0x00, value);
        // DPRPU: the pull-up tells the host a device is there.
        if (value & 0x10 && !(before & 0x10)) this.attach();
        return;
      }
      case 0x14:
        return this.fifoWrite(0, value, width);
      case 0x18:
        return this.fifoWrite(this.get(0x28) & 0xf, value, width);
      case 0x22:
        return this.fifoCtrWrite(0, value);
      case 0x2a:
        return this.fifoCtrWrite(this.get(0x28) & 0xf, value);
      case 0x40:
        // Status bits written 0 are cleared; VALID likewise.
        this.intsts0 &= value | ~(INTSTS0.CTRT | INTSTS0.DVST | INTSTS0.SOFR | INTSTS0.RESM | INTSTS0.VBINT | INTSTS0.VALID);
        break;
      case 0x46:
        this.brdysts &= value;
        break;
      case 0x4a:
        this.bempsts &= value;
        break;
      case 0x60:
        this.dcpCtrWrite(value);
        break;
      case 0x68:
        this.pipes[this.get(0x64) & 0xf].cfg = value;
        break;
      case 0x6c:
        this.pipes[this.get(0x64) & 0xf].maxp = value & 0x7ff;
        break;
      default:
        if (reg >= 0x70 && reg < 0x82) {
          const num = ((reg - 0x70) >> 1) + 1;
          const p = this.pipes[num];
          if (value & 0x200) {
            // ACLRM: the buffer is cleared.
            p.buf = [];
            p.full = false;
          }
          p.ctr = value & ~0x300;
          this.pumpOut();
          this.serviceIn(num);
          break;
        }
        this.set(reg, value);
    }
    this.update();
  }

  private get(reg: number): number {
    return this.regs.get(reg) ?? 0;
  }

  private set(reg: number, value: number): void {
    this.regs.set(reg, value & 0xffff);
  }

  private update(): void {
    const active = (this.read(0x40, 2) & this.get(0x30) & 0xff00) !== 0;
    if (active !== this.level) {
      this.level = active;
      this.chip.setInterrupt(active);
    }
  }

  /** Whether the interrupt is still asserted (for an ICU flag cleared while it is). */
  get asserted(): boolean {
    return this.level;
  }

  // ------------------------------------------------------- pipes and FIFOs

  /** Whether a pipe's port is accessible: room to write, or data to read. */
  private isInPipe(num: number): boolean {
    if (num === 0) return (this.get(0x20) & 0x20) !== 0; // CFIFOSEL.ISEL
    return (this.pipes[num].cfg & 0x10) !== 0; // PIPECFG.DIR
  }

  private bufferReady(num: number): boolean {
    const p = this.pipes[num];
    return this.isInPipe(num) ? !p.full : p.buf.length > 0;
  }

  private fifoCtr(num: number): number {
    const p = this.pipes[num];
    const frdy = this.isInPipe(num) ? !p.full : true;
    return (frdy ? 0x2000 : 0) | (this.isInPipe(num) ? 0 : p.buf.length & 0x1ff);
  }

  private fifoWrite(num: number, value: number, width: 1 | 2): void {
    const p = this.pipes[num];
    if (p.full) return;
    p.buf.push(value & 0xff);
    if (width === 2) p.buf.push((value >>> 8) & 0xff);
    const mps = num === 0 ? this.get(0x5e) & 0x7f || 64 : p.maxp || 64;
    if (p.buf.length >= mps) this.complete(num);
  }

  private fifoRead(num: number, width: 1 | 2): number {
    const p = this.pipes[num];
    const a = p.buf.shift() ?? 0;
    const b = width === 2 ? p.buf.shift() ?? 0 : 0;
    // An OUT buffer read empty can take the host's next packet.
    if (num && !p.buf.length) this.pumpOut();
    return width === 1 ? a : a | (b << 8);
  }

  private fifoCtrWrite(num: number, value: number): void {
    const p = this.pipes[num];
    if (value & 0x4000) {
      // BCLR
      p.buf = [];
      p.full = false;
      if (num) this.pumpOut();
    }
    if (value & 0x8000) this.complete(num); // BVAL: a short packet is ready
  }

  /** An IN buffer is complete: the host takes it. */
  private complete(num: number): void {
    const p = this.pipes[num];
    p.full = true;
    if (num === 0) this.serviceControlIn();
    else this.serviceIn(num);
  }

  private dcpCtr(): number {
    const p = this.pipes[0];
    const bsts = this.isInPipe(0) ? !p.full : p.buf.length > 0;
    return (this.get(0x60) & ~0x8000) | (bsts || this.ctsq === 1 ? 0x8000 : 0);
  }

  private dcpCtrWrite(value: number): void {
    this.set(0x60, value & ~0x4);
    if (value & 0x4) {
      // CCPL: the status stage completes.
      this.chip.afterUs(20, () => this.finishControl());
    }
    if ((value & 3) === 1) {
      this.serviceControlIn();
      this.serviceControlOut();
    }
  }

  // --------------------------------------------------------------- host

  private attach(): void {
    if (this.attached) return;
    this.attached = true;
    this.chip.afterUs(20_000, () => {
      // Bus reset: the device goes to the Default state.
      this.dvsq = 1;
      this.intsts0 |= INTSTS0.DVST;
      this.update();
      this.chip.afterUs(10_000, () => this.enumerate());
    });
  }

  /** Queues a control transfer; `done` runs on the chip's clock, never as a promise. */
  private request(setup: number[], out: number[] | undefined, done: (data: number[]) => void): void {
    this.controls.push({ setup, out, done });
    if (!this.control) this.nextControl();
  }

  /** Enumeration, one step after another, each started by the previous one's completion. */
  private enumerate(): void {
    const steps: ((next: (data: number[]) => void, last: number[]) => void)[] = [
      (next) => this.request(setupPacket(0x80, 6, 0x0100, 0, 64), undefined, next),
      (next) => {
        // SET_ADDRESS is handled by the hardware and reported as a state change.
        this.set(0x50, 5);
        this.dvsq = 2;
        this.intsts0 |= INTSTS0.DVST;
        this.update();
        this.chip.afterUs(2_000, () => next([]));
      },
      (next) => this.request(setupPacket(0x80, 6, 0x0100, 0, 18), undefined, next),
      (next) => this.request(setupPacket(0x80, 6, 0x0200, 0, 9), undefined, next),
      (next, head) => {
        const total = head.length >= 4 ? head[2] | (head[3] << 8) : 9;
        this.request(setupPacket(0x80, 6, 0x0200, 0, total), undefined, next);
      },
      (next, config) => {
        this.findCdc(config);
        this.dvsq = 3;
        this.request(setupPacket(0x00, 9, config[5] ?? 1, 0, 0), undefined, next);
      },
      (next) => this.request(setupPacket(0x21, 0x20, 0, this.cdcInterface, 7), [0x00, 0xc2, 0x01, 0x00, 0, 0, 8], next),
      (next) => this.request(setupPacket(0x21, 0x22, 3, this.cdcInterface, 0), undefined, next),
      () => {
        this.portOpen = true;
        this.pumpOut();
      },
    ];
    const run = (i: number, last: number[]) => {
      if (i < steps.length) steps[i]((data) => run(i + 1, data), last);
    };
    run(0, []);
  }

  /** The CDC data interface's bulk endpoints, from the configuration descriptor. */
  private findCdc(config: number[]): void {
    let iface = -1;
    let cls = -1;
    for (let i = 0; i + 1 < config.length && config[i] > 0; i += config[i]) {
      const type = config[i + 1];
      if (type === 4) {
        iface = config[i + 2];
        cls = config[i + 5];
        if (cls === 0x02) this.cdcInterface = iface;
      } else if (type === 5 && cls === 0x0a) {
        const addr = config[i + 2];
        const kind = config[i + 3] & 3;
        if (kind !== 2) continue;
        if (addr & 0x80) this.dataIn = addr & 0xf;
        else this.dataOut = addr & 0xf;
      }
    }
  }

  private nextControl(): void {
    const c = this.controls.shift();
    this.control = c ?? null;
    if (!c) return;
    this.controlIn = [];
    this.controlOutAt = 0;
    const [type, req, vl, vh, il, ih, ll, lh] = c.setup;
    const length = ll | (lh << 8);
    this.set(0x54, type | (req << 8));
    this.set(0x56, vl | (vh << 8));
    this.set(0x58, il | (ih << 8));
    this.set(0x5a, length);
    // The pipe goes to NAK for the new transfer; the stage follows the request.
    this.set(0x60, this.get(0x60) & ~3);
    this.pipes[0].buf = [];
    this.pipes[0].full = false;
    this.ctsq = length === 0 ? 5 : type & 0x80 ? 1 : 3;
    this.intsts0 |= INTSTS0.VALID | INTSTS0.CTRT;
    this.update();
  }

  private serviceControlIn(): void {
    const c = this.control;
    if (!c || this.ctsq !== 1 || (this.get(0x60) & 3) !== 1 || !this.pipes[0].full) return;
    this.chip.afterUs(20, () => {
      const p = this.pipes[0];
      if (!p.full) return;
      const packet = p.buf.splice(0);
      p.full = false;
      this.controlIn.push(...packet);
      this.bempsts |= 1;
      const want = this.get(0x5a);
      const mps = this.get(0x5e) & 0x7f || 64;
      if (packet.length < mps || this.controlIn.length >= want) this.ctsq = 2; // status stage next
      this.update();
    });
  }

  private serviceControlOut(): void {
    const c = this.control;
    if (!c || this.ctsq !== 3 || !c.out || (this.get(0x60) & 3) !== 1 || this.pipes[0].buf.length) return;
    this.chip.afterUs(20, () => {
      if (this.pipes[0].buf.length || !c.out) return;
      const mps = this.get(0x5e) & 0x7f || 64;
      const packet = c.out.slice(this.controlOutAt, this.controlOutAt + mps);
      this.controlOutAt += packet.length;
      this.pipes[0].buf.push(...packet);
      this.brdysts |= 1;
      if (this.controlOutAt >= c.out.length) this.ctsq = 4;
      this.update();
    });
  }

  private finishControl(): void {
    const c = this.control;
    if (!c) return;
    this.ctsq = 0;
    this.set(0x60, this.get(0x60) & ~3);
    this.intsts0 |= INTSTS0.CTRT;
    this.update();
    c.done(this.controlIn);
    this.chip.afterUs(50, () => this.nextControl());
  }

  // --------------------------------------------------------------- data

  private pipeFor(ep: number, dirIn: boolean): number {
    for (let n = 1; n < 10; n++) {
      const cfg = this.pipes[n].cfg;
      if ((cfg & 0xf) === ep && ((cfg & 0x10) !== 0) === dirIn && cfg & 0xc000) return n;
    }
    return -1;
  }

  /** The host reads a completed IN buffer. */
  private serviceIn(num: number): void {
    const p = this.pipes[num];
    if (!p.full || (p.ctr & 3) !== 1) return;
    this.chip.afterUs(30, () => {
      if (!p.full) return;
      const packet = p.buf.splice(0);
      p.full = false;
      if (num === this.pipeFor(this.dataIn, true)) for (const b of packet) this.onSerialData?.(b);
      this.brdysts |= 1 << num; // ready to be written again
      this.update();
    });
  }

  /** The host sends what is waiting on the bulk OUT pipe when the device can take it. */
  private pumpOut(): void {
    if (!this.portOpen || !this.outgoing.length) return;
    const num = this.pipeFor(this.dataOut, false);
    if (num < 0) return;
    const p = this.pipes[num];
    if ((p.ctr & 3) !== 1 || p.buf.length) return;
    this.chip.afterUs(30, () => {
      if (p.buf.length || !this.outgoing.length || (p.ctr & 3) !== 1) return;
      const packet = this.outgoing.splice(0, p.maxp || 64);
      p.buf.push(...packet);
      this.brdysts |= 1 << num;
      this.update();
    });
  }
}
