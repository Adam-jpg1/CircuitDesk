// What an ARMv7-M core needs from the chip around it.
//
// The core owns the private peripheral bus — the NVIC, SysTick, the system
// control block, the DWT cycle counter, the FPU's control registers — because
// those are part of every Cortex-M3, M4 and M7 alike. Everything below
// 0xE0000000 is the chip's: its flash, its RAM, its peripherals. Memory that
// is plain storage is handed to the core as regions so loads and stores reach
// it without a call; everything else goes through the chip's read and write.

export interface MemoryRegion {
  /** First address, inclusive. */
  start: number;
  /** One past the last address. */
  end: number;
  bytes: Uint8Array;
  /** Writes are ignored (flash), and a write anywhere in it invalidates no code. */
  readOnly?: boolean;
}

export interface ArmChip {
  /** Plain storage the core may read and write directly, checked in order. */
  readonly regions: MemoryRegion[];
  /** Any other address below the private peripheral bus. Width is 1, 2 or 4 bytes. */
  read(address: number, width: 1 | 2 | 4): number;
  write(address: number, value: number, width: 1 | 2 | 4): void;
  /** Called when firmware writes an address in the vendor-specific system space (0xE0040000+). */
  readSystem?(address: number, width: 1 | 2 | 4): number | undefined;
  writeSystem?(address: number, value: number, width: 1 | 2 | 4): boolean;
}

export interface CortexMConfig {
  /** 'm3', 'm4' (with single-precision FPU when `fpu` is set) or 'm7' (double-precision FPU). */
  variant: 'm3' | 'm4' | 'm7';
  /** 'sp' single precision (FPv4-SP), 'dp' single and double (FPv5-D16), or none. */
  fpu?: 'sp' | 'dp';
  /** External interrupt lines the NVIC has. */
  irqCount: number;
  /** Implemented priority bits: 3 on the nRF52, 4 on most others. */
  priorityBits: number;
  /** CPUID as the SCB reports it. */
  cpuid: number;
}
