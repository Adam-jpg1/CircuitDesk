// The inter-core FIFO status register, modelled for a single running core.
//
// WHY THIS EXISTS
//
// rp2040js does not model SIO's inter-core mailbox (FIFO_ST, FIFO_WR,
// FIFO_RD at SIO offsets 0x50-0x58) and logs a `console.warn` straight to the
// console for every access. The Pico SDK's startup clears the FIFO's sticky
// error flags on the way up, so every Pico simulation printed
// "Write to invalid SIO address: 50" into the user's console before their
// sketch had even started.
//
// Silencing that would be the wrong fix, because the register does have a
// correct value here. CircuitDesk runs core 0 only — the second core is not
// simulated, and the capability text says so — and a core that never starts
// never sends anything. So the mailbox is permanently empty and permanently
// ready to accept a word that nothing will ever read:
//
//   VLD (bit 0) = 0   nothing in the receive FIFO, because core 1 sent nothing
//   RDY (bit 1) = 1   the transmit FIFO is not full
//   WOF (bit 2)       sticky write-on-full, cleared by writing a 1
//   ROE (bit 3)       sticky read-on-empty, cleared by writing a 1
//
// Reading FIFO_RD on an empty FIFO sets ROE and returns zero, which is what
// the datasheet specifies (section 2.3.1.5). A sketch that tries to use the
// second core therefore sees an idle mailbox rather than a fabricated reply.

const FIFO_ST = 0x50;
const FIFO_WR = 0x54;
const FIFO_RD = 0x58;

const ST_VLD = 1 << 0;
const ST_RDY = 1 << 1;
const ST_WOF = 1 << 2;
const ST_ROE = 1 << 3;

interface SioHost {
  sio: {
    readUint32(offset: number): number;
    writeUint32(offset: number, value: number): void;
  };
}

/**
 * Installs the mailbox registers over rp2040js's SIO block.
 *
 * Every other offset is delegated untouched, so this adds the three registers
 * without taking responsibility for the rest of SIO.
 */
export function installSioFifo(rp: SioHost): void {
  const sio = rp.sio;
  const read = sio.readUint32.bind(sio);
  const write = sio.writeUint32.bind(sio);
  let sticky = 0;

  sio.readUint32 = (offset: number): number => {
    switch (offset) {
      case FIFO_ST:
        // Never valid (core 1 sends nothing), always ready (nothing fills it).
        return ST_RDY | sticky;
      case FIFO_RD:
        // Reading an empty FIFO is an error the hardware records and returns 0.
        sticky |= ST_ROE;
        return 0;
      default:
        return read(offset);
    }
  };

  sio.writeUint32 = (offset: number, value: number): void => {
    switch (offset) {
      case FIFO_ST:
        // Writing a 1 clears a sticky flag; the other bits are read-only.
        sticky &= ~(value & (ST_WOF | ST_ROE));
        return;
      case FIFO_WR:
        // The word is accepted and discarded: no core is there to read it.
        return;
      default:
        write(offset, value);
    }
  };
}

/** The bit layout, exported so tests can assert against named constants. */
export const SIO_FIFO_BITS = { VLD: ST_VLD, RDY: ST_RDY, WOF: ST_WOF, ROE: ST_ROE, FIFO_ST, FIFO_WR, FIFO_RD };
