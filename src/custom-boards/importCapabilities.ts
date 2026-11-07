// What each importer actually does, stated once, honestly.
//
// The failure this exists to prevent is a specific and common one: a format
// appears in a list of supported imports, a user brings a file, and what comes
// back is a rectangle with no pins and no explanation. The format was
// "supported" in the sense that a parser existed; it was not supported in the
// sense the user meant.
//
// So every importer is classified by what it produces, in four levels, and the
// UI shows the level next to the name BEFORE the user picks a file. The
// classification is derived from what the parsers genuinely extract — it was
// written by reading them, and the tests assert that a format claiming pins has
// a parser that produces pins.
//
// The levels mean:
//
//   complete       identity, geometry, pins and — where the file says so — a
//                  processor suggestion. Import, confirm, use.
//   pins-geometry  real pins and a real outline, but nothing about the chip.
//                  You choose the processor; that is a question, not a gap.
//   artwork-only   a picture and dimensions. Pins are placed by hand.
//   visual-only    a rendering for reference. No pin semantics are inferred,
//                  because none can be inferred reliably from the format.

export type ImportCapabilityLevel = 'complete' | 'pins-geometry' | 'artwork-only' | 'visual-only';

export interface ImportCapability {
  format: string;
  name: string;
  level: ImportCapabilityLevel;
  /** What comes out, in the words a user would use. */
  produces: string;
  /** What does NOT come out. Stated, never left to be discovered. */
  limitation?: string;
}

export const IMPORT_CAPABILITIES: ImportCapability[] = [
  {
    format: 'cdboard',
    name: 'CircuitDesk board file',
    level: 'complete',
    produces:
      'Everything: identity, revision, outline, artwork, every pin with its processor pad, ' +
      'the processor and pipeline, and the peripheral assignments.',
  },
  {
    format: 'circuitdesk',
    name: 'CircuitDesk project',
    level: 'complete',
    produces: 'A whole project, including any custom boards embedded in it.',
  },
  {
    format: 'csv',
    name: 'CSV pin map',
    level: 'pins-geometry',
    produces:
      'Pins with their labels and, where the file has a processor-pin column, their pads. ' +
      'A label column alone is enough: the pins are stacked for you to place.',
    limitation:
      'A pin table says nothing about the chip, so the processor is yours to choose. ' +
      'Without x/y columns the positions are yours to place.',
  },
  {
    format: 'svg',
    name: 'SVG board artwork',
    level: 'artwork-only',
    produces: 'The board\'s face and its dimensions, sanitised down to drawing instructions.',
    limitation: 'An SVG has no pin data, so pins are placed by hand or imported alongside from a CSV.',
  },
  {
    format: 'kicad',
    name: 'KiCad PCB',
    level: 'pins-geometry',
    produces:
      'The Edge.Cuts outline and every pad with its number, position and net, from real ' +
      's-expression parsing of .kicad_pcb and .kicad_mod.',
    limitation:
      'Pads are copper, not silicon: which pad reaches which processor pin is not in the file, ' +
      'so the mapping is yours. Schematic files carry coordinates only.',
  },
  {
    format: 'eagle',
    name: 'Autodesk Eagle',
    level: 'pins-geometry',
    produces: 'The layer-20 outline, elements, packages and pads with their signal names, from real XML parsing.',
    limitation: 'Schematics have no positions, so a .sch yields the part list rather than a board.',
  },
  {
    format: 'fritzing',
    name: 'Fritzing part',
    level: 'pins-geometry',
    produces: 'Connector ids and names from the .fzp, plus the part\'s own SVG artwork out of the archive.',
    limitation:
      'Fritzing connectors carry no processor mapping, and a part archive describes one part rather than a board.',
  },
  {
    format: 'easyeda',
    name: 'EasyEDA document',
    level: 'pins-geometry',
    produces: 'Board shape and PAD objects with coordinates and nets, from the document structure.',
    limitation: 'Schematic-only documents have no coordinates and yield no board.',
  },
  {
    format: 'gerber',
    name: 'Gerber / drill',
    level: 'visual-only',
    produces: 'A layer-by-layer rendering of the copper, silkscreen, mask and drill data, with toggles.',
    limitation:
      'Gerber describes manufacturing, not connectivity. A flashed pad is not distinguishable from a via or ' +
      'a fiducial, so CircuitDesk does not infer pins from it: use it as the artwork and bring a pin map.',
  },
  {
    format: 'zip-bundle',
    name: 'Zipped part bundle',
    level: 'pins-geometry',
    produces: 'metadata.json, board.svg and pinmap.csv read together into one part.',
    limitation: 'The processor is whatever the metadata names, confirmed by you, never assumed.',
  },
];

export function importCapability(format: string): ImportCapability | undefined {
  return IMPORT_CAPABILITIES.find((c) => c.format === format);
}

/** Short badge text for the format list. */
export function capabilityLabel(level: ImportCapabilityLevel): string {
  switch (level) {
    case 'complete': return 'Complete board';
    case 'pins-geometry': return 'Pins + outline';
    case 'artwork-only': return 'Artwork only';
    case 'visual-only': return 'Visual reference';
  }
}
