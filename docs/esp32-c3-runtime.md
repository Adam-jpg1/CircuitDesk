# ESP32-C3 runtime

Status: **execution core and firmware loader done and verified; ROM-call layer
is the remaining blocker.** This note records what was measured, not what was
assumed, so the next session starts from evidence.

## Board identity — naming issue, unresolved by design

CircuitDesk's existing entry is `board.esp32-c3`, publicly named
**"ESP32-C3 DevKitM"**. That name does not match any Espressif product, and the
definition does not match one either:

| | CircuitDesk entry | Real ESP32-C3-DevKitM-1 |
| --- | --- | --- |
| Header pins | 19, across two headers | 30, two 15-pin headers |
| USB | USB-C | Micro-USB |
| Board size | 25.4 × 52 mm | ≈22.9 × 51.1 mm |
| UART pins | `TX0` / `RX0`, no GPIO number | GPIO21 (TX) / GPIO20 (RX) |
| GPIO20/21 | absent | present |

Espressif's product is **ESP32-C3-DevKitM-1** (ESP32-C3-MINI-1 module), and
there is also an ESP32-C3-DevKitC-02. "ESP32-C3 DevKitM" is neither. The
Espressif Arduino core does not ship a DevKitM-1 board entry at all — its
generic entry is `esp32c3`, named "ESP32C3 Dev Module", which is what every
Espressif C3 development board is built as.

Per the project rule that real third-party hardware must carry its actual
product name, **the public name has not been changed**. Two honest options,
for a decision:

1. Correct the definition into a real **ESP32-C3-DevKitM-1** — 30 pins,
   Micro-USB, correct dimensions, GPIO20/21 as the UART — and use that exact
   product name. This changes the pin set, so existing saved projects that
   reference it would need care.
2. Rename to a generic, non-product label such as **"ESP32-C3 Dev Module"**,
   matching the Arduino core's own generic entry, and leave the reduced pin set
   as an explicitly generic breakout.

Option 1 is the better one: it is a real board a user can buy, and the pin
identifiers then match its silk screen.

### Naming audit note

Only one other third-party board name looks questionable: **"ESP32 DevKit V1"**
is a community label rather than a single manufacturer's product, and several
incompatible boards ship under it. Flagged for the dedicated naming audit, not
changed here.

## Compiler

FQBN **`esp32:esp32:esp32c3`** (Espressif core 3.3.11), allowlisted in
`SUPPORTED_TARGETS` like every other target; no arguments reach it from the
frontend. `f_cpu` 160 MHz, 4 MB flash, 1,310,720-byte application partition,
327,680 bytes of RAM.

Measured on this machine:

| | |
| --- | --- |
| Installed core | **5.6 GB** |
| Install time | 143 s |
| Cold compile | 13.0 s |
| Warm compile | 3.1 s |
| Peak RAM during compile | +413 MB |
| Download cache (deletable after install) | 1.7 GB |

**5.6 GB → 2.6 GB after trimming**, verified by compiling the same sketch
afterwards and getting a byte-identical result:

* `tools/esp-x32` — the Xtensa toolchain, 1.1 GB. The C3 is RISC-V and never
  uses it.
* the seven non-C3 chip library sets (`esp32`, `s2`, `s3`, `c5`, `c6`, `h2`,
  `p4`, `p4_es`) — 1.9 GB.
* `tools/riscv32-esp-elf-gdb` — 124 MB, a debugger, not needed to compile.

Nothing has been deployed. For comparison, the RP2040 core is 1.5 GB (816 MB
trimmed), so an image carrying AVR + RP2040 + ESP32-C3 trimmed would be roughly
3.7 GB of toolchain.

## Firmware format

An ESP32-C3 build writes four binaries. The one that executes is the
application image; the others exist to get it into flash on real hardware.

| Artifact | Size (blink) | Role |
| --- | --- | --- |
| `.ino.bin` | 286,224 B | application image — **this is what runs** |
| `.ino.bootloader.bin` | 19,536 B | second-stage bootloader |
| `.ino.partitions.bin` | 3,072 B | partition table |
| `.ino.merged.bin` | 4,194,304 B | the other three at their flash offsets |
| `.ino.elf` | 6.5 MB | symbols, used here only for diagnostics |

