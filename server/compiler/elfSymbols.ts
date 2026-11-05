// A minimal reader for the 32-bit little-endian ELF files the Espressif
// toolchains link: function symbols by name, and the bytes at an address.
//
// The compile service uses it to tell the simulator where a handful of named
// routines landed in a build (see firmwareSymbols.ts). It parses only what the
// linker wrote for us, from our own build directory, and bounds every read by
// the file's length, so a malformed file yields nothing rather than an error
// that escapes.

export interface ElfSymbol {
  name: string;
  value: number;
  size: number;
  /** STT_FUNC (2) or STT_OBJECT (1). */
  type: number;
  section: number;
}

export interface ElfFile {
  symbols: ElfSymbol[];
  /** The bytes a loaded section holds at an address, or undefined. */
  read(address: number, length: number): Uint8Array | undefined;
}

interface Section {
  type: number;
  addr: number;
  offset: number;
  size: number;
  link: number;
  entsize: number;
}

const SHT_SYMTAB = 2;
const SHT_NOBITS = 8;

export function parseElf32(bytes: Uint8Array): ElfFile | undefined {
  if (bytes.length < 52 || bytes[0] !== 0x7f || bytes[1] !== 0x45 || bytes[2] !== 0x4c || bytes[3] !== 0x46) return undefined;
  if (bytes[4] !== 1 || bytes[5] !== 1) return undefined; // ELFCLASS32, little-endian
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u32 = (o: number) => (o + 4 <= bytes.length ? view.getUint32(o, true) : 0);
  const u16 = (o: number) => (o + 2 <= bytes.length ? view.getUint16(o, true) : 0);
  const shoff = u32(32);
  const shentsize = u16(46);
  const shnum = u16(48);
  if (shentsize < 40 || shnum > 4096 || shoff + shnum * shentsize > bytes.length) return undefined;
  const sections: Section[] = [];
  for (let i = 0; i < shnum; i++) {
    const o = shoff + i * shentsize;
    sections.push({ type: u32(o + 4), addr: u32(o + 12), offset: u32(o + 16), size: u32(o + 20), link: u32(o + 24), entsize: u32(o + 36) });
  }
  const symbols: ElfSymbol[] = [];
  for (const sec of sections) {
    if (sec.type !== SHT_SYMTAB || sec.entsize < 16) continue;
    const strtab = sections[sec.link];
    if (!strtab || sec.offset + sec.size > bytes.length) continue;
    const count = Math.floor(sec.size / sec.entsize);
    for (let i = 0; i < count; i++) {
      const o = sec.offset + i * sec.entsize;
      const nameOff = u32(o);
      const info = bytes[o + 12];
      const type = info & 0xf;
      if (type !== 1 && type !== 2) continue;
      let name = '';
      for (let k = strtab.offset + nameOff; k < bytes.length && k < strtab.offset + strtab.size && bytes[k] !== 0 && name.length < 256; k++) {
        name += String.fromCharCode(bytes[k]);
      }
      if (name) symbols.push({ name, value: u32(o + 4), size: u32(o + 8), type, section: u16(o + 14) });
    }
  }
  return {
    symbols,
    read(address, length) {
      for (const sec of sections) {
        if (sec.type === SHT_NOBITS || sec.addr === 0) continue;
        if (address >= sec.addr && address + length <= sec.addr + sec.size) {
          const start = sec.offset + (address - sec.addr);
          if (start + length > bytes.length) return undefined;
          return bytes.subarray(start, start + length);
        }
      }
      return undefined;
    },
  };
}
