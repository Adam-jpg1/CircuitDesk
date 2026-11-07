// The STMicroelectronics STM32F401RE, the Nucleo-64's chip, on the ARMv7-M core.
//
// Modelled from the STM32F401 reference manual (RM0368) and the CMSIS device
// header the STM32duino core is compiled against, at the level that core, its
// HAL and its libraries actually use:
//
//   * RCC: oscillator and PLL ready flags, the system clock switch, and the
//     peripheral clock enables (which read back, as the HAL checks). The CPU
//     is taken to run at 84 MHz, the clock the Nucleo variant sets up before
//     setup(); both APB timer clocks are 84 MHz with that configuration.
//   * FLASH: the access-control register the HAL reads back, and real sector
//     erase and programming behind the unlock sequence — the EEPROM library
//     keeps its data in the last sector this way.
//   * GPIOA-E and H: mode, output type, pulls, alternate functions, BSRR; and
//     EXTI with SYSCFG's port selection, which attachInterrupt runs on.
//   * USART1, USART2 and USART6: the v1 register layout, interrupt driven,
//     bytes paced at the programmed baud. USART2 is Serial, which on a Nucleo
//     goes to the ST-LINK's virtual COM port.
//   * TIM1-5 and TIM9-11: up-counting with prescaler, auto-reload and compare
//     preloads, output compare and PWM modes on every channel (complementary
//     outputs on TIM1), update and compare interrupts. analogWrite, tone and
//     Servo all run on these through HardwareTimer.
//   * ADC1: single software-triggered conversions, 12 bits against 3.3 V, plus
//     the internal reference and temperature channels.
//   * I2C1-3: the v1 master with its event flags (SB, ADDR, TXE, RXNE, BTF)
//     and acknowledge failure, interrupt driven as the HAL drives it.
//   * SPI1-4 as masters, 8 or 16 bit frames, either bit order.
//   * The device ID, unique ID and flash-size registers.

import { CortexM } from '../armv7m/cortexM';
import type { MemoryRegion } from '../armv7m/bus';
import type { ArmMcu, I2cMasterHooks, McuSerial } from '../armv7m/armRunner';
import { EventQueue, Pads, Periph, PeriphBus, NOT_DRIVEN } from '../armv7m/peripherals';

export const STM32F4_HZ = 84_000_000;
export const STM32F4_FLASH_BASE = 0x08000000;
export const STM32F4_FLASH_BYTES = 512 * 1024;
const SRAM_BASE = 0x20000000;
const SRAM_BYTES = 96 * 1024;
/** Ports A-H, sixteen pads each (F, G are absent on this package). */
export const STM32F4_PAD_COUNT = 128;

/** PA0 is 0, PC13 is 45: port * 16 + bit. */
export function stm32PadIndex(pad: string): number | undefined {
  const m = /^P([A-H])(\d{1,2})$/.exec(pad);
  if (!m) return undefined;
  const bit = Number(m[2]);
  if (bit > 15) return undefined;
  return (m[1].charCodeAt(0) - 65) * 16 + bit;
}

const pad = (name: string) => stm32PadIndex(name)!;

/** ADC1 channel behind each pad (IN0-IN15). */
export const STM32F4_ADC_BY_PAD: Record<number, number> = {
  [pad('PA0')]: 0, [pad('PA1')]: 1, [pad('PA2')]: 2, [pad('PA3')]: 3, [pad('PA4')]: 4, [pad('PA5')]: 5,
  [pad('PA6')]: 6, [pad('PA7')]: 7, [pad('PB0')]: 8, [pad('PB1')]: 9, [pad('PC0')]: 10, [pad('PC1')]: 11,
  [pad('PC2')]: 12, [pad('PC3')]: 13, [pad('PC4')]: 14, [pad('PC5')]: 15,
};

/** Internal ADC channels: the temperature sensor (16/18) and VREFINT (17). */
const TEMP_SENSOR_VOLTS = 0.76; // 25 °C
const VREFINT_VOLTS = 1.21;

/** NVIC lines (RM0368 table 38). */
const IRQ = {
  EXTI0: 6, EXTI1: 7, EXTI2: 8, EXTI3: 9, EXTI4: 10, ADC: 18, EXTI9_5: 23,
  TIM1_BRK_TIM9: 24, TIM1_UP_TIM10: 25, TIM1_TRG_COM_TIM11: 26, TIM1_CC: 27, TIM2: 28, TIM3: 29, TIM4: 30,
  I2C1_EV: 31, I2C1_ER: 32, I2C2_EV: 33, I2C2_ER: 34, SPI1: 35, SPI2: 36, USART1: 37, USART2: 38,
  EXTI15_10: 40, TIM5: 50, SPI3: 51, USART6: 71, I2C3_EV: 72, I2C3_ER: 73, SPI4: 84,
} as const;

/**
 * Pad functions that drive a pad, by pad and alternate function number, from
 * the core's PeripheralPins.c for this package. Inputs (RX, MISO) drive
 * nothing and are not listed.
 */
const AF_OUTPUTS =
  'PA0:1:TIM2_CH1 PA0:2:TIM5_CH1 PA10:1:TIM1_CH3 PA11:1:TIM1_CH4 PA11:8:USART6_TX PA15:1:TIM2_CH1 PA1:1:TIM2_CH2 ' +
  'PA1:2:TIM5_CH2 PA2:1:TIM2_CH3 PA2:2:TIM5_CH3 PA2:3:TIM9_CH1 PA2:7:USART2_TX PA3:1:TIM2_CH4 PA3:2:TIM5_CH4 ' +
  'PA3:3:TIM9_CH2 PA5:1:TIM2_CH1 PA5:5:SPI1_SCK PA6:2:TIM3_CH1 PA7:1:TIM1_CH1N PA7:2:TIM3_CH2 PA7:5:SPI1_MOSI ' +
  'PA8:1:TIM1_CH1 PA8:4:I2C3_SCL PA9:1:TIM1_CH2 PA9:7:USART1_TX PB0:1:TIM1_CH2N PB0:2:TIM3_CH3 PB10:1:TIM2_CH3 ' +
  'PB10:4:I2C2_SCL PB10:5:SPI2_SCK PB13:1:TIM1_CH1N PB13:5:SPI2_SCK PB14:1:TIM1_CH2N PB15:1:TIM1_CH3N ' +
  'PB15:5:SPI2_MOSI PB1:1:TIM1_CH3N PB1:2:TIM3_CH4 PB3:1:TIM2_CH2 PB3:5:SPI1_SCK PB3:6:SPI3_SCK PB3:9:I2C2_SDA ' +
  'PB4:2:TIM3_CH1 PB4:9:I2C3_SDA PB5:2:TIM3_CH2 PB5:5:SPI1_MOSI PB5:6:SPI3_MOSI PB6:2:TIM4_CH1 PB6:4:I2C1_SCL ' +
  'PB6:7:USART1_TX PB7:2:TIM4_CH2 PB7:4:I2C1_SDA PB8:2:TIM4_CH3 PB8:3:TIM10_CH1 PB8:4:I2C1_SCL PB9:2:TIM4_CH4 ' +
  'PB9:3:TIM11_CH1 PB9:4:I2C1_SDA PC10:6:SPI3_SCK PC12:6:SPI3_MOSI PC3:5:SPI2_MOSI PC6:2:TIM3_CH1 PC6:8:USART6_TX ' +
  'PC7:2:TIM3_CH2 PC8:2:TIM3_CH3 PC9:2:TIM3_CH4 PC9:4:I2C3_SDA';

