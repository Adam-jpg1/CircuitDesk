// ESP32-C3 GPIO, driven the way firmware drives it.
//
// Nothing here calls digitalWrite or pinMode. Those compile into register
// writes, and it is the registers this checks — the same ones the real
// firmware was observed to write. Three blocks have to agree before a pad
// does anything, and the cases below exist mostly to prove that all three are
// consulted: a model that watched only the output register would report a pad
// as driven while the pad was still assigned to another function.

import {
  Esp32C3Gpio,
  ESP32C3_GPIO_COUNT,
  GPIO_BASE,
  IO_MUX_BASE,
  PIN_FUNC_GPIO,
  SIG_GPIO_OUT_IDX,
} from '../src/simulation/esp32c3/gpio';
import type { PinChange } from '../src/simulation/gpioEvents';

let failures = 0;
function check(cond: boolean, msg: string) {
  console.log(cond ? 'PASS:' : 'FAIL:', msg);
  if (!cond) failures++;
}

const GPIO_OUT = 0x04;
const GPIO_OUT_W1TS = 0x08;
const GPIO_OUT_W1TC = 0x0c;
const GPIO_ENABLE = 0x20;
const GPIO_ENABLE_W1TS = 0x24;
const GPIO_ENABLE_W1TC = 0x28;
const GPIO_IN = 0x3c;
const GPIO_PIN_BASE = 0x74;
const OUT_SEL_BASE = 0x554;
const IO_MUX_PIN_BASE = 0x04;

const FUN_PD = 1 << 7;
const FUN_PU = 1 << 8;
const FUN_IE = 1 << 9;
const PAD_DRIVER = 1 << 2;

class TestClock {
  nanos = 0;
}

/** Sets a pad up exactly as the firmware was observed to for a plain output. */
function configureOutput(gpio: Esp32C3Gpio, pin: number, options: { input?: boolean } = {}): void {
  gpio.ioMux.writeUint32(IO_MUX_PIN_BASE + pin * 4, (PIN_FUNC_GPIO << 12) | (options.input ? FUN_IE : 0));
  gpio.writeUint32(OUT_SEL_BASE + pin * 4, SIG_GPIO_OUT_IDX);
  gpio.writeUint32(GPIO_ENABLE_W1TS, 1 << pin);
}

/** Sets a pad up as an input with the internal pull-up, as INPUT_PULLUP does. */
function configureInputPullUp(gpio: Esp32C3Gpio, pin: number): void {
  gpio.ioMux.writeUint32(IO_MUX_PIN_BASE + pin * 4, (PIN_FUNC_GPIO << 12) | FUN_IE | FUN_PU);
  gpio.writeUint32(GPIO_ENABLE_W1TC, 1 << pin);
}

// ---------- 1. reset state ----------
{
  const gpio = new Esp32C3Gpio(new TestClock());
  check(gpio.base === GPIO_BASE, 'the GPIO block sits at its documented base address');
  check(gpio.ioMux.base === IO_MUX_BASE, 'and the IO MUX at its own');
  check(gpio.pinNumbers().length === ESP32C3_GPIO_COUNT, `the part exposes ${ESP32C3_GPIO_COUNT} GPIOs`);

  const state = gpio.pinState(8);
  check(state.direction === 'disabled', 'a pad out of reset drives nothing and reads nothing');
  check(state.level === undefined, 'and has no defined level');
  check(state.pull === 'none', 'with no pull enabled');
  check(gpio.readUint32(GPIO_IN) === 0, 'the input register reads zero when no input buffer is on');
}

