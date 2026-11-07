// The mask ROM's GPIO routines, for the ESP32-C3 and the ESP32-C6.
//
// ESP-IDF routes every peripheral signal through these: esp_rom_gpio_connect_
// out_signal is gpio_matrix_out, esp_rom_gpio_connect_in_signal is
// gpio_matrix_in, and esp_rom_gpio_pad_select_gpio hands a pad to the matrix.
// Without them analogWrite(), tone(), Wire and SPI stopped at the first pin
// they attached, with an unimplemented-ROM-call error.
//
// Each is implemented from its documented contract (esp_rom_gpio.h) as writes
// to the GPIO matrix and IO MUX registers, so the GPIO model sees exactly what
// it would if the ROM's own code had run. The two chips share the routines and
// differ in where the blocks sit and in the width of a FUNCn_IN_SEL_CFG field.

import type { RomCallContext, RomFunction } from '../esp32c3/romFunctions';

export interface RomGpioLayout {
  gpioBase: number;
  ioMuxBase: number;
  /** Mask of the GPIO number in FUNCn_IN_SEL_CFG, then the invert and route-through-matrix bits. */
  inSelMask: number;
  inInvBit: number;
  inSigSelBit: number;
}

export const ESP32C3_ROM_GPIO_LAYOUT: RomGpioLayout = {
  gpioBase: 0x60004000,
  ioMuxBase: 0x60009000,
  inSelMask: 0x1f,
  inInvBit: 5,
  inSigSelBit: 6,
};

export const ESP32C6_ROM_GPIO_LAYOUT: RomGpioLayout = {
  gpioBase: 0x60091000,
  ioMuxBase: 0x60090000,
  inSelMask: 0x3f,
  inInvBit: 6,
  inSigSelBit: 7,
};

const GPIO_OUT_W1TS = 0x08;
const GPIO_OUT_W1TC = 0x0c;
const GPIO_ENABLE_W1TS = 0x24;
const GPIO_ENABLE_W1TC = 0x28;
const GPIO_IN = 0x3c;
const GPIO_FUNC_IN_SEL_BASE = 0x154;
const GPIO_FUNC_OUT_SEL_BASE = 0x554;
const OUT_INV_SEL = 1 << 8;
const OEN_INV_SEL = 1 << 10;

const IO_MUX_PIN_BASE = 0x04;
const FUN_PD = 1 << 7;
const FUN_PU = 1 << 8;
const FUN_IE = 1 << 9;
const FUN_DRV_SHIFT = 10;
const MCU_SEL_SHIFT = 12;
const MCU_SEL_MASK = 0x7 << MCU_SEL_SHIFT;
const PIN_FUNC_GPIO = 1;

