// Tokens of the Python subset CircuitDesk runs on its Raspberry Pi headers.
//
// Indentation becomes INDENT/DEDENT tokens, as in CPython's tokenizer; lines
// inside brackets continue, as does a line ending in a backslash. Strings are
// single, double and triple quoted, with the usual escapes and f-strings.

export type TokenType = 'name' | 'number' | 'string' | 'fstring' | 'op' | 'newline' | 'indent' | 'dedent' | 'eof';

export interface Token {
  type: TokenType;
  value: string;
  line: number;
  col: number;
}

export class PySyntaxError extends Error {
  constructor(
    message: string,
    readonly line: number,
    readonly col = 0,
  ) {
    super(message);
  }
}

const OPERATORS = [
  '**=', '//=', '>>=', '<<=', '->', '...',
  '**', '//', '==', '!=', '<=', '>=', '<<', '>>', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', ':=',
  '+', '-', '*', '/', '%', '@', '<', '>', '=', '(', ')', '[', ']', '{', '}', ',', ':', '.', ';', '&', '|', '^', '~',
];

const ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', '0': '\0', '\\': '\\', "'": "'", '"': '"', a: '\x07', b: '\b', f: '\f', v: '\v' };

function unescape(raw: string, line: number): string {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c !== '\\') {
      out += c;
      continue;
    }
    const n = raw[++i];
    if (n === undefined) break;
    if (n === '\n') continue;
    if (n === 'x') {
      out += String.fromCharCode(parseInt(raw.slice(i + 1, i + 3), 16));
      i += 2;
    } else if (n === 'u') {
      out += String.fromCharCode(parseInt(raw.slice(i + 1, i + 5), 16));
      i += 4;
    } else if (n in ESCAPES) out += ESCAPES[n];
    else if (/[0-7]/.test(n)) {
      let oct = n;
      while (oct.length < 3 && /[0-7]/.test(raw[i + 1] ?? '')) oct += raw[++i];
      out += String.fromCharCode(parseInt(oct, 8));
    } else out += '\\' + n;
  }
  void line;
  return out;
}

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  const indents = [0];
  let depth = 0; // bracket nesting
  let i = 0;
  let line = 1;
  let lineStart = 0;
  let atLineStart = true;
  const src = source.replace(/\r\n?/g, '\n');

  const push = (type: TokenType, value: string, at = i) => tokens.push({ type, value, line, col: at - lineStart + 1 });

  while (i < src.length) {
    if (atLineStart && depth === 0) {
      // Measure indentation; blank and comment-only lines do not count.
      let width = 0;
      let j = i;
      while (j < src.length && (src[j] === ' ' || src[j] === '\t')) {
        width += src[j] === '\t' ? 8 - (width % 8) : 1;
        j++;
      }
      if (j >= src.length || src[j] === '\n' || src[j] === '#') {
        while (j < src.length && src[j] !== '\n') j++;
        i = j + 1;
        line++;
        lineStart = i;
        continue;
      }
      i = j;
      atLineStart = false;
      const current = indents[indents.length - 1];
      if (width > current) {
        indents.push(width);
        push('indent', '');
      } else {
        while (width < indents[indents.length - 1]) {
          indents.pop();
          push('dedent', '');
        }
        if (width !== indents[indents.length - 1]) throw new PySyntaxError('unindent does not match any outer indentation level', line);
      }
    }
    const c = src[i];
    if (c === '\n') {
      if (depth === 0) {
        if (tokens.length && tokens[tokens.length - 1].type !== 'newline') push('newline', '');
        atLineStart = true;
      }
      i++;
      line++;
      lineStart = i;
      continue;
    }
    if (c === ' ' || c === '\t') {
      i++;
      continue;
    }
    if (c === '#') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '\\' && src[i + 1] === '\n') {
      i += 2;
      line++;
      lineStart = i;
      continue;
    }
    // Strings, with an optional prefix: f, r, b, rb, fr ...
    const prefix = /^([rRbBfFuU]{0,2})(['"])/.exec(src.slice(i, i + 3));
    if (prefix && (prefix[1] === '' || /^[rRbBfFuU]+$/.test(prefix[1]))) {
      const flags = prefix[1].toLowerCase();
      const start = i;
      i += prefix[1].length;
      const quote = src[i];
      const triple = src.slice(i, i + 3) === quote.repeat(3);
      const delim = triple ? quote.repeat(3) : quote;
      i += delim.length;
      const bodyStart = i;
      const startLine = line;
      while (true) {
        if (i >= src.length) throw new PySyntaxError('unterminated string literal', startLine);
        if (src[i] === '\\') {
          if (src[i + 1] === '\n') {
            line++;
            lineStart = i + 2;
          }
          i += 2;
          continue;
        }
        if (src.startsWith(delim, i)) break;
        if (src[i] === '\n') {
          if (!triple) throw new PySyntaxError('unterminated string literal', startLine);
          line++;
          lineStart = i + 1;
        }
        i++;
      }
      const body = src.slice(bodyStart, i);
      i += delim.length;
      const text = flags.includes('r') ? body : unescape(body, line);
      tokens.push({ type: flags.includes('f') ? 'fstring' : 'string', value: text, line: startLine, col: start - lineStart + 1 });
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const m = /^(0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d+)?j?)/.exec(src.slice(i));
      push('number', m![0].replace(/_/g, ''));
      i += m![0].length;
      continue;
    }
    if (/[A-Za-z_À-￿]/.test(c)) {
      const m = /^[A-Za-z_0-9À-￿]+/.exec(src.slice(i))!;
      push('name', m[0]);
      i += m[0].length;
      continue;
    }
    const op = OPERATORS.find((o) => src.startsWith(o, i));
    if (!op) throw new PySyntaxError(`invalid character '${c}'`, line, i - lineStart + 1);
    if (op === '(' || op === '[' || op === '{') depth++;
    if (op === ')' || op === ']' || op === '}') depth = Math.max(0, depth - 1);
    push('op', op);
    i += op.length;
  }
  if (tokens.length && tokens[tokens.length - 1].type !== 'newline') push('newline', '');
  while (indents.length > 1) {
    indents.pop();
    push('dedent', '');
  }
  push('eof', '');
  return tokens;
}