The application image is self-describing. Parsed from real blink firmware:

```
entry 0x403807ca   chip id 5 (esp32c3)   6 segments   SHA-256 appended
  0x3c030020    64404  DROM (flash-mapped constants)
  0x3fc8d400     1116  DRAM
  0x42000020   159892  IROM (flash-mapped code)
  0x3fc8d85c     6712  DRAM
  0x40380000    53952  IRAM
  0x50000000       32  RTC fast memory
```

`src/simulation/esp32c3/espImage.ts` parses this and refuses AVR Intel HEX, an
RP2040 UF2, a wrong chip id, a truncated image, a segment outside the chip's
documented memory map, and an image larger than the application partition.

## Boot strategy

The smallest technically accurate path is to **load the application image's
segments at their own load addresses and start at its own entry point**.

That is not a shortcut around the boot process; it is the result of it. On
hardware the mask ROM reads the partition table to find this image, and the
second-stage bootloader then copies these exact segments to these exact
addresses and jumps to this exact entry point. Reproducing the outcome needs no
Espressif ROM code, no bootloader, and no partition parsing, and the firmware
is never patched.

Confirmed by execution: the entry point resolves to **`call_start_cpu0`**, the
ESP-IDF startup function, and it executes real instructions immediately.

## CPU

`src/simulation/riscv/rv32Core.ts` — an RV32IMC_Zicsr interpreter written from
the public RISC-V specifications. Deliberately generic: nothing in it knows
what an ESP32-C3 is, memory and peripherals arrive through a `Bus` interface,
so it also serves ESP32-C6, ESP32-H2, CH32V and any other RISC-V target later.

Why not an existing emulator: the mature browser-capable ones are QEMU builds
(GPLv2) or AGPLv3 projects, neither compatible with this project's permissive
licensing route; the permissively licensed JavaScript ones are teaching
exercises with no compressed extension and no CSR support; npm's `riscv`
package is an encoding-table helper, not an emulator.

66 checks against hand-assembled programs cover base arithmetic, x0's hardwired
zero, shifts and comparisons, all load and store widths, signed and unsigned
branches, jump linkage, the M extension including the spec's division edge
cases, compressed encodings interleaved with 32-bit ones, CSRs, traps, WFI and
interrupt entry, and a real loop. They already caught a bug: `mepc` recorded
the address *after* a synchronous trap rather than the offending instruction's.

## The remaining blocker: ROM calls

ESP-IDF startup calls into the ESP32-C3 mask ROM, which is linked at fixed
addresses through Espressif's public `esp32c3.rom.ld`. The blink ELF resolves
**1,577** such symbols.

Tracing execution with ROM entries logged and stubbed shows the startup path
touches only **five distinct ROM functions** before it needs real answers:

| # | Address | Symbol | Assessment |
| --- | --- | --- | --- |
| 0 | `0x40000018` | `esp_rom_get_reset_reason` | Trivial — report a power-on reset |
| 1 | `0x40000354` | `memset` | Trivial |
| 2 | `0x40000520` | `Cache_Enable_ICache` | No-op here: segments are already at their final addresses, there is no cache to enable |
| 3 | `0x40000548` | `Cache_Set_IDROM_MMU_Size` | Same reasoning — nothing to map |
| 4 | `0x40001960` | `esp_rom_regi2c_write_mask` | Internal analog register access, used for clock configuration; modelled as a register file |

This is the same shape as the RP2040 boot ROM problem, which was solved the
same way: implement independently, from documented behaviour, only what the
firmware actually calls, and let anything unimplemented fail loudly rather than
return a fabricated value. **No Espressif ROM binary or source is used.**

Peripheral pages the startup path touches, for the next pass:

```
0x600c0000 SYSTEM    0x600c2000 INTERRUPT   0x600c4000 EXTMEM/cache
0x60008000 RTC       0x60002000 SPI1        0x60003000 SPI0
0x600ce000           0x60026000             0x6001c000
0x6001d000           0x60005000             0x60006000
```

## Not yet started

Peripherals (GPIO, timers, UART, interrupt controller), the `BoardRunner`
adapter, canvas integration, Pin States, and the board's capability text. The
board remains **not Simulated**, and no capability claim was added.
