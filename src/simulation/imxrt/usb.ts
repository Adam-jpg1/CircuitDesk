// The i.MX RT1062's USB OTG1 controller in device mode (a ChipIdea core), and
// a host on the other end.
//
// On the Teensy 4.1 `Serial` is native USB: the Teensy core's own driver
// (usb.c, usb_serial.c), unmodified. This models the controller as that driver
// uses it:
//
//   * endpoint queue heads (dQH) in RAM at ENDPTLISTADDR, two per endpoint
//     (OUT, then IN), and the transfer descriptors (dTD) linked from them;
//   * ENDPTPRIME loads a queue head's next dTD (ENDPTSTAT shows it primed),
//     the host moves a packet at a time through its buffer, and a retired dTD
//     has its token written back and, with IOC, sets ENDPTCOMPLETE;
//   * SETUP packets land in the EP0 OUT queue head with ENDPTSETUPSTAT;
//   * USBSTS (UI, URI, SRI, TI0) behind the one interrupt, the start-of-frame
//     tick while SRE is enabled, and general-purpose timer 0, which the
//     serial driver's transmit flush uses.
//
// The host (usbCdcHost.ts) enumerates once the controller runs (USBCMD.RS),
// at full speed, then opens the CDC port. Everything runs on the chip's clock.
//
// Simplified: one control transfer at a time, no ISO, no stalls beyond ending
// the request, no suspend, timer 1 absent.

import type { McuUsbSerial } from '../armv7m/armRunner';
import { enumerateCdc, setupPacket } from '../armv7m/usbCdcHost';

export interface ImxrtUsbChip {
  afterUs(us: number, fn: () => void): () => void;
  setInterrupt(on: boolean): void;
  read8(address: number): number;
  write8(address: number, value: number): void;
  read32(address: number): number;
  write32(address: number, value: number): void;
}

const STS = { UI: 1 << 0, URI: 1 << 6, SRI: 1 << 7, PCI: 1 << 2, TI0: 1 << 24 };

interface Control {
  setup: number[];
  out?: number[];
  done: (data: number[]) => void;
}

type Stage = 'setup' | 'dataIn' | 'dataOut' | 'statusIn' | 'statusOut';

export class ImxrtUsb implements McuUsbSerial {
  onSerialData: ((byte: number) => void) | null = null;
  portOpen = false;

  private readonly regs = new Map<number, number>();
  private usbsts = 0;
  private setupStat = 0;
  private endptStat = 0;
  private endptComplete = 0;
  private attached = false;
  private sof: (() => void) | null = null;
  private timer0: (() => void) | null = null;
  private control: Control | null = null;
  private stage: Stage = 'setup';
  private controlIn: number[] = [];
  private controlOutAt = 0;
  private readonly controls: Control[] = [];
  /** A host transaction on this endpoint bit is already scheduled. */
  private readonly pending = new Set<number>();
  private dataIn = -1;
  private dataOut = -1;
  private readonly outgoing: number[] = [];
  /** How far into its current dTD each endpoint has got. */
  private readonly moved = new Map<number, { dtd: number; bytes: number }>();

  constructor(private readonly chip: ImxrtUsbChip) {}

  sendSerial(bytes: Iterable<number>): void {
    for (const b of bytes) this.outgoing.push(b & 0xff);
    this.service();
  }

  // ------------------------------------------------------------ registers

  read(offset: number, width: 1 | 2 | 4): number {
    const word = offset & ~3;
    let v: number;
    switch (word) {
      case 0x140: v = this.get(0x140); break; // USBCMD
      case 0x144: v = this.usbsts; break;
      case 0x184: v = this.portsc(); break; // PORTSC1
      case 0x1ac: v = this.setupStat; break;
      case 0x1b0: v = 0; break; // ENDPTPRIME: priming completes at once
      case 0x1b4: v = 0; break; // ENDPTFLUSH: likewise
      case 0x1b8: v = this.endptStat; break;
      case 0x1bc: v = this.endptComplete; break;
      default: v = this.get(word);
    }
    const shift = (offset & 3) * 8;
    return width === 4 ? v >>> 0 : (v >>> shift) & (width === 1 ? 0xff : 0xffff);
  }

  write(offset: number, value: number, width: 1 | 2 | 4): void {
    const word = offset & ~3;
    let v = value >>> 0;
    if (width !== 4) {
      const shift = (offset & 3) * 8;
      const mask = ((width === 1 ? 0xff : 0xffff) << shift) >>> 0;
      v = ((this.read(word, 4) & ~mask) | ((value << shift) & mask)) >>> 0;
    }
    switch (word) {
      case 0x140: { // USBCMD
        if (v & 2) {
          // RST: the controller resets and the bit clears.
          this.regs.clear();
          this.usbsts = this.setupStat = this.endptStat = this.endptComplete = 0;
          this.update();
          return;
        }
        this.set(0x140, v);
        if (v & 1) this.attach();
        return;
      }
      case 0x144: this.usbsts &= ~v; return this.update(); // USBSTS, write 1 to clear
      case 0x148: this.set(0x148, v); this.sofTick(); return this.update(); // USBINTR
      case 0x084: return this.timer0Ctrl(v); // GPTIMER0CTRL
      case 0x1ac: this.setupStat &= ~v; return; // ENDPTSETUPSTAT
      case 0x1b0: return this.prime(v); // ENDPTPRIME
      case 0x1b4: this.endptStat &= ~v; return; // ENDPTFLUSH
      case 0x1bc: this.endptComplete &= ~v; return this.update(); // ENDPTCOMPLETE
      default: this.set(word, v);
    }
  }

