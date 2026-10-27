// The ATmega32U4's USB device controller, and a host on the other end of the
// cable.
//
// On a Leonardo, `Serial` is not a UART. It is a CDC-ACM port the chip's own
// USB controller presents to the computer, so without this model a sketch's
// Serial.println() went nowhere and `while (!Serial);` — in nearly every
// Leonardo example — waited for ever.
//
// The model is of the registers firmware touches (avr-libc's iom32u4.h names,
// datasheet chapter 22), not of the Arduino core: the core's USBCore.cpp runs
// unmodified against it. The host side does what a computer does when the
// board is plugged in — resets the bus, reads the descriptors, sets an address
// and a configuration, sets the line coding and raises DTR — and then reads the
// CDC data endpoint every frame. Everything is scheduled on the CPU's own
// clock, so enumeration takes simulated milliseconds, not wall time.
//
// Simplified, deliberately: one bank per endpoint (the host empties an IN bank
// the moment firmware releases it, so a second bank would never be used), no
// suspend/resume, no remote wakeup, no isochronous endpoints, no status-stage
// OUT packet after a control read (Arduino's core never waits for one), and no
// endpoint other than the CDC pair is read by the host. A HID sketch therefore
// enumerates but its reports are not consumed.

import type { CPU } from 'avr8js';

/** The shape CPU.queueInterrupt takes; avr8js does not export its name. */
type AVRInterruptConfig = Parameters<CPU['queueInterrupt']>[0];

const UHWCON = 0xd7;
const USBCON = 0xd8;
const USBSTA = 0xd9;
const USBINT = 0xda;
const UDCON = 0xe0;
const UDINT = 0xe1;
const UDIEN = 0xe2;
const UDADDR = 0xe3;
const UDFNUML = 0xe4;
const UDFNUMH = 0xe5;
const UDMFN = 0xe6;
const UEINTX = 0xe8;
const UENUM = 0xe9;
const UERST = 0xea;
const UECONX = 0xeb;
const UECFG0X = 0xec;
const UECFG1X = 0xed;
const UESTA0X = 0xee;
const UESTA1X = 0xef;
const UEIENX = 0xf0;
const UEDATX = 0xf1;
const UEBCLX = 0xf2;
const UEBCHX = 0xf3;
const UEINT = 0xf4;

// USBCON / UDCON
const USBE = 1 << 7;
const FRZCLK = 1 << 5;
const DETACH = 1 << 0;
// UDINT
const SOFI = 1 << 2;
const EORSTI = 1 << 3;
// UEINTX
const TXINI = 1 << 0;
const STALLEDI = 1 << 1;
const RXOUTI = 1 << 2;
const RXSTPI = 1 << 3;
const RWAL = 1 << 5;
const FIFOCON = 1 << 7;
/** The UEINTX bits firmware clears by writing 0. RWAL is read-only. */
const CLEARABLE = 0xdf;
/** UEINTX bits that have an enable in UEIENX at the same position. */
const INTERRUPTING = 0x5f;
// UECONX / UECFG
const EPEN = 1 << 0;
const STALLRQC = 1 << 4;
const STALLRQ = 1 << 5;
const EPDIR_IN = 1 << 0;
const ALLOC = 1 << 1;
const CFGOK = 1 << 7;

const EP_SIZE = 64;
const ENDPOINTS = 7;

/** USB_GEN and USB_COM: vectors 10 and 11, two words each. */
const GEN_INTERRUPT: AVRInterruptConfig = {
  address: 0x14, enableRegister: UDIEN, enableMask: 0, flagRegister: UDINT, flagMask: 0, constant: true,
};
const COM_INTERRUPT: AVRInterruptConfig = {
  address: 0x16, enableRegister: UEIENX, enableMask: 0, flagRegister: UEINTX, flagMask: 0, constant: true,
};

interface Endpoint {
  conx: number;
  cfg0: number;
  cfg1: number;
  ienx: number;
  /** Interrupt flags firmware has not cleared yet (TXINI, RXOUTI, RXSTPI, STALLEDI). */
  flags: number;
  /** What firmware has written for the host (an IN bank, or EP0's IN data). */
  inBank: number[];
  /** What the host has sent and firmware has not read yet. */
  outBank: number[];
  stalled: boolean;
}

interface ControlTransfer {
  setup: number[];
  /** Host-to-device data stage, if any. */
  data?: number[];
  done: (ok: boolean, data: number[]) => void;
}

type ControlPhase = 'setup' | 'data-in' | 'data-out' | 'status';

const freshEndpoint = (): Endpoint => ({
  conx: 0, cfg0: 0, cfg1: 0, ienx: 0, flags: 0, inBank: [], outBank: [], stalled: false,
});

