// CAN, one bit at a time.
//
// This is built bit by bit rather than frame by frame, and that is the whole
// point. CAN's defining property is that arbitration is non-destructive: two
// nodes start transmitting in the same bit, and the one with the lower
// identifier wins WITHOUT the loser corrupting the winner's frame — because a
// dominant bit overwrites a recessive one on the wire, and a node that
// presented recessive while reading dominant knows it has lost and stops.
//
// Sorting a queue by identifier after the fact would produce the same delivery
// order and would be a fake. It would not reproduce a loser that becomes a
// receiver mid-frame, it would not reproduce two frames with the same
// identifier destroying each other, and it would let a design with no priority
// discipline look sound. So the bus is a wired-AND that steps one bit at a
// time, every node presents a bit into it, and every node reads back what the
// wire actually became.
//
// What is here: SOF, 11-bit and 29-bit identifiers, RTR, IDE, DLC, up to eight
// data bytes, the real CRC-15 (polynomial 0x4599), the CRC delimiter, the ACK
// slot driven dominant by any node that received the frame, the ACK delimiter,
// seven bits of EOF, three bits of interframe space, and bit stuffing — after
// five identical bits a complement is inserted, which changes the length of
// every frame and is not optional.
//
// NOT modelled, and recorded rather than implied:
//
//   error frames             A bit error or a stuff error is counted, but no
//   error counters           node transmits an error flag, and there are no
//   error-passive, bus-off   transmit or receive error counters, so a node
//                            never goes error-passive or bus-off.
//   overload frames          Not implemented.
//   physical layer           No differential voltages, no termination, no
//                            reflections, no propagation delay, and therefore
//                            no cable-length limit on the bitrate.
//   bit timing detail        A bit is a bit: no time quanta, no sample point,
//                            no synchronisation jump width. Nodes on different
//                            bitrates simply cannot share a bus here, which is
//                            the outcome, without the resynchronisation
//                            machinery that produces it on hardware.
//   remote frame answering   An RTR frame is carried; nothing automatically
//                            replies to one.

import type { DeviceSnapshot } from './types';

export interface CanFrame {
  /** 11 bits for a standard frame, 29 for an extended one. */
  id: number;
  extended: boolean;
  /** Remote transmission request: a frame that asks rather than tells. */
  rtr: boolean;
  data: Uint8Array;
}

/** Dominant is 0 and wins; recessive is 1 and yields. That is the whole trick. */
export const DOMINANT = 0;
export const RECESSIVE = 1;

/** CRC-15 with the CAN polynomial, over the destuffed bits from SOF. */
export function crc15(bits: readonly number[]): number {
  let crc = 0;
  for (const bit of bits) {
    const invert = ((crc >> 14) & 1) ^ bit;
    crc = (crc << 1) & 0x7fff;
    if (invert) crc ^= 0x4599;
  }
  return crc;
}

function pushBits(out: number[], value: number, count: number): void {
  for (let i = count - 1; i >= 0; i--) out.push((value >> i) & 1);
}

/**
 * The logical (unstuffed) bits of a frame, from SOF through the CRC.
 *
 * `arbitrationBits` is how many of them are the arbitration field, which is
 * exactly the window in which losing is allowed and harmless.
 */
export function frameBits(frame: CanFrame): { bits: number[]; arbitrationBits: number } {
  const bits: number[] = [];
  bits.push(DOMINANT); // start of frame

  let arbitrationBits: number;
  if (!frame.extended) {
    pushBits(bits, frame.id & 0x7ff, 11);
    bits.push(frame.rtr ? RECESSIVE : DOMINANT);
    arbitrationBits = 12; // 11 identifier bits and RTR
    bits.push(DOMINANT); // IDE: standard
    bits.push(DOMINANT); // r0
  } else {
    pushBits(bits, (frame.id >> 18) & 0x7ff, 11);
    bits.push(RECESSIVE); // SRR, always recessive in an extended frame
    bits.push(RECESSIVE); // IDE: extended
    pushBits(bits, frame.id & 0x3ffff, 18);
    bits.push(frame.rtr ? RECESSIVE : DOMINANT);
    arbitrationBits = 32; // 11 + SRR + IDE + 18 + RTR
    bits.push(DOMINANT); // r1
    bits.push(DOMINANT); // r0
  }

  const dlc = Math.min(8, frame.data.length);
  pushBits(bits, dlc, 4);
  if (!frame.rtr) for (let i = 0; i < dlc; i++) pushBits(bits, frame.data[i], 8);

  pushBits(bits, crc15(bits), 15);
  return { bits, arbitrationBits };
}