/** Sectors of the 512 KB flash: four of 16 KB, one of 64 KB, three of 128 KB. */
const SECTORS: [number, number][] = [
  [0x00000, 0x4000], [0x04000, 0x4000], [0x08000, 0x4000], [0x0c000, 0x4000],
  [0x10000, 0x10000], [0x20000, 0x20000], [0x40000, 0x20000], [0x60000, 0x20000],
];

/** A U(S)ART as the runner sees it. */
export type Stm32Serial = McuSerial;

export class Stm32f4 implements ArmMcu {
  readonly hz = STM32F4_HZ;
  readonly adcReference = 3.3;
  readonly flash = new Uint8Array(STM32F4_FLASH_BYTES).fill(0xff);
  /** Flash, which the EEPROM library programs. */
  get nonVolatile(): Uint8Array[] {
    return [this.flash];
  }
  readonly sram = new Uint8Array(SRAM_BYTES);
  readonly regions: MemoryRegion[];
  readonly bus = new PeriphBus();
  readonly pads = new Pads(STM32F4_PAD_COUNT);
  readonly core: CortexM;
  readonly events: EventQueue;
  /** IN0-IN15 from the pads; 16-18 are internal and fixed. */
  readonly adcVolts = new Float64Array(16);
  readonly serials: Stm32Serial[] = [];
  i2c: I2cMasterHooks | null = null;
  spiTransfer: ((mosi: number, mode: 0 | 1 | 2 | 3) => number) | null = null;

  readonly moder = new Uint32Array(8);
  readonly otyper = new Uint32Array(8);
  readonly pupdr = new Uint32Array(8);
  readonly odr = new Uint32Array(8);
  readonly afr = new Uint32Array(16);
  /** What drives a pad in alternate-function mode, by `pad * 16 + af`. */
  private readonly afDrive = new Map<number, () => number>();
  /** Which named function each pad's alternate function numbers select. */
  private readonly afName = new Map<number, string>();
  private readonly irqSources = new Map<number, Set<string>>();
  private usart2!: StmUsart;
  private exti!: Exti;

  constructor() {
    this.regions = [
      { start: STM32F4_FLASH_BASE, end: STM32F4_FLASH_BASE + STM32F4_FLASH_BYTES, bytes: this.flash, readOnly: true },
      { start: SRAM_BASE, end: SRAM_BASE + SRAM_BYTES, bytes: this.sram },
      // Booting from main flash maps it at 0 as well.
      { start: 0, end: STM32F4_FLASH_BYTES, bytes: this.flash, readOnly: true },
    ];
    this.core = new CortexM(this, { variant: 'm4', fpu: 'sp', irqCount: 86, priorityBits: 4, cpuid: 0x410fc241 });
    this.events = new EventQueue(() => this.core.cycles);
    for (const entry of AF_OUTPUTS.split(' ')) {
      const [p, af, fn] = entry.split(':');
      this.afName.set(pad(p) * 16 + Number(af), fn);
    }
    // Reset state: PA13-PA15 and PB3-PB4 belong to the debug port, with its pulls.
    this.moder[0] = 0xa8000000;
    this.pupdr[0] = 0x64000000;
    this.moder[1] = 0x00000280;
    this.pupdr[1] = 0x00000100;
    this.buildPeripherals();
    for (let pin = 0; pin < STM32F4_PAD_COUNT; pin++) this.refreshPad(pin);
    this.exti.pr = 0;
  }

  // ------------------------------------------------------------- ArmChip

  read(address: number, width: 1 | 2 | 4): number {
    return this.bus.read(address, width);
  }

  write(address: number, value: number, width: 1 | 2 | 4): void {
    if (address >= STM32F4_FLASH_BASE && address < STM32F4_FLASH_BASE + STM32F4_FLASH_BYTES) {
      this.programFlash(address - STM32F4_FLASH_BASE, value, width);
      return;
    }
    this.bus.write(address, value, width);
  }

  readSystem(address: number): number | undefined {
    if (address === 0xe0042000) return 0x10006433; // DBGMCU_IDCODE: STM32F401xD/E, revision Z
    return undefined;
  }

  writeSystem(): boolean {
    return true; // DBGMCU freeze bits: accepted
  }

  reset(): void {
    this.core.reset(STM32F4_FLASH_BASE);
  }

  /** Serial: USART2, which the Nucleo's ST-LINK carries to the monitor. */
  get console(): Stm32Serial {
    return this.usart2;
  }

  adcChannelForPad(p: number): number | undefined {
    return STM32F4_ADC_BY_PAD[p];
  }

  load(image: Uint8Array): void {
    if (image.length > STM32F4_FLASH_BYTES) throw new Error("Firmware is larger than the STM32F401RE's 512 KB of flash.");
    this.flash.set(image);
  }

  /** Several sources can share one NVIC line (TIM1 update and TIM10, say). */
  setIrqSource(line: number, source: string, active: boolean): void {
    let set = this.irqSources.get(line);
    if (!set) this.irqSources.set(line, (set = new Set()));
    if (active) set.add(source);
    else set.delete(source);
    this.core.setIrqLevel(line, set.size > 0);
  }

  // ------------------------------------------------------- pad plumbing

