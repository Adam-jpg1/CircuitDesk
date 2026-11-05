// The ESP32 (ESP32-D0WD): two Xtensa LX6 cores, their memory map, the flash
// cache and its MMU, the interrupt matrix, and the peripherals an Arduino
// sketch reaches.
//
// Addresses are from ESP-IDF's soc/esp32 headers (reg_base.h, soc.h,
// ext_mem_defs.h, dport_reg.h) and the chip's linker scripts. What happens at
// boot is what the second-stage bootloader leaves behind: the application's
// RAM segments loaded, its flash segments mapped through the MMU, and the PRO
// CPU entering call_start_cpu0 on the ROM's stack. The APP CPU stays in reset
// until the firmware releases it through DPORT and hands the ROM a start
// address, exactly as ESP-IDF's start_other_core() does.
//
// Time: each core retires one instruction per clock cycle of the frequency
// the firmware configured (DPORT_CPU_PER_CONF and RTC_CNTL_CLK_CONF), and the
// two cores are interleaved on the same timeline. A core in WAITI costs
// nothing — the clock jumps to the next thing that can wake it.

import type { XtensaConfig } from '../xtensa/xtensa';
import { EspXtensaMachine } from '../xtensa/espXtensaMachine';
import type { Peripheral, SimulatedClock } from '../espRiscv/peripheral';
import { EspUart, type UartLayout } from '../espRiscv/uart';
import type { SerialNorFlash } from '../esp32c3/spiFlash';
import { FLASH_COMMAND } from '../esp32c3/spiFlash';
import type { EspApplicationImage } from '../esp32c3/espImage';
import { Esp32Gpio, IO_MUX_OFFSET } from './gpio';
import { Esp32TimerGroup } from './timg';
import { Esp32Ledc } from './ledc';
import { Esp32Spi } from './spi';
import { Esp32Sens } from './adc';
import { EspI2c } from '../espRiscv/i2c';
import { ESP32_ROM, ESP32_ROM_END, ESP32_SYSCALL_TABLE_PTR, REENT_TRAMPOLINE, REENT_TRAMPOLINE_CODE, ESP32_ROM_START, esp32MacCrc8, type Esp32RomHost } from './rom';

/** Interrupt level of each CPU interrupt number on the ESP32 (XCHAL_INT*_LEVEL). */
export const ESP32_INT_LEVEL = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 3, 1, 1, 7, 3, 5, 1, 1, 2, 2, 2, 3, 3, 4, 4, 5, 3, 4, 3, 4, 5];
export const ESP32_SOURCE = {
  tg0T0: 14, tg0T1: 15, tg0Wdt: 16, tg0Lact: 17, tg1T0: 18, tg1T1: 19, tg1Wdt: 20, tg1Lact: 21,
  gpio: 22, fromCpu0: 24, spi2: 30, spi3: 31, uart0: 34, uart1: 35, uart2: 36, ledc: 43, rtcCore: 46,
  rmt: 47, pcnt: 48, i2c0: 49, i2c1: 50, count: 69,
} as const;

export function esp32CoreConfig(prid: number): XtensaConfig {
  return {
    windowed: true,
    fpu: true,
    nareg: 64,
    excmLevel: 3,
    intLevel: ESP32_INT_LEVEL,
    timerInt: [6, 15, 16],
    vectors: { level: { 2: 0x180, 3: 0x1c0, 4: 0x200, 5: 0x240, 6: 0x280, 7: 0x2c0 }, kernel: 0x300, user: 0x340, double: 0x3c0 },
    prid,
    vecbase: 0x40000000,
  };
}

/** The ESP32 UART: counts in 8 bits, thresholds in 7-bit fields a byte apart. */
export const ESP32_UART_LAYOUT: UartLayout = {
  countBits: 8,
  conf0RxfifoRst: 17,
  conf0TxfifoRst: 18,
  conf1FieldBits: 8,
  toutEnable: { offset: 0x24, bit: 31 },
  selfClearing: [],
  fsmStatus: -1,
  memRxStatus: 0x60,
};

