// The Pico W's Wi-Fi chip, an Infineon CYW43439, at its SPI bus.
//
// On the Pico W the RP2040 talks to the CYW43439 over a half-duplex SPI bus
// (gSPI) that a PIO program clocks. Everything on the RP2040's side is open
// source and runs as compiled: the cyw43-driver (which loads the chip's
// firmware, frames ioctls and packets in Broadcom's SDPCM/CDC/BDC formats, and
// parses the chip's events), lwIP, and Arduino-Pico's WiFi library. What is
// closed is the firmware the chip runs. So this is the chip as the driver sees
// it, at the driver's one bus call (cyw43_spi_transfer: a command word, then
// data either way):
//
//   * function 0, the gSPI core's own registers: the test pattern the driver
//     reads first, bus control (word length), interrupt status and enable,
//     and the status word that says whether a packet is waiting and how long;
//   * function 1, the backplane: the window registers, the clock control that
//     reports the ALP and HT clocks available, the sleep control, and the
//     cores' reset/IO control registers the firmware download goes through.
//     The firmware and NVRAM written into the chip's RAM are accepted and not
//     kept: nothing here executes them;
//   * function 2, the chip's packet FIFO: SDPCM frames. Control frames carry
//     ioctls (WLC_* commands and iovars), which are answered as the firmware
//     does — the MAC address, the CLM download, the country, scans (escan),
//     joining with the WPA2 passphrase, the chip's GPIOs (the Pico W's LED is
//     one) — and data frames carry Ethernet frames to and from the simulated
//     network. Events (scan results, authentication, link up and down) come
//     back as the firmware sends them: Ethernet frames of type 0x886C carrying
//     Broadcom's big-endian event message.
//
// The host-wake line (GPIO24, shared with the bus's data line) is raised while
// a frame is waiting, which is what the driver's interrupt and its polls look
// at. Structure layouts are cyw43-driver's (as Arduino-Pico 6.0.0 builds it).

import { WifiNetwork, type StationPort, type ScanResult } from './network';
import { BleAir, BleController } from '../bluetooth/controller';

/** Memory the chip's bus transfers read and write: the RP2040's. */
export interface Cyw43Memory {
  read8(a: number): number;
  write8(a: number, v: number): void;
}

const TEST_PATTERN = 0xfeedbead;
const BUS = 0;
const BACKPLANE = 1;
const WLAN = 2;

// gSPI registers (function 0)
const SPI_BUS_CONTROL = 0x00;
const SPI_INTERRUPT_REGISTER = 0x04;
const SPI_STATUS_REGISTER = 0x08;
const SPI_FUNCTION1_INFO = 0x0c;
const SPI_FUNCTION2_INFO = 0x0e;
const SPI_READ_TEST_REGISTER = 0x14;
const SPI_RESP_DELAY_F1 = 0x1d;
const WORD_LENGTH_32 = 0x01;
const F2_PACKET_AVAILABLE = 0x0020;
const STATUS_F2_RX_READY = 0x20;
const STATUS_F2_PKT_AVAILABLE = 0x100;
const STATUS_F2_PKT_LEN_SHIFT = 9;

// Function 1 registers
const SDIO_BACKPLANE_ADDRESS_LOW = 0x1000a;
const SDIO_BACKPLANE_ADDRESS_MID = 0x1000b;
const SDIO_BACKPLANE_ADDRESS_HIGH = 0x1000c;
const SDIO_CHIP_CLOCK_CSR = 0x1000e;
const SDIO_SLEEP_CSR = 0x1001f;
const SBSDIO_ALP_AVAIL = 0x40;
const SBSDIO_HT_AVAIL = 0x80;
const SBSDIO_SLPCSR_DEVICE_ON = 0x02;
const BACKPLANE_ADDR_MASK = 0x7fff;
/** The SDIO core's interrupt status; I_HMB_FC_CHANGE is what says the Bluetooth core has something. */
const SDIO_INT_STATUS = 0x18002020;
const I_HMB_FC_CHANGE = 1 << 5;
/** The two cores' reset control, which starts asserted (AIRC_RESET). */
const RESET_CONTROLS = [0x18003000 + 0x100000 + 0x800, 0x18004000 + 0x100000 + 0x800];

