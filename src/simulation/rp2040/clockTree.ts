// RP2040 clock tree, modelled from the real registers.
//
// WHY THIS EXISTS
//
// rp2040js stores `clkSys` and `clkPeri` as plain numbers fixed at 125 MHz and
// never updates them. It records writes to CLK_SYS_CTRL and CLK_PERI_CTRL but
// does not act on them, and both PLLs are UnimplementedPeripherals that drop
// every write.
//
// The visible consequence is the UART. `RPUART.baudRate` is
// `clkPeri / (baudDivider * 16)`, and the Pico SDK runs clk_peri from the USB
// PLL at 48 MHz, so it programs a divisor for 48 MHz. Divided into a hard-coded
// 125 MHz that divisor reports roughly 300 kbaud where the sketch asked for
// 115200 — a 2.6x error on every rate, in the same proportion, which is what
// gives the bug away as a clock-source problem rather than a UART problem.
//
// The fix here is general: model the two PLLs from their documented register
// layout (RP2040 datasheet section 2.18), then resolve clk_ref, clk_sys and
// clk_peri from the CLOCKS block's own MUX and divider fields (section 2.15)
// whenever the firmware writes to either. Nothing is special-cased to a
// particular baud rate, a particular clock frequency or a particular sketch:
// change the PLL configuration in the firmware and the reported rate follows.

/** Peripheral map keys, which rp2040js derives as (address >>> 14) << 2. */
const KEY_CLOCKS = 0x40008;
const KEY_PLL_SYS = 0x40028;
const KEY_PLL_USB = 0x4002c;

// CLOCKS register offsets used here.
const CLK_REF_CTRL = 0x30;
const CLK_REF_DIV = 0x34;
const CLK_SYS_CTRL = 0x3c;
const CLK_SYS_DIV = 0x40;
const CLK_PERI_CTRL = 0x48;

// PLL register offsets (datasheet section 2.18.4).
const PLL_CS = 0x00;
const PLL_PWR = 0x04;
const PLL_FBDIV_INT = 0x08;
const PLL_PRIM = 0x0c;

const PLL_CS_LOCK = 1 << 31;
const PLL_CS_BYPASS = 1 << 8;
const PLL_CS_REFDIV_MASK = 0x3f;
const PLL_PWR_PD = 1 << 0;
const PLL_PWR_VCOPD = 1 << 5;
const PLL_PWR_POSTDIVPD = 1 << 3;

/** The ring oscillator's nominal frequency at reset. It is not trimmed here. */
const ROSC_HZ = 6.5e6;

/** Minimal structural view of the parts of rp2040js this module touches. */
interface ClockHost {
  clkSys: number;
  clkPeri: number;
  peripherals: Record<number, { readUint32(offset: number): number; writeUint32(offset: number, value: number): void; writeUint32Atomic(offset: number, value: number, type: number): void }>;
}

/**
 * One RP2040 PLL.
 *
 * The output is `(reference / REFDIV) * FBDIV / (POSTDIV1 * POSTDIV2)`, which
 * is the relationship the datasheet gives. LOCK is reported immediately: there
 * is no VCO to settle, and firmware spins waiting for the bit.
 */
export class Rp2040Pll {
  private cs = 0x00000001; // REFDIV = 1 at reset
  private pwr = PLL_PWR_PD | PLL_PWR_VCOPD | PLL_PWR_POSTDIVPD;
  private fbdiv = 0;
  private prim = 0x00070000; // POSTDIV1 = 7, POSTDIV2 = 0 at reset

  constructor(
    readonly name: string,
    private readonly referenceHz: () => number,
    private readonly onChange: () => void,
  ) {}

  readUint32(offset: number): number {
    switch (offset) {
      // The PLL locks as soon as it is powered and configured. Firmware polls
      // this bit and would otherwise spin for ever.
      case PLL_CS:
        return this.locked ? this.cs | PLL_CS_LOCK : this.cs & ~PLL_CS_LOCK;
      case PLL_PWR:
        return this.pwr;
      case PLL_FBDIV_INT:
        return this.fbdiv;
      case PLL_PRIM:
        return this.prim;
      default:
        return 0;
    }
  }

  writeUint32(offset: number, value: number): void {
    switch (offset) {
      case PLL_CS:
        this.cs = value >>> 0;
        break;
      case PLL_PWR:
        this.pwr = value >>> 0;
        break;
      case PLL_FBDIV_INT:
        this.fbdiv = value & 0xfff;
        break;
      case PLL_PRIM:
        this.prim = value >>> 0;
        break;
      default:
        return;
    }
    this.onChange();
  }

  /** Atomic set/clear/xor aliases, which the SDK uses for these registers. */
  writeUint32Atomic(offset: number, value: number, atomicType: number): void {
    const current = this.rawRegister(offset);
    const next =
      atomicType === 1 ? current ^ value : atomicType === 2 ? current | value : atomicType === 3 ? current & ~value : value;
    this.writeUint32(offset, next >>> 0);
  }

  private rawRegister(offset: number): number {
    switch (offset) {
      case PLL_CS:
        return this.cs;
      case PLL_PWR:
        return this.pwr;
      case PLL_FBDIV_INT:
        return this.fbdiv;
      case PLL_PRIM:
        return this.prim;
      default:
        return 0;
    }
  }

  private get locked(): boolean {
    return (this.pwr & (PLL_PWR_PD | PLL_PWR_VCOPD)) === 0 && this.fbdiv >= 16;
  }

  get refdiv(): number {
    return Math.max(1, this.cs & PLL_CS_REFDIV_MASK);
  }

