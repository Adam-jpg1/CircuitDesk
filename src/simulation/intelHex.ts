/**
 * Highest flash byte address referenced by an Intel HEX image, without
 * writing anything. Used to reject firmware built for a larger MCU instead of
 * silently truncating it into a smaller chip's address space.
 */
export function intelHexHighestAddress(hexText: string): number {
  let extendedAddress = 0;
  let highest = -1;
  for (const rawLine of hexText.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith(':')) continue;
    const bytes: number[] = [];
    for (let i = 1; i < line.length; i += 2) bytes.push(parseInt(line.substring(i, i + 2), 16));
    const count = bytes[0];
    const address = (bytes[1] << 8) | bytes[2];
    const type = bytes[3];
    const data = bytes.slice(4, 4 + count);
    if (type === 0x00) highest = Math.max(highest, extendedAddress + address + data.length - 1);
    else if (type === 0x02) extendedAddress = ((data[0] << 8) | data[1]) << 4;
    else if (type === 0x04) extendedAddress = ((data[0] << 8) | data[1]) << 16;
    else if (type === 0x01) break;
  }
  return highest;
}

/** Parses Intel HEX text into a flat byte buffer (AVR flash image). */
export function parseIntelHex(hexText: string, target: Uint8Array): number {
  let extendedAddress = 0;
  let maxAddress = 0;
  for (const rawLine of hexText.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith(':')) continue;
    const bytes: number[] = [];
    for (let i = 1; i < line.length; i += 2) {
      bytes.push(parseInt(line.substring(i, i + 2), 16));
    }
    const count = bytes[0];
    const address = (bytes[1] << 8) | bytes[2];
    const type = bytes[3];
    const data = bytes.slice(4, 4 + count);
    const checksum = bytes[4 + count];
    const sum = bytes.slice(0, 4 + count).reduce((a, b) => a + b, 0);
    if (((sum + checksum) & 0xff) !== 0) {
      throw new Error('Intel HEX checksum error: firmware appears corrupted.');
    }
    if (type === 0x00) {
      const base = extendedAddress + address;
      for (let i = 0; i < data.length; i++) {
        if (base + i < target.length) {
          target[base + i] = data[i];
          maxAddress = Math.max(maxAddress, base + i);
        }
      }
    } else if (type === 0x02) {
      extendedAddress = ((data[0] << 8) | data[1]) << 4;
    } else if (type === 0x04) {
      extendedAddress = ((data[0] << 8) | data[1]) << 16;
    } else if (type === 0x01) {
      break;
    }
  }
  return maxAddress + 1;
}
