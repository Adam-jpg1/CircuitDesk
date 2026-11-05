// The ESP8266: one Xtensa LX106 core (CALL0 ABI, no register windows, no
// FPU), 80 KB of data RAM, 32 KB of instruction RAM plus the cache window
// onto flash, and the peripherals an Arduino sketch reaches.
//
// Memory map (the SDK's eagle.app.v6.ld and esp8266_peri.h):
//
//   0x3FFE8000-0x40000000  DRAM; the top 16 KB is the ROM's own data, whose
//                          exception and interrupt tables firmware links to
//   0x40000000-0x40010000  mask ROM, provided natively (./rom)
//   0x40100000-0x40110000  IRAM
//   0x40200000-0x40300000  the flash cache window, 1 MB of flash chosen by
//                          Cache_Read_Enable
//   0x60000000-0x60001000  UART0, SPI, GPIO, FRC timers, RTC, IO MUX, UART1
//   0x60001000-0x60001400  RTC memory
//   0x3FF00000             DPORT; 0x3FF20000 the Wi-Fi block, whose
//                          microsecond counter is system_get_time()
//
// The Arduino core runs on Espressif's NONOS SDK: the SDK's start-up
// initialises the radio, then hands over to the ROM scheduler, which the
// core's loop runs inside as a task. The radio's registers are kept as plain
// storage; nothing on the air is modelled.
//
// The interrupt controller is the core itself: each peripheral drives its
// CPU interrupt number directly (UART 5, GPIO 4, FRC1 9, FRC2 10).

import { EspXtensaMachine, type CoreSlot } from '../xtensa/espXtensaMachine';
import type { XtensaConfig } from '../xtensa/xtensa';
import type { Peripheral, SimulatedClock } from '../espRiscv/peripheral';
import { EspUart, type UartLayout } from '../espRiscv/uart';
import type { SerialNorFlash } from '../esp32c3/spiFlash';
import type { EspApplicationImage } from '../esp32c3/espImage';
import type { Esp32RomEntry, Esp32RomHost } from '../esp32/rom';
import { Esp8266Gpio } from './gpio';
import { Esp8266Timers, FRC1_INUM, FRC2_INUM } from './timers';
import { Esp8266FlashSpi, Esp8266Hspi } from './spi';
import { Esp8266Sar } from './sar';
import {
  ESP8266_ROM_ADDRESSES, ETS_RUN_LOOP_AT, GLUE_AT, HOOK_NEXT_INTERRUPT, HOOK_NEXT_TASK, HOOK_UNHANDLED, L1INT_AT,
  PHY_STUBS_AT, PHY_TABLE_AT, PHY_TABLE_ENTRIES, ROM_DATA, ROM_GLUE, sharedHandler, type Esp8266Handler,
} from './rom';

const DRAM_BASE = 0x3ffe8000;
const DRAM_END = 0x40000000;
const IRAM_BASE = 0x40100000;
const IRAM_END = 0x40110000;
const ROM_BASE = 0x40000000;
const ROM_END = 0x40010000;
const CACHE_BASE = 0x40200000;
const CACHE_END = 0x40300000;
const MMIO_BASE = 0x60000000;
const MMIO_END = 0x60001000;
const RTC_MEM = 0x60001000;
const RTC_MEM_END = 0x60001400;
/** Where the stack starts when the ROM jumps to firmware. */
const BOOT_SP = 0x3ffffff0;
/** The RF PLL's analog block and the register whose bit 7 reports its calibration done. */
const RFPLL_BLOCK = 98;
const RFPLL_CAL_REG = 7;

export const ESP8266_UART_LAYOUT: UartLayout = {
  countBits: 8,
  conf0RxfifoRst: 17,
  conf0TxfifoRst: 18,
  conf1FieldBits: 8,
  toutEnable: { offset: 0x24, bit: 31 },
  selfClearing: [],
  fsmStatus: -1,
  clkdivIntegerBits: 20,
};

/** The LX106 as the ESP8266 configures it (core-isa.h of its overlay). */
export function lx106Config(): XtensaConfig {
  const intLevel = new Array(32).fill(1);
  intLevel[14] = 3; // NMI
  return {
    windowed: false,
    fpu: false,
    nareg: 16,
    excmLevel: 1,
    intLevel,
    timerInt: [6, -1, -1],
    vectors: { level: { 2: 0x10, 3: 0x20 }, kernel: 0x30, user: 0x50, double: 0x70 },
    prid: 0,
    vecbase: ROM_BASE,
    nmi: { int: 14, level: 3 },
  };
}

