// The ESP32-C6 machine: its SoC configuration, its own blocks, and how far
// real C6 firmware gets through it.
//
// The risk this file exists to catch is a C6 built by copying the C3's machine
// and editing constants. Several of the differences would not crash — they
// would quietly produce wrong behaviour — so each is asserted by value against
// the Espressif header it was read from.

import { ESP32C3_SOC, ESP32C6_SOC } from '../src/simulation/espRiscv/soc';
import { createEsp32C6Machine, Esp32C6Machine } from '../src/simulation/esp32c6/esp32c6Machine';
import { Esp32C6FlashMmu } from '../src/simulation/esp32c6/flashMmu';
import { Esp32C6LpTimer, RC_SLOW_HZ } from '../src/simulation/esp32c6/lpTimer';
import { Esp32C6AnalogMaster, BBPLL_CALIBRATION_NS } from '../src/simulation/esp32c6/analogMaster';
import { Esp32C6InterruptController, ESP32C6_INTERRUPT_SOURCE } from '../src/simulation/esp32c6/interrupts';
import { ESP32C6_GPIO_COUNT, ESP32C6_PERIPHERAL_BASE } from '../src/simulation/esp32c6/peripherals';
import { ESP32C6_ROM_WATCHDOG, WDT_WRITE_PROTECT_KEY } from '../src/simulation/esp32c6/romWatchdog';
import { romTableFor } from '../src/simulation/esp32c6/romDispatch';

let failures = 0;
function check(cond: boolean, msg: string) {
  console.log(cond ? 'PASS:' : 'FAIL:', msg);
  if (!cond) failures++;
}

// ---------- 1. the memory map is the C6's, not the C3's ----------
{
  const c6 = ESP32C6_SOC.memory;
  const c3 = ESP32C3_SOC.memory;

  // SOC_IRAM_LOW == SOC_DRAM_LOW on this part: one window serves both.
  check(c6.iram.start === c6.dram.start && c6.iram.end === c6.dram.end, 'the C6 unifies instruction and data RAM');
  check(c6.iram.start === 0x40800000 && c6.iram.end === 0x40880000, 'at 0x40800000-0x40880000');
  check(c3.iram.start !== c3.dram.start, 'while the C3 splits them');

  // SOC_IROM_LOW == SOC_DROM_LOW likewise.
  check(c6.irom.start === c6.drom.start && c6.irom.end === c6.drom.end, 'and unifies the two cache windows');
  check(c6.irom.start === 0x42000000 && c6.irom.end === 0x43000000, 'at 0x42000000-0x43000000, twice the C3\'s');
  check(c3.irom.start !== c3.drom.start, 'while the C3 splits those too');

  // SOC_IROM_MASK_HIGH.
  check(c6.rom.end === 0x40050000, 'the C6 mask ROM window ends at 0x40050000');
  check(c3.rom.end === 0x40060000, 'and the C3\'s at 0x40060000, so the two differ');

  check(c6.rtcFast.end - c6.rtcFast.start === 0x4000, 'the C6 has 16 KB of low-power memory');
  check(c3.rtcFast.end - c3.rtcFast.start === 0x2000, 'against the C3\'s 8 KB');

  // SOC_ROM_STACK_START.
  check(ESP32C6_SOC.romStackTop === 0x4087e610, 'the ROM stack top is the C6\'s own');
  check(
    ESP32C6_SOC.romStackTop > c6.dram.start && ESP32C6_SOC.romStackTop < c6.dram.end,
    'and lies inside the C6\'s RAM rather than the C3\'s',
  );
  check(
    ESP32C3_SOC.romStackTop < c6.dram.start,
    'the C3\'s would fall outside it entirely, so reusing it would corrupt the first stack frame',
  );
}