// ---------- 2. an output pad ----------
{
  const clock = new TestClock();
  const gpio = new Esp32C3Gpio(clock);
  configureOutput(gpio, 8);

  check(gpio.pinState(8).direction === 'output', 'enabling the output makes the pad an output');
  check(gpio.pinState(8).level === 0, 'and it starts low');

  gpio.writeUint32(GPIO_OUT_W1TS, 1 << 8);
  check(gpio.pinState(8).level === 1, 'the set register drives it high');
  gpio.writeUint32(GPIO_OUT_W1TC, 1 << 8);
  check(gpio.pinState(8).level === 0, 'and the clear register drives it low again');

  // The set and clear registers act on the output register rather than holding
  // a value, so the output register has to show the result.
  gpio.writeUint32(GPIO_OUT_W1TS, 1 << 8);
  check((gpio.readUint32(GPIO_OUT) & (1 << 8)) !== 0, 'a set is visible in the output register');
  check(gpio.readUint32(GPIO_OUT_W1TS) === 0, 'and the set register itself holds nothing');

  // Only the pin written to may move.
  configureOutput(gpio, 3);
  check(gpio.pinState(3).level === 0, 'a second output starts low');
  gpio.writeUint32(GPIO_OUT_W1TS, 1 << 3);
  check(gpio.pinState(3).level === 1 && gpio.pinState(8).level === 1, 'setting one pin leaves the other alone');
  gpio.writeUint32(GPIO_OUT_W1TC, 1 << 3);
  check(gpio.pinState(3).level === 0 && gpio.pinState(8).level === 1, 'and clearing one does too');
}

// ---------- 3. all three blocks have to agree ----------
//
// This is the case a naive model gets wrong: it watches the output register
// and reports a pad as driven when the pad is not even assigned to GPIO.
{
  const gpio = new Esp32C3Gpio(new TestClock());

  // Output enabled and a value written, but the matrix routes nothing.
  gpio.ioMux.writeUint32(IO_MUX_PIN_BASE + 8 * 4, PIN_FUNC_GPIO << 12);
  gpio.writeUint32(GPIO_ENABLE_W1TS, 1 << 8);
  gpio.writeUint32(GPIO_OUT_W1TS, 1 << 8);
  check(gpio.pinState(8).direction !== 'output', 'a pad the matrix has not routed is not an output');
  check(gpio.pinState(8).level === undefined, 'and is not driven');

  // Route it, and it comes to life.
  gpio.writeUint32(OUT_SEL_BASE + 8 * 4, SIG_GPIO_OUT_IDX);
  check(gpio.pinState(8).level === 1, 'routing the GPIO signal to the pad makes it drive');

  // Hand the pad to a different IO MUX function and it stops again.
  gpio.ioMux.writeUint32(IO_MUX_PIN_BASE + 8 * 4, 2 << 12);
  check(gpio.pinState(8).direction !== 'output', 'a pad on another IO MUX function is not a GPIO');

  gpio.ioMux.writeUint32(IO_MUX_PIN_BASE + 8 * 4, PIN_FUNC_GPIO << 12);
  gpio.writeUint32(GPIO_ENABLE_W1TC, 1 << 8);
  check(gpio.pinState(8).direction !== 'output', 'and clearing the output enable stops it driving');
}

// ---------- 4. inputs, pulls and floating ----------
{
  const gpio = new Esp32C3Gpio(new TestClock());
  configureInputPullUp(gpio, 9);

  check(gpio.pinState(9).direction === 'input', 'enabling the input buffer makes the pad an input');
  check(gpio.pinState(9).pull === 'up', 'with its pull-up reported');
  check(gpio.pinState(9).level === 1, 'and the pull-up holds it high with nothing connected');
  check((gpio.readUint32(GPIO_IN) & (1 << 9)) !== 0, 'which the input register shows');

  // A button to ground wins over the pull-up, as it does on hardware.
  gpio.drivePin(9, 0);
  check(gpio.pinState(9).level === 0, 'a wire to ground pulls it low against the pull-up');
  check((gpio.readUint32(GPIO_IN) & (1 << 9)) === 0, 'and the input register follows');

  gpio.drivePin(9, undefined);
  check(gpio.pinState(9).level === 1, 'releasing it returns to the pull-up');

  // A pull-down is the mirror image.
  gpio.ioMux.writeUint32(IO_MUX_PIN_BASE + 9 * 4, (PIN_FUNC_GPIO << 12) | FUN_IE | FUN_PD);
  check(gpio.pinState(9).pull === 'down', 'a pull-down is reported as one');
  check(gpio.pinState(9).level === 0, 'and holds the pad low');
  gpio.drivePin(9, 1);
  check(gpio.pinState(9).level === 1, 'an external high beats the pull-down');
  gpio.drivePin(9, undefined);

  // No pull and nothing connected is genuinely indeterminate.
  gpio.ioMux.writeUint32(IO_MUX_PIN_BASE + 9 * 4, (PIN_FUNC_GPIO << 12) | FUN_IE);
  check(gpio.pinState(9).pull === 'none', 'with neither pull enabled');
  check(gpio.pinState(9).level === undefined, 'a floating input has no level rather than a made-up one');
  check((gpio.readUint32(GPIO_IN) & (1 << 9)) === 0, 'and reads back as zero, which is what the register can say');

  // An input buffer that is off reads zero whatever is on the pad.
  gpio.ioMux.writeUint32(IO_MUX_PIN_BASE + 9 * 4, PIN_FUNC_GPIO << 12);
  gpio.drivePin(9, 1);
  check((gpio.readUint32(GPIO_IN) & (1 << 9)) === 0, 'a disabled input buffer reads zero even when driven high');
}