class Store implements Peripheral {
  readonly regs = new Map<number, number>();
  constructor(
    readonly name: string,
    readonly base: number,
    readonly size: number,
    private readonly initial: [number, number][] = [],
  ) {
    this.reset();
  }
  readUint32(offset: number): number {
    return (this.regs.get(offset) ?? 0) >>> 0;
  }
  writeUint32(offset: number, value: number): void {
    this.regs.set(offset, value >>> 0);
  }
  reset(): void {
    this.regs.clear();
    for (const [o, v] of this.initial) this.regs.set(o, v >>> 0);
  }
}

/** The RTC block: GPIO16's registers, the rest plain storage. */
class Esp8266Rtc extends Store {
  constructor(private readonly gpio: Esp8266Gpio) {
    super('rtc', 0x60000700, 0x100);
  }
  override readUint32(offset: number): number {
    switch (offset) {
      case 0x68: return this.gpio.gp16.out;
      case 0x74: return this.gpio.gp16.enable;
      case 0x8c: return this.gpio.gp16Input();
      case 0x90: return this.gpio.gp16.conf;
      case 0xa0: return this.gpio.gp16.fn;
      // The wake-up state the SDK's power manager waits on after a sleep
      // request: woken (bit 0), at once, since the chip never sleeps here.
      case 0x28: return super.readUint32(offset) | 1;
    }
    return super.readUint32(offset);
  }
  override writeUint32(offset: number, value: number): void {
    switch (offset) {
      case 0x68: this.gpio.writeGp16('out', value); return;
      case 0x74: this.gpio.writeGp16('enable', value); return;
      case 0x90: this.gpio.writeGp16('conf', value); return;
      case 0xa0: this.gpio.writeGp16('fn', value); return;
    }
    super.writeUint32(offset, value);
  }
}

/** The Wi-Fi block: storage, with its free-running microsecond counter and random number register. */
class Esp8266Wdev extends Store {
  private seed = 0x2545f491;
  constructor(private readonly clock: SimulatedClock) {
    super('wdev', 0x3ff20000, 0x10000);
  }
  override readUint32(offset: number): number {
    if (offset === 0x0c00) return Math.floor(this.clock.nanos / 1000) % 2 ** 32;
    if (offset === 0x0e44) {
      // xorshift32: the hardware's is true noise; a sketch only needs it to vary.
      let x = this.seed;
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      this.seed = x >>> 0;
      return this.seed;
    }
    return super.readUint32(offset);
  }
}

interface Task {
  fn: number;
  queue: number;
  length: number;
  events: [number, number][];
}

export interface Esp8266Options {
  onUnclaimedMmio?: (address: number, write: boolean, value: number) => void;
}

export class Esp8266Machine extends EspXtensaMachine {
  readonly dram = new Uint8Array(DRAM_END - DRAM_BASE);
  readonly iram = new Uint8Array(IRAM_END - IRAM_BASE);
  readonly romBytes = new Uint8Array(ROM_END - ROM_BASE);
  readonly rtcMem = new Uint8Array(RTC_MEM_END - RTC_MEM);
  readonly gpio: Esp8266Gpio;
  readonly uarts: EspUart[];
  readonly timers: Esp8266Timers;
  readonly sar = new Esp8266Sar();
  private readonly dport = new Store('dport', 0x3ff00000, 0x100, [
    // eFuse: the SDK refuses to start unless word 2's bit 15 marks an ESP8266;
    // with bit 12 clear the MAC is Espressif's 18:FE:34 OUI and the bytes
    // word 1 [15:0] and word 0 [31:24] give, here 18:FE:34:7C:12:5A.
    [0x50, 0x5a000000], [0x54, 0x00007c12], [0x58, 1 << 15], [0x5c, 0],
  ]);
  private readonly fallback = new Map<number, number>();
  private readonly sparse = new Map<number, Uint8Array>();
  /** Flash offset the cache window maps, or -1 while it is disabled. */
  private cacheOffset = 0;
  /** The ROM's interrupt table: handler and argument for each CPU interrupt. */
  private readonly isr = new Map<number, { fn: number; arg: number }>();
  private readonly tasks = new Map<number, Task>();
  private idleCb = { fn: 0, arg: 0 };
  private idleRan = false;
  /** Called with each routine the native ROM provides, for diagnosis. */
  onRomCall: ((name: string, pc: number) => void) | null = null;
  protected override readonly romName = 'ESP8266';
  /** The guest-call glue, in ROM space below ROM_GLUE. */
  protected override readonly glueBase = 0x4000ec00;
  /** The flash image is the whole build, so code in the cache window is patched at its own offset. */
  protected override readonly appFlashOffset = 0;
  /** The Wi-Fi model's work for the scheduler, when a build uses Wi-Fi (see nextTask). */
  wifiWork: { nextDue(): number | undefined } | null = null;
  /** The eFuse's MAC bytes 3..5 (the first three are Espressif's 18:FE:34). */
  private factoryMac: readonly number[] = [0x18, 0xfe, 0x34, 0x7c, 0x12, 0x5a];