// ---------- 2. the flash MMU is a different piece of hardware ----------
{
  check(ESP32C6_SOC.mmu.entryCount === 256, 'the C6 MMU has 256 entries');
  check(ESP32C3_SOC.mmu.entryCount === 128, 'against the C3\'s 128');
  check(ESP32C6_SOC.mmu.validity.kind === 'validBit', 'the C6 sets a bit to mean valid');
  check(ESP32C3_SOC.mmu.validity.kind === 'invalidBit', 'and the C3 sets one to mean invalid — the opposite rule');

  const mmu = new Esp32C6FlashMmu();

  // Nothing is mapped until firmware or the loader says so, and on this part
  // that is the all-zero entry rather than a set invalid bit.
  check(mmu.translate(0x42000000) === undefined, 'an unmapped page translates to nothing');
  check(mmu.entry(0) === 0, 'because an entry with no valid bit is what unmapped means here');

  mmu.map(0, 3);
  check(mmu.translate(0x42000000) === 3 * 0x10000, 'a mapped page translates to its flash offset');
  check((mmu.entry(0) & (1 << 9)) !== 0, 'and the entry carries the valid bit, SOC_MMU_VALID');
  check(mmu.translate(0x42000010) === 3 * 0x10000 + 0x10, 'with the offset within the page preserved');

  // 256 entries need a 9-bit page number, and the top of the window must reach
  // the last entry rather than wrapping at 128 as the C3's mask would.
  mmu.map(255, 0x1ff);
  check(mmu.entryOf(0x42ff0000) === 255, 'the last page of the window is entry 255');
  check(mmu.translate(0x42ff0000) === 0x1ff * 0x10000, 'and a 9-bit page number survives the round trip');
  check(mmu.entryOf(0x42800000) === 128, 'entry 128 exists, which the C3\'s 128-entry table could not address');

  // The access port: the C6 has no memory-mapped table, so every entry is
  // reached by selecting an index and then reading the content register.
  mmu.writeUint32(0x380, 255);
  check(mmu.readUint32(0x37c) === mmu.entry(255), 'an entry is readable through the index/content register pair');
  mmu.writeUint32(0x380, 7);
  mmu.writeUint32(0x37c, 0x209);
  check(mmu.entry(7) === 0x209, 'and writable through it');
  check(mmu.translate(0x42070000) === 9 * 0x10000, 'a firmware-written entry maps as the hardware would read it');

  check(mmu.base === 0x60002000, 'the port lives in SPI0, which on the C6 is at 0x60002000');
  check(ESP32C6_PERIPHERAL_BASE.spi1 === 0x60003000, 'and SPI1 at 0x60003000 — the two swap against the C3');
}

// ---------- 3. the interrupt controller spans two blocks ----------
{
  check(ESP32C6_SOC.cpuInterrupts.base === 0x600c5000, 'the C6 CPU interrupt controller is INTPRI at 0x600c5000');
  check(ESP32C3_SOC.cpuInterrupts.base === 0x600c2000, 'while the C3 keeps its inside the matrix at 0x600c2000');
  check(
    ESP32C6_SOC.cpuInterrupts.enable !== ESP32C3_SOC.cpuInterrupts.enable &&
      ESP32C6_SOC.cpuInterrupts.threshold !== ESP32C3_SOC.cpuInterrupts.threshold &&
      ESP32C6_SOC.cpuInterrupts.priorityBase !== ESP32C3_SOC.cpuInterrupts.priorityBase,
    'and every register offset differs',
  );
  check(
    ESP32C6_SOC.softwareInterrupts.base === ESP32C6_SOC.cpuInterrupts.base,
    'the C6 software interrupts are inside INTPRI',
  );
  check(
    ESP32C3_SOC.softwareInterrupts.base !== ESP32C3_SOC.cpuInterrupts.base,
    'while the C3 keeps its in a different block again',
  );

  // No source number carries over, which is what makes a shared table unsafe.
  const c3 = ESP32C3_SOC.interruptSources;
  const c6 = ESP32C6_SOC.interruptSources;
  const moved = (['gpio', 'uart0', 'uart1', 'systimerTarget0', 'fromCpu0'] as const).filter((k) => c3[k] !== c6[k]);
  check(moved.length === 5, `all five named interrupt sources move between the parts (${moved.join(', ')})`);
  check(c6.gpio === 30 && c6.systimerTarget0 === 57 && c6.fromCpu0 === 22, 'and are the C6\'s own numbers');

  // The controller reads routing from one block and everything else from the
  // other, so a route written to the matrix has to reach a decision made in
  // INTPRI. That crossing is the whole reason the class exists.
  const controller = new Esp32C6InterruptController();
  const [map, priority] = controller.peripherals;
  check(map.base === 0x60010000 && priority.base === 0x600c5000, 'its two windows sit at the C6\'s two addresses');

  const LINE = 7;
  map.writeUint32(ESP32C6_INTERRUPT_SOURCE.systimerTarget0 * 4, LINE);
  check(controller.routeOf(ESP32C6_INTERRUPT_SOURCE.systimerTarget0) === LINE, 'a source routes to the line it was given');

  priority.writeUint32(ESP32C6_SOC.cpuInterrupts.enable, 1 << LINE);
  priority.writeUint32(ESP32C6_SOC.cpuInterrupts.priorityBase + LINE * 4, 3);
  priority.writeUint32(ESP32C6_SOC.cpuInterrupts.threshold, 1);
  const pending = controller.evaluate([ESP32C6_INTERRUPT_SOURCE.systimerTarget0]);
  check(pending === 1 << LINE, 'and asserting it makes that line pending');
  check(controller.select(pending) === LINE, 'and the controller selects it');

  // Below the threshold it is masked, which is how a handler stops itself
  // being re-entered.
  priority.writeUint32(ESP32C6_SOC.cpuInterrupts.threshold, 4);
  check(controller.select(pending) === undefined, 'a line below the threshold is masked out');

  // Priority words are indexed from line zero. Indexing from one leaves every
  // interrupt able to re-enter itself, which is a bug this runtime has had.
  priority.writeUint32(ESP32C6_SOC.cpuInterrupts.priorityBase + LINE * 4, 0);
  priority.writeUint32(ESP32C6_SOC.cpuInterrupts.threshold, 1);
  check(controller.select(pending) === undefined, 'the priority word for a line is at priorityBase + line*4');

  // The software interrupts, which FreeRTOS yields through.
  priority.writeUint32(ESP32C6_SOC.softwareInterrupts.fromCpu0, 1);
  check(
    controller.interruptSource.assertedInterruptSources().includes(ESP32C6_INTERRUPT_SOURCE.fromCpu0),
    'writing FROM_CPU_0 asserts source 22, not the C3\'s 50',
  );
}

