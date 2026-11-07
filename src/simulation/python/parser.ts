// A recursive-descent parser for the Python subset the Raspberry Pi headers
// run: the statements and expressions GPIO scripts are written with —
// functions, classes, loops, try/except, comprehensions, f-strings, lambdas.
// What it does not parse is reported as a SyntaxError with its line, which is
// how CPython would report it too.

import { PySyntaxError, tokenize, type Token } from './lexer';

export type Expr =
  | { k: 'num'; v: number; int: boolean; line: number }
  | { k: 'str'; v: string; line: number }
  | { k: 'fstr'; parts: (string | { e: Expr; spec: string; conv: string })[]; line: number }
  | { k: 'name'; id: string; line: number }
  | { k: 'const'; v: 'None' | 'True' | 'False'; line: number }
  | { k: 'attr'; obj: Expr; name: string; line: number }
  | { k: 'call'; func: Expr; args: Arg[]; line: number }
  | { k: 'sub'; obj: Expr; index: Expr; line: number }
  | { k: 'slice'; lo?: Expr; hi?: Expr; step?: Expr; line: number }
  | { k: 'bin'; op: string; l: Expr; r: Expr; line: number }
  | { k: 'unary'; op: string; e: Expr; line: number }
  | { k: 'bool'; op: 'and' | 'or'; values: Expr[]; line: number }
  | { k: 'compare'; left: Expr; ops: string[]; rights: Expr[]; line: number }
  | { k: 'ifexp'; test: Expr; body: Expr; orelse: Expr; line: number }
  | { k: 'list' | 'tuple' | 'set'; elts: Expr[]; line: number }
  | { k: 'dict'; keys: Expr[]; values: Expr[]; line: number }
  | { k: 'lambda'; params: Param[]; body: Expr; line: number }
  | { k: 'comp'; kind: 'list' | 'set' | 'gen' | 'dict'; elt: Expr; value?: Expr; gens: CompFor[]; line: number }
  | { k: 'star'; e: Expr; line: number };

export interface Arg {
  kind: 'pos' | 'kw' | 'star' | 'dstar';
  name?: string;
  value: Expr;
}

export interface Param {
  name: string;
  def?: Expr;
  kind: 'pos' | 'star' | 'dstar';
}

export interface CompFor {
  target: Expr;
  iter: Expr;
  ifs: Expr[];
}

export type Stmt =
  | { k: 'expr'; e: Expr; line: number }
  | { k: 'assign'; targets: Expr[]; value: Expr; line: number }
  | { k: 'augassign'; target: Expr; op: string; value: Expr; line: number }
  | { k: 'if'; test: Expr; body: Stmt[]; orelse: Stmt[]; line: number }
  | { k: 'while'; test: Expr; body: Stmt[]; orelse: Stmt[]; line: number }
  | { k: 'for'; target: Expr; iter: Expr; body: Stmt[]; orelse: Stmt[]; line: number }
  | { k: 'break' | 'continue' | 'pass'; line: number }
  | { k: 'def'; name: string; params: Param[]; body: Stmt[]; decorators: Expr[]; line: number }
  | { k: 'class'; name: string; bases: Expr[]; body: Stmt[]; decorators: Expr[]; line: number }
  | { k: 'return'; value?: Expr; line: number }
  | { k: 'import'; names: [string, string | undefined][]; line: number }
  | { k: 'from'; module: string; names: [string, string | undefined][] | '*'; line: number }
  | { k: 'try'; body: Stmt[]; handlers: { type?: Expr; name?: string; body: Stmt[] }[]; orelse: Stmt[]; final: Stmt[]; line: number }
  | { k: 'raise'; exc?: Expr; line: number }
  | { k: 'global' | 'nonlocal'; names: string[]; line: number }
  | { k: 'with'; items: { ctx: Expr; as?: Expr }[]; body: Stmt[]; line: number }
  | { k: 'del'; targets: Expr[]; line: number }
  | { k: 'assert'; test: Expr; msg?: Expr; line: number };

const COMPARE_OPS = new Set(['<', '>', '==', '>=', '<=', '!=', 'in', 'not in', 'is', 'is not']);
const AUG_OPS = new Set(['+=', '-=', '*=', '/=', '//=', '%=', '**=', '&=', '|=', '^=', '>>=', '<<=']);

export function parse(source: string): Stmt[] {
  return new Parser(tokenize(source)).module();
}

