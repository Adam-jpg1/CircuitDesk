// Where an ESP build's Wi-Fi driver landed, for the simulator.
//
// Espressif's Wi-Fi driver is closed source: libnet80211, libpp and their
// companions are shipped as binaries and run a radio the simulator does not
// have. Everything above them — lwIP, esp_netif, the event loop, Arduino's
// WiFi library — is ordinary code in the firmware. So the simulator provides
// the driver's entry points natively and leaves the rest to run as built.
//
// To do that it needs the addresses: every function the closed archives
// contributed to this build (so each can be answered, or stopped with a clear
// message rather than run against a radio that is not there), and a few named
// routines it calls back into (the event loop, the heap, task creation). The
// linker map says which address ranges came from the closed archives; the
// ELF's symbol table names the functions in them.
//
// A build that does not link the driver sends nothing.

import { readFile } from 'node:fs/promises';
import { parseElf32 } from './elfSymbols.js';

export interface FirmwareSymbols {
  /** Functions from the closed Wi-Fi archives: [name, address]. */
  closed: [string, number][];
  /** Open routines and data the simulator uses, by name. */
  named: Record<string, number>;
}

/** The closed-source archives of ESP-IDF's Wi-Fi stack and of the ESP8266 SDK. */
const CLOSED_ARCHIVES = /(?:^|[/\\])lib(net80211|pp|core|mesh|espnow|smartconfig|wapi|coexist|phy|wpa|wps|crypto|main|airkiss)\.a\(/;

/** Open routines and data the Wi-Fi model reaches by name. */
export const NAMED_SYMBOLS = [
  // ESP-IDF: the driver's open wrapper, and what the model calls back into.
  'esp_wifi_init', 'esp_wifi_deinit', 'WIFI_EVENT', 'esp_event_post', 'malloc', 'free',
  'xTaskCreatePinnedToCore', 'vTaskDelay',
  // The ESP8266 core: lwIP2's glue to the SDK, both ways.
  'esp2glue_netif_set_up1down0', 'esp2glue_netif_update', 'esp2glue_ethernet_input', 'esp2glue_alloc_for_recv',
  'esp2glue_dhcp_start', 'esp2glue_dhcp_stop', 'esp2glue_pbuf_freed', 'glue2esp_linkoutput', 'glue2esp_ifupdown',
  // The Pico W: cyw43-driver's bus transfer and host-wake read, where the CYW43439 model sits.
  'cyw43_spi_transfer', 'cyw43_cb_read_host_interrupt_pin',
];

/**
 * The Pico W's: a build that drives a CYW43 carries its open driver, whose bus
 * routine is where the simulator's chip model answers. No closed code runs on
 * the RP2040 itself, so there is nothing else to send.
 */
export function cyw43SymbolsFrom(elfBytes: Uint8Array): FirmwareSymbols | undefined {
  const elf = parseElf32(elfBytes);
  if (!elf) return undefined;
  const named: Record<string, number> = {};
  for (const s of elf.symbols) {
    if ((s.name === 'cyw43_spi_transfer' || s.name === 'cyw43_cb_read_host_interrupt_pin') && s.value) named[s.name] = s.value >>> 0;
  }
  return named.cyw43_spi_transfer ? { closed: [], named } : undefined;
}

/** Reads the Pico W symbols from the .elf an arduino-cli build wrote, if it is there. */
export async function readCyw43Symbols(elfPath: string | undefined): Promise<FirmwareSymbols | undefined> {
  if (!elfPath) return undefined;
  try {
    return cyw43SymbolsFrom(new Uint8Array(await readFile(elfPath)));
  } catch {
    return undefined;
  }
}

/** Upper bound on what is sent, so a pathological build cannot bloat the response. */
const MAX_CLOSED = 6000;

/** Address ranges the closed archives occupy, from a GNU ld map. */
export function closedRangesFromMap(map: string): [number, number][] {
  const ranges: [number, number][] = [];
  for (const line of map.split('\n')) {
    if (!CLOSED_ARCHIVES.test(line)) continue;
    const m = /\s(0x[0-9a-f]+)\s+(0x[0-9a-f]+)\s+\S/i.exec(line);
    if (!m) continue;
    const start = parseInt(m[1], 16);
    const size = parseInt(m[2], 16);
    if (start !== 0 && size > 0) ranges.push([start, start + size]);
  }
  return ranges.sort((a, b) => a[0] - b[0]);
}

export function firmwareSymbolsFrom(elfBytes: Uint8Array, map: string): FirmwareSymbols | undefined {
  const elf = parseElf32(elfBytes);
  if (!elf) return undefined;
  const ranges = closedRangesFromMap(map);
  if (ranges.length === 0) return undefined;
  const inClosed = (a: number) => {
    let lo = 0;
    let hi = ranges.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (a < ranges[mid][0]) hi = mid - 1;
      else if (a >= ranges[mid][1]) lo = mid + 1;
      else return true;
    }
    return false;
  };
  const closed = new Map<number, string>();
  const named: Record<string, number> = {};
  const wanted = new Set(NAMED_SYMBOLS);
  for (const s of elf.symbols) {
    if (wanted.has(s.name) && s.value) named[s.name] = s.value >>> 0;
    if (s.type !== 2 || !s.value) continue;
    // RISC-V and Xtensa function addresses are even; the low bit never marks a mode here.
    if (inClosed(s.value) && !closed.has(s.value)) closed.set(s.value, s.name);
  }
  if (closed.size === 0 || closed.size > MAX_CLOSED) return undefined;
  return { closed: [...closed].map(([address, name]) => [name, address]), named };
}

/** Reads the .elf and .map an arduino-cli build wrote, if both are there. */
export async function readFirmwareSymbols(elfPath: string | undefined, mapPath: string | undefined): Promise<FirmwareSymbols | undefined> {
  if (!elfPath || !mapPath) return undefined;
  try {
    const [elf, map] = await Promise.all([readFile(elfPath), readFile(mapPath, 'utf8')]);
    return firmwareSymbolsFrom(new Uint8Array(elf), map);
  } catch {
    return undefined;
  }
}
