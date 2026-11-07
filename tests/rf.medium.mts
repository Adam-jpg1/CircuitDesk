// The radio medium, before any radio is built on it.
//
// This is the foundation Checkpoint F rests on, and it is worth testing on its
// own because every mistake it could make is a mistake that would look like a
// working radio. A medium that delivered a packet to a receiver on the wrong
// channel would make wrong wiring look right. A medium that queued two
// simultaneous transmissions instead of destroying them would make a design
// with no collision avoidance look sound. A medium that invented an RSSI would
// have people designing for a range that does not exist.
//
// So: matching is checked, mismatching is checked, overlap destroys, and the
// things that are NOT modelled are asserted absent rather than left to drift
// in later.

import { RfMedium, type RfListener, type RfTransmission } from '../src/simulation/devices/rfMedium';

let failures = 0;
function check(cond: boolean, msg: string) {
  console.log(cond ? 'PASS:' : 'FAIL:', msg);
  if (!cond) failures++;
}
function section(t: string) {
  console.log(`\n--- ${t}`);
}

const bytes = (...v: number[]) => Uint8Array.from(v);
const listener = (over: Partial<RfListener> = {}): RfListener => ({
  band: '2.4g', channel: 76, match: {}, ...over,
});
function send(
  m: RfMedium,
  over: Partial<Omit<RfTransmission, 'id'>> = {},
): RfTransmission {
  return m.transmit({
    transmitterId: 'tx', band: '2.4g', channel: 76,
    startUs: 1000, endUs: 1300, payload: bytes(1, 2, 3), match: {},
    ...over,
  });
}

// ================================================ 1. a packet gets through ===
section('1. a matching receiver gets the bytes');
{
  const m = new RfMedium();
  const t = send(m);
  check(m.completed(listener(), 0, 900).length === 0, 'nothing is delivered before the packet has finished');
  const got = m.completed(listener(), 0, 2000);
  check(got.length === 1, `one packet after it lands (${got.length})`);
  check(!got[0].collided, 'uncollided');
  check([...got[0].transmission.payload].join(',') === '1,2,3', 'carrying the bytes that were sent');
  check(got[0].transmission.transmitterId === 'tx', 'and naming who sent it');

  // A cursor, not a clock: a receiver that was not polled for a while must not
  // lose packets, and one that was must not see them twice.
  check(m.completed(listener(), t.id, 2000).length === 0, 'and it is not delivered twice');
}

// ====================================== 2. the channel actually matters ======
section('2. a receiver on the wrong channel hears nothing');
{
  const m = new RfMedium();
  const t = send(m, { channel: 76 });
  check(m.completed(listener({ channel: 76 }), 0, 2000).length === 1, 'the right channel receives');
  check(m.completed(listener({ channel: 2 }), 0, 2000).length === 0, 'the wrong channel does not');
  check(m.completed(listener({ band: '433' }), 0, 2000).length === 0, 'and neither does the wrong band');

  // Silence is the worst diagnostic there is, so the medium can say why.
  const why = m.explainMismatch(listener({ channel: 2 }), t);
  check(why !== null && /channel/.test(why), `and it can say why ("${why}")`);
  check(m.explainMismatch(listener({ band: '433' }), t)?.includes('band') === true, 'including a band mismatch');
  check(m.explainMismatch(listener({ channel: 76 }), t) === null, 'with nothing to explain when they agree');
}

// =============================== 3. family-specific matching is enforced =====
section('3. an address or sync word that differs is not for you');
{
  const m = new RfMedium();
  const t = send(m, { match: { address: 'E7E7E7E7E7' } });
  check(m.completed(listener({ match: { address: 'E7E7E7E7E7' } }), 0, 2000).length === 1, 'the right pipe address receives');
  check(m.completed(listener({ match: { address: 'C2C2C2C2C2' } }), 0, 2000).length === 0, 'a different one does not');
  const why = m.explainMismatch(listener({ match: { address: 'C2C2C2C2C2' } }), t);
  check(why !== null && /address/.test(why), `and the reason names the field ("${why}")`);

  // A listener with no address constraint is promiscuous, which is a real mode
  // and must not be confused with a matching one.
  check(m.completed(listener(), 0, 2000).length === 1, 'a listener with no constraint hears everything on its channel');
}

