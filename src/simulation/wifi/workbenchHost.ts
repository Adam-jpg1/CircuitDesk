// The workbench on the simulated Wi-Fi: a host with a fixed address on an
// access point (its subnet's .2), so the person at the bench can open a
// board's web page the way they would from a laptop on the same router.
//
// It is the client side of TCP (RFC 793) and HTTP/1.1, and only that: one
// request per connection, sent with "Connection: close"; segments arrive in
// order or not at all, because nothing on this network drops or reorders
// them, so there is no retransmission and no reassembly; a server that does
// not answer is reported as not answering after a timeout. ARP is answered for
// its own address and asked for the server's. It reaches only stations on the
// same simulated network — never the real one.

import {
  ETH_ARP, ETH_IPV4, IP_TCP, BROADCAST_MAC, checksum, ethernet, ipv4, parseEthernet, parseIpv4, pseudoSum, put16, put32,
  sameMac, u16, u32,
} from './packets';
import type { StationPort, WifiNetwork } from './network';

export interface HttpResult {
  status: number;
  statusText: string;
  headers: [string, string][];
  body: Uint8Array;
}

const SYN = 0x02;
const ACK = 0x10;
const PSH = 0x08;
const FIN = 0x01;
const RST = 0x04;
const MSS = 1460;
/** A response larger than this is cut off: a page, not a download. */
const MAX_BODY = 512 * 1024;

interface Connection {
  remoteIp: number;
  remoteMac?: Uint8Array;
  localPort: number;
  remotePort: number;
  sndNxt: number;
  rcvNxt: number;
  state: 'arp' | 'syn-sent' | 'established' | 'closing' | 'closed';
  request: Uint8Array;
  received: number[];
  resolve: (r: HttpResult) => void;
  reject: (e: Error) => void;
}

export class WorkbenchHost {
  readonly mac = new Uint8Array([0x02, 0xcd, 0x5e, 0xbe, 0x0c, 0x01]);
  readonly label = 'Workbench';
  private conn: Connection | null = null;
  private nextPort = 49152 + Math.floor(Math.random() * 10000);
  readonly port: StationPort;

  constructor(
    private readonly network: WifiNetwork,
    private readonly apId: string,
    readonly ip: number,
  ) {
    this.port = { mac: this.mac, label: this.label, deliver: (f) => this.receive(f) };
  }

  /** GET `path` from `ip`:`port`. Resolves when the server closes or the body is complete. */
  get(serverIp: number, path: string, hostHeader: string, port = 80): Promise<HttpResult> {
    if (this.conn && this.conn.state !== 'closed') return Promise.reject(new Error('A request is already in progress.'));
    if (!this.network.attachHost(this.apId, this.port)) return Promise.reject(new Error('That access point is not on the canvas.'));
    const request = new TextEncoder().encode(
      `GET ${path} HTTP/1.1\r\nHost: ${hostHeader}\r\nUser-Agent: CircuitDesk-Workbench\r\nAccept: */*\r\nConnection: close\r\n\r\n`,
    );
    return new Promise((resolve, reject) => {
      this.conn = {
        remoteIp: serverIp,
        localPort: this.nextPort++,
        remotePort: port,
        sndNxt: (Math.random() * 0xffffffff) >>> 0,
        rcvNxt: 0,
        state: 'arp',
        request,
        received: [],
        resolve,
        reject,
      };
      if (this.nextPort > 65000) this.nextPort = 49152;
      this.sendArpRequest(serverIp);
    });
  }

  /** Gives up on the request in flight. */
  abort(reason: string): void {
    const c = this.conn;
    if (!c || c.state === 'closed') return;
    c.state = 'closed';
    c.reject(new Error(reason));
  }

  private send(dst: Uint8Array, type: number, payload: Uint8Array): void {
    this.network.transmit(this.port, ethernet(dst, this.mac, type, payload));
  }

  private sendArpRequest(target: number): void {
    const p = new Uint8Array(28);
    put16(p, 0, 1);
    put16(p, 2, ETH_IPV4);
    p[4] = 6;
    p[5] = 4;
    put16(p, 6, 1);
    p.set(this.mac, 8);
    put32(p, 14, this.ip);
    put32(p, 24, target);
    this.send(BROADCAST_MAC, ETH_ARP, p);
  }