  refreshPad(pin: number): void {
    const port = pin >> 4;
    const bit = pin & 15;
    const mode = (this.moder[port] >>> (bit * 2)) & 3;
    const pupd = (this.pupdr[port] >>> (bit * 2)) & 3;
    const openDrain = (this.otyper[port] >>> bit) & 1;
    let drive = NOT_DRIVEN;
    if (mode === 1) {
      const high = (this.odr[port] >>> bit) & 1;
      drive = openDrain ? (high ? NOT_DRIVEN : 0) : high;
    } else if (mode === 2) {
      const af = (this.afr[port * 2 + (bit >> 3)] >>> ((bit & 7) * 4)) & 0xf;
      const fn = this.afDrive.get(pin * 16 + af);
      if (fn) {
        const level = fn();
        drive = openDrain && level === 1 ? NOT_DRIVEN : level;
      }
    }
    this.pads.setDrive(pin, drive);
    this.pads.setPull(pin, mode === 3 ? 0 : pupd === 1 ? 1 : pupd === 2 ? 2 : 0);
  }

  /** Registers what a named function drives on every pad that can carry it. */
  private drives(fn: string, level: () => number): number[] {
    const pins: number[] = [];
    for (const [key, name] of this.afName) {
      if (name !== fn) continue;
      this.afDrive.set(key, level);
      pins.push(key >> 4);
    }
    return pins;
  }

  /** The pads currently muxed to a named function. */
  padsFor(fn: string): number[] {
    const out: number[] = [];
    for (const [key, name] of this.afName) {
      if (name !== fn) continue;
      const pin = key >> 4;
      const port = pin >> 4;
      const bit = pin & 15;
      if (((this.moder[port] >>> (bit * 2)) & 3) !== 2) continue;
      if (((this.afr[port * 2 + (bit >> 3)] >>> ((bit & 7) * 4)) & 0xf) === (key & 15)) out.push(pin);
    }
    return out;
  }

  activeI2cPads(): { sda?: number; scl?: number } | undefined {
    for (const n of [1, 2, 3]) {
      const scl = this.padsFor(`I2C${n}_SCL`)[0];
      if (scl === undefined) continue;
      const sda = this.padsFor(`I2C${n}_SDA`)[0] ?? (n === 1 ? pad('PB9') : n === 3 ? pad('PC9') : pad('PB3'));
      return { sda, scl };
    }
    return undefined;
  }

  activeSpiPads(): { sck?: number; mosi?: number; miso?: number } | undefined {
    const miso: Record<number, number> = { 1: pad('PA6'), 2: pad('PB14'), 3: pad('PB4') };
    for (const n of [1, 2, 3]) {
      const sck = this.padsFor(`SPI${n}_SCK`)[0];
      if (sck === undefined) continue;
      return { sck, mosi: this.padsFor(`SPI${n}_MOSI`)[0], miso: miso[n] };
    }
    return undefined;
  }

  // ------------------------------------------------------- peripherals

  private buildPeripherals(): void {
    const bus = this.bus;

    this.buildRcc();
    this.buildFlash();
    const pwr = bus.add(new Periph('PWR', 0x40007000, 0x400));
    pwr.reg(0x04, () => (pwr.peek(0x04) | 0x4000) >>> 0); // CSR.VOSRDY

    const ids = bus.add(new Periph('DEVICE_ID', 0x1fff7a00, 0x100));
    ids.init(0x10, 0x00430030).init(0x14, 0x3436510f).init(0x18, 0x34353930); // unique ID
    ids.reg(0x20, () => 512 << 16); // flash size in KB, at 0x1FFF7A22

    for (const [name, base] of [
      ['CRC', 0x40023000], ['DMA1', 0x40026000], ['DMA2', 0x40026400], ['RTC', 0x40002800],
      ['WWDG', 0x40002c00], ['IWDG', 0x40003000], ['SDIO', 0x40012c00], ['OTG_FS', 0x50000000],
    ] as const) {
      bus.add(new Periph(name, base, name === 'OTG_FS' ? 0x40000 : 0x400));
    }

    // GPIO ports A-E and H.
    for (const port of [0, 1, 2, 3, 4, 7]) this.buildGpio(port, 0x40020000 + port * 0x400);
    this.exti = new Exti(this);
    this.pads.onChange = (pin, high) => this.exti.inputChanged(pin, high);

    const serial = (name: string, base: number, irq: number, pclk: number, rx: string, tx: string, txFn: string) => {
      const s = new StmUsart(this, name, base, irq, pclk, pad(rx), pad(tx));
      this.drives(txFn, () => s.txLevel());
      this.serials.push(s);
      return s;
    };
    this.usart2 = serial('Serial', 0x40004400, IRQ.USART2, STM32F4_HZ / 2, 'PA3', 'PA2', 'USART2_TX');
    serial('USART1', 0x40011000, IRQ.USART1, STM32F4_HZ, 'PA10', 'PA9', 'USART1_TX');
    serial('USART6', 0x40011400, IRQ.USART6, STM32F4_HZ, 'PA12', 'PA11', 'USART6_TX');

    const timer = (name: string, base: number, bits: 16 | 32, channels: number, up: number, cc: number) => {
      const touched: number[] = [];
      const t = new StmTimer(this, bus.add(new Periph(name, base, 0x400)), name, bits, channels, up, cc, () => {
        for (const p of touched) this.refreshPad(p);
      });
      for (let ch = 1; ch <= channels; ch++) {
        touched.push(...this.drives(`${name}_CH${ch}`, () => t.output(ch - 1, false)));
        touched.push(...this.drives(`${name}_CH${ch}N`, () => t.output(ch - 1, true)));
      }
      return t;
    };
    timer('TIM1', 0x40010000, 16, 4, IRQ.TIM1_UP_TIM10, IRQ.TIM1_CC);
    timer('TIM2', 0x40000000, 32, 4, IRQ.TIM2, IRQ.TIM2);
    timer('TIM3', 0x40000400, 16, 4, IRQ.TIM3, IRQ.TIM3);
    timer('TIM4', 0x40000800, 16, 4, IRQ.TIM4, IRQ.TIM4);
    timer('TIM5', 0x40000c00, 32, 4, IRQ.TIM5, IRQ.TIM5);
    timer('TIM9', 0x40014000, 16, 2, IRQ.TIM1_BRK_TIM9, IRQ.TIM1_BRK_TIM9);
    timer('TIM10', 0x40014400, 16, 1, IRQ.TIM1_UP_TIM10, IRQ.TIM1_UP_TIM10);
    timer('TIM11', 0x40014800, 16, 1, IRQ.TIM1_TRG_COM_TIM11, IRQ.TIM1_TRG_COM_TIM11);

    this.buildAdc();
    this.buildI2c('I2C1', 0x40005400, IRQ.I2C1_EV, IRQ.I2C1_ER);
    this.buildI2c('I2C2', 0x40005800, IRQ.I2C2_EV, IRQ.I2C2_ER);
    this.buildI2c('I2C3', 0x40005c00, IRQ.I2C3_EV, IRQ.I2C3_ER);
    this.buildSpi('SPI1', 0x40013000);
    this.buildSpi('SPI2', 0x40003800);
    this.buildSpi('SPI3', 0x40003c00);
    this.buildSpi('SPI4', 0x40013400);
  }