// SDPCM
const SDPCM_HEADER_LEN = 12;
const CONTROL_HEADER = 0;
const ASYNCEVENT_HEADER = 1;
const DATA_HEADER = 2;
const SDPCM_SET = 2;
/** Where a data or event frame's BDC header sits (two bytes of padding after the SDPCM header). */
const BDC_AT = SDPCM_HEADER_LEN + 2;
const BDC_LEN = 4;

// WLC ioctls
const WLC = {
  UP: 2, DOWN: 3, SET_INFRA: 20, SET_AUTH: 22, GET_BSSID: 23, GET_SSID: 25, SET_SSID: 26, GET_CHANNEL: 29,
  DISASSOC: 52, GET_RSSI: 127, SET_WSEC: 134, GET_VAR: 262, SET_VAR: 263, SET_WSEC_PMK: 268,
} as const;

// Events
const EV = { SET_SSID: 0, AUTH: 3, DISASSOC: 11, LINK: 16, PSK_SUP: 46, ESCAN_RESULT: 69 } as const;
const STATUS = { SUCCESS: 0, FAIL: 1, NO_NETWORKS: 3, UNSOLICITED: 6, PARTIAL: 8 } as const;
/** WLC_SUP_KEYED: the supplicant's handshake finished. */
const SUP_KEYED = 6;
const EVENT_MSG_LEN = 48;

/** wl_bss_info as the driver reads it (cyw43_scan_result_internal_t), and the escan header before it. */
const BSS = { size: 128, bssid: 8, beaconPeriod: 14, capability: 16, ssidLen: 18, ssid: 19, chanspec: 72, rssi: 78, ctlCh: 88, ieOffset: 116, ieLength: 120 } as const;
const ESCAN_HEADER = 12;
const DOT11_CAP_ESS = 0x0001;
const DOT11_CAP_PRIVACY = 0x0010;
/** An RSN element for WPA2-PSK with CCMP, which is what marks a scan result as WPA2 to the driver. */
const RSN_IE = [48, 20, 1, 0, 0x00, 0x0f, 0xac, 4, 1, 0, 0x00, 0x0f, 0xac, 4, 1, 0, 0x00, 0x0f, 0xac, 2, 0, 0];

/** Simulated time an association and a scan take, as on the other boards' models. */
const ASSOCIATE_NS = 150e6;
const SCAN_NS = 250e6;
/** How long the chip takes to answer an ioctl. */
const IOCTL_NS = 20e3;

interface Pending {
  at: number;
  frame: Uint8Array;
}

function swap16pairs(x: number): number {
  return (((x & 0xff00ff00) >>> 8) | ((x & 0x00ff00ff) << 8)) >>> 0;
}

export class Cyw43Chip {
  private wordMode32 = false;
  private readonly f0 = new Uint8Array(0x20);
  private readonly f1 = new Map<number, number>();
  private readonly backplane = new Map<number, number>();
  private window = 0;
  private interruptEnable = 0;
  /** Frames for the host, in the order they become available. */
  private queue: Pending[] = [];
  private hostSeq = 0;
  private txSeq = 0;
  private mac: Uint8Array;
  private label: string;
  private network: WifiNetwork;
  private wsec = 0;
  private pmk = '';
  private connected: ScanResult | null = null;
  private gpioOut = 0;
  readonly station: StationPort;
  /** The chip's GPIOs changed (bit 0 is the Pico W's LED). */
  onGpio: ((bits: number) => void) | null = null;
  /** Whether a frame is waiting: the host-wake line's level. */
  onHostWake: ((high: boolean) => void) | null = null;
  private lastWake = false;
  /** The chip's Bluetooth core: a BLE controller on the air, which BTstack reaches over the shared bus. */
  readonly bluetooth: BleController;

