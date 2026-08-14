// CAN, and the one thing about it that cannot be faked.
//
// Arbitration is why CAN exists. Two nodes start transmitting in the same bit
// and the one with the lower identifier wins WITHOUT the loser corrupting the
// winner's frame. Sorting a queue by identifier after the fact produces the
// same delivery order and is a fake: it cannot show a loser becoming a
// receiver mid-frame, it cannot show two frames with the SAME identifier
// destroying each other, and it would let a design with no priority discipline
// look sound.
//
// So this bus is a wired-AND stepped one bit at a time, and the tests below
// check the mechanism rather than the outcome: which bit each node presented,
// what the wire became, when the loser stopped, and that the winner's frame
// arrived byte for byte with nothing of the loser's in it.

import {
  CanBus, crc15, frameBits, stuff, DOMINANT, RECESSIVE, type CanFrame,
} from '../src/simulation/devices/canBus';

let failures = 0;
function check(cond: boolean, msg: string) {
  console.log(cond ? 'PASS:' : 'FAIL:', msg);
  if (!cond) failures++;
}
function section(t: string) {
  console.log(`\n--- ${t}`);
}

const frame = (id: number, data: number[], opts: Partial<CanFrame> = {}): CanFrame => ({
  id, extended: false, rtr: false, data: Uint8Array.from(data), ...opts,
});

/**
 * Steps the bus through exactly one frame, plus the interframe space.
 *
 * The first step is where any queued node emits its start-of-frame bit, which
 * is what takes the bus out of idle.
 */
function runOneFrame(bus: CanBus, maxBits = 4000): number {
  let bits = 0;
  bus.stepBit();
  bits++;
  while (bits < maxBits && !bus.busIdle) {
    bus.stepBit();
    bits++;
  }
  for (let i = 0; i < 3; i++) {
    bus.stepBit();
    bits++;
  }
  return bits;
}

// =========================================== 1. the frame is a real frame ====
section('1. frame encoding, CRC and bit stuffing');
{
  const f = frame(0x123, [0xde, 0xad]);
  const { bits, arbitrationBits } = frameBits(f);

  check(bits[0] === DOMINANT, 'a frame starts with a dominant start-of-frame bit');
  check(arbitrationBits === 12, 'a standard frame arbitrates on 11 identifier bits and RTR');
  // SOF + 11 id + RTR + IDE + r0 + 4 DLC + 16 data + 15 CRC
  check(bits.length === 1 + 11 + 1 + 1 + 1 + 4 + 16 + 15, `and is ${bits.length} logical bits long`);

  let id = 0;
  for (let i = 1; i <= 11; i++) id = (id << 1) | bits[i];
  check(id === 0x123, `carrying the identifier MSB first (0x${id.toString(16)})`);

  // The CRC is real: recomputing over the body must match what was appended.
  const body = bits.slice(0, bits.length - 15);
  let appended = 0;
  for (const b of bits.slice(bits.length - 15)) appended = (appended << 1) | b;
  check(crc15(body) === appended, 'with a CRC-15 that checks out');
  check(crc15([...body, 1]) !== appended, 'and that a changed bit breaks');

  // Bit stuffing: six identical bits can never appear on the wire.
  const run = [0, 0, 0, 0, 0, 0, 0, 1];
  const stuffed = stuff(run);
  check(stuffed.bits.length === run.length + 1, 'five identical bits force a stuff bit');
  check(stuffed.bits[5] === 1, 'which is the complement');
  let longest = 0;
  let current = 0;
  let last = -1;
  const wire = stuff(bits).bits;
  for (const b of wire) {
    current = b === last ? current + 1 : 1;
    last = b;
    longest = Math.max(longest, current);
  }
  check(longest <= 5, `so no more than five identical bits ever go out (${longest})`);
  check(wire.length > bits.length, `and the frame on the wire is longer than the frame (${wire.length} vs ${bits.length})`);

  const ext = frameBits(frame(0x12345678 & 0x1fffffff, [1], { extended: true }));
  check(ext.arbitrationBits === 32, 'an extended frame arbitrates on 29 identifier bits plus SRR, IDE and RTR');
}