  private sendSegment(flags: number, data: Uint8Array = new Uint8Array(0)): void {
    const c = this.conn;
    if (!c?.remoteMac) return;
    const synOptions = flags & SYN ? 4 : 0;
    const t = new Uint8Array(20 + synOptions + data.length);
    put16(t, 0, c.localPort);
    put16(t, 2, c.remotePort);
    put32(t, 4, c.sndNxt);
    put32(t, 8, flags & ACK ? c.rcvNxt : 0);
    t[12] = ((20 + synOptions) / 4) << 4;
    t[13] = flags;
    put16(t, 14, 65535);
    if (synOptions) {
      t[20] = 2;
      t[21] = 4;
      put16(t, 22, MSS);
    }
    t.set(data, 20 + synOptions);
    put16(t, 16, checksum(t, 0, t.length, pseudoSum(this.ip, c.remoteIp, IP_TCP, t.length)));
    this.send(c.remoteMac, ETH_IPV4, ipv4(this.ip, c.remoteIp, IP_TCP, t));
    c.sndNxt = (c.sndNxt + data.length + (flags & (SYN | FIN) ? 1 : 0)) >>> 0;
  }

  private receive(frame: Uint8Array): void {
    const eth = parseEthernet(frame);
    if (!eth) return;
    if (eth.type === ETH_ARP) return this.arp(eth.payload);
    if (eth.type !== ETH_IPV4 || !sameMac(eth.dst, this.mac)) return;
    const ip = parseIpv4(eth.payload);
    if (!ip || ip.dst !== this.ip || ip.protocol !== IP_TCP) return;
    this.tcp(ip.src, ip.payload);
  }

  private arp(p: Uint8Array): void {
    if (p.length < 28) return;
    const op = u16(p, 6);
    const senderIp = u32(p, 14);
    const targetIp = u32(p, 24);
    if (op === 1 && targetIp === this.ip) {
      const r = new Uint8Array(28);
      r.set(p.subarray(0, 6));
      put16(r, 6, 2);
      r.set(this.mac, 8);
      put32(r, 14, this.ip);
      r.set(p.subarray(8, 14), 18);
      put32(r, 24, senderIp);
      this.send(p.subarray(8, 14), ETH_ARP, r);
      return;
    }
    const c = this.conn;
    if (op === 2 && c && c.state === 'arp' && senderIp === c.remoteIp) {
      c.remoteMac = p.slice(8, 14);
      c.state = 'syn-sent';
      this.sendSegment(SYN);
    }
  }

  private tcp(src: number, t: Uint8Array): void {
    const c = this.conn;
    if (!c || t.length < 20 || src !== c.remoteIp || u16(t, 0) !== c.remotePort || u16(t, 2) !== c.localPort) return;
    const flags = t[13];
    const seq = u32(t, 4);
    const offset = (t[12] >> 4) * 4;
    const data = t.subarray(offset);
    if (flags & RST) {
      c.state = 'closed';
      c.reject(new Error(c.received.length ? 'The board reset the connection.' : 'Connection refused: nothing on the board is listening on that port.'));
      return;
    }
    if (c.state === 'syn-sent') {
      if ((flags & (SYN | ACK)) !== (SYN | ACK)) return;
      c.rcvNxt = (seq + 1) >>> 0;
      c.state = 'established';
      this.sendSegment(ACK);
      for (let i = 0; i < c.request.length; i += MSS) this.sendSegment(ACK | PSH, c.request.subarray(i, i + MSS));
      return;
    }
    if (c.state !== 'established' && c.state !== 'closing') return;
    if (data.length > 0) {
      if (seq !== c.rcvNxt) {
        this.sendSegment(ACK);
        return;
      }
      if (c.received.length < MAX_BODY + 16384) for (const b of data) c.received.push(b);
      c.rcvNxt = (c.rcvNxt + data.length) >>> 0;
    }
    if (flags & FIN && ((seq + data.length) >>> 0) === c.rcvNxt) {
      c.rcvNxt = (c.rcvNxt + 1) >>> 0;
      this.sendSegment(ACK);
      if (c.state === 'established') this.sendSegment(FIN | ACK);
      this.finish();
      return;
    }
    if (data.length > 0) this.sendSegment(ACK);
    // A server that keeps the connection open still says how long its body is.
    const parsed = parseResponse(Uint8Array.from(c.received));
    if (parsed?.complete && c.state === 'established') {
      c.state = 'closing';
      this.sendSegment(FIN | ACK);
      this.finish();
    }
  }

