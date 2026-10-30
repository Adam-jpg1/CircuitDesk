// The nRF52840's USBD controller, and a host on the other end.
//
// On the Arduino Nano 33 BLE `Serial` is native USB: mbed's USBCDC over the
// Nordic USBPhy and SDK 15's nrf_drv_usbd, unmodified. This models the
// controller as that driver uses it, from the nRF52840 Product Specification:
//
//   * every endpoint transfer is EasyDMA — STARTEPIN[n]/STARTEPOUT[n] copy
//     between RAM and the endpoint's buffer (STARTED, then ENDEPIN/ENDEPOUT),
//     and the host's side of each packet is reported separately: EP0DATADONE
//     on endpoint 0, EPDATA with EPDATASTATUS on the others;
//   * control transfers: EP0SETUP with the request in BMREQUESTTYPE..WLENGTH,
//     EP0RCVOUT to accept an OUT data stage, EP0STATUS to finish, EP0STALL;
//   * SET_ADDRESS is completed by the hardware itself, as on the real part;
//   * EVENTCAUSE.READY after ENABLE; VBUS is present from the start, and the
//     USB regulator reports ready (POWER.USBPWRRDY) once the USBD is enabled.
//
// The host (usbCdcHost.ts) enumerates once the pull-up is enabled, then opens
// the CDC port and moves bytes over the bulk endpoints. Everything runs on
// the chip's clock.
//
// Simplified: no SOF, suspend or resume, no isochronous endpoints, no stalls
// beyond ending the control transfer, and every DMA is a few microseconds.

import type { McuUsbSerial } from '../armv7m/armRunner';
import { enumerateCdc, setupPacket } from '../armv7m/usbCdcHost';
import type { Periph } from '../armv7m/peripherals';

/** What the controller needs from the chip and from its Nordic peripheral wrapper. */
export interface UsbdHost {
  readonly p: Periph;
  task(offset: number, fn: () => void): void;
  /** The hardware sets an event, running any task SHORTS links to it. */
  fire(offset: number): void;
  /** SHORTS bit `bit`: when event `from` fires, task `to` runs. */
  link(bit: number, from: number, to: number): void;
  afterUs(us: number, fn: () => void): void;
  dmaRead(address: number): number;
  dmaWrite(address: number, value: number): void;
  /** ENABLE was written: the USB regulator comes up and POWER reports it. */
  enabled(): void;
}

const EV = {
  USBRESET: 0x100,
  STARTED: 0x104,
  ENDEPIN: (n: number) => 0x108 + n * 4,
  EP0DATADONE: 0x128,
  ENDEPOUT: (n: number) => 0x130 + n * 4,
  USBEVENT: 0x158,
  EP0SETUP: 0x15c,
  EPDATA: 0x160,
};

const READY = 1 << 11;

interface Control {
  setup: number[];
  out?: number[];
  done: (data: number[]) => void;
  /** SET_ADDRESS: the hardware runs the status stage itself. */
  byHardware?: boolean;
}

export class NrfUsbd implements McuUsbSerial {
  onSerialData: ((byte: number) => void) | null = null;
  /** True once the host has opened the port (DTR set). */
  portOpen = false;

  private attached = false;
  private eventcause = 0;
  private epstatus = 0;
  private epdatastatus = 0;
  private readonly outSize = new Uint32Array(8);
  /** A packet the host has put in an OUT endpoint, waiting for its DMA. */
  private readonly outBuf: (number[] | null)[] = Array(8).fill(null);
  /** A packet DMA'd into an IN endpoint, waiting for the host. */
  private readonly inBuf: (number[] | null)[] = Array(8).fill(null);
  private control: Control | null = null;
  private readonly controls: Control[] = [];
  private controlIn: number[] = [];
  private controlOutAt = 0;
  private dataIn = -1;
  private dataOut = -1;
  private readonly outgoing: number[] = [];

  constructor(private readonly n: UsbdHost) {
    const p = n.p;
    p.reg(0x400, () => this.eventcause, (v) => (this.eventcause &= ~v)); // EVENTCAUSE, write 1 to clear
    p.reg(0x468, () => this.epstatus, (v) => (this.epstatus &= ~v)); // EPSTATUS
    p.reg(0x46c, () => this.epdatastatus, (v) => (this.epdatastatus &= ~v)); // EPDATASTATUS
    const setupByte = (i: number) => () => this.control?.setup[i] ?? 0;
    for (let i = 0; i < 8; i++) p.reg(0x480 + i * 4, setupByte(i)); // BMREQUESTTYPE .. WLENGTHH
    for (let e = 0; e < 8; e++) {
      // SIZE.EPOUT[n]: what the host sent; a write frees the buffer for the next packet.
      p.reg(0x4a0 + e * 4, () => this.outSize[e], () => {
        this.outBuf[e] = null;
        this.pumpOut();
      });
      n.task(0x004 + e * 4, () => this.startIn(e)); // STARTEPIN[n]
      n.task(0x028 + e * 4, () => this.startOut(e)); // STARTEPOUT[n]
    }
    p.reg(0x500, undefined, (v) => {
      if (!(v & 1)) return;
      this.eventcause |= READY;
      n.enabled();
    }); // ENABLE
    p.reg(0x504, undefined, (v) => {
      if (v & 1) this.attach();
    }); // USBPULLUP
    p.reg(0x514, undefined, () => this.pumpOut()); // EPOUTEN
    n.task(0x04c, () => this.receiveControlOut()); // EP0RCVOUT
    n.task(0x050, () => this.status()); // EP0STATUS
    n.task(0x054, () => this.status()); // EP0STALL: the host gives up on the request
    // SHORTS, which the driver uses to end a control transfer's last packet.
    n.link(0, EV.EP0DATADONE, 0x004); // EP0DATADONE_STARTEPIN0
    n.link(1, EV.EP0DATADONE, 0x028); // EP0DATADONE_STARTEPOUT0
    n.link(2, EV.EP0DATADONE, 0x050); // EP0DATADONE_EP0STATUS
    n.link(3, EV.ENDEPOUT(0), 0x050); // ENDEPOUT0_EP0STATUS
    n.link(4, EV.ENDEPOUT(0), 0x04c); // ENDEPOUT0_EP0RCVOUT
  }