// ---------- 4. the low-power timer really counts ----------
{
  let nanos = 0;
  const timer = new Esp32C6LpTimer({ get nanos() { return nanos; } });
  const UPDATE = 0x10;
  const BUF0_LOW = 0x14;
  const MAIN_TIMER_UPDATE = 1 << 28;

  // Reading it is a two-step transaction: latch, then read the buffers.
  nanos = 1_000_000_000;
  check(timer.readUint32(BUF0_LOW) === 0, 'the buffers hold nothing until the counter is latched');
  timer.writeUint32(UPDATE, MAIN_TIMER_UPDATE);
  check(timer.readUint32(BUF0_LOW) === RC_SLOW_HZ, 'after a latch they hold one second of slow-clock cycles');

  // And it is a snapshot, not a live read — which is the point of the latch.
  nanos = 2_000_000_000;
  check(timer.readUint32(BUF0_LOW) === RC_SLOW_HZ, 'the buffers keep that snapshot until the next latch');
  timer.writeUint32(UPDATE, MAIN_TIMER_UPDATE);
  check(timer.readUint32(BUF0_LOW) === 2 * RC_SLOW_HZ, 'and follow the counter when latched again');

  check((timer.readUint32(UPDATE) & MAIN_TIMER_UPDATE) === 0, 'the trigger bit does not stay set');
}

// ---------- 5. BBPLL calibration completes, but not instantly ----------
{
  let nanos = 0;
  const analog = new Esp32C6AnalogMaster({ get nanos() { return nanos; } });
  const ANA_CONF0 = 0x18;
  const STOP_FORCE_HIGH = 1 << 2;
  const STOP_FORCE_LOW = 1 << 3;
  const CAL_DONE = 1 << 24;

  check((analog.readUint32(ANA_CONF0) & CAL_DONE) === 0, 'calibration is not done before it is started');

  // regi2c_ctrl_ll_bbpll_calibration_start(): clear FORCE_HIGH, set FORCE_LOW.
  analog.writeUint32(ANA_CONF0, STOP_FORCE_LOW);
  check((analog.readUint32(ANA_CONF0) & CAL_DONE) === 0, 'nor at the instant the PLL is released');
  nanos = BBPLL_CALIBRATION_NS - 1;
  check((analog.readUint32(ANA_CONF0) & CAL_DONE) === 0, 'nor a moment before it could have settled');
  nanos = BBPLL_CALIBRATION_NS;
  check((analog.readUint32(ANA_CONF0) & CAL_DONE) !== 0, 'but it is done once the PLL has been released long enough');

  // Forcing it stopped abandons the calibration.
  analog.writeUint32(ANA_CONF0, STOP_FORCE_HIGH);
  check((analog.readUint32(ANA_CONF0) & CAL_DONE) === 0, 'and stopping the PLL takes the done bit away again');

  // The controller registers report not-busy, which is what firmware polls for.
  analog.writeUint32(0x04, 0x361);
  check((analog.readUint32(0x04) & (1 << 25)) === 0, 'a completed transaction leaves the controller not busy');
}