const DRAM_BASE = 0x3ffa0000;
const DRAM_END = 0x40000000;
const IRAM_BASE = 0x40070000;
const IRAM_END = 0x400c0000;
const RTC_FAST_D = 0x3ff80000;
const RTC_FAST_I = 0x400c0000;
const RTC_SLOW = 0x50000000;
const RTC_SIZE = 0x2000;
const DROM_BASE = 0x3f400000;
const DROM_END = 0x3f800000;
const IROM_BASE = 0x400d0000;
const IROM_END = 0x40400000;
const MMIO_BASE = 0x3ff00000;
const MMIO_END = 0x3ff80000;
const AHB_ALIAS = 0x60000000;
/** newlib's ctype table in the ESP32's ROM data (esp32.rom.newlib-data.ld). */
const CTYPE_PTR = 0x3ff96350;
const CTYPE_TABLE = 0x3ff96354;
const MMU_INVALID = 0x100;
/** Where the ROM leaves each CPU's stack before the application sets its own. */
const PRO_ROM_STACK = 0x3ffe3f00;
const APP_ROM_STACK = 0x3ffe7f00;

/** Plain register storage, for blocks whose registers only need to read back. */
class Store implements Peripheral {
  readonly regs = new Map<number, number>();
  constructor(readonly name: string, readonly base: number, readonly size: number) {}
  readUint32(offset: number): number {
    return (this.regs.get(offset) ?? 0) >>> 0;
  }
  writeUint32(offset: number, value: number): void {
    this.regs.set(offset, value >>> 0);
  }
  reset(): void {
    this.regs.clear();
  }
}

/** SPI1, the controller ESP-IDF drives to read, erase and program the flash. */
/**
 * The Wi-Fi block's hardware random number generator (WDEV_RND_REG, 0x3FF75144).
 * esp_random() reads it, and lwIP draws its DNS ports and TCP sequence numbers
 * from esp_random(), retrying until the value suits — so a register that reads
 * a constant hangs the network stack.
 */
class Esp32Rng extends Store {
  private seed = 0x9e3779b9;
  constructor() {
    super('wdev', 0x3ff75000, 0x1000);
  }
  override readUint32(offset: number): number {
    if (offset !== 0x144) return super.readUint32(offset);
    // xorshift32: the hardware's is noise; firmware only needs it to vary.
    let x = this.seed;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.seed = x >>> 0;
    return this.seed;
  }
}

class Esp32Spi1 extends Store {
  constructor(private readonly flash: SerialNorFlash) {
    super('spi1', 0x3ff42000, 0x1000);
  }

  override readUint32(offset: number): number {
    if (offset === 0x00) return 0; // every command has finished
    return super.readUint32(offset);
  }

  override writeUint32(offset: number, value: number): void {
    super.writeUint32(offset, value);
    if (offset !== 0x00 || value === 0) return;
    const C = FLASH_COMMAND;
    const addrReg = this.readUint32(0x04);
    if (value & (1 << 18)) {
      const user = this.readUint32(0x1c);
      const user1 = this.readUint32(0x20);
      const user2 = this.readUint32(0x24);
      let command = 0;
      if (user & (1 << 31)) {
        const bits = ((user2 >>> 28) & 0xf) + 1;
        command = user2 & ((1 << bits) - 1);
      }
      let address = 0;
      if (user & (1 << 30)) {
        // A user transaction sends ADDR from its top bit (spi_flash_ll_set_usr_address).
        const bits = ((user1 >>> 26) & 0x3f) + 1;
        address = bits >= 32 ? addrReg : addrReg >>> (32 - bits);
      }
      const mosiLen = user & (1 << 27) ? Math.ceil(((this.readUint32(0x28) & 0xffffff) + 1) / 8) : 0;
      const misoLen = user & (1 << 28) ? Math.ceil(((this.readUint32(0x2c) & 0xffffff) + 1) / 8) : 0;
      const miso = this.flash.transfer(command, address, this.buffer(Math.min(64, mosiLen)), Math.min(64, misoLen));
      this.fill(miso);
      return;
    }
    const address = addrReg & 0xffffff;
    const length = (addrReg >>> 24) & 0xff;
    const none = new Uint8Array(0);
    if (value & (1 << 30)) this.flash.transfer(C.writeEnable, address, none, 0);
    if (value & (1 << 29)) this.flash.transfer(C.writeDisable, address, none, 0);
    if (value & (1 << 28)) this.fill(this.flash.transfer(C.readId, address, none, 3));
    if (value & (1 << 27)) this.regs.set(0x10, this.flash.transfer(C.readStatus1, address, none, 1)[0]);
    if (value & (1 << 25)) this.flash.transfer(C.pageProgram, address, this.buffer(length), 0);
    if (value & (1 << 24)) this.flash.transfer(C.sectorErase, address, none, 0);
    if (value & (1 << 23)) this.flash.transfer(C.blockErase64k, address, none, 0);
    if (value & (1 << 22)) this.flash.transfer(C.chipErase, address, none, 0);
    if (value & (1 << 31)) this.fill(this.flash.transfer(C.read, address, none, length));
  }

