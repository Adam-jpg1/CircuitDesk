// Bluetooth Low Energy, below HCI: a controller for each board, and the air
// between them.
//
// Every Bluetooth stack on the boards here is split where the Bluetooth spec
// splits it: a host (Bluedroid or NimBLE on the ESP32s, BTstack on the Pico W)
// that does L2CAP, ATT/GATT, SMP and GAP, and a controller below the Host
// Controller Interface that does the radio. The hosts are open source and run
// as compiled; the controllers are closed firmware on a radio this simulator
// does not have. So this is a controller, speaking HCI as the spec defines it:
//
//   * the informational and setup commands a host issues at start-up (reset,
//     versions, features, buffer sizes, event masks), answered with what a
//     Bluetooth 5.0 LE controller with data length extension reports;
//   * legacy advertising (parameters, advertising and scan response data,
//     enable), which puts the board on the air with its data;
//   * scanning, passive or active, which reports every advertiser on the air
//     as LE Advertising Report events (and its scan response when active);
//   * connections: LE Create Connection to an advertiser that accepts them
//     ends in LE Connection Complete on both sides, the advertiser as
//     peripheral, and ACL data then crosses between the two hosts unchanged —
//     what they say in it (L2CAP, ATT, SMP) is theirs. Number Of Completed
//     Packets returns the host's buffers; Disconnect ends the link on both
//     sides with the reason the spec gives each;
//   * connection updates, remote features and version, data length and PHY
//     commands, answered as a controller that keeps the 1M PHY.
//
// Not modelled: BR/EDR (classic Bluetooth: no inquiry, paging or SPP),
// encryption (LE Start Encryption is refused, so pairing cannot finish),
// extended and periodic advertising, filter-accept lists beyond accepting
// their commands, address resolution, RSSI that varies, and the radio itself:
// timing is the link's, not the air's.

/** HCI packet indicators (the H4 framing every transport here uses). */
export const H4 = { COMMAND: 0x01, ACL: 0x02, EVENT: 0x04 } as const;

const EV = {
  DISCONNECTION_COMPLETE: 0x05,
  READ_REMOTE_VERSION_COMPLETE: 0x0c,
  COMMAND_COMPLETE: 0x0e,
  COMMAND_STATUS: 0x0f,
  NUMBER_OF_COMPLETED_PACKETS: 0x13,
  LE_META: 0x3e,
} as const;
const LE_SUB = {
  CONNECTION_COMPLETE: 0x01,
  ADVERTISING_REPORT: 0x02,
  CONNECTION_UPDATE_COMPLETE: 0x03,
  READ_REMOTE_FEATURES_COMPLETE: 0x04,
  DATA_LENGTH_CHANGE: 0x07,
  ENHANCED_CONNECTION_COMPLETE: 0x0a,
  PHY_UPDATE_COMPLETE: 0x0c,
} as const;
/** Error codes (Core spec Vol 1 Part F). */
export const HCI_ERR = {
  SUCCESS: 0x00,
  UNKNOWN_CONNECTION: 0x02,
  COMMAND_DISALLOWED: 0x0c,
  UNSUPPORTED_FEATURE: 0x11,
  INVALID_PARAMETERS: 0x12,
  REMOTE_USER_TERMINATED: 0x13,
  LOCAL_HOST_TERMINATED: 0x16,
  UNKNOWN_ADV_IDENTIFIER: 0x42,
} as const;