// ---------- 6. the ROM watchdog HAL, which the C3 has no counterpart for ----------
{
  const { machine } = createEsp32C6Machine();
  const table = romTableFor('esp32c6');

  for (const entry of ESP32C6_ROM_WATCHDOG) {
    check(table.entries.get(entry.address) === entry, `${entry.name} is dispatchable at 0x${entry.address.toString(16)}`);
  }
  check(
    romTableFor('esp32c3').entries.get(0x400003a0) === undefined,
    'and none of it is offered on a C3, whose ROM does not publish a watchdog HAL',
  );

  // Drive it as firmware does: build a context, unlock, disable, read back.
  const CONTEXT = 0x40800100;
  const TIMG0 = ESP32C6_PERIPHERAL_BASE.timg0;
  const WDT_CONFIG0 = 0x48;
  const WDT_WPROTECT = 0x64;
  const WDT_EN = 1 << 31;

  machine.writeUint32(CONTEXT, 1); // WDT_MWDT0
  machine.writeUint32(CONTEXT + 4, TIMG0);

  const call = (address: number, ...args: number[]) => {
    machine.core.registers[1] = 0x40800000; // a return address outside the ROM
    for (let i = 0; i < args.length; i++) machine.core.registers[10 + i] = args[i] | 0;
    machine.core.pc = address;
    machine.step();
    return machine.core.registers[10] | 0;
  };

  call(0x400003a0, CONTEXT); // wdt_hal_write_protect_disable
  check(machine.readUint32(TIMG0 + WDT_WPROTECT) === WDT_WRITE_PROTECT_KEY, 'unlocking writes the documented key');

  call(0x400003a8, CONTEXT); // wdt_hal_enable
  check((machine.readUint32(TIMG0 + WDT_CONFIG0) & WDT_EN) !== 0, 'enabling sets the enable bit in the real register');
  check(call(0x400003bc, CONTEXT) === 1, 'and wdt_hal_is_enabled reads it back from the register');

  call(0x400003ac, CONTEXT); // wdt_hal_disable
  check((machine.readUint32(TIMG0 + WDT_CONFIG0) & WDT_EN) === 0, 'disabling clears it');
  check(call(0x400003bc, CONTEXT) === 0, 'and the read-back agrees, rather than reporting remembered state');

  // A stage writes both its timeout and its behaviour field.
  call(0x4000039c, CONTEXT, 0, 1234, 2); // wdt_hal_config_stage(hal, 0, 1234, 2)
  check(machine.readUint32(TIMG0 + 0x4c) === 1234, 'a stage timeout reaches its own register');
  check(((machine.readUint32(TIMG0 + WDT_CONFIG0) >>> 28) & 0x3) === 2, 'and its behaviour reaches CONFIG0');

  call(0x400003a4, CONTEXT); // wdt_hal_write_protect_enable
  check(machine.readUint32(TIMG0 + WDT_WPROTECT) !== WDT_WRITE_PROTECT_KEY, 'and protection is restored afterwards');
}

// ---------- 7. the machine refuses a C3 image ----------
{
  const machine = new Esp32C6Machine();
  check(machine.soc.chip === 'esp32c6', 'the machine knows which part it is');
  check(machine.isRomAddress(0x4004ffff), 'the C6 ROM window includes 0x4004ffff');
  check(!machine.isRomAddress(0x40050000), 'and ends there, where the C3\'s continues');
  check(machine.isRomAddress(0x40055000) === false, 'so a C3-only ROM address is not mistaken for one');

  // The image loader needs an MMU; a bare machine has none, and says so.
  let complained = false;
  try {
    machine.loadImage({ chipName: 'esp32c6', entryPoint: 0x40800828, segments: [], byteLength: 0 } as never);
  } catch (error) {
    complained = /ESP32-C6 machine has no flash MMU/.test((error as Error).message);
  }
  check(complained, 'and an image cannot be loaded without one, named as a C6 rather than a C3');
}

// ---------- 8. GPIO is the C6's, with the C6's pin count ----------
{
  const { gpio } = createEsp32C6Machine();
  check(gpio.base === 0x60091000, 'the GPIO block is at the C6\'s base');
  check(gpio.ioMux.base === 0x60090000, 'and the IO MUX at the C6\'s');
  check(gpio.pinCount === ESP32C6_GPIO_COUNT && gpio.pinCount === 31, 'with 31 pads, SOC_GPIO_PIN_COUNT');
  check(gpio.pinNumbers().length === 31, 'and every one of them reported');
  check(gpio.pinState(30).pin === 30, 'including GPIO30, which a C3 does not have');
}

console.log(failures === 0 ? '\nESP32-C6 machine checks passed.' : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
