// The ESP32-S3: two Xtensa LX7 cores and the S3's memory map, flash MMU,
// interrupt matrix, CPU controls and peripherals.
//
// Addresses are from ESP-IDF's soc/esp32s3 headers (reg_base.h, soc.h,
// ext_mem_defs.h, system_reg.h, interrupt_core0_reg.h). The scheduling of the
// two cores, interrupt delivery and ROM dispatch are the ESP32's
// (../xtensa/espXtensaMachine); what differs is everything a chip decides:
//
//   * one SRAM seen twice, as DRAM at 0x3FC88000 and as IRAM 0x6F0000 above
//     it, plus 32 KB of SRAM0 below at 0x40370000;
//   * one 512-entry MMU for both cache windows (IROM at 0x42000000, DROM at
//     0x3C000000), whose virtual pages share one linear space;
//   * the interrupt matrix at 0x600C2000 (and 0x600C2800 for core 1), one map
//     register per source;
//   * the APP CPU released through SYSTEM_CORE_1_CONTROL_0;
//   * FreeRTOS's tick and esp_timer on the system timer, as on the C3, whose
//     UART, LED PWM, I2C and GP-SPI designs the S3 shares — so those models
//     are reused with the S3's addresses and signal numbers; the MCPWM,
//     which ESP32Servo uses on this chip, is modelled here.
//
// Not modelled: Wi-Fi, Bluetooth, USB OTG and USB Serial/JTAG, PSRAM.

import { EspXtensaMachine } from '../xtensa/espXtensaMachine';
import { esp32CoreConfig } from '../esp32/esp32';
import type { Peripheral, SimulatedClock } from '../espRiscv/peripheral';
import { EspUart } from '../espRiscv/uart';
import { ESP32S3_UART_LAYOUT } from '../espRiscv/uart';
import { EspLedc, ESP32S3_LEDC } from '../espRiscv/ledc';
import { EspI2c } from '../espRiscv/i2c';
import { EspSpi2, type Spi2Layout } from '../espRiscv/spi2';
import { SysTimer } from '../esp32c3/peripherals';
import { SpiMemController } from '../esp32c3/spiMem';
import type { SerialNorFlash } from '../esp32c3/spiFlash';
import type { EspApplicationImage } from '../esp32c3/espImage';
import { Esp32Gpio, ESP32S3_GPIO_LAYOUT } from '../esp32/gpio';
import { Esp32TimerGroup, ESP32S3_TIMG_LAYOUT } from '../esp32/timg';
import { Esp32Sens, ESP32S3_SENS } from '../esp32/adc';
import { Esp32S3Mcpwm } from './mcpwm';
import { type Esp32RomEntry, type Esp32RomHost } from '../esp32/rom';
import { REENT_TRAMPOLINE_CODE } from '../esp32/rom';
import { ESP32S3_ROM_ADDRESSES } from './romAddresses';
import { s3Handler, S3_COEX_VERSION, S3_COEX_VERSION_AT, S3_QSORT_AT, S3_QSORT_CODE } from './romRoutines';

export const ESP32S3_SOURCE = {
  gpio: 16, uart0: 27, uart1: 28, uart2: 29, ledc: 35, i2c0: 42, i2c1: 43,
  tg0T0: 50, tg0T1: 51, tg0Wdt: 52, tg1T0: 53, tg1T1: 54, tg1Wdt: 55, systimerTarget0: 57, fromCpu0: 79,
  usbSerialJtag: 96, count: 99,
} as const;

