// E-paper: the panel does not follow its RAM.
//
// That sentence is the part. Everything else about an e-paper is ordinary SPI,
// and a model that repainted the glass whenever firmware wrote display RAM
// would look more responsive, be easier to build, and hide the single most
// confusing property of the technology — the one that produces "my drawing
// isn't showing up" on every forum thread about these panels.
//
// So there are two buffers, and only a refresh copies one to the other. The
// tests below are almost entirely about the gap between them: writing without
// refreshing, refreshing while asleep, resetting after refreshing, and BUSY
// being long enough that a driver's wait actually waits.

import { EpaperDevice, EPAPER_REFRESH_MS, EPAPER_WIDTH, EPAPER_HEIGHT } from '../src/simulation/devices/epaper';
import { COMPONENT_DEFINITIONS } from '../src/components-library/definitions';
import { COMPONENT_COVERAGE } from '../src/components-library/componentCoverage';

let failures = 0;
function check(cond: boolean, msg: string) {
  console.log(cond ? 'PASS:' : 'FAIL:', msg);
  if (!cond) failures++;
}
function section(t: string) {
  console.log(`\n--- ${t}`);
}

const defOf = (id: string) => COMPONENT_DEFINITIONS.find((d) => d.id === id);

/** Drives a panel, with a clock the test moves by hand. */
function panel() {
  let now = 0;
  const dev = new EpaperDevice('e', 'cs', () => now);
  let dc = false;
  let rst = true;
  dev.attachControls((pin) => (pin === 'dc' ? dc : pin === 'rst' ? rst : undefined));
  dev.select(true);
  return {
    dev,
    at: (ms: number) => {
      now = ms;
      dev.settle();
    },
    advance: (ms: number) => {
      now += ms;
      dev.settle();
    },
    cmd(opcode: number, ...args: number[]) {
      dc = false;
      dev.transfer(opcode);
      dc = true;
      for (const a of args) dev.transfer(a);
    },
    /** Display RAM bytes after a 0x24. */
    ram(...bytes: number[]) {
      dc = true;
      for (const b of bytes) dev.transfer(b);
    },
    resetPulse() {
      rst = true;
      dev.settle();
      rst = false;
      dev.settle();
      rst = true;
      dev.settle();
    },
  };
}

/** The bring-up every SSD1680 driver sends. */
function init(p: ReturnType<typeof panel>) {
  p.cmd(0x12); // software reset
  p.cmd(0x01, 0x27, 0x01, 0x00); // driver output control
  p.cmd(0x11, 0x03); // data entry mode
  p.cmd(0x44, 0x00, 0x0f); // RAM X window
  p.cmd(0x45, 0x00, 0x00, 0x27, 0x01); // RAM Y window
  p.cmd(0x4e, 0x00); // X cursor
  p.cmd(0x4f, 0x00, 0x00); // Y cursor
}

// ================================ 1. writing RAM does not change the picture ==
section('1. the glass does not follow the RAM');
{
  const p = panel();
  init(p);

  check(p.dev.shownPixelCount === 0, 'the panel starts blank, as one out of the box is');

  // A 0 bit is a dark pixel on this controller, so 0x00 is a run of black.
  p.cmd(0x24);
  p.ram(...new Array(16).fill(0x00));
  check(p.dev.pendingPixel(0, 0), 'firmware has written dark pixels into RAM');
  check(p.dev.shownPixelCount === 0, 'and the glass has not changed at all');
  check(!p.dev.pixel(0, 0), 'the pixel it wrote is not showing');

  // Only the refresh moves it.
  p.cmd(0x22, 0xf7); // display update control
  p.cmd(0x20); // master activation
  check(p.dev.isBusy, 'the update asserts BUSY');
  check(p.dev.shownPixelCount === 0, 'and the glass still has not changed while it runs');

  p.advance(EPAPER_REFRESH_MS);
  check(!p.dev.isBusy, 'BUSY drops when the update finishes');
  check(p.dev.pixel(0, 0), 'and now the pixel is on the glass');
  check(p.dev.shownPixelCount === 128, `exactly the pixels firmware wrote (${p.dev.shownPixelCount})`);
  check(p.dev.refreshCount === 1, 'one refresh happened');
}