  private buildRcc(): void {
    const rcc = this.bus.add(new Periph('RCC', 0x40023800, 0x400));
    // CR: every oscillator and PLL is ready the moment it is switched on.
    rcc.init(0x00, 0x00000083);
    rcc.reg(0x00, () => {
      const v = rcc.peek(0x00);
      let ready = 0;
      if (v & 0x1) ready |= 0x2; // HSIRDY
      if (v & 0x10000) ready |= 0x20000; // HSERDY
      if (v & 0x1000000) ready |= 0x2000000; // PLLRDY
      if (v & 0x4000000) ready |= 0x8000000; // PLLI2SRDY
      return ((v & ~0x0a020002) | ready) >>> 0;
    });
    rcc.init(0x04, 0x24003010); // PLLCFGR
    rcc.init(0x84, 0x20003000); // PLLI2SCFGR
    // CFGR: the switch status follows the switch.
    rcc.reg(0x08, () => {
      const v = rcc.peek(0x08);
      return ((v & ~0xc) | ((v & 3) << 2)) >>> 0;
    });
    rcc.reg(0x70, () => {
      const v = rcc.peek(0x70); // BDCR: LSERDY follows LSEON
      return v & 1 ? v | 2 : v & ~2;
    });
    rcc.init(0x74, 0x0e000000); // CSR: POR, PIN and BOR reset flags
    rcc.reg(0x74, () => {
      const v = rcc.peek(0x74); // LSIRDY follows LSION
      return (v & 1 ? v | 2 : v & ~2) >>> 0;
    }, (v) => {
      if (v & 0x01000000) rcc.poke(0x74, v & ~0xff000000); // RMVF clears the reset flags
    });
  }

  private flashLocked = true;
  private flashKey = 0;

  private buildFlash(): void {
    const f = this.bus.add(new Periph('FLASH', 0x40023c00, 0x400));
    f.init(0x10, 0x80000000); // CR.LOCK
    f.init(0x14, 0x0fffaaed); // OPTCR
    f.reg(0x04, undefined, (v) => {
      if (this.flashKey === 0 && v === 0x45670123) this.flashKey = 1;
      else if (this.flashKey === 1 && v === 0xcdef89ab) {
        this.flashLocked = false;
        this.flashKey = 0;
        f.poke(0x10, f.peek(0x10) & ~0x80000000);
      } else this.flashKey = 0;
    });
    f.reg(0x0c, () => f.peek(0x0c) & 0x1f3, (v, prev) => f.poke(0x0c, prev & ~v)); // SR: write 1 to clear
    f.reg(0x10, () => (f.peek(0x10) | (this.flashLocked ? 0x80000000 : 0)) >>> 0, (v, prev) => {
      if (this.flashLocked) {
        f.poke(0x10, prev);
        return;
      }
      if (v & 0x80000000) {
        this.flashLocked = true;
        return;
      }
      if (v & 0x10000) {
        // STRT: erase.
        if (v & 0x4) this.flash.fill(0xff);
        else if (v & 0x2) {
          const sector = SECTORS[(v >>> 3) & 0xf];
          if (sector) this.flash.fill(0xff, sector[0], sector[0] + sector[1]);
        }
        f.poke(0x10, v & ~0x10000);
        f.poke(0x0c, f.peek(0x0c) | 0x1); // EOP
      }
    });
  }

  /** A store into flash: programs (clears bits) when unlocked with PG set, else is ignored. */
  private programFlash(offset: number, value: number, width: 1 | 2 | 4): void {
    const f = this.bus.find(0x40023c00)!;
    const cr = f.peek(0x10);
    if (this.flashLocked || !(cr & 1)) {
      f.poke(0x0c, f.peek(0x0c) | 0x80); // PGSERR
      return;
    }
    for (let i = 0; i < width; i++) {
      const at = offset + i;
      if (at < this.flash.length) this.flash[at] &= (value >>> (8 * i)) & 0xff;
    }
    f.poke(0x0c, f.peek(0x0c) | 0x1);
  }

  private buildGpio(port: number, base: number): void {
    const g = this.bus.add(new Periph(`GPIO${String.fromCharCode(65 + port)}`, base, 0x400));
    const refresh = (mask: number) => {
      for (let bit = 0; bit < 16; bit++) if (mask & (1 << bit)) this.refreshPad(port * 16 + bit);
    };
    const twoBit = (changed: number) => {
      let mask = 0;
      for (let bit = 0; bit < 16; bit++) if ((changed >>> (bit * 2)) & 3) mask |= 1 << bit;
      return mask;
    };
    g.reg(0x00, () => this.moder[port], (v) => {
      const before = this.moder[port];
      this.moder[port] = v;
      refresh(twoBit(before ^ v));
    });
    g.reg(0x04, () => this.otyper[port], (v) => {
      const before = this.otyper[port];
      this.otyper[port] = v & 0xffff;
      refresh(before ^ this.otyper[port]);
    });
    g.reg(0x0c, () => this.pupdr[port], (v) => {
      const before = this.pupdr[port];
      this.pupdr[port] = v;
      refresh(twoBit(before ^ v));
    });
    g.reg(0x10, () => {
      let v = 0;
      for (let bit = 0; bit < 16; bit++) if (this.pads.level(port * 16 + bit)) v |= 1 << bit;
      return v;
    });
    g.reg(0x14, () => this.odr[port], (v) => {
      const before = this.odr[port];
      this.odr[port] = v & 0xffff;
      refresh(before ^ this.odr[port]);
    });
    g.reg(0x18, () => 0, (v) => {
      const before = this.odr[port];
      // Set wins over reset when both are written.
      this.odr[port] = ((before & ~(v >>> 16)) | (v & 0xffff)) & 0xffff;
      refresh(before ^ this.odr[port]);
    });
    for (const [offset, index] of [[0x20, port * 2], [0x24, port * 2 + 1]] as const) {
      g.reg(offset, () => this.afr[index], (v) => {
        const before = this.afr[index];
        this.afr[index] = v;
        let mask = 0;
        for (let i = 0; i < 8; i++) if (((before ^ v) >>> (i * 4)) & 0xf) mask |= 1 << (i + (offset === 0x24 ? 8 : 0));
        refresh(mask);
      });
    }
  }