const op = (ogf: number, ocf: number) => (ogf << 10) | ocf;
const OP = {
  DISCONNECT: op(1, 0x0006),
  READ_REMOTE_VERSION: op(1, 0x001d),
  SET_EVENT_MASK: op(3, 0x0001),
  RESET: op(3, 0x0003),
  READ_LOCAL_NAME: op(3, 0x0014),
  READ_TX_POWER: op(3, 0x002d),
  READ_LE_HOST_SUPPORT: op(3, 0x006c),
  WRITE_LE_HOST_SUPPORT: op(3, 0x006d),
  WRITE_SIMPLE_PAIRING_MODE: op(3, 0x0056),
  READ_AUTH_PAYLOAD_TIMEOUT: op(3, 0x007b),
  READ_LOCAL_VERSION: op(4, 0x0001),
  READ_LOCAL_COMMANDS: op(4, 0x0002),
  READ_LOCAL_FEATURES: op(4, 0x0003),
  READ_LOCAL_EXT_FEATURES: op(4, 0x0004),
  READ_BUFFER_SIZE: op(4, 0x0005),
  READ_BD_ADDR: op(4, 0x0009),
  READ_RSSI: op(5, 0x0005),
  LE_SET_EVENT_MASK: op(8, 0x0001),
  LE_READ_BUFFER_SIZE: op(8, 0x0002),
  LE_READ_LOCAL_FEATURES: op(8, 0x0003),
  LE_SET_RANDOM_ADDRESS: op(8, 0x0005),
  LE_SET_ADV_PARAMS: op(8, 0x0006),
  LE_READ_ADV_TX_POWER: op(8, 0x0007),
  LE_SET_ADV_DATA: op(8, 0x0008),
  LE_SET_SCAN_RSP_DATA: op(8, 0x0009),
  LE_SET_ADV_ENABLE: op(8, 0x000a),
  LE_SET_SCAN_PARAMS: op(8, 0x000b),
  LE_SET_SCAN_ENABLE: op(8, 0x000c),
  LE_CREATE_CONNECTION: op(8, 0x000d),
  LE_CREATE_CONNECTION_CANCEL: op(8, 0x000e),
  LE_READ_ACCEPT_LIST_SIZE: op(8, 0x000f),
  LE_CONNECTION_UPDATE: op(8, 0x0013),
  LE_READ_CHANNEL_MAP: op(8, 0x0015),
  LE_READ_REMOTE_FEATURES: op(8, 0x0016),
  LE_ENCRYPT: op(8, 0x0017),
  LE_RAND: op(8, 0x0018),
  LE_START_ENCRYPTION: op(8, 0x0019),
  LE_LTK_REPLY: op(8, 0x001a),
  LE_LTK_NEG_REPLY: op(8, 0x001b),
  LE_READ_SUPPORTED_STATES: op(8, 0x001c),
  LE_SET_DATA_LENGTH: op(8, 0x0022),
  LE_READ_SUGGESTED_DATA_LENGTH: op(8, 0x0023),
  LE_READ_P256_PUBLIC_KEY: op(8, 0x0025),
  LE_GENERATE_DHKEY: op(8, 0x0026),
  LE_READ_RESOLVING_LIST_SIZE: op(8, 0x002a),
  LE_READ_MAX_DATA_LENGTH: op(8, 0x002f),
  LE_READ_PHY: op(8, 0x0030),
  LE_SET_PHY: op(8, 0x0032),
  LE_READ_TX_POWER: op(8, 0x004b),
  /**
   * Vendor command 0x0001: with no parameters, NimBLE's Read Static Address;
   * with six, Broadcom's Write BD_ADDR (the Pico W's BTstack sets its address so).
   */
  VS_0001: op(0x3f, 0x0001),
} as const;

/**
 * LMP features (page 0): LE supported by the controller (octet 4, bit 6),
 * with the BR/EDR basics a dual-mode host expects to see; nothing of BR/EDR
 * is modelled beyond answering its configuration commands.
 */
const LMP_FEATURES = [0xbf, 0xfe, 0x8f, 0xfe, 0xd8, 0x3f, 0x5b, 0x87].map((b, i) => (i === 4 ? b | 0x40 : b));

/** Advertising PDU types, as LE Set Advertising Parameters names them, and as reports carry them. */
const ADV_IND = 0x00;
const ADV_DIRECT_IND = 0x01;
const ADV_SCAN_IND = 0x02;
const ADV_NONCONN_IND = 0x03;
const REPORT_SCAN_RSP = 0x04;

/** Simulated time things take on the air. */
const SCAN_REPORT_INTERVAL_NS = 100e6;
const CONNECT_NS = 30e6;
const PROCEDURE_NS = 15e6;
/**
 * How long the controller takes to answer anything, as a real one does over
 * its transport. Not zero: a host that is told "answered" while it is still
 * inside its own send (BTstack on the Pico W, woken by an interrupt) would see
 * its packet buffer still in use and stall.
 */
const CONTROLLER_LATENCY_NS = 50e3;
/** The controller's ACL buffers: data length extension's maximum, eight of them. */
const ACL_LENGTH = 251;
const ACL_BUFFERS = 8;
/** The interval a new connection runs at, in 1.25 ms units, when the initiator asked for a range. */
const DEFAULT_SUPERVISION = 400;

export const SIMULATED_BLE_RSSI = -50;

export interface Advertisement {
  address: Uint8Array;
  addressType: number;
  /** The legacy PDU type: ADV_IND (0) and ADV_DIRECT_IND (1) accept connections. */
  pduType: number;
  data: Uint8Array;
  scanResponse: Uint8Array;
}

/** Something on the air that can hold a connection: a board's controller, or the workbench. */
export interface BleLinkEnd {
  readonly label: string;
  readonly address: Uint8Array;
  readonly addressType: number;
  /** The link is up: this end's handle for it, its role (0 central, 1 peripheral) and the other end. */
  linkUp(handle: number, role: number, peer: BleLinkEnd, interval: number): void;
  /** ACL data from the other end, as its host sent it (packet boundary flag and the L2CAP bytes). */
  aclIn(handle: number, pb: number, data: Uint8Array): void;
  linkDown(handle: number, reason: number): void;
  /** The other end updated the connection parameters. */
  linkUpdated?(handle: number, interval: number, latency: number, timeout: number): void;
}

interface Link {
  a: BleLinkEnd;
  b: BleLinkEnd;
  handleA: number;
  handleB: number;
}

/** One board's view of the air, for the workbench. */
export interface BleDeviceView {
  label: string;
  address: string;
  addressType: 'public' | 'random';
  advertising: boolean;
  connectable: boolean;
  name?: string;
  connections: number;
}

export function addressString(a: Uint8Array): string {
  // HCI carries addresses least significant byte first.
  return [...a].reverse().map((b) => b.toString(16).padStart(2, '0')).join(':').toUpperCase();
}