/**
 * Bit stuffing: after five identical bits, the complement is inserted.
 *
 * Not optional and not cosmetic — it changes the length of every frame on the
 * wire, and a receiver that did not remove them would decode nonsense.
 */
export function stuff(bits: readonly number[]): { bits: number[]; stuffedAt: Set<number> } {
  const out: number[] = [];
  const stuffedAt = new Set<number>();
  let run = 0;
  let last = -1;
  for (const bit of bits) {
    if (bit === last) run++;
    else {
      run = 1;
      last = bit;
    }
    out.push(bit);
    if (run === 5) {
      stuffedAt.add(out.length);
      out.push(bit ^ 1);
      last = bit ^ 1;
      run = 1;
    }
  }
  return { bits: out, stuffedAt };
}

type NodePhase = 'idle' | 'transmitting' | 'lost' | 'receiving';

interface Transmitting {
  frame: CanFrame;
  /** The stuffed bits from SOF through the CRC. */
  wire: number[];
  /** How many of the UNSTUFFED bits are arbitration. */
  arbitrationBits: number;
  /** Which wire positions are stuff bits, so arbitration can be located. */
  stuffedAt: Set<number>;
  index: number;
}

/** What a node has decoded so far from the wire. */
interface Decoder {
  active: boolean;
  bits: number[];
  run: number;
  last: number;
  expecting: 'frame' | 'crc-delimiter' | 'ack' | 'ack-delimiter' | 'eof';
  eofSeen: number;
  /** Total logical bits the frame will have, once DLC is known. */
  total: number;
}

function newDecoder(): Decoder {
  return { active: false, bits: [], run: 0, last: -1, expecting: 'frame', eofSeen: 0, total: 0 };
}

export interface CanNodeState {
  readonly id: string;
  phase: NodePhase;
  tx: Transmitting | null;
  queue: CanFrame[];
  decoder: Decoder;
  bitrate: number;
  /** Set while this node listens rather than talks — MCP2515 listen-only. */
  listenOnly: boolean;
  received: CanFrame[];
  sentCount: number;
  receivedCount: number;
  arbitrationLosses: number;
  bitErrors: number;
  ackedByAnyone: boolean;
}

/**
 * The wire.
 *
 * `stepBit` is one bit time on the bus: every node presents a bit, the wire
 * becomes the AND of them, and every node reads back what it became. Nothing
 * knows about frames at this level, which is what makes arbitration fall out
 * of the physics rather than being arranged.
 */
export class CanBus {
  readonly id: string;
  private nodes = new Map<string, CanNodeState>();
  /** Recessive bits since the last dominant, for the interframe space. */
  private idleBits = 3;
  private bitsStepped = 0;
  private arbitrations = 0;
  private lastBit = RECESSIVE;
  private log: string[] = [];

  constructor(id: string) {
    this.id = id;
  }

  addNode(id: string, bitrate: number): CanNodeState {
    const existing = this.nodes.get(id);
    if (existing) {
      existing.bitrate = bitrate;
      return existing;
    }
    const node: CanNodeState = {
      id,
      phase: 'idle',
      tx: null,
      queue: [],
      decoder: newDecoder(),
      bitrate,
      listenOnly: false,
      received: [],
      sentCount: 0,
      receivedCount: 0,
      arbitrationLosses: 0,
      bitErrors: 0,
      ackedByAnyone: false,
    };
    this.nodes.set(id, node);
    return node;
  }

  nodeState(id: string): CanNodeState | undefined {
    return this.nodes.get(id);
  }

  /**
   * A node's bit timing, once its controller has been configured.
   *
   * Zero means "not on the bus": a controller still in configuration mode has
   * no meaningful bit clock and must not be counted as one.
   */
  noteBitrate(node: CanNodeState, bitrate: number): void {
    node.bitrate = bitrate;
  }