  private get(reg: number): number {
    return this.regs.get(reg) ?? 0;
  }

  private set(reg: number, value: number): void {
    this.regs.set(reg, value >>> 0);
  }

  private portsc(): number {
    // Connected, enabled, full speed (Teensy's driver leaves the port change
    // interrupt off and stays at 12 Mbit/s).
    return 0x1 | 0x4;
  }

  private update(): void {
    this.chip.setInterrupt((this.usbsts & this.get(0x148)) !== 0);
  }

  private raise(bits: number): void {
    this.usbsts |= bits;
    this.update();
  }

  /** The start-of-frame interrupt, every millisecond while SRE is enabled. */
  private sofTick(): void {
    const on = (this.get(0x148) & STS.SRI) !== 0;
    if (on && !this.sof) {
      const tick = () => {
        this.sof = this.chip.afterUs(1000, () => {
          this.raise(STS.SRI);
          if (this.get(0x148) & STS.SRI) tick();
          else this.sof = null;
        });
      };
      tick();
    }
  }

  private timer0Ctrl(v: number): void {
    this.set(0x084, v);
    if (v & (1 << 30) || !(v & (1 << 31))) {
      this.timer0?.();
      this.timer0 = null;
    }
    if (v & (1 << 31)) {
      // GPTRUN with GPTRST: a one-shot of GPTIMER0LD + 1 microseconds.
      this.timer0 = this.chip.afterUs((this.get(0x080) & 0xffffff) + 1, () => {
        this.timer0 = null;
        this.set(0x084, this.get(0x084) & ~(1 << 31));
        this.raise(STS.TI0);
      });
    }
  }

  // ------------------------------------------------- queue heads and dTDs

  /** The queue head for an ENDPT* bit: OUT n is bit n, IN n is bit 16 + n. */
  private qh(bit: number): number {
    const ep = bit & 15;
    const dirIn = bit >= 16 ? 1 : 0;
    return this.get(0x158) + (ep * 2 + dirIn) * 64;
  }

  private maxPacket(bit: number): number {
    return (this.chip.read32(this.qh(bit)) >>> 16) & 0x7ff || 64;
  }

  /** ENDPTPRIME: each queue head takes its next dTD, if it has one. */
  private prime(bits: number): void {
    for (let bit = 0; bit < 32; bit++) {
      if (!(bits & (1 << bit))) continue;
      const qh = this.qh(bit);
      const next = this.chip.read32(qh + 8);
      if (next & 1) continue;
      this.chip.write32(qh + 4, next); // current dTD
      this.endptStat |= 1 << bit;
    }
    this.service();
  }

  /** The dTD the endpoint is working on, or 0. */
  private current(bit: number): number {
    if (!(this.endptStat & (1 << bit))) return 0;
    const dtd = this.chip.read32(this.qh(bit) + 4);
    if (!dtd || dtd & 1) return 0;
    if (!(this.chip.read32(dtd + 4) & 0x80)) return 0; // not active
    return dtd;
  }

  private remaining(dtd: number): number {
    return (this.chip.read32(dtd + 4) >>> 16) & 0x7fff;
  }

  private bufferAddress(dtd: number, at: number): number {
    const ptr0 = this.chip.read32(dtd + 8);
    const total = (ptr0 & 0xfff) + at;
    const page = total >>> 12;
    const base = page === 0 ? ptr0 & ~0xfff : this.chip.read32(dtd + 8 + page * 4) & ~0xfff;
    return (base + (total & 0xfff)) >>> 0;
  }

  /** Moves one packet through the current dTD: IN reads it out, OUT fills it. */
  private transact(bit: number, out?: number[]): number[] {
    const dtd = this.current(bit);
    if (!dtd) return [];
    const token = this.chip.read32(dtd + 4);
    const left = this.remaining(dtd);
    const progress = this.moved.get(bit);
    const moved = progress && progress.dtd === dtd ? progress.bytes : 0;
    const mps = this.maxPacket(bit);
    let packet: number[];
    if (bit >= 16) {
      const n = Math.min(mps, left);
      packet = [];
      for (let i = 0; i < n; i++) packet.push(this.chip.read8(this.bufferAddress(dtd, moved + i)));
    } else {
      packet = (out ?? []).slice(0, Math.min(mps, left));
      packet.forEach((b, i) => this.chip.write8(this.bufferAddress(dtd, moved + i), b));
    }
    const nowLeft = left - packet.length;
    const finished = nowLeft === 0 || packet.length < mps;
    this.chip.write32(dtd + 4, ((token & ~(0x7fff << 16)) | (nowLeft << 16)) >>> 0);
    if (finished) {
      this.moved.delete(bit);
      this.retire(bit, dtd);
    } else this.moved.set(bit, { dtd, bytes: moved + packet.length });
    return packet;
  }