// ============================================== 2. the image persists ========
section('2. what is shown stays shown');
{
  const p = panel();
  init(p);
  p.cmd(0x24);
  p.ram(...new Array(16).fill(0x00));
  p.cmd(0x20);
  p.advance(EPAPER_REFRESH_MS);
  const shown = p.dev.shownPixelCount;
  check(shown > 0, `an image is on the glass (${shown} dark pixels)`);

  // Write completely different RAM. The glass must not move.
  p.cmd(0x24);
  p.ram(...new Array(16).fill(0xff));
  check(p.dev.shownPixelCount === shown, 'writing new RAM does not disturb it');

  // A software reset clears the controller. It does not clear the panel.
  p.cmd(0x12);
  check(p.dev.shownPixelCount === shown, 'a software reset does not clear the panel');

  // Neither does a hardware reset — which is the property that makes these
  // useful for battery devices, and surprising to everyone at first.
  p.resetPulse();
  check(p.dev.shownPixelCount === shown, 'and neither does a hardware reset');

  // Only another refresh does.
  p.cmd(0x11, 0x03);
  p.cmd(0x4e, 0x00);
  p.cmd(0x4f, 0x00, 0x00);
  p.cmd(0x24);
  p.ram(...new Array(16).fill(0xff)); // 0xff = white
  p.cmd(0x20);
  p.advance(EPAPER_REFRESH_MS);
  check(p.dev.shownPixelCount < shown, `and a second refresh replaces it (${p.dev.shownPixelCount})`);
}

// ================================================ 3. BUSY is worth waiting on
section('3. BUSY is long enough that a wait is a wait');
{
  const p = panel();
  init(p);
  p.cmd(0x24);
  p.ram(0x00);
  p.cmd(0x20);

  check(p.dev.isBusy, 'BUSY goes high immediately');
  p.advance(EPAPER_REFRESH_MS / 2);
  check(p.dev.isBusy, 'and is still high halfway through');
  check(p.dev.refreshCount === 0, 'with nothing on the glass yet');
  p.advance(EPAPER_REFRESH_MS / 2);
  check(!p.dev.isBusy, 'and drops at the end');
  check(p.dev.refreshCount === 1, 'having completed exactly one refresh');

  // A second activation while busy is ignored rather than queued.
  const q = panel();
  init(q);
  q.cmd(0x24);
  q.ram(0x00);
  q.cmd(0x20);
  q.cmd(0x20);
  q.advance(EPAPER_REFRESH_MS);
  check(q.dev.refreshCount === 1, 'a second activation during an update does not stack up a second refresh');
}

// ===================================== 4. deep sleep refuses to refresh ======
section('4. a panel in deep sleep does not refresh');
{
  const p = panel();
  init(p);
  p.cmd(0x24);
  p.ram(...new Array(16).fill(0x00));
  p.cmd(0x10, 0x01); // deep sleep
  check(p.dev.isAsleep, 'the controller is asleep');

  p.cmd(0x20);
  p.advance(EPAPER_REFRESH_MS * 2);
  check(p.dev.refreshCount === 0, 'the refresh was refused');
  check(p.dev.shownPixelCount === 0, 'and nothing reached the glass');

  // Waking it up is a reset, and then it works.
  p.resetPulse();
  check(!p.dev.isAsleep, 'a hardware reset wakes it');
  init(p);
  p.cmd(0x24);
  p.ram(...new Array(16).fill(0x00));
  p.cmd(0x20);
  p.advance(EPAPER_REFRESH_MS);
  check(p.dev.refreshCount === 1, 'and now the refresh happens');
}

// ============================================= 5. unknown commands are counted
section('5. commands this controller does not have');
{
  const p = panel();
  // 0x2C is an ILI9341 memory write. Not an SSD1680 command.
  p.cmd(0x2c);
  // 0x2C IS in this controller's table (VCOM), so pick one that genuinely is not.
  p.cmd(0xa5);
  check(p.dev.unknownCommands.includes(0xa5), 'an opcode from another controller is recorded as unknown');
  check(!p.dev.unknownCommands.includes(0x24), 'while its own write-RAM command is not');
}

// ==================================================== 6. the part as shipped =
section('6. the part in the library');
{
  const def = defOf('comp.epaper29');
  check(def !== undefined, 'the e-paper is in the library');
  if (def) {
    check(def.supportLevel === 'simulated', 'badged Simulated');
    check(def.simulationAdapterId === 'sim.epaper', 'on the e-paper adapter');
    for (const pinId of ['sck', 'mosi', 'cs', 'dc', 'rst', 'busy', 'vcc', 'gnd']) {
      check(def.pins.some((pp) => pp.id === pinId), `it exposes ${pinId}`);
    }
    check(
      def.pins.find((pp) => pp.id === 'busy')?.capabilities.includes('digital-out') === true,
      'and BUSY is an output from the panel, not something the board drives',
    );
    // The honesty rule: what is not modelled has to be named.
    for (const claim of ['ghosting', 'LUT waveforms', 'temperature compensation']) {
      check((def.description ?? '').includes(claim), `the description disclaims ${claim}`);
    }
  }
  const cov = COMPONENT_COVERAGE.find((c) => c.id === 'comp.epaper29');
  check(cov?.status === 'simulated', 'recorded as simulated');
  check((cov?.tests ?? []).includes('tests/displays.epaper.mts'), 'and names this file as its proof');

  console.log(`   panel geometry: ${EPAPER_WIDTH}x${EPAPER_HEIGHT}, refresh ${EPAPER_REFRESH_MS} ms`);
}

console.log(failures === 0 ? '\nE-paper checks passed.' : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
