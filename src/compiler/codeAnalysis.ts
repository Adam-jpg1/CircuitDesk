// Lightweight static analysis of sketch code for validation and pin-aware
// editor features. This is used for cross-referencing ONLY — simulation
// behavior always comes from executing compiled firmware.

import type { CodeFile } from '../types';

export interface CodePinRef {
  pin: number;
  fn: string;
  fileId: string;
  fileName: string;
  line: number; // 1-based
  column: number;
  length: number;
}

export interface CodePinUsage {
  refs: CodePinRef[];
  /** pin → declared mode from pinMode calls */
  modes: Map<number, 'OUTPUT' | 'INPUT' | 'INPUT_PULLUP'>;
  usedPins: Set<number>;
  unresolvedNames: string[];
}

const PIN_FN_RE = /\b(pinMode|digitalWrite|digitalRead|analogWrite|analogRead|pulseIn|tone|noTone)\s*\(\s*([A-Za-z_][A-Za-z0-9_]*|\d+)/g;
const DEFINE_RE = /#define\s+([A-Za-z_][A-Za-z0-9_]*)\s+(\d+|A[0-5])\b/g;
const CONST_RE = /\b(?:const\s+)?(?:int|byte|uint8_t|unsigned\s+char)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(\d+|A[0-5])\s*[;,]/g;

function resolveToken(token: string, names: Map<string, number>): number | undefined {
  if (/^\d+$/.test(token)) return Number(token);
  if (/^A[0-5]$/.test(token)) return 14 + Number(token[1]);
  if (token === 'LED_BUILTIN') return 13;
  return names.get(token);
}

export function analyzeCodePins(files: CodeFile[]): CodePinUsage {
  const names = new Map<string, number>();
  for (const file of files) {
    for (const m of file.content.matchAll(DEFINE_RE)) {
      const v = resolveToken(m[2], names);
      if (v !== undefined) names.set(m[1], v);
    }
    for (const m of file.content.matchAll(CONST_RE)) {
      const v = resolveToken(m[2], names);
      if (v !== undefined) names.set(m[1], v);
    }
    // multi-declaration: const int R = 9, G = 10, B = 11;
    for (const m of file.content.matchAll(/\b(?:const\s+)?(?:int|byte|uint8_t)\s+([^;]+);/g)) {
      for (const part of m[1].split(',')) {
        const pm = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(\d+|A[0-5])\s*$/.exec(part);
        if (pm) {
          const v = resolveToken(pm[2], names);
          if (v !== undefined) names.set(pm[1], v);
        }
      }
    }
  }

  const refs: CodePinRef[] = [];
  const modes = new Map<number, 'OUTPUT' | 'INPUT' | 'INPUT_PULLUP'>();
  const usedPins = new Set<number>();
  const unresolved: string[] = [];

  for (const file of files) {
    const lineStarts: number[] = [0];
    for (let i = 0; i < file.content.length; i++) {
      if (file.content[i] === '\n') lineStarts.push(i + 1);
    }
    const posToLineCol = (pos: number): { line: number; column: number } => {
      let lo = 0, hi = lineStarts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (lineStarts[mid] <= pos) lo = mid;
        else hi = mid - 1;
      }
      return { line: lo + 1, column: pos - lineStarts[lo] + 1 };
    };

    for (const m of file.content.matchAll(PIN_FN_RE)) {
      const fn = m[1];
      const token = m[2];
      const pin = resolveToken(token, names);
      if (pin === undefined) {
        unresolved.push(token);
        continue;
      }
      const effectivePin = fn === 'analogRead' && pin < 14 ? pin + 14 : pin;
      usedPins.add(effectivePin);
      const tokenPos = m.index! + m[0].length - token.length;
      const { line, column } = posToLineCol(tokenPos);
      refs.push({ pin: effectivePin, fn, fileId: file.id, fileName: file.name, line, column, length: token.length });
      if (fn === 'pinMode') {
        const rest = file.content.slice(m.index! + m[0].length, m.index! + m[0].length + 40);
        const modeMatch = /,\s*(OUTPUT|INPUT_PULLUP|INPUT)\b/.exec(rest);
        if (modeMatch) modes.set(effectivePin, modeMatch[1] as 'OUTPUT' | 'INPUT' | 'INPUT_PULLUP');
      }
    }
  }

  return { refs, modes, usedPins, unresolvedNames: [...new Set(unresolved)] };
}