  constructor(
    private readonly memory: Cyw43Memory,
    private readonly clock: () => number,
    mac: ArrayLike<number>,
    label: string,
    network: WifiNetwork = new WifiNetwork(),
  ) {
    this.mac = Uint8Array.from(mac);
    this.label = label;
    this.network = network;
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const chip = this;
    this.station = {
      get mac() {
        return chip.mac;
      },
      get label() {
        return chip.label;
      },
      deliver: (frame) => {
        if (chip.connected) chip.send(chip.dataFrame(frame));
      },
    };
    this.bluetooth = new BleController(clock, [0x43, 0x43, 0xa2, 0x12, 0x1f, 0xac].reverse(), label);
    this.bluetooth.onPending = () => this.updateWake();
    this.reset();
  }

  /** Puts the Bluetooth core on the world's air, under the board's name. */
  attachBluetooth(air: BleAir, address: ArrayLike<number>, label: string): void {
    this.bluetooth.attach(air, address, label);
  }

  // ------------------------------------------------------------- the Bluetooth core

  /** cyw43_btbus_init: the BT firmware download and the shared bus come up; here, the controller powers on. */
  btInit(): number {
    this.bluetooth.powerOn();
    return 0;
  }

  /** cyw43_btbus_write(buf, size): a 3-byte length and the H4 type, then the packet. */
  btWrite(buf: number, size: number): number {
    if (size < 4) return 0;
    const packet = new Uint8Array(size - 3);
    for (let k = 0; k < packet.length; k++) packet[k] = this.memory.read8(buf + 3 + k);
    this.bluetooth.fromHost(packet);
    this.updateWake();
    return 0;
  }

  /** cyw43_btbus_read(buf, max, *size): the next packet with the same header, or a size of 0. */
  btRead(buf: number, max: number, sizeOut: number): number {
    const packet = this.bluetooth.hasDue() ? this.bluetooth.takeDue() : undefined;
    if (!packet || packet.length + 3 > max) {
      this.write32(sizeOut, 0);
      this.updateWake();
      return 0;
    }
    const len = packet.length - 1;
    this.memory.write8(buf, len & 0xff);
    this.memory.write8(buf + 1, (len >> 8) & 0xff);
    this.memory.write8(buf + 2, 0);
    for (let k = 0; k < packet.length; k++) this.memory.write8(buf + 3 + k, packet[k]);
    this.write32(sizeOut, len + 4);
    this.updateWake();
    return 0;
  }

  attach(network: WifiNetwork, mac: ArrayLike<number>, label: string): void {
    if (network !== this.network) {
      this.network.leave(this.station);
      this.connected = null;
      this.network = network;
    }
    this.mac = Uint8Array.from(mac);
    this.label = label;
  }

  /** Power-on state, as WL_REG_ON going high leaves it. */
  reset(): void {
    this.network.leave(this.station);
    this.wordMode32 = false;
    this.f0.fill(0);
    this.f1.clear();
    this.backplane.clear();
    for (const a of RESET_CONTROLS) this.backplane.set(a, 1);
    this.window = 0;
    this.interruptEnable = 0;
    this.queue = [];
    this.hostSeq = 0;
    this.txSeq = 0;
    this.wsec = 0;
    this.pmk = '';
    this.connected = null;
    this.gpioOut = 0;
    this.bluetooth.powerOn();
    this.updateWake();
  }

  get isConnected(): boolean {
    return this.connected !== null;
  }

  /** The chip's GPIO outputs (bit 0 drives the Pico W's LED). */
  get gpio(): number {
    return this.gpioOut;
  }

  /** When the next frame (or Bluetooth packet) becomes available, if one is queued for later. */
  nextDueNs(): number | undefined {
    const now = this.clock();
    let at: number | undefined;
    for (const p of this.queue) if (p.at > now) {
      at = p.at;
      break;
    }
    const bt = this.bluetooth.nextDueNs();
    if (bt !== undefined && bt > now && (at === undefined || bt < at)) at = bt;
    return at;
  }

