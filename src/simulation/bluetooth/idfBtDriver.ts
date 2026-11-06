// ESP-IDF's Bluetooth controller interface, provided natively, for the ESP32,
// ESP32-S3, ESP32-C3 and ESP32-C6.
//
// ESP-IDF's Bluetooth is a host — Bluedroid on the ESP32, NimBLE on the S3 and
// C3, both open and both run as compiled — on top of a closed controller
// (libbtdm_app, libbtbb) that drives the radio. Between them is VHCI, a
// virtual HCI transport: the host hands the controller H4-framed HCI packets
// with esp_vhci_host_send_packet, and the controller hands packets back
// through the callback the host registered. So the simulator answers the
// controller's side of that, and nothing of the controller runs:
//
//   * esp_bt_controller_init / enable / disable / deinit and get_status keep
//     the state machine Arduino's btStart() and the hosts walk through;
//   * esp_vhci_host_send_packet gives the packet to the controller model
//     (./controller), and what the model has for the host is delivered from
//     the simulator's firmware task through notify_host_recv, in a buffer the
//     host copies from, as the real controller's task delivers it;
//   * esp_vhci_host_check_send_available always says yes: the model's buffers
//     are returned as soon as a packet is on the air; NimBLE also waits to be
//     told (notify_host_send_available), which it is after each packet;
//   * the ESP32-C6 has a different transport in the same place
//     (bt/porting/transport): hci_transport_host_cmd_tx and _acl_tx take the
//     host's packets without the H4 indicator, and the callback registered with
//     hci_transport_host_callback_register takes the controller's, with the
//     indicator as its first argument. Its controller library also carries
//     generic NimBLE code the host needs (the mbuf pools, the OS porting
//     layer), built in its own start-up, which reaches into the controller
//     itself: not modelled yet. On the C6, esp_bt_controller_init answers
//     ESP_ERR_NOT_SUPPORTED, so the sketch's BLE start fails and it carries on.
//
// Every function of the closed controller archives is patched to stop with
// its name, should anything reach past these.

import { call, type FirmwareHost, type GuestRoutine } from '../firmwareCalls';
import { BleAir, BleController, H4 } from './controller';

const ESP_OK = 0;
const ESP_ERR_INVALID_STATE = 0x103;
const ESP_ERR_NOT_SUPPORTED = 0x106;
const STATUS = { IDLE: 0, INITED: 1, ENABLED: 2 } as const;

export interface IdfBtSymbols {
  bluetooth?: [string, number][];
  named: Record<string, number>;
}

/** The open entry points this model answers. */
const PROVIDED = [
  'esp_bt_controller_init', 'esp_bt_controller_deinit', 'esp_bt_controller_enable', 'esp_bt_controller_disable',
  'esp_bt_controller_get_status', 'esp_vhci_host_check_send_available', 'esp_vhci_host_send_packet',
  'esp_vhci_host_register_callback', 'hci_transport_init', 'hci_transport_deinit',
  'hci_transport_host_callback_register', 'hci_transport_host_cmd_tx', 'hci_transport_host_acl_tx',
] as const;

/** At most this many packets go to the host per round of the task, so a busy scan cannot starve it. */
const PACKETS_PER_ROUND = 16;

export class IdfBtDriver {
  private status: number = STATUS.IDLE;
  private recv = 0;
  /** The C6's receive callback (type, data, len), in place of VHCI's. */
  private transportRecv = 0;
  private sendAvailable = 0;
  /** The host is waiting to hear its last packet was taken (NimBLE waits for this before sending another). */
  private owedSendAvailable = false;
  readonly controller: BleController;

  constructor(
    private readonly host: FirmwareHost,
    private readonly symbols: IdfBtSymbols,
    address: ArrayLike<number>,
    label: string,
    air: BleAir = new BleAir(),
  ) {
    this.controller = new BleController(() => host.nanos, address, label, air);
  }

  attach(air: BleAir, address: ArrayLike<number>, label: string): void {
    this.controller.attach(air, address, label);
  }