  get postdiv1(): number {
    return (this.prim >>> 16) & 0x7;
  }

  get postdiv2(): number {
    return (this.prim >>> 12) & 0x7;
  }

  /** Output frequency in Hz, or 0 when the PLL is powered down or unlocked. */
  get frequencyHz(): number {
    if (this.cs & PLL_CS_BYPASS) return this.referenceHz();
    if (!this.locked) return 0;
    if (this.pwr & PLL_PWR_POSTDIVPD) return 0;
    const post = this.postdiv1 * this.postdiv2;
    if (post === 0) return 0;
    return (this.referenceHz() / this.refdiv) * this.fbdiv / post;
  }
}

export interface ClockTreeOptions {
  /** Crystal frequency in Hz. 12 MHz on every Raspberry Pi Pico. */
  xoscHz?: number;
}

/**
 * Installs the PLLs and keeps `clkSys` / `clkPeri` in step with the firmware's
 * own clock configuration.
 *
 * Returns a handle so callers can read the resolved frequencies — the UART's
 * reported baud rate is derived from clk_peri, so tests assert against it.
 */
export class Rp2040ClockTree {
  readonly pllSys: Rp2040Pll;
  readonly pllUsb: Rp2040Pll;
  private readonly xoscHz: number;
  private readonly clocks: ClockHost['peripherals'][number];

  constructor(
    private readonly rp: ClockHost,
    options: ClockTreeOptions = {},
  ) {
    this.xoscHz = options.xoscHz ?? 12e6;
    const resolve = () => this.resolve();
    this.pllSys = new Rp2040Pll('pll_sys', () => this.xoscHz, resolve);
    this.pllUsb = new Rp2040Pll('pll_usb', () => this.xoscHz, resolve);
    rp.peripherals[KEY_PLL_SYS] = this.pllSys;
    rp.peripherals[KEY_PLL_USB] = this.pllUsb;

    // Wrap the CLOCKS block so its register state stays rp2040js's, while a
    // write to any of it re-derives the frequencies we care about.
    this.clocks = rp.peripherals[KEY_CLOCKS];
    const inner = this.clocks;
    rp.peripherals[KEY_CLOCKS] = {
      readUint32: (offset) => inner.readUint32(offset),
      writeUint32: (offset, value) => {
        inner.writeUint32(offset, value);
        resolve();
      },
      writeUint32Atomic: (offset, value, type) => {
        inner.writeUint32Atomic(offset, value, type);
        resolve();
      },
    };
    this.resolve();
  }

  /** clk_ref, after its MUX and integer divider. */
  get refHz(): number {
    const ctrl = this.clocks.readUint32(CLK_REF_CTRL);
    const src = ctrl & 0x3;
    const aux = (ctrl >>> 5) & 0x3;
    const base = src === 0 ? ROSC_HZ : src === 1 ? this.auxRef(aux) : src === 2 ? this.xoscHz : ROSC_HZ;
    const div = Math.max(1, (this.clocks.readUint32(CLK_REF_DIV) >>> 8) & 0x3);
    return base / div;
  }

  private auxRef(aux: number): number {
    // 0 = clksrc_pll_usb, 1 and 2 = GPIN, which nothing on a Pico drives.
    return aux === 0 ? this.pllUsb.frequencyHz : 0;
  }

  /** clk_sys, after its glitchless MUX, aux MUX and fractional divider. */
  get sysHz(): number {
    const ctrl = this.clocks.readUint32(CLK_SYS_CTRL);
    const glitchless = ctrl & 0x1;
    const aux = (ctrl >>> 5) & 0x7;
    const source = glitchless === 0 ? this.refHz : this.sysAux(aux);
    const divReg = this.clocks.readUint32(CLK_SYS_DIV) >>> 0;
    // CLK_SYS_DIV is 24.8 fixed point; an integer part of 0 means divide by 2^16.
    const int = divReg >>> 8;
    const frac = divReg & 0xff;
    const divisor = int === 0 ? 65536 : int + frac / 256;
    return source / divisor;
  }

  private sysAux(aux: number): number {
    switch (aux) {
      case 0:
        return this.pllSys.frequencyHz;
      case 1:
        return this.pllUsb.frequencyHz;
      case 2:
        return ROSC_HZ;
      case 3:
        return this.xoscHz;
      default:
        return 0; // GPIN sources, which a Pico does not drive
    }
  }

  /** clk_peri. It has an aux MUX and an enable, but no divider. */
  get periHz(): number {
    const ctrl = this.clocks.readUint32(CLK_PERI_CTRL);
    if ((ctrl & (1 << 11)) === 0) return 0; // not enabled
    switch ((ctrl >>> 5) & 0x7) {
      case 0:
        return this.sysHz;
      case 1:
        return this.pllSys.frequencyHz;
      case 2:
        return this.pllUsb.frequencyHz;
      case 3:
        return ROSC_HZ;
      case 4:
        return this.xoscHz;
      default:
        return 0; // GPIN sources
    }
  }

  /**
   * Publishes the resolved frequencies onto the machine.
   *
   * A frequency of zero means the firmware has not finished configuring that
   * branch yet. Writing it through would make the UART report a division by
   * zero and the PWM stop, so the previous value is kept until the tree is
   * genuinely running.
   */
  resolve(): void {
    const sys = this.sysHz;
    if (sys > 0 && Number.isFinite(sys)) this.rp.clkSys = sys;
    const peri = this.periHz;
    if (peri > 0 && Number.isFinite(peri)) this.rp.clkPeri = peri;
  }
}
