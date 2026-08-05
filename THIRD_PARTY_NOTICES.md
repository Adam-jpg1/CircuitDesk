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

Present as a development dependency for the RP2040 feasibility work. The
package contains **no** Raspberry Pi boot ROM: it allocates a zero-filled 4 KB
ROM region and exposes `loadBootrom()` for the embedder to supply one.

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
(the lookup table layout and function signatures). It provides only a function
lookup table and naive byte-loop `memcpy`/`memset` routines. It contains no
Raspberry Pi code and is deliberately not derived from the optimised ROM
implementations. The floating-point routines (which are the mufplib code) are
not implemented and are not advertised in the function table.

## Arduino cores

Firmware is compiled by `arduino-cli` using vendor board support packages
(`arduino:avr`, `rp2040:rp2040`) installed on the compiler backend at build
time. Those packages are not redistributed as part of CircuitDesk's source or
its browser bundle.