const SRAM0_BASE = 0x40370000;
const SRAM0_END = 0x40378000;
const DRAM_BASE = 0x3fc88000;
const DRAM_END = 0x3fd00000;
const IRAM_ALIAS_BASE = 0x40378000;
const IRAM_ALIAS_END = 0x403e0000;
const I_D_OFFSET = IRAM_ALIAS_BASE - DRAM_BASE;
const IROM_BASE = 0x42000000;
const IROM_END = 0x44000000;
const DROM_BASE = 0x3c000000;
const DROM_END = 0x3e000000;
const RTC_FAST = 0x600fe000;
const RTC_SLOW = 0x50000000;
const RTC_SIZE = 0x2000;
const MMIO_BASE = 0x60000000;
const MMIO_END = 0x600d1000;
const MMU_TABLE = 0x600c5000;
const MMU_ENTRIES = 512;
const MMU_INVALID = 1 << 14;
const INTERRUPT_BASE = 0x600c2000;
const SYSTEM_BASE = 0x600c0000;
const ROM_START = 0x40000000;
const ROM_END = 0x40060000;
/** Where this runtime places the machine code the ROM's newlib glue runs (see ../esp32/rom). */
const S3_REENT_TRAMPOLINE = 0x4005ff00;
/** The ROM's stack, from soc.h's SOC_ROM_STACK_START/SIZE: PRO at the top, APP below it. */
const PRO_ROM_STACK = 0x3fceb700;
const APP_ROM_STACK = 0x3fcea700;
const SYSCALL_TABLE_PTR = 0x3fceffd4;
const ETS_ROM_LAYOUT_P = 0x3ff1fffc;
const ROM_LAYOUT_AT = 0x3ff1fe00;
const ROM_SPIFLASH_LEGACY_DATA = 0x3fceffe4;
const FLASHCHIP_AT = 0x3ff1fd00;
const ROM_STACK_START = 0x3fceb710;
const ROM_STACK_SIZE = 0x2000;

/** S3 matrix signals of the GP-SPI pins (gpio_sig_map.h). */
export const ESP32S3_SPI_SIGNALS = {
  fspi: { clk: 101, miso: 102, mosi: 103, cs0: 110 },
  spi3: { clk: 66, miso: 67, mosi: 68, cs0: 71 },
} as const;
const S3_SPI2: Spi2Layout = { base: 0x60024000, rdBitOrderShift: 25, wrBitOrderShift: 26 };
const S3_SPI3: Spi2Layout = { base: 0x60025000, rdBitOrderShift: 25, wrBitOrderShift: 26 };

export class UnimplementedS3Error extends Error {}

class Store implements Peripheral {
  readonly regs = new Map<number, number>();
  constructor(
    readonly name: string,
    readonly base: number,
    readonly size: number,
    private readonly initial: [number, number][] = [],
    /** Status bits the hardware always reports set here: work that finishes at once. */
    private readonly alwaysSet: [number, number][] = [],
  ) {
    this.reset();
  }
  readUint32(offset: number): number {
    let v = this.regs.get(offset) ?? 0;
    for (const [o, bits] of this.alwaysSet) if (o === offset) v |= bits;
    return v >>> 0;
  }
  writeUint32(offset: number, value: number): void {
    this.regs.set(offset, value >>> 0);
  }
  reset(): void {
    this.regs.clear();
    for (const [o, v] of this.initial) this.regs.set(o, v >>> 0);
  }
}

class S3Rng extends Store {
  private seed = 0x9e3779b9;
  constructor() {
    super('wdev', 0x60035000, 0x100);
  }
  override readUint32(offset: number): number {
    if (offset !== 0x7c) return super.readUint32(offset);
    let x = this.seed;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.seed = x >>> 0;
    return this.seed;
  }
}

/** RTC_CNTL: reset state, the RTC timer and the store registers the bootloader fills. */
class S3RtcCntl extends Store {
  constructor(private readonly clock: SimulatedClock) {
    // STORE4: crystal MHz, STORE5: APB >> 12, each duplicated in the high half
    // as the bootloader leaves them. RESET_STATE: both cores power-on.
    super('rtc_cntl', 0x60008000, 0x400, [[0xc0, 0x00280028], [0xc4, ((40e6 >>> 12) << 16) | (40e6 >>> 12)], [0x38, 0x1041]]);
  }
  override writeUint32(offset: number, value: number): void {
    super.writeUint32(offset, value);
    if (offset === 0x0c && value >>> 31) {
      // The RTC slow clock: the 136 kHz internal oscillator.
      const ticks = Math.floor((this.clock.nanos * 136e3) / 1e9);
      this.regs.set(0x10, ticks % 2 ** 32);
      this.regs.set(0x14, Math.floor(ticks / 2 ** 32));
      this.regs.set(0x0c, value & ~(1 << 31));
    }
  }
}

