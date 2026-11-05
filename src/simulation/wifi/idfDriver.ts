// ESP-IDF's Wi-Fi driver, provided natively, for the ESP32 family.
//
// The driver itself — libnet80211, libpp and the rest — is closed source and
// drives a radio. Everything that calls it is open and runs as compiled:
// Arduino's WiFi library, esp_netif and its Wi-Fi glue, the default event
// loop, and lwIP, which is the TCP/IP stack every packet actually goes
// through. So this file is the driver's API and nothing else:
//
//   * esp_wifi_init creates a task, as the real driver's init does; the task
//     is the simulator's (GLUE task_entry), and it is where events are posted
//     and received frames are handed up, as the real driver's task does;
//   * mode, configuration, start/stop, connect/disconnect and scans follow the
//     driver's documented behaviour and post the documented events
//     (WIFI_EVENT_STA_START, _CONNECTED with its event data, _DISCONNECTED with
//     the documented reason codes, _SCAN_DONE), which esp_netif and Arduino
//     react to exactly as on hardware — DHCP included, which lwIP runs against
//     the simulated access point;
//   * esp_wifi_internal_tx takes the Ethernet frame lwIP built and gives it to
//     the network; a frame for this station goes up through the receive
//     callback esp_netif registered, in a buffer the driver later frees.
//
// Every other function the closed archives put in the build is patched to
// stop with its name, rather than run code written for a radio this machine
// does not have. Structure layouts and constants are ESP-IDF 5.5's, as
// Arduino-ESP32 3.3.11 builds it, and were read from a compiled probe rather
// than from the headers by hand.

import { call, type FirmwareHost, type GuestRoutine } from '../firmwareCalls';
import { WifiNetwork, type StationPort } from './network';

const WIFI_IF_STA = 0;
const WIFI_IF_AP = 1;
const MODE_STA = 1;
const MODE_AP = 2;

const ESP_OK = 0;
const ESP_ERR_INVALID_ARG = 0x102;
const ERR_WIFI = 0x3000;
const ESP_ERR_WIFI_NOT_INIT = ERR_WIFI + 1;
const ESP_ERR_WIFI_NOT_STARTED = ERR_WIFI + 2;
const ESP_ERR_WIFI_IF = ERR_WIFI + 4;
const ESP_ERR_WIFI_MODE = ERR_WIFI + 5;
const ESP_ERR_WIFI_NOT_CONNECT = ERR_WIFI + 15;
const PORT_MAX_DELAY = 0xffffffff;

const EVENT = { SCAN_DONE: 1, STA_START: 2, STA_STOP: 3, STA_CONNECTED: 4, STA_DISCONNECTED: 5, AP_START: 12, AP_STOP: 13 } as const;
const REASON = { ASSOC_LEAVE: 8, NO_AP_FOUND: 201, AUTH_FAIL: 202 } as const;
const AUTH_OPEN = 0;
const AUTH_WPA2_PSK = 3;

/** sizeof/offsetof in IDF 5.5 (identical on Xtensa and RISC-V). */
const LAYOUT = {
  configSize: 184,
  sta: { ssid: 0, password: 32 },
  connected: { size: 48, ssid: 0, ssidLen: 32, bssid: 33, channel: 39, authmode: 40, aid: 44 },
  disconnected: { size: 41, ssid: 0, ssidLen: 32, bssid: 33, reason: 39, rssi: 40 },
  apRecord: { size: 92, bssid: 0, ssid: 6, primary: 39, second: 40, rssi: 44, authmode: 48, pairwise: 52, group: 56, phyBits: 64 },
  scanDone: { size: 8, status: 0, number: 4, scanId: 5 },
} as const;

/** Simulated time an association and a scan take: the real ones take a second or two. */
const ASSOCIATE_NS = 150e6;
const SCAN_NS = 250e6;

interface Job {
  at: number;
  run: () => GuestRoutine | void;
}

export interface IdfWifiSymbols {
  closed: [string, number][];
  named: Record<string, number>;
}

export class IdfWifiDriver {
  private mode = 0;
  private initialised = false;
  private taskCreated = false;
  private started = false;
  private readonly config = [new Uint8Array(LAYOUT.configSize), new Uint8Array(LAYOUT.configSize)];
  private readonly rxcb = [0, 0];
  private jobs: Job[] = [];
  private connected: { ssid: string; bssid: Uint8Array; channel: number; open: boolean; rssi: number } | null = null;
  private scanResults: { ssid: string; bssid: Uint8Array; channel: number; rssi: number; open: boolean }[] = [];
  private scanId = 0;
  readonly station: StationPort;
  /** Every closed routine the firmware reached that the model does not provide, for the fault message. */
  unprovided: string | null = null;