  constructor(
    flash: SerialNorFlash,
    private readonly options: Esp8266Options = {},
  ) {
    super(flash, [lx106Config(), lx106Config()], 32, { start: ROM_BASE, end: ROM_END }, new Map());
    this.romCode.push({ start: GLUE_AT, end: GLUE_AT + ROM_GLUE.length });
    this.buildRomTable();
    this.gpio = new Esp8266Gpio(this);
    this.gpio.onInterruptChange = () => (this.interruptsDirty = true);
    this.timers = new Esp8266Timers(this);
    // DPORT's NMI source select (NmiTimSetFunc writes 15 to its low bits) puts FRC1 on the NMI.
    this.timers.nmiRouted = () => (this.dport.readUint32(0) & 0x1f) === 15;
    this.timers.onNmiEdge = () => {
      this.slots[0].cpu.latched |= 1 << 14;
    };
    this.uarts = [
      new EspUart('uart0', 0x60000000, this, 5, ESP8266_UART_LAYOUT),
      new EspUart('uart1', 0x60000f00, this, 5, ESP8266_UART_LAYOUT),
    ];
    for (const p of [
      ...this.uarts, this.gpio, this.gpio.ioMux, this.timers, new Esp8266Rtc(this.gpio),
      new Esp8266Hspi(() => this.ports.spi), new Esp8266FlashSpi(flash),
      new Store('wdt', 0x60000900, 0x100), new Store('slc', 0x60000b00, 0x100), new Store('i2s', 0x60000e00, 0x100),
      this.sar, this.dport, new Esp8266Wdev(this),
    ]) this.addPeripheral(p);
    // The Wi-Fi model's work wakes the scheduler's wait as an interrupt would.
    this.addEventSource({ nextEventNanos: () => this.wifiWork?.nextDue() });
  }

  /** The station MAC the SDK reads from the eFuse at start-up: bytes 3..5 are the chip's own. */
  setFactoryMac(mac: readonly number[]): void {
    this.factoryMac = mac;
    this.writeFactoryMac();
  }

  private writeFactoryMac(): void {
    const m = this.factoryMac;
    this.dport.writeUint32(0x50, (m[5] << 24) >>> 0);
    this.dport.writeUint32(0x54, (m[3] << 8) | m[4]);
  }

  protected override writeRomByte(a: number, v: number): void {
    this.romBytes[a - ROM_BASE] = v & 0xff;
  }

  protected override idle(slot: CoreSlot): boolean {
    if (!super.idle(slot)) return false;
    const due = this.wifiWork?.nextDue();
    if (due === undefined || due > slot.ns) return true;
    // ets_run's wait ends, and its next step finds the work (nextTask).
    slot.cpu.waiting = false;
    return false;
  }

  // ------------------------------------------------------------- clocks

  override get cpuMhz(): number {
    // DPORT 0x14 bit 0: the CPU's divide-by-two bypass, set for 160 MHz.
    return this.dport.readUint32(0x14) & 1 ? 160 : 80;
  }

  // ------------------------------------------------------------- loading

