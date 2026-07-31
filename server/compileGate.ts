/**
 * Serialises compiler runs and bounds how many callers may wait.
 *
 * COMPILE_JOBS limits parallelism *inside* one arduino-cli run; it says
 * nothing about two API requests arriving together. On a 512 MB instance a
 * single RP2040 build already peaks around 300 MB, so two concurrent builds
 * would exhaust the container. One build runs at a time, a short queue absorbs
 * bursts, and anything beyond that is refused immediately with a clear status
 * rather than piling up until the process dies.
 *
 * The slot is released in a `finally`, so it comes back on success, on
 * compiler failure, and on timeout alike — a build that throws can never strand
 * the queue.
 */
export class CompilerBusyError extends Error {
  readonly retryAfterSeconds: number;
  constructor(waiting: number, retryAfterSeconds: number) {
    super(
      `The compiler is busy: one build is running and ${waiting} more are already queued. ` +
        'Try again in a few seconds.',
    );
    this.name = 'CompilerBusyError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class CompileGate {
  private tail: Promise<unknown> = Promise.resolve();
  private waiting = 0;
  private active = 0;

  constructor(
    /** How many callers may wait for the running build before we refuse. */
    private readonly maxQueued = Math.max(0, Number(process.env.COMPILE_QUEUE_MAX ?? '2') || 0),
    private readonly retryAfterSeconds = 5,
  ) {}

  get stats(): { active: number; waiting: number; maxQueued: number } {
    return { active: this.active, waiting: this.waiting, maxQueued: this.maxQueued };
  }

  /** Runs `fn` once the compiler is free. Throws CompilerBusyError when full. */
  run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.waiting >= this.maxQueued && this.active > 0) {
      throw new CompilerBusyError(this.waiting, this.retryAfterSeconds);
    }
    this.waiting++;
    const start = async (): Promise<T> => {
      this.waiting--;
      this.active++;
      try {
        return await fn();
      } finally {
        this.active--;
      }
    };
    const next = this.tail.then(start, start);
    // The chain must survive a rejected build, otherwise every later caller
    // would inherit that rejection instead of getting its turn.
    this.tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}