export interface Esp32S3Options {
  onUnclaimedMmio?: (address: number, write: boolean, value: number) => void;
}

function buildRomTable(): Map<number, Esp32RomEntry> {
  const table = new Map<number, Esp32RomEntry>();
  for (const [name, address] of Object.entries(ESP32S3_ROM_ADDRESSES)) {
    const handler = s3Handler(name);
    if (handler && !table.has(address)) table.set(address, { name, handler });
  }
  return table;
}

export class Esp32S3Machine extends EspXtensaMachine {
  readonly sram0 = new Uint8Array(SRAM0_END - SRAM0_BASE);
  readonly dram = new Uint8Array(DRAM_END - DRAM_BASE);
  readonly rtcFast = new Uint8Array(RTC_SIZE);
  readonly rtcSlow = new Uint8Array(RTC_SIZE);
  /** The MMU: [entry] = flash byte offset of the page, or -1. */
  private readonly pageBase = new Int32Array(MMU_ENTRIES).fill(-1);
  private readonly mmuRaw = new Uint32Array(MMU_ENTRIES).fill(MMU_INVALID);
  readonly gpio: Esp32Gpio;
  readonly uarts: EspUart[];
  readonly timerGroups: Esp32TimerGroup[];
  readonly sens = new Esp32Sens(ESP32S3_SENS);
  private readonly system = new Store('system', SYSTEM_BASE, 0x1000, [[0x00, 1 << 2]]);
  /** eFuse: a factory MAC (RD_MAC_SPI_SYS_0/1), chip revision 0.0, nothing else burnt. */
  private readonly efuse = new Store('efuse', 0x60007000, 0x1000, [[0x44, 0xc4123456 >>> 0], [0x48, 0x0000240a]]);
  private readonly rtc: S3RtcCntl;
  private readonly fallback = new Map<number, number>();
  private readonly sparse = new Map<number, Uint8Array>();
  private appBootAddress = 0;
  private appReleased = false;
  protected override readonly romName = 'ESP32-S3';
  /** The guest-call glue's place: ROM space below the qsort routine that no ROM routine uses. */
  protected override readonly glueBase = 0x4005fc00;