  private buffer(length: number): Uint8Array {
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i++) out[i] = (this.readUint32(0x80 + (i >> 2) * 4) >>> ((i & 3) * 8)) & 0xff;
    return out;
  }

  private fill(data: Uint8Array): void {
    for (let i = 0; i < data.length; i += 4) {
      let word = 0;
      for (let b = 0; b < 4; b++) word |= (data[i + b] ?? 0xff) << (b * 8);
      this.regs.set(0x80 + i, word >>> 0);
    }
  }
}

/** RTC_CNTL: reset state, the RTC timer, CPU stall control and the store registers. */
class RtcCntl extends Store {
  constructor(private readonly clock: SimulatedClock) {
    super('rtc_cntl', 0x3ff48000, 0x400);
    this.reset();
  }
  override reset(): void {
    super.reset();
    // What the bootloader records for the application: the crystal in MHz
    // (STORE4) and the APB clock >> 12 (STORE5), each duplicated in the high
    // half as the check rtc_clk_xtal_freq_get() makes.
    this.regs.set(0xb0, 0x00280028);
    this.regs.set(0xb4, ((40e6 >>> 12) << 16) | (40e6 >>> 12));
  }
  override readUint32(offset: number): number {
    // TIME_UPDATE: the value is valid as soon as it is asked for.
    if (offset === 0x0c) return (super.readUint32(offset) | (1 << 30)) >>> 0;
    // RESET_STATE: both CPUs' reset reason, power-on.
    if (offset === 0x34) return super.readUint32(offset) || 0x3001;
    return super.readUint32(offset);
  }
  override writeUint32(offset: number, value: number): void {
    super.writeUint32(offset, value);
    if (offset === 0x0c && value >>> 31) {
      // The RTC slow clock: the 150 kHz internal oscillator.
      const ticks = Math.floor((this.clock.nanos * 150e3) / 1e9);
      this.regs.set(0x10, ticks % 2 ** 32);
      this.regs.set(0x14, Math.floor(ticks / 2 ** 32));
    }
  }
}

/** eFuse: a factory MAC with its CRC, chip revision 1, no flash encryption. */
class Efuse extends Store {
  constructor(private mac: readonly number[] = ESP32_DEFAULT_MAC) {
    super('efuse', 0x3ff5a000, 0x1000);
    this.reset();
  }
  override reset(): void {
    super.reset();
    const mac = this.mac;
    // BLK0 RDATA1 (0x04) holds MAC bytes 5..2, RDATA2 (0x08) bytes 1..0 and,
    // in bits 23:16, the CRC ESP-IDF checks over the MAC in its usual order.
    this.regs.set(0x04, ((mac[2] << 24) | (mac[3] << 16) | (mac[4] << 8) | mac[5]) >>> 0);
    this.regs.set(0x08, (esp32MacCrc8(mac) << 16) | (mac[0] << 8) | mac[1]);
    // RDATA3 (0x0c): chip revision bit 15 (rev 1), package D0WD.
    this.regs.set(0x0c, 1 << 15);
  }
  setMac(mac: readonly number[]): void {
    this.mac = mac;
    this.reset();
  }
}

/** The factory MAC a board gets unless the runner gives it its own (Espressif's 24:0A:C4 OUI). */
export const ESP32_DEFAULT_MAC: readonly number[] = [0x24, 0x0a, 0xc4, 0x12, 0x34, 0x56];

export interface Esp32Options {
  onUnclaimedMmio?: (address: number, write: boolean, value: number) => void;
  /** The factory MAC burnt into eFuse: each board on a network needs its own. */
  mac?: readonly number[];
}

export class Esp32Machine extends EspXtensaMachine {
  /** The factory MAC in eFuse, which the firmware reads as it boots. */
  get factoryMac(): readonly number[] {
    return this.efuseMac;
  }