  /** Raises or lowers the host-wake line for the frames now due. */
  service(): void {
    this.updateWake();
  }

  private due(): Pending | undefined {
    const head = this.queue[0];
    return head && head.at <= this.clock() ? head : undefined;
  }

  private updateWake(): void {
    const high = this.due() !== undefined || this.bluetooth.hasDue();
    if (high !== this.lastWake) {
      this.lastWake = high;
      this.onHostWake?.(high);
    }
  }

  /** The host-wake line, as cyw43_cb_read_host_interrupt_pin reads it. */
  get hostWake(): boolean {
    return this.due() !== undefined || this.bluetooth.hasDue();
  }

  // ------------------------------------------------------------- the bus

  private read32(a: number): number {
    const m = this.memory;
    return (m.read8(a) | (m.read8(a + 1) << 8) | (m.read8(a + 2) << 16) | (m.read8(a + 3) << 24)) >>> 0;
  }

  private write32(a: number, v: number): void {
    for (let k = 0; k < 4; k++) this.memory.write8(a + k, (v >>> (k * 8)) & 0xff);
  }

  /** cyw43_spi_transfer(self, tx, tx_length, rx, rx_length): one bus transaction. */
  transfer(tx: number, txLength: number, rx: number, rxLength: number): number {
    if (!tx && !rx) return -22 >>> 0; // -CYW43_EINVAL
    const cmdAt = tx || rx;
    let cmd = this.read32(cmdAt);
    if (!this.wordMode32) cmd = swap16pairs(cmd);
    const write = (cmd >>> 31) & 1;
    const fn = (cmd >>> 28) & 3;
    const addr = (cmd >>> 11) & 0x1ffff;
    const size = cmd & 0x7ff || 0x800;
    if (rx) {
      // What the chip clocks back starts after the command, and after the
      // function's response delay (the backplane's padding).
      for (let k = 0; k < txLength; k++) this.memory.write8(rx + k, 0);
      const pad = fn === BACKPLANE ? this.f0[SPI_RESP_DELAY_F1] : 0;
      const data = rx + txLength + pad;
      const room = Math.max(0, rxLength - txLength - pad);
      this.read(fn, addr, Math.min(size, room), data, room);
    } else if (write) {
      this.write(fn, addr, Math.min(size, Math.max(0, txLength - 4)), tx + 4);
    }
    this.updateWake();
    return 0;
  }

  private read(fn: number, addr: number, size: number, out: number, room: number): void {
    const m = this.memory;
    for (let k = 0; k < room; k++) m.write8(out + k, 0);
    if (fn === BUS) {
      let v = this.busRegister(addr, size);
      if (!this.wordMode32 && size === 4) v = swap16pairs(v);
      if (room >= 4) this.write32(out, v);
      return;
    }
    if (fn === BACKPLANE) {
      if (addr >= 0x10000) {
        m.write8(out, this.f1Register(addr));
        return;
      }
      const a = (this.window | (addr & BACKPLANE_ADDR_MASK)) >>> 0;
      if (size <= 4) {
        let v = this.backplane.get(a & ~3) ?? 0;
        if ((a & ~3) === SDIO_INT_STATUS && this.bluetooth.hasDue()) v |= I_HMB_FC_CHANGE;
        if (size === 4) this.write32(out, v);
        else m.write8(out, (v >>> ((a & 3) * 8)) & 0xff);
      }
      // Larger reads are of the chip's RAM, which is not kept: zeros.
      return;
    }
    if (fn === WLAN) {
      const p = this.due();
      if (!p) return;
      this.queue.shift();
      const n = Math.min(p.frame.length, room);
      for (let k = 0; k < n; k++) m.write8(out + k, p.frame[k]);
    }
  }