  /** The bitrate every operational node agrees on, or 0 if they do not. */
  get agreedBitrate(): number {
    let rate = 0;
    for (const node of this.nodes.values()) {
      if (node.bitrate <= 0) continue;
      if (rate === 0) rate = node.bitrate;
      else if (rate !== node.bitrate) return 0;
    }
    return rate;
  }
  /**
   * True when this node's bit clock disagrees with another node's.
   *
   * Deliberately symmetric: nobody is nominated as correct. Two controllers
   * with different bit timing cannot both be right about where a bit ends, so
   * neither samples the other's frames and both wreck the wire — which is what
   * a bench does, without needing an arbitrary winner.
   */
  desynced(node: CanNodeState): boolean {
    if (node.bitrate <= 0) return false;
    for (const other of this.nodes.values()) {
      if (other === node || other.bitrate <= 0) continue;
      if (other.bitrate !== node.bitrate) return true;
    }
    return false;
  }
  get nodeCount(): number {
    return this.nodes.size;
  }
  /**
   * True only when no frame is in progress anywhere and the interframe space
   * has passed.
   *
   * Three recessive bits are NOT enough on their own: stuffing guarantees no
   * more than five identical bits, so a run of three happens constantly inside
   * a frame, and a node that started transmitting on one would smash whatever
   * was already on the wire. A node knows a frame is in progress because it
   * saw a start-of-frame and has not yet seen the end of it — which is exactly
   * what the decoder being active means.
   */
  get busIdle(): boolean {
    if (this.idleBits < 3) return false;
    for (const node of this.nodes.values()) {
      if (node.phase === 'transmitting' || node.decoder.active) return false;
    }
    return true;
  }
  get steppedBits(): number {
    return this.bitsStepped;
  }
  get arbitrationCount(): number {
    return this.arbitrations;
  }
  get recentLog(): string[] {
    return [...this.log];
  }

  /** Queues a frame on a node. It goes out when the node wins the bus. */
  send(nodeId: string, frame: CanFrame): boolean {
    const node = this.nodes.get(nodeId);
    if (!node || node.listenOnly) return false;
    node.queue.push(frame);
    return true;
  }

  /**
   * One bit time.
   *
   * The three phases are the physical ones: present, resolve, observe. Keeping
   * them apart is what stops a node from seeing its own bit before the wire
   * has settled, which is precisely the mistake that would make arbitration
   * depend on iteration order.
   */
  stepBit(): void {
    this.bitsStepped++;

    // --- start of frame: anyone with something to send may begin when the
    // bus has been idle for the interframe space. Several of them starting in
    // the same bit is not a problem — that is what arbitration is for.
    if (this.busIdle) {
      let starters = 0;
      for (const node of this.nodes.values()) {
        if (node.phase !== 'idle' || node.listenOnly || node.queue.length === 0) continue;
        const frame = node.queue[0];
        const logical = frameBits(frame);
        const stuffed = stuff(logical.bits);
        node.tx = {
          frame,
          wire: stuffed.bits,
          arbitrationBits: logical.arbitrationBits,
          stuffedAt: stuffed.stuffedAt,
          index: 0,
        };
        node.phase = 'transmitting';
        node.ackedByAnyone = false;
        starters++;
      }
      if (starters > 1) {
        this.arbitrations++;
        this.note(`${starters} nodes started in the same bit — arbitrating`);
      }
    }

    // --- present
    const presented = new Map<string, number>();
    for (const node of this.nodes.values()) {
      presented.set(node.id, this.bitFrom(node));
    }

    // --- resolve: the wire is a wired-AND, so one dominant bit wins.
    let bus: number = RECESSIVE;
    for (const bit of presented.values()) if (bit === DOMINANT) bus = DOMINANT;

    // A node on the wrong bitrate puts its dominant bits in the wrong places,
    // so nothing on the wire decodes while it is talking.
    for (const node of this.nodes.values()) {
      if (node.phase === 'transmitting' && this.desynced(node)) {
        for (const other of this.nodes.values()) {
          if (other === node) continue;
          other.decoder.active = false;
          other.decoder.bits = [];
        }
        node.bitErrors++;
      }
    }

    // --- observe
    for (const node of this.nodes.values()) {
      this.observe(node, presented.get(node.id) ?? RECESSIVE, bus);
    }

    this.lastBit = bus;
    if (bus === DOMINANT) this.idleBits = 0;
    else this.idleBits++;
  }

