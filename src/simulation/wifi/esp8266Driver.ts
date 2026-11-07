// The ESP8266's Wi-Fi, provided natively at the NONOS SDK's station API.
//
// On the ESP8266 the Arduino core runs on Espressif's NONOS SDK, whose
// libraries are closed and whose start-up runs as compiled (it brings up a
// radio whose registers are plain storage here). Above the SDK sits lwIP —
// the core's lwIP2, open source — joined to the SDK by a small glue layer.
// So, as with the ESP32 family (./idfDriver), the TCP/IP stack every packet
// goes through is the firmware's own, and the simulator answers the radio's
// side:
//
//   * the station API Arduino's ESP8266WiFi calls — configuration, connect,
//     disconnect, status, scans, the IP information and the event callback —
//     follows the SDK's documented behaviour, with its documented status
//     values, events and reason codes;
//   * on association it brings lwIP's station interface up and starts DHCP,
//     as the SDK does, through the glue's own entry points (esp2glue_*); when
//     lwIP has an address it reports it through glue2esp_ifupdown, which this
//     takes as the SDK would, and the station is connected;
//   * lwIP's frames leave through glue2esp_linkoutput and go to the network;
//     a frame for the station goes up through esp2glue_alloc_for_recv and
//     esp2glue_ethernet_input, as the SDK's receive path hands it up.
//
// The work that calls back into firmware (events, received frames, scan
// results) runs from the ROM scheduler's loop, where the SDK's own tasks run,
// through Esp8266Machine's guest-call glue. Layouts are the SDK's
// user_interface.h as the core (3.1.2, SDK 2.2.x) builds it, read from a
// compiled probe.

import { call, type FirmwareHost, type GuestRoutine } from '../firmwareCalls';
import { WifiNetwork, type StationPort } from './network';
import type { IdfWifiSymbols } from './idfDriver';

const STATION_IF = 0;
/** station_config, and where the parts used here sit in it. */
const STA_CONFIG = { size: 112, ssid: 0, password: 32, bssidSet: 96, bssid: 97 } as const;
/** System_Event_t: the event number, then its information. */
const SYSTEM_EVENT = { size: 44, info: 4 } as const;
const EVENT = { CONNECTED: 0, DISCONNECTED: 1, GOT_IP: 3 } as const;
const STATUS = { IDLE: 0, CONNECTING: 1, WRONG_PASSWORD: 2, NO_AP_FOUND: 3, CONNECT_FAIL: 4, GOT_IP: 5 } as const;
const REASON = { ASSOC_LEAVE: 8, NO_AP_FOUND: 201, AUTH_FAIL: 202 } as const;
const AUTH_OPEN = 0;
const AUTH_WPA2_PSK = 3;
const CIPHER_CCMP = 4;
/** bss_info, a scan result: an STAILQ link first. */
const BSS = { size: 80, next: 0, bssid: 4, ssid: 10, ssidLen: 42, channel: 43, rssi: 44, authmode: 48, pairwise: 68, group: 72, phy: 76 } as const;
const SCAN_OK = 0;

/** Simulated time an association and a scan take, as on the ESP32 model. */
const ASSOCIATE_NS = 150e6;
const SCAN_NS = 250e6;

/** The SDK entry points this model answers. */
const PROVIDED = [
  'wifi_station_set_config', 'wifi_station_set_config_current', 'wifi_station_get_config', 'wifi_station_get_config_default',
  'wifi_station_connect', 'wifi_station_disconnect', 'wifi_station_get_connect_status', 'wifi_station_dhcpc_start',
  'wifi_station_dhcpc_stop', 'wifi_station_dhcpc_status', 'wifi_station_scan', 'wifi_station_get_rssi', 'wifi_get_channel',
  'wifi_get_ip_info', 'wifi_set_ip_info', 'wifi_set_event_handler_cb',
] as const;

interface Job {
  at: number;
  run: () => GuestRoutine | void;
}

interface Association {
  ssid: string;
  bssid: Uint8Array;
  channel: number;
  open: boolean;
  rssi: number;
}

export class Esp8266WifiDriver {
  private readonly config = new Uint8Array(STA_CONFIG.size);
  private status: number = STATUS.IDLE;
  private dhcp = true;
  /** Counts connection attempts, so one called off is not completed. */
  private attempt = 0;
  private eventCb = 0;
  private jobs: Job[] = [];
  private connected: Association | null = null;
  /** The station's address once DHCP (or a static configuration) gives it one. */
  private ip = { ip: 0, mask: 0, gw: 0 };
  /** An address set with wifi_set_ip_info while DHCP is off. */
  private staticIp: { ip: number; mask: number; gw: number } | null = null;
  readonly station: StationPort;
  private network: WifiNetwork;
  private mac: Uint8Array;
  private label: string;