class Parser {
  private pos = 0;

  constructor(private readonly toks: Token[]) {}

  private get t(): Token {
    return this.toks[this.pos];
  }

  private peek(n = 1): Token {
    return this.toks[Math.min(this.pos + n, this.toks.length - 1)];
  }

  private isOp(v: string): boolean {
    return this.t.type === 'op' && this.t.value === v;
  }

  private isName(v: string): boolean {
    return this.t.type === 'name' && this.t.value === v;
  }

  private next(): Token {
    return this.toks[this.pos++];
  }

  private fail(msg = 'invalid syntax', t: Token = this.t): never {
    throw new PySyntaxError(msg, t.line, t.col);
  }

  private expectOp(v: string): Token {
    if (!this.isOp(v)) this.fail(`expected '${v}'`);
    return this.next();
  }

  private expectName(v?: string): string {
    if (this.t.type !== 'name' || (v !== undefined && this.t.value !== v)) this.fail(v ? `expected '${v}'` : 'expected a name');
    return this.next().value;
  }

  module(): Stmt[] {
    const body: Stmt[] = [];
    while (this.t.type !== 'eof') {
      if (this.t.type === 'newline') {
        this.next();
        continue;
      }
      body.push(...this.statement());
    }
    return body;
  }

  private block(): Stmt[] {
    this.expectOp(':');
    // A local, not this.t: TypeScript would keep this.t narrowed to 'newline' past the next() calls below.
    const first: Token = this.t;
    if (first.type !== 'newline') return this.simpleLine();
    this.next();
    if (this.peek(0).type !== 'indent') this.fail('expected an indented block');
    this.next();
    const body: Stmt[] = [];
    while (this.t.type !== 'dedent' && this.t.type !== 'eof') {
      if (this.t.type === 'newline') {
        this.next();
        continue;
      }
      body.push(...this.statement());
    }
    if (this.t.type === 'dedent') this.next();
    return body;
  }

  private statement(): Stmt[] {
    const t = this.t;
    if (t.type === 'op' && t.value === '@') {
      const decorators: Expr[] = [];
      while (this.isOp('@')) {
        this.next();
        decorators.push(this.expr());
        if (this.t.type === 'newline') this.next();
      }
      const s = this.statement()[0];
      if (s.k !== 'def' && s.k !== 'class') this.fail('decorators apply to functions and classes', t);
      s.decorators = decorators;
      return [s];
    }
    if (t.type === 'name') {
      switch (t.value) {
        case 'if': return [this.ifStmt()];
        case 'while': {
          this.next();
          const test = this.namedExpr();
          const body = this.block();
          return [{ k: 'while', test, body, orelse: this.elseBlock(), line: t.line }];
        }
        case 'for': {
          this.next();
          const target = this.targetList();
          this.expectName('in');
          const iter = this.exprList();
          const body = this.block();
          return [{ k: 'for', target, iter, body, orelse: this.elseBlock(), line: t.line }];
        }
        case 'def': return [this.funcDef()];
        case 'class': {
          this.next();
          const name = this.expectName();
          let bases: Expr[] = [];
          if (this.isOp('(')) {
            this.next();
            bases = this.isOp(')') ? [] : this.callArgs().map((a) => a.value);
            this.expectOp(')');
          }
          return [{ k: 'class', name, bases, body: this.block(), decorators: [], line: t.line }];
        }
        case 'try': return [this.tryStmt()];
        case 'with': {
          this.next();
          const items: { ctx: Expr; as?: Expr }[] = [];
          do {
            if (items.length) this.next();
            const ctx = this.expr();
            let as: Expr | undefined;
            if (this.isName('as')) {
              this.next();
              as = this.atomTarget();
            }
            items.push({ ctx, as });
          } while (this.isOp(','));
          return [{ k: 'with', items, body: this.block(), line: t.line }];
        }
      }
    }
    return this.simpleLine();
  }

  private elseBlock(): Stmt[] {
    if (this.isName('else')) {
      this.next();
      return this.block();
    }
    return [];
  }

  private ifStmt(): Stmt {
    const t = this.next();
    const test = this.namedExpr();
    const body = this.block();
    let orelse: Stmt[] = [];
    if (this.isName('elif')) orelse = [this.ifStmt()];
    else if (this.isName('else')) {
      this.next();
      orelse = this.block();
    }
    return { k: 'if', test, body, orelse, line: t.line };
  }

