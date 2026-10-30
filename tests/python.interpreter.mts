// CircuitDesk's Python interpreter (the Raspberry Pi runtime) against what
// CPython 3.11 prints for the same programs. Each expected string below is
// CPython's own output for the snippet beside it.

import { Interpreter } from '../src/simulation/python/interpreter';
import { PyError } from '../src/simulation/python/values';
import { PySyntaxError } from '../src/simulation/python/lexer';

let failures = 0;
function check(cond: boolean, msg: string) {
  console.log(cond ? 'PASS:' : 'FAIL:', msg);
  if (!cond) failures++;
}

/** Runs a program to the end on simulated time; returns what it printed (or its error). */
function run(src: string): string {
  let out = '';
  let now = 0;
  const py = new Interpreter({ write: (s) => (out += s), readLine: () => undefined, module: () => undefined, nowMs: () => now });
  try {
    const g = py.runModule(src);
    for (let r = g.next(); !r.done; r = g.next()) {
      const w = r.value;
      if (w.k === 'sleep') now += w.ms;
      if (w.k === 'tick') now += w.us / 1000;
    }
  } catch (e) {
    if (e instanceof PyError) out += `!${py.describe(e)}`;
    else if (e instanceof PySyntaxError) out += `!SyntaxError line ${e.line}`;
    else throw e;
  }
  return out;
}