  constructor(
    flash: SerialNorFlash,
    private readonly options: Esp32S3Options = {},
  ) {
    super(flash, [esp32CoreConfig(0xcdcd), esp32CoreConfig(0xabab)], ESP32S3_SOURCE.count, { start: ROM_START, end: ROM_END }, buildRomTable());
    this.romCode.push({ start: S3_REENT_TRAMPOLINE, end: S3_REENT_TRAMPOLINE + REENT_TRAMPOLINE_CODE.length });
    this.romCode.push({ start: S3_QSORT_AT, end: S3_QSORT_AT + S3_QSORT_CODE.length });
    this.gpio = new Esp32Gpio(this, ESP32S3_SOURCE.gpio, ESP32S3_GPIO_LAYOUT);
    this.gpio.onInterruptChange = () => (this.interruptsDirty = true);
    this.rtc = new S3RtcCntl(this);
    const apb = () => this.apbHz();
    this.uarts = [
      new EspUart('uart0', 0x60000000, this, ESP32S3_SOURCE.uart0, ESP32S3_UART_LAYOUT),
      new EspUart('uart1', 0x60010000, this, ESP32S3_SOURCE.uart1, ESP32S3_UART_LAYOUT),
      new EspUart('uart2', 0x6002e000, this, ESP32S3_SOURCE.uart2, ESP32S3_UART_LAYOUT),
    ];
    this.timerGroups = [
      new Esp32TimerGroup('timg0', 0x6001f000, this, [50, 51, 52, 52], apb, ESP32S3_TIMG_LAYOUT),
      new Esp32TimerGroup('timg1', 0x60020000, this, [53, 54, 55, 55], apb, ESP32S3_TIMG_LAYOUT),
    ];
    const signals = {
      driveSignal: (signal: number, drive: { level: 0 | 1; enable: boolean } | undefined) => {
        if (drive) this.gpio.driveSignal(signal, drive.level);
      },
    };
    for (const p of [
      this.system, this.rtc, this.gpio, this.gpio.ioMux, ...this.uarts, ...this.timerGroups,
      new SysTimer(this, 0x60023000, ESP32S3_SOURCE.systimerTarget0),
      new SpiMemController(flash, 0x60002000),
      new Store('spi0', 0x60003000, 0x1000),
      // The analog I2C master: ANA_CONF0's BBPLL_CAL_DONE (bit 24), calibration being instant here.
      new Store('i2c_mst', 0x6000e000, 0x1000, [], [[0x40, 1 << 24]]),
      // EXTMEM: the cache controller. CACHE_STATE reads both caches idle (its reset value).
      new Store('extmem', 0x600c4000, 0x1000, [[0x130, 0x00001001]]),
      this.efuse,
      // The Wi-Fi block's random number generator (WDEV_RND_REG, 0x6003507C):
      // lwIP draws its ports and sequence numbers from it and retries until
      // they suit, so it must vary.
      new S3Rng(),
      // USB Serial/JTAG: nothing on the other end; its IN endpoint always has room.
      new Store('usb_serial_jtag', 0x60038000, 0x1000, [[0x04, 0x2]]),
      new EspLedc(ESP32S3_LEDC, this, signals),
      new EspI2c({ base: 0x60013000, interruptSource: ESP32S3_SOURCE.i2c0, sclSignal: 89, sdaSignal: 90 }, this, () => this.ports.i2c),
      new EspI2c({ base: 0x60027000, interruptSource: ESP32S3_SOURCE.i2c1, sclSignal: 91, sdaSignal: 92 }, this, () => this.ports.i2c),
      new EspSpi2(S3_SPI2, () => this.ports.spi),
      new EspSpi2(S3_SPI3, () => this.ports.spi),
      this.sens,
      new Esp32S3Mcpwm('mcpwm0', 0x6001e000, 0, this, this.gpio),
      new Esp32S3Mcpwm('mcpwm1', 0x6002c000, 1, this, this.gpio),
    ]) this.addPeripheral(p);
  }

  private factoryMac: readonly number[] | null = null;

  /** Burns a factory MAC: bytes 5..2 in RD_MAC_SPI_SYS_0, 1..0 in SYS_1, as ESP-IDF reads them back reversed. */
  setFactoryMac(mac: readonly number[]): void {
    this.factoryMac = mac;
    this.efuse.regs.set(0x44, ((mac[2] << 24) | (mac[3] << 16) | (mac[4] << 8) | mac[5]) >>> 0);
    this.efuse.regs.set(0x48, (mac[0] << 8) | mac[1]);
  }

  // ------------------------------------------------------------- clocks

  override get cpuMhz(): number {
    const sysclk = this.system.readUint32(0x60);
    if (((sysclk >>> 10) & 3) === 1) {
      const per = this.system.readUint32(0x10);
      const pll480 = ((per >>> 2) & 1) === 1;
      return [80, 160, pll480 ? 240 : 160, 160][per & 3];
    }
    return 40 / ((sysclk & 0x3ff) + 1);
  }

  apbHz(): number {
    return ((this.system.readUint32(0x60) >>> 10) & 3) === 1 ? 80e6 : this.cpuMhz * 1e6;
  }