  private tryStmt(): Stmt {
    const t = this.next();
    const body = this.block();
    const handlers: { type?: Expr; name?: string; body: Stmt[] }[] = [];
    while (this.isName('except')) {
      this.next();
      let type: Expr | undefined;
      let name: string | undefined;
      if (!this.isOp(':')) {
        type = this.expr();
        if (this.isName('as')) {
          this.next();
          name = this.expectName();
        }
      }
      handlers.push({ type, name, body: this.block() });
    }
    const orelse = this.elseBlock();
    let final: Stmt[] = [];
    if (this.isName('finally')) {
      this.next();
      final = this.block();
    }
    if (!handlers.length && !final.length) this.fail("expected 'except' or 'finally' block");
    return { k: 'try', body, handlers, orelse, final, line: t.line };
  }

  private funcDef(): Stmt {
    const t = this.next();
    const name = this.expectName();
    this.expectOp('(');
    const params = this.params(')');
    this.expectOp(')');
    if (this.isOp('->')) {
      this.next();
      this.expr();
    }
    return { k: 'def', name, params, body: this.block(), decorators: [], line: t.line };
  }

  private params(end: string): Param[] {
    const params: Param[] = [];
    while (!this.isOp(end)) {
      if (this.isOp('*') || this.isOp('**')) {
        const kind = this.next().value === '*' ? 'star' : 'dstar';
        if (this.t.type === 'name') params.push({ name: this.next().value, kind });
      } else if (this.isOp('/')) this.next();
      else {
        const name = this.expectName();
        if (this.isOp(':') && end === ')') {
          this.next();
          this.expr();
        }
        let def: Expr | undefined;
        if (this.isOp('=')) {
          this.next();
          def = this.expr();
        }
        params.push({ name, def, kind: 'pos' });
      }
      if (!this.isOp(',')) break;
      this.next();
    }
    return params;
  }

  private simpleLine(): Stmt[] {
    const out = [this.smallStmt()];
    while (this.isOp(';')) {
      this.next();
      if (this.t.type === 'newline' || this.t.type === 'eof') break;
      out.push(this.smallStmt());
    }
    if (this.t.type === 'newline') this.next();
    else if (this.t.type !== 'eof' && this.t.type !== 'dedent') this.fail();
    return out;
  }

  private smallStmt(): Stmt {
    const t = this.t;
    if (t.type === 'name') {
      switch (t.value) {
        case 'pass':
        case 'break':
        case 'continue':
          this.next();
          return { k: t.value, line: t.line };
        case 'return': {
          this.next();
          const value = this.atLineEnd() ? undefined : this.exprList();
          return { k: 'return', value, line: t.line };
        }
        case 'raise': {
          this.next();
          const exc = this.atLineEnd() ? undefined : this.expr();
          if (this.isName('from')) {
            this.next();
            this.expr();
          }
          return { k: 'raise', exc, line: t.line };
        }
        case 'global':
        case 'nonlocal': {
          this.next();
          const names = [this.expectName()];
          while (this.isOp(',')) {
            this.next();
            names.push(this.expectName());
          }
          return { k: t.value, names, line: t.line };
        }
        case 'import': {
          this.next();
          const names: [string, string | undefined][] = [];
          do {
            if (names.length) this.next();
            const mod = this.dotted();
            let as: string | undefined;
            if (this.isName('as')) {
              this.next();
              as = this.expectName();
            }
            names.push([mod, as]);
          } while (this.isOp(','));
          return { k: 'import', names, line: t.line };
        }
        case 'from': {
          this.next();
          let module = '';
          while (this.isOp('.')) module += this.next().value;
          module += this.t.type === 'name' && this.t.value !== 'import' ? this.dotted() : '';
          this.expectName('import');
          if (this.isOp('*')) {
            this.next();
            return { k: 'from', module, names: '*', line: t.line };
          }
          const paren = this.isOp('(');
          if (paren) this.next();
          const names: [string, string | undefined][] = [];
          while (this.t.type === 'name') {
            const name = this.next().value;
            let as: string | undefined;
            if (this.isName('as')) {
              this.next();
              as = this.expectName();
            }
            names.push([name, as]);
            if (!this.isOp(',')) break;
            this.next();
          }
          if (paren) this.expectOp(')');
          return { k: 'from', module, names, line: t.line };
        }
        case 'del': {
          this.next();
          const targets = [this.expr()];
          while (this.isOp(',')) {
            this.next();
            targets.push(this.expr());
          }
          return { k: 'del', targets, line: t.line };
        }
        case 'assert': {
          this.next();
          const test = this.expr();
          let msg: Expr | undefined;
          if (this.isOp(',')) {
            this.next();
            msg = this.expr();
          }
          return { k: 'assert', test, msg, line: t.line };
        }
      }
    }
    const first = this.exprList(true);
    if (this.t.type === 'op' && AUG_OPS.has(this.t.value)) {
      const op = this.next().value.slice(0, -1);
      this.checkTarget(first);
      return { k: 'augassign', target: first, op, value: this.exprList(), line: t.line };
    }
    if (this.isOp(':')) {
      // An annotated assignment: x: int = 5.
      this.next();
      this.expr();
      if (!this.isOp('=')) return { k: 'pass', line: t.line };
    }
    if (this.isOp('=')) {
      const targets = [first];
      let value: Expr = first;
      while (this.isOp('=')) {
        this.next();
        value = this.exprList(true);
        targets.push(value);
      }
      targets.pop();
      targets.forEach((x) => this.checkTarget(x));
      return { k: 'assign', targets, value, line: t.line };
    }
    return { k: 'expr', e: first, line: t.line };
  }

