// The ESP32-C6's peripherals.
//
// Blocks whose register layout is genuinely identical to the C3's are the same
// class at a different base — the system timer and the GPIO/IO MUX pair are
// documented word for word alike, and duplicating them would mean two copies of
// the same bug. Blocks that differ get their own implementation: the flash MMU
// and the interrupt controller both do, and neither difference is cosmetic.
//
// What is *not* here is as deliberate as what is. Nothing is added
// speculatively; a block appears once real C6 firmware is shown to touch it,
// which is how the C3's set was built too. An address no block claims reads as
// zero and is reported through the machine's unclaimed-MMIO callback, so
// firmware that needs something missing stops visibly rather than continuing on
// invented data.
//
// Base addresses are from `soc/esp32c6/include/soc/reg_base.h`.

import { EspUart, ESP32C6_UART_LAYOUT } from '../espRiscv/uart';
import { EspSarAdc, ESP32C6_SAR_ADC } from '../espRiscv/sarAdc';
import { RegisterFile } from '../esp32c3/registerFile';
import { SysTimer, TimerGroup } from '../esp32c3/peripherals';
import { SpiMemController } from '../esp32c3/spiMem';
import { Esp32C3Gpio } from '../esp32c3/gpio';
import type { Peripheral, SimulatedClock } from '../espRiscv/peripheral';
import type { SerialNorFlash } from '../esp32c3/spiFlash';
import { Esp32C6FlashMmu, ESP32C6_SPI1_BASE } from './flashMmu';
import { Esp32C6InterruptController, ESP32C6_INTERRUPT_SOURCE } from './interrupts';
import { Esp32C6LpTimer } from './lpTimer';
import { Esp32C6AnalogMaster } from './analogMaster';
import { Esp32C6Pcr } from './pcr';

/** Documented ESP32-C6 peripheral base addresses. */
export const ESP32C6_PERIPHERAL_BASE = {
  uart0: 0x60000000,
  uart1: 0x60001000,
  // SPI0 is the cache controller here; on the C3 this address is SPI1.
  spi0: 0x60002000,
  // SPI1 is the one ESP-IDF drives to reach the flash; the two have swapped.
  spi1: ESP32C6_SPI1_BASE,
  i2c0: 0x60004000,
  timg0: 0x60008000,
  timg1: 0x60009000,
  systimer: 0x6000a000,
  apbSaradc: 0x6000e000,
  usbSerialJtag: 0x6000f000,
  interruptMatrix: 0x60010000,
  spi2: 0x60081000,
  ioMux: 0x60090000,
  gpio: 0x60091000,
  /** PCR replaces the C3's SYSTEM block for clock and reset control. */
  pcr: 0x60096000,
  /** Where the first execution spike saw the firmware write. */
  assistDebug: 0x600c2000,
  intpri: 0x600c5000,
  /** The RISC-V PLIC, which is the CPU interrupt controller on this part. */
  plic: 0x20001000,
  extMem: 0x600c8000,
  /**
   * The modem clock blocks, which the C3 has no counterpart for.
   *
   * Startup writes MODEM_LPCON_CLK_CONF_REG here to enable the analog I²C
   * master's clock and then asserts that it reads back — `regi2c_enable_block`
   * in `esp_rom_hp_regi2c_esp32c6.c` calls `regi2c_ctrl_ll_master_is_clock_
   * enabled()`, which is `MODEM_LPCON.clk_conf.clk_i2c_mst_en`. With nothing at
   * this address the write is dropped, the read returns zero and the assertion
   * aborts the boot. Found by running the firmware, not by guessing.
   * (`soc/esp32c6/include/modem/reg_base.h`, `.../modem_lpcon_reg.h`.)
   */
  modemSyscon: 0x600a9800,
  modemLpcon: 0x600af000,
  /** The analog I²C master itself, reached through regi2c. */
  i2cAnaMst: 0x600af800,
  /** The low-power peripherals, which the C3 has no counterpart for. */
  pmu: 0x600b0000,
  lpClkRst: 0x600b0400,
  efuse: 0x600b0800,
  lpTimer: 0x600b0c00,
  lpAon: 0x600b1000,
  lpWdt: 0x600b1c00,
  lpIo: 0x600b2000,
  lpPeri: 0x600b2800,
  lpAnalogPeri: 0x600b2c00,
} as const;