  setFactoryMac(mac: readonly number[]): void {
    this.efuseMac = mac;
    this.efuse.setMac(mac);
  }

  private efuseMac: readonly number[] = ESP32_DEFAULT_MAC;

  /**
   * newlib's character classes, which the ESP32's libc takes from mask-ROM
   * data (esp32.rom.newlib-data.ld): __ctype_ptr__ at 0x3FF96350 points at
   * _ctype_, one entry for EOF then one per character. isspace(), isdigit()
   * and Arduino's String::trim() read it; with nothing there every character
   * is in no class at all.
   */
  private installCtype(): void {
    const U = 0x01, L = 0x02, N = 0x04, S = 0x08, P = 0x10, C = 0x20, X = 0x40, B = 0x80;
    const cls = (c: number): number => {
      if (c === 32) return S | B;
      if (c >= 9 && c <= 13) return C | S;
      if (c < 32 || c === 127) return C;
      if (c >= 48 && c <= 57) return N;
      if (c >= 65 && c <= 90) return U | (c <= 70 ? X : 0);
      if (c >= 97 && c <= 122) return L | (c <= 102 ? X : 0);
      return c < 127 ? P : 0;
    };
    this.write32(CTYPE_PTR, CTYPE_TABLE);
    this.write8(CTYPE_TABLE, 0);
    for (let c = 0; c < 256; c++) this.write8(CTYPE_TABLE + 1 + c, cls(c));
  }

  /** The guest-call glue's place: ROM space below the newlib trampoline that no ROM routine uses. */
  protected override readonly glueBase = 0x4006fe00;
  readonly dram = new Uint8Array(DRAM_END - DRAM_BASE);
  private readonly efuse: Efuse;
  readonly iram = new Uint8Array(IRAM_END - IRAM_BASE);
  readonly rtcFast = new Uint8Array(RTC_SIZE);
  readonly rtcSlow = new Uint8Array(RTC_SIZE);
  /** Flash MMU: 256 entries per CPU; [cpu * 256 + entry] = flash byte offset of the page, or -1. */
  private readonly pageBase = new Int32Array(512).fill(-1);
  private readonly mmuRaw = new Uint32Array(512).fill(MMU_INVALID);
  readonly gpio: Esp32Gpio;
  readonly uarts: EspUart[];
  readonly timerGroups: Esp32TimerGroup[];
  readonly sens = new Esp32Sens();
  private readonly dport = new Store('dport', 0x3ff00000, 0x1000);
  private readonly rtc: RtcCntl;
  private readonly fallback = new Map<number, number>();
  private readonly sparse = new Map<number, Uint8Array>();
  private appBootAddress = 0;
  private appReleased = false;
  constructor(
    flash: SerialNorFlash,
    private readonly options: Esp32Options = {},
  ) {
    super(flash, [esp32CoreConfig(0xcdcd), esp32CoreConfig(0xabab)], ESP32_SOURCE.count, { start: ESP32_ROM_START, end: ESP32_ROM_END }, ESP32_ROM);
    this.romCode.push({ start: REENT_TRAMPOLINE, end: REENT_TRAMPOLINE + REENT_TRAMPOLINE_CODE.length });
    this.efuse = new Efuse(options.mac);
    if (options.mac) this.efuseMac = options.mac;
    this.gpio = new Esp32Gpio(this, ESP32_SOURCE.gpio);
    this.gpio.onInterruptChange = () => (this.interruptsDirty = true);
    this.rtc = new RtcCntl(this);
    const apb = () => this.apbHz();
    this.uarts = [
      new EspUart('uart0', 0x3ff40000, this, ESP32_SOURCE.uart0, ESP32_UART_LAYOUT, () => this.uartClockConf(0)),
      new EspUart('uart1', 0x3ff50000, this, ESP32_SOURCE.uart1, ESP32_UART_LAYOUT, () => this.uartClockConf(1)),
      new EspUart('uart2', 0x3ff6e000, this, ESP32_SOURCE.uart2, ESP32_UART_LAYOUT, () => this.uartClockConf(2)),
    ];
    this.timerGroups = [
      new Esp32TimerGroup('timg0', 0x3ff5f000, this, [14, 15, 16, 17], apb),
      new Esp32TimerGroup('timg1', 0x3ff60000, this, [18, 19, 20, 21], apb),
    ];
    for (const p of [
      this.dport, this.rtc, this.gpio, this.gpio.ioMux, this.gpio.rtcIo, ...this.uarts, ...this.timerGroups,
      new Esp32Spi1(flash), this.efuse, new Esp32Rng(), new Esp32Ledc(this, this.gpio, apb),
      new EspI2c({ base: 0x3ff53000, interruptSource: ESP32_SOURCE.i2c0, sclSignal: 29, sdaSignal: 30, classic: { name: 'i2c0', commands: 16, apbHz: apb } }, this, () => this.ports.i2c),
      new EspI2c({ base: 0x3ff67000, interruptSource: ESP32_SOURCE.i2c1, sclSignal: 95, sdaSignal: 96, classic: { name: 'i2c1', commands: 16, apbHz: apb } }, this, () => this.ports.i2c),
      new Esp32Spi('hspi', 0x3ff64000, () => this.ports.spi),
      new Esp32Spi('vspi', 0x3ff65000, () => this.ports.spi),
      this.sens,
    ]) this.addPeripheral(p);
  }