  private checkTarget(e: Expr): void {
    if (e.k === 'name' || e.k === 'attr' || e.k === 'sub') return;
    if ((e.k === 'tuple' || e.k === 'list') && e.elts.every((x) => (x.k === 'star' ? this.checkTarget(x.e) ?? true : this.checkTarget(x) ?? true))) return;
    if (e.k === 'star') return this.checkTarget(e.e);
    throw new PySyntaxError('cannot assign to expression', e.line);
  }

  private atLineEnd(): boolean {
    return this.t.type === 'newline' || this.t.type === 'eof' || this.isOp(';');
  }

  private dotted(): string {
    let name = this.expectName();
    while (this.isOp('.')) {
      this.next();
      name += '.' + this.expectName();
    }
    return name;
  }

  // ------------------------------------------------------------ expressions

  /** a, b, c — a tuple when there is a comma. */
  private exprList(allowStar = false): Expr {
    const line = this.t.line;
    const first = allowStar && this.isOp('*') ? this.starExpr() : this.expr();
    if (!this.isOp(',')) return first;
    const elts = [first];
    while (this.isOp(',')) {
      this.next();
      if (this.atLineEnd() || this.isOp('=') || this.isOp(')') || (this.t.type === 'op' && AUG_OPS.has(this.t.value))) break;
      elts.push(allowStar && this.isOp('*') ? this.starExpr() : this.expr());
    }
    return { k: 'tuple', elts, line };
  }

  private starExpr(): Expr {
    const line = this.next().line;
    return { k: 'star', e: this.orExpr(), line };
  }

  /** The target of a for loop: names, attributes, subscripts, tuples of them. */
  private targetList(): Expr {
    const line = this.t.line;
    const first = this.atomTarget();
    if (!this.isOp(',')) return first;
    const elts = [first];
    while (this.isOp(',')) {
      this.next();
      if (this.isName('in')) break;
      elts.push(this.atomTarget());
    }
    return { k: 'tuple', elts, line };
  }

  private atomTarget(): Expr {
    if (this.isOp('*')) return this.starExpr();
    // Below comparisons, so the 'in' of a for loop is not taken as one.
    const e = this.bitOr();
    this.checkTarget(e);
    return e;
  }

  private namedExpr(): Expr {
    const e = this.expr();
    if (this.isOp(':=')) this.fail('assignment expressions are not supported');
    return e;
  }

  expr(): Expr {
    if (this.isName('lambda')) {
      const line = this.next().line;
      const params = this.params(':');
      this.expectOp(':');
      return { k: 'lambda', params, body: this.expr(), line };
    }
    const body = this.orExpr();
    if (this.isName('if')) {
      this.next();
      const test = this.orExpr();
      this.expectName('else');
      return { k: 'ifexp', test, body, orelse: this.expr(), line: body.line };
    }
    return body;
  }

  private orExpr(): Expr {
    let e = this.andExpr();
    if (!this.isName('or')) return e;
    const values = [e];
    while (this.isName('or')) {
      this.next();
      values.push(this.andExpr());
    }
    e = { k: 'bool', op: 'or', values, line: e.line };
    return e;
  }

