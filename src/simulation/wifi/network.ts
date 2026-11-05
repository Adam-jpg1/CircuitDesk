// The simulated Wi-Fi network: the access points on the canvas and the
// boards that join them.
//
// A board's Wi-Fi driver model (./idfDriver for the ESP32 family) joins an
// access point by SSID and password, then hands this network the Ethernet
// frames its own lwIP sends and receives the ones addressed to it. The network
// is the access point's side of that: it switches frames between the stations
// associated with it, and it is the gateway every station's DHCP finds —
// answering ARP, DHCP, DNS (the hostnames boards gave in their DHCP requests)
// and ping for its own address.
//
// What it is not: a way out. Nothing here reaches the real internet; a name
// it does not know is NXDOMAIN, and a packet for an address that is not a
// station on the same access point goes nowhere. Each access point is its own
// subnet (192.168.1.0/24 for the first, 192.168.2.0/24 for the next, ...), and
// two access points do not route to each other.
//
// Not modelled: signal strength (every station hears its access point
// perfectly; scans report a fixed RSSI), channels contending, airtime, roaming,
// WPA handshakes (a password either matches or it does not), and 802.11 itself
// — frames cross as Ethernet, which is what both ends of the driver see.

import {
  BROADCAST_MAC, ETH_ARP, ETH_IPV4, IP_ICMP, IP_UDP, checksum, ethernet, ipString, ipv4, macString, parseEthernet, parseIpv4,
  put16, put32, sameMac, u16, u32, udp,
} from './packets';

export interface AccessPointConfig {
  /** The canvas part's instance id. */
  id: string;
  ssid: string;
  /** Empty for an open network. WPA2 otherwise; at least 8 characters, as real ones require. */
  password: string;
  channel: number;
}

export interface ScanResult {
  ssid: string;
  bssid: Uint8Array;
  channel: number;
  rssi: number;
  open: boolean;
}

/** A board's Wi-Fi interface, as the network sees it. */
export interface StationPort {
  readonly mac: Uint8Array;
  /** Who it is, for the workbench: the board instance's label. */
  readonly label: string;
  /** A frame for this station has arrived. */
  deliver(frame: Uint8Array): void;
}

export type JoinResult =
  | { ok: true; ap: ScanResult }
  | { ok: false; reason: 'no-ap' | 'auth' };

/** One station's state, for the workbench's network view. */
export interface StationView {
  label: string;
  mac: string;
  ssid: string;
  ip?: string;
  hostname?: string;
}

/** The fixed RSSI every scan reports: no geometry exists to compute a real one. */
export const SIMULATED_RSSI = -45;

interface Lease {
  ip: number;
  hostname?: string;
}

class SimAccessPoint {
  readonly stations = new Set<StationPort>();
  readonly leases = new Map<string, Lease>();
  readonly gateway: number;
  private nextHost = 100;

  constructor(
    readonly config: AccessPointConfig,
    readonly bssid: Uint8Array,
    readonly subnet: number,
    private readonly network: WifiNetwork,
  ) {
    this.gateway = (subnet | 1) >>> 0;
  }

  get open(): boolean {
    return this.config.password.length === 0;
  }

  /** A frame a station sent. */
  receive(from: StationPort, frame: Uint8Array): void {
    const eth = parseEthernet(frame);
    if (!eth) return;
    const broadcast = (eth.dst[0] & 1) === 1;
    if (broadcast || sameMac(eth.dst, this.bssid)) this.local(from, eth.type, eth.payload);
    for (const s of this.stations) {
      if (s === from) continue;
      if (broadcast || sameMac(eth.dst, s.mac)) s.deliver(frame.slice());
    }
  }

  private send(to: StationPort | undefined, dstMac: Uint8Array, type: number, payload: Uint8Array): void {
    const frame = ethernet(dstMac, this.bssid, type, payload);
    if (to) to.deliver(frame);
    else for (const s of this.stations) s.deliver(frame.slice());
  }