  /** A finished dTD: inactive, IOC reported, the next one taken up or the endpoint idle. */
  private retire(bit: number, dtd: number): void {
    const token = this.chip.read32(dtd + 4);
    this.chip.write32(dtd + 4, (token & ~0x80) >>> 0);
    if (token & (1 << 15)) {
      this.endptComplete |= 1 << bit;
      this.raise(STS.UI);
    }
    const next = this.chip.read32(dtd);
    const qh = this.qh(bit);
    this.chip.write32(qh + 8, next);
    if (next & 1) this.endptStat &= ~(1 << bit);
    else this.chip.write32(qh + 4, next);
  }

  // ------------------------------------------------------------- the host

  private attach(): void {
    if (this.attached) return;
    this.attached = true;
    this.chip.afterUs(20_000, () => {
      // Bus reset.
      this.raise(STS.URI);
      this.chip.afterUs(10_000, () =>
        enumerateCdc({
          request: (setup, out, done) => this.request({ setup, out, done }),
          setAddress: (address, done) => this.request({ setup: setupPacket(0x00, 5, address, 0, 0), done: () => this.chip.afterUs(2_000, done) }),
          configuring: (cdc) => {
            this.dataIn = cdc.dataIn;
            this.dataOut = cdc.dataOut;
          },
          opened: () => {
            this.portOpen = true;
            this.service();
          },
        }),
      );
    });
  }

  private request(c: Control): void {
    this.controls.push(c);
    if (!this.control) this.nextControl();
  }

  private nextControl(): void {
    const c = this.controls.shift() ?? null;
    this.control = c;
    if (!c) return;
    this.controlIn = [];
    this.controlOutAt = 0;
    const [type, , , , , , ll, lh] = c.setup;
    const length = ll | (lh << 8);
    this.stage = length === 0 ? 'statusIn' : type & 0x80 ? 'dataIn' : 'dataOut';
    // The SETUP packet: into the EP0 OUT queue head, flagged in ENDPTSETUPSTAT.
    const qh = this.get(0x158);
    for (let i = 0; i < 8; i++) this.chip.write8(qh + 40 + i, c.setup[i]);
    this.setupStat |= 1;
    this.raise(STS.UI);
  }

  private finishControl(): void {
    const c = this.control;
    if (!c) return;
    this.control = null;
    c.done(this.controlIn);
    this.chip.afterUs(50, () => {
      if (!this.control) this.nextControl();
    });
  }

  /** Starts whatever host transaction the primed endpoints now allow. */
  private service(): void {
    const c = this.control;
    if (c && !this.setupStat) {
      const want = c.setup[6] | (c.setup[7] << 8);
      if (this.stage === 'dataIn') {
        this.after(16, 20, () => {
          const packet = this.transact(16);
          this.controlIn.push(...packet);
          if (packet.length < this.maxPacket(16) || this.controlIn.length >= want) this.stage = 'statusOut';
        });
      } else if (this.stage === 'dataOut' && c.out) {
        this.after(0, 20, () => {
          const packet = c.out!.slice(this.controlOutAt, this.controlOutAt + this.maxPacket(0));
          this.controlOutAt += this.transact(0, packet).length;
          if (this.controlOutAt >= c.out!.length) this.stage = 'statusIn';
        });
      } else if (this.stage === 'statusIn') {
        this.after(16, 20, () => {
          this.transact(16);
          this.finishControl();
        });
      } else if (this.stage === 'statusOut') {
        this.after(0, 20, () => {
          this.transact(0, []);
          this.finishControl();
        });
      }
    }
    if (this.portOpen) {
      if (this.dataIn > 0) {
        this.after(16 + this.dataIn, 30, () => {
          for (const b of this.transact(16 + this.dataIn)) this.onSerialData?.(b);
        });
      }
      if (this.dataOut > 0 && this.outgoing.length) {
        this.after(this.dataOut, 30, () => {
          const mps = this.maxPacket(this.dataOut);
          const left = this.remaining(this.current(this.dataOut));
          const packet = this.outgoing.splice(0, Math.min(mps, left));
          this.transact(this.dataOut, packet);
        });
      }
    }
  }

  /** One transaction on an endpoint, `us` from now, if it has an active dTD then. */
  private after(bit: number, us: number, fn: () => void): void {
    if (this.pending.has(bit) || !this.current(bit)) return;
    this.pending.add(bit);
    this.chip.afterUs(us, () => {
      this.pending.delete(bit);
      if (this.current(bit)) fn();
      this.service();
    });
  }
}