  private andExpr(): Expr {
    const e = this.notExpr();
    if (!this.isName('and')) return e;
    const values = [e];
    while (this.isName('and')) {
      this.next();
      values.push(this.notExpr());
    }
    return { k: 'bool', op: 'and', values, line: e.line };
  }

  private notExpr(): Expr {
    if (this.isName('not')) {
      const line = this.next().line;
      return { k: 'unary', op: 'not', e: this.notExpr(), line };
    }
    return this.comparison();
  }

  private comparison(): Expr {
    const left = this.bitOr();
    const ops: string[] = [];
    const rights: Expr[] = [];
    while (true) {
      let op: string | null = null;
      if (this.t.type === 'op' && COMPARE_OPS.has(this.t.value)) op = this.next().value;
      else if (this.isName('in')) {
        this.next();
        op = 'in';
      } else if (this.isName('not') && this.peek().type === 'name' && this.peek().value === 'in') {
        this.next();
        this.next();
        op = 'not in';
      } else if (this.isName('is')) {
        this.next();
        op = 'is';
        if (this.isName('not')) {
          this.next();
          op = 'is not';
        }
      }
      if (!op) break;
      ops.push(op);
      rights.push(this.bitOr());
    }
    return ops.length ? { k: 'compare', left, ops, rights, line: left.line } : left;
  }

  private binary(next: () => Expr, ops: string[]): Expr {
    let l = next();
    while (this.t.type === 'op' && ops.includes(this.t.value)) {
      const op = this.next().value;
      l = { k: 'bin', op, l, r: next(), line: l.line };
    }
    return l;
  }

  private bitOr(): Expr {
    return this.binary(() => this.bitXor(), ['|']);
  }

  private bitXor(): Expr {
    return this.binary(() => this.bitAnd(), ['^']);
  }

  private bitAnd(): Expr {
    return this.binary(() => this.shift(), ['&']);
  }

  private shift(): Expr {
    return this.binary(() => this.arith(), ['<<', '>>']);
  }

  private arith(): Expr {
    return this.binary(() => this.term(), ['+', '-']);
  }

  private term(): Expr {
    return this.binary(() => this.factor(), ['*', '/', '//', '%', '@']);
  }

  private factor(): Expr {
    if (this.isOp('-') || this.isOp('+') || this.isOp('~')) {
      const t = this.next();
      return { k: 'unary', op: t.value, e: this.factor(), line: t.line };
    }
    return this.power();
  }

  private power(): Expr {
    const base = this.postfix();
    if (this.isOp('**')) {
      this.next();
      return { k: 'bin', op: '**', l: base, r: this.factor(), line: base.line };
    }
    return base;
  }

  private postfix(): Expr {
    let e = this.atom();
    while (true) {
      if (this.isOp('.')) {
        this.next();
        e = { k: 'attr', obj: e, name: this.expectName(), line: e.line };
      } else if (this.isOp('(')) {
        this.next();
        const args = this.isOp(')') ? [] : this.callArgs();
        this.expectOp(')');
        e = { k: 'call', func: e, args, line: e.line };
      } else if (this.isOp('[')) {
        this.next();
        const index = this.subscript();
        this.expectOp(']');
        e = { k: 'sub', obj: e, index, line: e.line };
      } else return e;
    }
  }

  private subscript(): Expr {
    const line = this.t.line;
    const one = (): Expr => {
      let lo: Expr | undefined;
      if (!this.isOp(':')) {
        lo = this.expr();
        if (!this.isOp(':')) return lo;
      }
      this.next();
      const hi = this.isOp(']') || this.isOp(':') || this.isOp(',') ? undefined : this.expr();
      let step: Expr | undefined;
      if (this.isOp(':')) {
        this.next();
        step = this.isOp(']') || this.isOp(',') ? undefined : this.expr();
      }
      return { k: 'slice', lo, hi, step, line };
    };
    const first = one();
    if (!this.isOp(',')) return first;
    const elts = [first];
    while (this.isOp(',')) {
      this.next();
      if (this.isOp(']')) break;
      elts.push(one());
    }
    return { k: 'tuple', elts, line };
  }