  // ------------------------------------------------------------- clocks

  /** The CPU clock the firmware selected. */
  override get cpuMhz(): number {
    const sel = (this.rtc.readUint32(0x70) >>> 27) & 3;
    if (sel === 1) return [80, 160, 240, 240][this.dport.readUint32(0x3c) & 3];
    // XTAL, divided by APB_CTRL's pre-divider.
    const div = (this.fallback.get(0x3ff66000) ?? 0) & 0x3ff;
    return 40 / (div + 1);
  }

  apbHz(): number {
    return ((this.rtc.readUint32(0x70) >>> 27) & 3) === 1 ? 80e6 : this.cpuMhz * 1e6;
  }

  private uartClockConf(n: number): number {
    // CONF0's tick_ref_always_on (bit 27) picks APB; clear, the 1 MHz REF_TICK.
    const conf0 = this.uarts?.[n]?.peek(0x20) ?? 0;
    if ((conf0 >>> 27) & 1) return this.apbHz() >= 80e6 ? 0 : (3 << 20);
    return (3 << 20) | (39 << 12);
  }

  // ------------------------------------------------------------- loading

  override loadImage(image: EspApplicationImage): void {
    this.image = image;
    this.dram.fill(0);
    this.iram.fill(0);
    this.rtcFast.fill(0);
    this.rtcSlow.fill(0);
    this.sparse.clear();
    this.fallback.clear();
    for (const p of this.peripherals) p.reset?.();
    this.pageBase.fill(-1);
    this.mmuRaw.fill(MMU_INVALID);
    // What the bootloader does: map each flash segment's pages for both CPUs,
    // then copy the RAM segments into place.
    for (const seg of image.segments) {
      const a = seg.loadAddress >>> 0;
      if (!((a >= DROM_BASE && a < DROM_END) || (a >= IROM_BASE && a < IROM_END))) continue;
      const flashAddress = 0x10000 + seg.fileOffset;
      const firstPage = Math.floor(flashAddress / 0x10000);
      const pages = Math.ceil(((flashAddress % 0x10000) + seg.data.length) / 0x10000);
      for (let cpu = 0; cpu < 2; cpu++) this.mmuSet(cpu, a & ~0xffff, firstPage * 0x10000, pages);
    }
    for (const seg of image.segments) {
      const a = seg.loadAddress >>> 0;
      if ((a >= DROM_BASE && a < DROM_END) || (a >= IROM_BASE && a < IROM_END)) continue;
      for (let i = 0; i < seg.data.length; i++) this.write8(a + i, seg.data[i]);
    }
    this.romState.cpuTicksPerUs = 40;
    this.romState.regi2c.clear();
    this.romState.md5.clear();
    REENT_TRAMPOLINE_CODE.forEach((b, k) => this.write8(REENT_TRAMPOLINE + k, b));
    this.installGlue();
    this.installCtype();
    // g_rom_flashchip, which the ROM fills from the flash's JEDEC ID and the
    // image header: ESP-IDF's flash driver takes the chip size from it.
    const id = this.flash.id;
    [(id.manufacturer << 16) | (id.memoryType << 8) | id.capacity, this.flash.sizeBytes, 0x10000, 0x1000, 0x100, 0xffff].forEach(
      (v, k) => this.write32(0x3ffae270 + k * 4, v),
    );
    this.appBootAddress = 0;
    this.appReleased = false;
    this.resetCores();
    this.startCore(0, image.entryPoint, PRO_ROM_STACK);
    this.fault = null;
    this.interruptsDirty = true;
  }