  private buildAdc(): void {
    // ADC1 and, at 0x300, the common registers.
    const adc = this.bus.add(new Periph('ADC1', 0x40012000, 0x400));
    let sr = 0;
    let dr = 0;
    let busy = false;
    const irq = () => {
      const cr1 = adc.peek(0x04);
      this.setIrqSource(IRQ.ADC, 'ADC1', ((sr & 0x2) !== 0 && (cr1 & 0x20) !== 0) || ((sr & 0x20) !== 0 && (cr1 & 0x4000000) !== 0));
    };
    const volts = (ch: number) => {
      if (ch < 16) return this.adcVolts[ch];
      if (ch === 17) return VREFINT_VOLTS;
      return TEMP_SENSOR_VOLTS;
    };
    const convert = () => {
      const ch = adc.peek(0x34) & 0x1f; // SQ1
      // Sampling time from SMPR, plus twelve cycles, at PCLK2 / 4.
      const smp = ch < 10 ? (adc.peek(0x10) >>> (ch * 3)) & 7 : (adc.peek(0x0c) >>> ((ch - 10) * 3)) & 7;
      const sampleCycles = [3, 15, 28, 56, 84, 112, 144, 480][smp] + 12;
      busy = true;
      sr |= 0x10; // STRT
      this.events.schedule(sampleCycles * 4, () => {
        busy = false;
        const res = (adc.peek(0x04) >>> 24) & 3; // 12, 10, 8 or 6 bits
        const bits = 12 - res * 2;
        const full = (1 << bits) - 1;
        let v = Math.round((Math.max(0, Math.min(3.3, volts(ch))) / 3.3) * full);
        if (adc.peek(0x08) & 0x800) v = (v << (16 - bits)) & 0xffff; // ALIGN left
        if (sr & 0x2) sr |= 0x20; // OVR: the last result was never read
        dr = v;
        sr |= 0x2; // EOC
        irq();
        if (adc.peek(0x08) & 0x2) convert(); // CONT
      });
    };
    adc.reg(0x00, () => sr, (v) => {
      sr &= v | ~0x3f; // rc_w0
      irq();
    });
    adc.reg(0x04, undefined, () => irq());
    adc.reg(0x08, undefined, (v) => {
      if (v & 0x40000000 && v & 1 && !busy) convert(); // SWSTART with ADON
      adc.poke(0x08, v & ~0x40000000);
    });
    adc.reg(0x4c, () => {
      sr &= ~0x2;
      irq();
      return dr;
    });
  }

  private buildI2c(name: string, base: number, evIrq: number, erIrq: number): void {
    new StmI2c(this, this.bus.add(new Periph(name, base, 0x400)), name, evIrq, erIrq);
  }

  private buildSpi(name: string, base: number): void {
    const spi = this.bus.add(new Periph(name, base, 0x400));
    let sr = 0x2; // TXE
    let rx = 0;
    spi.reg(0x08, () => sr, (v) => (sr &= v | ~0x10)); // CRCERR is cleared by writing 0
    const reverse = (b: number) => {
      let r = 0;
      for (let i = 0; i < 8; i++) if (b & (1 << i)) r |= 0x80 >> i;
      return r;
    };
    const byte = (mosi: number, cr1: number) => {
      const mode = (((cr1 >>> 1) & 1) << 1 | (cr1 & 1)) as 0 | 1 | 2 | 3;
      const lsb = (cr1 & 0x80) !== 0;
      const out = lsb ? reverse(mosi) : mosi;
      const got = (this.spiTransfer ? this.spiTransfer(out, mode) : 0xff) & 0xff;
      return lsb ? reverse(got) : got;
    };
    spi.reg(0x0c, () => {
      sr &= ~0x1;
      return rx;
    }, (v) => {
      const cr1 = spi.peek(0x00);
      if (!(cr1 & 0x40)) return; // SPE
      if (cr1 & 0x800) {
        // 16-bit frames: the most significant byte first unless LSBFIRST.
        const lsb = (cr1 & 0x80) !== 0;
        const first = byte(lsb ? v & 0xff : (v >>> 8) & 0xff, cr1);
        const second = byte(lsb ? (v >>> 8) & 0xff : v & 0xff, cr1);
        rx = lsb ? first | (second << 8) : (first << 8) | second;
      } else rx = byte(v & 0xff, cr1);
      if (sr & 0x1) sr |= 0x40; // OVR
      sr |= 0x3; // RXNE TXE
    });
  }
}

/** EXTI lines 0-15, each fed by one port's pad of that number as SYSCFG selects. */
class Exti {
  pr = 0;
  private readonly p: Periph;
  private readonly syscfg: Periph;

  constructor(private readonly chip: Stm32f4) {
    this.p = chip.bus.add(new Periph('EXTI', 0x40013c00, 0x400));
    this.syscfg = chip.bus.add(new Periph('SYSCFG', 0x40013800, 0x400));
    this.p.reg(0x00, undefined, () => this.irq());
    this.p.reg(0x10, undefined, (v) => {
      this.pr |= v & this.p.peek(0x00); // SWIER
      this.irq();
    });
    this.p.reg(0x14, () => this.pr, (v) => {
      this.pr &= ~v;
      this.irq();
    });
  }

  private portFor(line: number): number {
    const word = this.syscfg.peek(0x08 + (line >> 2) * 4);
    return (word >>> ((line & 3) * 4)) & 0xf;
  }

  inputChanged(pin: number, high: boolean): void {
    const line = pin & 15;
    if (line >= 16 || this.portFor(line) !== pin >> 4) return;
    const edge = high ? this.p.peek(0x08) : this.p.peek(0x0c); // RTSR / FTSR
    if (!(edge & (1 << line))) return;
    this.pr |= 1 << line;
    this.irq();
  }