/** The C6 has 31 GPIOs, `SOC_GPIO_PIN_COUNT = 31`. */
export const ESP32C6_GPIO_COUNT = 31;

/** The GPIO block and its IO MUX, at the C6's addresses. */
export function esp32c6Gpio(clock: SimulatedClock): Esp32C3Gpio {
  return new Esp32C3Gpio(clock, {
    base: ESP32C6_PERIPHERAL_BASE.gpio,
    ioMuxBase: ESP32C6_PERIPHERAL_BASE.ioMux,
    pinCount: ESP32C6_GPIO_COUNT,
  });
}

export interface Esp32C6Peripherals {
  peripherals: Peripheral[];
  gpio: Esp32C3Gpio;
  uart0: EspUart;
  adc: EspSarAdc;
  interrupts: Esp32C6InterruptController;
  mmu: Esp32C6FlashMmu;
}

/**
 * Builds the peripheral set an ESP32-C6 machine needs to start.
 *
 * The GPIO block and the interrupt controller are returned alongside the list
 * because callers need to talk to them directly — a runner drives pads through
 * the first and nothing else can reach the second's two halves as one object.
 */
export function createEsp32C6Peripherals(clock: SimulatedClock, flash?: SerialNorFlash): Esp32C6Peripherals {
  const mmu = new Esp32C6FlashMmu();
  const interrupts = new Esp32C6InterruptController();
  const gpio = esp32c6Gpio(clock);
  // UART0: Serial, through the IDF driver.
  // Its clock source and divider live in PCR on this part (PCR_UART0_SCLK_CONF).
  const pcr = new Esp32C6Pcr();
  const adc = new EspSarAdc(ESP32C6_SAR_ADC);
  const uart0 = new EspUart('uart0', ESP32C6_PERIPHERAL_BASE.uart0, clock, ESP32C6_INTERRUPT_SOURCE.uart0, ESP32C6_UART_LAYOUT, () =>
    pcr.readUint32(0x4),
  );

  const peripherals: Peripheral[] = [
    // SPI0 is the cache's own controller and carries the MMU's access port, so
    // the two are one block on this part.
    mmu,
    ...(flash ? [new SpiMemController(flash, ESP32C6_PERIPHERAL_BASE.spi1)] : []),
    new TimerGroup('timg0', ESP32C6_PERIPHERAL_BASE.timg0),
    new TimerGroup('timg1', ESP32C6_PERIPHERAL_BASE.timg1),
    ...interrupts.peripherals,
    // PCR is not storage that starts at zero: 76 of its registers have a
    // documented non-zero reset value, and firmware asserts on some of them.
    pcr,
    new RegisterFile('assist_debug', ESP32C6_PERIPHERAL_BASE.assistDebug, 0x1000),
    new RegisterFile('extmem', ESP32C6_PERIPHERAL_BASE.extMem, 0x1000),
    // The modem clock control blocks. Configuration registers: startup enables
    // a clock here and asserts that it reads back.
    new RegisterFile('modem_syscon', ESP32C6_PERIPHERAL_BASE.modemSyscon, 0x800),
    new RegisterFile('modem_lpcon', ESP32C6_PERIPHERAL_BASE.modemLpcon, 0x800),
    // The analog master is not storage: the BBPLL calibration handshake runs
    // through it, and startup waits for it.
    new Esp32C6AnalogMaster(clock),
    // The low-power domain: PMU, the LP clock and reset controller, eFuse,
    // AON, the watchdog and the analog peripherals sit in one contiguous
    // stretch the C3 has nothing at. Configuration registers, so storage.
    new RegisterFile('lp_peripherals', ESP32C6_PERIPHERAL_BASE.pmu, 0x4000),
    // The LP timer is inside that stretch and is not storage: it is the
    // chip's always-on clock, and everything that asks what time it is reads
    // it. Registered after the block above so it wins for its own range.
    new Esp32C6LpTimer(clock),
    gpio,
    gpio.ioMux,
    new SysTimer(clock, ESP32C6_PERIPHERAL_BASE.systimer, ESP32C6_INTERRUPT_SOURCE.systimerTarget0),
    uart0,
    // The SAR ADC's one-shot path: analogRead().
    adc,
  ];

  return { peripherals, gpio, uart0, adc, interrupts, mmu };
}