  override loadImage(image: EspApplicationImage): void {
    this.image = image;
    this.dram.fill(0);
    this.iram.fill(0);
    this.rtcMem.fill(0);
    this.romBytes.fill(0);
    this.sparse.clear();
    this.fallback.clear();
    for (const p of this.peripherals) p.reset?.();
    this.writeFactoryMac();
    this.isr.clear();
    this.tasks.clear();
    this.idleCb = { fn: 0, arg: 0 };
    this.idleRan = false;
    this.cacheOffset = 0;
    for (const seg of image.segments) {
      const a = seg.loadAddress >>> 0;
      if (a >= CACHE_BASE && a < CACHE_END) continue;
      for (let i = 0; i < seg.data.length; i++) this.write8(a + i, seg.data[i]);
    }
    this.romBytes.set(ROM_GLUE, GLUE_AT - ROM_BASE);
    this.installGlue();
    this.installRomData();
    this.romState.cpuTicksPerUs = 80;
    this.romState.md5.clear();
    this.resetCores();
    const cpu = this.slots[0].cpu;
    this.startCore(0, image.entryPoint, BOOT_SP);
    // CALL0, level 0, user vector mode: as the ROM leaves it.
    cpu.ps = 0x20;
    this.slots[0].map.forEach((_, s, m) => (m[s] = s));
    this.fault = null;
    this.interruptsDirty = true;
  }

  private installRomData(): void {
    // Every exception goes to the dispatcher (level 1 interrupt) or the unhandled hook.
    for (let n = 0; n < 64; n++) this.write32(ROM_DATA.excHandlerTable + n * 4, n === 4 ? L1INT_AT : HOOK_UNHANDLED);
    // flashchip is a pointer to the ROM's flash descriptor, which follows it.
    const f = ROM_DATA.flashchip + 4;
    this.write32(ROM_DATA.flashchip, f);
    const id = this.flash.id;
    [(id.capacity << 16) | (id.memoryType << 8) | id.manufacturer, this.flash.sizeBytes, 0x10000, 0x1000, 0x100, 0xffff].forEach(
      (v, k) => this.write32(f + k * 4, v),
    );
    for (let i = 0; i < PHY_TABLE_ENTRIES; i++) this.write32(PHY_TABLE_AT + i * 4, PHY_STUBS_AT + i * 4);
    for (const [at, digits] of [[ROM_DATA.digitsUpper, '0123456789ABCDEF'], [ROM_DATA.digitsLower, '0123456789abcdef']] as const) {
      [...digits, '\0'].forEach((c, k) => this.write8(at + k, c.charCodeAt(0)));
    }
  }

  // ------------------------------------------------------------- ROM

  private buildRomTable(): void {
    const own = this.ownRoutines();
    for (const [name, address] of Object.entries(ESP8266_ROM_ADDRESSES)) {
      const handler = own[name] ?? sharedHandler(name);
      if (handler) this.romTable.set(address, { name, handler } as Esp32RomEntry);
    }
    this.romTable.set(HOOK_NEXT_INTERRUPT, { name: 'next_interrupt', handler: (h) => this.nextInterrupt(h) });
    this.romTable.set(HOOK_NEXT_TASK, { name: 'next_task', handler: (h) => this.nextTask(h) });
    this.romTable.set(HOOK_UNHANDLED, {
      name: 'unhandled_exception',
      handler: (h) => {
        const c = h.core;
        this.fault = `The sketch raised exception ${c.rsr(232)} at 0x${c.rsr(177).toString(16)} (address 0x${c.rsr(238).toString(16)}).`;
        return { jump: HOOK_UNHANDLED };
      },
    });
    // The radio's ROM routines are inert here, except the analog-register
    // accessors the SDK's calibration reads back (table entries 36..39, in
    // the ROM's alphabetical order: i2c_readReg, readReg_Mask, writeReg,
    // writeReg_Mask), kept as storage. The RF PLL reports calibrated at once.
    const regi2c: Record<number, string> = { 36: 'rom_i2c_readReg', 37: 'rom_i2c_readReg_Mask', 38: 'rom_i2c_writeReg', 39: 'rom_i2c_writeReg_Mask' };
    for (let i = 0; i < PHY_TABLE_ENTRIES; i++) {
      const shared = regi2c[i] ? sharedHandler(regi2c[i]) : undefined;
      const handler: Esp8266Handler = shared
        ? i === 37
          ? (h) => (h.arg(0) === RFPLL_BLOCK && h.arg(2) === RFPLL_CAL_REG ? 1 : shared(h))
          : shared
        : () => 0;
      this.romTable.set(PHY_STUBS_AT + i * 4, { name: regi2c[i] ?? `phy_rom_${i}`, handler });
    }
  }

