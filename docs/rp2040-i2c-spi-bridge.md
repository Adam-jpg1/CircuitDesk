# Bridging RP2040 I2C and SPI to CircuitDesk's device models

Status: **investigated, not implemented.** This note records exactly what is
missing, so the work can start from measured facts.

CircuitDesk already has working device models for the SSD1306, BMP280,
MPU-6050, LCD1602, 24C256 EEPROM, DS3231, MCP4725, SPI flash, SD card, 74HC595
and 74HC165. They attach to two reusable buses — `src/simulation/devices/i2cBus.ts`
and `src/simulation/devices/spiBus.ts` — which are deliberately engine-neutral.
Today only the AVR runner connects to them, so a Pico simulation attaches no
devices at all rather than pretending they replied (`CircuitBinding.setupI2cDevices`
and `setupSpiDevices` return early when the runner exposes no bus).

## What was verified

Both rp2040js peripherals are live and expose the callbacks a bridge needs.
A sketch calling `Wire.begin()` and one calling `SPI.begin()` were compiled by
the real backend and executed: neither hits the floating-point limitation that
blocks `analogWrite()`, `i2c[0].enable` reads back set, and both
`i2c[0].onConnect` and `spi[0].onTransmit` are installed function slots.

## The missing pieces

### 1. Callback adapters

The two sides already have matching shapes; only the names differ.

| rp2040js `RPI2C` | CircuitDesk `I2cBus.handler()` |
| --- | --- |
| `onStart(repeatedStart)` | `start(repeated)` |
| `onConnect(address, mode)` | `connectToSlave(address, write)` |
| `onWriteByte(value)` | `writeByte(value)` |
| `onReadByte(ack)` | `readByte(ack)` |
| `onStop()` | `stop()` |

The completion calls match one for one: `completeStart`, `completeConnect(ack)`,
`completeWrite(ack)`, `completeRead(value)`, `completeStop`. `I2CMode` has to be
translated into the bus's `write: boolean`.

`RPSPI` is simpler still: `onTransmit(value)` maps onto
`SpiBus.transferByte(mosi, controller, levelOf)` and the result goes back through
`completeTransmit(rxValue)`.

### 2. An SPI controller description

`SpiBus` needs a `SpiController` — the datasheet mode `(CPOL << 1) | CPHA` and
the bit order. On the RP2040 these come from the PL022's `SSPCR0` register
(`SPO` is CPOL, `SPH` is CPHA); the PL022 in Motorola SPI format is MSB-first
only, so `bitOrder` is fixed. Note the AVR runner reads its control bits
directly rather than trusting `avr8js`'s `spiMode` getter, which swaps
datasheet modes 1 and 2 — the RP2040 side must not copy that workaround.

### 3. Board-side bus pin maps

This is the real gap. `CircuitBinding` decides which canvas nets are the bus by
looking up the board's bus pins, and both lookups are AVR-shaped:

* I2C pins come from `board.metadata.i2cPins`, which the Pico definition does
  not set. The Arduino-Pico default `Wire` is SDA on GP4 and SCL on GP5.
* SPI pins come from `spiPinsFor(avrProfile)`, which has no RP2040 equivalent.
  The Arduino-Pico default `SPI` is SCK GP18, MOSI (TX) GP19, MISO (RX) GP16,
  with CS commonly on GP17.

Both are per-board data, not per-architecture: the RP2040 can remap either bus
to several pin groups, and a sketch may call `Wire.setSDA()` / `SPI.setSCK()`
before `begin()`. A faithful bridge should read the pin assignment from the
GPIO function-select registers the firmware actually programs, rather than
assuming the defaults — the same principle applied to the clock tree.

### 4. Verification before any claim

Nothing may be added to the Pico's `supportedApis` or `supportedPeripherals`
until each device model is exercised from real compiled Pico firmware. The
cheapest honest path uses only the `Wire` and `SPI` libraries bundled with the
Arduino-Pico core — raw transactions against the 24C256 EEPROM and the 74HC595
— because third-party device libraries (Adafruit BMP280, SSD1306) are not
installed on the compiler service and would add their own failure modes to the
first end-to-end test.

## Not a blocker

Floating point is not in the way here. The SDK's I2C and SPI initialisation
computes its divisors in integer arithmetic, which is why these sketches run
while `analogWrite()` does not.