const setupPacket = (bmRequestType: number, bRequest: number, wValue: number, wIndex: number, wLength: number): number[] => [
  bmRequestType, bRequest, wValue & 0xff, wValue >> 8, wIndex & 0xff, wIndex >> 8, wLength & 0xff, wLength >> 8,
];

export class Atmega32u4Usb {
  /** Bytes the firmware sent on the CDC data endpoint. */
  onSerialData: ((byte: number) => void) | null = null;

  private readonly eps: Endpoint[] = Array.from({ length: ENDPOINTS }, freshEndpoint);
  private current = 0;
  private usbcon = FRZCLK;
  private uhwcon = 0;
  private udcon = DETACH;
  private udint = 0;
  private udien = 0;
  private udaddr = 0;
  private usbint = 0;
  private frame = 0;

  private attached = false;
  private sofRunning = false;

  // The host.
  private control: ControlTransfer | null = null;
  private phase: ControlPhase = 'setup';
  private received: number[] = [];
  private queue: ControlTransfer[] = [];
  private cdcIn = -1;
  private cdcOut = -1;
  private cdcInterface = 0;
  private open = false;
  private hostOut: number[] = [];
  /** Bumped on every detach, so callbacks from an old connection are dropped. */
  private session = 0;

  constructor(private readonly cpu: CPU, private readonly fCpu: number) {
    const r = cpu.readHooks;
    const w = cpu.writeHooks;
    const plain = (addr: number, get: () => number, set: (v: number) => void) => {
      r[addr] = () => get() & 0xff;
      w[addr] = (value: number) => {
        set(value);
        this.afterAccess();
        return true;
      };
    };
    plain(UHWCON, () => this.uhwcon, (v) => (this.uhwcon = v));
    plain(USBCON, () => this.usbcon, (v) => (this.usbcon = v));
    plain(UDCON, () => this.udcon, (v) => (this.udcon = v));
    plain(UDIEN, () => this.udien, (v) => (this.udien = v));
    plain(UDADDR, () => this.udaddr, (v) => (this.udaddr = v));
    plain(USBINT, () => this.usbint, (v) => (this.usbint &= v));
    plain(UDMFN, () => 0, () => {});
    // VBUS present and the ID pin high: a device on a powered cable.
    plain(USBSTA, () => 0x03, () => {});
    plain(UDFNUML, () => this.frame & 0xff, () => {});
    plain(UDFNUMH, () => (this.frame >> 8) & 0x07, () => {});
    // UDINT's flags are set by hardware and cleared by writing 0.
    plain(UDINT, () => this.udint, (v) => (this.udint &= v));
    plain(UENUM, () => this.current, (v) => (this.current = Math.min(v & 7, ENDPOINTS - 1)));
    plain(UERST, () => 0, (v) => {
      for (let i = 0; i < ENDPOINTS; i++) {
        if (v & (1 << i)) {
          const ep = this.eps[i];
          ep.inBank = [];
          ep.outBank = [];
          ep.flags = 0;
        }
      }
    });
    plain(UECONX, () => this.ep.conx, (v) => this.writeConx(v));
    plain(UECFG0X, () => this.ep.cfg0, (v) => (this.ep.cfg0 = v));
    plain(UECFG1X, () => this.ep.cfg1, (v) => (this.ep.cfg1 = v));
    plain(UESTA0X, () => (this.ep.cfg1 & ALLOC ? CFGOK : 0), () => {});
    plain(UESTA1X, () => 0, () => {});
    plain(UEIENX, () => this.ep.ienx, (v) => (this.ep.ienx = v));
    plain(UEBCLX, () => this.byteCount(), () => {});
    plain(UEBCHX, () => 0, () => {});
    plain(UEINT, () => this.pendingEndpoints(), () => {});
    plain(UEINTX, () => this.intx(), (v) => this.writeIntx(v));
    r[UEDATX] = () => {
      const value = this.ep.outBank.shift() ?? 0;
      this.afterAccess();
      return value;
    };
    w[UEDATX] = (value: number) => {
      const ep = this.ep;
      if (ep.inBank.length < EP_SIZE) ep.inBank.push(value & 0xff);
      return true;
    };
  }

  // ------------------------------------------------------------ the host side

  /** Text typed into the monitor, for Serial.read(). Dropped if no port is open. */
  sendSerial(bytes: Iterable<number>): void {
    if (!this.open) return;
    for (const b of bytes) this.hostOut.push(b & 0xff);
    this.deliverOut();
  }

  /** True once the host has configured the device and raised DTR. */
  get portOpen(): boolean {
    return this.open;
  }

  private get ep(): Endpoint {
    return this.eps[this.current];
  }

  private get cyclesPerMs(): number {
    return this.fCpu / 1000;
  }

