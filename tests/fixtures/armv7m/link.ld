MEMORY { FLASH (rx) : ORIGIN = 0x00000000, LENGTH = 1M  RAM (rwx) : ORIGIN = 0x20000000, LENGTH = 256K }
_estack = ORIGIN(RAM) + LENGTH(RAM);
SECTIONS {
  .text : { KEEP(*(.isr_vector)) *(.text*) *(.rodata*) KEEP(*(.init)) KEEP(*(.fini)) . = ALIGN(4); } > FLASH
  .ARM.exidx : { *(.ARM.exidx*) } > FLASH
  .preinit_array : { PROVIDE(__preinit_array_start = .); KEEP(*(.preinit_array)) PROVIDE(__preinit_array_end = .); } > FLASH
  .init_array : { PROVIDE(__init_array_start = .); KEEP(*(.init_array*)) PROVIDE(__init_array_end = .); } > FLASH
  .fini_array : { PROVIDE(__fini_array_start = .); KEEP(*(.fini_array*)) PROVIDE(__fini_array_end = .); } > FLASH
  _sidata = .;
  .data : AT(_sidata) { _sdata = .; *(.data*) . = ALIGN(4); _edata = .; } > RAM
  .bss : { _sbss = .; *(.bss*) *(COMMON) . = ALIGN(4); _ebss = .; } > RAM
  _end = .; PROVIDE(end = .);
}