  // ------------------------------------------------------------- loading

  override loadImage(image: EspApplicationImage): void {
    this.image = image;
    this.sram0.fill(0);
    this.dram.fill(0);
    this.rtcFast.fill(0);
    this.rtcSlow.fill(0);
    this.sparse.clear();
    this.fallback.clear();
    for (const p of this.peripherals) p.reset?.();
    if (this.factoryMac) this.setFactoryMac(this.factoryMac);
    this.pageBase.fill(-1);
    this.mmuRaw.fill(MMU_INVALID);
    for (const seg of image.segments) {
      const a = seg.loadAddress >>> 0;
      if (!this.isCache(a)) continue;
      const flashAddress = 0x10000 + seg.fileOffset;
      const firstPage = Math.floor(flashAddress / 0x10000);
      const pages = Math.ceil(((flashAddress % 0x10000) + seg.data.length) / 0x10000);
      const entry = (a & 0x1ffffff) >>> 16;
      for (let i = 0; i < pages; i++) this.writeMmu(entry + i, firstPage + i);
    }
    for (const seg of image.segments) {
      const a = seg.loadAddress >>> 0;
      if (this.isCache(a)) continue;
      for (let i = 0; i < seg.data.length; i++) this.write8(a + i, seg.data[i]);
    }
    this.romState.cpuTicksPerUs = 40;
    this.romState.regi2c.clear();
    this.romState.md5.clear();
    REENT_TRAMPOLINE_CODE.forEach((b, k) => this.write8(S3_REENT_TRAMPOLINE + k, b));
    S3_QSORT_CODE.forEach((b, k) => this.write8(S3_QSORT_AT + k, b));
    this.installGlue();
    this.installRomData();
    this.appBootAddress = 0;
    this.appReleased = false;
    this.resetCores();
    this.startCore(0, image.entryPoint, PRO_ROM_STACK);
    this.fault = null;
    this.interruptsDirty = true;
  }

  /**
   * What the ROM publishes as data. ESP-IDF's heap set-up reads the reserved
   * DRAM ranges through ets_rom_layout_p, and its flash driver takes the
   * chip's size from the descriptor rom_spiflash_legacy_data points at.
   */
  private installRomData(): void {
    const fields = [ROM_STACK_START, ROM_STACK_START, ROM_STACK_START - ROM_STACK_SIZE, DRAM_END, ROM_STACK_START - ROM_STACK_SIZE, DRAM_END];
    for (let i = 0; i < 40; i++) this.write32(ROM_LAYOUT_AT + i * 4, fields[i] ?? DRAM_END);
    this.write32(ETS_ROM_LAYOUT_P, ROM_LAYOUT_AT);
    const id = this.flash.id;
    [(id.manufacturer << 16) | (id.memoryType << 8) | id.capacity, this.flash.sizeBytes, 0x10000, 0x1000, 0x100, 0xffff, 0].forEach(
      (v, k) => this.write32(FLASHCHIP_AT + k * 4, v),
    );
    this.write32(ROM_SPIFLASH_LEGACY_DATA, FLASHCHIP_AT);
    [...S3_COEX_VERSION, '\0'].forEach((c, k) => this.write8(S3_COEX_VERSION_AT + k, c.charCodeAt(0)));
  }

  private isCache(a: number): boolean {
    return (a >= IROM_BASE && a < IROM_END) || (a >= DROM_BASE && a < DROM_END);
  }

  private writeMmu(entry: number, value: number): void {
    this.mmuRaw[entry] = value;
    this.pageBase[entry] = value & MMU_INVALID ? -1 : (value & 0x3fff) * 0x10000;
  }

  // ------------------------------------------------------------- the bus

  private flashByte(a: number): number {
    const base = this.pageBase[(a & 0x1ffffff) >>> 16];
    if (base < 0) return 0;
    return this.flash.bytes[(base + (a & 0xffff)) % this.flash.bytes.length];
  }