  private local(from: StationPort, type: number, payload: Uint8Array): void {
    if (type === ETH_ARP) this.arp(from, payload);
    else if (type === ETH_IPV4) {
      const ip = parseIpv4(payload);
      if (!ip) return;
      if (ip.protocol === IP_UDP && ip.payload.length >= 8) {
        const dstPort = u16(ip.payload, 2);
        const data = ip.payload.subarray(8, u16(ip.payload, 4));
        if (dstPort === 67) this.dhcp(from, data);
        else if (dstPort === 53 && ip.dst === this.gateway) this.dns(from, ip.src, u16(ip.payload, 0), data);
      } else if (ip.protocol === IP_ICMP && ip.dst === this.gateway && ip.payload[0] === 8) {
        const reply = ip.payload.slice();
        reply[0] = 0;
        put16(reply, 2, 0);
        put16(reply, 2, checksum(reply, 0, reply.length));
        this.send(from, from.mac, ETH_IPV4, ipv4(this.gateway, ip.src, IP_ICMP, reply));
      }
    }
  }

  private arp(from: StationPort, p: Uint8Array): void {
    if (p.length < 28 || u16(p, 6) !== 1) return;
    const targetIp = u32(p, 24);
    if (targetIp !== this.gateway) return;
    const r = new Uint8Array(28);
    put16(r, 0, 1);
    put16(r, 2, ETH_IPV4);
    r[4] = 6;
    r[5] = 4;
    put16(r, 6, 2);
    r.set(this.bssid, 8);
    put32(r, 14, this.gateway);
    r.set(p.subarray(8, 14), 18);
    r.set(p.subarray(14, 18), 24);
    this.send(from, from.mac, ETH_ARP, r);
  }

