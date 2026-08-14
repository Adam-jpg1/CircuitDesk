// The controllers, as data.
//
// Each entry is what is genuinely that chip's own: its geometry, its memory
// offsets, the pixel formats it accepts, and the vendor command opcodes it has
// along with how many parameters each takes. Everything they share is in
// tftController.ts.
//
// The vendor tables are deliberately not unioned. They are the reason an
// ST7789 initialisation sequence does not quietly drive a GC9A01: the opcodes
// overlap numerically and mean different things, and a controller handed one it
// does not have records it as unknown rather than consuming somebody else's
// parameter bytes and falling out of step with the stream. That is what happens
// on a bench, and it is what the negative tests here assert.
//
// Parameter counts come from each part's datasheet command table. Where a
// command's length is variable in the datasheet (gamma tables, mostly), the
// documented default length is used and the command has no visual effect
// either way.

import type { TftControllerSpec } from './tftController';

/** 16-bit RGB565. Every part here does this one; some do more. */
const PF_16BIT = 0x55;
/** 18-bit RGB666, sent as three bytes per pixel. */
const PF_18BIT = 0x66;
/** 12-bit RGB444. */
const PF_12BIT = 0x53;

export const ILI9341_SPEC: TftControllerSpec = {
  name: 'ILI9341',
  width: 240,
  height: 320,
  pixelFormats: [PF_16BIT, PF_18BIT],
  vendorCommands: {
    0xb1: 2, // frame rate control, normal mode
    0xb2: 2, // frame rate control, idle mode
    0xb4: 1, // display inversion control
    0xb6: 3, // display function control
    0xb7: 1, // entry mode set
    0xc0: 1, // power control 1
    0xc1: 1, // power control 2
    0xc5: 2, // VCOM control 1
    0xc7: 1, // VCOM control 2
    0xcb: 5, // power control A
    0xcf: 3, // power control B
    0xe0: 15, // positive gamma correction
    0xe1: 15, // negative gamma correction
    0xe8: 3, // driver timing control A
    0xea: 2, // driver timing control B
    0xed: 4, // power on sequence control
    0xf2: 1, // enable 3G
    0xf7: 1, // pump ratio control
  },
};

export const ST7735_SPEC: TftControllerSpec = {
  name: 'ST7735',
  width: 128,
  height: 160,
  // The visible panel is a corner of a 132x162 memory. A driver that omits the
  // offset draws everything shifted by two pixels with a coloured edge, which
  // is one of the most-asked questions about these modules.
  colOffset: 2,
  rowOffset: 1,
  pixelFormats: [PF_12BIT, PF_16BIT, PF_18BIT],
  vendorCommands: {
    0xb1: 3, // frame rate control, normal mode
    0xb2: 3, // frame rate control, idle mode
    0xb3: 6, // frame rate control, partial mode
    0xb4: 1, // display inversion control
    0xb6: 2, // display function set
    0xc0: 3, // power control 1
    0xc1: 1, // power control 2
    0xc2: 2, // power control 3
    0xc3: 2, // power control 4
    0xc4: 2, // power control 5
    0xc5: 1, // VCOM control
    0xe0: 16, // gamma positive
    0xe1: 16, // gamma negative
  },
};

export const ST7789_SPEC: TftControllerSpec = {
  name: 'ST7789',
  width: 240,
  height: 320,
  // The common 240x240 modules ship with the panel inverted; a driver that
  // does not send INVON on one of those gets a photographic negative.
  pixelFormats: [PF_12BIT, PF_16BIT, PF_18BIT],
  vendorCommands: {
    0xb0: 2, // RAM control
    0xb2: 5, // porch setting
    0xb7: 1, // gate control
    0xbb: 1, // VCOM setting
    0xc0: 1, // LCM control
    0xc2: 2, // VDV/VRH command enable
    0xc3: 1, // VRH set
    0xc4: 1, // VDV set
    0xc6: 1, // frame rate control in normal mode
    0xd0: 2, // power control 1
    0xe0: 14, // gamma positive
    0xe1: 14, // gamma negative
  },
};

export const GC9A01_SPEC: TftControllerSpec = {
  name: 'GC9A01',
  width: 240,
  height: 240,
  pixelFormats: [PF_12BIT, PF_16BIT, PF_18BIT],
  vendorCommands: {
    // The GC9A01's own register set. Numerically these collide with other
    // parts' commands and mean something else, which is precisely why each
    // controller carries its own table.
    0xfe: 0, // inter-register enable 1
    0xef: 0, // inter-register enable 2
    0x84: 1,
    0x85: 1,
    0x86: 1,
    0x87: 1,
    0x88: 1,
    0x89: 1,
    0x8a: 1,
    0x8b: 1,
    0x8c: 1,
    0x8d: 1,
    0x8e: 1,
    0x8f: 1,
    0xb6: 2, // display function control
    0xa4: 2,
    0xa5: 2,
    0xba: 1,
    0xbe: 1,
    0xcd: 1,
    0xc3: 1, // power control 2
    0xc4: 1, // power control 3
    0xc9: 1, // power control 4
    0xe8: 1, // frame rate
    0xe9: 3,
    0xec: 1,
    0xf0: 6, // SET_GAMMA1
    0xf1: 6, // SET_GAMMA2
    0xf2: 6, // SET_GAMMA3
    0xf3: 6, // SET_GAMMA4
    0xff: 3,
  },
};

/**
 * The SSD1331, which is the odd one out and gets its own device rather than
 * this spec shape.
 *
 * Its command set is not MIPI DCS at all: the address window is 0x15/0x75
 * rather than CASET/RASET, there is no RAMWR — data simply follows — and it has
 * hardware drawing commands for lines and rectangles. Forcing it through the
 * shared decoder would mean inventing a translation, so it does not use one.
 * See ssd1331.ts.
 */
export const SSD1331_NOTE =
  'The SSD1331 uses a different command set and is modelled separately.';
