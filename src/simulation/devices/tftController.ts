// Colour TFT controllers over SPI.
//
// ILI9341, ST7735, ST7789 and GC9A01 are four different chips that agree about
// a common core — the MIPI DCS commands for addressing a window and writing
// pixels — and disagree about everything around it: which initialisation
// sequence they need, which pixel formats they accept, how many parameters
// their vendor commands take, and what they do when handed a byte they have
// never heard of.
//
// That shape decides the design here. `TftDisplayDevice` implements the shared
// core once: the D/C line, the parameter state machine, CASET/RASET/RAMWR, the
// framebuffer walk, MADCTL, sleep and display on/off. Each controller then
// supplies a `TftControllerSpec` describing what is genuinely its own —
// geometry, offsets, which vendor opcodes exist and how many arguments each
// takes, and which pixel formats it will accept.
//
// The point of that split is negative as much as positive. A shared decoder
// that accepted every controller's opcodes would let an ST7789 sketch appear to
// drive a GC9A01, which is exactly the mistake a simulator should reproduce
// rather than paper over: on a bench you get a blank screen, and you should get
// a blank screen here. Unknown opcodes are counted and reported, and a pixel
// format the part does not support is refused.
//
// NOT modelled: gamma tables, VCOM and power-control registers (accepted, their
// arguments consumed, no visual effect), tearing effect output, partial and
// idle modes, scroll, and reads back from display RAM — RAMRD returns an idle
// bus rather than a fabricated pixel.

import { Rgb565Framebuffer, type MemoryAccess } from './framebuffer';
import type { ControlPinReader, DeviceSnapshot, SpiDevice, SpiMode } from './types';

/** Commands every controller in this family shares. */
export const DCS = {
  NOP: 0x00,
  SWRESET: 0x01,
  RDDID: 0x04,
  SLPIN: 0x10,
  SLPOUT: 0x11,
  PTLON: 0x12,
  NORON: 0x13,
  INVOFF: 0x20,
  INVON: 0x21,
  DISPOFF: 0x28,
  DISPON: 0x29,
  CASET: 0x2a,
  RASET: 0x2b,
  RAMWR: 0x2c,
  RAMRD: 0x2e,
  PTLAR: 0x30,
  TEOFF: 0x34,
  TEON: 0x35,
  MADCTL: 0x36,
  IDMOFF: 0x38,
  IDMON: 0x39,
  COLMOD: 0x3a,
} as const;

export interface TftControllerSpec {
  /** Name used in logs and the inspector. */
  name: string;
  /** Panel size in its native orientation. */
  width: number;
  height: number;
  /**
   * Offsets added to the addressed window.
   *
   * A 128x160 ST7735 panel is a corner of the controller's 132x162 memory, and
   * a driver that does not apply the offset draws a picture shifted by two
   * pixels with a coloured border. Real, and worth reproducing.
   */
  colOffset?: number;
  rowOffset?: number;
  /** COLMOD values the part accepts, e.g. 0x55 for 16-bit. */
  pixelFormats: readonly number[];
  /**
   * The COLMOD bits the part actually decodes. The ST7735 reads only the low
   * three (IFPF); the rest are don't-care, which is why Adafruit's driver
   * sends 0x05 for 16-bit colour and a panel shows it. Omitted means every
   * bit counts.
   */
  pixelFormatMask?: number;
  /**
   * Vendor commands this controller has, and how many parameter bytes each
   * takes. Present so the byte stream stays in step even where the command has
   * no visual effect — and absent so another controller's commands do not.
   */
  vendorCommands: Readonly<Record<number, number>>;
  /**
   * True when the part powers up with its display already on.
   *
   * Almost none do. Modelled because a sketch that forgets DISPON gets a dark
   * panel on a bench and should get one here.
   */
  displayOnAtReset?: boolean;
  /** Set when the controller inverts by default (ST7789 modules commonly do). */
  invertedAtReset?: boolean;
}

/** Parameter counts for the shared DCS commands. */
const DCS_ARGS: Record<number, number> = {
  [DCS.NOP]: 0,
  [DCS.SWRESET]: 0,
  [DCS.SLPIN]: 0,
  [DCS.SLPOUT]: 0,
  [DCS.PTLON]: 0,
  [DCS.NORON]: 0,
  [DCS.INVOFF]: 0,
  [DCS.INVON]: 0,
  [DCS.DISPOFF]: 0,
  [DCS.DISPON]: 0,
  [DCS.CASET]: 4,
  [DCS.RASET]: 4,
  [DCS.RAMWR]: 0, // followed by pixel data, not by counted parameters
  [DCS.RAMRD]: 0,
  [DCS.PTLAR]: 4,
  [DCS.TEOFF]: 0,
  [DCS.TEON]: 1,
  [DCS.MADCTL]: 1,
  [DCS.IDMOFF]: 0,
  [DCS.IDMON]: 0,
  [DCS.COLMOD]: 1,
};