  // ------------------------------------------------------------- flash MMU

  mmuEntry(vaddr: number): number {
    const a = vaddr >>> 0;
    if (a >= DROM_BASE && a < DROM_END) return (a & 0x3fffff) >>> 16;
    if (a >= IROM_BASE && a < IROM_END) return 64 + ((a & 0x3fffff) >>> 16);
    return -1;
  }

  mmuSet(cpu: number, vaddr: number, paddr: number, pages: number): number {
    const first = this.mmuEntry(vaddr);
    if (first < 0) return 1;
    for (let i = 0; i < pages && first + i < 256; i++) this.writeMmu(cpu, first + i, (paddr >>> 16) + i);
    return 0;
  }

  mmuInit(cpu: number): void {
    for (let i = 0; i < 256; i++) this.writeMmu(cpu, i, MMU_INVALID);
  }

  private writeMmu(cpu: number, entry: number, value: number): void {
    const k = (cpu & 1) * 256 + entry;
    this.mmuRaw[k] = value;
    this.pageBase[k] = value & MMU_INVALID ? -1 : (value & 0xff) * 0x10000;
  }

  // ------------------------------------------------------------- the bus

  /** Three instruction bytes, with the two places code runs from taken directly. */
  protected override fetch(a: number, cpu: number): number {
    a >>>= 0;
    if (a >= IROM_BASE && a < IROM_END && (a & 0xffff) <= 0xfffd) {
      const base = this.pageBase[(cpu & 1) * 256 + 64 + ((a & 0x3fffff) >>> 16)];
      if (base >= 0) {
        const o = base + (a & 0xffff);
        const f = this.flash.bytes;
        if (o + 2 < f.length) return f[o] | (f[o + 1] << 8) | (f[o + 2] << 16);
      }
    } else if (a >= IRAM_BASE && a + 2 < IRAM_END) {
      const o = a - IRAM_BASE;
      const m = this.iram;
      return m[o] | (m[o + 1] << 8) | (m[o + 2] << 16);
    }
    return this.read8(a, cpu) | (this.read8(a + 1, cpu) << 8) | (this.read8(a + 2, cpu) << 16);
  }

  private flashByte(a: number, cpu: number, entry: number): number {
    const base = this.pageBase[(cpu & 1) * 256 + entry];
    if (base < 0) return 0;
    return this.flash.bytes[(base + (a & 0xffff)) % this.flash.bytes.length];
  }

  override read8(a: number, cpu = this.current): number {
    a >>>= 0;
    if (a >= IROM_BASE && a < IROM_END) return this.flashByte(a, cpu, 64 + ((a & 0x3fffff) >>> 16));
    if (a >= IRAM_BASE && a < IRAM_END) return this.iram[a - IRAM_BASE];
    if (a >= DRAM_BASE && a < DRAM_END) return this.dram[a - DRAM_BASE];
    if (a >= DROM_BASE && a < DROM_END) return this.flashByte(a, cpu, (a & 0x3fffff) >>> 16);
    if (this.isMmio(a)) return (this.mmioRead(a & ~3) >>> ((a & 3) * 8)) & 0xff;
    if (a >= RTC_FAST_D && a < RTC_FAST_D + RTC_SIZE) return this.rtcFast[a - RTC_FAST_D];
    if (a >= RTC_FAST_I && a < RTC_FAST_I + RTC_SIZE) return this.rtcFast[a - RTC_FAST_I];
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
    if (this.isMmio(a)) return this.mmioRead(a);
    return (this.read8(a, cpu) | (this.read8(a + 1, cpu) << 8) | (this.read8(a + 2, cpu) << 16) | (this.read8(a + 3, cpu) << 24)) >>> 0;
  }

  override write16(a: number, v: number): void {
    if (this.isMmio(a)) this.mmioWrite(a, v, 2);
    else {
      this.write8(a, v);
      this.write8(a + 1, v >> 8);
    }
  }