  protected override fetch(a: number, cpu: number): number {
    a >>>= 0;
    if (a >= IROM_BASE && a < IROM_END && (a & 0xffff) <= 0xfffd) {
      const base = this.pageBase[(a & 0x1ffffff) >>> 16];
      if (base >= 0) {
        const o = base + (a & 0xffff);
        const f = this.flash.bytes;
        if (o + 2 < f.length) return f[o] | (f[o + 1] << 8) | (f[o + 2] << 16);
      }
    } else if (a >= IRAM_ALIAS_BASE && a + 2 < IRAM_ALIAS_END) {
      const o = a - I_D_OFFSET - DRAM_BASE;
      const m = this.dram;
      return m[o] | (m[o + 1] << 8) | (m[o + 2] << 16);
    }
    return this.read8(a, cpu) | (this.read8(a + 1, cpu) << 8) | (this.read8(a + 2, cpu) << 16);
  }

  override read8(a: number, _cpu = this.current): number {
    a >>>= 0;
    if (a >= DRAM_BASE && a < DRAM_END) return this.dram[a - DRAM_BASE];
    if (a >= IRAM_ALIAS_BASE && a < IRAM_ALIAS_END) return this.dram[a - I_D_OFFSET - DRAM_BASE];
    if (a >= IROM_BASE && a < IROM_END) return this.flashByte(a);
    if (a >= DROM_BASE && a < DROM_END) return this.flashByte(a);
    if (a >= SRAM0_BASE && a < SRAM0_END) return this.sram0[a - SRAM0_BASE];
    if (a >= RTC_FAST && a < RTC_FAST + RTC_SIZE) return this.rtcFast[a - RTC_FAST];
    if (a >= MMIO_BASE && a < MMIO_END) return (this.mmioRead(a & ~3) >>> ((a & 3) * 8)) & 0xff;
    if (a >= RTC_SLOW && a < RTC_SLOW + RTC_SIZE) return this.rtcSlow[a - RTC_SLOW];
    return this.sparse.get(a >>> 16)?.[a & 0xffff] ?? 0;
  }

  override read32(a: number, cpu = this.current): number {
    a >>>= 0;
    if (a >= DRAM_BASE && a + 3 < DRAM_END) {
      const o = a - DRAM_BASE;
      const m = this.dram;
      return (m[o] | (m[o + 1] << 8) | (m[o + 2] << 16) | (m[o + 3] << 24)) >>> 0;
    }
    if (a >= MMIO_BASE && a < MMIO_END && !(a >= RTC_FAST)) return this.mmioRead(a);
    return (this.read8(a, cpu) | (this.read8(a + 1, cpu) << 8) | (this.read8(a + 2, cpu) << 16) | (this.read8(a + 3, cpu) << 24)) >>> 0;
  }

  override write8(a: number, v: number): void {
    a >>>= 0;
    v &= 0xff;
    if (a >= DRAM_BASE && a < DRAM_END) this.dram[a - DRAM_BASE] = v;
    else if (a >= IRAM_ALIAS_BASE && a < IRAM_ALIAS_END) this.dram[a - I_D_OFFSET - DRAM_BASE] = v;
    else if (a >= SRAM0_BASE && a < SRAM0_END) this.sram0[a - SRAM0_BASE] = v;
    else if (a >= RTC_FAST && a < RTC_FAST + RTC_SIZE) this.rtcFast[a - RTC_FAST] = v;
    else if (a >= MMIO_BASE && a < MMIO_END) this.mmioWrite(a, v, 1);
    else if (a >= RTC_SLOW && a < RTC_SLOW + RTC_SIZE) this.rtcSlow[a - RTC_SLOW] = v;
    else if (this.isCache(a) || a < 0x3c000000) return;
    else {
      let page = this.sparse.get(a >>> 16);
      if (!page) this.sparse.set(a >>> 16, (page = new Uint8Array(0x10000)));
      page[a & 0xffff] = v;
    }
  }