  private write(fn: number, addr: number, size: number, from: number): void {
    const m = this.memory;
    if (fn === BUS) {
      let v = this.read32(from);
      if (!this.wordMode32 && size === 4) v = swap16pairs(v);
      this.setBusRegister(addr, size, v);
      return;
    }
    if (fn === BACKPLANE) {
      if (addr >= 0x10000) {
        this.setF1Register(addr, m.read8(from));
        return;
      }
      if (size <= 4) {
        const a = (this.window | (addr & BACKPLANE_ADDR_MASK)) >>> 0;
        const v = size === 4 ? this.read32(from) : m.read8(from);
        if (size === 4) this.backplane.set(a & ~3, v);
        else {
          const word = this.backplane.get(a & ~3) ?? 0;
          const sh = (a & 3) * 8;
          this.backplane.set(a & ~3, ((word & ~(0xff << sh)) | (v << sh)) >>> 0);
        }
      }
      // Firmware, NVRAM and the CLM blob land in RAM; nothing runs them here.
      return;
    }
    if (fn === WLAN) {
      const frame = new Uint8Array(size);
      for (let k = 0; k < size; k++) frame[k] = m.read8(from + k);
      this.fromHost(frame);
    }
  }

  private busRegister(addr: number, size: number): number {
    const at = (r: number) => this.f0[r & 0x1f];
    switch (addr) {
      case SPI_READ_TEST_REGISTER:
        return TEST_PATTERN;
      case SPI_INTERRUPT_REGISTER:
        return this.due() ? F2_PACKET_AVAILABLE : 0;
      case SPI_STATUS_REGISTER: {
        const p = this.due();
        let v = STATUS_F2_RX_READY;
        if (p) v |= STATUS_F2_PKT_AVAILABLE | (Math.min(p.frame.length, 0x7ff) << STATUS_F2_PKT_LEN_SHIFT);
        return v >>> 0;
      }
      case SPI_FUNCTION1_INFO:
      case SPI_FUNCTION2_INFO:
        // Enabled and ready.
        return 0x0003;
    }
    let v = 0;
    for (let k = 0; k < size; k++) v |= at(addr + k) << (k * 8);
    return v >>> 0;
  }

  private setBusRegister(addr: number, size: number, v: number): void {
    if (addr === SPI_INTERRUPT_REGISTER) return; // write-one-to-clear; F2_PACKET_AVAILABLE follows the queue
    if (addr === 0x06) {
      this.interruptEnable = v & 0xffff;
      return;
    }
    for (let k = 0; k < size; k++) this.f0[(addr + k) & 0x1f] = (v >>> (k * 8)) & 0xff;
    if (addr === SPI_BUS_CONTROL) this.wordMode32 = (v & WORD_LENGTH_32) !== 0;
  }

  private f1Register(addr: number): number {
    const v = this.f1.get(addr) ?? 0;
    if (addr === SDIO_CHIP_CLOCK_CSR) return (v & 0x3f) | SBSDIO_ALP_AVAIL | SBSDIO_HT_AVAIL;
    if (addr === SDIO_SLEEP_CSR) return v ? v | SBSDIO_SLPCSR_DEVICE_ON : 0;
    return v;
  }

  private setF1Register(addr: number, v: number): void {
    this.f1.set(addr, v);
    if (addr === SDIO_BACKPLANE_ADDRESS_LOW) this.window = ((this.window & 0xffff0000) | (v << 8)) >>> 0;
    else if (addr === SDIO_BACKPLANE_ADDRESS_MID) this.window = ((this.window & 0xff00ff00) | (v << 16)) >>> 0;
    else if (addr === SDIO_BACKPLANE_ADDRESS_HIGH) this.window = ((this.window & 0x00ffff00) | (v << 24)) >>> 0;
  }

  // ------------------------------------------------------------- SDPCM

  private send(body: { channel: number; headerLength: number; payload: Uint8Array }, delayNs = 0): void {
    const size = body.headerLength + body.payload.length;
    const f = new Uint8Array(size);
    const v = new DataView(f.buffer);
    v.setUint16(0, size, true);
    v.setUint16(2, ~size & 0xffff, true);
    f[4] = this.txSeq++ & 0xff;
    f[5] = body.channel;
    f[6] = 0;
    f[7] = body.headerLength;
    f[8] = 0; // no flow control
    // Credit well ahead of the host's sequence number, so it never stalls.
    f[9] = (this.hostSeq + 8) & 0xff;
    f.set(body.payload, body.headerLength);
    const at = this.clock() + delayNs;
    let i = this.queue.length;
    while (i > 0 && this.queue[i - 1].at > at) i--;
    this.queue.splice(i, 0, { at, frame: f });
    this.updateWake();
  }