// ========================================= 2. one node, one frame, no ack ====
section('2. a frame crosses the wire and is decoded');
{
  const bus = new CanBus('bus');
  bus.addNode('a', 500_000);
  bus.addNode('b', 500_000);

  bus.send('a', frame(0x100, [0x11, 0x22, 0x33]));
  runOneFrame(bus);

  const a = bus.nodeState('a');
  const b = bus.nodeState('b');
  check(a?.sentCount === 1, `the sender completed its frame (${a?.sentCount})`);
  check(b?.receivedCount === 1, `and the other node decoded one (${b?.receivedCount})`);
  const got = b?.received[0];
  check(got?.id === 0x100, `with the right identifier (0x${got?.id.toString(16)})`);
  check([...(got?.data ?? [])].join(',') === '17,34,51', `and the right data (${[...(got?.data ?? [])].join(',')})`);
  check(a?.ackedByAnyone === true, 'the transmitter saw the acknowledgement the receiver drove');

  // A node alone on a bus gets no acknowledgement, because nobody drove the
  // ACK slot dominant. That is a real and very confusing bench symptom.
  const lonely = new CanBus('lonely');
  lonely.addNode('only', 500_000);
  lonely.send('only', frame(0x200, [1]));
  runOneFrame(lonely);
  check(lonely.nodeState('only')?.ackedByAnyone === false, 'a node alone on the bus is never acknowledged');
}

// ============================= 3. arbitration, which is the whole point ======
section('3. two nodes in the same bit: the lower identifier wins');
{
  const bus = new CanBus('bus');
  bus.addNode('low', 500_000);
  bus.addNode('high', 500_000);
  bus.addNode('watcher', 500_000);

  // Both queued before a single bit is stepped, so they start together.
  bus.send('low', frame(0x100, [0xaa, 0xbb]));
  bus.send('high', frame(0x200, [0xcc, 0xdd]));
  runOneFrame(bus);

  const low = bus.nodeState('low');
  const high = bus.nodeState('high');
  const watcher = bus.nodeState('watcher');

  check(bus.arbitrationCount >= 1, `the bus saw them start in the same bit (${bus.arbitrationCount})`);
  check(low?.sentCount === 1, '0x100 won and completed its frame');
  check(high?.arbitrationLosses === 1, `0x200 detected that it had lost (${high?.arbitrationLosses})`);
  check(high?.bitErrors === 0, 'without a single bit error — losing arbitration is not an error');

  // The winner's frame must be intact. If the loser had corrupted it, the CRC
  // would fail and nothing would decode.
  const seen = watcher?.received ?? [];
  check(seen.length === 1, `the watcher decoded exactly one frame (${seen.length})`);
  check(seen[0]?.id === 0x100, `and it is the winner's (0x${seen[0]?.id.toString(16)})`);
  check([...(seen[0]?.data ?? [])].join(',') === '170,187', 'with the winner\'s data, unmarked by the loser');

  // The loser is a receiver from the moment it lost, so it heard the frame
  // that beat it — which is what makes CAN's retry free.
  check((high?.receivedCount ?? 0) === 1, `the loser received the winning frame (${high?.receivedCount})`);
  check(high?.received[0]?.id === 0x100, 'rather than losing it');

  // And its own frame is still queued, so it goes out next.
  runOneFrame(bus);
  check(high?.sentCount === 1, 'then the loser transmits, unprompted, on the now-free bus');
  check(watcher?.receivedCount === 2, `and the watcher has both frames (${watcher?.receivedCount})`);
  check(watcher?.received[1]?.id === 0x200, 'in priority order, because that is what the wire decided');
}

// ======================== 4. the mechanism, not just the outcome =============
section('4. arbitration is decided bit by bit, on the wire');
{
  // The identifiers differ only in bit 4, so the loser must stay in the race
  // for the first seven identifier bits and drop out on exactly the eighth.
  const bus = new CanBus('bus');
  bus.addNode('a', 500_000);
  bus.addNode('b', 500_000);
  bus.send('a', frame(0x0f0, [1]));
  bus.send('b', frame(0x0f8, [2]));

  const a = bus.nodeState('a');
  const b = bus.nodeState('b');
  let lostAtBit = -1;
  for (let bit = 0; bit < 40 && lostAtBit < 0; bit++) {
    bus.stepBit();
    if (b?.phase === 'lost' || (b?.arbitrationLosses ?? 0) > 0) lostAtBit = bit;
  }
  // SOF is bit 0, so identifier bit n is bus bit n+1. 0x0F0 and 0x0F8 are
  // 000 1111 0000 and 000 1111 1000: they first differ at identifier bit 8.
  check(lostAtBit === 8, `the loser dropped out on the bit where they first differ (bit ${lostAtBit})`);
  check(a?.phase === 'transmitting', 'while the winner carried on without interruption');

  runOneFrame(bus);
  check(a?.sentCount === 1, 'and finished its frame');
  check(b?.received[0]?.id === 0x0f0, 'and the loser decoded it');
}