  private ownRoutines(): Record<string, Esp8266Handler> {
    const m = this;
    return {
      _xtos_set_exception_handler: (h) => {
        const n = h.arg(0) & 63;
        const prev = h.read32(ROM_DATA.cHandlerTable + n * 4);
        h.write32(ROM_DATA.cHandlerTable + n * 4, h.arg(1));
        return prev;
      },
      ets_isr_attach: (h) => {
        m.isr.set(h.arg(0) & 31, { fn: h.arg(1), arg: h.arg(2) });
      },
      ets_set_idle_cb: (h) => {
        m.idleCb = { fn: h.arg(0), arg: h.arg(1) };
      },
      ets_task: (h) => {
        m.tasks.set(h.arg(1) & 31, { fn: h.arg(0), queue: h.arg(2), length: h.arg(3), events: [] });
        return 0;
      },
      ets_post_rom: (h) => {
        const task = m.tasks.get(h.arg(0) & 31);
        if (!task || task.events.length >= Math.max(1, task.length)) return 1;
        task.events.push([h.arg(1), h.arg(2)]);
        // Posted from an interrupt, the event is found as soon as that
        // interrupt returns: taking it is what ended ets_run's wait.
        return 0;
      },
      ets_run: () => ({ jump: ETS_RUN_LOOP_AT }),
      boot_from_flash: () => 0,
      ets_install_putc1: () => {},
      ets_write_char: (h) => { h.console(h.arg(0) & 0xff); },
      ets_uart_putc1: (h) => { h.console(h.arg(0) & 0xff); },
      ets_putc: (h) => { h.console(h.arg(0) & 0xff); },
      // The SDK's own messages; the Arduino core routes them nowhere unless debug output is on.
      ets_vprintf: () => 0,
      ets_update_cpu_frequency: (h) => { h.state.cpuTicksPerUs = h.arg(0); },
      UartDwnLdProc: () => 0,
      uartAttach: () => {},
      uart_buff_switch: () => {},
      uart_baudrate_detect: () => 115200,
      Uart_Init: () => {},
      rom_uart_div_modify: (h) => {
        const u = m.uarts[h.arg(0) & 1];
        u.writeUint32(0x14, h.arg(1) & 0xfffff);
      },
      SPI_read_status: (h) => {
        if (h.arg(1)) h.write32(h.arg(1), 0);
        return 0;
      },
      SPI_write_status: () => 0,
      SPI_write_enable: () => 0,
      Wait_SPI_Idle: () => 0,
      Enable_QMode: () => 0,
      Cache_Read_Enable: (h) => {
        // (odd_even, mb_count, no_idea): which megabyte of flash the window shows.
        const oddEven = h.arg(0) & 1;
        const mb = h.arg(1) & 3;
        m.cacheOffset = mb * 0x200000 + oddEven * 0x100000;
      },
      Cache_Read_Disable: () => {
        m.cacheOffset = -1;
      },
      SPIRead: (h) => {
        const [addr, dst, size] = [h.arg(0), h.arg(1), h.arg(2)];
        const f = m.flash.bytes;
        if (addr + size > f.length) return 1;
        for (let i = 0; i < size; i++) h.write8(dst + i, f[addr + i]);
        return 0;
      },
      SPIWrite: (h) => {
        const [addr, src, size] = [h.arg(0), h.arg(1), h.arg(2)];
        const f = m.flash.bytes;
        if (addr + size > f.length) return 1;
        // NOR programming only clears bits.
        for (let i = 0; i < size; i++) f[addr + i] &= h.read8(src + i);
        return 0;
      },
      SPIEraseSector: (h) => {
        const at = (h.arg(0) & 0xfff) * 0x1000;
        if (at + 0x1000 > m.flash.bytes.length) return 1;
        m.flash.bytes.fill(0xff, at, at + 0x1000);
        return 0;
      },
      gpio_output_set: (h) => {
        const [set, clear, en, dis] = [h.arg(0), h.arg(1), h.arg(2), h.arg(3)];
        if (set) m.gpio.writeUint32(0x04, set);
        if (clear) m.gpio.writeUint32(0x08, clear);
        if (en) m.gpio.writeUint32(0x10, en);
        if (dis) m.gpio.writeUint32(0x14, dis);
      },
      gpio_input_get: () => m.gpio.inputWord(),
      gpio_pin_wakeup_enable: () => {},
      gpio_pin_wakeup_disable: () => {},
      lldesc_build_chain: () => 0,
      lldesc_num2link: () => 0,
      rom_chip_v5_disable_cca: () => {},
      rom_chip_v5_enable_cca: () => {},
      phy_get_romfuncs: () => PHY_TABLE_AT,
    };
  }

