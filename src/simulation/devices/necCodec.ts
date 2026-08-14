// NEC infrared: the timings, and only the timings.
//
// NEC is the protocol behind almost every cheap remote and every "IR remote
// kit" on a hobby shelf, so it is the one worth being exact about. A frame is:
//
//   9000 us mark, 4500 us space          leader
//   8 bits address, LSB first            each bit: 560 us mark, then
//   8 bits inverted address                560 us space for 0
//   8 bits command, LSB first              1690 us space for 1
//   8 bits inverted command
//   560 us stop mark
//
// A held button does not repeat the frame. It sends a repeat code — 9000 us
// mark, 2250 us space, 560 us mark — every 108 ms measured from the START of
// the previous frame, which is why the second repeat arrives sooner than the
// first. Sketches that count presses get this wrong constantly, so it is
// modelled rather than approximated by re-sending the frame.
//
// The inverted bytes are real and are checked on decode. A decoder that
// ignored them would accept a corrupted frame, and corrupted frames are
// exactly what the medium produces when two remotes talk at once — which is
// the case this whole channel exists to represent honestly.
//
// Extended NEC (NEC2) drops the address inversion and uses a 16-bit address
// instead. Both are produced; decode accepts either and says which it saw.
//
// NOT modelled: the 38 kHz carrier's individual cycles (the medium works in
// marks, as a demodulating receiver does), duty cycle, and the several
// "NEC-like" variants with different leader lengths.

export const NEC_CARRIER_HZ = 38000;

export const NEC_TIMING = {
  leaderMarkUs: 9000,
  leaderSpaceUs: 4500,
  repeatSpaceUs: 2250,
  bitMarkUs: 560,
  zeroSpaceUs: 560,
  oneSpaceUs: 1690,
  /** Frame-start to frame-start while a button is held. */
  repeatPeriodUs: 108000,
} as const;

/** A mark, in microseconds from the start of the burst. */
export interface RelativeMark {
  startUs: number;
  endUs: number;
}

export interface NecFrame {
  address: number;
  command: number;
  /** True when the address was 16-bit and not inverted (NEC2). */
  extended: boolean;
}

function pushByte(marks: RelativeMark[], t: number, value: number): number {
  for (let bit = 0; bit < 8; bit++) {
    marks.push({ startUs: t, endUs: t + NEC_TIMING.bitMarkUs });
    t += NEC_TIMING.bitMarkUs;
    t += (value >> bit) & 1 ? NEC_TIMING.oneSpaceUs : NEC_TIMING.zeroSpaceUs;
  }
  return t;
}

/**
 * The marks of one NEC frame, relative to its own start.
 *
 * `extended` sends a 16-bit address with no inversion, which is what most
 * modern remotes actually do.
 */
export function necFrameMarks(address: number, command: number, extended = false): RelativeMark[] {
  const marks: RelativeMark[] = [];
  let t = 0;
  marks.push({ startUs: 0, endUs: NEC_TIMING.leaderMarkUs });
  t = NEC_TIMING.leaderMarkUs + NEC_TIMING.leaderSpaceUs;

  if (extended) {
    t = pushByte(marks, t, address & 0xff);
    t = pushByte(marks, t, (address >> 8) & 0xff);
  } else {
    t = pushByte(marks, t, address & 0xff);
    t = pushByte(marks, t, ~address & 0xff);
  }
  t = pushByte(marks, t, command & 0xff);
  t = pushByte(marks, t, ~command & 0xff);

  marks.push({ startUs: t, endUs: t + NEC_TIMING.bitMarkUs });
  return marks;
}

/** The repeat burst a held button sends: leader, short space, one mark. */
export function necRepeatMarks(): RelativeMark[] {
  return [
    { startUs: 0, endUs: NEC_TIMING.leaderMarkUs },
    {
      startUs: NEC_TIMING.leaderMarkUs + NEC_TIMING.repeatSpaceUs,
      endUs: NEC_TIMING.leaderMarkUs + NEC_TIMING.repeatSpaceUs + NEC_TIMING.bitMarkUs,
    },
  ];
}

/** Shifts relative marks onto the shared timeline. */
export function atTime(marks: readonly RelativeMark[], startUs: number): RelativeMark[] {
  return marks.map((m) => ({ startUs: startUs + m.startUs, endUs: startUs + m.endUs }));
}

export type NecDecoded =
  | { kind: 'frame'; frame: NecFrame }
  | { kind: 'repeat' }
  | { kind: 'invalid'; reason: string };

/**
 * Decodes marks back into a frame, the way a receiving sketch does.
 *
 * Used by the inspector and by tests. It is deliberately NOT how firmware gets
 * its data: firmware reads the receiver's output pin and decodes it itself.
 * If this function were the path into a sketch, the sketch would never have to
 * get its own timing right, and the model would be proving nothing.
 */
export function decodeNecMarks(marks: readonly RelativeMark[], toleranceUs = 200): NecDecoded {
  if (marks.length < 2) return { kind: 'invalid', reason: 'too few marks' };
  const near = (a: number, b: number) => Math.abs(a - b) <= toleranceUs;

  const leader = marks[0].endUs - marks[0].startUs;
  if (!near(leader, NEC_TIMING.leaderMarkUs)) {
    return { kind: 'invalid', reason: `leader was ${Math.round(leader)} us` };
  }
  const firstSpace = marks[1].startUs - marks[0].endUs;
  if (near(firstSpace, NEC_TIMING.repeatSpaceUs)) return { kind: 'repeat' };
  if (!near(firstSpace, NEC_TIMING.leaderSpaceUs)) {
    return { kind: 'invalid', reason: `leader space was ${Math.round(firstSpace)} us` };
  }
  if (marks.length < 34) return { kind: 'invalid', reason: `only ${marks.length} marks` };

  const bits: number[] = [];
  for (let i = 1; i < 33; i++) {
    const space = marks[i + 1].startUs - marks[i].endUs;
    if (near(space, NEC_TIMING.oneSpaceUs)) bits.push(1);
    else if (near(space, NEC_TIMING.zeroSpaceUs)) bits.push(0);
    else return { kind: 'invalid', reason: `bit ${i - 1} space was ${Math.round(space)} us` };
  }
  const byteAt = (index: number) => {
    let v = 0;
    for (let bit = 0; bit < 8; bit++) v |= bits[index * 8 + bit] << bit;
    return v;
  };
  const a0 = byteAt(0);
  const a1 = byteAt(1);
  const command = byteAt(2);
  const commandInv = byteAt(3);
  if ((command ^ commandInv) !== 0xff) {
    return { kind: 'invalid', reason: 'command checksum failed' };
  }
  const extended = (a0 ^ a1) !== 0xff;
  return {
    kind: 'frame',
    frame: { address: extended ? a0 | (a1 << 8) : a0, command, extended },
  };
}