// ===================== 5. two frames with the same identifier collide =======
section('5. identical identifiers destroy each other, as they must');
{
  // The one case a sorted queue can never reproduce: neither node ever reads
  // back a bit different from the one it sent during arbitration, so neither
  // knows it has lost, and both keep transmitting different data into the same
  // frame. The result must not be a clean delivery of either.
  const bus = new CanBus('bus');
  bus.addNode('a', 500_000);
  bus.addNode('b', 500_000);
  bus.addNode('watcher', 500_000);
  bus.send('a', frame(0x155, [0x01, 0x02, 0x03, 0x04]));
  bus.send('b', frame(0x155, [0xf1, 0xf2, 0xf3, 0xf4]));
  runOneFrame(bus);

  const watcher = bus.nodeState('watcher');
  const clean = (watcher?.received ?? []).filter(
    (f) => [...f.data].join(',') === '1,2,3,4' || [...f.data].join(',') === '241,242,243,244',
  );
  check(clean.length === 0, `neither message arrived intact (${clean.length} clean)`);
  const errors = (bus.nodeState('a')?.bitErrors ?? 0) + (bus.nodeState('b')?.bitErrors ?? 0);
  check(errors > 0, `and the nodes detected bit errors outside arbitration (${errors})`);
}

// ==================================== 6. extended identifiers arbitrate too ==
section('6. an extended frame carries 29 bits and still arbitrates');
{
  const bus = new CanBus('bus');
  bus.addNode('a', 500_000);
  bus.addNode('b', 500_000);
  bus.send('a', frame(0x0abcdef, [0x55], { extended: true }));
  runOneFrame(bus);

  const got = bus.nodeState('b')?.received[0];
  check(got !== undefined, 'an extended frame is decoded');
  check(got?.extended === true, 'as extended');
  check(got?.id === 0x0abcdef, `with all 29 identifier bits (0x${got?.id.toString(16)})`);
  check([...(got?.data ?? [])].join(',') === '85', 'and its data');

  // A standard frame always beats an extended one with the same 11-bit prefix,
  // because SRR is recessive where the standard frame's RTR is dominant.
  const race = new CanBus('race');
  race.addNode('std', 500_000);
  race.addNode('ext', 500_000);
  race.addNode('watcher', 500_000);
  race.send('std', frame(0x0ff, [1]));
  race.send('ext', frame((0x0ff << 18) | 1, [2], { extended: true }));
  runOneFrame(race);
  runOneFrame(race);
  const first = race.nodeState('watcher')?.received[0];
  check(first?.extended === false, 'a standard frame beats an extended one sharing its prefix');
  check(race.nodeState('ext')?.arbitrationLosses === 1, 'and the extended one knows it lost');
}

// ================================================ 7. an RTR frame is carried =
section('7. a remote frame asks rather than tells');
{
  const bus = new CanBus('bus');
  bus.addNode('a', 500_000);
  bus.addNode('b', 500_000);
  bus.send('a', { id: 0x321, extended: false, rtr: true, data: Uint8Array.from([]) });
  runOneFrame(bus);

  const got = bus.nodeState('b')?.received[0];
  check(got?.rtr === true, 'the remote flag survives');
  check(got?.id === 0x321, 'with its identifier');
  check(got?.data.length === 0, 'and no data, because a remote frame carries none');
  // Nothing answers it, and the model does not pretend otherwise.
  check(bus.nodeState('b')?.sentCount === 0, 'and nothing automatically replies — that is the sketch\'s job');
}

console.log(failures === 0 ? '\nCAN bus checks passed.' : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