  sendSerial(bytes: Iterable<number>): void {
    for (const b of bytes) this.outgoing.push(b & 0xff);
    this.pumpOut();
  }

  // ---------------------------------------------------------- the host

  private attach(): void {
    if (this.attached) return;
    this.attached = true;
    this.n.afterUs(20_000, () => {
      this.n.fire(EV.USBRESET);
      this.n.afterUs(10_000, () =>
        enumerateCdc({
          request: (setup, out, done) => this.request({ setup, out, done }),
          setAddress: (address, done) => {
            this.request({
              setup: setupPacket(0x00, 5, address, 0, 0),
              byHardware: true,
              done: () => {
                this.n.p.poke(0x470, address); // USBADDR
                this.n.afterUs(2_000, done);
              },
            });
          },
          configuring: (cdc) => {
            this.dataIn = cdc.dataIn;
            this.dataOut = cdc.dataOut;
          },
          opened: () => {
            this.portOpen = true;
            this.pumpOut();
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
    this.inBuf[0] = null;
    this.outBuf[0] = null;
    this.n.fire(EV.EP0SETUP);
    if (c.byHardware) this.n.afterUs(200, () => this.finish(c));
  }

  /** EP0STATUS (or a stall): the device is done with the request. */
  private status(): void {
    const c = this.control;
    if (!c || c.byHardware) return;
    // Let the host take a last IN packet already on its way.
    this.n.afterUs(40, () => this.finish(c));
  }

  private finish(c: Control): void {
    if (this.control !== c) return;
    this.control = null;
    c.done(this.controlIn);
    this.n.afterUs(50, () => {
      if (!this.control) this.nextControl();
    });
  }

  /** EP0RCVOUT: the device will take the next packet of an OUT data stage. */
  private receiveControlOut(): void {
    const c = this.control;
    if (!c?.out) return;
    this.n.afterUs(20, () => {
      if (this.control !== c || !c.out || this.outBuf[0]) return;
      const mps = 64;
      const packet = c.out.slice(this.controlOutAt, this.controlOutAt + mps);
      this.controlOutAt += packet.length;
      this.outBuf[0] = packet;
      this.outSize[0] = packet.length;
      this.n.fire(EV.EP0DATADONE);
    });
  }

  /** The host reads a packet waiting in an IN endpoint. */
  private takeIn(e: number): void {
    this.n.afterUs(e === 0 ? 20 : 30, () => {
      const packet = this.inBuf[e];
      if (!packet) return;
      this.inBuf[e] = null;
      if (e === 0) {
        if (!this.control) return;
        this.controlIn.push(...packet);
        this.n.fire(EV.EP0DATADONE);
        return;
      }
      if (e === this.dataIn) for (const b of packet) this.onSerialData?.(b);
      this.epdatastatus |= 1 << e;
      this.n.fire(EV.EPDATA);
    });
  }

  /** The host sends what is waiting on the bulk OUT endpoint when it can take it. */
  private pumpOut(): void {
    const e = this.dataOut;
    if (!this.portOpen || e < 1 || !this.outgoing.length || this.outBuf[e]) return;
    if (!(this.n.p.peek(0x514) & (1 << e))) return;
    this.n.afterUs(30, () => {
      if (this.outBuf[e] || !this.outgoing.length) return;
      const packet = this.outgoing.splice(0, 64);
      this.outBuf[e] = packet;
      this.outSize[e] = packet.length;
      this.epdatastatus |= 1 << (16 + e);
      this.n.fire(EV.EPDATA);
    });
  }

  // ------------------------------------------------------------ EasyDMA

  private startIn(e: number): void {
    const p = this.n.p;
    const ptr = p.peek(0x600 + e * 0x14);
    const count = p.peek(0x604 + e * 0x14) & 0x7f;
    const packet: number[] = [];
    for (let i = 0; i < count; i++) packet.push(this.n.dmaRead(ptr + i));
    p.poke(0x608 + e * 0x14, count); // AMOUNT
    this.epstatus |= 1 << e;
    this.n.fire(EV.STARTED);
    this.n.afterUs(2, () => {
      this.inBuf[e] = packet;
      this.n.fire(EV.ENDEPIN(e));
      this.takeIn(e);
    });
  }

  private startOut(e: number): void {
    const p = this.n.p;
    const ptr = p.peek(0x700 + e * 0x14);
    const max = p.peek(0x704 + e * 0x14) & 0x7f;
    const packet = this.outBuf[e] ?? [];
    const count = Math.min(max, packet.length);
    this.epstatus |= 1 << (16 + e);
    this.n.fire(EV.STARTED);
    this.n.afterUs(2, () => {
      for (let i = 0; i < count; i++) this.n.dmaWrite(ptr + i, packet[i]);
      p.poke(0x708 + e * 0x14, count); // AMOUNT
      this.outBuf[e] = null;
      this.n.fire(EV.ENDEPOUT(e));
      this.pumpOut();
    });
  }
}