/** The Complete or Shortened Local Name in advertising data, if there is one. */
export function advertisedName(data: Uint8Array): string | undefined {
  for (let i = 0; i + 1 < data.length; ) {
    const len = data[i];
    if (len === 0) break;
    const type = data[i + 1];
    if (type === 0x09 || type === 0x08) return new TextDecoder().decode(data.subarray(i + 2, i + 1 + len));
    i += len + 1;
  }
  return undefined;
}

/**
 * The air: who is advertising, who is scanning, and the links between them.
 * A world has one; every Bluetooth board on the canvas is on it.
 */
export class BleAir {
  private readonly controllers = new Set<BleController>();
  private readonly links = new Map<number, Link>();
  private nextLinkId = 1;
  private readonly listeners = new Set<() => void>();
  /** Ends that are not controllers (the workbench), keyed so a board can connect to them. */
  private readonly others = new Set<BleLinkEnd>();

  add(c: BleController): void {
    this.controllers.add(c);
    this.changed();
  }

  remove(c: BleController): void {
    this.controllers.delete(c);
    for (const [id, l] of this.links) if (l.a === c || l.b === c) this.drop(id, HCI_ERR.REMOTE_USER_TERMINATED, c);
    this.changed();
  }

  addEnd(end: BleLinkEnd): void {
    this.others.add(end);
  }

  /** Everything advertising now, but `except`. */
  advertisers(except?: BleController): { controller: BleController; adv: Advertisement }[] {
    const out: { controller: BleController; adv: Advertisement }[] = [];
    for (const c of this.controllers) {
      if (c === except) continue;
      const adv = c.advertisement;
      if (adv) out.push({ controller: c, adv });
    }
    return out;
  }

  /** The advertiser at an address, if it is advertising. */
  findAdvertiser(address: Uint8Array): BleController | undefined {
    for (const c of this.controllers) {
      const adv = c.advertisement;
      if (adv && sameAddress(adv.address, address)) return c;
    }
    return undefined;
  }

  /** Opens a link from `central` to the advertiser `peripheral`, whose advertising it ends. */
  connect(central: BleLinkEnd, peripheral: BleController, interval: number): number {
    const id = this.nextLinkId++;
    const link: Link = { a: central, b: peripheral, handleA: 0, handleB: 0 };
    this.links.set(id, link);
    link.handleA = central instanceof BleController ? central.allocateHandle(id) : id;
    link.handleB = peripheral.allocateHandle(id);
    peripheral.stopAdvertisingForConnection();
    peripheral.linkUp(link.handleB, 1, central, interval);
    central.linkUp(link.handleA, 0, peripheral, interval);
    this.changed();
    return id;
  }

  /** ACL data from one end of a link to the other. */
  send(linkId: number, from: BleLinkEnd, pb: number, data: Uint8Array): boolean {
    const l = this.links.get(linkId);
    if (!l) return false;
    if (l.a === from) l.b.aclIn(l.handleB, pb, data);
    else if (l.b === from) l.a.aclIn(l.handleA, pb, data);
    else return false;
    return true;
  }

  /** Ends a link; `by` is the end whose host asked, which hears its own reason, and the other the remote's. */
  drop(linkId: number, reason: number, by?: BleLinkEnd): void {
    const l = this.links.get(linkId);
    if (!l) return;
    this.links.delete(linkId);
    const remote = reason === HCI_ERR.LOCAL_HOST_TERMINATED ? HCI_ERR.REMOTE_USER_TERMINATED : reason;
    l.a.linkDown(l.handleA, l.a === by ? reason : remote);
    l.b.linkDown(l.handleB, l.b === by ? reason : remote);
    this.changed();
  }

  /** The connection parameters changed; both ends hear it. */
  update(linkId: number, interval: number, latency: number, timeout: number): void {
    const l = this.links.get(linkId);
    if (!l) return;
    l.a.linkUpdated?.(l.handleA, interval, latency, timeout);
    l.b.linkUpdated?.(l.handleB, interval, latency, timeout);
  }

  peerOf(linkId: number, end: BleLinkEnd): BleLinkEnd | undefined {
    const l = this.links.get(linkId);
    return l ? (l.a === end ? l.b : l.a) : undefined;
  }