  private irq(): void {
    const active = this.pr & this.p.peek(0x00);
    const lines: [number, number][] = [
      [6, 0x1], [7, 0x2], [8, 0x4], [9, 0x8], [10, 0x10], [23, 0x3e0], [40, 0xfc00],
    ];
    for (const [line, mask] of lines) this.chip.setIrqSource(line, 'EXTI', (active & mask) !== 0);
  }
}

/** USART v1: SR, DR, BRR, CR1-3. */
class StmUsart implements Stm32Serial {
  onTransmit: ((byte: number) => void) | null = null;
  private sr = 0xc0; // TXE TC
  private rdr = 0;
  private holding = -1;
  private shifting = false;
  private readonly rxQueue: number[] = [];
  private rxScheduled = false;
  private readonly p: Periph;

  constructor(
    private readonly chip: Stm32f4,
    readonly name: string,
    base: number,
    private readonly irqLine: number,
    private readonly pclk: number,
    readonly rxPad: number,
    readonly txPad: number,
  ) {
    const p = (this.p = chip.bus.add(new Periph(name, base, 0x400)));
    p.reg(0x00, () => this.sr, (v) => {
      this.sr &= v | ~0x360; // CTS LBD TC RXNE are cleared by writing 0
      this.irq();
    });
    p.reg(0x04, () => {
      this.sr &= ~0x3f; // reading DR after SR clears RXNE and the error flags
      this.irq();
      this.pumpRx();
      return this.rdr;
    }, (v) => this.transmit(v & 0xff));
    p.reg(0x0c, undefined, () => {
      this.irq();
      this.pumpRx();
    });
  }

  baud(): number | undefined {
    const brr = this.p.peek(0x08) & 0xffff;
    if (!brr) return undefined;
    const over8 = (this.p.peek(0x0c) & 0x8000) !== 0;
    const div = over8 ? (brr & 0xfff0) | ((brr & 7) << 1) : brr;
    return Math.round(((over8 ? 2 : 1) * this.pclk) / div);
  }

  private get cr1(): number {
    return this.p.peek(0x0c);
  }

  private charCycles(): number {
    return Math.max(16, Math.round((STM32F4_HZ * 10) / (this.baud() ?? 115200)));
  }

  /** TX idles high whenever the transmitter is not shifting a start bit out. */
  txLevel(): number {
    return 1;
  }

  private transmit(byte: number): void {
    const cr1 = this.cr1;
    if (!(cr1 & 0x2000) || !(cr1 & 0x8)) return; // UE, TE
    this.sr &= ~0x40; // TC
    if (this.shifting) {
      this.holding = byte;
      this.sr &= ~0x80; // TXE
    } else this.shift(byte);
    this.irq();
  }

  private shift(byte: number): void {
    this.shifting = true;
    this.sr |= 0x80; // the data register is empty again
    this.onTransmit?.(byte);
    this.chip.events.schedule(this.charCycles(), () => {
      this.shifting = false;
      if (this.holding >= 0) {
        const next = this.holding;
        this.holding = -1;
        this.shift(next);
      } else this.sr |= 0x40; // TC
      this.irq();
    });
  }

  receive(byte: number): void {
    this.rxQueue.push(byte & 0xff);
    this.pumpRx();
  }

  private pumpRx(): void {
    const cr1 = this.cr1;
    if (!(cr1 & 0x2000) || !(cr1 & 0x4) || this.rxScheduled || !this.rxQueue.length || this.sr & 0x20) return;
    this.rxScheduled = true;
    this.chip.events.schedule(this.charCycles(), () => {
      this.rxScheduled = false;
      if (this.sr & 0x20) {
        this.pumpRx();
        return;
      }
      if (!this.rxQueue.length) return;
      this.rdr = this.rxQueue.shift()!;
      this.sr |= 0x20; // RXNE
      this.irq();
    });
  }

  private irq(): void {
    const cr1 = this.cr1;
    const sr = this.sr;
    const active =
      (sr & 0x80 && cr1 & 0x80) || (sr & 0x40 && cr1 & 0x40) || (sr & 0x20 && cr1 & 0x20) || (sr & 0x8 && cr1 & 0x20) ||
      (sr & 0x10 && cr1 & 0x10) || (sr & 0x1 && cr1 & 0x100);
    this.chip.setIrqSource(this.irqLine, this.name, !!active);
  }
}

/** A general-purpose or advanced timer, counting up. */
class StmTimer {
  private sr = 0;
  private psc = 0;
  private arr = 0xffff;
  private readonly ccr = [0, 0, 0, 0];
  private readonly ocref = [false, false, false, false];
  private running = false;
  private anchorCount = 0;
  private anchorCycle = 0;
  private cancel: (() => void) | null = null;
  private readonly mask: number;

  constructor(
    private readonly chip: Stm32f4,
    private readonly p: Periph,
    private readonly name: string,
    bits: 16 | 32,
    private readonly channels: number,
    private readonly upIrq: number,
    private readonly ccIrq: number,
    private readonly outputsChanged: () => void,
  ) {
    this.mask = bits === 32 ? 0xffffffff : 0xffff;
    this.arr = this.mask;
    p.init(0x2c, this.mask);
    p.reg(0x00, undefined, (v, prev) => {
      if (v & 1 && !(prev & 1)) this.start();
      else if (!(v & 1) && prev & 1) this.stop();
    });
    p.reg(0x0c, undefined, () => this.irq());
    p.reg(0x10, () => this.sr, (v) => {
      this.sr &= v;
      this.irq();
    });
    p.reg(0x14, undefined, (v) => {
      if (v & 1) this.updateEvent(!(this.p.peek(0x00) & 0x4));
      for (let ch = 0; ch < 4; ch++) if (v & (2 << ch)) this.sr |= 2 << ch;
      this.irq();
    });
    p.reg(0x18, undefined, () => this.outputs());
    p.reg(0x1c, undefined, () => this.outputs());
    p.reg(0x20, undefined, () => this.outputs());
    p.reg(0x44, undefined, () => this.outputs());
    p.reg(0x24, () => this.count(), (v) => {
      this.anchorCount = (v & this.mask) >>> 0;
      this.anchorCycle = this.chip.core.cycles;
      this.reschedule();
    });
    p.reg(0x2c, undefined, (v) => {
      if (!(this.p.peek(0x00) & 0x80)) {
        this.arr = (v & this.mask) >>> 0; // no preload: takes effect now
        this.reschedule();
      }
    });
    for (let ch = 0; ch < 4; ch++) {
      p.reg(0x34 + ch * 4, undefined, (v) => {
        if (!this.preloaded(ch)) {
          this.ccr[ch] = (v & this.mask) >>> 0;
          this.recompute();
          this.reschedule();
        }
      });
    }
  }