  private network: WifiNetwork;
  /** The station MAC (the base MAC); the soft-AP's is one more. */
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
      deliver: (frame) => driver.queue(0, () => driver.receive(WIFI_IF_STA, frame)),
    };
  }

  /** Puts the station on the canvas's network, under its board's name and MAC. */
  attach(network: WifiNetwork, mac: ArrayLike<number>, label: string): void {
    if (network !== this.network) {
      this.network.leave(this.station);
      this.connected = null;
      this.network = network;
    }
    this.mac = Uint8Array.from(mac);
    this.label = label;
  }

  /** Patches the build's closed driver over with this model. False when the build has no driver. */
  install(): boolean {
    const handlers = this.handlers();
    let any = false;
    for (const [name, address] of this.symbols.closed) {
      // The radio-coexistence arbiter (Wi-Fi and Bluetooth sharing one antenna)
      // is set up at boot whether or not Wi-Fi is used; with one simulated
      // radio there is nothing to arbitrate.
      const handler = handlers[name] ?? (/^(esp_)?coex_/.test(name) ? () => ESP_OK : undefined);
      const provided = this.host.provideFirmwareRoutine(address, name, handler ?? (() => this.unavailable(name)));
      any ||= provided;
    }
    for (const name of ['esp_wifi_init', 'esp_wifi_deinit']) {
      const address = this.symbols.named[name];
      if (address && handlers[name]) this.host.provideFirmwareRoutine(address, name, handlers[name]);
    }
    this.host.provideTask(() => this.round());
    return any;
  }

  private unavailable(name: string): never {
    this.unprovided = name;
    throw new Error(
      `The sketch reached ${name} in Espressif's closed Wi-Fi driver, which this simulator does not provide. ` +
        'The simulated driver covers station mode: connecting, scanning and sending/receiving packets.',
    );
  }

  private named(name: string): number {
    const a = this.symbols.named[name];
    if (!a) throw new Error(`The build does not carry ${name}, which the simulated Wi-Fi driver calls.`);
    return a;
  }

  // ------------------------------------------------------------- the driver task

  private queue(delayNs: number, run: () => GuestRoutine | void): void {
    const at = this.host.nanos + delayNs;
    let i = this.jobs.length;
    while (i > 0 && this.jobs[i - 1].at > at) i--;
    this.jobs.splice(i, 0, { at, run });
  }

  /** One round of the driver task: the work that is due, then a tick's sleep. */
  private *round(): GuestRoutine {
    for (let n = 0; n < 64 && this.jobs.length > 0 && this.jobs[0].at <= this.host.nanos; n++) {
      const job = this.jobs.shift()!;
      const r = job.run();
      if (r) yield* r;
    }
    yield call(this.named('vTaskDelay'), 1);
    return 0;
  }

  private *post(id: number, data?: Uint8Array): GuestRoutine {
    let ptr = 0;
    if (data) {
      ptr = yield call(this.named('malloc'), data.length);
      if (!ptr) return 0;
      data.forEach((b, k) => this.host.write8(ptr + k, b));
    }
    const base = this.host.read32(this.named('WIFI_EVENT'));
    yield call(this.named('esp_event_post'), base, id, ptr, data?.length ?? 0, PORT_MAX_DELAY);
    if (ptr) yield call(this.named('free'), ptr);
    return 0;
  }

  private *receive(ifx: number, frame: Uint8Array): GuestRoutine {
    const fn = this.rxcb[ifx];
    if (!fn || (ifx === WIFI_IF_STA && !this.connected)) return 0;
    const buf = yield call(this.named('malloc'), frame.length);
    if (!buf) return 0;
    frame.forEach((b, k) => this.host.write8(buf + k, b));
    // (buffer, len, eb): the buffer is its own handle; esp_wifi_internal_free_rx_buffer frees it.
    yield call(fn, buf, frame.length, buf);
    return 0;
  }

  // ------------------------------------------------------------- helpers

  private readString(at: number, max: number): string {
    let s = '';
    for (let i = 0; i < max; i++) {
      const c = this.host.read8(at + i);
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s;
  }

  private bytesOf(text: string, length: number): Uint8Array {
    const out = new Uint8Array(length);
    const enc = new TextEncoder().encode(text);
    out.set(enc.subarray(0, length));
    return out;
  }

  private staSsid(): string {
    return new TextDecoder().decode(this.config[WIFI_IF_STA].subarray(LAYOUT.sta.ssid, LAYOUT.sta.ssid + 32)).replace(/\0.*$/s, '');
  }

  private staPassword(): string {
    return new TextDecoder().decode(this.config[WIFI_IF_STA].subarray(LAYOUT.sta.password, LAYOUT.sta.password + 64)).replace(/\0.*$/s, '');
  }

  private disconnectedEvent(ssid: string, bssid: Uint8Array | undefined, reason: number): Uint8Array {
    const d = new Uint8Array(LAYOUT.disconnected.size);
    const s = this.bytesOf(ssid, 32);
    d.set(s, LAYOUT.disconnected.ssid);
    d[LAYOUT.disconnected.ssidLen] = Math.min(32, new TextEncoder().encode(ssid).length);
    if (bssid) d.set(bssid, LAYOUT.disconnected.bssid);
    d[LAYOUT.disconnected.reason] = reason;
    d[LAYOUT.disconnected.rssi] = 0;
    return d;
  }

  private writeApRecord(at: number, ap: { ssid: string; bssid: Uint8Array; channel: number; rssi: number; open: boolean }): void {
    const L = LAYOUT.apRecord;
    for (let k = 0; k < L.size; k++) this.host.write8(at + k, 0);
    ap.bssid.forEach((b, k) => this.host.write8(at + L.bssid + k, b));
    this.bytesOf(ap.ssid, 33).forEach((b, k) => this.host.write8(at + L.ssid + k, b));
    this.host.write8(at + L.primary, ap.channel);
    this.host.write8(at + L.rssi, ap.rssi & 0xff);
    this.host.write32(at + L.authmode, ap.open ? AUTH_OPEN : AUTH_WPA2_PSK);
    // CCMP for WPA2, none when open.
    this.host.write32(at + L.pairwise, ap.open ? 0 : 4);
    this.host.write32(at + L.group, ap.open ? 0 : 4);
    // phy_11b, phy_11g and phy_11n.
    this.host.write32(at + L.phyBits, 0x7);
  }

  // ------------------------------------------------------------- association

  private connectNow(): void {
    const ssid = this.staSsid();
    const result = this.network.join(this.station, ssid, this.staPassword());
    if (!result.ok) {
      const reason = result.reason === 'no-ap' ? REASON.NO_AP_FOUND : REASON.AUTH_FAIL;
      this.queue(0, () => this.post(EVENT.STA_DISCONNECTED, this.disconnectedEvent(ssid, undefined, reason)));
      return;
    }
    const ap = result.ap;
    this.connected = { ssid, bssid: ap.bssid, channel: ap.channel, open: ap.open, rssi: ap.rssi };
    const L = LAYOUT.connected;
    const d = new Uint8Array(L.size);
    d.set(this.bytesOf(ssid, 32), L.ssid);
    d[L.ssidLen] = Math.min(32, new TextEncoder().encode(ssid).length);
    d.set(ap.bssid, L.bssid);
    d[L.channel] = ap.channel;
    new DataView(d.buffer).setUint32(L.authmode, ap.open ? AUTH_OPEN : AUTH_WPA2_PSK, true);
    new DataView(d.buffer).setUint16(L.aid, 1, true);
    this.queue(0, () => this.post(EVENT.STA_CONNECTED, d));
  }

  private dropConnection(reason: number): void {
    const was = this.connected;
    if (!was) return;
    this.connected = null;
    this.network.leave(this.station);
    this.queue(0, () => this.post(EVENT.STA_DISCONNECTED, this.disconnectedEvent(was.ssid, was.bssid, reason)));
  }

  // ------------------------------------------------------------- the API

  private handlers(): Record<string, (args: number[]) => number | void | GuestRoutine> {
    const h = this.host;
    const ok = () => ESP_OK;
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const d = this;
    const settings = [
      'esp_wifi_set_ps', 'esp_wifi_set_storage', 'esp_wifi_set_protocol', 'esp_wifi_set_protocols', 'esp_wifi_set_bandwidth',
      'esp_wifi_set_bandwidths', 'esp_wifi_set_max_tx_power', 'esp_wifi_set_country', 'esp_wifi_set_keep_alive_time',
      'esp_wifi_set_sleep_min_active_time', 'esp_wifi_set_sleep_wait_broadcast_data_time', 'esp_wifi_internal_set_log_level',
      'esp_wifi_internal_reg_netstack_buf_cb', 'esp_wifi_internal_set_sta_ip', 'esp_wifi_internal_update_mac_time',
      'esp_wifi_set_inactive_time', 'esp_wifi_set_event_mask', 'esp_wifi_clear_ap_list', 'esp_wifi_scan_stop',
      'esp_wifi_set_promiscuous', 'esp_wifi_set_channel', 'esp_wifi_set_rssi_threshold', 'esp_wifi_config_11b_rate',
      'esp_wifi_set_dynamic_cs', 'esp_wifi_restore', 'esp_wifi_set_ant', 'esp_wifi_set_ant_gpio', 'esp_wifi_set_band_mode',
      'esp_wifi_internal_set_fix_rate', 'esp_wifi_set_tx_done_cb', 'esp_wifi_set_vendor_ie', 'esp_wifi_set_vendor_ie_cb',
      'esp_wifi_internal_reg_rxcb_ap',
      // Arduino keeps the C3's USB PLL running alongside the radio; with no radio, nothing to keep.
      'phy_bbpll_en_usb',
    ];
    const table: Record<string, (args: number[]) => number | void | GuestRoutine> = {};
    for (const name of settings) table[name] = ok;
    Object.assign(table, {
      esp_wifi_init: () =>
        (function* (): GuestRoutine {
          d.initialised = true;
          if (!d.taskCreated && h.glueTaskEntry !== undefined) {
            d.taskCreated = true;
            // (code, name, stack bytes, param, priority, handle out, core: no affinity)
            yield call(d.named('xTaskCreatePinnedToCore'), h.glueTaskEntry, h.glueTaskName ?? 0, 4096, 0, 23, 0, 0x7fffffff);
          }
          return ESP_OK;
        })(),
      esp_wifi_deinit: () => {
        d.initialised = false;
        d.started = false;
        d.dropConnection(REASON.ASSOC_LEAVE);
        return ESP_OK;
      },
      esp_wifi_set_mode: ([mode]: number[]) => {
        if (!d.initialised) return ESP_ERR_WIFI_NOT_INIT;
        if (mode > 3) return ESP_ERR_INVALID_ARG;
        const before = d.mode;
        d.mode = mode;
        if (d.started && before & MODE_STA && !(mode & MODE_STA)) d.dropConnection(REASON.ASSOC_LEAVE);
        return ESP_OK;
      },
      esp_wifi_get_mode: ([out]: number[]) => {
        if (!d.initialised) return ESP_ERR_WIFI_NOT_INIT;
        if (out) h.write32(out, d.mode);
        return ESP_OK;
      },
      esp_wifi_set_config: ([ifx, cfg]: number[]) => {
        if (ifx > 1) return ESP_ERR_WIFI_IF;
        for (let k = 0; k < LAYOUT.configSize; k++) d.config[ifx][k] = h.read8(cfg + k);
        return ESP_OK;
      },
      esp_wifi_get_config: ([ifx, cfg]: number[]) => {
        if (ifx > 1) return ESP_ERR_WIFI_IF;
        d.config[ifx].forEach((b, k) => h.write8(cfg + k, b));
        return ESP_OK;
      },
      esp_wifi_start: () => {
        if (!d.initialised) return ESP_ERR_WIFI_NOT_INIT;
        if (d.started) return ESP_OK;
        d.started = true;
        if (d.mode & MODE_STA) d.queue(0, () => d.post(EVENT.STA_START));
        if (d.mode & MODE_AP) d.queue(0, () => d.post(EVENT.AP_START));
        return ESP_OK;
      },
      esp_wifi_stop: () => {
        if (!d.started) return ESP_OK;
        d.dropConnection(REASON.ASSOC_LEAVE);
        d.started = false;
        if (d.mode & MODE_STA) d.queue(0, () => d.post(EVENT.STA_STOP));
        if (d.mode & MODE_AP) d.queue(0, () => d.post(EVENT.AP_STOP));
        return ESP_OK;
      },
      esp_wifi_connect_internal: () => {
        if (!d.initialised) return ESP_ERR_WIFI_NOT_INIT;
        if (!d.started) return ESP_ERR_WIFI_NOT_STARTED;
        if (!(d.mode & MODE_STA)) return ESP_ERR_WIFI_MODE;
        if (d.connected) d.dropConnection(REASON.ASSOC_LEAVE);
        d.queue(ASSOCIATE_NS, () => d.connectNow());
        return ESP_OK;
      },
      esp_wifi_disconnect_internal: () => {
        d.dropConnection(REASON.ASSOC_LEAVE);
        return ESP_OK;
      },
      esp_wifi_internal_reg_rxcb: ([ifx, fn]: number[]) => {
        if (ifx > 1) return ESP_ERR_WIFI_IF;
        d.rxcb[ifx] = fn;
        return ESP_OK;
      },
      esp_wifi_internal_tx: ([ifx, buf, len]: number[]) => {
        if (ifx !== WIFI_IF_STA) return ESP_ERR_WIFI_IF;
        if (!d.connected || !d.network.isJoined(d.station)) return ESP_ERR_WIFI_NOT_CONNECT;
        const n = len & 0xffff;
        const frame = new Uint8Array(n);
        for (let k = 0; k < n; k++) frame[k] = h.read8(buf + k);
        d.network.transmit(d.station, frame);
        return ESP_OK;
      },
      esp_wifi_internal_free_rx_buffer: ([eb]: number[]) =>
        (function* (): GuestRoutine {
          if (eb) yield call(d.named('free'), eb);
          return 0;
        })(),
      esp_wifi_get_mac: ([ifx, out]: number[]) => {
        if (ifx > 1) return ESP_ERR_WIFI_IF;
        d.mac.forEach((b, k) => h.write8(out + k, k === 5 ? (b + ifx) & 0xff : b));
        return ESP_OK;
      },
      esp_wifi_sta_get_ap_info: ([out]: number[]) => {
        if (!d.connected) return ESP_ERR_WIFI_NOT_CONNECT;
        d.writeApRecord(out, d.connected);
        return ESP_OK;
      },
      esp_wifi_scan_start: ([, block]: number[]) => {
        if (!d.started) return ESP_ERR_WIFI_NOT_STARTED;
        if (!(d.mode & MODE_STA)) return ESP_ERR_WIFI_MODE;
        const id = ++d.scanId & 0xff;
        const finish = () => {
          d.scanResults = d.network.scan();
          const e = new Uint8Array(LAYOUT.scanDone.size);
          new DataView(e.buffer).setUint32(LAYOUT.scanDone.status, 0, true);
          e[LAYOUT.scanDone.number] = d.scanResults.length;
          e[LAYOUT.scanDone.scanId] = id;
          return d.post(EVENT.SCAN_DONE, e);
        };
        if (block) {
          return (function* (): GuestRoutine {
            // A blocking scan takes its time in the calling task.
            yield call(d.named('vTaskDelay'), Math.round(SCAN_NS / 1e6));
            yield* finish();
            return ESP_OK;
          })();
        }
        d.queue(SCAN_NS, finish);
        return ESP_OK;
      },
      esp_wifi_scan_get_ap_num: ([out]: number[]) => {
        h.write8(out, d.scanResults.length);
        h.write8(out + 1, 0);
        return ESP_OK;
      },
      esp_wifi_scan_get_ap_records: ([numPtr, records]: number[]) => {
        const want = h.read8(numPtr) | (h.read8(numPtr + 1) << 8);
        const n = Math.min(want, d.scanResults.length);
        for (let i = 0; i < n; i++) d.writeApRecord(records + i * LAYOUT.apRecord.size, d.scanResults[i]);
        h.write8(numPtr, n);
        h.write8(numPtr + 1, 0);
        d.scanResults = [];
        return ESP_OK;
      },
      esp_wifi_get_channel: ([primary, second]: number[]) => {
        if (primary) h.write8(primary, d.connected?.channel ?? 1);
        if (second) h.write32(second, 0);
        return ESP_OK;
      },
      esp_wifi_get_protocol: ([, out]: number[]) => {
        if (out) h.write8(out, 0x7);
        return ESP_OK;
      },
      esp_wifi_get_bandwidth: ([, out]: number[]) => {
        if (out) h.write32(out, 1);
        return ESP_OK;
      },
      esp_wifi_get_max_tx_power: ([out]: number[]) => {
        if (out) h.write8(out, 80);
        return ESP_OK;
      },
      esp_wifi_get_ps: ([out]: number[]) => {
        if (out) h.write32(out, 0);
        return ESP_OK;
      },
      esp_wifi_get_event_mask: ([out]: number[]) => {
        if (out) h.write32(out, 0);
        return ESP_OK;
      },
      esp_wifi_ap_get_sta_list: ([out]: number[]) => {
        // No stations: the soft-AP side is not modelled yet. num sits after the 15 entries.
        if (out) h.write32(out + 180, 0);
        return ESP_OK;
      },
    });
    return table;
  }

  /** Whether the station is associated, for the workbench. */
  get isConnected(): boolean {
    return this.connected !== null;
  }
}
