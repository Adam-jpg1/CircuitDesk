// A tree-walking interpreter for the Python subset in parser.ts.
//
// Every evaluation is a generator, so anything that waits — time.sleep(), a
// GPIO edge, input() — suspends the script on simulated time and the board
// runner resumes it when that time comes. Each statement also costs a little
// simulated time (STATEMENT_US), so a loop that never sleeps still lets the
// clock move instead of freezing the canvas, as a real Pi's CPU would.
//
// The interpreter only ever runs the parsed tree: there is no eval, no exec,
// no access to JavaScript objects, and the only modules are the ones the
// runtime defines.

import { parse, type Expr, type Param, type Stmt } from './parser';
import { PySyntaxError } from './lexer';
import {
  PyBound, PyBuiltin, PyClass, PyDict, PyError, PyInstance, PyIter, PyList, PyModule, PyObject, PyProperty, PyRange, PySet, PySlice, PyTuple,
  type CallArgs, type PyValue, type Run, type Wait,
} from './values';

/** Simulated cost of one statement: CPython on a Pi runs a few hundred thousand simple statements a second. */
export const STATEMENT_US = 2;
const TICK_EVERY = 64;
const MAX_DEPTH = 200;

type Completion = { k: 'break' } | { k: 'continue' } | { k: 'return'; v: PyValue } | undefined;

/**
 * x to `nd` decimals as Python does it: from the double's exact value, with
 * an exact tie going to the even digit (toFixed alone rounds ties up).
 */
export function fixedHalfEven(x: number, nd: number): string {
  if (!Number.isFinite(x)) return String(x);
  const neg = x < 0 || Object.is(x, -0);
  const exact = Math.abs(x).toFixed(Math.min(100, nd + 40));
  const [ip, fp = ''] = exact.split('.');
  const keep = fp.slice(0, nd);
  const rest = fp.slice(nd);
  let digits = ip + keep;
  const first = rest[0] ?? '0';
  const tail = rest.slice(1);
  const up = first > '5' || (first === '5' && (/[1-9]/.test(tail) || Number(digits[digits.length - 1] ?? '0') % 2 === 1));
  if (up) {
    const arr = digits.split('').map(Number);
    let i = arr.length - 1;
    while (i >= 0) {
      if (arr[i] === 9) {
        arr[i] = 0;
        i--;
      } else {
        arr[i]++;
        break;
      }
    }
    if (i < 0) arr.unshift(1);
    digits = arr.join('');
  }
  const intLen = digits.length - nd;
  const out = nd > 0 ? `${digits.slice(0, intLen)}.${digits.slice(intLen)}` : digits;
  return (neg && /[1-9]/.test(out) ? '-' : neg ? '-' : '') + out;
}

export class PyFunction extends PyObject {
  readonly typeName = 'function';
  constructor(
    readonly name: string,
    readonly params: Param[],
    readonly defaults: (PyValue | undefined)[],
    readonly body: Stmt[] | Expr,
    readonly closure: Scope,
    readonly cls?: PyClass,
  ) {
    super();
  }
}

export class Scope {
  readonly vars = new Map<string, PyValue>();
  readonly globalNames = new Set<string>();
  readonly nonlocalNames = new Set<string>();
  constructor(
    readonly globals: Map<string, PyValue>,
    readonly parent?: Scope,
    /** The class a method belongs to and its self, for super(). */
    readonly method?: { cls: PyClass; self: PyValue },
  ) {}
}

export interface InterpreterHost {
  /** print() output. */
  write(text: string): void;
  /** A line typed into the monitor, if one has arrived. */
  readLine(): string | undefined;
  /** Modules beyond the standard ones (RPi.GPIO, gpiozero, ...), made on first import. */
  module(name: string, py: Interpreter): PyModule | undefined;
  /** Simulated time, for time.time() and friends. */
  nowMs(): number;
}

export class Interpreter {
  readonly builtins = new Map<string, PyValue>();
  readonly exc = new Map<string, PyClass>();
  readonly types = new Map<string, PyClass>();
  private readonly modules = new Map<string, PyModule>();
  private steps = 0;
  private depth = 0;
  readonly globals = new Map<string, PyValue>();
  /** The line being executed, for tracebacks. */
  line = 0;
  private rng = 0x2545f491;

  constructor(readonly host: InterpreterHost) {
    this.setupTypes();
    this.setupExceptions();
    this.setupBuiltins();
    this.globals.set('__name__', '__main__');
  }

  static check(source: string): PySyntaxError | null {
    try {
      parse(source);
      return null;
    } catch (e) {
      if (e instanceof PySyntaxError) return e;
      throw e;
    }
  }

  *runModule(source: string): Run<void> {
    const tree = parse(source);
    const scope = new Scope(this.globals);
    for (const s of tree) {
      const c = yield* this.exec(s, scope);
      if (c) break;
    }
  }

  // ------------------------------------------------------------- errors

  makeExc(name: string, msg = ''): PyInstance {
    const cls = this.exc.get(name) ?? this.exc.get('Exception')!;
    const inst = new PyInstance(cls);
    inst.dict.set('args', new PyTuple(msg ? [msg] : []));
    inst.dict.set('__msg__', msg);
    return inst;
  }

  error(name: string, msg = ''): PyError {
    return new PyError(this.makeExc(name, msg), this.line);
  }

  /** "NameError: name 'x' is not defined", as a traceback's last line says it. */
  describe(e: PyError): string {
    const msg = String(e.exc.dict.get('__msg__') ?? '');
    return msg ? `${e.exc.cls.name}: ${msg}` : e.exc.cls.name;
  }

  // ---------------------------------------------------------- execution

  private *tick(): Run<void> {
    if (++this.steps % TICK_EVERY === 0) yield { k: 'tick', us: TICK_EVERY * STATEMENT_US };
  }

  private *execBlock(body: Stmt[], scope: Scope): Run<Completion> {
    for (const s of body) {
      const c = yield* this.exec(s, scope);
      if (c) return c;
    }
    return undefined;
  }

  *exec(s: Stmt, scope: Scope): Run<Completion> {
    this.line = s.line;
    yield* this.tick();
    switch (s.k) {
      case 'expr':
        yield* this.eval(s.e, scope);
        return;
      case 'assign': {
        const v = yield* this.eval(s.value, scope);
        for (const t of s.targets) yield* this.assign(t, v, scope);
        return;
      }
      case 'augassign': {
        const cur = yield* this.eval(s.target, scope);
        const rhs = yield* this.eval(s.value, scope);
        let v: PyValue;
        if (s.op === '+' && cur instanceof PyList) {
          for (const x of yield* this.iterate(rhs)) cur.items.push(x);
          v = cur;
        } else v = yield* this.binop(s.op, cur, rhs);
        this.line = s.line;
        yield* this.assign(s.target, v, scope);
        return;
      }
      case 'if': {
        const t = yield* this.eval(s.test, scope);
        return yield* this.execBlock(this.truthy(t) ? s.body : s.orelse, scope);
      }
      case 'while': {
        while (true) {
          this.line = s.line;
          const t = yield* this.eval(s.test, scope);
          if (!this.truthy(t)) return yield* this.execBlock(s.orelse, scope);
          const c = yield* this.execBlock(s.body, scope);
          if (c?.k === 'break') return;
          if (c?.k === 'return') return c;
          yield* this.tick();
        }
      }
      case 'for': {
        const it = yield* this.iterate(yield* this.eval(s.iter, scope));
        for (const v of it) {
          yield* this.assign(s.target, v, scope);
          const c = yield* this.execBlock(s.body, scope);
          if (c?.k === 'break') return;
          if (c?.k === 'return') return c;
          yield* this.tick();
        }
        return yield* this.execBlock(s.orelse, scope);
      }
      case 'break':
      case 'continue':
        return { k: s.k };
      case 'pass':
        return;
      case 'return':
        return { k: 'return', v: s.value ? yield* this.eval(s.value, scope) : null };
      case 'def': {
        const defaults: (PyValue | undefined)[] = [];
        for (const p of s.params) defaults.push(p.def ? yield* this.eval(p.def, scope) : undefined);
        let f: PyValue = new PyFunction(s.name, s.params, defaults, s.body, scope, scope.method?.cls);
        for (const d of [...s.decorators].reverse()) f = yield* this.call(yield* this.eval(d, scope), [f]);
        this.store(s.name, f, scope);
        return;
      }
      case 'class': {
        const bases: PyClass[] = [];
        for (const b of s.bases) {
          const v = yield* this.eval(b, scope);
          if (!(v instanceof PyClass)) throw this.error('TypeError', 'bases must be classes');
          bases.push(v);
        }
        const cls = new PyClass(s.name, bases.length ? bases : [this.types.get('object')!]);
        const body = new Scope(scope.globals, scope);
        // Methods defined in the body know their class, for super().
        const classScope = new Scope(scope.globals, scope, { cls, self: null });
        for (const st of s.body) {
          const c = yield* this.exec(st, classScope);
          if (c) break;
        }
        void body;
        for (const [k, v] of classScope.vars) cls.dict.set(k, v);
        let out: PyValue = cls;
        for (const d of [...s.decorators].reverse()) out = yield* this.call(yield* this.eval(d, scope), [out]);
        this.store(s.name, out, scope);
        return;
      }
      case 'import':
        for (const [name, as] of s.names) {
          const mod = this.importModule(name);
          if (as) this.store(as, mod, scope);
          else {
            const top = name.split('.')[0];
            this.store(top, this.importModule(top), scope);
          }
        }
        return;
      case 'from': {
        const mod = this.importModule(s.module);
        if (s.names === '*') {
          for (const [k, v] of mod.dict) if (!k.startsWith('_')) this.store(k, v, scope);
        } else {
          for (const [name, as] of s.names) {
            let v = mod.dict.get(name);
            if (v === undefined) {
              const sub = this.tryImport(`${s.module}.${name}`);
              if (!sub) throw this.error('ImportError', `cannot import name '${name}' from '${s.module}'`);
              v = sub;
            }
            this.store(as ?? name, v, scope);
          }
        }
        return;
      }
      case 'global':
        for (const n of s.names) scope.globalNames.add(n);
        return;
      case 'nonlocal':
        for (const n of s.names) scope.nonlocalNames.add(n);
        return;
      case 'try':
        return yield* this.execTry(s, scope);
      case 'raise': {
        if (!s.exc) throw this.error('RuntimeError', 'No active exception to reraise');
        let v = yield* this.eval(s.exc, scope);
        if (v instanceof PyClass) v = yield* this.call(v, []);
        if (!(v instanceof PyInstance) || !v.cls.isSubclassOf(this.exc.get('BaseException')!)) {
          throw this.error('TypeError', 'exceptions must derive from BaseException');
        }
        throw new PyError(v, s.line);
      }
      case 'with': {
        const exits: PyValue[] = [];
        for (const item of s.items) {
          const ctx = yield* this.eval(item.ctx, scope);
          const entered = yield* this.callMethod(ctx, '__enter__', []);
          exits.push(ctx);
          if (item.as) yield* this.assign(item.as, entered, scope);
        }
        try {
          return yield* this.execBlock(s.body, scope);
        } finally {
          for (const ctx of exits.reverse()) yield* this.callMethod(ctx, '__exit__', [null, null, null]);
        }
      }
      case 'del':
        for (const t of s.targets) yield* this.del(t, scope);
        return;
      case 'assert': {
        const ok = yield* this.eval(s.test, scope);
        if (!this.truthy(ok)) throw this.error('AssertionError', s.msg ? this.str(yield* this.eval(s.msg, scope)) : '');
        return;
      }
    }
  }