  override write8(a: number, v: number): void {
    a >>>= 0;
    v &= 0xff;
    if (a >= DRAM_BASE && a < DRAM_END) this.dram[a - DRAM_BASE] = v;
    else if (a >= IRAM_BASE && a < IRAM_END) this.iram[a - IRAM_BASE] = v;
    else if (this.isMmio(a)) this.mmioWrite(a, v, 1);
    else if (a >= RTC_FAST_D && a < RTC_FAST_D + RTC_SIZE) this.rtcFast[a - RTC_FAST_D] = v;
    else if (a >= RTC_FAST_I && a < RTC_FAST_I + RTC_SIZE) this.rtcFast[a - RTC_FAST_I] = v;
    else if (a >= RTC_SLOW && a < RTC_SLOW + RTC_SIZE) this.rtcSlow[a - RTC_SLOW] = v;
    else if ((a >= DROM_BASE && a < DROM_END) || (a >= IROM_BASE && a < IROM_END) || a < 0x3f000000) return;
    else {
      let page = this.sparse.get(a >>> 16);
      if (!page) this.sparse.set(a >>> 16, (page = new Uint8Array(0x10000)));
      page[a & 0xffff] = v;
    }
  }

  override write32(a: number, v: number): void {
    a >>>= 0;
    if (this.isMmio(a)) {
      this.mmioWrite(a, v, 4);
      return;
    }
    if (a >= DRAM_BASE && a + 3 < DRAM_END) {
      const o = a - DRAM_BASE;
      const m = this.dram;
      m[o] = v;
      m[o + 1] = v >>> 8;
      m[o + 2] = v >>> 16;
      m[o + 3] = v >>> 24;
      return;
    }
    this.write8(a, v);
    this.write8(a + 1, v >>> 8);
    this.write8(a + 2, v >>> 16);
    this.write8(a + 3, v >>> 24);
  }

  private isMmio(a: number): boolean {
    return (a >= MMIO_BASE && a < MMIO_END) || (a >= AHB_ALIAS && a < AHB_ALIAS + 0x40000);
  }

  private normalise(a: number): number {
    return a >= AHB_ALIAS ? a - AHB_ALIAS + 0x3ff40000 : a;
  }

  private peripheralAt(a: number): Peripheral | undefined {
    for (const p of this.peripherals) if (a >= p.base && a < p.base + p.size) return p;
    return undefined;
  }

  private mmioRead(addr: number): number {
    const a = this.normalise(addr >>> 0) & ~3;
    if (a >= 0x3ff10000 && a < 0x3ff14000) {
      const k = (a - 0x3ff10000) >> 2;
      return k < 256 ? this.mmuRaw[k] : k >= 0x800 && k < 0x900 ? this.mmuRaw[256 + k - 0x800] : 0;
    }
    if (a >= 0x3ff00000 && a < 0x3ff01000) return this.dportRead(a - 0x3ff00000);
    const p = this.peripheralAt(a);
    if (p) return p.readUint32(a - p.base) >>> 0;
    this.options.onUnclaimedMmio?.(a, false, 0);
    return this.fallback.get(a) ?? 0;
  }