  /** What one node puts on the wire this bit. */
  private bitFrom(node: CanNodeState): number {
    if (node.phase === 'transmitting' && node.tx) {
      if (node.tx.index < node.tx.wire.length) return node.tx.wire[node.tx.index];
      // Past the CRC: the transmitter sends recessive through the delimiter,
      // the ACK slot (which is where it listens for someone else's dominant),
      // the ACK delimiter and EOF.
      return RECESSIVE;
    }
    // A receiver drives the ACK slot dominant when it has a frame whose CRC
    // checked out. That acknowledgement is the only thing a receiver ever
    // transmits, and it is why a lone node on a bus never gets an ACK.
    if (node.decoder.expecting === 'ack' && node.decoder.active) return DOMINANT;
    return RECESSIVE;
  }

  private observe(node: CanNodeState, presentedBit: number, busBit: number): void {
    if (node.phase === 'transmitting' && node.tx) {
      const tx = node.tx;
      if (presentedBit === RECESSIVE && busBit === DOMINANT) {
        // Somebody stronger is on the wire. Inside the arbitration field that
        // is normal and harmless: this node simply loses and becomes a
        // listener, having contributed nothing to the winner's frame.
        if (this.inArbitration(tx)) {
          node.phase = 'lost';
          node.arbitrationLosses++;
          node.tx = null;
          this.note(`${node.id} lost arbitration`);
          // It still decodes the frame that beat it, from this bit onwards.
          this.feedDecoder(node, busBit);
          return;
        }
        // Outside arbitration this is a bit error. Counted, not handled: no
        // error frame is transmitted. See the note at the top of the file.
        node.bitErrors++;
      } else {
        tx.index++;
      }
      this.feedDecoder(node, busBit);
      return;
    }
    this.feedDecoder(node, busBit);
  }

  /** True while the transmitter is still inside the arbitration field. */
  private inArbitration(tx: Transmitting): boolean {
    // Count the logical bits emitted so far: wire position minus the stuff
    // bits before it.
    let stuffed = 0;
    for (const at of tx.stuffedAt) if (at <= tx.index) stuffed++;
    const logical = tx.index - stuffed;
    // SOF is logical bit 0; the arbitration field follows it.
    return logical <= tx.arbitrationBits;
  }

  /**
   * One bit into a node's receive decoder.
   *
   * Every node decodes every frame, including the one transmitting it — that
   * is how a transmitter learns whether anyone acknowledged.
   */
  private feedDecoder(node: CanNodeState, bit: number): void {
    const d = node.decoder;

    if (!d.active) {
      if (bit !== DOMINANT) return; // waiting for a start of frame
      if (this.desynced(node)) return; // sampling in the wrong places
      d.active = true;
      d.bits = [DOMINANT];
      d.run = 1;
      d.last = DOMINANT;
      d.expecting = 'frame';
      d.eofSeen = 0;
      d.total = 0;
      return;
    }

    if (d.expecting === 'frame') {
      // Destuffing: after five identical bits the next one is a stuff bit and
      // is not part of the frame.
      if (d.run === 5) {
        d.run = 1;
        d.last = bit;
        return;
      }
      d.bits.push(bit);
      if (bit === d.last) d.run++;
      else {
        d.run = 1;
        d.last = bit;
      }
      if (d.total === 0) d.total = this.frameLengthFrom(d.bits);
      if (d.total > 0 && d.bits.length >= d.total) {
        d.expecting = 'crc-delimiter';
      }
      return;
    }

    if (d.expecting === 'crc-delimiter') {
      d.expecting = this.checkFrame(node) ? 'ack' : 'eof';
      if (d.expecting === 'eof') d.active = false;
      return;
    }
    if (d.expecting === 'ack') {
      // Somebody drove this slot dominant, so the frame was acknowledged.
      if (bit === DOMINANT && node.phase === 'transmitting') node.ackedByAnyone = true;
      d.expecting = 'ack-delimiter';
      return;
    }
    if (d.expecting === 'ack-delimiter') {
      d.expecting = 'eof';
      d.eofSeen = 0;
      return;
    }
    // End of frame: seven recessive bits, and then the bus is free again.
    d.eofSeen++;
    if (d.eofSeen >= 7) {
      this.completeFrame(node);
      d.active = false;
      d.expecting = 'frame';
    }
  }