/** Idle MISO level — what a controller that does not drive it reads back as. */
const IDLE_BYTE = 0xff;

export class TftDisplayDevice implements SpiDevice {
  readonly instanceId: string;
  readonly csPinId: string | null;
  /** These parts clock on the rising edge with an idle-low clock: mode 0. */
  readonly supportedModes: readonly SpiMode[] = [0];

  readonly spec: TftControllerSpec;
  readonly fb: Rgb565Framebuffer;

  private readControl: ControlPinReader = () => undefined;

  private selected = false;
  private displayOn: boolean;
  private sleeping = true;
  private inverted: boolean;
  private pixelFormat = 0x55;

  /** Command awaiting parameters, or -1 when none. */
  private pending = -1;
  private params: number[] = [];
  private paramsWanted = 0;
  /** True once RAMWR has been issued: subsequent data bytes are pixels. */
  private streaming = false;
  /** High byte of an RGB565 pixel, waiting for its partner. */
  private halfPixel = -1;

  private lastResetLevel: boolean | undefined;
  private unknown: number[] = [];
  private refusedFormats: number[] = [];
  private commandBytes = 0;
  private log: string[] = [];

  constructor(instanceId: string, csPinId: string | null, spec: TftControllerSpec) {
    this.instanceId = instanceId;
    this.csPinId = csPinId;
    this.spec = spec;
    this.fb = new Rgb565Framebuffer(spec.width, spec.height);
    this.displayOn = spec.displayOnAtReset === true;
    this.inverted = spec.invertedAtReset === true;
  }

  attachControls(read: ControlPinReader): void {
    this.readControl = read;
  }

  /**
   * True when the byte on the wire is a command.
   *
   * D/C low means command. A part whose D/C is not wired at all cannot be told
   * apart from one held low, and that is the honest reading: with the line
   * floating the controller sees whatever the pin does, and treating it as
   * command-mode is what makes an unwired D/C produce a display that never
   * shows pixels rather than one that mysteriously works.
   */
  private get dataMode(): boolean {
    return this.readControl('dc') === true;
  }

  select(active: boolean): void {
    if (active === this.selected) return;
    this.selected = active;
    if (!active) {
      // Deselecting ends the transaction. A pixel stream that was mid-pixel
      // loses its dangling byte, exactly as the shift register would.
      this.halfPixel = -1;
      this.pending = -1;
      this.paramsWanted = 0;
      this.params = [];
    }
  }

  /**
   * Samples the hardware reset line.
   *
   * Called by the binding each time it settles. RESET is asynchronous and level
   * triggered: holding it low clears the controller, and releasing it leaves a
   * part in its power-on state — which is why a sketch that resets and then
   * immediately draws without re-initialising gets nothing.
   */
  settle(): void {
    const level = this.readControl('rst');
    if (level === undefined) return;
    if (this.lastResetLevel === true && level === false) this.hardReset();
    this.lastResetLevel = level;
  }

  private hardReset(): void {
    this.fb.reset();
    this.displayOn = this.spec.displayOnAtReset === true;
    this.sleeping = true;
    this.inverted = this.spec.invertedAtReset === true;
    this.pixelFormat = 0x55;
    this.pending = -1;
    this.params = [];
    this.paramsWanted = 0;
    this.streaming = false;
    this.halfPixel = -1;
    this.note('hardware reset');
  }

  transfer(mosi: number): number | null {
    const byte = mosi & 0xff;
    if (this.dataMode) this.dataByte(byte);
    else this.commandByte(byte);
    // These controllers share MISO with other parts and only drive it for reads
    // this model does not implement, so it never drives the line.
    return null;
  }

  private commandByte(value: number): void {
    this.commandBytes++;
    this.streaming = false;
    this.halfPixel = -1;
    this.params = [];

    const shared = DCS_ARGS[value];
    const vendor = this.spec.vendorCommands[value];
    const wanted = shared !== undefined ? shared : vendor;

    if (wanted === undefined) {
      // Not this controller's command. Counted, not guessed at — this is what
      // makes one controller's init sequence fail on another part.
      this.unknown.push(value);
      this.note(`unknown command 0x${value.toString(16)}`);
      this.pending = -1;
      this.paramsWanted = 0;
      return;
    }

    this.pending = value;
    this.paramsWanted = wanted;
    if (wanted === 0) this.applyCommand(value, []);
  }