  private mmioWrite(addr: number, v: number, size: 1 | 2 | 4): void {
    const a = this.normalise(addr >>> 0) & ~3;
    if (size !== 4) {
      const shift = (addr & 3) * 8;
      const mask = (size === 1 ? 0xff : 0xffff) << shift;
      v = ((this.mmioRead(a) & ~mask) | ((v << shift) & mask)) >>> 0;
    }
    v >>>= 0;
    this.interruptsDirty = true;
    if (a >= 0x3ff10000 && a < 0x3ff14000) {
      const k = (a - 0x3ff10000) >> 2;
      if (k < 256) this.writeMmu(0, k, v);
      else if (k >= 0x800 && k < 0x900) this.writeMmu(1, k - 0x800, v);
      return;
    }
    if (a >= 0x3ff00000 && a < 0x3ff01000) {
      this.dportWrite(a - 0x3ff00000, v);
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

  // ------------------------------------------------------------- DPORT

  private dportRead(off: number): number {
    if (off >= 0x104 && off < 0x104 + 4 * ESP32_SOURCE.count) return this.slots[0].map[(off - 0x104) >> 2];
    if (off >= 0x218 && off < 0x218 + 4 * ESP32_SOURCE.count) return this.slots[1].map[(off - 0x218) >> 2];
    if (off >= 0xec && off < 0xf8) return this.sourceStatus((off - 0xec) >> 2);
    if (off >= 0xf8 && off < 0x104) return this.sourceStatus((off - 0xf8) >> 2);
    // PRO/APP_DCACHE_DBUG0: the cache state machine is idle (1) whenever asked.
    if (off === 0x3f0 || off === 0x418) return (this.dport.readUint32(off) & ~(0xfff << 7)) | (1 << 7);
    return this.dport.readUint32(off);
  }

  private dportWrite(off: number, v: number): void {
    if (off >= 0x104 && off < 0x104 + 4 * ESP32_SOURCE.count) {
      this.slots[0].map[(off - 0x104) >> 2] = v & 0x1f;
      return;
    }
    if (off >= 0x218 && off < 0x218 + 4 * ESP32_SOURCE.count) {
      this.slots[1].map[(off - 0x218) >> 2] = v & 0x1f;
      return;
    }
    const before = this.dport.readUint32(off);
    this.dport.writeUint32(off, v);
    // APPCPU_CTRL_A: RESETTING going low releases the APP CPU into the ROM.
    if (off === 0x2c && before & 1 && !(v & 1)) {
      this.appReleased = true;
      this.maybeStartApp();
    }
  }

  private sourceStatus(word: number): number {
    let v = 0;
    for (const s of this.asserted) if (s >> 5 === word) v |= 1 << (s & 31);
    return v >>> 0;
  }

  setAppCpuBootAddress(address: number): void {
    this.appBootAddress = address >>> 0;
    this.maybeStartApp();
  }

  private maybeStartApp(): void {
    if (this.slots[1].running || !this.appBootAddress) return;
    const clockOn = this.dport.readUint32(0x30) & 1;
    const stalled = this.dport.readUint32(0x34) & 1;
    if (!this.appReleased || !clockOn || stalled) return;
    this.startCore(1, this.appBootAddress, APP_ROM_STACK);
  }

  protected override softwareSources(): number[] {
    // DPORT_CPU_INTR_FROM_CPU_0..3: the cross-core (and self) software interrupts.
    const out: number[] = [];
    for (let n = 0; n < 4; n++) if (this.dport.readUint32(0xdc + n * 4) & 1) out.push(ESP32_SOURCE.fromCpu0 + n);
    return out;
  }

  // ------------------------------------------------------------- ROM

  protected override romHost(i: number): Esp32RomHost {
    const slot = this.slots[i];
    const cpu = slot.cpu;
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const machine = this;
    return {
      cpu: i,
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
      mmuSet: (c, v, p, n) => machine.mmuSet(c, v, p, n),
      mmuInit: (c) => machine.mmuInit(c),
      gpioMatrixIn: (gpio, signal, inv) => {
        if (signal < 256) machine.gpio.writeUint32(0x130 + signal * 4, (gpio & 0x3f) | (inv ? 1 << 6 : 0) | (1 << 7));
      },
      gpioMatrixOut: (gpio, signal, inv, oenInv) => {
        if (gpio < 40) machine.gpio.writeUint32(0x530 + gpio * 4, (signal & 0x1ff) | (inv ? 1 << 9 : 0) | (oenInv ? 1 << 11 : 0));
      },
      padSelectGpio: (gpio) => machine.setMux(gpio, (v) => (v & ~(7 << 12)) | (2 << 12)),
      padPull: (gpio, up, down) => machine.setMux(gpio, (v) => (v & ~(3 << 7)) | (up ? 1 << 8 : 0) | (down ? 1 << 7 : 0)),
      padDrive: (gpio, strength) => machine.setMux(gpio, (v) => (v & ~(3 << 10)) | ((strength & 3) << 10)),
      softwareReset: () => machine.softwareReset(),
      core: cpu,
      syscallTablePointer: ESP32_SYSCALL_TABLE_PTR[i & 1],
      reentTrampoline: REENT_TRAMPOLINE,
      get ps() {
        return cpu.ps;
      },
      set ps(v: number) {
        cpu.ps = v >>> 0;
      },
    };
  }

  private setMux(gpio: number, f: (v: number) => number): void {
    const off = IO_MUX_OFFSET[gpio];
    if (off === undefined || off < 0) return;
    this.gpio.ioMux.writeUint32(off, f(this.gpio.ioMux.readUint32(off)) >>> 0);
  }
}