  override write16(a: number, v: number): void {
    if (a >= MMIO_BASE && a < MMIO_END) this.mmioWrite(a, v, 2);
    else {
      this.write8(a, v);
      this.write8(a + 1, v >> 8);
    }
  }

  override write32(a: number, v: number): void {
    a >>>= 0;
    if (a >= DRAM_BASE && a + 3 < DRAM_END) {
      const o = a - DRAM_BASE;
      const m = this.dram;
      m[o] = v;
      m[o + 1] = v >>> 8;
      m[o + 2] = v >>> 16;
      m[o + 3] = v >>> 24;
      return;
    }
    if (a >= MMIO_BASE && a < MMIO_END) {
      this.mmioWrite(a, v, 4);
      return;
    }
    this.write8(a, v);
    this.write8(a + 1, v >>> 8);
    this.write8(a + 2, v >>> 16);
    this.write8(a + 3, v >>> 24);
  }

  private peripheralAt(a: number): Peripheral | undefined {
    for (const p of this.peripherals) if (a >= p.base && a < p.base + p.size) return p;
    return undefined;
  }

  private mmioRead(addr: number): number {
    const a = (addr >>> 0) & ~3;
    if (a >= MMU_TABLE && a < MMU_TABLE + MMU_ENTRIES * 4) return this.mmuRaw[(a - MMU_TABLE) >> 2];
    if (a >= INTERRUPT_BASE && a < INTERRUPT_BASE + 0x1000) return this.matrixRead(a - INTERRUPT_BASE);
    const p = this.peripheralAt(a);
    if (p) return p.readUint32(a - p.base) >>> 0;
    this.options.onUnclaimedMmio?.(a, false, 0);
    return this.fallback.get(a) ?? 0;
  }

  private mmioWrite(addr: number, v: number, size: 1 | 2 | 4): void {
    const a = (addr >>> 0) & ~3;
    if (size !== 4) {
      const shift = (addr & 3) * 8;
      const mask = (size === 1 ? 0xff : 0xffff) << shift;
      v = ((this.mmioRead(a) & ~mask) | ((v << shift) & mask)) >>> 0;
    }
    v >>>= 0;
    this.interruptsDirty = true;
    if (a >= MMU_TABLE && a < MMU_TABLE + MMU_ENTRIES * 4) {
      this.writeMmu((a - MMU_TABLE) >> 2, v);
      return;
    }
    if (a >= INTERRUPT_BASE && a < INTERRUPT_BASE + 0x1000) {
      this.matrixWrite(a - INTERRUPT_BASE, v);
      return;
    }
    if (a === SYSTEM_BASE) {
      // SYSTEM_CORE_1_CONTROL_0: RESETING falling releases the APP CPU into the ROM.
      const before = this.system.readUint32(0);
      this.system.writeUint32(0, v);
      if (before & 4 && !(v & 4)) {
        this.appReleased = true;
        this.maybeStartApp();
      }
      return;
    }
    const p = this.peripheralAt(a);
    if (p) {
      p.writeUint32(a - p.base, v);
      return;
    }
    this.options.onUnclaimedMmio?.(a, true, v);
    this.fallback.set(a, v);
  }

  // ------------------------------------------------------------- interrupt matrix and CPUs

  private matrixRead(off: number): number {
    const core = off >= 0x800 ? 1 : 0;
    const o = off & 0x7ff;
    if (o < ESP32S3_SOURCE.count * 4) return this.slots[core].map[o >> 2];
    if (o >= 0x18c && o < 0x198) {
      let v = 0;
      const word = (o - 0x18c) >> 2;
      for (const s of this.asserted) if (s >> 5 === word) v |= 1 << (s & 31);
      return v >>> 0;
    }
    return this.fallback.get(INTERRUPT_BASE + off) ?? 0;
  }

