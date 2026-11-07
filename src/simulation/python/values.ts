// Python values for CircuitDesk's Raspberry Pi runtime.
//
// int is a JavaScript bigint (so 7 // 2, 2 ** 70 and -7 % 3 behave as Python
// says), float a number, bool a boolean, None null and str a string. The rest
// are the small classes below.

export type PyValue = null | boolean | bigint | number | string | PyObject;

/** What a blocking builtin or a statement boundary hands the scheduler. */
export type Wait =
  | { k: 'tick'; us: number }
  | { k: 'sleep'; ms: number }
  | { k: 'until'; ready: () => boolean; timeoutMs?: number };

export type Run<T> = Generator<Wait, T, unknown>;

export abstract class PyObject {
  abstract readonly typeName: string;
}

export class PyList extends PyObject {
  readonly typeName = 'list';
  constructor(public items: PyValue[]) {
    super();
  }
}

export class PyTuple extends PyObject {
  readonly typeName = 'tuple';
  constructor(readonly items: PyValue[]) {
    super();
  }
}

/** A dict, keyed by a value's identity for objects and its value otherwise. */
export class PyDict extends PyObject {
  readonly typeName = 'dict';
  readonly map = new Map<unknown, [PyValue, PyValue]>();

  static keyOf(v: PyValue): unknown {
    if (typeof v === 'bigint') return `i${v}`;
    if (typeof v === 'boolean') return `i${v ? 1 : 0}`;
    if (typeof v === 'number') return Number.isInteger(v) ? `i${v}` : `f${v}`;
    if (typeof v === 'string') return `s${v}`;
    if (v === null) return 'None';
    if (v instanceof PyTuple) return `t(${v.items.map((x) => String(PyDict.keyOf(x))).join(',')})`;
    return v;
  }

  get(k: PyValue): PyValue | undefined {
    return this.map.get(PyDict.keyOf(k))?.[1];
  }

  set(k: PyValue, v: PyValue): void {
    this.map.set(PyDict.keyOf(k), [k, v]);
  }

  has(k: PyValue): boolean {
    return this.map.has(PyDict.keyOf(k));
  }

  delete(k: PyValue): boolean {
    return this.map.delete(PyDict.keyOf(k));
  }

  keys(): PyValue[] {
    return [...this.map.values()].map((e) => e[0]);
  }
}

export class PySet extends PyObject {
  readonly typeName = 'set';
  readonly d = new PyDict();
  constructor(items: PyValue[] = []) {
    super();
    for (const i of items) this.d.set(i, null);
  }
}

export class PyRange extends PyObject {
  readonly typeName = 'range';
  constructor(
    readonly start: bigint,
    readonly stop: bigint,
    readonly step: bigint,
  ) {
    super();
  }

  get length(): number {
    const n = this.step > 0n ? (this.stop - this.start + this.step - 1n) / this.step : (this.start - this.stop - this.step - 1n) / -this.step;
    return n > 0n ? Number(n) : 0;
  }
}

export class PySlice extends PyObject {
  readonly typeName = 'slice';
  constructor(
    readonly lo: PyValue,
    readonly hi: PyValue,
    readonly step: PyValue,
  ) {
    super();
  }
}

/** A JavaScript iterator seen from Python (an iterator object). */
export class PyIter extends PyObject {
  readonly typeName = 'iterator';
  constructor(readonly it: Iterator<PyValue>) {
    super();
  }
}

export interface CallArgs {
  args: PyValue[];
  kwargs: Map<string, PyValue>;
}

/** A function implemented natively. Blocking ones return a Run. */
export class PyBuiltin extends PyObject {
  readonly typeName = 'builtin_function_or_method';
  constructor(
    readonly name: string,
    readonly fn: (a: CallArgs, self?: PyValue) => PyValue | Run<PyValue>,
    readonly blocking = false,
  ) {
    super();
  }
}

/** A native property on a class: a getter and, optionally, a setter. */
export class PyProperty extends PyObject {
  readonly typeName = 'property';
  constructor(
    readonly get: (self: PyValue) => PyValue | Run<PyValue>,
    readonly set?: (self: PyValue, v: PyValue) => void | Run<void>,
  ) {
    super();
  }
}

export class PyClass extends PyObject {
  readonly typeName = 'type';
  readonly dict = new Map<string, PyValue>();
  readonly mro: PyClass[];
  constructor(
    readonly name: string,
    readonly bases: PyClass[],
    /** For builtin types: is this value an instance of it? */
    readonly check?: (v: PyValue) => boolean,
  ) {
    super();
    const mro: PyClass[] = [this];
    for (const b of bases) for (const c of b.mro) if (!mro.includes(c)) mro.push(c);
    this.mro = mro;
  }

  lookup(name: string): PyValue | undefined {
    for (const c of this.mro) if (c.dict.has(name)) return c.dict.get(name);
    return undefined;
  }

  isSubclassOf(other: PyClass): boolean {
    return this.mro.includes(other);
  }
}

export class PyInstance extends PyObject {
  readonly dict = new Map<string, PyValue>();
  /** Native state of builtin-backed instances (a gpiozero LED's pin, say). */
  native: Record<string, unknown> = {};
  constructor(readonly cls: PyClass) {
    super();
  }
  get typeName(): string {
    return this.cls.name;
  }
}

export class PyModule extends PyObject {
  readonly typeName = 'module';
  readonly dict = new Map<string, PyValue>();
  constructor(readonly name: string) {
    super();
  }
}

export class PyBound extends PyObject {
  readonly typeName = 'method';
  constructor(
    readonly self: PyValue,
    readonly fn: PyValue,
  ) {
    super();
  }
}

/** A Python exception travelling through the interpreter. */
export class PyError extends Error {
  constructor(
    readonly exc: PyInstance,
    public line?: number,
  ) {
    super(String(exc.dict.get('__msg__') ?? exc.cls.name));
  }
}