  private *execTry(s: Extract<Stmt, { k: 'try' }>, scope: Scope): Run<Completion> {
    let result: Completion;
    try {
      try {
        result = yield* this.execBlock(s.body, scope);
      } catch (e) {
        if (!(e instanceof PyError)) throw e;
        for (const h of s.handlers) {
          let match = !h.type;
          if (h.type) {
            const t = yield* this.eval(h.type, scope);
            const types = t instanceof PyTuple ? t.items : [t];
            match = types.some((x) => x instanceof PyClass && e.exc.cls.isSubclassOf(x));
          }
          if (match) {
            if (h.name) this.store(h.name, e.exc, scope);
            return yield* this.execBlock(h.body, scope);
          }
        }
        throw e;
      }
      if (!result) result = yield* this.execBlock(s.orelse, scope);
      return result;
    } finally {
      if (s.final.length) {
        const c = yield* this.execBlock(s.final, scope);
        // A return in finally wins, as in Python.
        if (c) return c;
      }
    }
  }

  // ------------------------------------------------------------- names

  private store(name: string, v: PyValue, scope: Scope): void {
    if (scope.globalNames.has(name)) {
      scope.globals.set(name, v);
      return;
    }
    if (scope.nonlocalNames.has(name)) {
      for (let s = scope.parent; s; s = s.parent) {
        if (s.vars.has(name)) {
          s.vars.set(name, v);
          return;
        }
      }
    }
    if (!scope.parent && !scope.method) scope.globals.set(name, v);
    else scope.vars.set(name, v);
  }

  private lookup(name: string, scope: Scope): PyValue {
    if (!scope.globalNames.has(name)) {
      for (let s: Scope | undefined = scope; s; s = s.parent) {
        if (!s.parent && !s.method) break; // module level: the globals
        if (s.vars.has(name)) return s.vars.get(name)!;
      }
    }
    if (scope.globals.has(name)) return scope.globals.get(name)!;
    if (this.builtins.has(name)) return this.builtins.get(name)!;
    throw this.error('NameError', `name '${name}' is not defined`);
  }

  private *assign(t: Expr, v: PyValue, scope: Scope): Run<void> {
    switch (t.k) {
      case 'name':
        this.store(t.id, v, scope);
        return;
      case 'attr':
        yield* this.setattr(yield* this.eval(t.obj, scope), t.name, v);
        return;
      case 'sub':
        yield* this.setitem(yield* this.eval(t.obj, scope), yield* this.evalIndex(t.index, scope), v);
        return;
      case 'tuple':
      case 'list': {
        const items = [...(yield* this.iterate(v))];
        const star = t.elts.findIndex((e) => e.k === 'star');
        if (star < 0) {
          if (items.length !== t.elts.length) {
            throw this.error('ValueError', items.length > t.elts.length ? `too many values to unpack (expected ${t.elts.length})` : `not enough values to unpack (expected ${t.elts.length}, got ${items.length})`);
          }
          for (let i = 0; i < items.length; i++) yield* this.assign(t.elts[i], items[i], scope);
        } else {
          const after = t.elts.length - star - 1;
          for (let i = 0; i < star; i++) yield* this.assign(t.elts[i], items[i], scope);
          yield* this.assign((t.elts[star] as Extract<Expr, { k: 'star' }>).e, new PyList(items.slice(star, items.length - after)), scope);
          for (let i = 0; i < after; i++) yield* this.assign(t.elts[star + 1 + i], items[items.length - after + i], scope);
        }
        return;
      }
      default:
        throw this.error('SyntaxError', 'cannot assign to expression');
    }
  }

  private *del(t: Expr, scope: Scope): Run<void> {
    if (t.k === 'name') {
      if (scope.vars.delete(t.id) || scope.globals.delete(t.id)) return;
      throw this.error('NameError', `name '${t.id}' is not defined`);
    }
    if (t.k === 'sub') {
      const obj = yield* this.eval(t.obj, scope);
      const key = yield* this.evalIndex(t.index, scope);
      if (obj instanceof PyList) {
        if (key instanceof PySlice) {
          const [lo, hi] = this.sliceBounds(key, obj.items.length);
          obj.items.splice(lo, Math.max(0, hi - lo));
        } else obj.items.splice(this.index(key, obj.items.length), 1);
      } else if (obj instanceof PyDict) {
        if (!obj.delete(key)) throw this.error('KeyError', this.repr(key));
      } else throw this.error('TypeError', `'${this.typeName(obj)}' object doesn't support item deletion`);
      return;
    }
    if (t.k === 'attr') {
      const obj = yield* this.eval(t.obj, scope);
      if (obj instanceof PyInstance) obj.dict.delete(t.name);
      return;
    }
    if (t.k === 'tuple') for (const e of t.elts) yield* this.del(e, scope);
  }

  // --------------------------------------------------------- expressions

  *eval(e: Expr, scope: Scope): Run<PyValue> {
    switch (e.k) {
      case 'num':
        return e.int ? BigInt(e.v) : e.v;
      case 'str':
        return e.v;
      case 'const':
        return e.v === 'None' ? null : e.v === 'True';
      case 'name':
        return this.lookup(e.id, scope);
      case 'fstr': {
        let out = '';
        for (const p of e.parts) {
          if (typeof p === 'string') out += p;
          else {
            let v = yield* this.eval(p.e, scope);
            if (p.conv === 'r') v = this.repr(v);
            else if (p.conv === 's') v = this.str(v);
            out += yield* this.format(v, p.spec.includes('{') ? yield* this.expandSpec(p.spec, scope) : p.spec);
          }
        }
        return out;
      }
      case 'attr':
        return yield* this.getattr(yield* this.eval(e.obj, scope), e.name);
      case 'call': {
        if (e.func.k === 'name' && e.func.id === 'super' && !e.args.length && !scope.vars.has('super')) return this.makeSuper(scope);
        const f = yield* this.eval(e.func, scope);
        const args: PyValue[] = [];
        const kwargs = new Map<string, PyValue>();
        for (const a of e.args) {
          const v = yield* this.eval(a.value, scope);
          if (a.kind === 'pos') args.push(v);
          else if (a.kind === 'kw') kwargs.set(a.name!, v);
          else if (a.kind === 'star') args.push(...(yield* this.iterate(v)));
          else if (v instanceof PyDict) for (const [k, val] of v.map.values()) kwargs.set(this.str(k), val);
        }
        this.line = e.line;
        return yield* this.call(f, args, kwargs);
      }
      case 'sub':
        return yield* this.getitem(yield* this.eval(e.obj, scope), yield* this.evalIndex(e.index, scope));
      case 'slice':
        return yield* this.evalIndex(e, scope);
      case 'bin': {
        const l = yield* this.eval(e.l, scope);
        const r = yield* this.eval(e.r, scope);
        this.line = e.line;
        return yield* this.binop(e.op, l, r);
      }
      case 'unary': {
        const v = yield* this.eval(e.e, scope);
        if (e.op === 'not') return !this.truthy(v);
        if (e.op === '-') {
          if (typeof v === 'bigint') return -v;
          if (typeof v === 'boolean') return -BigInt(v ? 1 : 0);
          if (typeof v === 'number') return -v;
        }
        if (e.op === '+' && (typeof v === 'bigint' || typeof v === 'number')) return v;
        if (e.op === '~' && (typeof v === 'bigint' || typeof v === 'boolean')) return ~this.toBig(v);
        throw this.error('TypeError', `bad operand type for unary ${e.op}: '${this.typeName(v)}'`);
      }
      case 'bool': {
        let v: PyValue = null;
        for (const x of e.values) {
          v = yield* this.eval(x, scope);
          if (e.op === 'and' ? !this.truthy(v) : this.truthy(v)) return v;
        }
        return v;
      }
      case 'compare': {
        let l = yield* this.eval(e.left, scope);
        for (let i = 0; i < e.ops.length; i++) {
          const r = yield* this.eval(e.rights[i], scope);
          if (!(yield* this.compare(e.ops[i], l, r))) return false;
          l = r;
        }
        return true;
      }
      case 'ifexp':
        return this.truthy(yield* this.eval(e.test, scope)) ? yield* this.eval(e.body, scope) : yield* this.eval(e.orelse, scope);
      case 'list':
      case 'tuple':
      case 'set': {
        const items: PyValue[] = [];
        for (const x of e.elts) {
          if (x.k === 'star') items.push(...(yield* this.iterate(yield* this.eval(x.e, scope))));
          else items.push(yield* this.eval(x, scope));
        }
        return e.k === 'list' ? new PyList(items) : e.k === 'tuple' ? new PyTuple(items) : new PySet(items);
      }
      case 'dict': {
        const d = new PyDict();
        for (let i = 0; i < e.keys.length; i++) d.set(yield* this.eval(e.keys[i], scope), yield* this.eval(e.values[i], scope));
        return d;
      }
      case 'lambda': {
        const defaults: (PyValue | undefined)[] = [];
        for (const p of e.params) defaults.push(p.def ? yield* this.eval(p.def, scope) : undefined);
        return new PyFunction('<lambda>', e.params, defaults, e.body, scope);
      }
      case 'comp':
        return yield* this.comprehension(e, scope);
      case 'star':
        throw this.error('SyntaxError', "can't use starred expression here");
    }
  }