// ================================= 4. two transmitters destroy each other ====
section('4. overlap is destruction, not a queue');
{
  const m = new RfMedium();
  send(m, { transmitterId: 'a', startUs: 1000, endUs: 2000, payload: bytes(0xaa) });
  send(m, { transmitterId: 'b', startUs: 1500, endUs: 2500, payload: bytes(0xbb) });

  const got = m.completed(listener(), 0, 3000);
  check(got.length === 2, `both are delivered so a radio can see something arrived (${got.length})`);
  check(got.every((r) => r.collided), 'and both are marked collided');
  check(m.collisionCount > 0, `with the collision counted (${m.collisionCount})`);

  // Back to back, not overlapping: both are clean. The boundary case matters,
  // because a model that called touching packets a collision would break every
  // correctly written retry loop.
  const m2 = new RfMedium();
  m2.transmit({ transmitterId: 'a', band: '2.4g', channel: 5, startUs: 0, endUs: 1000, payload: bytes(1), match: {} });
  m2.transmit({ transmitterId: 'b', band: '2.4g', channel: 5, startUs: 1000, endUs: 2000, payload: bytes(2), match: {} });
  const clean = m2.completed(listener({ channel: 5 }), 0, 3000);
  check(clean.length === 2 && clean.every((r) => !r.collided), 'back-to-back packets do not collide');

  // Overlapping on DIFFERENT channels is not a collision. This is the case a
  // per-pair link model cannot represent at all.
  const m3 = new RfMedium();
  m3.transmit({ transmitterId: 'a', band: '2.4g', channel: 1, startUs: 0, endUs: 1000, payload: bytes(1), match: {} });
  m3.transmit({ transmitterId: 'b', band: '2.4g', channel: 2, startUs: 0, endUs: 1000, payload: bytes(2), match: {} });
  check(
    m3.completed(listener({ channel: 1 }), 0, 2000).every((r) => !r.collided),
    'and two transmitters on different channels do not',
  );
}

// ============================ 5. nothing here invents a radio environment ====
section('5. the medium does not know things it cannot know');
{
  const m = new RfMedium();
  const t = send(m);
  const keys = Object.keys(t);
  for (const invented of ['rssi', 'snr', 'distance', 'position', 'strength', 'range', 'attenuation', 'lqi']) {
    check(!keys.includes(invented), `a transmission carries no ${invented}`);
  }
  // The medium is a set of transmissions and nothing else: no geometry to
  // derive a range from, so nothing can quietly start deriving one.
  check(!('distanceBetween' in m), 'and the medium exposes no distance model');
  check(!('rssiFor' in m), 'nor a signal-strength model');
}

// ================================================ 6. it does not grow ========
section('6. old traffic is dropped');
{
  const m = new RfMedium();
  for (let i = 0; i < 50; i++) {
    m.transmit({
      transmitterId: 'a', band: '2.4g', channel: 1,
      startUs: i * 1000, endUs: i * 1000 + 500, payload: bytes(i), match: {},
    });
  }
  check(m.transmissionCount === 50, '50 packets in the air');
  m.prune(40_000);
  check(m.transmissionCount < 50 && m.transmissionCount > 0, `pruning drops the old ones (${m.transmissionCount} left)`);
  // Ids keep counting, so a receiver's cursor stays meaningful across a prune.
  const after = m.transmit({
    transmitterId: 'a', band: '2.4g', channel: 1, startUs: 60_000, endUs: 60_500, payload: bytes(9), match: {},
  });
  check(after.id === 51, `ids do not restart after a prune (${after.id})`);
}

console.log(failures === 0 ? '\nRF medium checks passed.' : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