  /** A DHCP server (RFC 2131) handing out .100 upwards for a day. */
  private dhcp(from: StationPort, m: Uint8Array): void {
    if (m.length < 240 || m[0] !== 1 || u32(m, 236) !== 0x63825363) return;
    const options = new Map<number, Uint8Array>();
    for (let i = 240; i < m.length; ) {
      const code = m[i];
      if (code === 255) break;
      if (code === 0) {
        i++;
        continue;
      }
      const len = m[i + 1] ?? 0;
      options.set(code, m.subarray(i + 2, i + 2 + len));
      i += 2 + len;
    }
    const kind = options.get(53)?.[0];
    const key = macString(m.subarray(28, 34));
    const hostname = options.get(12) ? new TextDecoder().decode(options.get(12)) : undefined;
    let lease = this.leases.get(key);
    if (kind === 7) {
      this.leases.delete(key);
      this.network.changed();
      return;
    }
    if (!lease) {
      if (this.nextHost > 250) return;
      lease = { ip: (this.subnet | this.nextHost++) >>> 0 };
      this.leases.set(key, lease);
    }
    if (hostname) lease.hostname = hostname;
    let reply: number;
    if (kind === 1) reply = 2; // DISCOVER -> OFFER
    else if (kind === 3) {
      const requested = options.get(50);
      const asked = requested && requested.length === 4 ? u32(requested, 0) : u32(m, 12);
      reply = asked === 0 || asked === lease.ip ? 5 : 6; // ACK, or NAK for an address it was not given
    } else if (kind === 8) reply = 5; // INFORM
    else return;
    const out = new Uint8Array(300);
    out[0] = 2;
    out[1] = 1;
    out[2] = 6;
    out.set(m.subarray(4, 8), 4); // xid
    out.set(m.subarray(10, 12), 10); // flags
    if (reply !== 6 && kind !== 8) put32(out, 16, lease.ip);
    put32(out, 20, this.gateway);
    out.set(m.subarray(28, 44), 28); // chaddr
    put32(out, 236, 0x63825363);
    let o = 240;
    const opt = (code: number, bytes: number[]) => {
      out[o++] = code;
      out[o++] = bytes.length;
      for (const b of bytes) out[o++] = b;
    };
    const ip4 = (v: number) => [v >>> 24, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
    opt(53, [reply]);
    opt(54, ip4(this.gateway));
    if (reply !== 6) {
      opt(51, ip4(86400));
      opt(1, ip4(0xffffff00));
      opt(3, ip4(this.gateway));
      opt(6, ip4(this.gateway));
    }
    out[o++] = 255;
    const packet = udp(this.gateway, 0xffffffff, 67, 68, out.subarray(0, Math.max(o, 272)));
    this.send(from, BROADCAST_MAC, ETH_IPV4, packet);
    if (reply === 5) this.network.changed();
  }

  /** DNS (RFC 1035): A records for the hostnames stations registered over DHCP. */
  private dns(from: StationPort, srcIp: number, srcPort: number, q: Uint8Array): void {
    if (q.length < 12 || q[2] & 0x80 || u16(q, 4) !== 1) return;
    let i = 12;
    const labels: string[] = [];
    while (i < q.length && q[i] !== 0 && labels.length < 64) {
      const len = q[i];
      if (len > 63 || i + 1 + len > q.length) return;
      labels.push(new TextDecoder().decode(q.subarray(i + 1, i + 1 + len)));
      i += 1 + len;
    }
    const qEnd = i + 5;
    if (qEnd > q.length) return;
    const qtype = u16(q, i + 1);
    const name = labels.join('.').toLowerCase();
    const bare = name.replace(/\.(local|lan|home)$/, '');
    const lease = [...this.leases.values()].find((l) => l.hostname && l.hostname.toLowerCase() === bare);
    const answer = qtype === 1 && lease ? lease.ip : undefined;
    const r = new Uint8Array(qEnd + (answer !== undefined ? 16 : 0));
    r.set(q.subarray(0, qEnd));
    // QR, the opcode and RD echoed, RA; NXDOMAIN when the name is not ours.
    r[2] = 0x80 | (q[2] & 0x79);
    r[3] = 0x80 | (answer === undefined && qtype === 1 ? 3 : 0);
    put16(r, 6, answer !== undefined ? 1 : 0);
    put16(r, 8, 0);
    put16(r, 10, 0);
    if (answer !== undefined) {
      put16(r, qEnd, 0xc00c);
      put16(r, qEnd + 2, 1);
      put16(r, qEnd + 4, 1);
      put32(r, qEnd + 6, 60);
      put16(r, qEnd + 10, 4);
      put32(r, qEnd + 12, answer);
    }
    this.send(from, from.mac, ETH_IPV4, udp(this.gateway, srcIp, 53, srcPort, r));
  }
}

export class WifiNetwork {
  private aps: SimAccessPoint[] = [];
  private readonly membership = new Map<StationPort, SimAccessPoint>();
  /** Hosts that are not boards (the workbench): on an access point, but not listed as stations. */
  private readonly hosts = new Set<StationPort>();
  private readonly listeners = new Set<() => void>();

  /** The access points on the canvas. Stations on one that is gone are dropped. */
  setAccessPoints(configs: AccessPointConfig[]): void {
    const kept: SimAccessPoint[] = [];
    configs.forEach((config, index) => {
      const old = this.aps.find((a) => a.config.id === config.id && a.config.ssid === config.ssid && a.config.password === config.password);
      if (old) {
        kept.push(old);
        return;
      }
      // A locally administered BSSID per access point, and its own /24.
      const bssid = new Uint8Array([0x02, 0xcd, 0x5e, 0x00, 0x00, (index + 1) & 0xff]);
      kept.push(new SimAccessPoint(config, bssid, (0xc0a80000 | ((index + 1) << 8)) >>> 0, this));
    });
    for (const [station, ap] of [...this.membership]) {
      if (!kept.includes(ap)) this.membership.delete(station);
    }
    this.aps = kept;
    this.changed();
  }

  get accessPoints(): readonly AccessPointConfig[] {
    return this.aps.map((a) => a.config);
  }

  scan(): ScanResult[] {
    return this.aps.map((a) => ({ ssid: a.config.ssid, bssid: a.bssid, channel: a.config.channel, rssi: SIMULATED_RSSI, open: a.open }));
  }