  private dataByte(value: number): void {
    if (this.streaming) {
      // RGB565 arrives high byte first.
      if (this.halfPixel < 0) {
        this.halfPixel = value;
        return;
      }
      const pixel = (this.halfPixel << 8) | value;
      this.halfPixel = -1;
      this.fb.writePixel(pixel);
      return;
    }
    if (this.paramsWanted <= 0) return; // a data byte nobody asked for
    this.params.push(value);
    if (this.params.length >= this.paramsWanted) {
      const cmd = this.pending;
      const args = this.params;
      this.pending = -1;
      this.paramsWanted = 0;
      this.params = [];
      this.applyCommand(cmd, args);
    }
  }

  private applyCommand(cmd: number, args: number[]): void {
    switch (cmd) {
      case DCS.SWRESET:
        this.hardReset();
        this.note('software reset');
        return;
      case DCS.SLPOUT:
        this.sleeping = false;
        this.note('sleep out');
        return;
      case DCS.SLPIN:
        this.sleeping = true;
        return;
      case DCS.DISPON:
        this.displayOn = true;
        this.note('display on');
        return;
      case DCS.DISPOFF:
        this.displayOn = false;
        return;
      case DCS.INVON:
        this.inverted = true;
        return;
      case DCS.INVOFF:
        this.inverted = false;
        return;
      case DCS.CASET: {
        const start = ((args[0] << 8) | args[1]) - (this.spec.colOffset ?? 0);
        const end = ((args[2] << 8) | args[3]) - (this.spec.colOffset ?? 0);
        this.fb.setColumnRange(start, end);
        return;
      }
      case DCS.RASET: {
        const start = ((args[0] << 8) | args[1]) - (this.spec.rowOffset ?? 0);
        const end = ((args[2] << 8) | args[3]) - (this.spec.rowOffset ?? 0);
        this.fb.setRowRange(start, end);
        return;
      }
      case DCS.RAMWR:
        this.streaming = true;
        this.fb.rewind();
        return;
      case DCS.MADCTL: {
        const v = args[0] ?? 0;
        const access: MemoryAccess = {
          rowMirror: (v & 0x80) !== 0,
          colMirror: (v & 0x40) !== 0,
          exchange: (v & 0x20) !== 0,
          bgr: (v & 0x08) !== 0,
        };
        this.fb.access = access;
        this.note(`MADCTL 0x${v.toString(16)}`);
        return;
      }
      case DCS.COLMOD: {
        const mask = this.spec.pixelFormatMask ?? 0xff;
        const raw = args[0] ?? 0;
        const v = this.spec.pixelFormats.find((f) => (f & mask) === (raw & mask)) ?? raw;
        if (!this.spec.pixelFormats.includes(v)) {
          // A format the silicon does not have. Refusing it is the point: a
          // library configured for 18-bit colour on a part that only does 16
          // produces garbage on a bench, not a corrected picture.
          this.refusedFormats.push(v);
          this.note(`refused pixel format 0x${v.toString(16)}`);
          return;
        }
        this.pixelFormat = v;
        return;
      }
      default:
        // A vendor command this controller has: its parameters were consumed so
        // the stream stays in step, and it has no visual effect here.
        return;
    }
  }

  private note(text: string): void {
    this.log.push(text);
    if (this.log.length > 60) this.log.shift();
  }

  // ---- inspection ----

  /** True when the panel is actually showing its RAM. */
  get isVisible(): boolean {
    return this.displayOn && !this.sleeping;
  }
  get isInverted(): boolean {
    return this.inverted;
  }
  get isSleeping(): boolean {
    return this.sleeping;
  }
  get currentPixelFormat(): number {
    return this.pixelFormat;
  }
  get unknownCommands(): number[] {
    return [...new Set(this.unknown)];
  }
  get refusedPixelFormats(): number[] {
    return [...new Set(this.refusedFormats)];
  }
  get revision(): number {
    return this.fb.revision;
  }

  /** The colour the glass shows at a panel coordinate, after inversion. */
  pixel(x: number, y: number): { r: number; g: number; b: number } {
    if (!this.isVisible) return { r: 0, g: 0, b: 0 };
    const c = this.fb.pixel(x, y);
    return this.inverted ? { r: 255 - c.r, g: 255 - c.g, b: 255 - c.b } : c;
  }

  reset(): void {
    this.hardReset();
    this.unknown = [];
    this.refusedFormats = [];
    this.commandBytes = 0;
    this.log = [];
  }

  snapshot(): DeviceSnapshot {
    return {
      status:
        `${this.spec.name} ${this.spec.width}x${this.spec.height}: ` +
        `${this.isVisible ? 'on' : this.sleeping ? 'asleep' : 'display off'}, ` +
        `${this.fb.written} pixel(s) written, ${this.commandBytes} command(s)` +
        (this.unknown.length ? `, ${this.unknownCommands.length} unknown command(s)` : '') +
        (this.refusedFormats.length ? `, refused ${this.refusedPixelFormats.length} pixel format(s)` : ''),
      log: [...this.log],
    };
  }
}
