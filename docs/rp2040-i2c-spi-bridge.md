# RP2040 I2C and SPI

Status: **implemented and verified.** This note records how the bridge works
and which parts of the RP2040's bus flexibility are not covered yet.

CircuitDesk's device models for the SSD1306, BMP280, MPU-6050, LCD1602, 24C256
EEPROM, DS3231, MCP4725, SPI flash, SD card, 74HC595 and 74HC165 are shared
across architectures. Pico firmware drives the same objects an Uno drives,
through the same `I2cBus`, `SpiBus` and `CircuitBinding`. No device model was
changed and no Pico-specific copy exists.

## How the bridge works

`Rp2040Runner` connects both I2C controllers and both SPI controllers to the
buses. rp2040js reports what the firmware's `Wire` and `SPI` calls actually do
on the wire; the bus decides who, if anyone, answers.

| rp2040js `RPI2C` | `I2cBus.handler()` |
| --- | --- |
| `onStart(repeatedStart)` | `start(repeated)` |
| `onConnect(address, mode)` | `connectToSlave(address, mode === Write)` |
| `onWriteByte(value)` | `writeByte(value)` |
| `onReadByte(ack)` | `readByte(ack)` |
| `onStop()` | `stop()` |

`RPSPI.onTransmit(value)` maps onto `SpiBus.transferByte(mosi, controller,
levelOf)`, and the result returns through `completeTransmit(rxValue)`.

Both controller instances are wired, because `Wire`/`Wire1` and `SPI`/`SPI1`
are different silicon and which one a sketch uses is its own choice.

### SPI mode

The datasheet mode is read straight out of SSPCR0: `SPO` is CPOL (bit 6) and
`SPH` is CPHA (bit 7), giving `(CPOL << 1) | CPHA`.

rp2040js's own `spiMode` getter is **not** used: it returns 3 for
CPOL=1/CPHA=0 and 2 for CPOL=1/CPHA=1, i.e. modes 2 and 3 swapped relative to
the datasheet. This is the same class of defect the AVR runner already works
around in avr8js, which swaps modes 1 and 2.

Bit order is fixed to MSB-first, the only order the PL022 offers in Motorola
SPI format. Unlike an AVR there is no `DORD` to read.

## Pin mapping

The RP2040 does not bond its buses to fixed pins. Each controller appears at
several places in the GPIO function table (datasheet section 2.19.2), and the
Arduino-Pico core lets a sketch choose with `Wire.setSDA()` or `SPI.setSCK()`
before `begin()`. So `busPins.ts` reads the assignment back from the pads:
whichever pins the firmware muxed to the I2C or SPI function *are* the bus.

The function table is regular, so it is expressed as arithmetic rather than
thirty copied rows:

* **I2C** — even pins are SDA, odd pins are SCL, and the controller alternates
  every two pins: GP0/GP1 are I2C0, GP2/GP3 are I2C1, GP4/GP5 are I2C0 again.
* **SPI** — the four lines repeat every four pins as RX, CSn, SCK, TX, and the
  controller alternates every eight: GP0-GP7 are SPI0, GP8-GP15 are SPI1,
  GP16-GP23 are SPI0, GP24-GP29 are SPI1.

### The pre-mux default

A device wired on the canvas exists from the moment the project loads, but the
chip does not mux a bus until the sketch calls `begin()` inside `setup()`.
Without a starting point, a device could not answer a transaction issued in
that same `setup()`. The installed Arduino-Pico core's defaults fill that gap —
`Wire` on GP4/GP5, `SPI` on SCK GP18, MOSI GP19, MISO GP16 — and any live mux
immediately wins.

Because the mux appears mid-run, `CircuitBinding` re-binds its device
attachment when the assignment changes. `sync()` keeps devices by instance id,
so re-binding does not wipe an SSD1306's display RAM or an EEPROM's contents.

## Not covered yet

* **`Wire1` and `SPI1` are wired but untested.** Both controller instances are
  connected to the buses and the pin reader understands their pin groups, but
  no test drives a sketch that uses them, so they are not claimed.
* **Only one bus of each kind is presented to the canvas at a time.**
  `activeI2cPins()` and `activeSpiPins()` return a single assignment — the
  first controller with its lines muxed. A sketch running `Wire` and `Wire1`
  simultaneously would have only one of them reach the canvas.
* **Hardware chip-select (`SSPFSSOUT`) is recognised but unused.** Every tested
  sketch drives CS as a plain GPIO, which is what Arduino libraries do, and
  that is the path the bus follows.
* **Clock rate is not enforced.** `SPISettings` and `Wire.setClock()` change the
  real divisors and the reported frequency follows them, but transfers complete
  in the emulator's own time rather than taking the programmed number of
  bit periods. A device whose timing depends on the clock rate would not notice
  the difference.
* **10-bit I2C addressing** is not exercised; every model uses 7-bit addresses.
* **SPI data sizes other than 8 bits.** The PL022 supports 4 to 16 bits per
  frame; the shared bus is byte-oriented, so a sketch configuring another size
  is not modelled.