  private later(ms: number, fn: () => void): void {
    const session = this.session;
    this.cpu.addClockEvent(() => {
      if (session === this.session) fn();
    }, Math.max(1, Math.round(ms * this.cyclesPerMs)));
  }

  /** Watches for the firmware connecting to (or leaving) the bus. */
  private checkAttach(): void {
    const attached = (this.usbcon & USBE) !== 0 && (this.usbcon & FRZCLK) === 0 && (this.udcon & DETACH) === 0;
    if (attached === this.attached) return;
    this.attached = attached;
    this.session++;
    this.open = false;
    this.control = null;
    this.queue = [];
    this.sofRunning = false;
    if (!attached) return;
    // A host notices the pull-up, waits for the line to settle, and resets the bus.
    this.later(2, () => this.busReset());
  }

  private busReset(): void {
    for (let i = 0; i < ENDPOINTS; i++) this.eps[i] = freshEndpoint();
    this.udint |= EORSTI;
    this.evaluate();
    if (!this.sofRunning) {
      this.sofRunning = true;
      this.later(1, () => this.startOfFrame());
    }
    // Enumerate once the firmware has set EP0 up again after the reset.
    this.later(1, () => this.waitForEp0());
  }

  private startOfFrame(): void {
    if (!this.sofRunning) return;
    this.frame = (this.frame + 1) & 0x7ff;
    this.udint |= SOFI;
    this.deliverOut();
    this.evaluate();
    this.later(1, () => this.startOfFrame());
  }

  private waitForEp0(): void {
    const ep0 = this.eps[0];
    if ((ep0.conx & EPEN) === 0 || (ep0.ienx & RXSTPI) === 0) {
      this.later(1, () => this.waitForEp0());
      return;
    }
    this.enumerate();
  }