  /** The dispatcher's next interrupt: a2 its argument, a3 the frame, a4 the handler (0: done). */
  private nextInterrupt(h: Esp32RomHost): number {
    const cpu = h.core;
    if (this.interruptsDirty) this.refreshInterrupts();
    const pending = (cpu.interrupt & cpu.intenable) >>> 0;
    for (let n = 0; n < 15; n++) {
      if (!((pending >>> n) & 1)) continue;
      // Edge and software interrupts are taken here; level ones clear at their source.
      if (n === FRC1_INUM || n === FRC2_INUM) {
        this.timers.acknowledge(n);
        this.interruptsDirty = true;
      }
      if (n === 6 || n === 7) cpu.latched &= ~(1 << n);
      const entry = this.isr.get(n);
      if (!entry) {
        // Nothing attached: mask it, as the ROM's default handler leaves it.
        cpu.intenable &= ~(1 << n);
        continue;
      }
      cpu.setA(4, entry.fn);
      cpu.setA(3, cpu.a(1));
      return entry.arg;
    }
    cpu.setA(4, 0);
    return 0;
  }

  /** ets_run's next step: a2 the argument, a4 the function to call, or 0 to wait for an interrupt. */
  private nextTask(h: Esp32RomHost): number {
    const cpu = h.core;
    // The Wi-Fi model's work first, as the SDK's own radio task outranks the core's loop.
    const due = this.wifiWork?.nextDue();
    if (due !== undefined && due <= this.nanos && this.glueRoundEntry !== undefined) {
      cpu.setA(4, this.glueRoundEntry);
      return 0;
    }
    for (let prio = 31; prio >= 0; prio--) {
      const task = this.tasks.get(prio);
      if (!task || task.events.length === 0) continue;
      const [sig, par] = task.events.shift()!;
      this.write32(task.queue, sig);
      this.write32(task.queue + 4, par);
      this.idleRan = false;
      cpu.setA(4, task.fn);
      return task.queue;
    }
    if (this.idleCb.fn && !this.idleRan) {
      this.idleRan = true;
      cpu.setA(4, this.idleCb.fn);
      return this.idleCb.arg;
    }
    this.idleRan = false;
    cpu.setA(4, 0);
    return 0;
  }

  protected override romCall(i: number, pc: number): boolean {
    const entry = this.romTable.get(pc);
    if (entry && this.onRomCall) this.onRomCall(entry.name, pc);
    return super.romCall(i, pc);
  }

  protected override softwareSources(): number[] {
    return [];
  }

  protected override romHost(i: number): Esp32RomHost {
    const slot = this.slots[i];
    const cpu = slot.cpu;
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const machine = this;
    return {
      cpu: 0,
      core: cpu,
      arg: (k) => cpu.romArg(k),
      sp: () => cpu.romSp(),
      read8: (a) => machine.read8(a),
      read32: (a) => machine.read32(a),
      write8: (a, v) => machine.write8(a, v),
      write32: (a, v) => machine.write32(a, v),
      console: (b) => machine.onConsoleByte?.(b),
      consoleRead: () => undefined,
      delayUs: (us) => {
        slot.stalledUntil = slot.ns + (us >>> 0) * 1000;
      },
      state: machine.romState,
      setInterruptMap: () => {},
      setAppCpuBootAddress: () => {},
      mmuSet: () => 0,
      mmuInit: () => {},
      gpioMatrixIn: () => {},
      gpioMatrixOut: () => {},
      padSelectGpio: () => {},
      padPull: () => {},
      padDrive: () => {},
      softwareReset: () => machine.softwareReset(),
      syscallTablePointer: 0,
      reentTrampoline: 0,
      get ps() {
        return cpu.ps;
      },
      set ps(v: number) {
        cpu.ps = v >>> 0;
      },
    };
  }