  join(station: StationPort, ssid: string, password: string): JoinResult {
    this.leave(station);
    const ap = this.aps.find((a) => a.config.ssid === ssid);
    if (!ap) return { ok: false, reason: 'no-ap' };
    if (!ap.open && ap.config.password !== password) return { ok: false, reason: 'auth' };
    ap.stations.add(station);
    this.membership.set(station, ap);
    this.changed();
    return { ok: true, ap: { ssid, bssid: ap.bssid, channel: ap.config.channel, rssi: SIMULATED_RSSI, open: ap.open } };
  }

  leave(station: StationPort): void {
    const ap = this.membership.get(station);
    if (!ap) return;
    ap.stations.delete(station);
    this.membership.delete(station);
    this.changed();
  }

  /** Whether the station is still associated (its access point may have been removed). */
  isJoined(station: StationPort): boolean {
    return this.membership.has(station);
  }

  transmit(station: StationPort, frame: Uint8Array): void {
    this.membership.get(station)?.receive(station, frame);
  }

  /** Puts a host that is not a board (the workbench) on an access point, without a password. */
  attachHost(apId: string, host: StationPort): boolean {
    const ap = this.aps.find((a) => a.config.id === apId);
    if (!ap) return false;
    if (this.membership.get(host) === ap) return true;
    this.leave(host);
    ap.stations.add(host);
    this.membership.set(host, ap);
    this.hosts.add(host);
    return true;
  }

  /**
   * Finds a station by dotted address or by the hostname it gave DHCP (with
   * or without .local): its address, and the access point it is on.
   */
  resolve(name: string): { ip: number; apId: string; subnet: number } | undefined {
    const lower = name.toLowerCase().replace(/\.(local|lan|home)$/, '');
    for (const ap of this.aps) {
      for (const lease of ap.leases.values()) {
        if (ipString(lease.ip) === name || (lease.hostname && lease.hostname.toLowerCase() === lower)) {
          return { ip: lease.ip, apId: ap.config.id, subnet: ap.subnet };
        }
      }
    }
    return undefined;
  }

  stations(): StationView[] {
    const out: StationView[] = [];
    for (const [station, ap] of this.membership) {
      if (this.hosts.has(station)) continue;
      const lease = ap.leases.get(macString(station.mac));
      out.push({
        label: station.label,
        mac: macString(station.mac),
        ssid: ap.config.ssid,
        ip: lease ? ipString(lease.ip) : undefined,
        hostname: lease?.hostname,
      });
    }
    return out;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** @internal */
  changed(): void {
    for (const l of this.listeners) l();
  }
}

/** The access points a project's canvas holds, from their parts' properties. */
export function accessPointsIn(project: { componentInstances: { id: string; definitionId: string; properties?: Record<string, unknown> }[] }): AccessPointConfig[] {
  return project.componentInstances
    .filter((c) => c.definitionId === 'comp.wifi-ap')
    .map((c) => {
      const p = c.properties ?? {};
      const channel = Math.round(Number(p.channel ?? 6));
      return {
        id: c.id,
        ssid: String(p.ssid ?? 'CircuitDesk').slice(0, 32),
        password: String(p.password ?? '').slice(0, 63),
        channel: channel >= 1 && channel <= 13 ? channel : 6,
      };
    })
    // An SSID must not be empty, and WPA2 needs at least eight characters: a
    // real access point refuses either, so this one does not come up.
    .filter((ap) => ap.ssid.length > 0 && (ap.password.length === 0 || ap.password.length >= 8));
}

/** A board runner whose radio the simulator models: it joins the canvas's network as one board. */
export interface WifiRadio {
  attachWifi(network: WifiNetwork, identity: { id: string; label: string }): void;
}

/**
 * A factory MAC for a board instance: an OUI followed by three bytes hashed
 * from the instance id (FNV-1a), so each board on a canvas keeps the same
 * address across runs and no two boards share one. The low byte is kept even
 * because ESP-IDF derives the soft-AP's MAC as one more.
 */
export function macForBoard(id: string, oui: readonly number[] = [0x24, 0x0a, 0xc4]): number[] {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return [...oui.slice(0, 3), (h >>> 16) & 0xff, (h >>> 8) & 0xff, h & 0xfe];
}