  devices(): BleDeviceView[] {
    const out: BleDeviceView[] = [];
    for (const c of this.controllers) {
      const adv = c.advertisement;
      let connections = 0;
      for (const l of this.links.values()) if (l.a === c || l.b === c) connections++;
      out.push({
        label: c.label,
        address: addressString(adv?.address ?? c.address),
        addressType: (adv?.addressType ?? 0) === 0 ? 'public' : 'random',
        advertising: adv !== null,
        connectable: adv !== null && (adv.pduType === ADV_IND || adv.pduType === ADV_DIRECT_IND),
        name: adv ? advertisedName(adv.data) ?? advertisedName(adv.scanResponse) : undefined,
        connections,
      });
    }
    return out;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  changed(): void {
    for (const l of this.listeners) l();
  }
}

function sameAddress(a: Uint8Array, b: Uint8Array): boolean {
  for (let i = 0; i < 6; i++) if (a[i] !== b[i]) return false;
  return true;
}

interface PendingPacket {
  at: number;
  packet: Uint8Array;
}

interface Connection {
  linkId: number;
  role: number;
  peer: BleLinkEnd;
  interval: number;
}

/**
 * One board's Bluetooth controller. The board's HCI transport hands it the
 * host's packets (fromHost) and takes what it has for the host (takeDue),
 * each an H4-framed HCI packet.
 */
export class BleController implements BleLinkEnd {
  private air: BleAir;
  address: Uint8Array;
  private randomAddress = new Uint8Array(6);
  label: string;
  private queue: PendingPacket[] = [];
  private eventMask = new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0x1f, 0, 0]);
  private leHost = false;
  private sspHost = false;
  private leEventMask = new Uint8Array([0x1f, 0, 0, 0, 0, 0, 0, 0]);
  private adv = { type: ADV_IND, ownAddressType: 0, data: new Uint8Array(0), scanResponse: new Uint8Array(0), enabled: false };
  private scan = { active: false, ownAddressType: 0, enabled: false, filterDuplicates: false, seen: new Set<string>(), next: 0 };
  private initiating: { address: Uint8Array; addressType: number; interval: number; at: number } | null = null;
  private readonly connections = new Map<number, Connection>();
  private nextHandle = 1;
  /** Called when a packet for the host is queued, so the transport can raise its interrupt or wake its task. */
  onPending: (() => void) | null = null;

  constructor(
    private readonly clock: () => number,
    address: ArrayLike<number>,
    label: string,
    air: BleAir = new BleAir(),
  ) {
    this.address = Uint8Array.from(address);
    this.label = label;
    this.air = air;
    air.add(this);
  }

  get addressType(): number {
    return this.adv.ownAddressType & 1;
  }

  /** Moves to the world's air, under its board's name and address (least significant byte first). */
  attach(air: BleAir, address: ArrayLike<number>, label: string): void {
    if (air !== this.air) {
      this.air.remove(this);
      this.air = air;
      air.add(this);
    }
    this.address = Uint8Array.from(address);
    this.label = label;
    air.changed();
  }

  /** What the controller has on the air, if it is advertising. */
  get advertisement(): Advertisement | null {
    if (!this.adv.enabled) return null;
    const random = (this.adv.ownAddressType & 1) === 1;
    return {
      address: random ? this.randomAddress : this.address,
      addressType: random ? 1 : 0,
      pduType: this.adv.type,
      data: this.adv.data,
      scanResponse: this.adv.scanResponse,
    };
  }

  // ------------------------------------------------------------- to the host

  private push(packet: Uint8Array, delayNs = 0): void {
    const at = this.clock() + Math.max(delayNs, CONTROLLER_LATENCY_NS);
    let i = this.queue.length;
    while (i > 0 && this.queue[i - 1].at > at) i--;
    this.queue.splice(i, 0, { at, packet });
    this.onPending?.();
  }

  /** The next packet for the host, if one is due now. */
  takeDue(): Uint8Array | undefined {
    this.poll();
    const head = this.queue[0];
    if (!head || head.at > this.clock()) return undefined;
    this.queue.shift();
    return head.packet;
  }

  /** Whether a packet for the host is due now (without taking it). */
  hasDue(): boolean {
    this.poll();
    const head = this.queue[0];
    return head !== undefined && head.at <= this.clock();
  }

  /** When a packet for the host next becomes due (scanning makes them periodically). */
  nextDueNs(): number | undefined {
    let at = this.queue[0]?.at;
    if (this.scan.enabled && (at === undefined || this.scan.next < at)) at = this.scan.next;
    if (this.initiating && (at === undefined || this.initiating.at < at)) at = this.initiating.at;
    return at;
  }

  private event(code: number, params: ArrayLike<number>, delayNs = 0): void {
    // Events the host masked out are not sent. Command Complete, Command
    // Status and Number Of Completed Packets cannot be masked; LE Meta has its own mask too.
    const bit = code - 1;
    const unmaskable = code === EV.COMMAND_COMPLETE || code === EV.COMMAND_STATUS || code === EV.NUMBER_OF_COMPLETED_PACKETS;
    if (!unmaskable && code !== EV.LE_META && bit >= 0 && bit < 64) {
      if (!((this.eventMask[bit >> 3] >> (bit & 7)) & 1)) return;
    }
    const p = new Uint8Array(3 + params.length);
    p[0] = H4.EVENT;
    p[1] = code;
    p[2] = params.length;
    p.set(Array.from(params), 3);
    this.push(p, delayNs);
  }

  private leEvent(sub: number, params: ArrayLike<number>, delayNs = 0): boolean {
    const bit = sub - 1;
    if (!((this.eventMask[7] >> 5) & 1)) return false; // LE Meta itself (event mask bit 61)
    if (!((this.leEventMask[bit >> 3] >> (bit & 7)) & 1)) return false;
    this.event(EV.LE_META, [sub, ...Array.from(params)], delayNs);
    return true;
  }

  private complete(opcode: number, params: ArrayLike<number> = [HCI_ERR.SUCCESS]): void {
    this.event(EV.COMMAND_COMPLETE, [1, opcode & 0xff, opcode >> 8, ...Array.from(params)]);
  }

  private status(opcode: number, status: number): void {
    this.event(EV.COMMAND_STATUS, [status, 1, opcode & 0xff, opcode >> 8]);
  }

  // ------------------------------------------------------------- from the host

  /** An H4-framed packet from the host. */
  fromHost(packet: Uint8Array): void {
    if (packet[0] === H4.COMMAND) this.command(packet.subarray(1));
    else if (packet[0] === H4.ACL) this.aclOut(packet.subarray(1));
  }

  private command(p: Uint8Array): void {
    if (p.length < 3) return;
    const opcode = p[0] | (p[1] << 8);
    const param = p.subarray(3, 3 + p[2]);
    const u16 = (k: number) => param[k] | (param[k + 1] << 8);
    const le16 = (v: number) => [v & 0xff, (v >> 8) & 0xff];
    switch (opcode) {
      case OP.RESET:
        this.resetState();
        this.complete(opcode);
        return;
      case OP.SET_EVENT_MASK:
        this.eventMask.set(param.subarray(0, 8));
        this.complete(opcode);
        return;
      case OP.LE_SET_EVENT_MASK:
        this.leEventMask.set(param.subarray(0, 8));
        this.complete(opcode);
        return;
      case OP.READ_LOCAL_VERSION:
        // HCI 5.0, Espressif as the manufacturer is not claimed: 0xFFFF is "for testing".
        this.complete(opcode, [0, 9, ...le16(0), 9, ...le16(0xffff), ...le16(0)]);
        return;
      case OP.READ_LOCAL_COMMANDS:
        this.complete(opcode, [0, ...supportedCommands()]);
        return;
      case OP.READ_LOCAL_FEATURES:
        this.complete(opcode, [0, ...LMP_FEATURES]);
        return;
      case OP.READ_LOCAL_EXT_FEATURES: {
        // Page 0 is the LMP features; page 1 the host's, as Write LE Host Support and Simple Pairing set them.
        const page = param[0] ?? 0;
        const features = page === 0 ? LMP_FEATURES : page === 1 ? [(this.sspHost ? 1 : 0) | (this.leHost ? 2 : 0), 0, 0, 0, 0, 0, 0, 0] : new Array(8).fill(0);
        this.complete(opcode, [0, page, 1, ...features]);
        return;
      }
      case OP.WRITE_LE_HOST_SUPPORT:
        this.leHost = param[0] === 1;
        this.complete(opcode);
        return;
      case OP.WRITE_SIMPLE_PAIRING_MODE:
        this.sspHost = param[0] === 1;
        this.complete(opcode);
        return;
      case OP.READ_BUFFER_SIZE:
        this.complete(opcode, [0, ...le16(ACL_LENGTH), 0, ...le16(ACL_BUFFERS), ...le16(0)]);
        return;
      case OP.LE_READ_BUFFER_SIZE:
        this.complete(opcode, [0, ...le16(ACL_LENGTH), ACL_BUFFERS]);
        return;
      case OP.READ_BD_ADDR:
        this.complete(opcode, [0, ...this.address]);
        return;
      case OP.READ_LOCAL_NAME:
        this.complete(opcode, [0, ...new Uint8Array(248)]);
        return;
      case OP.READ_LE_HOST_SUPPORT:
        this.complete(opcode, [0, this.leHost ? 1 : 0, 0]);
        return;
      case OP.LE_READ_LOCAL_FEATURES:
        // LE features: data packet length extension only.
        this.complete(opcode, [0, 0x20, 0, 0, 0, 0, 0, 0, 0]);
        return;
      case OP.LE_READ_SUPPORTED_STATES:
        this.complete(opcode, [0, 0xff, 0xff, 0xff, 0xff, 0xff, 0x03, 0, 0]);
        return;
      case OP.LE_READ_ACCEPT_LIST_SIZE:
        this.complete(opcode, [0, 8]);
        return;
      case OP.LE_READ_RESOLVING_LIST_SIZE:
        this.complete(opcode, [0, 0]);
        return;
      case OP.LE_READ_ADV_TX_POWER:
        this.complete(opcode, [0, 0]);
        return;
      case OP.LE_READ_TX_POWER:
        this.complete(opcode, [0, 0xec, 0x14]); // -20 to +20 dBm
        return;
      case OP.LE_READ_MAX_DATA_LENGTH:
        this.complete(opcode, [0, ...le16(251), ...le16(2120), ...le16(251), ...le16(2120)]);
        return;
      case OP.LE_READ_SUGGESTED_DATA_LENGTH:
        this.complete(opcode, [0, ...le16(27), ...le16(328)]);
        return;
      case OP.LE_RAND: {
        const r = new Uint8Array(8);
        for (let i = 0; i < 8; i++) r[i] = (Math.random() * 256) | 0;
        this.complete(opcode, [0, ...r]);
        return;
      }
      case OP.LE_SET_RANDOM_ADDRESS:
        this.randomAddress = Uint8Array.from(param.subarray(0, 6));
        this.complete(opcode);
        return;
      case OP.LE_SET_ADV_PARAMS:
        if (this.adv.enabled) return this.complete(opcode, [HCI_ERR.COMMAND_DISALLOWED]);
        this.adv.type = param[4] ?? ADV_IND;
        this.adv.ownAddressType = param[5] ?? 0;
        this.complete(opcode);
        return;
      case OP.LE_SET_ADV_DATA:
        this.adv.data = Uint8Array.from(param.subarray(1, 1 + Math.min(31, param[0] ?? 0)));
        this.complete(opcode);
        this.air.changed();
        return;
      case OP.LE_SET_SCAN_RSP_DATA:
        this.adv.scanResponse = Uint8Array.from(param.subarray(1, 1 + Math.min(31, param[0] ?? 0)));
        this.complete(opcode);
        return;
      case OP.LE_SET_ADV_ENABLE:
        this.adv.enabled = param[0] === 1;
        this.complete(opcode);
        this.air.changed();
        return;
      case OP.LE_SET_SCAN_PARAMS:
        if (this.scan.enabled) return this.complete(opcode, [HCI_ERR.COMMAND_DISALLOWED]);
        this.scan.active = param[0] === 1;
        this.scan.ownAddressType = param[5] ?? 0;
        this.complete(opcode);
        return;
      case OP.LE_SET_SCAN_ENABLE:
        this.scan.enabled = param[0] === 1;
        this.scan.filterDuplicates = param[1] === 1;
        this.scan.seen.clear();
        this.scan.next = this.clock() + SCAN_REPORT_INTERVAL_NS / 10;
        this.complete(opcode);
        return;
      case OP.LE_CREATE_CONNECTION: {
        if (this.initiating) return this.status(opcode, HCI_ERR.COMMAND_DISALLOWED);
        // scan interval, window, filter policy, peer address type, peer address, own address type, interval min, max, ...
        this.initiating = {
          addressType: param[5],
          address: Uint8Array.from(param.subarray(6, 12)),
          interval: u16(13) || 24,
          at: this.clock() + CONNECT_NS,
        };
        this.status(opcode, HCI_ERR.SUCCESS);
        return;
      }
      case OP.LE_CREATE_CONNECTION_CANCEL:
        if (!this.initiating) return this.complete(opcode, [HCI_ERR.COMMAND_DISALLOWED]);
        this.initiating = null;
        this.complete(opcode);
        // The connection attempt ends with LE Connection Complete, status "unknown connection identifier".
        this.connectionComplete(0x02, 0, 0, new Uint8Array(6), 0, 0);
        return;
      case OP.DISCONNECT: {
        const handle = u16(0) & 0x0fff;
        const c = this.connections.get(handle);
        if (!c) return this.status(opcode, HCI_ERR.UNKNOWN_CONNECTION);
        this.status(opcode, HCI_ERR.SUCCESS);
        this.air.drop(c.linkId, HCI_ERR.LOCAL_HOST_TERMINATED, this);
        return;
      }
      case OP.READ_REMOTE_VERSION: {
        const handle = u16(0) & 0x0fff;
        if (!this.connections.has(handle)) return this.status(opcode, HCI_ERR.UNKNOWN_CONNECTION);
        this.status(opcode, HCI_ERR.SUCCESS);
        this.event(EV.READ_REMOTE_VERSION_COMPLETE, [0, ...le16(handle), 9, ...le16(0xffff), ...le16(0)], PROCEDURE_NS);
        return;
      }
      case OP.LE_READ_REMOTE_FEATURES: {
        const handle = u16(0) & 0x0fff;
        if (!this.connections.has(handle)) return this.status(opcode, HCI_ERR.UNKNOWN_CONNECTION);
        this.status(opcode, HCI_ERR.SUCCESS);
        this.leEvent(LE_SUB.READ_REMOTE_FEATURES_COMPLETE, [0, ...le16(handle), 0x20, 0, 0, 0, 0, 0, 0, 0], PROCEDURE_NS);
        return;
      }
      case OP.LE_CONNECTION_UPDATE: {
        const handle = u16(0) & 0x0fff;
        const c = this.connections.get(handle);
        if (!c) return this.status(opcode, HCI_ERR.UNKNOWN_CONNECTION);
        this.status(opcode, HCI_ERR.SUCCESS);
        const interval = u16(4) || u16(2);
        this.air.update(c.linkId, interval, u16(6), u16(8) || DEFAULT_SUPERVISION);
        return;
      }
      case OP.LE_SET_DATA_LENGTH: {
        const handle = u16(0) & 0x0fff;
        if (!this.connections.has(handle)) return this.complete(opcode, [HCI_ERR.UNKNOWN_CONNECTION, ...le16(handle)]);
        this.complete(opcode, [0, ...le16(handle)]);
        const tx = Math.min(251, u16(2) || 27);
        this.leEvent(LE_SUB.DATA_LENGTH_CHANGE, [...le16(handle), ...le16(tx), ...le16(2120), ...le16(tx), ...le16(2120)], PROCEDURE_NS);
        return;
      }
      case OP.LE_READ_PHY: {
        const handle = u16(0) & 0x0fff;
        this.complete(opcode, [this.connections.has(handle) ? 0 : HCI_ERR.UNKNOWN_CONNECTION, ...le16(handle), 1, 1]);
        return;
      }
      case OP.LE_SET_PHY: {
        const handle = u16(0) & 0x0fff;
        if (!this.connections.has(handle)) return this.status(opcode, HCI_ERR.UNKNOWN_CONNECTION);
        this.status(opcode, HCI_ERR.SUCCESS);
        // The 1M PHY is the only one, so the "update" keeps it.
        this.leEvent(LE_SUB.PHY_UPDATE_COMPLETE, [0, ...le16(handle), 1, 1], PROCEDURE_NS);
        return;
      }
      case OP.READ_RSSI: {
        const handle = u16(0) & 0x0fff;
        this.complete(opcode, [this.connections.has(handle) ? 0 : HCI_ERR.UNKNOWN_CONNECTION, ...le16(handle), SIMULATED_BLE_RSSI & 0xff]);
        return;
      }
      case OP.READ_TX_POWER:
        this.complete(opcode, [0, ...le16(u16(0)), 0]);
        return;
      case OP.READ_AUTH_PAYLOAD_TIMEOUT:
        this.complete(opcode, [0, ...le16(u16(0)), ...le16(3000)]);
        return;
      case OP.LE_READ_CHANNEL_MAP:
        this.complete(opcode, [0, ...le16(u16(0)), 0xff, 0xff, 0xff, 0xff, 0x1f]);
        return;
      case OP.VS_0001: {
        if (param.length >= 6) {
          this.address = Uint8Array.from(param.subarray(0, 6));
          this.complete(opcode);
          this.air.changed();
          return;
        }
        // A static random address is the public one with its top two bits set.
        const a = Uint8Array.from(this.address);
        a[5] |= 0xc0;
        this.complete(opcode, [0, ...a]);
        return;
      }
      case OP.LE_ENCRYPT:
      case OP.LE_START_ENCRYPTION:
      case OP.LE_LTK_REPLY:
      case OP.LE_LTK_NEG_REPLY:
      case OP.LE_READ_P256_PUBLIC_KEY:
      case OP.LE_GENERATE_DHKEY:
        // Encryption is not modelled; the host learns it plainly.
        if (opcode === OP.LE_ENCRYPT || opcode === OP.LE_LTK_REPLY || opcode === OP.LE_LTK_NEG_REPLY) this.complete(opcode, [HCI_ERR.UNSUPPORTED_FEATURE]);
        else this.status(opcode, HCI_ERR.UNSUPPORTED_FEATURE);
        return;
    }
    // Everything else configures something not modelled (BR/EDR settings,
    // accept lists, vendor commands): accepted.
    this.complete(opcode);
  }

  private aclOut(p: Uint8Array): void {
    if (p.length < 4) return;
    const handle = (p[0] | (p[1] << 8)) & 0x0fff;
    const pb = (p[1] >> 4) & 3;
    const len = p[2] | (p[3] << 8);
    const c = this.connections.get(handle);
    if (!c) return;
    this.air.send(c.linkId, this, pb, p.slice(4, 4 + len));
    // The buffer is free again once the packet is on the air.
    this.event(EV.NUMBER_OF_COMPLETED_PACKETS, [1, handle & 0xff, handle >> 8, 1, 0]);
  }

  // ------------------------------------------------------------- the air

  private resetState(): void {
    for (const c of [...this.connections.values()]) this.air.drop(c.linkId, HCI_ERR.LOCAL_HOST_TERMINATED, this);
    this.queue = [];
    // The spec's default (0x00001FFFFFFFFFFF): LE Meta is off until the host enables it.
    this.eventMask = new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0x1f, 0, 0]);
    this.leEventMask = new Uint8Array([0x1f, 0, 0, 0, 0, 0, 0, 0]);
    this.adv = { type: ADV_IND, ownAddressType: 0, data: new Uint8Array(0), scanResponse: new Uint8Array(0), enabled: false };
    this.scan = { active: false, ownAddressType: 0, enabled: false, filterDuplicates: false, seen: new Set(), next: 0 };
    this.initiating = null;
    this.leHost = false;
    this.sspHost = false;
    this.air.changed();
  }

  /** Power-on: what a reset of the whole board leaves. */
  powerOn(): void {
    this.resetState();
    this.nextHandle = 1;
  }

  /** Scanning reports and connection attempts that have come due. */
  private poll(): void {
    const now = this.clock();
    if (this.initiating && this.initiating.at <= now) {
      const target = this.air.findAdvertiser(this.initiating.address);
      const adv = target?.advertisement;
      if (target && adv && (adv.pduType === ADV_IND || adv.pduType === ADV_DIRECT_IND)) {
        const interval = this.initiating.interval;
        this.initiating = null;
        this.air.connect(this, target, interval);
      } else {
        // Nobody to connect to yet: keep listening, as an initiator does until cancelled.
        this.initiating.at = now + SCAN_REPORT_INTERVAL_NS;
      }
    }
    if (this.scan.enabled && this.scan.next <= now) {
      this.scan.next = now + SCAN_REPORT_INTERVAL_NS;
      for (const { adv } of this.air.advertisers(this)) {
        const key = addressString(adv.address);
        if (this.scan.filterDuplicates && this.scan.seen.has(key)) continue;
        this.scan.seen.add(key);
        this.report(adv.pduType, adv, adv.data);
        if (this.scan.active && adv.pduType !== ADV_NONCONN_IND && adv.pduType !== ADV_DIRECT_IND) {
          this.report(REPORT_SCAN_RSP, adv, adv.scanResponse);
        }
      }
    }
  }

  private report(type: number, adv: Advertisement, data: Uint8Array): void {
    this.leEvent(LE_SUB.ADVERTISING_REPORT, [1, type, adv.addressType, ...adv.address, data.length, ...data, SIMULATED_BLE_RSSI & 0xff]);
  }

  allocateHandle(linkId: number): number {
    const handle = this.nextHandle;
    this.nextHandle = (this.nextHandle % 0x0eff) + 1;
    this.connections.set(handle, { linkId, role: 0, peer: this, interval: 0 });
    return handle;
  }

  stopAdvertisingForConnection(): void {
    this.adv.enabled = false;
  }

  private connectionComplete(status: number, handle: number, role: number, peer: Uint8Array, peerType: number, interval: number): void {
    const le16 = (v: number) => [v & 0xff, (v >> 8) & 0xff];
    const tail = [...le16(interval), ...le16(0), ...le16(DEFAULT_SUPERVISION), 0];
    // A host that enabled the enhanced event (for privacy) gets that one instead.
    const enhanced = (this.leEventMask[1] >> 1) & 1;
    if (enhanced && this.leEvent(LE_SUB.ENHANCED_CONNECTION_COMPLETE, [status, ...le16(handle), role, peerType, ...peer, ...new Uint8Array(12), ...tail])) return;
    this.leEvent(LE_SUB.CONNECTION_COMPLETE, [status, ...le16(handle), role, peerType, ...peer, ...tail]);
  }

  linkUp(handle: number, role: number, peer: BleLinkEnd, interval: number): void {
    const c = this.connections.get(handle);
    if (c) {
      c.role = role;
      c.peer = peer;
      c.interval = interval;
    }
    this.connectionComplete(0, handle, role, peer.address, peer.addressType, interval);
    this.air.changed();
  }

  aclIn(handle: number, pb: number, data: Uint8Array): void {
    if (!this.connections.has(handle)) return;
    // From the controller to the host, a first fragment is "automatically flushable".
    const flags = pb === 0 ? 2 : pb;
    const p = new Uint8Array(5 + data.length);
    p[0] = H4.ACL;
    p[1] = handle & 0xff;
    p[2] = ((handle >> 8) & 0x0f) | (flags << 4);
    p[3] = data.length & 0xff;
    p[4] = data.length >> 8;
    p.set(data, 5);
    this.push(p);
  }

  linkDown(handle: number, reason: number): void {
    if (!this.connections.delete(handle)) return;
    this.event(EV.DISCONNECTION_COMPLETE, [0, handle & 0xff, handle >> 8, reason]);
  }

  linkUpdated(handle: number, interval: number, latency: number, timeout: number): void {
    const c = this.connections.get(handle);
    if (!c) return;
    c.interval = interval;
    const le16 = (v: number) => [v & 0xff, (v >> 8) & 0xff];
    this.leEvent(LE_SUB.CONNECTION_UPDATE_COMPLETE, [0, ...le16(handle), ...le16(interval), ...le16(latency), ...le16(timeout)], PROCEDURE_NS);
  }

  get connectionCount(): number {
    return this.connections.size;
  }
}