  private matrixWrite(off: number, v: number): void {
    const core = off >= 0x800 ? 1 : 0;
    const o = off & 0x7ff;
    if (o < ESP32S3_SOURCE.count * 4) {
      this.slots[core].map[o >> 2] = v & 0x1f;
      return;
    }
    this.fallback.set(INTERRUPT_BASE + off, v);
  }

  setAppCpuBootAddress(address: number): void {
    this.appBootAddress = address >>> 0;
    this.maybeStartApp();
  }

  private maybeStartApp(): void {
    if (this.slots[1].running || !this.appBootAddress) return;
    const ctrl = this.system.readUint32(0);
    if (!this.appReleased || !(ctrl & 2) || ctrl & 1) return;
    this.startCore(1, this.appBootAddress, APP_ROM_STACK);
  }

  protected override softwareSources(): number[] {
    // SYSTEM_CPU_INTR_FROM_CPU_0..3.
    const out: number[] = [];
    for (let n = 0; n < 4; n++) if (this.system.readUint32(0x30 + n * 4) & 1) out.push(ESP32S3_SOURCE.fromCpu0 + n);
    return out;
  }

  // ------------------------------------------------------------- ROM

  protected override romHost(i: number): Esp32RomHost {
    const slot = this.slots[i];
    const cpu = slot.cpu;
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const machine = this;
    const gpio = this.gpio;
    const mux = (n: number, f: (v: number) => number) => {
      const off = ESP32S3_GPIO_LAYOUT.ioMuxOffset[n];
      if (off === undefined || off < 0) return;
      gpio.ioMux.writeUint32(off, f(gpio.ioMux.readUint32(off)) >>> 0);
    };
    return {
      cpu: i,
      core: cpu,
      arg: (k) => cpu.romArg(k),
      sp: () => cpu.romSp(),
      read8: (a) => machine.read8(a, i),
      read32: (a) => machine.read32(a, i),
      write8: (a, v) => machine.write8(a, v),
      write32: (a, v) => machine.write32(a, v),
      console: (b) => machine.onConsoleByte?.(b),
      consoleRead: () => undefined,
      delayUs: (us) => {
        slot.stalledUntil = slot.ns + (us >>> 0) * 1000;
      },
      state: machine.romState,
      setInterruptMap: (c, s, l) => machine.setInterruptMap(c, s, l),
      setAppCpuBootAddress: (a) => machine.setAppCpuBootAddress(a),
      mmuSet: () => 0,
      mmuInit: () => {},
      gpioMatrixIn: (n, signal, inv) => {
        if (signal < 256) gpio.writeUint32(ESP32S3_GPIO_LAYOUT.funcInSel + signal * 4, (n & 0x3f) | (inv ? 1 << 6 : 0) | (1 << 7));
      },
      gpioMatrixOut: (n, signal, inv, oenInv) => {
        if (n < ESP32S3_GPIO_LAYOUT.padCount) gpio.writeUint32(ESP32S3_GPIO_LAYOUT.funcOutSel + n * 4, (signal & 0x1ff) | (inv ? 1 << 9 : 0) | (oenInv ? 1 << 11 : 0));
      },
      padSelectGpio: (n) => mux(n, (v) => (v & ~(7 << 12)) | (1 << 12)),
      padPull: (n, up, down) => mux(n, (v) => (v & ~(3 << 7)) | (up ? 1 << 8 : 0) | (down ? 1 << 7 : 0)),
      padDrive: (n, strength) => mux(n, (v) => (v & ~(3 << 10)) | ((strength & 3) << 10)),
      softwareReset: () => machine.softwareReset(),
      syscallTablePointer: SYSCALL_TABLE_PTR,
      reentTrampoline: S3_REENT_TRAMPOLINE,
      get ps() {
        return cpu.ps;
      },
      set ps(v: number) {
        cpu.ps = v >>> 0;
      },
    };
  }
}
