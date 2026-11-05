// Ethernet, ARP, IPv4, UDP and ICMP framing for the simulated Wi-Fi network.
//
// The boards' own TCP/IP stacks (lwIP, compiled into the firmware) build and
// parse the real thing; what lives here is only what the simulated access
// point needs to answer them — and, for the workbench's own client, to speak
// to them. Byte orders and checksums are RFC 791/768/792/826's.

export const ETH_IPV4 = 0x0800;
export const ETH_ARP = 0x0806;
export const IP_ICMP = 1;
export const IP_TCP = 6;
export const IP_UDP = 17;
export const BROADCAST_MAC = new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);

export function macString(mac: ArrayLike<number>): string {
  return Array.from(mac, (b) => b.toString(16).padStart(2, '0')).join(':');
}

export function ipString(ip: number): string {
  return [ip >>> 24, (ip >>> 16) & 0xff, (ip >>> 8) & 0xff, ip & 0xff].join('.');
}

export function sameMac(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  for (let i = 0; i < 6; i++) if (a[i] !== b[i]) return false;
  return true;
}

export const u16 = (b: Uint8Array, o: number) => (b[o] << 8) | b[o + 1];
export const u32 = (b: Uint8Array, o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
export function put16(b: Uint8Array, o: number, v: number): void {
  b[o] = (v >>> 8) & 0xff;
  b[o + 1] = v & 0xff;
}
export function put32(b: Uint8Array, o: number, v: number): void {
  b[o] = v >>> 24;
  b[o + 1] = (v >>> 16) & 0xff;
  b[o + 2] = (v >>> 8) & 0xff;
  b[o + 3] = v & 0xff;
}

/** The Internet checksum (RFC 1071) of a span, with an initial partial sum. */
export function checksum(b: Uint8Array, o: number, len: number, initial = 0): number {
  let sum = initial;
  for (let i = 0; i + 1 < len; i += 2) sum += (b[o + i] << 8) | b[o + i + 1];
  if (len & 1) sum += b[o + len - 1] << 8;
  while (sum > 0xffff) sum = (sum & 0xffff) + (sum >>> 16);
  return ~sum & 0xffff;
}

export interface Ipv4Packet {
  src: number;
  dst: number;
  protocol: number;
  ttl: number;
  payload: Uint8Array;
}

export interface EthernetFrame {
  dst: Uint8Array;
  src: Uint8Array;
  type: number;
  payload: Uint8Array;
}

export function parseEthernet(frame: Uint8Array): EthernetFrame | undefined {
  if (frame.length < 14) return undefined;
  return { dst: frame.subarray(0, 6), src: frame.subarray(6, 12), type: u16(frame, 12), payload: frame.subarray(14) };
}

export function ethernet(dst: ArrayLike<number>, src: ArrayLike<number>, type: number, payload: Uint8Array): Uint8Array {
  const f = new Uint8Array(14 + payload.length);
  f.set(dst, 0);
  f.set(src, 6);
  put16(f, 12, type);
  f.set(payload, 14);
  return f;
}

export function parseIpv4(p: Uint8Array): Ipv4Packet | undefined {
  if (p.length < 20 || p[0] >> 4 !== 4) return undefined;
  const ihl = (p[0] & 0xf) * 4;
  const total = u16(p, 2);
  if (ihl < 20 || total < ihl || total > p.length) return undefined;
  // Fragments are not reassembled: nothing on this network sends any.
  if ((u16(p, 6) & 0x3fff) !== 0) return undefined;
  return { src: u32(p, 12), dst: u32(p, 16), protocol: p[9], ttl: p[8], payload: p.subarray(ihl, total) };
}

let ipId = 1;
export function ipv4(src: number, dst: number, protocol: number, payload: Uint8Array, ttl = 64): Uint8Array {
  const p = new Uint8Array(20 + payload.length);
  p[0] = 0x45;
  put16(p, 2, p.length);
  put16(p, 4, ipId++ & 0xffff);
  p[8] = ttl;
  p[9] = protocol;
  put32(p, 12, src);
  put32(p, 16, dst);
  put16(p, 10, checksum(p, 0, 20));
  p.set(payload, 20);
  return p;
}

/** The pseudo-header sum TCP and UDP checksums start from. */
export function pseudoSum(src: number, dst: number, protocol: number, length: number): number {
  return (src >>> 16) + (src & 0xffff) + (dst >>> 16) + (dst & 0xffff) + protocol + length;
}

export function udp(src: number, dst: number, srcPort: number, dstPort: number, data: Uint8Array): Uint8Array {
  const u = new Uint8Array(8 + data.length);
  put16(u, 0, srcPort);
  put16(u, 2, dstPort);
  put16(u, 4, u.length);
  u.set(data, 8);
  const c = checksum(u, 0, u.length, pseudoSum(src, dst, IP_UDP, u.length));
  put16(u, 6, c === 0 ? 0xffff : c);
  return ipv4(src, dst, IP_UDP, u);
}

export function parseIp(text: string): number | undefined {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text.trim());
  if (!m) return undefined;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return undefined;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}