  private finish(): void {
    const c = this.conn;
    if (!c || c.state === 'closed') return;
    c.state = 'closed';
    const parsed = parseResponse(Uint8Array.from(c.received));
    if (!parsed) c.reject(new Error('The board closed the connection without an HTTP response.'));
    else c.resolve(parsed.result);
  }
}

/** Parses an HTTP/1.x response: status line, headers, and the body as far as it goes. */
export function parseResponse(bytes: Uint8Array): { result: HttpResult; complete: boolean } | undefined {
  let end = -1;
  for (let i = 0; i + 3 < bytes.length; i++) {
    if (bytes[i] === 13 && bytes[i + 1] === 10 && bytes[i + 2] === 13 && bytes[i + 3] === 10) {
      end = i;
      break;
    }
  }
  if (end < 0) return undefined;
  const head = new TextDecoder().decode(bytes.subarray(0, end)).split('\r\n');
  const m = /^HTTP\/1\.[01] (\d{3}) ?(.*)$/.exec(head[0] ?? '');
  if (!m) return undefined;
  const headers: [string, string][] = [];
  for (const line of head.slice(1)) {
    const k = line.indexOf(':');
    if (k > 0) headers.push([line.slice(0, k).trim(), line.slice(k + 1).trim()]);
  }
  let body = bytes.subarray(end + 4);
  const length = headers.find(([k]) => k.toLowerCase() === 'content-length');
  const chunked = headers.some(([k, v]) => k.toLowerCase() === 'transfer-encoding' && /chunked/i.test(v));
  let complete = false;
  if (chunked) {
    const decoded = dechunk(body);
    complete = decoded.complete;
    body = decoded.body;
  } else if (length) {
    const n = Number(length[1]);
    complete = body.length >= n;
    body = body.subarray(0, n);
  }
  return {
    result: { status: Number(m[1]), statusText: m[2], headers, body: body.subarray(0, MAX_BODY) },
    complete,
  };
}

function dechunk(b: Uint8Array): { body: Uint8Array; complete: boolean } {
  const out: number[] = [];
  let i = 0;
  while (i < b.length) {
    let lineEnd = i;
    while (lineEnd + 1 < b.length && !(b[lineEnd] === 13 && b[lineEnd + 1] === 10)) lineEnd++;
    if (lineEnd + 1 >= b.length) break;
    const size = parseInt(new TextDecoder().decode(b.subarray(i, lineEnd)), 16);
    if (Number.isNaN(size)) break;
    if (size === 0) return { body: Uint8Array.from(out), complete: true };
    const start = lineEnd + 2;
    if (start + size > b.length) break;
    for (let k = start; k < start + size; k++) out.push(b[k]);
    i = start + size + 2;
  }
  return { body: Uint8Array.from(out), complete: false };
}

/**
 * Fetches http://<board>[:port]/path from a board on the network: by its
 * address or hostname. The workbench joins the board's access point as .2.
 * `advance` lets the simulation move on by about that many milliseconds — a
 * test steps it; the workbench, whose simulation runs on its own, waits — and
 * the request is given up after `timeoutMs` of them.
 */
export async function fetchFromBoard(
  network: WifiNetwork,
  url: string,
  advance: (ms: number) => void | Promise<void>,
  timeoutMs = 3000,
): Promise<HttpResult> {
  const m = /^(?:http:\/\/)?([^/:\s]+)(?::(\d{1,5}))?(\/[^\s]*)?$/i.exec(url.trim());
  if (!m) throw new Error('Enter an address like http://192.168.1.100/ or http://esp32-123456/.');
  if (/^https:/i.test(url.trim())) throw new Error('Only http:// is supported: the workbench does not speak TLS.');
  const [, host, portText, path = '/'] = m;
  const target = network.resolve(host);
  if (!target) throw new Error(`No board on the simulated network is called ${host}. Is it connected (see the list above)?`);
  const bench = new WorkbenchHost(network, target.apId, (target.subnet | 2) >>> 0);
  const pending = bench.get(target.ip, path, host, portText ? Number(portText) : 80);
  let settled = false;
  pending.then(() => (settled = true), () => (settled = true));
  for (let t = 0; t < timeoutMs && !settled; t += 10) {
    await advance(10);
    await Promise.resolve();
  }
  if (!settled) bench.abort(`${host} did not answer within ${timeoutMs / 1000} s of simulated time.`);
  return pending;
}
