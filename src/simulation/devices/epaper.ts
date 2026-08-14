// 2.9" e-paper (SSD1680-family controller), over SPI.
//
// The behaviour that makes an e-paper an e-paper, and the one a simulator has
// to get right or the part is worthless: the panel does not follow its RAM.
// Writing display RAM changes nothing anybody can see. The image only changes
// when a refresh is commanded, and then it stays there — through further RAM
// writes, through the controller going to sleep, and through the board being
// reset.
//
// That is the single most confusing thing about the part for someone meeting it
// for the first time ("my drawing isn't showing up"), and a model that repainted
// on every RAM write would hide it completely while looking more responsive.
// So there are two buffers here: the RAM firmware writes, and the image the
// panel is showing, and only a refresh copies one to the other.
//
// BUSY is modelled as a real output: the controller asserts it for the duration
// of an update, and every driver library waits on it. A sketch that polls BUSY
// therefore blocks for a plausible time rather than spinning forever or
// returning instantly.
//
// NOT modelled, and deliberately not claimed: ghosting, the LUT waveforms that
// drive the particles, partial-refresh artefacts, refresh current, temperature
// compensation, and the red channel of three-colour panels. A refresh here is
// instantaneous-and-clean at the end of its BUSY period. What IS modelled is
// the state machine — RAM, window, cursor, refresh, sleep, BUSY — which is what
// decides whether a driver works.

import { PagedMonoRam } from './pagedMono';
import type { ControlPinReader, DeviceSnapshot, SpiDevice, SpiMode } from './types';

export const EPAPER_WIDTH = 128;
export const EPAPER_HEIGHT = 296;

/** How long an update holds BUSY. Real panels take one to two seconds. */
export const EPAPER_REFRESH_MS = 1500;

/** Commands, and how many parameter bytes each takes. */
const COMMAND_ARGS: Record<number, number> = {
  0x01: 3, // driver output control
  0x03: 1, // gate driving voltage
  0x04: 3, // source driving voltage
  0x0c: 4, // booster soft start
  0x10: 1, // deep sleep mode
  0x11: 1, // data entry mode
  0x12: 0, // software reset
  0x18: 1, // temperature sensor control
  0x20: 0, // master activation — this is the refresh
  0x21: 2, // display update control 1
  0x22: 1, // display update control 2
  0x24: -1, // write RAM (black/white); data follows until the next command
  0x26: -1, // write RAM (red), accepted and discarded on a mono panel
  0x2c: 1, // VCOM
  0x32: -1, // write LUT
  0x37: 10, // write register for display option
  0x3a: 1, // dummy line period
  0x3b: 1, // gate line width
  0x3c: 1, // border waveform
  0x44: 2, // RAM X start/end
  0x45: 4, // RAM Y start/end
  0x4e: 1, // RAM X cursor
  0x4f: 2, // RAM Y cursor
  0x7f: 0, // NOP
};

export class EpaperDevice implements SpiDevice {
  readonly instanceId: string;
  readonly csPinId: string | null;
  readonly supportedModes: readonly SpiMode[] = [0];

  /** What firmware has written. Invisible until a refresh. */
  readonly ram = new PagedMonoRam(EPAPER_WIDTH, EPAPER_HEIGHT);
  /** What the glass is actually showing. */
  private displayed = new Uint8Array((EPAPER_WIDTH * EPAPER_HEIGHT) / 8);

  private readControl: ControlPinReader = () => undefined;
  private nowMs: () => number = () => 0;

  private pending = -1;
  private args: number[] = [];
  private argsWanted = 0;
  /** True while data bytes are display RAM rather than command parameters. */
  private streaming = false;

  /** Simulated time the current update finishes, or null when idle. */
  private busyUntilMs: number | null = null;
  private sleeping = false;
  private refreshes = 0;
  private ramBytes = 0;

  private lastResetLevel: boolean | undefined;
  private unknown: number[] = [];
  private log: string[] = [];
  revision = 0;

  constructor(instanceId: string, csPinId: string | null, nowMs: () => number) {
    this.instanceId = instanceId;
    this.csPinId = csPinId;
    this.nowMs = nowMs;
  }

  attachControls(read: ControlPinReader): void {
    this.readControl = read;
  }

  /**
   * Completes an update whose time has come, and follows the reset line.
   *
   * Called once per slice by the binding. The refresh is not instantaneous
   * because a driver waits on BUSY, and a BUSY that dropped in the same
   * transaction would let a sketch with a broken wait appear to work.
   */
  settle(): void {
    if (this.busyUntilMs !== null && this.nowMs() >= this.busyUntilMs) {
      this.displayed = this.ram.orientedFrame().slice();
      this.busyUntilMs = null;
      this.refreshes++;
      this.revision++;
      this.note('update complete');
    }
    const level = this.readControl('rst');
    if (level !== undefined) {
      if (this.lastResetLevel === true && level === false) this.hardReset();
      this.lastResetLevel = level;
    }
  }

  /**
   * True while an update is running.
   *
   * The panel drives BUSY high during an update on this controller family, and
   * every driver polls it before sending the next command.
   */
  get isBusy(): boolean {
    return this.busyUntilMs !== null;
  }

  select(active: boolean): void {
    if (!active) {
      this.streaming = false;
      this.pending = -1;
      this.argsWanted = 0;
      this.args = [];
    }
  }

  transfer(mosi: number): number | null {
    const byte = mosi & 0xff;
    if (this.readControl('dc') === true) this.dataByte(byte);
    else this.commandByte(byte);
    return null;
  }