  private dataFrame(ethernet: Uint8Array): { channel: number; headerLength: number; payload: Uint8Array } {
    const p = new Uint8Array(BDC_LEN + ethernet.length);
    p[0] = 0x20; // BDC version 2
    p[2] = 0; // interface: STA
    p[3] = 0; // no extra header words
    p.set(ethernet, BDC_LEN);
    return { channel: DATA_HEADER, headerLength: BDC_AT, payload: p };
  }

  private fromHost(frame: Uint8Array): void {
    if (frame.length < SDPCM_HEADER_LEN) return;
    const v = new DataView(frame.buffer);
    const size = v.getUint16(0, true);
    if ((size ^ v.getUint16(2, true)) !== 0xffff || size > frame.length) return;
    this.hostSeq = frame[4];
    const channel = frame[5] & 0x0f;
    const hl = frame[7];
    if (channel === CONTROL_HEADER) this.ioctl(frame.subarray(hl, size));
    else if (channel === DATA_HEADER) {
      const offset = hl + BDC_LEN + frame[hl + 3] * 4;
      if (this.connected && this.network.isJoined(this.station)) this.network.transmit(this.station, frame.slice(offset, size));
    }
  }

  private ioctl(msg: Uint8Array): void {
    if (msg.length < 16) return;
    const v = new DataView(msg.buffer, msg.byteOffset, msg.byteLength);
    const cmd = v.getUint32(0, true);
    const len = v.getUint32(4, true) & 0xffff;
    const flags = v.getUint32(8, true);
    const set = (flags & 0xf) === SDPCM_SET;
    const iface = (flags >>> 12) & 0xf;
    const data = msg.slice(16, 16 + len);
    const reply = new Uint8Array(len);
    reply.set(data.subarray(0, len));
    let status = 0;
    if (cmd === WLC.SET_VAR || cmd === WLC.GET_VAR) {
      const nul = data.indexOf(0);
      const name = new TextDecoder().decode(data.subarray(0, nul < 0 ? data.length : nul));
      const arg = data.subarray(nul + 1);
      status = set ? this.setVar(name, arg, iface) : this.getVar(name, reply);
    } else if (set) {
      this.setIoctl(cmd, data);
    } else {
      this.getIoctl(cmd, reply);
    }
    const out = new Uint8Array(16 + len);
    const o = new DataView(out.buffer);
    o.setUint32(0, cmd, true);
    o.setUint32(4, len, true);
    o.setUint32(8, flags, true);
    o.setUint32(12, status >>> 0, true);
    out.set(reply, 16);
    this.send({ channel: CONTROL_HEADER, headerLength: SDPCM_HEADER_LEN, payload: out }, IOCTL_NS);
  }

  private getVar(name: string, reply: Uint8Array): number {
    reply.fill(0);
    switch (name) {
      case 'cur_etheraddr':
        reply.set(this.mac.subarray(0, Math.min(6, reply.length)));
        break;
      case 'clmver':
        reply.set(new TextEncoder().encode('simulated CLM').subarray(0, Math.max(0, reply.length - 1)));
        break;
      case 'ccgpioin':
        if (reply.length >= 4) new DataView(reply.buffer).setUint32(0, this.gpioOut, true);
        break;
    }
    return 0;
  }

