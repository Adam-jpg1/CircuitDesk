// Pad-level pull resistor resolution for the RP2040.
//
// WHY THIS EXISTS
//
// rp2040js models a GPIO's input level as `rawInputValue && inputEnable`,
// where `rawInputValue` is whatever an external driver last asserted. It
// starts false and the pad's pull-up/pull-down configuration never feeds into
// it. That is fine for a pin something is wired to, but it is wrong for an
// undriven pad: on silicon a pad with no external driver settles to whichever
// pull resistor the PADS_BANK0 register has enabled.
//
// The practical consequence is that `pinMode(pin, INPUT_PULLUP)` followed by
// `digitalRead(pin)` returns LOW in the unmodified engine and HIGH on real
// hardware — the two most common button wirings read inverted. Every sketch
// that polls a button against an internal pull-up would behave backwards.
//
// This resolver closes that gap by modelling the pad the way the datasheet
// describes it (section 2.19.4, "Pads"): the input buffer sees whatever is
// holding the pad, which is the external driver if there is one, the pad's
// own output driver if it is enabled, and otherwise the enabled pull
// resistor. Nothing here fakes a value the hardware would not produce — a
// floating pad with both pulls disabled is deliberately left alone, because
// its level genuinely is indeterminate.

/** The subset of rp2040js's GPIOPin this resolver needs. */
export interface PadPin {
  readonly pullupEnabled: boolean;
  readonly pulldownEnabled: boolean;
  readonly inputEnable: boolean;
  readonly outputEnable: boolean;
  readonly outputValue: boolean;
  setInputValue(value: boolean): void;
  addListener(callback: (state: number, previous: number) => void): () => boolean;
}

/** What is holding a pad, in the order silicon resolves it. */
export type PadSource = 'external' | 'self' | 'pullup' | 'pulldown' | 'bus-keeper' | 'floating';

export interface PadLevel {
  source: PadSource;
  /** Null when the pad is left as it was, because nothing determines it. */
  level: boolean | null;
}

/**
 * Keeps every undriven RP2040 pad at the level its configured pull resistor
 * would hold it at.
 *
 * Attach it once to a machine's `gpio` array. It re-evaluates a pad whenever
 * the firmware changes that pad's configuration, so a `pinMode()` call takes
 * effect immediately without polling.
 */
export class PadPullResolver {
  /** Pins an external circuit is actively driving, and to what level. */
  private readonly external = new Map<number, boolean>();
  private settling = false;

  constructor(private readonly pins: readonly PadPin[]) {
    this.pins.forEach((pin, index) => {
      pin.addListener(() => this.settle(index));
    });
    this.refresh();
  }

  /**
   * Declares that something outside the chip is holding a pad — a wire to a
   * rail, another device's output, or a test harness standing in for a button.
   * Pass null to disconnect it again.
   */
  drive(index: number, level: boolean | null): void {
    if (level === null) this.external.delete(index);
    else this.external.set(index, level);
    this.settle(index);
  }

  /** Disconnects every external driver. */
  releaseAll(): void {
    const driven = [...this.external.keys()];
    this.external.clear();
    for (const index of driven) this.settle(index);
  }

  /** Re-evaluates every pad. */
  refresh(): void {
    for (let i = 0; i < this.pins.length; i++) this.settle(i);
  }

  /** What is holding a pad, without changing it — useful in diagnostics. */
  resolve(index: number): PadLevel {
    const pin = this.pins[index];
    if (this.external.has(index)) return { source: 'external', level: this.external.get(index)! };
    // A pad that is driving reads back its own output.
    if (pin.outputEnable) return { source: 'self', level: pin.outputValue };
    // Both pulls enabled is the datasheet's bus-keeper mode: the pad holds
    // whatever level it was last at, so there is nothing to impose.
    if (pin.pullupEnabled && pin.pulldownEnabled) return { source: 'bus-keeper', level: null };
    if (pin.pullupEnabled) return { source: 'pullup', level: true };
    if (pin.pulldownEnabled) return { source: 'pulldown', level: false };
    return { source: 'floating', level: null };
  }

  private settle(index: number): void {
    // setInputValue notifies listeners, which land back here; one level of
    // re-entrancy is all this needs to avoid.
    if (this.settling) return;
    const { level } = this.resolve(index);
    if (level === null) return;
    this.settling = true;
    try {
      this.pins[index].setInputValue(level);
    } finally {
      this.settling = false;
    }
  }
}
