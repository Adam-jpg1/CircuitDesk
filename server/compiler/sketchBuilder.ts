import path from 'node:path';
import { writeTextFile } from './fileService.js';
import type { CodeFilePayload } from './types.js';

/**
 * Builds an on-disk sketch folder from the project's code files.
 *
 * The primary .ino file (sketch.ino, or the first .ino alphabetically) is
 * converted to a .cpp translation unit by prepending `#include <Arduino.h>`
 * plus a #line directive so compiler diagnostics point back at the original
 * .ino line numbers. Additional .ino files are appended in alphabetical
 * order, mirroring the Arduino build convention. .h/.c/.cpp files are copied
 * verbatim next to it.
 */
export interface BuiltSketch {
  dir: string;
  /** Absolute paths of translation units to compile (.cpp/.c). */
  units: string[];
  /** Maps on-disk unit name to the original file name for diagnostics. */
  nameMap: Map<string, string>;
}

export async function buildSketchDir(buildDir: string, files: CodeFilePayload[]): Promise<BuiltSketch> {
  const sketchDir = path.join(buildDir, 'sketch');
  const inos = files.filter((f) => f.name.endsWith('.ino')).sort((a, b) => {
    if (a.name === 'sketch.ino') return -1;
    if (b.name === 'sketch.ino') return 1;
    return a.name.localeCompare(b.name);
  });
  const others = files.filter((f) => !f.name.endsWith('.ino'));

  let merged = '#include <Arduino.h>\n';
  for (const ino of inos) {
    merged += `#line 1 "${ino.name}"\n${ino.content}\n`;
  }
  const mainUnit = await writeTextFile(sketchDir, 'sketch_merged.cpp', merged);

  const units: string[] = [mainUnit];
  const nameMap = new Map<string, string>();
  nameMap.set('sketch_merged.cpp', inos[0]?.name ?? 'sketch.ino');

  for (const f of others) {
    const abs = await writeTextFile(sketchDir, f.name, f.content);
    nameMap.set(f.name, f.name);
    if (f.name.endsWith('.cpp') || f.name.endsWith('.c')) {
      units.push(abs);
    }
  }
  return { dir: sketchDir, units, nameMap };
}

/**
 * Writes files for arduino-cli, which expects a folder whose name matches the
 * primary sketch file. arduino-cli performs its own .ino preprocessing.
 */
export async function buildCliSketchDir(buildDir: string, files: CodeFilePayload[]): Promise<string> {
  const sketchDir = path.join(buildDir, 'cdsketch');
  let hasPrimary = false;
  for (const f of files) {
    const name = f.name === 'sketch.ino' ? 'cdsketch.ino' : f.name;
    if (name === 'cdsketch.ino') hasPrimary = true;
    await writeTextFile(sketchDir, name, f.content);
  }
  if (!hasPrimary) {
    const firstIno = files.find((f) => f.name.endsWith('.ino'));
    if (firstIno) await writeTextFile(sketchDir, 'cdsketch.ino', firstIno.content);
  }
  return sketchDir;
}