  private commandByte(value: number): void {
    this.streaming = false;
    this.args = [];
    const wanted = COMMAND_ARGS[value];
    if (wanted === undefined) {
      this.unknown.push(value);
      this.note(`unknown command 0x${value.toString(16)}`);
      this.pending = -1;
      this.argsWanted = 0;
      return;
    }
    this.pending = value;
    if (wanted < 0) {
      // A streaming command: everything that follows is data until the next
      // command byte arrives.
      this.argsWanted = 0;
      this.streaming = true;
      if (value === 0x24) this.ram.rewindCursor();
      return;
    }
    this.argsWanted = wanted;
    if (wanted === 0) this.apply(value, []);
  }

  private dataByte(value: number): void {
    if (this.streaming) {
      if (this.pending === 0x24) {
        // Display RAM. Inverted relative to the OLEDs: on this controller a
        // zero bit is a black pixel, because the panel's default is white.
        this.ram.write(~value & 0xff);
        this.ramBytes++;
      }
      // 0x26 (red channel) and 0x32 (LUT) are consumed and discarded, which is
      // what a mono panel with a fixed waveform does with them.
      return;
    }
    if (this.argsWanted <= 0) return;
    this.args.push(value);
    if (this.args.length >= this.argsWanted) {
      const cmd = this.pending;
      const args = this.args;
      this.pending = -1;
      this.argsWanted = 0;
      this.args = [];
      this.apply(cmd, args);
    }
  }

  private apply(cmd: number, args: number[]): void {
    switch (cmd) {
      case 0x12:
        this.softReset();
        return;
      case 0x10:
        this.sleeping = (args[0] & 0x03) !== 0;
        this.note(this.sleeping ? 'deep sleep' : 'awake');
        return;
      case 0x20:
        this.startUpdate();
        return;
      case 0x11:
        this.ram.addressingMode = (args[0] & 0x04) !== 0 ? 'vertical' : 'horizontal';
        return;
      case 0x44:
        this.ram.colStart = (args[0] & 0x1f) * 8;
        this.ram.colEnd = Math.min(((args[1] & 0x1f) + 1) * 8 - 1, EPAPER_WIDTH - 1);
        return;
      case 0x45:
        this.ram.pageStart = 0;
        this.ram.pageEnd = this.ram.pages - 1;
        return;
      case 0x4e:
        this.ram.col = (args[0] & 0x1f) * 8;
        return;
      case 0x4f:
        this.ram.page = Math.min(((args[1] << 8) | args[0]) >> 3, this.ram.pages - 1);
        return;
      default:
        return; // accepted, consumed, no visual effect
    }
  }

  /**
   * Begins an update.
   *
   * Refused while asleep, which is the other thing that catches people: a
   * driver that puts the panel into deep sleep to save power and then tries to
   * refresh without waking it gets nothing, on a bench and here.
   */
  private startUpdate(): void {
    if (this.sleeping) {
      this.note('refresh ignored: the controller is in deep sleep');
      return;
    }
    if (this.busyUntilMs !== null) {
      this.note('refresh ignored: an update is already running');
      return;
    }
    this.busyUntilMs = this.nowMs() + EPAPER_REFRESH_MS;
    this.note('update started');
  }

  private softReset(): void {
    // A software reset clears the controller's settings and its RAM. It does
    // NOT clear the panel: the image stays until something refreshes it, which
    // is the defining property of the technology.
    this.ram.reset();
    this.streaming = false;
    this.pending = -1;
    this.argsWanted = 0;
    this.args = [];
    this.sleeping = false;
    this.note('software reset (the shown image is unaffected)');
  }

  private hardReset(): void {
    this.softReset();
    this.busyUntilMs = null;
    this.note('hardware reset (the shown image is unaffected)');
  }

  private note(text: string): void {
    this.log.push(text);
    if (this.log.length > 40) this.log.shift();
  }

  // ---- inspection ----

  /** The image on the glass. Never null: an e-paper always shows something. */
  frame(): Uint8Array {
    return this.displayed;
  }

  /** True when the pixel is dark on the shown image. */
  pixel(x: number, y: number): boolean {
    if (x < 0 || y < 0 || x >= EPAPER_WIDTH || y >= EPAPER_HEIGHT) return false;
    return ((this.displayed[(y >> 3) * EPAPER_WIDTH + x] >> (y & 7)) & 1) === 1;
  }

  /** What firmware has written but not yet refreshed onto the glass. */
  pendingPixel(x: number, y: number): boolean {
    return this.ram.pixel(x, y);
  }

  get shownPixelCount(): number {
    let n = 0;
    for (let i = 0; i < this.displayed.length; i++) {
      let b = this.displayed[i];
      while (b) {
        n += b & 1;
        b >>= 1;
      }
    }
    return n;
  }
  get refreshCount(): number {
    return this.refreshes;
  }
  get isAsleep(): boolean {
    return this.sleeping;
  }
  get unknownCommands(): number[] {
    return [...new Set(this.unknown)];
  }

  reset(): void {
    this.hardReset();
    this.displayed.fill(0);
    this.refreshes = 0;
    this.ramBytes = 0;
    this.unknown = [];
    this.log = [];
    this.revision++;
  }

  snapshot(): DeviceSnapshot {
    return {
      status:
        `E-paper ${EPAPER_WIDTH}x${EPAPER_HEIGHT} — ` +
        `${this.isBusy ? 'refreshing' : this.sleeping ? 'asleep' : 'idle'}, ` +
        `${this.refreshes} refresh(es), ${this.shownPixelCount} dark pixel(s) shown, ` +
        `${this.ramBytes} byte(s) written to RAM` +
        (this.unknown.length ? `, ${this.unknownCommands.length} unknown command(s)` : ''),
      log: [...this.log],
    };
  }
}
