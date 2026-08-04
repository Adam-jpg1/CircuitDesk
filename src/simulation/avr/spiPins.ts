// Where each supported AVR bonds out its hardware SPI lines.
//
// SCK/MOSI/MISO are fixed port pins on the silicon, so they are derived from
// the MCU rather than read from board metadata: the board files only carry an
// unordered `spiPins` list, and their order differs per board (the Uno lists
// SS first, the Mega lists MISO first). Resolving through the port map gives
// the right Arduino pin number on every board without touching any board
// definition.

import type { AvrBoardProfile, AvrPortName } from '../../boards/pinMaps';

interface SpiPortPins {
  sck: [AvrPortName, number];
  mosi: [AvrPortName, number];
  miso: [AvrPortName, number];
}

const SPI_PORT_PINS: Record<AvrBoardProfile['mcu'], SpiPortPins> = {
  // ATmega328P: SCK=PB5 (D13), MOSI=PB3 (D11), MISO=PB4 (D12).
  atmega328p: { sck: ['B', 5], mosi: ['B', 3], miso: ['B', 4] },
  // ATmega2560: SCK=PB1 (D52), MOSI=PB2 (D51), MISO=PB3 (D50).
  atmega2560: { sck: ['B', 1], mosi: ['B', 2], miso: ['B', 3] },
  // ATmega32U4: SCK=PB1, MOSI=PB2, MISO=PB3 — reachable on the Leonardo only
  // through the ICSP header, which the board maps to D15/D16/D14.
  atmega32u4: { sck: ['B', 1], mosi: ['B', 2], miso: ['B', 3] },
};

export interface BoardSpiPins {
  sck: number | undefined;
  mosi: number | undefined;
  miso: number | undefined;
}

/** Arduino pin numbers for this board's hardware SPI lines. */
export function spiPinsFor(profile: AvrBoardProfile): BoardSpiPins {
  const spec = SPI_PORT_PINS[profile.mcu];
  const find = (want: [AvrPortName, number] | undefined): number | undefined => {
    if (!want) return undefined;
    for (const [pinStr, ref] of Object.entries(profile.portMap)) {
      if (ref.port === want[0] && ref.index === want[1]) return Number(pinStr);
    }
    return undefined;
  };
  return { sck: find(spec?.sck), mosi: find(spec?.mosi), miso: find(spec?.miso) };
}