  private *expandSpec(spec: string, scope: Scope): Run<string> {
    let out = '';
    const re = /\{([^}]*)\}/g;
    let last = 0;
    for (let m = re.exec(spec); m; m = re.exec(spec)) {
      out += spec.slice(last, m.index);
      const tree = parse(m[1]);
      out += this.str(yield* this.eval((tree[0] as Extract<Stmt, { k: 'expr' }>).e, scope));
      last = m.index + m[0].length;
    }
    return out + spec.slice(last);
  }

  private *comprehension(e: Extract<Expr, { k: 'comp' }>, scope: Scope): Run<PyValue> {
    const inner = new Scope(scope.globals, scope);
    const out: PyValue[] = [];
    const d = new PyDict();
    const self = this;
    function* level(i: number): Run<void> {
      if (i === e.gens.length) {
        if (e.kind === 'dict') d.set(yield* self.eval(e.elt, inner), yield* self.eval(e.value!, inner));
        else out.push(yield* self.eval(e.elt, inner));
        return;
      }
      const g = e.gens[i];
      for (const v of yield* self.iterate(yield* self.eval(g.iter, i === 0 ? scope : inner))) {
        yield* self.assign(g.target, v, inner);
        let ok = true;
        for (const c of g.ifs) if (!self.truthy(yield* self.eval(c, inner))) ok = false;
        if (ok) yield* level(i + 1);
        yield* self.tick();
      }
    }
    yield* level(0);
    if (e.kind === 'dict') return d;
    if (e.kind === 'set') return new PySet(out);
    if (e.kind === 'gen') return new PyIter(out[Symbol.iterator]());
    return new PyList(out);
  }

  private *evalIndex(e: Expr, scope: Scope): Run<PyValue> {
    if (e.k === 'slice') {
      return new PySlice(e.lo ? yield* this.eval(e.lo, scope) : null, e.hi ? yield* this.eval(e.hi, scope) : null, e.step ? yield* this.eval(e.step, scope) : null);
    }
    return yield* this.eval(e, scope);
  }

  // --------------------------------------------------------------- calls

  *call(f: PyValue, args: PyValue[], kwargs: Map<string, PyValue> = new Map()): Run<PyValue> {
    // A blocking builtin returns a Run when it has to wait, a value when not.
    if (f instanceof PyBuiltin) {
      const r = f.fn({ args, kwargs });
      return f.blocking ? yield* this.runMaybe(r) : (r as PyValue);
    }
    if (f instanceof PyBound) {
      if (f.fn instanceof PyBuiltin) {
        const r = f.fn.fn({ args, kwargs }, f.self);
        return f.fn.blocking ? yield* this.runMaybe(r) : (r as PyValue);
      }
      return yield* this.call(f.fn, [f.self, ...args], kwargs);
    }
    if (f instanceof PyFunction) return yield* this.callFunction(f, args, kwargs);
    if (f instanceof PyClass) {
      if (f.check) {
        // A builtin type used as a constructor: int("5"), list(x), ...
        const ctor = f.dict.get('__new__');
        if (ctor instanceof PyBuiltin) return yield* this.call(ctor, args, kwargs);
      }
      const inst = new PyInstance(f);
      if (f.isSubclassOf(this.exc.get('BaseException')!)) {
        inst.dict.set('args', new PyTuple(args));
        inst.dict.set('__msg__', args.length === 1 ? this.str(args[0]) : args.length ? this.repr(new PyTuple(args)) : '');
      }
      const init = f.lookup('__init__');
      if (init) {
        const r = yield* this.call(new PyBound(inst, init), args, kwargs);
        if (r !== null) throw this.error('TypeError', '__init__() should return None');
      }
      return inst;
    }
    if (f instanceof PyInstance) {
      const m = f.cls.lookup('__call__');
      if (m) return yield* this.call(new PyBound(f, m), args, kwargs);
    }
    throw this.error('TypeError', `'${this.typeName(f)}' object is not callable`);
  }

  *callMethod(obj: PyValue, name: string, args: PyValue[]): Run<PyValue> {
    return yield* this.call(yield* this.getattr(obj, name), args);
  }

  private *callFunction(f: PyFunction, args: PyValue[], kwargs: Map<string, PyValue>): Run<PyValue> {
    if (this.depth >= MAX_DEPTH) throw this.error('RecursionError', 'maximum recursion depth exceeded');
    const self = f.cls && args.length ? args[0] : null;
    const scope = new Scope(f.closure.globals, f.closure, f.cls ? { cls: f.cls, self } : undefined);
    let ai = 0;
    const extraKw = new PyDict();
    for (let i = 0; i < f.params.length; i++) {
      const p = f.params[i];
      if (p.kind === 'star') {
        scope.vars.set(p.name, new PyTuple(args.slice(ai)));
        ai = args.length;
      } else if (p.kind === 'dstar') {
        scope.vars.set(p.name, extraKw);
      } else if (ai < args.length) {
        if (kwargs.has(p.name)) throw this.error('TypeError', `${f.name}() got multiple values for argument '${p.name}'`);
        scope.vars.set(p.name, args[ai++]);
      } else if (kwargs.has(p.name)) {
        scope.vars.set(p.name, kwargs.get(p.name)!);
      } else if (f.defaults[i] !== undefined) {
        scope.vars.set(p.name, f.defaults[i]!);
      } else throw this.error('TypeError', `${f.name}() missing required positional argument: '${p.name}'`);
    }
    if (ai < args.length) throw this.error('TypeError', `${f.name}() takes ${f.params.filter((p) => p.kind === 'pos').length} positional arguments but ${args.length} were given`);
    const named = new Set(f.params.map((p) => p.name));
    for (const [k, v] of kwargs) {
      if (named.has(k)) continue;
      if (f.params.some((p) => p.kind === 'dstar')) extraKw.set(k, v);
      else throw this.error('TypeError', `${f.name}() got an unexpected keyword argument '${k}'`);
    }
    const line = this.line;
    this.depth++;
    try {
      if (!Array.isArray(f.body)) return yield* this.eval(f.body, scope);
      const c = yield* this.execBlock(f.body, scope);
      return c?.k === 'return' ? c.v : null;
    } finally {
      this.depth--;
      this.line = line;
    }
  }

  // ---------------------------------------------------------- attributes

  *getattr(obj: PyValue, name: string): Run<PyValue> {
    if (obj instanceof PyModule) {
      const v = obj.dict.get(name);
      if (v === undefined) throw this.error('AttributeError', `module '${obj.name}' has no attribute '${name}'`);
      return v;
    }
    if (obj instanceof PyInstance) {
      if (obj.cls.name === 'super' && typeof obj.native.lookup === 'function') {
        const v = (obj.native.lookup as (n: string) => PyValue | undefined)(name);
        if (v === undefined) throw this.error('AttributeError', `'super' object has no attribute '${name}'`);
        if (v instanceof PyProperty) return yield* this.runMaybe(v.get(obj.native.self as PyValue));
        return v instanceof PyFunction || v instanceof PyBuiltin ? new PyBound(obj.native.self as PyValue, v) : v;
      }
      if (obj.dict.has(name)) return obj.dict.get(name)!;
      const v = obj.cls.lookup(name);
      if (v instanceof PyProperty) return yield* this.runMaybe(v.get(obj));
      if (v instanceof PyFunction || v instanceof PyBuiltin) return new PyBound(obj, v);
      if (v !== undefined) return v;
      if (name === '__class__') return obj.cls;
      throw this.error('AttributeError', `'${obj.cls.name}' object has no attribute '${name}'`);
    }
    if (obj instanceof PyClass) {
      if (name === '__name__') return obj.name;
      const v = obj.lookup(name);
      if (v !== undefined) return v;
      throw this.error('AttributeError', `type object '${obj.name}' has no attribute '${name}'`);
    }
    // Methods of the builtin types.
    const cls = this.classOf(obj);
    const m = cls.lookup(name);
    if (m instanceof PyBuiltin) return new PyBound(obj, m);
    if (m instanceof PyProperty) return yield* this.runMaybe(m.get(obj));
    throw this.error('AttributeError', `'${this.typeName(obj)}' object has no attribute '${name}'`);
  }

  private *runMaybe<T>(r: T | Run<T>): Run<T> {
    if (r && typeof r === 'object' && typeof (r as Run<T>).next === 'function' && !(r instanceof PyObject)) return yield* r as Run<T>;
    return r as T;
  }

  *setattr(obj: PyValue, name: string, v: PyValue): Run<void> {
    if (obj instanceof PyInstance) {
      const p = obj.cls.lookup(name);
      if (p instanceof PyProperty) {
        if (!p.set) throw this.error('AttributeError', `can't set attribute '${name}'`);
        yield* this.runMaybe(p.set(obj, v));
        return;
      }
      obj.dict.set(name, v);
      return;
    }
    if (obj instanceof PyClass) {
      obj.dict.set(name, v);
      return;
    }
    if (obj instanceof PyModule) {
      obj.dict.set(name, v);
      return;
    }
    throw this.error('AttributeError', `'${this.typeName(obj)}' object attribute '${name}' is read-only`);
  }

  // --------------------------------------------------------- arithmetic

  toBig(v: PyValue): bigint {
    if (typeof v === 'bigint') return v;
    if (typeof v === 'boolean') return v ? 1n : 0n;
    throw this.error('TypeError', `'${this.typeName(v)}' object cannot be interpreted as an integer`);
  }

  toNum(v: PyValue): number {
    if (typeof v === 'number') return v;
    if (typeof v === 'bigint') return Number(v);
    if (typeof v === 'boolean') return v ? 1 : 0;
    throw this.error('TypeError', `must be real number, not ${this.typeName(v)}`);
  }

  isNumber(v: PyValue): v is bigint | number | boolean {
    return typeof v === 'bigint' || typeof v === 'number' || typeof v === 'boolean';
  }

  *binop(op: string, l: PyValue, r: PyValue): Run<PyValue> {
    if (this.isNumber(l) && this.isNumber(r)) {
      if (typeof l !== 'number' && typeof r !== 'number' && op !== '/') {
        const a = this.toBig(l);
        const b = this.toBig(r);
        switch (op) {
          case '+': return a + b;
          case '-': return a - b;
          case '*': return a * b;
          case '//': {
            if (b === 0n) throw this.error('ZeroDivisionError', 'integer division or modulo by zero');
            const q = a / b;
            return (a % b !== 0n && (a < 0n) !== (b < 0n)) ? q - 1n : q;
          }
          case '%': {
            if (b === 0n) throw this.error('ZeroDivisionError', 'integer division or modulo by zero');
            const m = a % b;
            return m !== 0n && (m < 0n) !== (b < 0n) ? m + b : m;
          }
          case '**':
            if (b < 0n) return Math.pow(Number(a), Number(b));
            return a ** b;
          case '&': return a & b;
          case '|': return a | b;
          case '^': return a ^ b;
          case '<<': return a << b;
          case '>>': return a >> b;
        }
      }
      const a = this.toNum(l);
      const b = this.toNum(r);
      switch (op) {
        case '+': return a + b;
        case '-': return a - b;
        case '*': return a * b;
        case '/':
          if (b === 0) throw this.error('ZeroDivisionError', 'division by zero');
          return a / b;
        case '//':
          if (b === 0) throw this.error('ZeroDivisionError', 'float floor division by zero');
          return Math.floor(a / b);
        case '%':
          if (b === 0) throw this.error('ZeroDivisionError', 'float modulo');
          return a - b * Math.floor(a / b);
        case '**': return Math.pow(a, b);
      }
    }
    if (op === '+') {
      if (typeof l === 'string' && typeof r === 'string') return l + r;
      if (l instanceof PyList && r instanceof PyList) return new PyList([...l.items, ...r.items]);
      if (l instanceof PyTuple && r instanceof PyTuple) return new PyTuple([...l.items, ...r.items]);
    }
    if (op === '*') {
      const rep = (s: PyValue, n: PyValue) => {
        const k = Math.max(0, Number(this.toBig(n)));
        if (typeof s === 'string') return s.repeat(k);
        if (s instanceof PyList) return new PyList(Array.from({ length: k }, () => s.items).flat());
        if (s instanceof PyTuple) return new PyTuple(Array.from({ length: k }, () => s.items).flat());
        return undefined;
      };
      if (typeof r === 'bigint' || typeof r === 'boolean') {
        const v = rep(l, r);
        if (v !== undefined) return v;
      }
      if (typeof l === 'bigint' || typeof l === 'boolean') {
        const v = rep(r, l);
        if (v !== undefined) return v;
      }
    }
    if (op === '%' && typeof l === 'string') return this.percentFormat(l, r);
    if (l instanceof PySet && r instanceof PySet) {
      const out = new PySet();
      const lk = l.d.keys();
      const rk = r.d.keys();
      if (op === '|') for (const x of [...lk, ...rk]) out.d.set(x, null);
      else if (op === '&') for (const x of lk) if (r.d.has(x)) out.d.set(x, null);
      else if (op === '-') for (const x of lk) if (!r.d.has(x)) out.d.set(x, null);
      return out;
    }
    if (l instanceof PyInstance) {
      const names: Record<string, string> = { '+': '__add__', '-': '__sub__', '*': '__mul__', '/': '__truediv__' };
      const m = names[op] && l.cls.lookup(names[op]);
      if (m) return yield* this.call(new PyBound(l, m), [r]);
    }
    throw this.error('TypeError', `unsupported operand type(s) for ${op}: '${this.typeName(l)}' and '${this.typeName(r)}'`);
  }

  *compare(op: string, l: PyValue, r: PyValue): Run<boolean> {
    switch (op) {
      case '==': return this.equals(l, r);
      case '!=': return !this.equals(l, r);
      case 'is': return l === r || (l === null && r === null) || (typeof l === 'boolean' && l === r);
      case 'is not': return !(yield* this.compare('is', l, r));
      case 'in': return yield* this.contains(r, l);
      case 'not in': return !(yield* this.contains(r, l));
    }
    const c = this.order(l, r);
    switch (op) {
      case '<': return c < 0;
      case '>': return c > 0;
      case '<=': return c <= 0;
      default: return c >= 0;
    }
  }

  equals(a: PyValue, b: PyValue): boolean {
    if (this.isNumber(a) && this.isNumber(b)) {
      if (typeof a !== 'number' && typeof b !== 'number') return this.toBig(a) === this.toBig(b);
      return this.toNum(a) === this.toNum(b);
    }
    if (typeof a === 'string' || typeof b === 'string' || a === null || b === null) return a === b;
    if ((a instanceof PyList && b instanceof PyList) || (a instanceof PyTuple && b instanceof PyTuple)) {
      return a.items.length === b.items.length && a.items.every((x, i) => this.equals(x, b.items[i]));
    }
    if (a instanceof PyDict && b instanceof PyDict) {
      if (a.map.size !== b.map.size) return false;
      for (const [k, [, v]] of a.map) if (!b.map.has(k) || !this.equals(v, b.map.get(k)![1])) return false;
      return true;
    }
    if (a instanceof PySet && b instanceof PySet) return a.d.map.size === b.d.map.size && a.d.keys().every((k) => b.d.has(k));
    return a === b;
  }

  order(a: PyValue, b: PyValue): number {
    if (this.isNumber(a) && this.isNumber(b)) {
      if (typeof a !== 'number' && typeof b !== 'number') {
        const x = this.toBig(a);
        const y = this.toBig(b);
        return x < y ? -1 : x > y ? 1 : 0;
      }
      const x = this.toNum(a);
      const y = this.toNum(b);
      return x < y ? -1 : x > y ? 1 : 0;
    }
    if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
    if ((a instanceof PyList && b instanceof PyList) || (a instanceof PyTuple && b instanceof PyTuple)) {
      for (let i = 0; i < Math.min(a.items.length, b.items.length); i++) {
        const c = this.order(a.items[i], b.items[i]);
        if (c) return c;
      }
      return a.items.length - b.items.length;
    }
    throw this.error('TypeError', `'<' not supported between instances of '${this.typeName(a)}' and '${this.typeName(b)}'`);
  }

  private *contains(container: PyValue, v: PyValue): Run<boolean> {
    if (typeof container === 'string') {
      if (typeof v !== 'string') throw this.error('TypeError', "'in <string>' requires string as left operand");
      return container.includes(v);
    }
    if (container instanceof PyDict) return container.has(v);
    if (container instanceof PySet) return container.d.has(v);
    if (container instanceof PyRange) {
      if (!this.isNumber(v)) return false;
      const x = this.toBig(v);
      const { start, stop, step } = container;
      return step > 0n ? x >= start && x < stop && (x - start) % step === 0n : x <= start && x > stop && (start - x) % -step === 0n;
    }
    for (const x of yield* this.iterate(container)) if (this.equals(x, v)) return true;
    return false;
  }

  truthy(v: PyValue): boolean {
    if (v === null || v === false) return false;
    if (v === true) return true;
    if (typeof v === 'bigint') return v !== 0n;
    if (typeof v === 'number') return v !== 0;
    if (typeof v === 'string') return v.length > 0;
    if (v instanceof PyList || v instanceof PyTuple) return v.items.length > 0;
    if (v instanceof PyDict) return v.map.size > 0;
    if (v instanceof PySet) return v.d.map.size > 0;
    if (v instanceof PyRange) return v.length > 0;
    if (v instanceof PyInstance) {
      const b = v.cls.lookup('__bool__');
      if (b instanceof PyProperty) return this.truthy(b.get(v) as PyValue);
      const len = v.cls.lookup('__len__');
      if (len instanceof PyBuiltin) return this.truthy(len.fn({ args: [], kwargs: new Map() }, v) as PyValue);
    }
    return true;
  }

  // ------------------------------------------------------------ sequences

  *iterate(v: PyValue): Run<Iterable<PyValue>> {
    if (v instanceof PyList || v instanceof PyTuple) return [...v.items];
    if (typeof v === 'string') return [...v];
    if (v instanceof PyRange) {
      const { start, step, length } = v;
      return (function* () {
        for (let i = 0; i < length; i++) yield start + step * BigInt(i);
      })();
    }
    if (v instanceof PyDict) return v.keys();
    if (v instanceof PySet) return v.d.keys();
    if (v instanceof PyIter) return { [Symbol.iterator]: () => v.it };
    if (v instanceof PyInstance) {
      const it = v.cls.lookup('__iter__');
      if (it) return yield* this.iterate(yield* this.call(new PyBound(v, it), []));
    }
    throw this.error('TypeError', `'${this.typeName(v)}' object is not iterable`);
  }

  index(v: PyValue, len: number): number {
    if (!(typeof v === 'bigint' || typeof v === 'boolean')) throw this.error('TypeError', `indices must be integers, not ${this.typeName(v)}`);
    let i = Number(this.toBig(v));
    if (i < 0) i += len;
    if (i < 0 || i >= len) throw this.error('IndexError', 'index out of range');
    return i;
  }

  sliceBounds(s: PySlice, len: number): [number, number, number] {
    const step = s.step === null ? 1 : Number(this.toBig(s.step));
    if (step === 0) throw this.error('ValueError', 'slice step cannot be zero');
    const norm = (v: PyValue, def: number) => {
      if (v === null) return def;
      let i = Number(this.toBig(v));
      if (i < 0) i += len;
      return step > 0 ? Math.max(0, Math.min(len, i)) : Math.max(-1, Math.min(len - 1, i));
    };
    return [norm(s.lo, step > 0 ? 0 : len - 1), norm(s.hi, step > 0 ? len : -1), step];
  }

  private sliceItems<T>(items: T[], s: PySlice): T[] {
    const [lo, hi, step] = this.sliceBounds(s, items.length);
    const out: T[] = [];
    if (step > 0) for (let i = lo; i < hi; i += step) out.push(items[i]);
    else for (let i = lo; i > hi; i += step) out.push(items[i]);
    return out;
  }

  *getitem(obj: PyValue, key: PyValue): Run<PyValue> {
    if (obj instanceof PyList || obj instanceof PyTuple) {
      if (key instanceof PySlice) {
        const items = this.sliceItems(obj.items, key);
        return obj instanceof PyList ? new PyList(items) : new PyTuple(items);
      }
      return obj.items[this.index(key, obj.items.length)];
    }
    if (typeof obj === 'string') {
      if (key instanceof PySlice) return this.sliceItems([...obj], key).join('');
      return [...obj][this.index(key, [...obj].length)];
    }
    if (obj instanceof PyDict) {
      const v = obj.get(key);
      if (v === undefined) throw this.error('KeyError', this.repr(key));
      return v;
    }
    if (obj instanceof PyRange) {
      if (key instanceof PySlice) throw this.error('TypeError', 'range slicing is not supported');
      return obj.start + obj.step * BigInt(this.index(key, obj.length));
    }
    if (obj instanceof PyInstance) {
      const m = obj.cls.lookup('__getitem__');
      if (m) return yield* this.call(new PyBound(obj, m), [key]);
    }
    throw this.error('TypeError', `'${this.typeName(obj)}' object is not subscriptable`);
  }

  *setitem(obj: PyValue, key: PyValue, v: PyValue): Run<void> {
    if (obj instanceof PyList) {
      if (key instanceof PySlice) {
        const [lo, hi] = this.sliceBounds(key, obj.items.length);
        obj.items.splice(lo, Math.max(0, hi - lo), ...(yield* this.iterate(v)));
        return;
      }
      obj.items[this.index(key, obj.items.length)] = v;
      return;
    }
    if (obj instanceof PyDict) {
      obj.set(key, v);
      return;
    }
    if (obj instanceof PyInstance) {
      const m = obj.cls.lookup('__setitem__');
      if (m) {
        yield* this.call(new PyBound(obj, m), [key, v]);
        return;
      }
    }
    throw this.error('TypeError', `'${this.typeName(obj)}' object does not support item assignment`);
  }

  // ------------------------------------------------------------- strings

  typeName(v: PyValue): string {
    if (v === null) return 'NoneType';
    if (typeof v === 'boolean') return 'bool';
    if (typeof v === 'bigint') return 'int';
    if (typeof v === 'number') return 'float';
    if (typeof v === 'string') return 'str';
    return v.typeName;
  }

  classOf(v: PyValue): PyClass {
    if (v instanceof PyInstance) return v.cls;
    return this.types.get(this.typeName(v)) ?? this.types.get('object')!;
  }

  floatRepr(v: number): string {
    if (Number.isNaN(v)) return 'nan';
    if (!Number.isFinite(v)) return v > 0 ? 'inf' : '-inf';
    if (v === 0) return Object.is(v, -0) ? '-0.0' : '0.0';
    const exp = Math.floor(Math.log10(Math.abs(v)));
    if (exp >= 16 || exp < -4) {
      const [m, e] = v.toExponential().split('e');
      const n = Number(e);
      const mant = m.includes('.') ? m : m;
      return `${mant}e${n < 0 ? '-' : '+'}${String(Math.abs(n)).padStart(2, '0')}`;
    }
    const s = String(v);
    if (s.includes('e')) return v.toFixed(Math.max(0, -exp + 16)).replace(/0+$/, '');
    return s.includes('.') ? s : `${s}.0`;
  }

  str(v: PyValue): string {
    if (typeof v === 'string') return v;
    if (v instanceof PyInstance) {
      const m = v.cls.lookup('__str__');
      if (m instanceof PyBuiltin) return String(m.fn({ args: [], kwargs: new Map() }, v));
      if (v.cls.isSubclassOf(this.exc.get('BaseException')!)) return String(v.dict.get('__msg__') ?? '');
    }
    return this.repr(v);
  }

  repr(v: PyValue): string {
    if (v === null) return 'None';
    if (v === true) return 'True';
    if (v === false) return 'False';
    if (typeof v === 'bigint') return v.toString();
    if (typeof v === 'number') return this.floatRepr(v);
    if (typeof v === 'string') {
      const q = v.includes("'") && !v.includes('"') ? '"' : "'";
      const body = v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
      return q + (q === "'" ? body.replace(/'/g, "\\'") : body) + q;
    }
    if (v instanceof PyList) return `[${v.items.map((x) => this.repr(x)).join(', ')}]`;
    if (v instanceof PyTuple) return v.items.length === 1 ? `(${this.repr(v.items[0])},)` : `(${v.items.map((x) => this.repr(x)).join(', ')})`;
    if (v instanceof PyDict) return `{${[...v.map.values()].map(([k, x]) => `${this.repr(k)}: ${this.repr(x)}`).join(', ')}}`;
    if (v instanceof PySet) return v.d.map.size ? `{${v.d.keys().map((x) => this.repr(x)).join(', ')}}` : 'set()';
    if (v instanceof PyRange) return `range(${v.start}, ${v.stop}${v.step !== 1n ? `, ${v.step}` : ''})`;
    if (v instanceof PyFunction) return `<function ${v.name}>`;
    if (v instanceof PyBuiltin) return `<built-in function ${v.name}>`;
    if (v instanceof PyClass) return `<class '${v.name}'>`;
    if (v instanceof PyModule) return `<module '${v.name}'>`;
    if (v instanceof PyBound) return `<bound method>`;
    if (v instanceof PyInstance) {
      const m = v.cls.lookup('__repr__');
      if (m instanceof PyBuiltin) return String(m.fn({ args: [], kwargs: new Map() }, v));
      if (v.cls.isSubclassOf(this.exc.get('BaseException')!)) {
        const args = v.dict.get('args');
        return `${v.cls.name}(${args instanceof PyTuple ? args.items.map((x) => this.repr(x)).join(', ') : ''})`;
      }
      return `<${v.cls.name} object>`;
    }
    return `<${(v as PyObject).typeName}>`;
  }

  /** format(value, spec): the format-spec mini-language's common parts. */
  *format(v: PyValue, spec: string): Run<string> {
    if (!spec) return this.str(v);
    const m = /^(?:(.)?([<>=^]))?([+\- ])?(#)?(0)?(\d+)?([,_])?(?:\.(\d+))?([bcdeEfFgGnosxX%])?$/.exec(spec);
    if (!m) throw this.error('ValueError', `Invalid format specifier '${spec}'`);
    const [, fillCh, align, sign, alt, zero, widthS, group, precS, typeS] = m;
    const prec = precS === undefined ? undefined : Number(precS);
    let type = typeS;
    let body: string;
    let negative = false;
    if (this.isNumber(v)) {
      if (!type) type = typeof v === 'number' ? (prec !== undefined ? 'g' : '') : 'd';
      const isInt = typeof v !== 'number';
      const num = this.toNum(v);
      negative = num < 0 || Object.is(num, -0);
      const a = Math.abs(num);
      switch (type) {
        case 'd':
        case 'n':
          if (!isInt) throw this.error('ValueError', "Unknown format code 'd' for object of type 'float'");
          body = (this.toBig(v) < 0n ? -this.toBig(v) : this.toBig(v)).toString();
          break;
        case 'x': body = (this.toBig(v) < 0n ? -this.toBig(v) : this.toBig(v)).toString(16); if (alt) body = '0x' + body; break;
        case 'X': body = (this.toBig(v) < 0n ? -this.toBig(v) : this.toBig(v)).toString(16).toUpperCase(); if (alt) body = '0X' + body; break;
        case 'b': body = (this.toBig(v) < 0n ? -this.toBig(v) : this.toBig(v)).toString(2); if (alt) body = '0b' + body; break;
        case 'o': body = (this.toBig(v) < 0n ? -this.toBig(v) : this.toBig(v)).toString(8); if (alt) body = '0o' + body; break;
        case 'c': body = String.fromCharCode(Number(this.toBig(v))); negative = false; break;
        case 'f':
        case 'F': body = fixedHalfEven(a, prec ?? 6); break;
        case 'e':
        case 'E': {
          const [mm, ee] = a.toExponential(prec ?? 6).split('e');
          body = `${mm}e${Number(ee) < 0 ? '-' : '+'}${String(Math.abs(Number(ee))).padStart(2, '0')}`;
          if (type === 'E') body = body.toUpperCase();
          break;
        }
        case '%': body = (a * 100).toFixed(prec ?? 6) + '%'; break;
        case 'g':
        case 'G': {
          const p = prec === 0 ? 1 : prec ?? 6;
          const exp = a === 0 ? 0 : Math.floor(Math.log10(a));
          if (exp < -4 || exp >= p) {
            const [mm, ee] = a.toExponential(p - 1).split('e');
            body = `${alt ? mm : mm.replace(/\.?0+$/, '')}e${Number(ee) < 0 ? '-' : '+'}${String(Math.abs(Number(ee))).padStart(2, '0')}`;
          } else {
            body = a.toFixed(Math.max(0, p - 1 - exp));
            if (!alt && body.includes('.')) body = body.replace(/\.?0+$/, '');
          }
          if (type === 'G') body = body.toUpperCase();
          break;
        }
        default:
          body = isInt ? (this.toBig(v) < 0n ? -this.toBig(v) : this.toBig(v)).toString() : this.floatRepr(a);
      }
      if (group) {
        const [ip, fp] = body.split('.');
        body = ip.replace(/\B(?=(\d{3})+(?!\d))/g, group) + (fp !== undefined ? '.' + fp : '');
      }
    } else {
      if (type && type !== 's') throw this.error('ValueError', `Unknown format code '${type}' for object of type '${this.typeName(v)}'`);
      body = this.str(v);
      if (prec !== undefined) body = body.slice(0, prec);
    }
    const signStr = this.isNumber(v) ? (negative ? '-' : sign === '+' ? '+' : sign === ' ' ? ' ' : '') : '';
    const width = widthS ? Number(widthS) : 0;
    const fill = fillCh ?? (zero && !align ? '0' : ' ');
    const al = align ?? (zero ? '=' : this.isNumber(v) ? '>' : '<');
    const total = signStr.length + body.length;
    if (total >= width) return signStr + body;
    const pad = width - total;
    switch (al) {
      case '<': return signStr + body + fill.repeat(pad);
      case '^': return fill.repeat(Math.floor(pad / 2)) + signStr + body + fill.repeat(Math.ceil(pad / 2));
      case '=': return signStr + fill.repeat(pad) + body;
      default: return fill.repeat(pad) + signStr + body;
    }
  }

  private percentFormat(fmt: string, arg: PyValue): string {
    const args = arg instanceof PyTuple ? [...arg.items] : [arg];
    let ai = 0;
    const out = fmt.replace(/%([-+ 0#]*)(\d+|\*)?(?:\.(\d+))?([sdifxXrcoeEgG%])/g, (_m, flags: string, width: string, prec: string, conv: string) => {
      if (conv === '%') return '%';
      const v = args[ai++];
      if (v === undefined) throw this.error('TypeError', 'not enough arguments for format string');
      let spec = '';
      if (flags.includes('-')) spec += '<';
      if (flags.includes('+')) spec += '+';
      if (flags.includes('0') && !flags.includes('-')) spec += '0';
      if (width) spec += width;
      if (prec) spec += '.' + prec;
      if (conv === 's' || conv === 'r') {
        const s = conv === 'r' ? this.repr(v) : this.str(v);
        return this.formatSync(s, spec);
      }
      const t = conv === 'i' ? 'd' : conv;
      const val = t === 'd' && typeof v === 'number' ? BigInt(Math.trunc(v)) : v;
      return this.formatSync(val, spec + t);
    });
    if (ai < args.length && arg instanceof PyTuple) throw this.error('TypeError', 'not all arguments converted during string formatting');
    return out;
  }

  /** format() for the cases that never block (all of them, in practice). */
  formatSync(v: PyValue, spec: string): string {
    const g = this.format(v, spec);
    const r = g.next();
    return r.value as string;
  }

  /** str.format(*args, **kwargs). */
  private strFormat(fmt: string, a: CallArgs): string {
    let auto = 0;
    return fmt.replace(/\{\{|\}\}|\{([^{}!:]*)(?:!([rs]))?(?::([^{}]*))?\}/g, (m, field: string, conv: string, spec: string) => {
      if (m === '{{') return '{';
      if (m === '}}') return '}';
      let v: PyValue;
      const parts = field.split(/[.[]/);
      const head = parts[0];
      if (head === '') v = a.args[auto++] ?? null;
      else if (/^\d+$/.test(head)) v = a.args[Number(head)] ?? null;
      else v = a.kwargs.get(head) ?? null;
      for (const p of field.slice(head.length).match(/\.\w+|\[[^\]]+\]/g) ?? []) {
        if (p.startsWith('.') && v instanceof PyInstance) v = v.dict.get(p.slice(1)) ?? null;
        else if (p.startsWith('[')) {
          const k = p.slice(1, -1);
          if (v instanceof PyList || v instanceof PyTuple) v = v.items[Number(k)];
          else if (v instanceof PyDict) v = v.get(/^\d+$/.test(k) ? BigInt(k) : k) ?? null;
        }
      }
      if (conv === 'r') v = this.repr(v);
      else if (conv === 's') v = this.str(v);
      return this.formatSync(v, spec ?? '');
    });
  }

  // -------------------------------------------------------------- modules

  private tryImport(name: string): PyModule | undefined {
    const cached = this.modules.get(name);
    if (cached) return cached;
    const mod = this.standardModule(name) ?? this.host.module(name, this);
    if (mod) this.modules.set(name, mod);
    return mod;
  }

  importModule(name: string): PyModule {
    const mod = this.tryImport(name);
    if (!mod) {
      throw this.error(
        'ModuleNotFoundError',
        `No module named '${name}' (CircuitDesk's Raspberry Pi runtime provides RPi.GPIO, gpiozero, time, math, random, signal and sys)`,
      );
    }
    // A dotted import makes the package's attribute too: import RPi.GPIO.
    const dot = name.lastIndexOf('.');
    if (dot > 0) {
      const parent = this.tryImport(name.slice(0, dot));
      if (parent && !parent.dict.has(name.slice(dot + 1))) parent.dict.set(name.slice(dot + 1), mod);
    }
    return mod;
  }

  fn(name: string, f: (a: CallArgs, self?: PyValue) => PyValue): PyBuiltin {
    return new PyBuiltin(name, f);
  }

  blocking(name: string, f: (a: CallArgs, self?: PyValue) => Run<PyValue>): PyBuiltin {
    return new PyBuiltin(name, f, true);
  }

  arg(a: CallArgs, i: number, name: string, def?: PyValue): PyValue {
    if (i < a.args.length) return a.args[i];
    if (a.kwargs.has(name)) return a.kwargs.get(name)!;
    if (def !== undefined) return def;
    throw this.error('TypeError', `missing required argument: '${name}'`);
  }

  /** A deterministic generator for the random module, so runs repeat. */
  random(): number {
    let x = this.rng;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.rng = x >>> 0;
    return this.rng / 0x100000000;
  }

  private standardModule(name: string): PyModule | undefined {
    const mod = new PyModule(name);
    const d = mod.dict;
    switch (name) {
      case 'time': {
        const sleep = this.blocking('sleep', (a) => {
          const s = this.toNum(this.arg(a, 0, 'secs'));
          if (s < 0) throw this.error('ValueError', 'sleep length must be non-negative');
          return (function* (): Run<PyValue> {
            yield { k: 'sleep', ms: s * 1000 };
            return null;
          })();
        });
        d.set('sleep', sleep);
        const epoch = 1_735_689_600; // 2025-01-01, plus simulated time
        d.set('time', this.fn('time', () => epoch + this.host.nowMs() / 1000));
        d.set('monotonic', this.fn('monotonic', () => this.host.nowMs() / 1000));
        d.set('perf_counter', this.fn('perf_counter', () => this.host.nowMs() / 1000));
        d.set('time_ns', this.fn('time_ns', () => BigInt(Math.round((epoch * 1000 + this.host.nowMs()) * 1e6))));
        d.set('monotonic_ns', this.fn('monotonic_ns', () => BigInt(Math.round(this.host.nowMs() * 1e6))));
        return mod;
      }
      case 'math': {
        const f1 = (n: string, f: (x: number) => number) => d.set(n, this.fn(n, (a) => f(this.toNum(this.arg(a, 0, 'x')))));
        for (const n of ['sqrt', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'exp', 'log10', 'log2', 'sinh', 'cosh', 'tanh'] as const) f1(n, Math[n]);
        f1('fabs', Math.abs);
        f1('radians', (x) => (x * Math.PI) / 180);
        f1('degrees', (x) => (x * 180) / Math.PI);
        d.set('floor', this.fn('floor', (a) => BigInt(Math.floor(this.toNum(this.arg(a, 0, 'x'))))));
        d.set('ceil', this.fn('ceil', (a) => BigInt(Math.ceil(this.toNum(this.arg(a, 0, 'x'))))));
        d.set('trunc', this.fn('trunc', (a) => BigInt(Math.trunc(this.toNum(this.arg(a, 0, 'x'))))));
        d.set('log', this.fn('log', (a) => (a.args.length > 1 ? Math.log(this.toNum(a.args[0])) / Math.log(this.toNum(a.args[1])) : Math.log(this.toNum(this.arg(a, 0, 'x'))))));
        d.set('pow', this.fn('pow', (a) => Math.pow(this.toNum(a.args[0]), this.toNum(a.args[1]))));
        d.set('atan2', this.fn('atan2', (a) => Math.atan2(this.toNum(a.args[0]), this.toNum(a.args[1]))));
        d.set('hypot', this.fn('hypot', (a) => Math.hypot(...a.args.map((x) => this.toNum(x)))));
        d.set('isclose', this.fn('isclose', (a) => Math.abs(this.toNum(a.args[0]) - this.toNum(a.args[1])) <= Math.max(1e-9 * Math.max(Math.abs(this.toNum(a.args[0])), Math.abs(this.toNum(a.args[1]))), this.toNum(a.kwargs.get('abs_tol') ?? 0))));
        d.set('pi', Math.PI);
        d.set('e', Math.E);
        d.set('tau', Math.PI * 2);
        d.set('inf', Infinity);
        d.set('nan', NaN);
        return mod;
      }
      case 'random': {
        d.set('random', this.fn('random', () => this.random()));
        d.set('seed', this.fn('seed', (a) => {
          this.rng = (Number(a.args[0] ?? 1n) | 0) || 0x2545f491;
          return null;
        }));
        d.set('randint', this.fn('randint', (a) => {
          const lo = this.toBig(this.arg(a, 0, 'a'));
          const hi = this.toBig(this.arg(a, 1, 'b'));
          return lo + BigInt(Math.floor(this.random() * Number(hi - lo + 1n)));
        }));
        d.set('randrange', this.fn('randrange', (a) => {
          const [lo, hi] = a.args.length > 1 ? [this.toBig(a.args[0]), this.toBig(a.args[1])] : [0n, this.toBig(a.args[0])];
          return lo + BigInt(Math.floor(this.random() * Number(hi - lo)));
        }));
        d.set('uniform', this.fn('uniform', (a) => {
          const lo = this.toNum(a.args[0]);
          return lo + this.random() * (this.toNum(a.args[1]) - lo);
        }));
        d.set('choice', this.fn('choice', (a) => {
          const seq = a.args[0];
          const items = seq instanceof PyList || seq instanceof PyTuple ? seq.items : typeof seq === 'string' ? [...seq] : [];
          if (!items.length) throw this.error('IndexError', 'Cannot choose from an empty sequence');
          return items[Math.floor(this.random() * items.length)];
        }));
        d.set('shuffle', this.fn('shuffle', (a) => {
          const l = a.args[0];
          if (l instanceof PyList) {
            for (let i = l.items.length - 1; i > 0; i--) {
              const j = Math.floor(this.random() * (i + 1));
              [l.items[i], l.items[j]] = [l.items[j], l.items[i]];
            }
          }
          return null;
        }));
        return mod;
      }
      case 'sys': {
        d.set('exit', this.fn('exit', (a) => {
          const e = this.makeExc('SystemExit', a.args.length ? this.str(a.args[0]) : '');
          throw new PyError(e, this.line);
        }));
        d.set('argv', new PyList(['main.py']));
        d.set('platform', 'linux');
        d.set('version', '3.11.2 (CircuitDesk Raspberry Pi runtime)');
        d.set('maxsize', 2n ** 63n - 1n);
        const stdout = new PyModule('stdout');
        stdout.dict.set('write', this.fn('write', (a) => {
          const s = this.str(a.args[0]);
          this.host.write(s);
          return BigInt(s.length);
        }));
        stdout.dict.set('flush', this.fn('flush', () => null));
        d.set('stdout', stdout);
        return mod;
      }
      case 'signal': {
        d.set('pause', this.blocking('pause', () =>
          (function* (): Run<PyValue> {
            while (true) yield { k: 'sleep', ms: 3_600_000 };
          })(),
        ));
        d.set('signal', this.fn('signal', () => null));
        d.set('SIGINT', 2n);
        d.set('SIGTERM', 15n);
        return mod;
      }
      case 'RPi':
        return mod;
      default:
        return undefined;
    }
  }

  // ------------------------------------------------------------ builtins

  private setupTypes(): void {
    const object = new PyClass('object', [], () => true);
    this.types.set('object', object);
    const t = (name: string, check: (v: PyValue) => boolean, ctor: (a: CallArgs) => PyValue | Run<PyValue>, base = object) => {
      const cls = new PyClass(name, [base], check);
      cls.dict.set('__new__', ctor instanceof Function && ctor.length >= 0 ? new PyBuiltin(name, ctor, ctor.constructor.name === 'GeneratorFunction') : ctor);
      this.types.set(name, cls);
      this.builtins.set(name, cls);
      return cls;
    };
    const self = this;
    const int = t('int', (v) => typeof v === 'bigint' || typeof v === 'boolean', (a) => {
      if (!a.args.length) return 0n;
      const v = a.args[0];
      if (typeof v === 'string') {
        const base = a.args.length > 1 ? Number(this.toBig(a.args[1])) : 10;
        const s = v.trim().replace(/_/g, '');
        const body = base === 16 ? s.replace(/^0x/i, '') : base === 2 ? s.replace(/^0b/i, '') : base === 8 ? s.replace(/^0o/i, '') : s;
        const valid = new RegExp(`^[+-]?[${'0123456789abcdefghijklmnopqrstuvwxyz'.slice(0, base)}]+$`, 'i');
        if (!valid.test(body)) throw this.error('ValueError', `invalid literal for int() with base ${base}: ${this.repr(v)}`);
        const neg = body.startsWith('-');
        const digits = body.replace(/^[+-]/, '');
        let n = 0n;
        for (const c of digits.toLowerCase()) n = n * BigInt(base) + BigInt(parseInt(c, 36));
        return neg ? -n : n;
      }
      if (typeof v === 'number') {
        if (!Number.isFinite(v)) throw this.error(Number.isNaN(v) ? 'ValueError' : 'OverflowError', 'cannot convert float to integer');
        return BigInt(Math.trunc(v));
      }
      return this.toBig(v);
    });
    void int;
    t('bool', (v) => typeof v === 'boolean', (a) => (a.args.length ? this.truthy(a.args[0]) : false), this.types.get('int'));
    t('float', (v) => typeof v === 'number', (a) => {
      if (!a.args.length) return 0;
      const v = a.args[0];
      if (typeof v === 'string') {
        const s = v.trim().toLowerCase();
        if (s === 'inf' || s === '+inf' || s === 'infinity') return Infinity;
        if (s === '-inf' || s === '-infinity') return -Infinity;
        if (s === 'nan') return NaN;
        const n = Number(s.replace(/_/g, ''));
        if (s === '' || Number.isNaN(n)) throw this.error('ValueError', `could not convert string to float: ${this.repr(v)}`);
        return n;
      }
      return this.toNum(v);
    });
    t('str', (v) => typeof v === 'string', (a) => (a.args.length ? this.str(a.args[0]) : ''));
    t('list', (v) => v instanceof PyList, function* (a) {
      return new PyList(a.args.length ? [...(yield* self.iterate(a.args[0]))] : []);
    });
    t('tuple', (v) => v instanceof PyTuple, function* (a) {
      return new PyTuple(a.args.length ? [...(yield* self.iterate(a.args[0]))] : []);
    });
    t('set', (v) => v instanceof PySet, function* (a) {
      return new PySet(a.args.length ? [...(yield* self.iterate(a.args[0]))] : []);
    });
    t('dict', (v) => v instanceof PyDict, function* (a) {
      const d = new PyDict();
      if (a.args.length) {
        const src = a.args[0];
        if (src instanceof PyDict) for (const [k, v] of src.map.values()) d.set(k, v);
        else for (const pair of yield* self.iterate(src)) {
          const kv = [...(yield* self.iterate(pair))];
          d.set(kv[0], kv[1]);
        }
      }
      for (const [k, v] of a.kwargs) d.set(k, v);
      return d;
    });
    t('range', (v) => v instanceof PyRange, (a) => {
      const n = a.args.map((x) => this.toBig(x));
      const [start, stop, step] = n.length === 1 ? [0n, n[0], 1n] : [n[0], n[1], n[2] ?? 1n];
      if (step === 0n) throw this.error('ValueError', 'range() arg 3 must not be zero');
      return new PyRange(start, stop, step);
    });
    this.types.set('NoneType', new PyClass('NoneType', [object], (v) => v === null));
    for (const n of ['function', 'builtin_function_or_method', 'method', 'module', 'iterator', 'slice', 'property', 'type']) {
      this.types.set(n, new PyClass(n, [object]));
    }
    this.builtins.set('object', object);
    this.builtins.set('type', new PyBuiltin('type', (a) => this.classOf(a.args[0])));
    this.methods();
  }

  /** Methods of str, list, dict and set. */
  private methods(): void {
    const m = (type: string, name: string, f: (self: never, a: CallArgs) => PyValue | Run<PyValue>, blocking = false) =>
      this.types.get(type)!.dict.set(name, new PyBuiltin(name, (a, self) => f(self as never, a), blocking));
    const S = (s: string, a: CallArgs, i: number, name: string, def?: PyValue) => this.str(this.arg(a, i, name, def));
    m('str', 'upper', (s: string) => s.toUpperCase());
    m('str', 'lower', (s: string) => s.toLowerCase());
    m('str', 'title', (s: string) => s.replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase()));
    m('str', 'capitalize', (s: string) => (s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : s));
    const stripper = (dir: 'both' | 'l' | 'r') => (s: string, a: CallArgs) => {
      const chars = a.args.length && a.args[0] !== null ? this.str(a.args[0]) : ' \t\n\r\x0b\x0c';
      let lo = 0;
      let hi = s.length;
      if (dir !== 'r') while (lo < hi && chars.includes(s[lo])) lo++;
      if (dir !== 'l') while (hi > lo && chars.includes(s[hi - 1])) hi--;
      return s.slice(lo, hi);
    };
    m('str', 'strip', stripper('both'));
    m('str', 'lstrip', stripper('l'));
    m('str', 'rstrip', stripper('r'));
    m('str', 'split', (s: string, a) => {
      const sep = a.args.length && a.args[0] !== null ? this.str(a.args[0]) : a.kwargs.has('sep') && a.kwargs.get('sep') !== null ? this.str(a.kwargs.get('sep')!) : null;
      const max = a.args.length > 1 ? Number(this.toBig(a.args[1])) : a.kwargs.has('maxsplit') ? Number(this.toBig(a.kwargs.get('maxsplit')!)) : -1;
      let parts: string[];
      if (sep === null) parts = s.trim().split(/\s+/).filter((x) => x !== '');
      else parts = s.split(sep);
      if (max >= 0 && parts.length > max + 1) parts = [...parts.slice(0, max), parts.slice(max).join(sep ?? ' ')];
      return new PyList(parts);
    });
    m('str', 'splitlines', (s: string) => new PyList(s.split(/\r?\n/).filter((x, i, arr) => i < arr.length - 1 || x !== '')));
    const self = this;
    m('str', 'join', function* (s: string, a): Run<PyValue> {
      const items = [...(yield* self.iterate(a.args[0]))];
      for (const x of items) if (typeof x !== 'string') throw self.error('TypeError', `sequence item: expected str instance, ${self.typeName(x)} found`);
      return items.join(s);
    }, true);
    m('str', 'replace', (s: string, a) => s.split(S(s, a, 0, 'old')).join(S(s, a, 1, 'new')));
    m('str', 'startswith', (s: string, a) => {
      const p = a.args[0];
      return p instanceof PyTuple ? p.items.some((x) => s.startsWith(this.str(x))) : s.startsWith(this.str(p));
    });
    m('str', 'endswith', (s: string, a) => {
      const p = a.args[0];
      return p instanceof PyTuple ? p.items.some((x) => s.endsWith(this.str(x))) : s.endsWith(this.str(p));
    });
    m('str', 'find', (s: string, a) => BigInt(s.indexOf(S(s, a, 0, 'sub'))));
    m('str', 'index', (s: string, a) => {
      const i = s.indexOf(S(s, a, 0, 'sub'));
      if (i < 0) throw this.error('ValueError', 'substring not found');
      return BigInt(i);
    });
    m('str', 'count', (s: string, a) => BigInt(s.split(S(s, a, 0, 'sub')).length - 1));
    m('str', 'format', (s: string, a) => this.strFormat(s, a));
    m('str', 'isdigit', (s: string) => /^\d+$/.test(s));
    m('str', 'isnumeric', (s: string) => /^\d+$/.test(s));
    m('str', 'isalpha', (s: string) => /^[A-Za-z]+$/.test(s));
    m('str', 'isalnum', (s: string) => /^[A-Za-z0-9]+$/.test(s));
    m('str', 'isspace', (s: string) => /^\s+$/.test(s));
    m('str', 'isupper', (s: string) => /[A-Z]/.test(s) && s === s.toUpperCase());
    m('str', 'islower', (s: string) => /[a-z]/.test(s) && s === s.toLowerCase());
    m('str', 'zfill', (s: string, a) => {
      const w = Number(this.toBig(a.args[0]));
      const sign = s.startsWith('-') || s.startsWith('+') ? s[0] : '';
      return sign + s.slice(sign.length).padStart(w - sign.length, '0');
    });
    m('str', 'center', (s: string, a) => this.formatSync(s, `${a.args[1] !== undefined ? this.str(a.args[1]) : ' '}^${this.toBig(a.args[0])}`));
    m('str', 'ljust', (s: string, a) => s.padEnd(Number(this.toBig(a.args[0])), a.args[1] !== undefined ? this.str(a.args[1]) : ' '));
    m('str', 'rjust', (s: string, a) => s.padStart(Number(this.toBig(a.args[0])), a.args[1] !== undefined ? this.str(a.args[1]) : ' '));
    m('str', 'encode', (s: string) => s);

    m('list', 'append', (l: PyList, a) => {
      l.items.push(a.args[0]);
      return null;
    });
    m('list', 'extend', function* (l: PyList, a): Run<PyValue> {
      l.items.push(...(yield* self.iterate(a.args[0])));
      return null;
    }, true);
    m('list', 'insert', (l: PyList, a) => {
      let i = Number(this.toBig(a.args[0]));
      if (i < 0) i = Math.max(0, l.items.length + i);
      l.items.splice(i, 0, a.args[1]);
      return null;
    });
    m('list', 'pop', (l: PyList, a) => {
      if (!l.items.length) throw this.error('IndexError', 'pop from empty list');
      const i = a.args.length ? this.index(a.args[0], l.items.length) : l.items.length - 1;
      return l.items.splice(i, 1)[0];
    });
    m('list', 'remove', (l: PyList, a) => {
      const i = l.items.findIndex((x) => this.equals(x, a.args[0]));
      if (i < 0) throw this.error('ValueError', 'list.remove(x): x not in list');
      l.items.splice(i, 1);
      return null;
    });
    m('list', 'index', (l: PyList, a) => {
      const i = l.items.findIndex((x) => this.equals(x, a.args[0]));
      if (i < 0) throw this.error('ValueError', `${this.repr(a.args[0])} is not in list`);
      return BigInt(i);
    });
    m('list', 'count', (l: PyList, a) => BigInt(l.items.filter((x) => this.equals(x, a.args[0])).length));
    m('list', 'reverse', (l: PyList) => {
      l.items.reverse();
      return null;
    });
    m('list', 'clear', (l: PyList) => {
      l.items.length = 0;
      return null;
    });
    m('list', 'copy', (l: PyList) => new PyList([...l.items]));
    m('list', 'sort', function* (l: PyList, a): Run<PyValue> {
      l.items = yield* self.sorted(l.items, a.kwargs.get('key') ?? null, self.truthy(a.kwargs.get('reverse') ?? false));
      return null;
    }, true);
    m('tuple', 'index', (t: PyTuple, a) => {
      const i = t.items.findIndex((x) => this.equals(x, a.args[0]));
      if (i < 0) throw this.error('ValueError', 'tuple.index(x): x not in tuple');
      return BigInt(i);
    });
    m('tuple', 'count', (t: PyTuple, a) => BigInt(t.items.filter((x) => this.equals(x, a.args[0])).length));

    m('dict', 'get', (d: PyDict, a) => d.get(a.args[0]) ?? (a.args.length > 1 ? a.args[1] : null));
    m('dict', 'keys', (d: PyDict) => new PyList(d.keys()));
    m('dict', 'values', (d: PyDict) => new PyList([...d.map.values()].map((e) => e[1])));
    m('dict', 'items', (d: PyDict) => new PyList([...d.map.values()].map((e) => new PyTuple([e[0], e[1]]))));
    m('dict', 'pop', (d: PyDict, a) => {
      const v = d.get(a.args[0]);
      if (v === undefined) {
        if (a.args.length > 1) return a.args[1];
        throw this.error('KeyError', this.repr(a.args[0]));
      }
      d.delete(a.args[0]);
      return v;
    });
    m('dict', 'setdefault', (d: PyDict, a) => {
      const v = d.get(a.args[0]);
      if (v !== undefined) return v;
      const def = a.args.length > 1 ? a.args[1] : null;
      d.set(a.args[0], def);
      return def;
    });
    m('dict', 'update', (d: PyDict, a) => {
      const src = a.args[0];
      if (src instanceof PyDict) for (const [k, v] of src.map.values()) d.set(k, v);
      for (const [k, v] of a.kwargs) d.set(k, v);
      return null;
    });
    m('dict', 'clear', (d: PyDict) => {
      d.map.clear();
      return null;
    });
    m('dict', 'copy', (d: PyDict) => {
      const c = new PyDict();
      for (const [k, v] of d.map.values()) c.set(k, v);
      return c;
    });
    m('set', 'add', (s: PySet, a) => {
      s.d.set(a.args[0], null);
      return null;
    });
    m('set', 'remove', (s: PySet, a) => {
      if (!s.d.delete(a.args[0])) throw this.error('KeyError', this.repr(a.args[0]));
      return null;
    });
    m('set', 'discard', (s: PySet, a) => {
      s.d.delete(a.args[0]);
      return null;
    });
    m('set', 'clear', (s: PySet) => {
      s.d.map.clear();
      return null;
    });
  }

  *sorted(items: PyValue[], key: PyValue, reverse: boolean): Run<PyValue[]> {
    const keyed: [PyValue, PyValue][] = [];
    for (const x of items) keyed.push([key === null ? x : yield* this.call(key, [x]), x]);
    keyed.sort((p, q) => this.order(p[0], q[0]));
    if (reverse) keyed.reverse();
    return keyed.map((p) => p[1]);
  }

  private setupExceptions(): void {
    const make = (name: string, base?: string) => {
      const cls = new PyClass(name, [base ? this.exc.get(base)! : this.types.get('object')!]);
      this.exc.set(name, cls);
      this.builtins.set(name, cls);
    };
    make('BaseException');
    make('SystemExit', 'BaseException');
    make('KeyboardInterrupt', 'BaseException');
    make('Exception', 'BaseException');
    for (const n of ['ArithmeticError', 'LookupError', 'RuntimeError', 'ValueError', 'TypeError', 'NameError', 'AttributeError', 'AssertionError', 'ImportError', 'OSError', 'StopIteration', 'EOFError']) make(n, 'Exception');
    make('ZeroDivisionError', 'ArithmeticError');
    make('OverflowError', 'ArithmeticError');
    make('IndexError', 'LookupError');
    make('KeyError', 'LookupError');
    make('ModuleNotFoundError', 'ImportError');
    make('NotImplementedError', 'RuntimeError');
    make('RecursionError', 'RuntimeError');
    make('UnboundLocalError', 'NameError');
    make('SyntaxError', 'Exception');
    make('TimeoutError', 'OSError');
    this.builtins.set('IOError', this.exc.get('OSError')!);
  }

  private setupBuiltins(): void {
    const b = (name: string, f: (a: CallArgs) => PyValue) => this.builtins.set(name, this.fn(name, f));
    const bb = (name: string, f: (a: CallArgs) => Run<PyValue>) => this.builtins.set(name, this.blocking(name, f));
    const self = this;
    b('print', (a) => {
      const sep = a.kwargs.has('sep') && a.kwargs.get('sep') !== null ? this.str(a.kwargs.get('sep')!) : ' ';
      const end = a.kwargs.has('end') && a.kwargs.get('end') !== null ? this.str(a.kwargs.get('end')!) : '\n';
      this.host.write(a.args.map((x) => this.str(x)).join(sep) + end);
      return null;
    });
    bb('input', function* (a) {
      if (a.args.length) self.host.write(self.str(a.args[0]));
      let line: string | undefined;
      yield { k: 'until', ready: () => (line = self.host.readLine()) !== undefined };
      return line ?? '';
    });
    b('len', (a) => {
      const v = a.args[0];
      if (typeof v === 'string') return BigInt([...v].length);
      if (v instanceof PyList || v instanceof PyTuple) return BigInt(v.items.length);
      if (v instanceof PyDict) return BigInt(v.map.size);
      if (v instanceof PySet) return BigInt(v.d.map.size);
      if (v instanceof PyRange) return BigInt(v.length);
      throw this.error('TypeError', `object of type '${this.typeName(v)}' has no len()`);
    });
    b('abs', (a) => {
      const v = a.args[0];
      if (typeof v === 'bigint') return v < 0n ? -v : v;
      return Math.abs(this.toNum(v));
    });
    b('round', (a) => {
      const v = this.toNum(a.args[0]);
      const nd = a.args.length > 1 && a.args[1] !== null ? Number(this.toBig(a.args[1])) : null;
      // Round half to even, as Python does.
      const bankers = (x: number) => {
        const r = Math.round(x);
        return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
      };
      if (nd === null) return BigInt(bankers(v));
      if (typeof a.args[0] !== 'number') return a.args[0];
      return nd >= 0 ? Number(fixedHalfEven(v, nd)) : bankers(v / 10 ** -nd) * 10 ** -nd;
    });
    bb('min', function* (a) {
      return yield* self.extreme(a, -1);
    });
    bb('max', function* (a) {
      return yield* self.extreme(a, 1);
    });
    bb('sum', function* (a) {
      let total: PyValue = a.args.length > 1 ? a.args[1] : 0n;
      for (const x of yield* self.iterate(a.args[0])) total = yield* self.binop('+', total, x);
      return total;
    });
    bb('sorted', function* (a) {
      return new PyList(yield* self.sorted([...(yield* self.iterate(a.args[0]))], a.kwargs.get('key') ?? null, self.truthy(a.kwargs.get('reverse') ?? false)));
    });
    bb('reversed', function* (a) {
      return new PyIter([...(yield* self.iterate(a.args[0]))].reverse()[Symbol.iterator]());
    });
    bb('enumerate', function* (a) {
      let i = a.args.length > 1 ? self.toBig(a.args[1]) : a.kwargs.has('start') ? self.toBig(a.kwargs.get('start')!) : 0n;
      const out: PyValue[] = [];
      for (const x of yield* self.iterate(a.args[0])) out.push(new PyTuple([i++, x]));
      return new PyIter(out[Symbol.iterator]());
    });
    bb('zip', function* (a) {
      const lists: PyValue[][] = [];
      for (const x of a.args) lists.push([...(yield* self.iterate(x))]);
      const n = lists.length ? Math.min(...lists.map((l) => l.length)) : 0;
      return new PyIter(Array.from({ length: n }, (_, i) => new PyTuple(lists.map((l) => l[i])))[Symbol.iterator]());
    });
    bb('map', function* (a) {
      const out: PyValue[] = [];
      const lists: PyValue[][] = [];
      for (const x of a.args.slice(1)) lists.push([...(yield* self.iterate(x))]);
      const n = Math.min(...lists.map((l) => l.length));
      for (let i = 0; i < n; i++) out.push(yield* self.call(a.args[0], lists.map((l) => l[i])));
      return new PyIter(out[Symbol.iterator]());
    });
    bb('filter', function* (a) {
      const out: PyValue[] = [];
      for (const x of yield* self.iterate(a.args[1])) if (self.truthy(a.args[0] === null ? x : yield* self.call(a.args[0], [x]))) out.push(x);
      return new PyIter(out[Symbol.iterator]());
    });
    bb('any', function* (a) {
      for (const x of yield* self.iterate(a.args[0])) if (self.truthy(x)) return true;
      return false;
    });
    bb('all', function* (a) {
      for (const x of yield* self.iterate(a.args[0])) if (!self.truthy(x)) return false;
      return true;
    });
    bb('iter', function* (a) {
      return new PyIter((yield* self.iterate(a.args[0]))[Symbol.iterator]());
    });
    b('next', (a) => {
      const it = a.args[0];
      if (!(it instanceof PyIter)) throw this.error('TypeError', `'${this.typeName(it)}' object is not an iterator`);
      const r = it.it.next();
      if (r.done) {
        if (a.args.length > 1) return a.args[1];
        throw this.error('StopIteration');
      }
      return r.value;
    });
    b('isinstance', (a) => {
      const types = a.args[1] instanceof PyTuple ? a.args[1].items : [a.args[1]];
      return types.some((t) => t instanceof PyClass && (t.check ? t.check(a.args[0]) : a.args[0] instanceof PyInstance && a.args[0].cls.isSubclassOf(t)));
    });
    b('issubclass', (a) => a.args[0] instanceof PyClass && a.args[1] instanceof PyClass && a.args[0].isSubclassOf(a.args[1]));
    b('callable', (a) => {
      const v = a.args[0];
      return v instanceof PyFunction || v instanceof PyBuiltin || v instanceof PyBound || v instanceof PyClass || (v instanceof PyInstance && !!v.cls.lookup('__call__'));
    });
    bb('getattr', function* (a) {
      try {
        return yield* self.getattr(a.args[0], self.str(a.args[1]));
      } catch (e) {
        if (a.args.length > 2 && e instanceof PyError && e.exc.cls.name === 'AttributeError') return a.args[2];
        throw e;
      }
    });
    bb('setattr', function* (a) {
      yield* self.setattr(a.args[0], self.str(a.args[1]), a.args[2]);
      return null;
    });
    bb('hasattr', function* (a) {
      try {
        yield* self.getattr(a.args[0], self.str(a.args[1]));
        return true;
      } catch (e) {
        if (e instanceof PyError) return false;
        throw e;
      }
    });
    b('repr', (a) => this.repr(a.args[0]));
    b('ascii', (a) => this.repr(a.args[0]));
    b('chr', (a) => String.fromCodePoint(Number(this.toBig(a.args[0]))));
    b('ord', (a) => {
      const s = this.str(a.args[0]);
      if ([...s].length !== 1) throw this.error('TypeError', `ord() expected a character, but string of length ${[...s].length} found`);
      return BigInt(s.codePointAt(0)!);
    });
    const radix = (name: string, base: number, prefix: string) =>
      b(name, (a) => {
        const v = this.toBig(a.args[0]);
        return (v < 0n ? '-' : '') + prefix + (v < 0n ? -v : v).toString(base);
      });
    radix('hex', 16, '0x');
    radix('bin', 2, '0b');
    radix('oct', 8, '0o');
    b('divmod', (a) => {
      return new PyTuple([this.runSync(this.binop('//', a.args[0], a.args[1])), this.runSync(this.binop('%', a.args[0], a.args[1]))]);
    });
    b('pow', (a) => {
      const r = this.runSync(this.binop('**', a.args[0], a.args[1]));
      if (a.args.length > 2 && a.args[2] !== null) return this.runSync(this.binop('%', r, a.args[2]));
      return r;
    });
    bb('format', function* (a) {
      return yield* self.format(a.args[0], a.args.length > 1 ? self.str(a.args[1]) : '');
    });
    b('id', () => BigInt(Math.floor(this.random() * 1e9)));
    b('hash', (a) => {
      const k = String(PyDict.keyOf(a.args[0]));
      let h = 0;
      for (let i = 0; i < k.length; i++) h = (Math.imul(h, 31) + k.charCodeAt(i)) | 0;
      return BigInt(h);
    });
    b('super', () => {
      throw this.error('RuntimeError', 'super(): use it inside a method, as super().method(...)');
    });
    b('exit', () => {
      throw new PyError(this.makeExc('SystemExit'), this.line);
    });
    this.builtins.set('quit', this.builtins.get('exit')!);
    b('globals', () => {
      const d = new PyDict();
      for (const [k, v] of this.globals) d.set(k, v);
      return d;
    });
    b('vars', (a) => {
      const d = new PyDict();
      const o = a.args[0];
      if (o instanceof PyInstance) for (const [k, v] of o.dict) d.set(k, v);
      return d;
    });
    this.builtins.set('property', this.fn('property', (a) => {
      const getter = a.args[0];
      const prop = new PyProperty((obj) => this.runSync(this.call(getter, [obj])));
      return prop;
    }));
    this.builtins.set('staticmethod', this.fn('staticmethod', (a) => a.args[0]));
    this.builtins.set('NotImplemented', null);
    this.builtins.set('Ellipsis', null);
  }

  /** super(): the method's class, from the scope the call is made in. */
  makeSuper(scope: Scope): PyValue {
    const m = scope.method ?? scope.parent?.method;
    if (!m) throw this.error('RuntimeError', 'super(): no arguments');
    // self is the method's first parameter, the first local it bound.
    const self = [...scope.vars.values()][0] ?? m.self;
    const proxy = new PyInstance(new PyClass('super', []));
    const next = m.cls.mro.slice(1);
    proxy.native.lookup = (name: string) => {
      for (const c of next) if (c.dict.has(name)) return c.dict.get(name);
      return undefined;
    };
    proxy.native.self = self;
    return proxy;
  }

  private *extreme(a: CallArgs, sign: number): Run<PyValue> {
    const items = a.args.length === 1 ? [...(yield* this.iterate(a.args[0]))] : a.args;
    if (!items.length) {
      if (a.kwargs.has('default')) return a.kwargs.get('default')!;
      throw this.error('ValueError', `${sign > 0 ? 'max' : 'min'}() arg is an empty sequence`);
    }
    const key = a.kwargs.get('key') ?? null;
    let best = items[0];
    let bestKey = key === null ? best : yield* this.call(key, [best]);
    for (const x of items.slice(1)) {
      const k = key === null ? x : yield* this.call(key, [x]);
      if (this.order(k, bestKey) * sign > 0) {
        best = x;
        bestKey = k;
      }
    }
    return best;
  }

  /** Runs a generator that cannot wait (arithmetic and the like) to its result. */
  runSync<T>(g: Run<T>): T {
    let r = g.next();
    while (!r.done) r = g.next();
    return r.value;
  }

  // -------------------------------------------------------- native classes

  /**
   * A class implemented natively, for modules like gpiozero: `init` sets up
   * an instance's native state, `methods` and `props` become its attributes.
   */
  nativeClass(
    name: string,
    spec: {
      init?: (self: PyInstance, a: CallArgs) => void;
      methods?: Record<string, (self: PyInstance, a: CallArgs) => PyValue | Run<PyValue>>;
      blocking?: string[];
      props?: Record<string, { get: (self: PyInstance) => PyValue; set?: (self: PyInstance, v: PyValue) => void }>;
      base?: PyClass;
    },
  ): PyClass {
    const cls = new PyClass(name, [spec.base ?? this.types.get('object')!]);
    if (spec.init) {
      const init = spec.init;
      cls.dict.set('__init__', new PyBuiltin('__init__', (a, self) => {
        init(self as PyInstance, a);
        return null;
      }));
    }
    for (const [n, f] of Object.entries(spec.methods ?? {})) {
      cls.dict.set(n, new PyBuiltin(n, (a, self) => f(self as PyInstance, a), spec.blocking?.includes(n) ?? false));
    }
    for (const [n, p] of Object.entries(spec.props ?? {})) {
      cls.dict.set(n, new PyProperty((self) => p.get(self as PyInstance), p.set ? (self, v) => p.set!(self as PyInstance, v) : undefined));
    }
    return cls;
  }
}

// The scheduler type is shared with the runner.
export type { Wait };