/**
 * Read Local Supported Commands: the commands above, as the bitmap of Core
 * spec Vol 4 Part E 6.27 (octet, bit) lays them out.
 */
function supportedCommands(): number[] {
  const bits: [number, number][] = [
    [0, 5], // Disconnect
    [2, 7], // Read Remote Version Information
    [5, 6], [5, 7], // Set Event Mask, Reset
    [10, 2], // Read Transmit Power Level
    [14, 3], [14, 5], [14, 6], [14, 7], // Read Local Version, Supported Features, Extended Features, Buffer Size
    [15, 1], [15, 5], // Read BD_ADDR, Read RSSI
    [24, 5], [24, 6], // Read/Write LE Host Support
    [25, 0], [25, 1], [25, 2], [25, 4], [25, 5], [25, 6], [25, 7], // LE Set Event Mask .. LE Set Advertising Data
    [26, 0], [26, 1], [26, 2], [26, 3], [26, 4], [26, 5], [26, 6], [26, 7], // scan response .. clear accept list
    [27, 0], [27, 1], [27, 2], [27, 3], [27, 4], [27, 5], [27, 7], // accept list .. read remote features, LE Rand (not Encrypt)
    [28, 3], // LE Read Supported States
    [33, 6], [33, 7], [34, 0], // LE Set Data Length, Read/Write Suggested Default Data Length
    [35, 3], [35, 4], [35, 5], [35, 6], // LE Read Maximum Data Length, Read PHY, Set Default PHY, Set PHY
  ];
  const out = new Array(64).fill(0);
  for (const [octet, bit] of bits) out[octet] |= 1 << bit;
  return out;
}