/** The ROM's routines, bound to one chip's layout and its published addresses. */
export function romGpioFunctions(layout: RomGpioLayout, addresses: Record<string, number>): RomFunction[] {
  const pad = (gpio: number) => layout.ioMuxBase + IO_MUX_PIN_BASE + (gpio >>> 0) * 4;
  const updatePad = (ctx: RomCallContext, gpio: number, change: (v: number) => number) => {
    const at = pad(gpio);
    ctx.bus.writeUint32(at, change(ctx.bus.readUint32(at) >>> 0) >>> 0);
  };

  const handlers: Record<string, Omit<RomFunction, 'address' | 'name'>> = {
    gpio_matrix_out: {
      // gpio_matrix_out(gpio, signal_idx, out_inv, oen_inv): the signal drives
      // the pad, with the enable from the peripheral (OEN_SEL clear) — and,
      // as the header says, output is then enabled on the pad.
      handler: ({ args, bus }) => {
        const [gpio, signal, outInv, oenInv] = args;
        const config = (signal & 0xff) | (outInv ? OUT_INV_SEL : 0) | (oenInv ? OEN_INV_SEL : 0);
        bus.writeUint32(layout.gpioBase + GPIO_FUNC_OUT_SEL_BASE + (gpio >>> 0) * 4, config);
        if (gpio >>> 0 < 32) bus.writeUint32(layout.gpioBase + GPIO_ENABLE_W1TS, 1 << gpio);
      },
      rationale: 'Routes a peripheral output signal to a pad through the GPIO matrix and enables the pad output.',
    },
    gpio_matrix_in: {
      // gpio_matrix_in(gpio, signal_idx, inv): the signal reads the pad. A
      // gpio of 0x1F/0x3F or 0x1E/0x3E is the constant high or low input.
      handler: ({ args, bus }) => {
        const [gpio, signal, inv] = args;
        const config = ((gpio >>> 0) & layout.inSelMask) | (inv ? 1 << layout.inInvBit : 0) | (1 << layout.inSigSelBit);
        bus.writeUint32(layout.gpioBase + GPIO_FUNC_IN_SEL_BASE + (signal >>> 0) * 4, config);
      },
      rationale: 'Routes a pad to a peripheral input signal through the GPIO matrix.',
    },
    gpio_pad_select_gpio: {
      handler: (ctx) => updatePad(ctx, ctx.args[0], (v) => (v & ~MCU_SEL_MASK) | (PIN_FUNC_GPIO << MCU_SEL_SHIFT)),
      rationale: 'Hands the pad to the GPIO matrix (IO MUX function 1).',
    },
    gpio_pad_pullup: {
      handler: (ctx) => updatePad(ctx, ctx.args[0], (v) => (v | FUN_PU) & ~FUN_PD),
      rationale: 'Pull-up only, as esp_rom_gpio_pad_pullup_only says.',
    },
    gpio_pad_pulldown: {
      handler: (ctx) => updatePad(ctx, ctx.args[0], (v) => (v | FUN_PD) & ~FUN_PU),
      rationale: 'Pull-down only.',
    },
    gpio_pad_input_enable: {
      handler: (ctx) => updatePad(ctx, ctx.args[0], (v) => v | FUN_IE),
      rationale: 'Turns on the pad input buffer.',
    },
    gpio_pad_input_disable: {
      handler: (ctx) => updatePad(ctx, ctx.args[0], (v) => v & ~FUN_IE),
      rationale: 'Turns off the pad input buffer.',
    },
    gpio_pad_set_drv: {
      handler: (ctx) => updatePad(ctx, ctx.args[0], (v) => (v & ~(0x3 << FUN_DRV_SHIFT)) | ((ctx.args[1] & 0x3) << FUN_DRV_SHIFT)),
      rationale: 'Sets the pad drive strength field; strength has no effect on a simulated level.',
    },
    gpio_pad_hold: {
      handler: () => undefined,
      rationale: 'Pad hold matters across sleep, which is not modelled; a running pad behaves the same held or not.',
    },
    gpio_pad_unhold: {
      handler: () => undefined,
      rationale: 'The counterpart of gpio_pad_hold.',
    },
    gpio_output_set: {
      // gpio_output_set(set_mask, clear_mask, enable_mask, disable_mask)
      handler: ({ args, bus }) => {
        const [set, clear, enable, disable] = args;
        bus.writeUint32(layout.gpioBase + GPIO_OUT_W1TS, set >>> 0);
        bus.writeUint32(layout.gpioBase + GPIO_OUT_W1TC, clear >>> 0);
        bus.writeUint32(layout.gpioBase + GPIO_ENABLE_W1TS, enable >>> 0);
        bus.writeUint32(layout.gpioBase + GPIO_ENABLE_W1TC, disable >>> 0);
      },
      rationale: 'Sets, clears, enables and disables outputs by mask through the W1TS/W1TC registers.',
    },
    gpio_input_get: {
      handler: ({ bus }) => bus.readUint32(layout.gpioBase + GPIO_IN) >>> 0,
      rationale: 'Reads GPIO_IN.',
    },
  };

  return Object.entries(handlers).map(([name, entry]) => {
    const address = addresses[name];
    if (address === undefined) throw new Error(`No ROM address is published for ${name}`);
    return { address: address >>> 0, name, ...entry };
  });
}

/** The C3's addresses, from esp32c3.rom.ld. */
export const ESP32C3_ROM_GPIO_ADDRESSES: Record<string, number> = {
  gpio_input_get: 0x4000059c,
  gpio_matrix_in: 0x400005a0,
  gpio_matrix_out: 0x400005a4,
  gpio_output_set: 0x400005b0,
  gpio_pad_hold: 0x400005b4,
  gpio_pad_input_disable: 0x400005b8,
  gpio_pad_input_enable: 0x400005bc,
  gpio_pad_pulldown: 0x400005c0,
  gpio_pad_pullup: 0x400005c4,
  gpio_pad_select_gpio: 0x400005c8,
  gpio_pad_set_drv: 0x400005cc,
  gpio_pad_unhold: 0x400005d0,
};

/** The C6's addresses, from esp32c6.rom.ld. */
export const ESP32C6_ROM_GPIO_ADDRESSES: Record<string, number> = {
  gpio_input_get: 0x400006d4,
  gpio_matrix_in: 0x400006d8,
  gpio_matrix_out: 0x400006dc,
  gpio_output_set: 0x400006e8,
  gpio_pad_hold: 0x400006ec,
  gpio_pad_input_disable: 0x400006f0,
  gpio_pad_input_enable: 0x400006f4,
  gpio_pad_pulldown: 0x400006f8,
  gpio_pad_pullup: 0x400006fc,
  gpio_pad_select_gpio: 0x40000700,
  gpio_pad_set_drv: 0x40000704,
  gpio_pad_unhold: 0x40000708,
};
