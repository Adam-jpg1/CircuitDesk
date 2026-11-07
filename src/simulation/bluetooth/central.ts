// The workbench as a Bluetooth LE central: what a phone running a BLE
// explorer would be, beside the boards on the canvas.
//
// It joins the air as a link end of its own (an address on the air, no board
// behind it) and carries just enough of a host to be useful: L2CAP's fixed
// channels with reassembly, and a GATT client — MTU exchange, primary service
// and characteristic discovery, descriptor discovery to find each
// characteristic's Client Characteristic Configuration, reads, writes, and
// notifications and indications. A board's host on the other end is the real
// one (Bluedroid, NimBLE, BTstack), so what the workbench sees is what the
// sketch's GATT server publishes.
//
// What it declines, plainly: pairing (it answers SMP with "pairing not
// supported", as encryption is not modelled), and any ATT request the board's
// host sends it beyond an MTU exchange (it has no GATT server of its own).

import { type BleAir, type BleController, type BleLinkEnd, addressString, advertisedName } from './controller';

const CID_ATT = 0x0004;
const CID_SIGNALING = 0x0005;
const CID_SMP = 0x0006;

const ATT = {
  ERROR_RSP: 0x01, MTU_REQ: 0x02, MTU_RSP: 0x03, FIND_INFO_REQ: 0x04, FIND_INFO_RSP: 0x05,
  READ_BY_TYPE_REQ: 0x08, READ_BY_TYPE_RSP: 0x09, READ_REQ: 0x0a, READ_RSP: 0x0b,
  READ_BY_GROUP_REQ: 0x10, READ_BY_GROUP_RSP: 0x11, WRITE_REQ: 0x12, WRITE_RSP: 0x13,
  NOTIFY: 0x1b, INDICATE: 0x1d, CONFIRM: 0x1e, WRITE_CMD: 0x52,
} as const;
const ATT_ERR_ATTRIBUTE_NOT_FOUND = 0x0a;
const ATT_ERR_REQUEST_NOT_SUPPORTED = 0x06;
const SMP_PAIRING_FAILED = 0x05;
const SMP_PAIRING_NOT_SUPPORTED = 0x05;
const MTU = 247;

export interface GattCharacteristic {
  uuid: string;
  /** The declaration's handle, the value's, and the CCCD's if it has one. */
  declarationHandle: number;
  valueHandle: number;
  cccdHandle?: number;
  properties: { read: boolean; write: boolean; writeWithoutResponse: boolean; notify: boolean; indicate: boolean };
}

export interface GattService {
  uuid: string;
  start: number;
  end: number;
  characteristics: GattCharacteristic[];
}

export interface ScanEntry {
  address: string;
  label: string;
  name?: string;
  connectable: boolean;
  /** Service UUIDs the advertising data lists. */
  services: string[];
}

export class AttError extends Error {
  constructor(readonly opcode: number, readonly handle: number, readonly code: number) {
    super(`The board's GATT server refused (ATT error 0x${code.toString(16).padStart(2, '0')} at handle 0x${handle.toString(16)}).`);
  }
}