  /**
   * How many logical bits this frame has, once enough of it has arrived to
   * know. Returns 0 while the DLC is still unknown.
   */
  private frameLengthFrom(bits: readonly number[]): number {
    if (bits.length < 14) return 0;
    const extended = bits[13] === RECESSIVE; // IDE
    const headerBits = extended ? 39 : 19; // SOF through the DLC
    if (bits.length < headerBits) return 0;
    let dlc = 0;
    for (let i = 0; i < 4; i++) dlc = (dlc << 1) | bits[headerBits - 4 + i];
    const rtr = extended ? bits[32] === RECESSIVE : bits[12] === RECESSIVE;
    const dataBits = rtr ? 0 : Math.min(8, dlc) * 8;
    return headerBits + dataBits + 15; // plus the CRC
  }

  /** Verifies the CRC, which is what decides whether a node acknowledges. */
  private checkFrame(node: CanNodeState): boolean {
    const bits = node.decoder.bits;
    if (bits.length < 20) return false;
    const body = bits.slice(0, bits.length - 15);
    let received = 0;
    for (const bit of bits.slice(bits.length - 15)) received = (received << 1) | bit;
    return crc15(body) === received;
  }

  /** Turns a decoded bit stream back into a frame, at the end of the frame. */
  private completeFrame(node: CanNodeState): void {
    const bits = node.decoder.bits;
    const body = bits.slice(0, bits.length - 15);
    if (body.length < 19) return;
    const extended = body[13] === RECESSIVE;
    const headerBits = extended ? 39 : 19;

    let id = 0;
    if (!extended) {
      for (let i = 1; i <= 11; i++) id = (id << 1) | body[i];
    } else {
      for (let i = 1; i <= 11; i++) id = (id << 1) | body[i];
      for (let i = 14; i < 32; i++) id = (id << 1) | body[i];
    }
    const rtr = extended ? body[32] === RECESSIVE : body[12] === RECESSIVE;
    let dlc = 0;
    for (let i = 0; i < 4; i++) dlc = (dlc << 1) | body[headerBits - 4 + i];
    dlc = Math.min(8, dlc);

    const data = new Uint8Array(rtr ? 0 : dlc);
    for (let b = 0; b < data.length; b++) {
      let value = 0;
      for (let i = 0; i < 8; i++) value = (value << 1) | body[headerBits + b * 8 + i];
      data[b] = value;
    }
    const frame: CanFrame = { id, extended, rtr, data };

    if (node.phase === 'transmitting' && node.tx) {
      // Its own frame came back off the wire intact. Only now is it sent.
      node.sentCount++;
      node.queue.shift();
      node.tx = null;
      node.phase = 'idle';
      return;
    }
    if (node.phase === 'lost') node.phase = 'idle';
    node.received.push(frame);
    if (node.received.length > 64) node.received.shift();
    node.receivedCount++;
  }

  private note(text: string): void {
    this.log.push(text);
    if (this.log.length > 60) this.log.shift();
  }

  reset(): void {
    for (const node of this.nodes.values()) {
      node.phase = 'idle';
      node.tx = null;
      node.queue = [];
      node.decoder = newDecoder();
      node.received = [];
      node.sentCount = 0;
      node.receivedCount = 0;
      node.arbitrationLosses = 0;
      node.bitErrors = 0;
    }
    this.idleBits = 3;
    this.bitsStepped = 0;
    this.arbitrations = 0;
    this.lastBit = RECESSIVE;
    this.log = [];
  }

  snapshot(): DeviceSnapshot {
    const nodes = [...this.nodes.values()];
    return {
      status:
        `CAN bus — ${nodes.length} node(s), ${this.bitsStepped} bit(s), ` +
        `${this.arbitrations} arbitration(s), bus ${this.busIdle ? 'idle' : 'busy'}`,
      log: [...this.log],
    };
  }
}