// ---------- 5. open drain ----------
{
  const gpio = new Esp32C3Gpio(new TestClock());
  configureOutput(gpio, 5, { input: true });
  gpio.writeUint32(GPIO_PIN_BASE + 5 * 4, PAD_DRIVER);

  gpio.writeUint32(GPIO_OUT_W1TC, 1 << 5);
  check(gpio.pinState(5).level === 0, 'an open-drain output still drives low');
  check(gpio.pinState(5).openDrain, 'and reports itself as open drain');

  gpio.writeUint32(GPIO_OUT_W1TS, 1 << 5);
  check(gpio.pinState(5).level === undefined, 'but driving high just lets go, leaving the pad floating');

  // Which is the point: something else decides the high level.
  gpio.drivePin(5, 1);
  check(gpio.pinState(5).level === 1, 'so an external pull-up can take it high');
  gpio.writeUint32(GPIO_OUT_W1TC, 1 << 5);
  check(gpio.pinState(5).level === 0, 'and the chip can still pull it back down');
}

// ---------- 6. change events ----------
{
  const clock = new TestClock();
  const gpio = new Esp32C3Gpio(clock);
  const changes: PinChange[] = [];
  const stop = gpio.onPinChange((c) => changes.push(c));

  configureOutput(gpio, 8);
  clock.nanos = 1_000_000;
  gpio.writeUint32(GPIO_OUT_W1TS, 1 << 8);

  const rising = changes[changes.length - 1];
  check(rising.current.pin === 8, 'a change names the pin it happened on');
  check(rising.previous.level === 0 && rising.current.level === 1, 'and carries both sides of the edge');
  check(rising.current.timestamp === 1_000_000, 'stamped with the simulated time it happened at');

  // Writing the same value again is not a change.
  const before = changes.length;
  gpio.writeUint32(GPIO_OUT_W1TS, 1 << 8);
  check(changes.length === before, 'rewriting the same value reports nothing');

  // An external drive on an input is a change too, so the canvas can be a
  // source rather than only a destination.
  configureInputPullUp(gpio, 9);
  const beforeButton = changes.length;
  gpio.drivePin(9, 0);
  check(changes.length > beforeButton, 'driving a pin from outside reports a change');
  check(changes[changes.length - 1].current.pin === 9, 'on the pin that was driven');

  stop();
  gpio.writeUint32(GPIO_OUT_W1TC, 1 << 8);
  check(changes[changes.length - 1].current.pin === 9, 'and unsubscribing really stops the reports');
}

// ---------- 7. reset ----------
{
  const gpio = new Esp32C3Gpio(new TestClock());
  configureOutput(gpio, 8);
  gpio.writeUint32(GPIO_OUT_W1TS, 1 << 8);
  gpio.drivePin(9, 0);
  check(gpio.pinState(8).level === 1, 'a pin is driven before the reset');

  gpio.reset();
  check(gpio.pinState(8).direction === 'disabled', 'reset returns the pad to driving nothing');
  check(gpio.pinState(8).level === undefined, 'with no level');
  check(gpio.readUint32(GPIO_OUT) === 0, 'the output register is cleared');
  check(gpio.readUint32(GPIO_ENABLE) === 0, 'and so is the output enable');
  check(gpio.pinState(9).level === undefined, 'and external drives are released, as unplugging the board would');
}

console.log(failures === 0 ? '\nESP32-C3 GPIO checks passed.' : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
