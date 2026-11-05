// The vocabulary for firmware routines a machine provides natively.
//
// Some of what a simulated chip needs is not hardware but a closed-source
// library linked into the firmware — Espressif's Wi-Fi driver — whose entry
// points the machine answers itself. Most answers are a value; some must call
// back into the firmware (post an event, allocate a buffer), which a handler
// does by returning a GuestRoutine: a generator that yields each call and
// receives its result. Each machine runs those through its own calling
// convention; the handlers are written once.

/** A call into the firmware: a function address and its arguments. */
export interface GuestCall {
  fn: number;
  args: number[];
}

/** A native routine that calls into the firmware as it goes; its return value is the routine's. */
export type GuestRoutine = Generator<GuestCall, number | void, number>;

/** A firmware routine provided natively: its arguments, and the calling core. */
export type FirmwareHandler = (args: number[], core: number) => number | void | GuestRoutine;

/** What a machine offers the models of closed firmware libraries. */
export interface FirmwareHost {
  read8(a: number): number;
  read32(a: number): number;
  write8(a: number, v: number): void;
  write32(a: number, v: number): void;
  readonly nanos: number;
  /** Answers the firmware routine at `address` natively; false if no loaded code is there. */
  provideFirmwareRoutine(address: number, name: string, handler: FirmwareHandler): boolean;
  /** Creates nothing by itself: the round of work a firmware task created at glueTaskEntry runs. */
  provideTask(round: () => GuestRoutine): void;
  /** A function address a FreeRTOS task can start at to run provideTask's rounds, and a name for it. */
  readonly glueTaskEntry: number | undefined;
  readonly glueTaskName: number | undefined;
  fault: string | null;
}

export function call(fn: number, ...args: number[]): GuestCall {
  return { fn, args };
}