  private callArgs(): Arg[] {
    const args: Arg[] = [];
    while (!this.isOp(')')) {
      if (this.isOp('*') || this.isOp('**')) {
        const kind = this.next().value === '*' ? 'star' : 'dstar';
        args.push({ kind, value: this.expr() });
      } else if (this.t.type === 'name' && this.peek().type === 'op' && this.peek().value === '=') {
        const name = this.next().value;
        this.next();
        args.push({ kind: 'kw', name, value: this.expr() });
      } else {
        const value = this.expr();
        if (this.isName('for')) {
          args.push({ kind: 'pos', value: this.comprehension('gen', value, value.line) });
        } else args.push({ kind: 'pos', value });
      }
      if (!this.isOp(',')) break;
      this.next();
    }
    return args;
  }

  private comprehension(kind: 'list' | 'set' | 'gen' | 'dict', elt: Expr, line: number, value?: Expr): Expr {
    const gens: CompFor[] = [];
    while (this.isName('for')) {
      this.next();
      const target = this.targetList();
      this.expectName('in');
      const iter = this.orExpr();
      const ifs: Expr[] = [];
      while (this.isName('if')) {
        this.next();
        ifs.push(this.orExpr());
      }
      gens.push({ target, iter, ifs });
    }
    return { k: 'comp', kind, elt, value, gens, line };
  }

  private atom(): Expr {
    const t = this.t;
    switch (t.type) {
      case 'number': {
        this.next();
        const raw = t.value;
        if (raw.endsWith('j')) this.fail('complex numbers are not supported', t);
        if (/^0[xX]/.test(raw)) return { k: 'num', v: parseInt(raw.slice(2), 16), int: true, line: t.line };
        if (/^0[bB]/.test(raw)) return { k: 'num', v: parseInt(raw.slice(2), 2), int: true, line: t.line };
        if (/^0[oO]/.test(raw)) return { k: 'num', v: parseInt(raw.slice(2), 8), int: true, line: t.line };
        const isInt = /^\d+$/.test(raw);
        return { k: 'num', v: Number(raw), int: isInt, line: t.line };
      }
      case 'string':
      case 'fstring': {
        // Adjacent literals concatenate.
        const parts: (string | { e: Expr; spec: string; conv: string })[] = [];
        let fmt = false;
        while (this.t.type === 'string' || this.t.type === 'fstring') {
          const s = this.next();
          if (s.type === 'fstring') {
            fmt = true;
            parts.push(...parseFString(s.value, s.line));
          } else parts.push(s.value);
        }
        if (!fmt) return { k: 'str', v: parts.join(''), line: t.line };
        return { k: 'fstr', parts, line: t.line };
      }
      case 'name': {
        if (t.value === 'None' || t.value === 'True' || t.value === 'False') {
          this.next();
          return { k: 'const', v: t.value, line: t.line };
        }
        if (['if', 'else', 'elif', 'while', 'for', 'def', 'class', 'return', 'import', 'from', 'in', 'is', 'and', 'or', 'not', 'try', 'except', 'finally', 'with', 'as', 'pass', 'break', 'continue', 'global', 'nonlocal', 'raise', 'del', 'assert', 'yield', 'async', 'await'].includes(t.value)) {
          if (t.value === 'yield' || t.value === 'async' || t.value === 'await') this.fail(`'${t.value}' is not supported here`, t);
          this.fail();
        }
        this.next();
        return { k: 'name', id: t.value, line: t.line };
      }
      case 'op': {
        if (t.value === '(') {
          this.next();
          if (this.isOp(')')) {
            this.next();
            return { k: 'tuple', elts: [], line: t.line };
          }
          const first = this.isOp('*') ? this.starExpr() : this.expr();
          if (this.isName('for')) {
            const comp = this.comprehension('gen', first, t.line);
            this.expectOp(')');
            return comp;
          }
          if (this.isOp(')')) {
            this.next();
            return first;
          }
          const elts = [first];
          while (this.isOp(',')) {
            this.next();
            if (this.isOp(')')) break;
            elts.push(this.isOp('*') ? this.starExpr() : this.expr());
          }
          this.expectOp(')');
          return { k: 'tuple', elts, line: t.line };
        }
        if (t.value === '[') {
          this.next();
          if (this.isOp(']')) {
            this.next();
            return { k: 'list', elts: [], line: t.line };
          }
          const first = this.isOp('*') ? this.starExpr() : this.expr();
          if (this.isName('for')) {
            const comp = this.comprehension('list', first, t.line);
            this.expectOp(']');
            return comp;
          }
          const elts = [first];
          while (this.isOp(',')) {
            this.next();
            if (this.isOp(']')) break;
            elts.push(this.isOp('*') ? this.starExpr() : this.expr());
          }
          this.expectOp(']');
          return { k: 'list', elts, line: t.line };
        }
        if (t.value === '{') {
          this.next();
          if (this.isOp('}')) {
            this.next();
            return { k: 'dict', keys: [], values: [], line: t.line };
          }
          const first = this.expr();
          if (this.isOp(':')) {
            this.next();
            const v = this.expr();
            if (this.isName('for')) {
              const comp = this.comprehension('dict', first, t.line, v);
              this.expectOp('}');
              return comp;
            }
            const keys = [first];
            const values = [v];
            while (this.isOp(',')) {
              this.next();
              if (this.isOp('}')) break;
              keys.push(this.expr());
              this.expectOp(':');
              values.push(this.expr());
            }
            this.expectOp('}');
            return { k: 'dict', keys, values, line: t.line };
          }
          if (this.isName('for')) {
            const comp = this.comprehension('set', first, t.line);
            this.expectOp('}');
            return comp;
          }
          const elts = [first];
          while (this.isOp(',')) {
            this.next();
            if (this.isOp('}')) break;
            elts.push(this.expr());
          }
          this.expectOp('}');
          return { k: 'set', elts, line: t.line };
        }
        if (t.value === '...') {
          this.next();
          return { k: 'const', v: 'None', line: t.line };
        }
      }
    }
    if (t.type === 'indent') this.fail('unexpected indent', t);
    if (t.type === 'eof' || t.type === 'newline') this.fail('unexpected end of line', t);
    this.fail();
  }
}