  /**
   * The board was reset: the controller is powered off with the rest of the
   * chip, its links drop, and the rebooted firmware starts it from IDLE again.
   */
  reset(): void {
    this.status = STATUS.IDLE;
    this.recv = 0;
    this.transportRecv = 0;
    this.sendAvailable = 0;
    this.owedSendAvailable = false;
    this.controller.powerOn();
  }

  /** The ESP32-C6's transport (hci_transport_*), in place of VHCI. */
  private get transportMode(): boolean {
    return !!this.symbols.named.hci_transport_host_cmd_tx && !this.symbols.named.esp_vhci_host_send_packet;
  }

  /** Patches the build's controller interface over with this model. False when the build has no Bluetooth. */
  install(): boolean {
    const named = this.symbols.named;
    if (!named.esp_bt_controller_init) return false;
    const handlers = this.handlers();
    if (this.transportMode) {
      // The ESP32-C6: its controller library is interleaved with code its
      // host needs (see the header), and is not modelled yet. Its start-up is
      // refused plainly, so BLEDevice::init() fails and the sketch carries on.
      this.host.provideFirmwareRoutine(named.esp_bt_controller_init, 'esp_bt_controller_init', () => ESP_ERR_NOT_SUPPORTED);
      return false;
    }
    for (const name of PROVIDED) {
      const address = named[name];
      if (address) this.host.provideFirmwareRoutine(address, name, handlers[name]);
    }
    const settings = closedSettings();
    for (const [name, address] of this.symbols.bluetooth ?? []) {
      this.host.provideFirmwareRoutine(address, name, settings[name] ?? (() => this.unavailable(name)));
    }
    this.host.provideTask(() => this.round());
    return true;
  }

  private unavailable(name: string): never {
    throw new Error(
      `The sketch reached ${name} in Espressif's closed Bluetooth controller, which this simulator does not provide. ` +
        'The simulated controller covers Bluetooth Low Energy through the host: advertising, scanning and connections.',
    );
  }

  private named(name: string): number {
    const a = this.symbols.named[name];
    if (!a) throw new Error(`The build does not carry ${name}, which the simulated Bluetooth controller calls.`);
    return a;
  }

  /** One round of the firmware task: the packets due for the host. */
  private *round(): GuestRoutine {
    if (this.status !== STATUS.ENABLED || (!this.recv && !this.transportRecv)) return 0;
    if (this.owedSendAvailable && this.sendAvailable) {
      this.owedSendAvailable = false;
      yield call(this.sendAvailable);
    }
    for (let n = 0; n < PACKETS_PER_ROUND; n++) {
      const packet = this.controller.takeDue();
      if (!packet) break;
      const buf = yield call(this.named('malloc'), packet.length);
      if (!buf) break;
      packet.forEach((b, k) => this.host.write8(buf + k, b));
      if (this.recv) {
        // notify_host_recv(data, len): the host copies the packet out.
        yield call(this.recv, buf, packet.length);
      } else {
        // hci_transport_host_recv_fn(type, data, len): the indicator separately.
        yield call(this.transportRecv, packet[0], buf + 1, packet.length - 1);
      }
      yield call(this.named('free'), buf);
    }
    // Without Wi-Fi in the build, nothing else sleeps the task between rounds.
    if (!this.symbols.named.esp_wifi_init) yield call(this.named('vTaskDelay'), 1);
    return 0;
  }

  /** A packet from the C6's host, which arrives without its H4 indicator. */
  private hostPacket(type: number, data: number, len: number): number {
    if (this.status !== STATUS.ENABLED) return -1 >>> 0;
    const packet = new Uint8Array(1 + len);
    packet[0] = type;
    for (let k = 0; k < len; k++) packet[1 + k] = this.host.read8(data + k);
    this.controller.fromHost(packet);
    return ESP_OK;
  }

