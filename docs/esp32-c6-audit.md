# ESP32-C6 audit

Measured facts, taken from Espressif's own headers in the installed
`esp32:esp32@3.3.11` core and from real compiled firmware. Nothing here is from
memory; anything not yet verified is marked as such.

## The headline finding

The ESP32-C6 is **not** an ESP32-C3 with a different number. Both are Espressif
RISC-V parts, and almost nothing about the address space carries over. Reusing
the C3's *architecture* is right; reusing its *addresses* would be wrong
everywhere.

## Memory map

| | ESP32-C3 | ESP32-C6 |
| --- | --- | --- |
| Instruction RAM | `0x40380000`–`0x403E0000` | `0x40800000`–`0x40880000` |
| Data RAM | `0x3FC80000`–`0x3FCE0000` | same window as above |
| Flash-mapped code | `0x42000000`–`0x42800000` | `0x42000000`–`0x43000000` |
| Flash-mapped constants | `0x3C000000`–`0x3C800000` | same window as above |
| Low-power memory | `0x50000000`–`0x50002000` (8 KB) | `0x50000000`–`0x50004000` (16 KB) |
| Flash MMU entries | 128 | 256 |

The C6 **unifies** both pairs of windows the C3 splits. A C6 image loaded
against the C3's region table has every segment fall outside every region, which
is what makes cross-family rejection precise rather than accidental.

Source: `soc/esp32c6/include/soc/soc.h`, `ext_mem_defs.h`.

## Peripheral base addresses

Every block that matters has moved, and two have swapped:

| Peripheral | ESP32-C3 | ESP32-C6 |
| --- | --- | --- |
| UART0 | `0x60000000` | `0x60000000` |
| UART1 | `0x60010000` | `0x60001000` |
| SPI0 (cache) | `0x60003000` | `0x60002000` |
| SPI1 (flash) | `0x60002000` | `0x60003000` |
| System timer | `0x60023000` | `0x6000A000` |
| GPIO | `0x60004000` | `0x60091000` |
| IO MUX | `0x60009000` | `0x60090000` |

The C6 also replaces the C3's `SYSTEM` block with `PCR` for clock and reset
control (`0x60096000`) and adds a family of low-power peripherals at
`0x600B0000` and above that the C3 does not have.

Source: `soc/esp32c6/register/soc/reg_base.h`.

## GPIO

- 31 GPIOs, `SOC_GPIO_PIN_COUNT = 31` (the C3 has 22).
- ADC1 with 7 channels on GPIO0–GPIO6.
- Arduino defaults for the `esp32c6` variant: `TX = 16`, `RX = 17`,
  `SDA = 23`, `SCL = 22`, `SS = 18`, `MOSI = 19`, `MISO = 20`, `SCK = 21`,
  `A0`–`A6` = GPIO0–GPIO6, RGB LED on GPIO8, and a fixed low-power I²C on
  `SDA1 = 6` / `SCL1 = 7`.

Source: `variants/esp32c6/pins_arduino.h`, `soc_caps.h`.

**Not yet verified:** the physical header layout of the ESP32-C6-DevKitC-1 —
which GPIOs appear on which side, in what silkscreen order. The Arduino core
carries the chip's pin capabilities but not the board's header arrangement, so
the board definition is deliberately not written from guesswork. It needs the
official DevKitC-1 pin layout from Espressif's board documentation.

## Compiler target

- FQBN `esp32:esp32:esp32c6`, core `esp32:esp32`, variant `esp32c6`.
- The core's generic entry is named "ESP32C6 Dev Module"; Espressif's own
  development board is the ESP32-C6-DevKitC-1, which is what CircuitDesk should
  present publicly.
- Application partition 1,310,720 bytes; 327,680 bytes of RAM; 160 MHz.

### Incremental footprint

This was the question worth measuring rather than guessing, and the answer is
good:

| Component | Size |
| --- | --- |
| `esp-rv32` toolchain | 2050 MB — **already installed for the C3, shared** |
| `esp32c3-libs` | 231 MB |
| `esp32c6-libs` | 264 MB |

Adding the C6 to a service that already compiles for the C3 costs **264 MB**,
not another toolchain. Cold compile 14 s, warm compile 3 s.

## Firmware image

A real `esp32:esp32:esp32c6` build of a blink sketch:

```
magic 0xe9  segments 5  entry 0x40800828  chip_id 0x0d  hash appended
  seg0 load=0x42030020  63716 bytes
  seg1 load=0x40800000   1804 bytes
  seg2 load=0x42000020 138016 bytes
  seg3 load=0x4080070c  50544 bytes
  seg4 load=0x4080cc80   8240 bytes
```

Chip id `0x0D` was already in the parser's table. The format is otherwise
identical to the C3's, so the parser needed a region table rather than new
parsing.

## First execution spike

Real C6 firmware was run through the **existing** RV32IMC core, with no C6
peripherals and no ROM table, purely to find out what the chip needs:

```
image: chip=esp32c6 entry=0x40800828 segments=5 bytes=262320
steps=21 pc=0x40000018
stopped at a mask-ROM call: 0x40000018
MMIO touched: 0x600c2074 x1
```

Two things follow, both of them useful:

- **No new CPU work is indicated so far.** The core executed the C6 instruction
  stream without an illegal instruction, an unsupported CSR or a trap. The
  existing RV32IMC implementation is a genuine starting point rather than an
  assumption.
- **The C6 calls into its mask ROM almost immediately** — 21 instructions in,
  against the C3's several thousand. The ROM dispatch table is therefore the
  first real piece of C6-specific work, and its addresses must be taken from the
  C6's own linker scripts rather than the C3's.

## What has not been done

The runtime does not exist yet. There is no C6 machine, no C6 peripherals, no
board definition, and no simulation claim of any kind. Nothing in this document
should be read as support for the part.