  private setVar(name: string, arg: Uint8Array, iface: number): number {
    const u32 = (k: number) => (arg.length >= k * 4 + 4 ? new DataView(arg.buffer, arg.byteOffset).getUint32(k * 4, true) : 0);
    switch (name) {
      case 'cur_etheraddr':
        if (arg.length >= 6 && iface === 0) this.mac = Uint8Array.from(arg.subarray(0, 6));
        break;
      case 'gpioout': {
        const mask = u32(0);
        const value = u32(1);
        const next = ((this.gpioOut & ~mask) | (value & mask)) >>> 0;
        if (next !== this.gpioOut) {
          this.gpioOut = next;
          this.onGpio?.(next);
        }
        break;
      }
      case 'escan':
        this.scan();
        break;
      case 'join': {
        // wl_join_params: ssid length, ssid, then scan and association parameters.
        const n = Math.min(32, u32(0));
        this.join(new TextDecoder().decode(arg.subarray(4, 4 + n)));
        break;
      }
    }
    return 0;
  }

  private setIoctl(cmd: number, data: Uint8Array): void {
    const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
    switch (cmd) {
      case WLC.SET_WSEC:
        this.wsec = data.length >= 4 ? v.getUint32(0, true) : 0;
        break;
      case WLC.SET_WSEC_PMK: {
        // wsec_pmk_t: key length, flags, key.
        const n = data.length >= 2 ? Math.min(64, v.getUint16(0, true)) : 0;
        this.pmk = new TextDecoder().decode(data.subarray(4, 4 + n));
        break;
      }
      case WLC.SET_SSID: {
        const n = data.length >= 4 ? Math.min(32, v.getUint32(0, true)) : 0;
        this.join(new TextDecoder().decode(data.subarray(4, 4 + n)));
        break;
      }
      case WLC.DISASSOC:
        this.leave();
        break;
      case WLC.DOWN:
        this.leave();
        break;
    }
  }

  private getIoctl(cmd: number, reply: Uint8Array): void {
    reply.fill(0);
    const v = new DataView(reply.buffer);
    switch (cmd) {
      case WLC.GET_BSSID:
        if (this.connected) reply.set(this.connected.bssid.subarray(0, Math.min(6, reply.length)));
        break;
      case WLC.GET_SSID:
        if (this.connected && reply.length >= 4) {
          const s = new TextEncoder().encode(this.connected.ssid).subarray(0, Math.min(32, reply.length - 4));
          v.setUint32(0, s.length, true);
          reply.set(s, 4);
        }
        break;
      case WLC.GET_RSSI:
        if (reply.length >= 4) v.setInt32(0, this.connected ? this.connected.rssi : 0, true);
        break;
      case WLC.GET_CHANNEL:
        // channel_info_t: hardware, target and scan channel.
        if (reply.length >= 8) {
          v.setUint32(0, this.connected?.channel ?? 0, true);
          v.setUint32(4, this.connected?.channel ?? 0, true);
        }
        break;
    }
  }

  // ------------------------------------------------------------- events

  private event(type: number, status: number, opts: { reason?: number; flags?: number; addr?: Uint8Array; data?: Uint8Array } = {}, delayNs = 0): void {
    const data = opts.data ?? new Uint8Array(0);
    const msg = new Uint8Array(EVENT_MSG_LEN + data.length);
    const m = new DataView(msg.buffer);
    // wl_event_msg_t, big-endian.
    m.setUint16(0, 2);
    m.setUint16(2, opts.flags ?? 0);
    m.setUint32(4, type);
    m.setUint32(8, status);
    m.setUint32(12, opts.reason ?? 0);
    m.setUint32(16, 0);
    m.setUint32(20, data.length);
    if (opts.addr) msg.set(opts.addr.subarray(0, 6), 24);
    msg.set(new TextEncoder().encode('wlan0'), 30);
    msg[46] = 0; // interface: STA
    msg[47] = 0;
    msg.set(data, EVENT_MSG_LEN);
    // An Ethernet frame of type 0x886C with Broadcom's header in front of the message.
    const eth = new Uint8Array(24 + msg.length);
    eth.set(this.mac, 0);
    eth.set(this.mac, 6);
    eth[12] = 0x88;
    eth[13] = 0x6c;
    new DataView(eth.buffer).setUint16(14, 0x8001);
    new DataView(eth.buffer).setUint16(16, 4 + msg.length + 4);
    eth[18] = 0;
    eth.set([0x00, 0x10, 0x18], 19);
    new DataView(eth.buffer).setUint16(22, 1);
    eth.set(msg, 24);
    const p = new Uint8Array(BDC_LEN + eth.length);
    p[0] = 0x20;
    p.set(eth, BDC_LEN);
    this.send({ channel: ASYNCEVENT_HEADER, headerLength: BDC_AT, payload: p }, delayNs);
  }