  // ------------------------------------------------------------- the bus

  private cacheByte(a: number): number {
    if (this.cacheOffset < 0) return 0;
    const o = this.cacheOffset + (a - CACHE_BASE);
    return o < this.flash.bytes.length ? this.flash.bytes[o] : 0;
  }

  protected override fetch(a: number): number {
    a >>>= 0;
    if (a >= CACHE_BASE && a < CACHE_END && this.cacheOffset >= 0) {
      const o = this.cacheOffset + (a - CACHE_BASE);
      const f = this.flash.bytes;
      if (o + 2 < f.length) return f[o] | (f[o + 1] << 8) | (f[o + 2] << 16);
    } else if (a >= IRAM_BASE && a + 2 < IRAM_END) {
      const o = a - IRAM_BASE;
      const m = this.iram;
      return m[o] | (m[o + 1] << 8) | (m[o + 2] << 16);
    }
    return this.read8(a) | (this.read8(a + 1) << 8) | (this.read8(a + 2) << 16);
  }

  override read8(a: number): number {
    a >>>= 0;
    if (a >= DRAM_BASE && a < DRAM_END) return this.dram[a - DRAM_BASE];
    if (a >= IRAM_BASE && a < IRAM_END) return this.iram[a - IRAM_BASE];
    if (a >= CACHE_BASE && a < CACHE_END) return this.cacheByte(a);
    if (a >= ROM_BASE && a < ROM_END) return this.romBytes[a - ROM_BASE];
    if (a >= MMIO_BASE && a < MMIO_END) return (this.mmioRead(a & ~3) >>> ((a & 3) * 8)) & 0xff;
    if (a >= RTC_MEM && a < RTC_MEM_END) return this.rtcMem[a - RTC_MEM];
    if (a >= 0x3ff00000 && a < 0x3ff30000) return (this.mmioRead(a & ~3) >>> ((a & 3) * 8)) & 0xff;
    return this.sparse.get(a >>> 16)?.[a & 0xffff] ?? 0;
  }

  override read32(a: number): number {
    a >>>= 0;
    if (a >= DRAM_BASE && a + 3 < DRAM_END) {
      const o = a - DRAM_BASE;
      const m = this.dram;
      return (m[o] | (m[o + 1] << 8) | (m[o + 2] << 16) | (m[o + 3] << 24)) >>> 0;
    }
    if ((a >= MMIO_BASE && a < MMIO_END) || (a >= 0x3ff00000 && a < 0x3ff30000)) return this.mmioRead(a);
    return (this.read8(a) | (this.read8(a + 1) << 8) | (this.read8(a + 2) << 16) | (this.read8(a + 3) << 24)) >>> 0;
  }

  override write8(a: number, v: number): void {
    a >>>= 0;
    v &= 0xff;
    if (a >= DRAM_BASE && a < DRAM_END) this.dram[a - DRAM_BASE] = v;
    else if (a >= IRAM_BASE && a < IRAM_END) this.iram[a - IRAM_BASE] = v;
    else if ((a >= MMIO_BASE && a < MMIO_END) || (a >= 0x3ff00000 && a < 0x3ff30000)) this.mmioWrite(a, v, 1);
    else if (a >= RTC_MEM && a < RTC_MEM_END) this.rtcMem[a - RTC_MEM] = v;
    else if ((a >= CACHE_BASE && a < CACHE_END) || (a >= ROM_BASE && a < ROM_END)) return;
    else {
      let page = this.sparse.get(a >>> 16);
      if (!page) this.sparse.set(a >>> 16, (page = new Uint8Array(0x10000)));
      page[a & 0xffff] = v;
    }
  }

  override write16(a: number, v: number): void {
    if ((a >= MMIO_BASE && a < MMIO_END) || (a >= 0x3ff00000 && a < 0x3ff30000)) this.mmioWrite(a, v, 2);
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
    if ((a >= MMIO_BASE && a < MMIO_END) || (a >= 0x3ff00000 && a < 0x3ff30000)) {
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
    const p = this.peripheralAt(a);
    if (p) {
      p.writeUint32(a - p.base, v);
      return;
    }
    this.options.onUnclaimedMmio?.(a, true, v);
    this.fallback.set(a, v);
  }
}