  private ccmr(ch: number): number {
    return (this.p.peek(ch < 2 ? 0x18 : 0x1c) >>> ((ch & 1) * 8)) & 0xff;
  }

  private preloaded(ch: number): boolean {
    return (this.ccmr(ch) & 0x8) !== 0;
  }

  private ticks(): number {
    return this.psc + 1;
  }

  private count(): number {
    if (!this.running) return this.anchorCount;
    return (this.anchorCount + Math.floor((this.chip.core.cycles - this.anchorCycle) / this.ticks())) >>> 0;
  }

  private start(): void {
    this.running = true;
    this.anchorCycle = this.chip.core.cycles;
    this.recompute();
    this.reschedule();
  }

  private stop(): void {
    this.anchorCount = this.count();
    this.running = false;
    this.cancel?.();
    this.cancel = null;
  }

  /** UEV: the preloaded prescaler, period and compares take effect and the count restarts. */
  private updateEvent(flag: boolean): void {
    this.psc = this.p.peek(0x28) & 0xffff;
    this.arr = (this.p.peek(0x2c) & this.mask) >>> 0;
    for (let ch = 0; ch < 4; ch++) this.ccr[ch] = (this.p.peek(0x34 + ch * 4) & this.mask) >>> 0;
    this.anchorCount = 0;
    this.anchorCycle = this.chip.core.cycles;
    if (flag) this.sr |= 1;
    this.recompute();
    this.reschedule();
  }

  /** PWM and forced reference levels as they stand at the current count. */
  private recompute(): void {
    const cnt = this.count();
    let changed = false;
    for (let ch = 0; ch < this.channels; ch++) {
      const mode = (this.ccmr(ch) >>> 4) & 7;
      if (this.ccmr(ch) & 3) continue; // input capture
      let ref = this.ocref[ch];
      if (mode === 4) ref = false;
      else if (mode === 5) ref = true;
      else if (mode === 6) ref = cnt < this.ccr[ch];
      else if (mode === 7) ref = cnt >= this.ccr[ch];
      if (ref !== this.ocref[ch]) {
        this.ocref[ch] = ref;
        changed = true;
      }
    }
    if (changed) this.outputsChanged();
  }

  private outputs(): void {
    this.recompute();
    this.outputsChanged();
  }

  /** The level a channel's output (or complementary output) drives, or not driven. */
  output(ch: number, complementary: boolean): number {
    const ccer = this.p.peek(0x20) >>> (ch * 4);
    const advanced = this.name === 'TIM1';
    if (advanced && !(this.p.peek(0x44) & 0x8000)) return NOT_DRIVEN; // MOE
    if (complementary) {
      if (!(ccer & 0x4)) return NOT_DRIVEN;
      // With the main output off, OCxN is OCxREF itself (RM0368 table 71);
      // with both on it is the complement.
      const ref = ccer & 0x1 ? !this.ocref[ch] : this.ocref[ch];
      return (ref !== ((ccer & 0x8) !== 0)) ? 1 : 0;
    }
    if (!(ccer & 0x1)) return NOT_DRIVEN;
    return (this.ocref[ch] !== ((ccer & 0x2) !== 0)) ? 1 : 0;
  }

  private reschedule(): void {
    this.cancel?.();
    this.cancel = null;
    // A zero period stops the counter.
    if (!this.running || this.arr === 0) return;
    const cnt = this.count();
    let next = this.arr + 1; // overflow
    for (let ch = 0; ch < this.channels; ch++) {
      const c = this.ccr[ch];
      if (c > cnt && c <= this.arr && c < next) next = c;
    }
    const cycles = (next - cnt) * this.ticks() - ((this.chip.core.cycles - this.anchorCycle) % this.ticks());
    this.cancel = this.chip.events.schedule(Math.max(1, cycles), () => this.reached(next));
  }

  private reached(value: number): void {
    this.cancel = null;
    if (value === this.arr + 1) {
      this.updateEvent(!(this.p.peek(0x00) & 0x2)); // UDIS suppresses the update
      this.matchAt(0);
      this.irq();
      return;
    }
    this.anchorCount = value;
    this.anchorCycle = this.chip.core.cycles;
    this.matchAt(value);
    this.irq();
    this.reschedule();
  }

  private matchAt(value: number): void {
    let changed = false;
    for (let ch = 0; ch < this.channels; ch++) {
      if (this.ccr[ch] !== value) continue;
      this.sr |= 2 << ch;
      if (this.ccmr(ch) & 3) continue;
      const mode = (this.ccmr(ch) >>> 4) & 7;
      const before = this.ocref[ch];
      if (mode === 1) this.ocref[ch] = true;
      else if (mode === 2) this.ocref[ch] = false;
      else if (mode === 3) this.ocref[ch] = !before;
      else if (mode === 6) this.ocref[ch] = value < this.ccr[ch];
      else if (mode === 7) this.ocref[ch] = value >= this.ccr[ch];
      if (this.ocref[ch] !== before) changed = true;
    }
    if (changed) this.outputsChanged();
  }

  private irq(): void {
    const dier = this.p.peek(0x0c);
    const up = (this.sr & dier & 0x1) !== 0;
    const cc = (this.sr & dier & 0x1e) !== 0;
    if (this.upIrq === this.ccIrq) this.chip.setIrqSource(this.upIrq, this.name, up || cc);
    else {
      this.chip.setIrqSource(this.upIrq, `${this.name}_UP`, up);
      this.chip.setIrqSource(this.ccIrq, `${this.name}_CC`, cc);
    }
  }
}

/**
 * The v1 I2C master: START, address, data, STOP, each completing as an event
 * flag the HAL's interrupt handler reacts to.
 *
 * Received bytes are clocked in one byte-time after the bus becomes free for
 * them, reading ACK, POS and STOP at that moment — which is when the silicon
 * decides whether to acknowledge, so the HAL's one-, two- and N-byte read
 * sequences all end where they should.
 */
class StmI2c {
  private sr1 = 0;
  private sr2 = 0;
  private dr = 0;
  /** Waiting for the address after a START. */
  private addressPhase = false;
  private reading = false;
  private rxCount = 0;
  /** Whether the last byte received was acknowledged — which tells the slave to send another. */
  private lastAck = true;
  private shiftFull = false;
  private shiftByte = 0;
  private receiving: (() => void) | null = null;
  private stopPending = false;
  private sr1ReadWithAddr = false;

