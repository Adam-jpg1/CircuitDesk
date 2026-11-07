// The host half of a simulated USB CDC connection, shared by the device
// controller models (the RA4M1's USBFS, the nRF52840's USBD).
//
// It does what a computer does when the board is plugged in: descriptors,
// address, configuration, line coding, DTR — each step started by the
// previous one's completion, on the chip's clock, never as a promise (the
// simulation is synchronous). What differs between controllers is how a
// control transfer reaches the device and how SET_ADDRESS is handled, so
// those come from the controller.

export const setupPacket = (type: number, request: number, value: number, index: number, length: number): number[] => [
  type, request, value & 0xff, value >> 8, index & 0xff, index >> 8, length & 0xff, length >> 8,
];

export interface CdcEndpoints {
  /** The CDC communications interface, which line coding and DTR address. */
  commInterface: number;
  /** Bulk IN endpoint number, or -1. */
  dataIn: number;
  /** Bulk OUT endpoint number, or -1. */
  dataOut: number;
}

/** The CDC interfaces and bulk endpoints in a configuration descriptor. */
export function findCdc(config: number[]): CdcEndpoints {
  const found: CdcEndpoints = { commInterface: 0, dataIn: -1, dataOut: -1 };
  let cls = -1;
  for (let i = 0; i + 1 < config.length && config[i] > 0; i += config[i]) {
    const type = config[i + 1];
    if (type === 4) {
      cls = config[i + 5];
      if (cls === 0x02) found.commInterface = config[i + 2];
    } else if (type === 5 && cls === 0x0a) {
      const addr = config[i + 2];
      if ((config[i + 3] & 3) !== 2) continue;
      if (addr & 0x80) found.dataIn = addr & 0xf;
      else found.dataOut = addr & 0xf;
    }
  }
  return found;
}

export interface CdcHostPort {
  /** Runs one control transfer; `done` gets the IN data stage, if any. */
  request(setup: number[], out: number[] | undefined, done: (data: number[]) => void): void;
  /** SET_ADDRESS, however this controller handles it. */
  setAddress(address: number, done: () => void): void;
  /** Called with the CDC endpoints just before SET_CONFIGURATION. */
  configuring(cdc: CdcEndpoints): void;
  /** The port is open: configured, line coding set, DTR asserted. */
  opened(): void;
}

/** Enumerates a CDC device and opens its port, one step after another. */
export function enumerateCdc(port: CdcHostPort): void {
  let cdc: CdcEndpoints = { commInterface: 0, dataIn: -1, dataOut: -1 };
  const steps: ((next: (data: number[]) => void, last: number[]) => void)[] = [
    (next) => port.request(setupPacket(0x80, 6, 0x0100, 0, 64), undefined, next),
    (next) => port.setAddress(5, () => next([])),
    (next) => port.request(setupPacket(0x80, 6, 0x0100, 0, 18), undefined, next),
    (next) => port.request(setupPacket(0x80, 6, 0x0200, 0, 9), undefined, next),
    (next, head) => {
      const total = head.length >= 4 ? head[2] | (head[3] << 8) : 9;
      port.request(setupPacket(0x80, 6, 0x0200, 0, total), undefined, next);
    },
    (next, config) => {
      cdc = findCdc(config);
      port.configuring(cdc);
      port.request(setupPacket(0x00, 9, config[5] ?? 1, 0, 0), undefined, next);
    },
    // 115200 8N1, then DTR and RTS.
    (next) => port.request(setupPacket(0x21, 0x20, 0, cdc.commInterface, 7), [0x00, 0xc2, 0x01, 0x00, 0, 0, 8], next),
    (next) => port.request(setupPacket(0x21, 0x22, 3, cdc.commInterface, 0), undefined, next),
    () => port.opened(),
  ];
  const run = (i: number, last: number[]) => {
    if (i < steps.length) steps[i]((data) => run(i + 1, data), last);
  };
  run(0, []);
}
