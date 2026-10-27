# Third-party notices

CircuitDesk is not affiliated with, sponsored by, or endorsed by Raspberry Pi
Ltd, Arduino, or any other hardware vendor named in this file. Hardware names
and part numbers are used only to identify the devices being simulated.

## avr8js

MIT License. Copyright (c) Uri Shaked.
<https://github.com/wokwi/avr8js>

Used to execute compiled AVR firmware for the Arduino Uno, Nano, Mega 2560 and
Leonardo.

## rp2040js

MIT License. Copyright (c) 2021 Uri Shaked.
<https://github.com/wokwi/rp2040js>

A runtime dependency: it executes Raspberry Pi Pico firmware in the browser. It
is loaded lazily, in its own chunk, only when a Pico or Pico W simulation is
started, so it is absent from the initial application bundle.

The package contains **no** Raspberry Pi boot ROM: it allocates a zero-filled
4 KB ROM region and exposes `loadBootrom()` for the embedder to supply one.

## Raspberry Pi boot ROM — NOT distributed

CircuitDesk ships **no** Raspberry Pi boot ROM material, in source or binary
form.

The RP2040 boot ROM repository as a whole carries BSD-style terms, but
`bootrom/mufplib.S` and `bootrom/mufplib-double.S` are third-party code
(© 2020 Mark Owen, <https://www.quinapalus.com>) offered either under a licence
limited to use "solely on a Raspberry Pi RP2040 device" or under GPLv2. Neither
is compatible with distributing them inside CircuitDesk, so they are not
included, not translated, and not used as a reference.

`src/simulation/rp2040/bootStub.ts` is an independent implementation written
from the RP2040 datasheet's public description of the boot ROM *interface*
(the lookup table layout and function signatures). It provides a function
lookup table and twelve entries behind it, and the two float data tables
described below:

- `memcpy` / `memcpy44` / `memset` / `memset4` — naive byte loops.
- `clz32` / `ctz32` / `popcount32` / `reverse32` — integer bit helpers written
  as carry-flag shift loops, because Cortex-M0+ has no `CLZ` instruction.
- `connect_internal_flash` / `flash_exit_xip` / `flash_flush_cache` /
  `flash_enter_cmd_xip` — immediate returns, which is the correct emulated
  behaviour where flash is plain memory with no QSPI pads and no XIP cache.

It contains no Raspberry Pi code and is deliberately not derived from the
optimised ROM implementations.

The floating-point and double-precision tables (`SF` and `SD`) are where the
mufplib routines live on silicon. None of mufplib is used here in any form.
Instead, the stub publishes the two tables itself, and every slot points at a
two-instruction trap (`bkpt #code; bx lr`). The runner answers each trap with
`src/simulation/rp2040/romFloat.ts`, an independent JavaScript implementation
of that slot's documented contract — which slot does what, with which
arguments and results — written from the datasheet's description of the
tables and the slot offsets in the Pico SDK's BSD-3-Clause header
`pico/bootrom/sf_table.h`. The arithmetic is the host's IEEE arithmetic; no
algorithm, constant or code from mufplib was consulted, copied or translated.

So floating point, and `analogWrite()` (which computes its PWM divisor in
floating point), run on the Pico in simulation. Each result is checked against
the value the chip produces in `tests/rp2040.integration.mts`.

## RISC-V execution core — original work

`src/simulation/riscv/rv32Core.ts` and `src/simulation/esp32c3/espImage.ts` are
original CircuitDesk code. They add **no dependency**.

The interpreter is written from the public RISC-V specifications, which
describe an open standard instruction set rather than anyone's implementation.
It is not derived from another emulator: the mature browser-capable RISC-V
emulators are QEMU builds (GPLv2) or projects licensed AGPLv3, and neither is
compatible with how CircuitDesk is distributed, so none of them was used or
consulted as a source.

The image parser follows the documented ESP-IDF application-image layout
(`esp_image_header_t` and `esp_image_segment_header_t`), which is public.

## Espressif ROM — NOT distributed

CircuitDesk ships **no** Espressif ROM material, in source or binary form.

ESP-IDF publishes the mask ROM's *symbol addresses* in its linker scripts, but
not the ROM's source, and no redistributable ROM binary is offered. Any ROM
behaviour CircuitDesk needs is therefore implemented independently from
documented behaviour, covering only the functions real firmware actually calls,
and anything unimplemented fails loudly rather than returning a fabricated
value. See `docs/esp32-c3-runtime.md` for the exact list.

## Arduino cores

Firmware is compiled by `arduino-cli` using vendor board support packages
(`arduino:avr`, `rp2040:rp2040`, `esp32:esp32`) installed on the compiler
backend at build time. Those packages are not redistributed as part of
CircuitDesk's source or its browser bundle, and none of them reaches the
browser: they are build-time toolchains that run server-side only.