  private enumerate(): void {
    const get = (type: number, index: number, length: number) => setupPacket(0x80, 6, (type << 8) | index, 0, length);
    this.request(get(1, 0, 64), undefined, () => {
      this.request(setupPacket(0x00, 5, 1, 0, 0), undefined, () => {
        this.request(get(2, 0, 9), undefined, (ok, head) => {
          const total = ok && head.length >= 4 ? head[2] | (head[3] << 8) : 9;
          this.request(get(2, 0, total), undefined, (okFull, config) => {
            if (okFull) this.findCdc(config);
            this.request(setupPacket(0x00, 9, 1, 0, 0), undefined, () => {
              if (this.cdcIn < 0) return; // no CDC port: enumerated, nothing to open
              // 115200 8N1, then DTR and RTS: the terminal opening the port.
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

  /** The CDC communication interface and its data endpoints, from the configuration. */
  private findCdc(config: number[]): void {
    let i = 0;
    let inData = false;
    while (i + 1 < config.length) {
      const len = config[i];
      const type = config[i + 1];
      if (len < 2) break;
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

  private request(setup: number[], data: number[] | undefined, done: ControlTransfer['done']): void {
    this.queue.push({ setup, data, done });
    if (!this.control) this.later(1, () => this.nextControl());
  }

  private nextControl(): void {
    if (this.control) return;
    const next = this.queue.shift();
    if (!next) return;
    const ep0 = this.eps[0];
    this.control = next;
    this.received = [];
    this.phase = 'setup';
    // A SETUP always gets through: it clears a stall and anything left in the bank.
    ep0.stalled = false;
    ep0.inBank = [];
    ep0.outBank = [...next.setup];
    ep0.flags = (ep0.flags | RXSTPI | TXINI) & ~RXOUTI;
    this.evaluate();
    // A device that never answers is given up on rather than waited for.
    const control = next;
    this.later(50, () => {
      if (this.control === control) this.finishControl(false);
    });
  }

  private finishControl(ok: boolean): void {
    const control = this.control;
    if (!control) return;
    this.control = null;
    control.done(ok, this.received);
    // A frame between transfers, as a host leaves: the firmware's handler for
    // this one may still be finishing, and a stray release from it must not
    // land in the next transfer.
    this.later(1, () => this.nextControl());
  }

  /** Firmware acknowledged the SETUP packet. */
  private setupAcknowledged(): void {
    const control = this.control;
    if (!control) return;
    const deviceToHost = (control.setup[0] & 0x80) !== 0;
    if (deviceToHost) {
      this.phase = 'data-in';
    } else if (control.data && control.data.length > 0) {
      this.phase = 'data-out';
      const ep0 = this.eps[0];
      ep0.outBank = [...control.data];
      ep0.flags |= RXOUTI;
    } else {
      this.phase = 'status';
    }
  }

  /** Firmware handed EP0's IN bank to the host. */
  private controlIn(packet: number[]): void {
    if (!this.control) return; // a status ZLP for a transfer already complete
    if (this.phase === 'data-in') {
      this.received.push(...packet);
      if (packet.length < EP_SIZE) this.finishControl(true);
    } else if (this.phase === 'status') {
      this.finishControl(true);
    }
  }

  /** Firmware read the data stage of a control write. */
  private controlOutConsumed(): void {
    if (this.phase === 'data-out') this.phase = 'status';
  }

  private bulkIn(ep: number, packet: number[]): void {
    if (ep !== this.cdcIn || !this.open) return;
    for (const b of packet) this.onSerialData?.(b);
  }

  /** Hands queued host bytes to the CDC OUT endpoint when its bank is free. */
  private deliverOut(): void {
    if (!this.open || this.cdcOut < 0 || this.hostOut.length === 0) return;
    const ep = this.eps[this.cdcOut];
    if ((ep.conx & EPEN) === 0 || ep.outBank.length > 0) return;
    ep.outBank = this.hostOut.splice(0, EP_SIZE);
    ep.flags |= RXOUTI;
    this.evaluate();
  }

  // ------------------------------------------------------------ the device side

  private isIn(index: number): boolean {
    return (this.eps[index].cfg0 & EPDIR_IN) !== 0;
  }

  private byteCount(): number {
    const ep = this.ep;
    if (this.current === 0) return ep.outBank.length || ep.inBank.length;
    return this.isIn(this.current) ? ep.inBank.length : ep.outBank.length;
  }

  /** UEINTX as firmware reads it for the selected endpoint. */
  private intx(): number {
    const ep = this.ep;
    let v = ep.flags & (TXINI | STALLEDI | RXOUTI | RXSTPI);
    if (this.current === 0) {
      if (ep.inBank.length < EP_SIZE) v |= RWAL;
      return v;
    }
    if (this.isIn(this.current)) {
      // The host empties the bank the moment it is released, so it is always free.
      v |= TXINI | FIFOCON;
      if (ep.inBank.length < EP_SIZE) v |= RWAL;
    } else if (ep.outBank.length > 0) {
      v |= RXOUTI | FIFOCON | RWAL;
    }
    return v;
  }

  private writeIntx(value: number): void {
    const index = this.current;
    const ep = this.ep;
    const before = this.intx();
    const cleared = before & ~value & CLEARABLE;

    if (index === 0) {
      if (cleared & RXSTPI) {
        // Acknowledging a SETUP also frees EP0's bank; it is not a transmission.
        ep.flags &= ~(RXSTPI | RXOUTI);
        ep.outBank = [];
        ep.inBank = [];
        ep.flags |= TXINI;
        this.setupAcknowledged();
        return;
      }
      if (cleared & TXINI) {
        const packet = ep.inBank;
        ep.inBank = [];
        ep.flags |= TXINI; // the host takes it at once, freeing the bank
        this.controlIn(packet);
      }
      if (cleared & RXOUTI) {
        ep.flags &= ~RXOUTI;
        ep.outBank = [];
        this.controlOutConsumed();
      }
      if (cleared & STALLEDI) ep.flags &= ~STALLEDI;
      return;
    }

    if (this.isIn(index)) {
      if (cleared & (FIFOCON | TXINI)) {
        const packet = ep.inBank;
        ep.inBank = [];
        this.bulkIn(index, packet);
      }
    } else if (cleared & (FIFOCON | RXOUTI)) {
      // ReleaseRX: the bank is handed back to the host.
      ep.outBank = [];
      ep.flags &= ~RXOUTI;
      this.later(0.05, () => this.deliverOut());
    }
    if (cleared & STALLEDI) ep.flags &= ~STALLEDI;
  }

  private writeConx(value: number): void {
    const ep = this.ep;
    ep.conx = value & ~(STALLRQ | STALLRQC);
    if (value & STALLRQC) ep.stalled = false;
    if (value & STALLRQ) {
      ep.stalled = true;
      // EP0 answers a request it does not support with a STALL.
      if (this.current === 0 && this.control) this.finishControl(false);
    }
  }

  private pendingEndpoints(): number {
    let v = 0;
    for (let i = 0; i < ENDPOINTS; i++) {
      const saved = this.current;
      this.current = i;
      if (this.intx() & this.eps[i].ienx & INTERRUPTING) v |= 1 << i;
      this.current = saved;
    }
    return v;
  }

  private afterAccess(): void {
    this.checkAttach();
    this.evaluate();
  }

  /** Raises or drops USB_GEN and USB_COM to match the flags and enables. */
  private evaluate(): void {
    if (this.udint & this.udien & 0x7f) this.cpu.queueInterrupt(GEN_INTERRUPT);
    else this.cpu.clearInterrupt(GEN_INTERRUPT, false);
    if (this.pendingEndpoints()) this.cpu.queueInterrupt(COM_INTERRUPT);
    else this.cpu.clearInterrupt(COM_INTERRUPT, false);
  }
}