/** A 16-bit UUID as four hex digits; a 128-bit one in its canonical form (both from little-endian bytes). */
export function uuidString(bytes: Uint8Array): string {
  const hex = [...bytes].reverse().map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  if (hex.length !== 32) return hex;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The service UUIDs listed in advertising data (types 0x02-0x07). */
export function advertisedServices(data: Uint8Array): string[] {
  const out: string[] = [];
  for (let i = 0; i + 1 < data.length; ) {
    const len = data[i];
    if (len === 0) break;
    const type = data[i + 1];
    const body = data.subarray(i + 2, i + 1 + len);
    const size = type === 0x02 || type === 0x03 ? 2 : type === 0x04 || type === 0x05 ? 4 : type === 0x06 || type === 0x07 ? 16 : 0;
    for (let k = 0; size && k + size <= body.length; k += size) out.push(uuidString(body.subarray(k, k + size)));
    i += len + 1;
  }
  return out;
}

interface Pending {
  opcodes: number[];
  resolve: (pdu: Uint8Array) => void;
  reject: (e: Error) => void;
}

export class BleCentral implements BleLinkEnd {
  readonly label = 'Workbench';
  /** A static random address (top two bits set), least significant byte first. */
  readonly address = Uint8Array.from([0x57, 0x4b, 0x42, 0x43, 0x44, 0xc5]);
  readonly addressType = 1;
  private linkId = 0;
  private handle = 0;
  private peer: BleLinkEnd | null = null;
  private rx: { expected: number; parts: Uint8Array[]; got: number } | null = null;
  private pending: Pending | null = null;
  private queue: (() => void)[] = [];
  private mtu = 23;
  private connectWaiters: ((ok: boolean) => void)[] = [];
  /** A notification or indication from the board: the value handle and the bytes. */
  onNotify: ((valueHandle: number, value: Uint8Array) => void) | null = null;
  onDisconnect: ((reason: number) => void) | null = null;

  constructor(readonly air: BleAir) {
    air.addEnd(this);
  }

  get connected(): boolean {
    return this.peer !== null;
  }

  get peerLabel(): string | undefined {
    return this.peer?.label;
  }

  /** Every advertiser on the air, as a scan would list it. */
  scan(): ScanEntry[] {
    return this.air.advertisers().map(({ controller, adv }) => ({
      address: addressString(adv.address),
      label: controller.label,
      name: advertisedName(adv.data) ?? advertisedName(adv.scanResponse),
      connectable: adv.pduType === 0 || adv.pduType === 1,
      services: [...advertisedServices(adv.data), ...advertisedServices(adv.scanResponse)],
    }));
  }

  /** Connects to the advertiser at `address` ("AA:BB:..", as scan lists it). Resolves when the link is up. */
  connect(address: string): Promise<void> {
    if (this.peer) return Promise.reject(new Error('The workbench is already connected; disconnect first.'));
    const target = this.air.advertisers().find(({ adv }) => addressString(adv.address) === address)?.controller as BleController | undefined;
    if (!target) return Promise.reject(new Error(`Nothing is advertising at ${address}.`));
    const adv = target.advertisement;
    if (!adv || (adv.pduType !== 0 && adv.pduType !== 1)) return Promise.reject(new Error(`${target.label} is advertising, but does not accept connections.`));
    const up = new Promise<void>((resolve, reject) => this.connectWaiters.push((ok) => (ok ? resolve() : reject(new Error('The link went down.')))));
    this.linkId = this.air.connect(this, target, 24);
    return up;
  }

  disconnect(): void {
    if (this.linkId) this.air.drop(this.linkId, 0x16, this);
  }

  // ------------------------------------------------------------- link end

  linkUp(handle: number, _role: number, peer: BleLinkEnd): void {
    this.handle = handle;
    this.peer = peer;
    this.mtu = 23;
    for (const w of this.connectWaiters.splice(0)) w(true);
  }

  linkDown(_handle: number, reason: number): void {
    this.peer = null;
    this.linkId = 0;
    this.rx = null;
    this.pending?.reject(new Error('The board disconnected.'));
    this.pending = null;
    this.queue = [];
    for (const w of this.connectWaiters.splice(0)) w(false);
    this.onDisconnect?.(reason);
  }

  aclIn(_handle: number, pb: number, data: Uint8Array): void {
    if (pb === 2 || pb === 0) {
      if (data.length < 4) return;
      const expected = data[0] | (data[1] << 8);
      this.rx = { expected: expected + 4, parts: [data], got: data.length };
    } else if (this.rx) {
      this.rx.parts.push(data);
      this.rx.got += data.length;
    } else return;
    if (this.rx.got < this.rx.expected) return;
    const whole = new Uint8Array(this.rx.got);
    let at = 0;
    for (const p of this.rx.parts) {
      whole.set(p, at);
      at += p.length;
    }
    this.rx = null;
    const cid = whole[2] | (whole[3] << 8);
    const payload = whole.subarray(4, 4 + (whole[0] | (whole[1] << 8)));
    if (cid === CID_ATT) this.att(payload);
    else if (cid === CID_SIGNALING) this.signaling(payload);
    else if (cid === CID_SMP) this.smp(payload);
  }

  private l2cap(cid: number, payload: ArrayLike<number>): void {
    if (!this.linkId) return;
    const p = new Uint8Array(4 + payload.length);
    p[0] = payload.length & 0xff;
    p[1] = payload.length >> 8;
    p[2] = cid & 0xff;
    p[3] = cid >> 8;
    p.set(Array.from(payload), 4);
    this.air.send(this.linkId, this, 0, p);
  }

  // ------------------------------------------------------------- ATT

  private att(pdu: Uint8Array): void {
    const opcode = pdu[0];
    if (opcode === ATT.NOTIFY || opcode === ATT.INDICATE) {
      const handle = pdu[1] | (pdu[2] << 8);
      if (opcode === ATT.INDICATE) this.l2cap(CID_ATT, [ATT.CONFIRM]);
      this.onNotify?.(handle, pdu.slice(3));
      return;
    }
    if (opcode === ATT.MTU_REQ) {
      const theirs = pdu[1] | (pdu[2] << 8);
      this.mtu = Math.max(23, Math.min(MTU, theirs));
      this.l2cap(CID_ATT, [ATT.MTU_RSP, MTU & 0xff, MTU >> 8]);
      return;
    }
    const p = this.pending;
    if (p && (p.opcodes.includes(opcode) || opcode === ATT.ERROR_RSP)) {
      this.pending = null;
      if (opcode === ATT.ERROR_RSP) p.reject(new AttError(pdu[1], pdu[2] | (pdu[3] << 8), pdu[4]));
      else p.resolve(pdu);
      this.queue.shift()?.();
      return;
    }
    // A request of the board's own (it would be reading the workbench's GATT server): there is none.
    if (opcode !== ATT.CONFIRM && opcode < 0x1b && opcode % 2 === 0) {
      this.l2cap(CID_ATT, [ATT.ERROR_RSP, opcode, pdu[1] ?? 0, pdu[2] ?? 0, opcode === ATT.READ_BY_GROUP_REQ || opcode === ATT.READ_BY_TYPE_REQ || opcode === ATT.FIND_INFO_REQ ? ATT_ERR_ATTRIBUTE_NOT_FOUND : ATT_ERR_REQUEST_NOT_SUPPORTED]);
    }
  }

  /** Sends a request and waits for its response; ATT allows one outstanding at a time, so the rest queue. */
  private request(pdu: ArrayLike<number>, response: number): Promise<Uint8Array> {
    if (!this.linkId) return Promise.reject(new Error('Not connected.'));
    return new Promise((resolve, reject) => {
      const go = () => {
        this.pending = { opcodes: [response], resolve, reject };
        this.l2cap(CID_ATT, pdu);
      };
      if (this.pending) this.queue.push(go);
      else go();
    });
  }

  async exchangeMtu(): Promise<number> {
    const r = await this.request([ATT.MTU_REQ, MTU & 0xff, MTU >> 8], ATT.MTU_RSP);
    this.mtu = Math.max(23, Math.min(MTU, r[1] | (r[2] << 8)));
    return this.mtu;
  }

  /** Every primary service and its characteristics, as the board's GATT server lists them. */
  async discover(): Promise<GattService[]> {
    const services: GattService[] = [];
    let start = 1;
    for (;;) {
      let r: Uint8Array;
      try {
        r = await this.request([ATT.READ_BY_GROUP_REQ, start & 0xff, start >> 8, 0xff, 0xff, 0x00, 0x28], ATT.READ_BY_GROUP_RSP);
      } catch (e) {
        if (e instanceof AttError && e.code === ATT_ERR_ATTRIBUTE_NOT_FOUND) break;
        throw e;
      }
      const size = r[1];
      let last = start;
      for (let k = 2; k + size <= r.length; k += size) {
        const s = r[k] | (r[k + 1] << 8);
        const e = r[k + 2] | (r[k + 3] << 8);
        services.push({ uuid: uuidString(r.subarray(k + 4, k + size)), start: s, end: e, characteristics: [] });
        last = e;
      }
      if (last >= 0xffff) break;
      start = last + 1;
    }
    for (const svc of services) svc.characteristics = await this.characteristics(svc);
    return services;
  }

  private async characteristics(svc: GattService): Promise<GattCharacteristic[]> {
    const out: GattCharacteristic[] = [];
    let start = svc.start;
    while (start <= svc.end) {
      let r: Uint8Array;
      try {
        r = await this.request([ATT.READ_BY_TYPE_REQ, start & 0xff, start >> 8, svc.end & 0xff, svc.end >> 8, 0x03, 0x28], ATT.READ_BY_TYPE_RSP);
      } catch (e) {
        if (e instanceof AttError && e.code === ATT_ERR_ATTRIBUTE_NOT_FOUND) break;
        throw e;
      }
      const size = r[1];
      let last = start;
      for (let k = 2; k + size <= r.length; k += size) {
        const decl = r[k] | (r[k + 1] << 8);
        const props = r[k + 2];
        const value = r[k + 3] | (r[k + 4] << 8);
        out.push({
          uuid: uuidString(r.subarray(k + 5, k + size)),
          declarationHandle: decl,
          valueHandle: value,
          properties: { read: !!(props & 0x02), writeWithoutResponse: !!(props & 0x04), write: !!(props & 0x08), notify: !!(props & 0x10), indicate: !!(props & 0x20) },
        });
        last = value;
      }
      start = last + 1;
    }
    // Each characteristic's descriptors lie between its value and the next declaration.
    for (let i = 0; i < out.length; i++) {
      const c = out[i];
      if (!c.properties.notify && !c.properties.indicate) continue;
      const end = i + 1 < out.length ? out[i + 1].declarationHandle - 1 : svc.end;
      for (let h = c.valueHandle + 1; h <= end; ) {
        let r: Uint8Array;
        try {
          r = await this.request([ATT.FIND_INFO_REQ, h & 0xff, h >> 8, end & 0xff, end >> 8], ATT.FIND_INFO_RSP);
        } catch (e) {
          if (e instanceof AttError && e.code === ATT_ERR_ATTRIBUTE_NOT_FOUND) break;
          throw e;
        }
        const size = r[1] === 1 ? 4 : 18;
        let last = h;
        for (let k = 2; k + size <= r.length; k += size) {
          const handle = r[k] | (r[k + 1] << 8);
          if (uuidString(r.subarray(k + 2, k + size)) === '2902') c.cccdHandle = handle;
          last = handle;
        }
        h = last + 1;
      }
    }
    return out;
  }

  async read(valueHandle: number): Promise<Uint8Array> {
    const r = await this.request([ATT.READ_REQ, valueHandle & 0xff, valueHandle >> 8], ATT.READ_RSP);
    return r.slice(1);
  }

  async write(valueHandle: number, value: ArrayLike<number>, withResponse = true): Promise<void> {
    const bytes = Array.from(value).slice(0, this.mtu - 3);
    if (!withResponse) {
      this.l2cap(CID_ATT, [ATT.WRITE_CMD, valueHandle & 0xff, valueHandle >> 8, ...bytes]);
      return;
    }
    await this.request([ATT.WRITE_REQ, valueHandle & 0xff, valueHandle >> 8, ...bytes], ATT.WRITE_RSP);
  }

  /** Turns notifications (or indications) on or off at the characteristic's CCCD. */
  async subscribe(c: GattCharacteristic, on = true): Promise<void> {
    if (c.cccdHandle === undefined) throw new Error(`Characteristic ${c.uuid} has no Client Characteristic Configuration to subscribe with.`);
    const value = on ? (c.properties.notify ? 1 : 2) : 0;
    await this.write(c.cccdHandle, [value, 0]);
  }

  // ------------------------------------------------------------- the other channels

  private signaling(p: Uint8Array): void {
    const code = p[0];
    const id = p[1];
    if (code === 0x12 && p.length >= 12) {
      // Connection Parameter Update Request: accepted, and applied as the central does.
      const min = p[4] | (p[5] << 8);
      const latency = p[8] | (p[9] << 8);
      const timeout = p[10] | (p[11] << 8);
      this.l2cap(CID_SIGNALING, [0x13, id, 2, 0, 0, 0]);
      if (this.linkId) this.air.update(this.linkId, min, latency, timeout);
      return;
    }
    if (code === 0x13 || code === 0x01) return; // responses and rejects
    // Anything else: Command Reject, "command not understood".
    this.l2cap(CID_SIGNALING, [0x01, id, 2, 0, 0, 0]);
  }

  private smp(p: Uint8Array): void {
    // A Pairing Request or Security Request: encryption is not modelled, so pairing is declined.
    if (p[0] === 0x01 || p[0] === 0x0b) this.l2cap(CID_SMP, [SMP_PAIRING_FAILED, SMP_PAIRING_NOT_SUPPORTED]);
  }
}

/** Waits for a promise while the simulation advances, as a request to a board must. */
export async function settle<T>(promise: Promise<T>, advance: (ms: number) => void | Promise<void>, timeoutMs = 5000): Promise<T> {
  let done = false;
  let value: T | undefined;
  let error: unknown;
  promise.then(
    (v) => {
      done = true;
      value = v;
    },
    (e) => {
      done = true;
      error = e;
    },
  );
  for (let t = 0; t < timeoutMs && !done; t += 10) {
    await advance(10);
    // Let resolved promises run their continuations before the next slice.
    await Promise.resolve();
  }
  if (!done) throw new Error('The board did not answer in time.');
  if (error) throw error;
  return value as T;
}