  constructor(
    private readonly host: FirmwareHost,
    private readonly symbols: IdfWifiSymbols,
    mac: ArrayLike<number>,
    label: string,
    network: WifiNetwork = new WifiNetwork(),
  ) {
    this.network = network;
    this.mac = Uint8Array.from(mac);
    this.label = label;
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const driver = this;
    this.station = {
      get mac() {
        return driver.mac;
      },
      get label() {
        return driver.label;
      },
      deliver: (frame) => driver.queue(0, () => driver.receive(frame)),
    };
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

  /** Answers the SDK's station API in the loaded build. False when the build does not use Wi-Fi. */
  install(): boolean {
    const closed = new Map(this.symbols.closed);
    const handlers = this.handlers();
    let any = false;
    for (const name of PROVIDED) {
      const address = closed.get(name);
      if (address) any = this.host.provideFirmwareRoutine(address, name, handlers[name]) || any;
    }
    for (const name of ['glue2esp_linkoutput', 'glue2esp_ifupdown'] as const) {
      const address = this.symbols.named[name];
      if (address) this.host.provideFirmwareRoutine(address, name, handlers[name]);
    }
    this.host.provideTask(() => this.round());
    return any;
  }

  /** When the model next has work for the firmware's scheduler, if it has any. */
  nextDue(): number | undefined {
    return this.jobs[0]?.at;
  }

  get isConnected(): boolean {
    return this.connected !== null;
  }

  private named(name: string): number {
    const a = this.symbols.named[name];
    if (!a) throw new Error(`The build does not carry ${name}, which the simulated Wi-Fi driver calls.`);
    return a;
  }

  private queue(delayNs: number, run: () => GuestRoutine | void): void {
    const at = this.host.nanos + delayNs;
    let i = this.jobs.length;
    while (i > 0 && this.jobs[i - 1].at > at) i--;
    this.jobs.splice(i, 0, { at, run });
  }

  /** The work that is due, run from the ROM scheduler's loop. */
  private *round(): GuestRoutine {
    for (let n = 0; n < 64 && this.jobs.length > 0 && this.jobs[0].at <= this.host.nanos; n++) {
      const r = this.jobs.shift()!.run();
      if (r) yield* r;
    }
    return 0;
  }

  // ------------------------------------------------------------- calls into the firmware

  /** Hands the event to the callback the core registered, in a buffer it can keep only for the call. */
  private *post(event: number, info?: Uint8Array): GuestRoutine {
    if (!this.eventCb) return 0;
    const ptr = yield call(this.named('malloc'), SYSTEM_EVENT.size);
    if (!ptr) return 0;
    for (let k = 0; k < SYSTEM_EVENT.size; k++) this.host.write8(ptr + k, 0);
    this.host.write32(ptr, event);
    info?.forEach((b, k) => this.host.write8(ptr + SYSTEM_EVENT.info + k, b));
    yield call(this.eventCb, ptr);
    yield call(this.named('free'), ptr);
    return 0;
  }

  private *receive(frame: Uint8Array): GuestRoutine {
    if (!this.connected) return 0;
    const out = yield call(this.named('malloc'), 8);
    if (!out) return 0;
    this.host.write32(out, 0);
    this.host.write32(out + 4, 0);
    yield call(this.named('esp2glue_alloc_for_recv'), frame.length, out, out + 4);
    const pbuf = this.host.read32(out);
    const data = this.host.read32(out + 4);
    yield call(this.named('free'), out);
    if (!pbuf || !data) return 0;
    frame.forEach((b, k) => this.host.write8(data + k, b));
    yield call(this.named('esp2glue_ethernet_input'), STATION_IF, pbuf);
    return 0;
  }

  // ------------------------------------------------------------- helpers

  private text(at: number, length: number): string {
    const bytes = this.config.subarray(at, at + length);
    const end = bytes.indexOf(0);
    return new TextDecoder().decode(end < 0 ? bytes : bytes.subarray(0, end));
  }

  private ssidBytes(ssid: string): Uint8Array {
    const out = new Uint8Array(32);
    out.set(new TextEncoder().encode(ssid).subarray(0, 32));
    return out;
  }

  private connectedInfo(a: Association): Uint8Array {
    // Event_StaMode_Connected_t: ssid[32], ssid_len, bssid[6], channel.
    const d = new Uint8Array(40);
    d.set(this.ssidBytes(a.ssid), 0);
    d[32] = Math.min(32, new TextEncoder().encode(a.ssid).length);
    d.set(a.bssid, 33);
    d[39] = a.channel;
    return d;
  }

  private disconnectedInfo(ssid: string, bssid: Uint8Array | undefined, reason: number): Uint8Array {
    // Event_StaMode_Disconnected_t: ssid[32], ssid_len, bssid[6], reason.
    const d = new Uint8Array(40);
    d.set(this.ssidBytes(ssid), 0);
    d[32] = Math.min(32, new TextEncoder().encode(ssid).length);
    if (bssid) d.set(bssid, 33);
    d[39] = reason;
    return d;
  }

  private gotIpInfo(): Uint8Array {
    const d = new Uint8Array(12);
    const v = new DataView(d.buffer);
    v.setUint32(0, this.ip.ip, true);
    v.setUint32(4, this.ip.mask, true);
    v.setUint32(8, this.ip.gw, true);
    return d;
  }

  // ------------------------------------------------------------- association

  private associate(): GuestRoutine | void {
    const ssid = this.text(STA_CONFIG.ssid, 32);
    const result = this.network.join(this.station, ssid, this.text(STA_CONFIG.password, 64));
    if (!result.ok) {
      const reason = result.reason === 'no-ap' ? REASON.NO_AP_FOUND : REASON.AUTH_FAIL;
      this.status = result.reason === 'no-ap' ? STATUS.NO_AP_FOUND : STATUS.WRONG_PASSWORD;
      return this.post(EVENT.DISCONNECTED, this.disconnectedInfo(ssid, undefined, reason));
    }
    const ap = result.ap;
    const a: Association = { ssid, bssid: ap.bssid, channel: ap.channel, open: ap.open, rssi: ap.rssi };
    this.connected = a;
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const d = this;
    return (function* (): GuestRoutine {
      yield* d.post(EVENT.CONNECTED, d.connectedInfo(a));
      // As the SDK does on association: the station interface up, then DHCP or the static address.
      yield call(d.named('esp2glue_netif_set_up1down0'), STATION_IF, 1);
      if (d.dhcp) {
        yield call(d.named('esp2glue_dhcp_start'), STATION_IF);
      } else if (d.staticIp) {
        d.ip = { ...d.staticIp };
        d.status = STATUS.GOT_IP;
        yield* d.post(EVENT.GOT_IP, d.gotIpInfo());
      }
      return 0;
    })();
  }

  private dropConnection(reason: number): void {
    const was = this.connected;
    this.status = STATUS.IDLE;
    if (!was) return;
    this.connected = null;
    if (this.dhcp) this.ip = { ip: 0, mask: 0, gw: 0 };
    this.network.leave(this.station);
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const d = this;
    this.queue(0, function* (): GuestRoutine {
      if (d.dhcp) yield call(d.named('esp2glue_dhcp_stop'), STATION_IF);
      yield call(d.named('esp2glue_netif_set_up1down0'), STATION_IF, 0);
      yield* d.post(EVENT.DISCONNECTED, d.disconnectedInfo(was.ssid, was.bssid, reason));
      return 0;
    });
  }

  private writeBss(at: number, ap: { ssid: string; bssid: Uint8Array; channel: number; rssi: number; open: boolean }, next: number): void {
    const h = this.host;
    for (let k = 0; k < BSS.size; k++) h.write8(at + k, 0);
    h.write32(at + BSS.next, next);
    ap.bssid.forEach((b, k) => h.write8(at + BSS.bssid + k, b));
    this.ssidBytes(ap.ssid).forEach((b, k) => h.write8(at + BSS.ssid + k, b));
    h.write8(at + BSS.ssidLen, Math.min(32, new TextEncoder().encode(ap.ssid).length));
    h.write8(at + BSS.channel, ap.channel);
    h.write8(at + BSS.rssi, ap.rssi & 0xff);
    h.write32(at + BSS.authmode, ap.open ? AUTH_OPEN : AUTH_WPA2_PSK);
    h.write32(at + BSS.pairwise, ap.open ? 0 : CIPHER_CCMP);
    h.write32(at + BSS.group, ap.open ? 0 : CIPHER_CCMP);
    // phy_11b, phy_11g, phy_11n.
    h.write32(at + BSS.phy, 0x7);
  }

  /** The scan's results as the SDK hands them to the callback: a linked list, freed after the call. */
  private *scanDone(cb: number): GuestRoutine {
    const found = this.network.scan();
    const nodes: number[] = [];
    for (let i = 0; i < found.length; i++) {
      const p = yield call(this.named('malloc'), BSS.size);
      if (!p) break;
      nodes.push(p);
    }
    nodes.forEach((p, i) => this.writeBss(p, found[i], nodes[i + 1] ?? 0));
    yield call(cb, nodes[0] ?? 0, SCAN_OK);
    for (const p of nodes) yield call(this.named('free'), p);
    return 0;
  }

  // ------------------------------------------------------------- the API

  private handlers(): Record<(typeof PROVIDED)[number] | 'glue2esp_linkoutput' | 'glue2esp_ifupdown', (args: number[]) => number | void | GuestRoutine> {
    const h = this.host;
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const d = this;
    const setConfig = ([cfg]: number[]) => {
      if (!cfg) return 0;
      for (let k = 0; k < STA_CONFIG.size; k++) d.config[k] = h.read8(cfg + k);
      return 1;
    };
    const getConfig = ([cfg]: number[]) => {
      if (!cfg) return 0;
      d.config.forEach((b, k) => h.write8(cfg + k, b));
      return 1;
    };
    const writeIp = (at: number, v: { ip: number; mask: number; gw: number }) => {
      h.write32(at, v.ip);
      h.write32(at + 4, v.mask);
      h.write32(at + 8, v.gw);
    };
    return {
      wifi_station_set_config: setConfig,
      wifi_station_set_config_current: setConfig,
      wifi_station_get_config: getConfig,
      wifi_station_get_config_default: getConfig,
      wifi_station_connect: () => {
        if (d.connected) d.dropConnection(REASON.ASSOC_LEAVE);
        d.status = STATUS.CONNECTING;
        const attempt = ++d.attempt;
        d.queue(ASSOCIATE_NS, () => (attempt === d.attempt ? d.associate() : undefined));
        return 1;
      },
      wifi_station_disconnect: () => {
        // An attempt still under way is called off too.
        d.attempt++;
        d.dropConnection(REASON.ASSOC_LEAVE);
        return 1;
      },
      wifi_station_get_connect_status: () => d.status,
      wifi_station_dhcpc_start: () => {
        d.dhcp = true;
        return 1;
      },
      wifi_station_dhcpc_stop: () => {
        d.dhcp = false;
        return 1;
      },
      // DHCP_STARTED 1, DHCP_STOPPED 0.
      wifi_station_dhcpc_status: () => (d.dhcp ? 1 : 0),
      wifi_station_scan: ([, cb]: number[]) => {
        if (cb) d.queue(SCAN_NS, () => d.scanDone(cb));
        return 1;
      },
      wifi_station_get_rssi: () => (d.connected ? d.connected.rssi : 31) >>> 0,
      wifi_get_channel: () => d.connected?.channel ?? 1,
      wifi_get_ip_info: ([ifx, out]: number[]) => {
        if (!out) return 0;
        writeIp(out, ifx === STATION_IF ? d.ip : { ip: 0, mask: 0, gw: 0 });
        return 1;
      },
      wifi_set_ip_info: ([ifx, info]: number[]) => {
        if (ifx !== STATION_IF || !info) return 0;
        const v = { ip: h.read32(info), mask: h.read32(info + 4), gw: h.read32(info + 8) };
        d.staticIp = v;
        // lwIP's interface takes the address now, as the SDK's netif_set_addr gives it.
        return (function* (): GuestRoutine {
          const hw = yield call(d.named('malloc'), 8);
          if (hw) {
            d.mac.forEach((b, k) => h.write8(hw + k, b));
            // (netif, ip, mask, gw, hwaddr length, hwaddr, mtu)
            yield call(d.named('esp2glue_netif_update'), STATION_IF, v.ip, v.mask, v.gw, 6, hw, 1500);
            yield call(d.named('free'), hw);
          }
          if (d.connected && !d.dhcp) {
            d.ip = { ...v };
            d.status = STATUS.GOT_IP;
            d.queue(0, () => d.post(EVENT.GOT_IP, d.gotIpInfo()));
          }
          return 1;
        })();
      },
      wifi_set_event_handler_cb: ([cb]: number[]) => {
        d.eventCb = cb;
      },
      // (netif, the pbuf to give back when sent, its bytes, their length)
      glue2esp_linkoutput: ([ifx, ref, data, size]: number[]) => {
        if (ifx !== STATION_IF || !d.connected || !d.network.isJoined(d.station)) return -11 >>> 0; // GLUE_ERR_CONN
        const n = size & 0xffff;
        const frame = new Uint8Array(n);
        for (let k = 0; k < n; k++) frame[k] = h.read8(data + k);
        d.network.transmit(d.station, frame);
        return (function* (): GuestRoutine {
          // Sent: the buffer goes back to lwIP, as the SDK returns it once the radio is done.
          yield call(d.named('esp2glue_pbuf_freed'), ref);
          return 0;
        })();
      },
      // lwIP has (or has lost) an address on an interface.
      glue2esp_ifupdown: ([ifx, ip, mask, gw]: number[]) => {
        if (ifx !== STATION_IF) return;
        d.ip = { ip, mask, gw };
        if (ip && d.connected && d.status !== STATUS.GOT_IP) {
          d.status = STATUS.GOT_IP;
          d.queue(0, () => d.post(EVENT.GOT_IP, d.gotIpInfo()));
        }
      },
    };
  }
}