  constructor(
    private readonly chip: Stm32f4,
    private readonly p: Periph,
    private readonly name: string,
    private readonly evIrq: number,
    private readonly erIrq: number,
  ) {
    p.reg(0x00, undefined, (v) => this.cr1Written(v));
    p.reg(0x04, undefined, () => this.irq());
    p.reg(0x10, () => {
      const v = this.dr;
      this.dataRead();
      return v;
    }, (v) => this.dataWritten(v & 0xff));
    p.reg(0x14, () => {
      if (this.sr1 & 0x2) this.sr1ReadWithAddr = true;
      return this.sr1;
    }, (v) => {
      this.sr1 &= v | ~0xdf00; // error flags are cleared by writing 0
      this.irq();
    });
    p.reg(0x18, () => {
      const v = this.sr2;
      if (this.sr1ReadWithAddr) this.addressCleared();
      return v;
    });
  }

  private get cr1(): number {
    return this.p.peek(0x00);
  }

  private bus(): I2cMasterHooks | null {
    return this.chip.i2c;
  }

  private byteCycles(): number {
    // 9 clocks at the programmed SCL rate (CCR in PCLK1 periods, 42 MHz).
    const ccr = this.p.peek(0x1c);
    const fast = (ccr & 0x8000) !== 0;
    const c = Math.max(4, ccr & 0xfff);
    const sclPeriod = fast ? (ccr & 0x4000 ? 25 * c : 3 * c) : 2 * c;
    return Math.max(200, sclPeriod * 2 * 9);
  }

  private cr1Written(v: number): void {
    if (v & 0x8000) {
      // SWRST
      this.reset();
      return;
    }
    if (!(v & 1)) return;
    if (v & 0x100) {
      // START (or a repeated START)
      this.p.poke(0x00, v & ~0x100);
      const repeated = (this.sr2 & 0x1) !== 0;
      this.cancelReceive();
      this.bus()?.start(repeated);
      this.sr1 = (this.sr1 & ~0x86) | 0x1; // SB
      this.sr2 |= 0x3; // MSL BUSY
      this.addressPhase = true;
      this.reading = false;
      this.irq();
    }
    if (v & 0x200) {
      // STOP: after the byte in flight, if one is.
      if (this.receiving) this.stopPending = true;
      else this.finish();
    }
  }

  private reset(): void {
    this.cancelReceive();
    this.sr1 = 0;
    this.sr2 = 0;
    this.addressPhase = false;
    this.reading = false;
    this.p.poke(0x00, 0);
    this.irq();
  }

  private finish(): void {
    this.p.poke(0x00, this.cr1 & ~0x200);
    this.cancelReceive();
    if (this.sr2 & 0x1) this.bus()?.stop();
    this.sr2 &= ~0x7;
    this.reading = false;
    this.stopPending = false;
    this.irq();
  }

  private cancelReceive(): void {
    this.receiving?.();
    this.receiving = null;
  }

  private dataWritten(byte: number): void {
    if (this.addressPhase && this.sr1 & 0x1) {
      this.sr1 &= ~0x1; // SB clears on the address write
      this.addressPhase = false;
      const write = (byte & 1) === 0;
      const ack = this.bus() ? this.bus()!.connect(byte >>> 1, write) : false;
      if (!ack) {
        this.sr1 |= 0x400; // AF
        this.irq();
        return;
      }
      this.reading = !write;
      this.rxCount = 0;
      this.lastAck = true;
      this.shiftFull = false;
      this.sr1 |= 0x2; // ADDR
      this.sr1ReadWithAddr = false;
      this.sr2 = (this.sr2 & ~0x4) | (write ? 0x4 : 0); // TRA
      this.irq();
      return;
    }
    if (this.reading || !(this.sr2 & 0x1)) return;
    this.sr1 &= ~0x84;
    const ack = this.bus() ? this.bus()!.writeByte(byte) : false;
    if (!ack) this.sr1 |= 0x400; // AF
    else this.sr1 |= 0x84; // TXE BTF: the byte went out and nothing is queued behind it
    this.irq();
  }

  private addressCleared(): void {
    this.sr1ReadWithAddr = false;
    this.sr1 &= ~0x2;
    if (this.sr2 & 0x4) this.sr1 |= 0x80; // transmitter: TXE
    else this.scheduleReceive();
    this.irq();
  }

  private scheduleReceive(): void {
    if (this.receiving || !this.reading) return;
    this.receiving = this.chip.events.schedule(this.byteCycles(), () => {
      this.receiving = null;
      const cr1 = this.cr1;
      // With POS, the ACK bit decides the byte after this one.
      const ack = cr1 & 0x800 && this.rxCount === 0 ? true : (cr1 & 0x400) !== 0;
      const byte = this.bus() ? this.bus()!.readByte(ack) : 0xff;
      this.rxCount++;
      this.lastAck = ack;
      if (this.sr1 & 0x40) {
        this.shiftFull = true;
        this.shiftByte = byte;
        this.sr1 |= 0x4; // BTF: data register and shift register both full
      } else {
        this.dr = byte;
        this.sr1 |= 0x40; // RXNE
      }
      if (this.stopPending || cr1 & 0x200) this.finish();
      else if (ack && !this.shiftFull) this.scheduleReceive();
      this.irq();
    });
  }

  /** DR read: the shift register's byte, if one waits, moves up; reception resumes. */
  private dataRead(): void {
    if (!(this.sr1 & 0x40)) return;
    this.sr1 &= ~0x4; // BTF
    if (this.shiftFull) {
      this.dr = this.shiftByte;
      this.shiftFull = false;
    } else this.sr1 &= ~0x40;
    if (this.reading && this.sr2 & 0x1 && !this.stopPending && this.lastAck) this.scheduleReceive();
    this.irq();
  }

  private irq(): void {
    const cr2 = this.p.peek(0x04);
    const evt = (cr2 & 0x200) !== 0;
    const buf = (cr2 & 0x400) !== 0;
    const ev = evt && ((this.sr1 & 0x1f) !== 0 || (buf && (this.sr1 & 0xc0) !== 0));
    const er = (cr2 & 0x100) !== 0 && (this.sr1 & 0xdf00) !== 0;
    this.chip.setIrqSource(this.evIrq, this.name, ev);
    this.chip.setIrqSource(this.erIrq, this.name, er);
  }
}
