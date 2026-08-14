// RS-485: a differential pair with more than one thing allowed on it.
//
// The reason this is not a board-to-board UART bridge, and must never become
// one: RS-485 is a BUS. Its whole character comes from what happens when more
// than two nodes share it — who is allowed to drive, what everyone else hears
// while they do, and what happens when two of them drive at once. A hidden
// point-to-point link would reproduce none of that and would make a design
// with no turnaround discipline look like it worked.
//
// WHAT THE PAIR CARRIES, and why. The bus carries BYTES with modelled timing,
// not individual bits, and that is forced by the emulator rather than chosen:
// an AVR's USART hands its output to a callback and never drives the physical
// TX pad, so there are no edges on DI to put on a wire. Everything that makes
// RS-485 a bus rather than a link is still real — who may drive, who hears,
// self-echo, and what two drivers do to each other — but a sketch that
// bit-bangs its own framing on DI will not be carried, and a baud mismatch
// between two nodes is not detected. That is written down here and in the
// part's own description rather than left for someone to discover.
//
// The consequences are the point:
//
//   * DE low means the node is not driving. A sketch that forgets to raise it
//     transmits into its own transceiver and nothing reaches the bus.
//   * /RE high means the node is deaf, including to itself.
//   * An idle bus reads as a mark, because real installations bias it that
//     way and a UART needs an idle line to be high.
//   * Two drivers with the same data are harmless. Two drivers that disagree
//     are a contention: the differential is not a valid level and every
//     receiver on the bus gets rubbish, which is what a real fight between
//     two output stages produces.
//
// NOT modelled, and not claimed: the actual differential voltages, common-mode
// range, failsafe biasing values, termination and reflections, cable length,
// slew-rate limiting and the resulting maximum baud, driver current limits,
// and thermal shutdown. Contention here corrupts data; on real hardware it
// also gets warm.

import type { DeviceSnapshot } from './types';

/** A byte as it came off the pair. */
export interface BusByte {
  value: number;
  /** True when more than one driver was enabled while it was sent. */
  corrupted: boolean;
}

/**
 * How a contended byte is mangled.
 *
 * Two output stages fighting do not produce one of the two messages — they
 * produce a level that is neither, and a UART sampling it gets something that
 * is usually not either byte. Flipping alternate bits is a deterministic
 * stand-in for that: it is never accidentally equal to what either node sent,
 * which is the property the test needs.
 */
export function mangle(byte: number): number {
  return byte ^ 0x55;
}

/**
 * One differential pair, shared by every transceiver wired to it.
 *
 * The bus owns the two things that make RS-485 what it is: who is currently
 * driving, and what happens to traffic when that is more than one node.
 */
export class Rs485Bus {
  readonly id: string;
  private drivers = new Set<string>();
  private contentions = 0;
  private carried = 0;

  constructor(id: string) {
    this.id = id;
  }

  /** A node raises or drops DE. */
  setDriver(nodeId: string, driving: boolean): void {
    if (driving) this.drivers.add(nodeId);
    else this.drivers.delete(nodeId);
  }

  /**
   * A byte from one node, as every listener will hear it.
   *
   * Corruption is decided by how many drivers are enabled AT THIS MOMENT, not
   * by whose byte it is: a node that keys up in the middle of someone else's
   * message destroys it, which is exactly the failure a half-duplex protocol
   * with no turnaround discipline suffers.
   */
  carry(byte: number, fromNodeId: string): BusByte | null {
    if (!this.drivers.has(fromNodeId)) return null;
    this.carried++;
    if (this.drivers.size > 1) {
      this.contentions++;
      return { value: mangle(byte), corrupted: true };
    }
    return { value: byte, corrupted: false };
  }

  /** True while the pair is idle, which a biased installation reads as a mark. */
  get idle(): boolean {
    return this.drivers.size === 0;
  }
  get driverCount(): number {
    return this.drivers.size;
  }
  get contentionCount(): number {
    return this.contentions;
  }
  get byteCount(): number {
    return this.carried;
  }
  get driverIds(): string[] {
    return [...this.drivers];
  }

  reset(): void {
    this.drivers.clear();
    this.contentions = 0;
    this.carried = 0;
  }
}

/**
 * A MAX485-style transceiver.
 *
 * Four control pins and a pair, and every one of them matters. The model holds
 * only what the part itself knows; the bus holds what the wire is doing.
 */
export class Max485Device {
  readonly instanceId: string;

  private driverEnabled = false;
  private receiverEnabled = true;
  private sent = 0;
  private received = 0;
  private corrupted = 0;
  private log: string[] = [];

  constructor(instanceId: string) {
    this.instanceId = instanceId;
  }

  /** DE, active high. */
  get driving(): boolean {
    return this.driverEnabled;
  }
  /** /RE, active low — so this is true when the pin is LOW. */
  get listening(): boolean {
    return this.receiverEnabled;
  }
  get sentCount(): number {
    return this.sent;
  }
  get receivedCount(): number {
    return this.received;
  }
  get corruptedCount(): number {
    return this.corrupted;
  }

  setDriverEnable(high: boolean): boolean {
    if (high === this.driverEnabled) return false;
    this.driverEnabled = high;
    this.note(high ? 'driver enabled' : 'driver released');
    return true;
  }
  setReceiverEnable(low: boolean): boolean {
    if (low === this.receiverEnabled) return false;
    this.receiverEnabled = low;
    this.note(low ? 'receiver enabled' : 'receiver disabled');
    return true;
  }

  noteSent(): void {
    this.sent++;
  }
  /**
   * A byte off the pair, which this node hears only if its receiver is on.
   *
   * A disabled receiver hears nothing, INCLUDING ITS OWN TRANSMISSION — which
   * is why half-duplex code raises RE while it talks, and why a node that
   * forgets to sees an echo of everything it said.
   */
  receive(byte: BusByte): number | null {
    if (!this.receiverEnabled) return null;
    this.received++;
    if (byte.corrupted) this.corrupted++;
    return byte.value;
  }

  private note(text: string): void {
    this.log.push(text);
    if (this.log.length > 40) this.log.shift();
  }

  reset(): void {
    this.driverEnabled = false;
    this.receiverEnabled = true;
    this.sent = 0;
    this.received = 0;
    this.corrupted = 0;
    this.log = [];
  }

  snapshot(): DeviceSnapshot {
    return {
      status:
        `MAX485 — ${this.driverEnabled ? 'driving' : 'released'}, ` +
        `receiver ${this.receiverEnabled ? 'enabled' : 'disabled'}, ` +
        `${this.sent} byte(s) sent, ${this.received} received` +
        (this.corrupted ? `, ${this.corrupted} corrupted by contention` : ''),
      log: [...this.log],
    };
  }
}
