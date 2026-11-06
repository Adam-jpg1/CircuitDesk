// The Bluetooth air a simulation world has, and the address each board has on it.

import { macForBoard } from '../wifi/network';

export { BleAir, BleController, addressString, advertisedName, type BleDeviceView, type BleLinkEnd } from './controller';

/**
 * A board's public Bluetooth address, least significant byte first as HCI
 * carries it. Espressif derives it from the base MAC plus two, and the Pico W's
 * CYW43 from its own; here it follows the board instance, so it stays the same
 * across runs and differs between boards.
 */
export function bluetoothAddressFor(id: string, oui?: readonly number[]): Uint8Array {
  const mac = macForBoard(id, oui);
  mac[5] = (mac[5] + 2) & 0xff;
  return Uint8Array.from(mac).reverse();
}
