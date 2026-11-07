# Starters and showcases

Two shelves on the dashboard, answering two different questions.

**Starters** answer *how do I begin*. The smallest honest example of one idea:
one board, few parts, a sketch you can read in one screen.

**Showcases** answer *what is this capable of*. Worked projects that drive real
device models on real buses, across the boards that genuinely execute firmware.

They are listed separately because a single undifferentiated row answers
neither question, and each card names the board it opens on — a showcase on a
Pico is not something you can open on an Uno, and finding that out after
clicking is too late.

## The rules every template is held to

1. **It validates clean.** Anything the validator says about a circuit we ship
   is our bug, not the user's. The seven-segment starter shipped for months
   driving eight LED segments straight off eight GPIOs with no series
   resistor — our own `led-needs-resistor` rule, failing eight times, on a
   circuit handed to beginners.
2. **It compiles, for real,** through the same toolchain the app uses.
3. **It has a test bench,** asserting the thing the template is *for* — not
   that it compiled. The bench runs on a fresh headless emulator against the
   compiled firmware.
4. **Every part in it reacts.** A part on the canvas that cannot respond to
   firmware teaches nothing, so the audit refuses one unless the template is
   explicitly about wiring.
5. **It stays inside what the board really does.** The ESP32-C6 showcase uses
   only GPIO, because Wi-Fi, ADC, PWM, I2C, SPI and the hardware UART are not
   simulated on it and a sketch using them would compile, run, and quietly do
   nothing.
6. **No library it does not have.** Only `Servo` and `ESP32Servo` are pinned,
   so the showcases drive devices with raw `Wire` and `SPI`. This turned out to
   be the better teaching choice anyway: the SD card showcase is the handshake
   every SD library performs, written out.

## The instrument

`tools/audit/templateAudit.mts` builds every template the way the dashboard
does and asks the questions the app would: do the pins exist, does it survive
save and reopen, what does the validator say, is every part one that reacts,
does it compile, and does its bench pass.

```bash
npx tsx tools/audit/templateAudit.mts            # full, needs the compiler service
npx tsx tools/audit/templateAudit.mts --no-build # static checks only
```

It earned its keep immediately: a ground pin that does not exist on a Pico, a
3.3 V sensor fed 5 V (twice, different modules), and a find-and-replace that
silently matched nothing and left a latch wire on one pin while the sketch
drove another.

It also caught its own first design. The original version sampled pin levels
every 10 ms and asked whether anything moved, and reported the ultrasonic
starter as dead — a TRIG pulse is 10 µs and falls between two samples. Running
each template's own bench asks the question in the vocabulary the app already
has, and the emulator answers it exactly.

## The test bench runs on every architecture

It used to construct an `AVRRunner` directly and refuse any board without an
AVR profile, so a Pico or ESP32-C6 project could be compiled and run live but
could not be *asserted*. It goes through the same `BoardRunner` interface the
live simulation uses now, so a bench proves the same thing on every engine.

One thing that bit during that change, worth knowing: `CompileResult.firmware`
did not declare `regions`, even though the service has always sent them. The
live path happened to work because it passes the whole object through; the
bench rebuilt the artifact field by field from a type that did not mention
them, and an ESP32 that cannot read its partition table out of flash fetches a
zero instruction. The type says what the payload is now.

## Adding one

Add it to `PROJECT_TEMPLATES` in `src/project/templates.ts` with `kind`,
`board`, a description that says what a reader gets, and a `bench()` asserting
the point of it. Then run the audit. If it reports anything, the template is
not ready — that is the whole arrangement.