/** Splits an f-string into literal text and {expression!conv:spec} fields. */
function parseFString(s: string, line: number): (string | { e: Expr; spec: string; conv: string })[] {
  const parts: (string | { e: Expr; spec: string; conv: string })[] = [];
  let text = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '{' && s[i + 1] === '{') {
      text += '{';
      i++;
      continue;
    }
    if (c === '}' && s[i + 1] === '}') {
      text += '}';
      i++;
      continue;
    }
    if (c !== '{') {
      text += c;
      continue;
    }
    // Find the matching close, respecting nested brackets and quotes.
    let depth = 0;
    let j = i + 1;
    let quote = '';
    let exprEnd = -1;
    let convAt = -1;
    let specAt = -1;
    for (; j < s.length; j++) {
      const d = s[j];
      if (quote) {
        if (d === quote) quote = '';
        continue;
      }
      if (d === "'" || d === '"') quote = d;
      else if (d === '(' || d === '[' || d === '{') depth++;
      else if ((d === ')' || d === ']' || d === '}') && depth > 0) depth--;
      else if (depth === 0 && d === '!' && s[j + 1] !== '=' && convAt < 0 && specAt < 0) convAt = j;
      else if (depth === 0 && d === ':' && specAt < 0) specAt = j;
      else if (depth === 0 && d === '}') {
        exprEnd = j;
        break;
      }
    }
    if (exprEnd < 0) throw new PySyntaxError("f-string: expecting '}'", line);
    const exprStop = convAt >= 0 ? convAt : specAt >= 0 ? specAt : exprEnd;
    let source = s.slice(i + 1, exprStop);
    let debug = false;
    if (source.trimEnd().endsWith('=') && !/[=!<>]=$/.test(source.trimEnd())) {
      debug = true;
      source = source.trimEnd().slice(0, -1);
    }
    const conv = convAt >= 0 ? s.slice(convAt + 1, specAt >= 0 ? specAt : exprEnd) : debug ? 'r' : '';
    const spec = specAt >= 0 ? s.slice(specAt + 1, exprEnd) : '';
    if (text) parts.push(text);
    text = debug ? source + '=' : '';
    if (text) {
      parts.push(text);
      text = '';
    }
    const stmts = parse(source.trim());
    const only = stmts[0];
    if (stmts.length !== 1 || only.k !== 'expr') throw new PySyntaxError('f-string: invalid expression', line);
    const fix = (e: Expr) => {
      e.line = line;
    };
    fix(only.e);
    parts.push({ e: only.e, spec, conv });
    i = exprEnd;
  }
  if (text) parts.push(text);
  return parts;
}