  private scan(): void {
    const found = this.network.scan();
    for (const ap of found) {
      const ie = ap.open ? [] : RSN_IE;
      const bss = new Uint8Array(BSS.size + ie.length);
      const b = new DataView(bss.buffer);
      b.setUint32(0, 109, true); // version
      b.setUint32(4, bss.length, true);
      bss.set(ap.bssid, BSS.bssid);
      b.setUint16(BSS.beaconPeriod, 100, true);
      b.setUint16(BSS.capability, DOT11_CAP_ESS | (ap.open ? 0 : DOT11_CAP_PRIVACY), true);
      const ssid = new TextEncoder().encode(ap.ssid).subarray(0, 32);
      bss[BSS.ssidLen] = ssid.length;
      bss.set(ssid, BSS.ssid);
      // 20 MHz, 2.4 GHz.
      b.setUint16(BSS.chanspec, (ap.channel & 0xff) | 0x1000, true);
      b.setInt16(BSS.rssi, ap.rssi, true);
      bss[BSS.ctlCh] = ap.channel;
      b.setUint16(BSS.ieOffset, BSS.size, true);
      b.setUint32(BSS.ieLength, ie.length, true);
      bss.set(ie, BSS.size);
      const escan = new Uint8Array(ESCAN_HEADER + bss.length);
      const e = new DataView(escan.buffer);
      e.setUint32(0, escan.length, true);
      e.setUint32(4, 1, true);
      e.setUint16(8, 0, true);
      e.setUint16(10, 1, true);
      escan.set(bss, ESCAN_HEADER);
      this.event(EV.ESCAN_RESULT, STATUS.PARTIAL, { data: escan, addr: ap.bssid }, SCAN_NS);
    }
    this.event(EV.ESCAN_RESULT, STATUS.SUCCESS, {}, SCAN_NS);
  }

  private join(ssid: string): void {
    if (this.connected) this.leave();
    const password = this.wsec ? this.pmk : '';
    // The outcome is decided when the association would finish.
    const at = ASSOCIATE_NS;
    const result = this.network.scan().find((ap) => ap.ssid === ssid);
    if (!result) {
      this.event(EV.SET_SSID, STATUS.NO_NETWORKS, { reason: 0 }, at);
      return;
    }
    const joined = this.network.join(this.station, ssid, password);
    if (!joined.ok) {
      // Authenticated, then the 4-way handshake fails: the driver reports a bad password (CYW43_LINK_BADAUTH).
      this.event(EV.AUTH, STATUS.SUCCESS, { addr: result.bssid }, at);
      this.event(EV.PSK_SUP, STATUS.FAIL, { reason: 0, addr: result.bssid }, at);
      return;
    }
    this.connected = joined.ap;
    const bssid = joined.ap.bssid;
    this.event(EV.AUTH, STATUS.SUCCESS, { addr: bssid }, at);
    this.event(EV.LINK, STATUS.SUCCESS, { flags: 1, addr: bssid }, at);
    this.event(EV.SET_SSID, STATUS.SUCCESS, { addr: bssid }, at);
    if (this.wsec) this.event(EV.PSK_SUP, SUP_KEYED, { addr: bssid }, at);
  }

  private leave(): void {
    const was = this.connected;
    if (!was) return;
    this.connected = null;
    this.network.leave(this.station);
    this.event(EV.LINK, STATUS.SUCCESS, { flags: 0, addr: was.bssid });
    this.event(EV.DISASSOC, STATUS.SUCCESS, { addr: was.bssid });
  }
}