const cases: [string, string, string][] = [
  ['integer arithmetic is exact and floors', 'print(7 // 2, -7 // 2, -7 % 3, 2 ** 70, 10 % -3)', '3 -4 2 1180591620717411303424 -2\n'],
  ['true division is float', 'print(7 / 2, 4 / 2, 1 / 3)', '3.5 2.0 0.3333333333333333\n'],
  ['float repr', 'print(1e-5, 1e16, 0.1 + 0.2, 1.5e300 * 1e10, -0.0, 100.0)', '1e-05 1e+16 0.30000000000000004 inf -0.0 100.0\n'],
  ['round half to even', 'print(round(2.5), round(3.5), round(2.675, 2), round(0.125, 2), round(7))', '2 4 2.67 0.12 7\n'],
  ['f-strings and format specs', 'n="Pi"\nprint(f"{n!r} {3.14159:.2f} {42:05d} {255:#x} {1234567:,} {\'x\':>4}| {0.5:.0%} {7:b}")', "'Pi' 3.14 00042 0xff 1,234,567    x| 50% 111\n"],
  ['%-formatting', 'print("%s=%d %.1f %5.2f|%-4s|" % ("n", 5, 2.25, 3.14159, "ab"))', 'n=5 2.2  3.14|ab  |\n'],
  ['str.format', 'print("{} + {} = {total}".format(1, 2, total=3), "{0:>3}|{0:<3}|".format(7))', '1 + 2 = 3   7|7  |\n'],
  ['comprehensions', 'print([x*x for x in range(6) if x % 2 == 0], {k: v for k, v in zip("abc", [1,2,3])}, {x % 3 for x in range(9)})', "[0, 4, 16] {'a': 1, 'b': 2, 'c': 3} {0, 1, 2}\n"],
  ['unpacking and star', 'a, *b, c = [1, 2, 3, 4]\nx, y = y, x = 1, 2\nprint(a, b, c, x, y)', '1 [2, 3] 4 2 1\n'],
  ['closures and nonlocal', 'def counter():\n    n = 0\n    def inc():\n        nonlocal n\n        n += 1\n        return n\n    return inc\nc = counter()\nc(); c()\nprint(c())', '3\n'],
  ['default and keyword arguments', 'def f(a, b=2, *args, c=3, **kw):\n    return (a, b, args, c, kw)\nprint(f(1), f(1, 5, 6, 7, c=8, d=9))', "(1, 2, (), 3, {}) (1, 5, (6, 7), 8, {'d': 9})\n"],
  ['classes, inheritance and super()', 'class A:\n    def __init__(self, n):\n        self.n = n\n    def who(self):\n        return "A" + str(self.n)\nclass B(A):\n    def __init__(self, n):\n        super().__init__(n * 2)\n    def who(self):\n        return "B/" + super().who()\nb = B(3)\nprint(b.who(), isinstance(b, A), isinstance(3, int), isinstance(True, int))', 'B/A6 True True True\n'],
  ['try / except / else / finally', 'def f(x):\n    try:\n        r = 10 / x\n    except ZeroDivisionError as e:\n        return "zero: " + str(e)\n    else:\n        return r\n    finally:\n        print("finally", x)\nprint(f(2), f(0))', 'finally 2\nfinally 0\n5.0 zero: division by zero\n'],
  ['raise and custom exceptions', 'class Oops(Exception):\n    pass\ntry:\n    raise Oops("bad")\nexcept Exception as e:\n    print(type(e).__name__, e)', 'Oops bad\n'],
  ['for/else and while/else', 'for i in range(3):\n    pass\nelse:\n    print("done", i)\nn = 0\nwhile n < 5:\n    n += 1\n    if n == 3: break\nelse:\n    print("no")\nprint(n)', 'done 2\n3\n'],
  ['strings', 'print("a,b,,c".split(","), " x ".strip(), "-".join(["1","2"]), "Hello"[1:4], "abc"[::-1], "ab" * 3, "x".zfill(3))', "['a', 'b', '', 'c'] x 1-2 ell cba ababab 00x\n"],
  ['lists and dicts', 'l = [3, 1, 2]\nl.sort()\nl.append(9)\nd = {"a": 1}\nd["b"] = 2\nprint(l, l[-1], l[1:3], d.get("z", 0), list(d.items()), len(d), 2 in l, sorted(d, reverse=True))', "[1, 2, 3, 9] 9 [2, 3] 0 [('a', 1), ('b', 2)] 2 True ['b', 'a']\n"],
  ['builtins', 'print(max([1, 5, 3]), min(4, 2, 8), sum(range(10)), abs(-3), any([0, 1]), all([1, 0]), list(map(str, [1, 2])), divmod(17, 5), hex(255), chr(65), ord("a"))', "5 2 45 3 True False ['1', '2'] (3, 2) 0xff A 97\n"],
  ['enumerate, zip, reversed', 'for i, (a, b) in enumerate(zip("xy", [1, 2]), 1):\n    print(i, a, b)\nprint(list(reversed([1, 2, 3])))', '1 x 1\n2 y 2\n[3, 2, 1]\n'],
  ['lambda and sorted by key', 'pts = [(1, "b"), (0, "c"), (2, "a")]\nprint(sorted(pts, key=lambda p: p[1]))', "[(2, 'a'), (1, 'b'), (0, 'c')]\n"],
  ['int() and float() parsing', 'print(int("42"), int("ff", 16), int(3.9), float("2.5"), int("-7"))', '42 255 3 2.5 -7\n'],
  ['NameError', 'print(nope)', "!NameError: name 'nope' is not defined"],
  ['TypeError', 'print("a" + 1)', "!TypeError: unsupported operand type(s) for +: 'str' and 'int'"],
  ['IndexError', 'print([1][5])', '!IndexError: index out of range'],
  ['KeyError', 'print({}["k"])', "!KeyError: 'k'"],
  ['syntax error line', 'x = 1\nif x\n    pass', '!SyntaxError line 2'],
  ['time.sleep is simulated time', 'import time\nt = time.monotonic()\ntime.sleep(1.5)\nprint(round(time.monotonic() - t, 3))', '1.5\n'],
];

for (const [name, src, expected] of cases) {
  const got = run(src);
  check(got === expected, `${name}${got === expected ? '' : ` — expected ${JSON.stringify(expected)}, got ${JSON.stringify(got)}`}`);
}

console.log(`\n--- ${failures} failing`);
process.exit(failures ? 1 : 0);