  private handlers(): Record<(typeof PROVIDED)[number], (args: number[]) => number | void | GuestRoutine> {
    const h = this.host;
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const d = this;
    return {
      esp_bt_controller_init: () =>
        (function* (): GuestRoutine {
          if (d.status !== STATUS.IDLE) return ESP_ERR_INVALID_STATE;
          d.status = STATUS.INITED;
          d.controller.powerOn();
          if (h.glueTaskEntry !== undefined && h.claimTask()) {
            // (code, name, stack bytes, param, priority, handle out, core: no affinity)
            yield call(d.named('xTaskCreatePinnedToCore'), h.glueTaskEntry, h.glueTaskName ?? 0, 4096, 0, 23, 0, 0x7fffffff);
          }
          return ESP_OK;
        })(),
      esp_bt_controller_deinit: () => {
        if (d.status !== STATUS.INITED) return ESP_ERR_INVALID_STATE;
        d.status = STATUS.IDLE;
        return ESP_OK;
      },
      esp_bt_controller_enable: () => {
        if (d.status !== STATUS.INITED) return ESP_ERR_INVALID_STATE;
        d.status = STATUS.ENABLED;
        return ESP_OK;
      },
      esp_bt_controller_disable: () => {
        if (d.status !== STATUS.ENABLED) return ESP_ERR_INVALID_STATE;
        d.status = STATUS.INITED;
        d.controller.powerOn();
        return ESP_OK;
      },
      esp_bt_controller_get_status: () => d.status,
      esp_vhci_host_check_send_available: () => 1,
      esp_vhci_host_send_packet: ([data, len]: number[]) => {
        if (d.status !== STATUS.ENABLED) return;
        const n = len & 0xffff;
        const packet = new Uint8Array(n);
        for (let k = 0; k < n; k++) packet[k] = h.read8(data + k);
        d.controller.fromHost(packet);
        d.owedSendAvailable = true;
      },
      hci_transport_init: () =>
        (function* (): GuestRoutine {
          // On the C6 the controller is up once ESP-IDF's start-up reaches its transport.
          d.status = STATUS.ENABLED;
          d.controller.powerOn();
          if (h.glueTaskEntry !== undefined && h.claimTask()) {
            yield call(d.named('xTaskCreatePinnedToCore'), h.glueTaskEntry, h.glueTaskName ?? 0, 4096, 0, 23, 0, 0x7fffffff);
          }
          return ESP_OK;
        })(),
      hci_transport_deinit: () => {
        d.status = STATUS.IDLE;
      },
      hci_transport_host_callback_register: ([fn]: number[]) => {
        d.transportRecv = fn;
        return ESP_OK;
      },
      hci_transport_host_cmd_tx: ([data, len]: number[]) => d.hostPacket(H4.COMMAND, data, len),
      hci_transport_host_acl_tx: ([data, len]: number[]) => d.hostPacket(H4.ACL, data, len),
      esp_vhci_host_register_callback: ([cb]: number[]) => {
        // esp_vhci_host_callback_t: notify_host_send_available, notify_host_recv.
        d.sendAvailable = cb ? h.read32(cb) : 0;
        d.recv = cb ? h.read32(cb + 4) : 0;
        return ESP_OK;
      },
    };
  }
}

/**
 * Closed controller functions the open side calls for settings with no
 * bearing on a simulated link (transmit power, sleep, coexistence), answered
 * as the controller would.
 */
function closedSettings(): Record<string, () => number> {
  const ok = () => ESP_OK;
  // esp_power_level_t: the ESP32's default, +3 dBm.
  const level = () => 4;
  return {
    ble_txpwr_get: level, ble_txpwr_set: ok, bredr_txpwr_get: level, bredr_txpwr_set: ok,
    esp_ble_tx_power_get_enhanced: level, esp_ble_tx_power_set_enhanced: ok,
    btdm_controller_set_sleep_mode: ok, btdm_controller_get_sleep_mode: () => 0, btdm_controller_enable_sleep: ok,
    btdm_controller_is_enabled: () => 1, btdm_controller_get_mode: () => 1,
    bredr_sco_datapath_set: ok, btdm_controller_scan_duplicate_list_clear: ok,
  };
}
