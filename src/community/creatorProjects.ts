// The creator's projects: large, many-part builds that show how far the
// simulator goes.
//
// Each one is held to the same bar as every built-in project — it validates
// with nothing to report, every part is simulated, and it compiles and passes
// its own test bench on the emulator (tests/community.builtin.mts) — so the
// size is real rather than decorative.

import { bench, code, emptyProject, inst, wire } from '../project/templates';
import type { ComponentInstance, Connection } from '../types';
import type { BuiltinProject } from './builtinProjects';
import { contactStateKey } from '../simulation/devices/contacts';

const RED = '#e03131';
const BLACK = '#212529';
const BLUE = '#1971c2';
const ORANGE = '#e8590c';
const GREEN = '#2f9e44';
const PURPLE = '#7048e8';
const YELLOW = '#f59f00';
const TEAL = '#0c8599';

/** A little wiring kit, so a forty-wire circuit reads as what it connects. */
class Wiring {
  readonly connections: Connection[] = [];
  constructor(private readonly power: ComponentInstance, private readonly vccPin: string, private readonly gndPin: string) {}
  link(a: ComponentInstance, ap: string, b: ComponentInstance, bp: string, colour = BLUE): void {
    this.connections.push(wire(a, ap, b, bp, colour));
  }
  supply(part: ComponentInstance, vcc = 'vcc', gnd = 'gnd'): void {
    this.link(part, vcc, this.power, this.vccPin, RED);
    this.link(part, gnd, this.power, this.gndPin, BLACK);
  }
  high(part: ComponentInstance, ...pins: string[]): void {
    for (const p of pins) this.link(part, p, this.power, this.vccPin, RED);
  }
  low(part: ComponentInstance, ...pins: string[]): void {
    for (const p of pins) this.link(part, p, this.power, this.gndPin, BLACK);
  }
  /** Signal -> resistor -> LED -> ground. */
  lamp(from: ComponentInstance, pin: string, r: ComponentInstance, led: ComponentInstance, colour = ORANGE): void {
    this.link(from, pin, r, 'p1', colour);
    this.link(r, 'p2', led, 'anode', colour);
    this.link(led, 'cathode', this.power, this.gndPin, BLACK);
  }
}

// =============================================================== computer

const COMPUTER_SKETCH = `// A 4-bit computer, built from logic chips.
//
// The Uno is only the program memory - the ROM. It reads the address the
// 74HC161 program counter is showing, puts that instruction on the bus, and
// pulses the clock. Everything else happens in the chips:
//
//   74HC157  picks the accumulator's next value: the operand (LOAD) or the sum (ADD)
//   74HC283  adds the accumulator and the operand
//   74HC574  is the accumulator; its fifth bit is the carry flag
//   74HC04 + 74HC08  let the adder's carry into the flag only on ADD
//   CD4511   shows the accumulator on the display (0-9; 10-15 blank, as on the real chip)
//
// The Uno never works out the answer. It reads it back off the
// accumulator's own pins and prints what the hardware computed.

const int PC_PINS[4]  = {2, 3, 4, 5};      // 74HC161 QA..QD: the address
const int BUS_PINS[4] = {6, 7, 8, 9};      // operand bits 0..3
const int CLK = 10, RESET_N = 11, LOAD = 12;
const int ACC_PINS[4] = {A0, A1, A2, A3};  // the accumulator, read back
const int CARRY = A4;                      // the carry flag, read back

enum Op { OP_LOAD, OP_ADD, OP_HALT };
struct Instruction { Op op; byte value; };

// The program: 3 x 3 by repeated addition, then one more add to overflow.
const Instruction ROM[16] = {
  { OP_LOAD, 0 },
  { OP_ADD,  3 },
  { OP_ADD,  3 },
  { OP_ADD,  3 },   // 9
  { OP_ADD,  9 },   // 18: four bits hold 2, and the carry flag sets
  { OP_HALT, 0 },
};

bool halted = false;

byte readNibble(const int *pins) {
  byte value = 0;
  for (int i = 0; i < 4; i++) if (digitalRead(pins[i]) == HIGH) value |= 1 << i;
  return value;
}

void setup() {
  Serial.begin(9600);
  for (int i = 0; i < 4; i++) {
    pinMode(PC_PINS[i], INPUT);
    pinMode(BUS_PINS[i], OUTPUT);
    pinMode(ACC_PINS[i], INPUT);
  }
  pinMode(CARRY, INPUT);
  pinMode(CLK, OUTPUT);
  pinMode(RESET_N, OUTPUT);
  pinMode(LOAD, OUTPUT);
  digitalWrite(CLK, LOW);
  digitalWrite(RESET_N, LOW);   // program counter to 0
  delay(30);
  digitalWrite(RESET_N, HIGH);
  delay(30);
  Serial.println("4-bit computer ready");
}

void loop() {
  if (halted) return;
  byte pc = readNibble(PC_PINS);
  Instruction in = ROM[pc];
  if (in.op == OP_HALT) {
    halted = true;
    Serial.print("HALT at PC=");
    Serial.print(pc);
    Serial.print("  ACC=");
    Serial.println(readNibble(ACC_PINS));
    return;
  }

  // Fetch: put the instruction on the bus and let it settle through the chips.
  digitalWrite(LOAD, in.op == OP_LOAD ? HIGH : LOW);
  for (int i = 0; i < 4; i++) digitalWrite(BUS_PINS[i], (in.value >> i) & 1);
  delay(30);

  // Execute: one clock edge latches the accumulator and advances the counter.
  digitalWrite(CLK, HIGH);
  delay(30);
  digitalWrite(CLK, LOW);
  delay(30);

  Serial.print("PC=");
  Serial.print(pc);
  Serial.print(in.op == OP_LOAD ? "  LOAD " : "  ADD  ");
  Serial.print(in.value);
  Serial.print("  ->  ACC=");
  Serial.print(readNibble(ACC_PINS));
  Serial.print("  carry=");
  Serial.println(digitalRead(CARRY));
  delay(120);   // slow enough to watch the lights
}
`;

const logicComputer: BuiltinProject = {
  id: 'cp_logic_computer',
  title: '4-bit computer built from logic chips',
  description:
    'A real accumulator machine on the bench: a 74HC161 program counter, a 74HC157 to choose LOAD or ADD, a ' +
    '74HC283 adder, a 74HC574 accumulator with a carry flag, and a CD4511 driving the display. The Uno is only ' +
    'the program memory — it puts each instruction on the bus and pulses the clock, then reads back what the ' +
    'chips computed. Watch the program counter count, the accumulator reach 9, and the carry flag light when it ' +
    'overflows. Change the ROM table to write your own program.',
  author: 'creator',
  tags: ['logic', 'computer', '74hc', 'cpu'],
  baseLikes: 64,
  createdAt: '2026-10-21T19:30:00.000Z',
  build: () => {
    const p = emptyProject('4-bit computer built from logic chips');
    const uno = inst('board.arduino-uno', 40, 420);
    const pc = inst('comp.74hc161', 40, 60);
    const mux = inst('comp.74hc157', 170, 60);
    const adder = inst('comp.74hc283', 300, 60);
    const acc = inst('comp.74hc574', 430, 50);
    const inv = inst('comp.74hc04', 560, 60);
    const and = inst('comp.74hc08', 660, 60);
    const decoder = inst('comp.cd4511', 760, 60);
    const display = inst('comp.seven-segment', 880, 70);
    const w = new Wiring(uno, '5V', 'GND_PWR1');

    // Every chip on the 5 V rail.
    for (const chip of [pc, mux, adder, acc, inv, and, decoder]) w.supply(chip);

    // Program counter: counts on the clock, cleared by the Uno, never loaded.
    w.link(uno, 'D10', pc, 'clk', YELLOW);
    w.link(uno, 'D11', pc, 'nclr', PURPLE);
    w.high(pc, 'enp', 'ent', 'nload');
    w.low(pc, 'a', 'b', 'c', 'd');
    const pcBits = ['qa', 'qb', 'qc', 'qd'];
    ['D2', 'D3', 'D4', 'D5'].forEach((pin, i) => w.link(pc, pcBits[i], uno, pin, TEAL));

    // The operand bus, to both the adder and the LOAD side of the selector.
    const busPins = ['D6', 'D7', 'D8', 'D9'];
    busPins.forEach((pin, i) => {
      w.link(uno, pin, adder, `b${i + 1}`, GREEN);
      w.link(uno, pin, mux, `${i + 1}b`, GREEN);
    });
    w.low(adder, 'c0');

    // Selector: sum on ADD (sel low), operand on LOAD (sel high), into the accumulator.
    w.link(uno, 'D12', mux, 'sel', PURPLE);
    w.low(mux, 'ne');
    [1, 2, 3, 4].forEach((n) => {
      w.link(adder, `s${n}`, mux, `${n}a`, ORANGE);
      w.link(mux, `${n}y`, acc, `d${n}`, ORANGE);
    });

    // Accumulator: clocked with the counter; outputs feed back into the adder,
    // out to the display decoder, and back to the Uno.
    w.link(uno, 'D10', acc, 'clk', YELLOW);
    w.low(acc, 'noe', 'd6', 'd7', 'd8');
    const accIn = ['a', 'b', 'c', 'd'];
    ['A0', 'A1', 'A2', 'A3'].forEach((pin, i) => {
      w.link(acc, `q${i + 1}`, adder, `a${i + 1}`, BLUE);
      w.link(acc, `q${i + 1}`, decoder, accIn[i], BLUE);
      w.link(acc, `q${i + 1}`, uno, pin, BLUE);
    });

    // Carry flag: the adder's carry, let through only on ADD (LOAD inverted, ANDed).
    w.link(uno, 'D12', inv, '1a', PURPLE);
    w.link(inv, '1y', and, '1b', PURPLE);
    w.link(adder, 'c4', and, '1a', RED);
    w.link(and, '1y', acc, 'd5', RED);
    w.link(acc, 'q5', uno, 'A4', RED);
    w.low(inv, '2a', '3a', '4a', '5a', '6a');
    w.low(and, '2a', '2b', '3a', '3b', '4a', '4b');

    // Display: BCD in, segments out, no lamp test, no blanking, transparent latch.
    w.high(decoder, 'nlt', 'nbi');
    w.low(decoder, 'le');
    for (const s of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) w.link(decoder, `s${s}`, display, s, ORANGE);
    w.low(display, 'com1');

    // Lamps: program counter (blue), accumulator (green), carry (red).
    const lamps: ComponentInstance[] = [];
    pcBits.forEach((q, i) => {
      const r = inst('comp.resistor', 40 + i * 60, 220, { resistance: 330 }, 90);
      const led = inst('comp.led', 50 + i * 60, 300, { color: 'blue' });
      w.lamp(pc, q, r, led, TEAL);
      lamps.push(r, led);
    });
    [1, 2, 3, 4].forEach((n, i) => {
      const r = inst('comp.resistor', 400 + i * 60, 230, { resistance: 330 }, 90);
      const led = inst('comp.led', 410 + i * 60, 310, { color: 'green' });
      w.lamp(acc, `q${n}`, r, led, GREEN);
      lamps.push(r, led);
    });
    const rc = inst('comp.resistor', 660, 230, { resistance: 330 }, 90);
    const carryLed = inst('comp.led', 670, 310, { color: 'red' });
    w.lamp(acc, 'q5', rc, carryLed, RED);
    lamps.push(rc, carryLed);

    p.boardInstances = [uno];
    p.componentInstances = [pc, mux, adder, acc, inv, and, decoder, display, ...lamps];
    p.connections = w.connections;
    p.codeFiles = [code('sketch.ino', COMPUTER_SKETCH)];
    p.tests = [
      bench(
        'The chips compute 3 x 3, then overflow',
        'Every value is read back off the accumulator\'s pins: the Uno only supplies the program.',
        [
          { kind: 'serial-contains', text: 'PC=0  LOAD 0  ->  ACC=0', withinMs: 1500 },
          { kind: 'serial-contains', text: 'PC=3  ADD  3  ->  ACC=9  carry=0', withinMs: 2500 },
          { kind: 'serial-contains', text: 'PC=4  ADD  9  ->  ACC=2  carry=1', withinMs: 3000 },
          { kind: 'serial-contains', text: 'HALT at PC=5  ACC=2', withinMs: 3500 },
        ],
        { timeoutMs: 3600 },
      ),
    ];
    return p;
  },
};

// ================================================================= snake

const SNAKE_SKETCH = `// Snake on an 8x8 LED matrix.
//
// A MAX7219 on hardware SPI drives the 64 LEDs, an analog joystick steers,
// and a buzzer clicks on every bite. The display driver is spoken to
// directly, register by register: no library between the sketch and the chip.

#include <SPI.h>

const int CS = 10, BUZZER = 8, STICK_X = A0, STICK_Y = A1, STICK_SW = 2;
const unsigned long STEP_MS = 220;

int8_t sx[64], sy[64];      // the snake, head first
int len, dx, dy, foodX, foodY, score;
unsigned long lastStep = 0;
unsigned int seed = 7;      // the same food every game, so a game can be replayed

void max7219(byte reg, byte value) {
  digitalWrite(CS, LOW);
  SPI.transfer(reg);
  SPI.transfer(value);
  digitalWrite(CS, HIGH);
}

bool onSnake(int x, int y) {
  for (int i = 0; i < len; i++) if (sx[i] == x && sy[i] == y) return true;
  return false;
}

void show() {
  byte rows[8] = {0, 0, 0, 0, 0, 0, 0, 0};
  for (int i = 0; i < len; i++) rows[sy[i]] |= 1 << sx[i];
  rows[foodY] |= 1 << foodX;
  for (int r = 0; r < 8; r++) max7219(r + 1, rows[r]);
}

void placeFood() {
  do {
    seed = seed * 109 + 89;
    foodX = (seed >> 4) & 7;
    foodY = (seed >> 8) & 7;
  } while (onSnake(foodX, foodY));
}

void newGame() {
  len = 3; dx = 1; dy = 0; score = 0;
  for (int i = 0; i < len; i++) { sx[i] = 2 - i; sy[i] = 3; }
  foodX = 5; foodY = 3;     // the first bite is straight ahead
  Serial.println("SNAKE: new game");
  show();
}

void steer() {
  int x = analogRead(STICK_X), y = analogRead(STICK_Y);
  if (x < 300 && dx == 0)      { dx = -1; dy = 0; Serial.println("turn L"); }
  else if (x > 700 && dx == 0) { dx = 1;  dy = 0; Serial.println("turn R"); }
  else if (y < 300 && dy == 0) { dx = 0; dy = -1; Serial.println("turn U"); }
  else if (y > 700 && dy == 0) { dx = 0; dy = 1;  Serial.println("turn D"); }
}

void setup() {
  Serial.begin(9600);
  pinMode(CS, OUTPUT);
  pinMode(BUZZER, OUTPUT);
  pinMode(STICK_SW, INPUT_PULLUP);
  digitalWrite(CS, HIGH);
  SPI.begin();
  max7219(0x0F, 0);   // display test off
  max7219(0x09, 0);   // no BCD decoding: raw pixels
  max7219(0x0A, 6);   // brightness
  max7219(0x0B, 7);   // scan all eight rows
  max7219(0x0C, 1);   // out of shutdown
  newGame();
}

void loop() {
  steer();
  if (millis() - lastStep < STEP_MS) return;
  lastStep = millis();

  int nx = sx[0] + dx, ny = sy[0] + dy;
  if (nx < 0 || nx > 7 || ny < 0 || ny > 7 || onSnake(nx, ny)) {
    Serial.print("GAME OVER  score ");
    Serial.println(score);
    digitalWrite(BUZZER, HIGH); delay(400); digitalWrite(BUZZER, LOW);
    delay(600);
    newGame();
    return;
  }
  bool ate = (nx == foodX && ny == foodY);
  if (ate && len < 64) len++;
  for (int i = len - 1; i > 0; i--) { sx[i] = sx[i - 1]; sy[i] = sy[i - 1]; }
  sx[0] = nx; sy[0] = ny;
  if (ate) {
    score++;
    Serial.print("score ");
    Serial.println(score);
    digitalWrite(BUZZER, HIGH); delay(30); digitalWrite(BUZZER, LOW);
    placeFood();
  }
  show();
}
`;

const snake: BuiltinProject = {
  id: 'cp_matrix_snake',
  title: 'Snake on an 8×8 LED matrix',
  description:
    'The whole game on a MAX7219 matrix: an analog joystick steers, the snake grows when it eats, a buzzer ' +
    'clicks on every bite and sounds when you crash. The matrix driver is programmed register by register over ' +
    'hardware SPI — no library — so every pixel you see is a byte the sketch sent. Drag the joystick in the ' +
    'inspector (or click it on the canvas) to play.',
  author: 'creator',
  tags: ['game', 'max7219', 'spi', 'joystick'],
  baseLikes: 81,
  createdAt: '2026-10-18T21:05:00.000Z',
  build: () => {
    const p = emptyProject('Snake on an 8×8 LED matrix');
    const uno = inst('board.arduino-uno', 40, 260);
    const matrix = inst('comp.max7219', 400, 40);
    const stick = inst('comp.joystick', 400, 230);
    const buzzer = inst('comp.buzzer', 600, 120);
    const w = new Wiring(uno, '5V', 'GND_PWR1');
    w.supply(matrix);
    w.link(uno, 'D11', matrix, 'din', GREEN);
    w.link(uno, 'D13', matrix, 'clk', YELLOW);
    w.link(uno, 'D10', matrix, 'cs', PURPLE);
    w.supply(stick);
    w.link(stick, 'vrx', uno, 'A0', BLUE);
    w.link(stick, 'vry', uno, 'A1', TEAL);
    w.link(stick, 'sw', uno, 'D2', ORANGE);
    w.link(uno, 'D8', buzzer, 'plus', ORANGE);
    w.link(buzzer, 'minus', uno, 'GND_TOP', BLACK);
    p.boardInstances = [uno];
    p.componentInstances = [matrix, stick, buzzer];
    p.connections = w.connections;
    p.codeFiles = [code('sketch.ino', SNAKE_SKETCH)];
    p.tests = [
      bench(
        'Eat, turn, crash',
        'The first bite is straight ahead; pushing the stick up turns the snake into the top wall.',
        [
          { kind: 'serial-contains', text: 'SNAKE: new game', withinMs: 500 },
          { kind: 'serial-contains', text: 'score 1', withinMs: 1300 },
          { kind: 'serial-contains', text: 'turn U', withinMs: 1500 },
          { kind: 'serial-contains', text: 'GAME OVER  score 1', withinMs: 3200 },
          { kind: 'pin-toggles', pin: 8, minToggles: 2, withinMs: 3200 },
        ],
        {
          events: [
            { atMs: 1000, action: 'set-analog', componentId: `${stick.id}#y`, value: 0 },
            { atMs: 1300, action: 'set-analog', componentId: `${stick.id}#y`, value: 0.5 },
          ],
          timeoutMs: 3400,
        },
      ),
    ];
    return p;
  },
};

// ============================================================ keypad safe

const SAFE_SKETCH = `// A keypad combination safe.
//
// A 4x4 membrane keypad is scanned by hand - one row driven low at a time,
// columns read through pull-ups - a servo is the bolt, a 16x2 LCD on an I2C
// backpack shows the prompt, and LEDs and a buzzer say yes or no.
// The LCD is driven directly too: an HD44780 in 4-bit mode behind a PCF8574.
//
// The code is 1234, finished with #. * clears what you typed.

#include <Wire.h>
#include <Servo.h>

const char CODE[] = "1234";
const byte ROWS[4] = {9, 8, 7, 6};
const byte COLS[4] = {5, 4, 3, 2};
const char KEYS[4][4] = {
  {'1', '2', '3', 'A'},
  {'4', '5', '6', 'B'},
  {'7', '8', '9', 'C'},
  {'*', '0', '#', 'D'},
};
const int BOLT = 10, GREEN_LED = A0, RED_LED = A1, BUZZER = A2;
const uint8_t LCD = 0x27;
const byte RS = 0x01, EN = 0x04, LIGHT = 0x08;

Servo bolt;
char entry[9];
byte typed = 0;
char lastKey = 0;
unsigned long unlockedAt = 0;

// ---- LCD: HD44780, 4-bit, behind a PCF8574 ----
void lcdNibble(byte bits, byte mode) {
  byte b = (bits & 0xF0) | mode | LIGHT;
  Wire.beginTransmission(LCD);
  Wire.write(b | EN);
  Wire.write(b);
  Wire.endTransmission();
}
void lcdSend(byte value, byte mode) { lcdNibble(value, mode); lcdNibble(value << 4, mode); }
void lcdCommand(byte c) { lcdSend(c, 0); delay(c < 4 ? 2 : 1); }
void lcdText(byte row, const char *text) {
  lcdCommand(0x80 | (row ? 0x40 : 0));
  for (byte i = 0; i < 16; i++) lcdSend(*text ? *text++ : ' ', RS);
}
void lcdBegin() {
  delay(50);
  lcdNibble(0x30, 0); delay(5);
  lcdNibble(0x30, 0); delay(1);
  lcdNibble(0x30, 0);
  lcdNibble(0x20, 0);           // into 4-bit mode
  lcdCommand(0x28);             // two lines, 5x8
  lcdCommand(0x0C);             // display on, no cursor
  lcdCommand(0x06);             // move right as we write
  lcdCommand(0x01);             // clear
}

// ---- keypad: one row low at a time ----
char scanKeypad() {
  for (byte r = 0; r < 4; r++) {
    pinMode(ROWS[r], OUTPUT);
    digitalWrite(ROWS[r], LOW);
    delay(8);                    // let the line settle before reading
    for (byte c = 0; c < 4; c++) {
      if (digitalRead(COLS[c]) == LOW) {
        pinMode(ROWS[r], INPUT);
        return KEYS[r][c];
      }
    }
    pinMode(ROWS[r], INPUT);     // released, so two keys can never short
  }
  return 0;
}

void prompt() {
  typed = 0;
  entry[0] = 0;
  lcdText(0, "Enter code:");
  lcdText(1, "");
}

void beep(int times, int ms) {
  for (int i = 0; i < times; i++) {
    digitalWrite(BUZZER, HIGH); delay(ms);
    digitalWrite(BUZZER, LOW);  delay(ms);
  }
}

void setup() {
  Serial.begin(9600);
  for (byte i = 0; i < 4; i++) { pinMode(ROWS[i], INPUT); pinMode(COLS[i], INPUT_PULLUP); }
  pinMode(GREEN_LED, OUTPUT); pinMode(RED_LED, OUTPUT); pinMode(BUZZER, OUTPUT);
  bolt.attach(BOLT);
  bolt.write(0);                 // locked
  Wire.begin();
  lcdBegin();
  prompt();
  Serial.println("SAFE locked");
}

void loop() {
  if (unlockedAt && millis() - unlockedAt > 3000) {   // close again after 3 s
    unlockedAt = 0;
    bolt.write(0);
    digitalWrite(GREEN_LED, LOW);
    Serial.println("SAFE locked");
    prompt();
  }

  char key = scanKeypad();
  if (key == lastKey) return;    // act on presses, not on holding
  lastKey = key;
  if (!key) return;

  Serial.print("key ");
  Serial.println(key);
  if (key == '*') { prompt(); return; }
  if (key != '#') {
    if (typed < 8) { entry[typed++] = key; entry[typed] = 0; }
    char stars[9] = "";
    for (byte i = 0; i < typed; i++) stars[i] = '*';
    stars[typed] = 0;
    lcdText(1, stars);
    return;
  }
  if (strcmp(entry, CODE) == 0) {
    Serial.println("UNLOCKED");
    lcdText(0, "Open");
    lcdText(1, "Welcome back");
    bolt.write(90);
    digitalWrite(GREEN_LED, HIGH);
    beep(1, 80);
    unlockedAt = millis();
  } else {
    Serial.println("WRONG CODE");
    lcdText(0, "Wrong code");
    digitalWrite(RED_LED, HIGH);
    beep(3, 60);
    digitalWrite(RED_LED, LOW);
    prompt();
  }
}
`;

const KEY_POS: Record<string, string> = {
  '1': 'r0c0', '2': 'r0c1', '3': 'r0c2', 'A': 'r0c3',
  '4': 'r1c0', '5': 'r1c1', '6': 'r1c2', 'B': 'r1c3',
  '7': 'r2c0', '8': 'r2c1', '9': 'r2c2', 'C': 'r2c3',
  '*': 'r3c0', '0': 'r3c1', '#': 'r3c2', 'D': 'r3c3',
};

const keypadSafe: BuiltinProject = {
  id: 'cp_keypad_safe',
  title: 'Keypad combination safe',
  description:
    'A 4×4 keypad scanned by hand, a servo as the bolt, a 16×2 LCD on an I2C backpack driven straight from the ' +
    'HD44780 datasheet, and LEDs and a buzzer for right and wrong. Type 1234 then # on the keypad — click the ' +
    'keys on the canvas — and the bolt swings open for three seconds. Get it wrong and it tells you.',
  author: 'creator',
  tags: ['keypad', 'servo', 'lcd', 'i2c'],
  baseLikes: 73,
  createdAt: '2026-10-14T16:40:00.000Z',
  build: () => {
    const p = emptyProject('Keypad combination safe');
    const uno = inst('board.arduino-uno', 40, 300);
    const keypad = inst('comp.keypad-4x4', 380, 260);
    const lcd = inst('comp.lcd1602', 380, 40);
    const servo = inst('comp.servo', 600, 260);
    const rg = inst('comp.resistor', 600, 420, { resistance: 220 });
    const green = inst('comp.led', 700, 440, { color: 'green' });
    const rr = inst('comp.resistor', 600, 490, { resistance: 220 });
    const red = inst('comp.led', 700, 510, { color: 'red' });
    const buzzer = inst('comp.buzzer', 760, 300);
    const w = new Wiring(uno, '5V', 'GND_PWR1');
    ['D9', 'D8', 'D7', 'D6'].forEach((pin, i) => w.link(uno, pin, keypad, `row${i + 1}`, ORANGE));
    ['D5', 'D4', 'D3', 'D2'].forEach((pin, i) => w.link(uno, pin, keypad, `col${i + 1}`, BLUE));
    w.supply(lcd);
    w.link(lcd, 'sda', uno, 'A4', GREEN);
    w.link(lcd, 'scl', uno, 'A5', BLUE);
    w.supply(servo);
    w.link(uno, 'D10', servo, 'sig', YELLOW);
    w.lamp(uno, 'A0', rg, green, GREEN);
    w.lamp(uno, 'A1', rr, red, RED);
    w.link(uno, 'A2', buzzer, 'plus', ORANGE);
    w.link(buzzer, 'minus', uno, 'GND_TOP', BLACK);
    p.boardInstances = [uno];
    p.componentInstances = [keypad, lcd, servo, rg, green, rr, red, buzzer];
    p.connections = w.connections;
    p.codeFiles = [code('sketch.ino', SAFE_SKETCH)];
    const press = (key: string, at: number) => [
      { atMs: at, action: 'press' as const, componentId: contactStateKey(keypad.id, KEY_POS[key]) },
      { atMs: at + 150, action: 'release' as const, componentId: contactStateKey(keypad.id, KEY_POS[key]) },
    ];
    const sequence = (keys: string, start: number) => [...keys].flatMap((k, i) => press(k, start + i * 300));
    p.tests = [
      bench(
        'A wrong code, then the right one',
        'Typed on the keypad matrix itself: 9 # is refused, 1 2 3 4 # opens the bolt.',
        [
          { kind: 'serial-contains', text: 'SAFE locked', withinMs: 800 },
          { kind: 'serial-contains', text: 'WRONG CODE', withinMs: 2000 },
          { kind: 'serial-contains', text: 'UNLOCKED', withinMs: 4400 },
          { kind: 'pin-becomes-high', pin: 14, withinMs: 4400 },
        ],
        { events: [...sequence('9#', 600), ...sequence('1234#', 2000)], timeoutMs: 4500 },
      ),
    ];
    return p;
  },
};

// ======================================================== weather station

const WEATHER_SKETCH = `// A four-chip weather station on one I2C bus.
//
//   BMP280  (0x76) temperature and pressure, datasheet compensation in full
//   SHT31   (0x44) temperature and humidity
//   DS3231  (0x68) the time
//   LCD2004 (0x27) a 20x4 display behind a PCF8574
//
// Four devices, two wires, every byte sent by hand. An amber LED and the
// buzzer warn when the air gets too humid.

#include <Wire.h>

const uint8_t BMP = 0x76, SHT = 0x44, RTC = 0x68, LCD = 0x27;
const int HUMID_LED = 9, BUZZER = 8;
const float HUMID_LIMIT = 70.0;

uint16_t T1, P1; int16_t T2, T3, P2, P3, P4, P5, P6, P7, P8, P9;

// ---- I2C helpers ----
void writeReg(uint8_t dev, uint8_t reg, uint8_t value) {
  Wire.beginTransmission(dev); Wire.write(reg); Wire.write(value); Wire.endTransmission();
}
void readRegs(uint8_t dev, uint8_t reg, uint8_t *buf, uint8_t n) {
  Wire.beginTransmission(dev); Wire.write(reg); Wire.endTransmission();
  Wire.requestFrom((int)dev, (int)n);
  for (uint8_t i = 0; i < n; i++) buf[i] = Wire.read();
}

// ---- BMP280 ----
void bmpBegin() {
  uint8_t c[24];
  readRegs(BMP, 0x88, c, 24);
  T1 = c[0] | (c[1] << 8);  T2 = c[2] | (c[3] << 8);  T3 = c[4] | (c[5] << 8);
  P1 = c[6] | (c[7] << 8);  P2 = c[8] | (c[9] << 8);  P3 = c[10] | (c[11] << 8);
  P4 = c[12] | (c[13] << 8); P5 = c[14] | (c[15] << 8); P6 = c[16] | (c[17] << 8);
  P7 = c[18] | (c[19] << 8); P8 = c[20] | (c[21] << 8); P9 = c[22] | (c[23] << 8);
  writeReg(BMP, 0xF4, 0x27);  // normal mode, x1 oversampling
}
void bmpRead(float *celsius, float *hpa) {
  uint8_t d[6];
  readRegs(BMP, 0xF7, d, 6);
  long adcP = ((long)d[0] << 12) | ((long)d[1] << 4) | (d[2] >> 4);
  long adcT = ((long)d[3] << 12) | ((long)d[4] << 4) | (d[5] >> 4);
  float v1 = (adcT / 16384.0 - T1 / 1024.0) * T2;
  float v2 = (adcT / 131072.0 - T1 / 8192.0) * (adcT / 131072.0 - T1 / 8192.0) * T3;
  float tFine = v1 + v2;
  *celsius = tFine / 5120.0;
  v1 = tFine / 2.0 - 64000.0;
  v2 = v1 * v1 * P6 / 32768.0 + v1 * P5 * 2.0;
  v2 = v2 / 4.0 + P4 * 65536.0;
  v1 = (P3 * v1 * v1 / 524288.0 + P2 * v1) / 524288.0;
  v1 = (1.0 + v1 / 32768.0) * P1;
  float pa = 1048576.0 - adcP;
  pa = (pa - v2 / 4096.0) * 6250.0 / v1;
  v1 = P9 * pa * pa / 2147483648.0;
  v2 = pa * P8 / 32768.0;
  pa = pa + (v1 + v2 + P7) / 16.0;
  *hpa = pa / 100.0;
}

// ---- SHT31: single shot, high repeatability ----
void shtRead(float *celsius, float *rh) {
  Wire.beginTransmission(SHT); Wire.write(0x24); Wire.write(0x00); Wire.endTransmission();
  delay(16);
  Wire.requestFrom((int)SHT, 6);
  uint16_t t = (Wire.read() << 8) | Wire.read(); Wire.read();
  uint16_t h = (Wire.read() << 8) | Wire.read(); Wire.read();
  *celsius = -45.0 + 175.0 * t / 65535.0;
  *rh = 100.0 * h / 65535.0;
}

// ---- DS3231 ----
byte bcd(byte b) { return (b >> 4) * 10 + (b & 0x0F); }
void rtcRead(byte *h, byte *m, byte *s) {
  uint8_t t[3];
  readRegs(RTC, 0x00, t, 3);
  *s = bcd(t[0] & 0x7F); *m = bcd(t[1]); *h = bcd(t[2] & 0x3F);
}

// ---- LCD2004: HD44780, 4-bit, behind a PCF8574 ----
void lcdNibble(byte bits, byte mode) {
  byte b = (bits & 0xF0) | mode | 0x08;
  Wire.beginTransmission(LCD); Wire.write(b | 0x04); Wire.write(b); Wire.endTransmission();
}
void lcdSend(byte v, byte mode) { lcdNibble(v, mode); lcdNibble(v << 4, mode); }
void lcdLine(byte row, const char *text) {
  const byte start[4] = {0x00, 0x40, 0x14, 0x54};
  lcdSend(0x80 | start[row], 0);
  for (byte i = 0; i < 20; i++) lcdSend(*text ? *text++ : ' ', 0x01);
}
void lcdBegin() {
  delay(50);
  lcdNibble(0x30, 0); delay(5); lcdNibble(0x30, 0); delay(1); lcdNibble(0x30, 0); lcdNibble(0x20, 0);
  lcdSend(0x28, 0); lcdSend(0x0C, 0); lcdSend(0x06, 0); lcdSend(0x01, 0); delay(2);
}

void setup() {
  Serial.begin(9600);
  pinMode(HUMID_LED, OUTPUT);
  pinMode(BUZZER, OUTPUT);
  Wire.begin();
  bmpBegin();
  lcdBegin();
  lcdLine(0, "Weather station");
  Serial.println("weather station: 4 devices on I2C");
}

void loop() {
  float bmpC, hpa, shtC, rh;
  byte h, m, s;
  bmpRead(&bmpC, &hpa);
  shtRead(&shtC, &rh);
  rtcRead(&h, &m, &s);
  bool humid = rh > HUMID_LIMIT;
  digitalWrite(HUMID_LED, humid ? HIGH : LOW);
  if (humid) { digitalWrite(BUZZER, HIGH); delay(40); digitalWrite(BUZZER, LOW); }

  char line[21];
  snprintf(line, sizeof line, "Time %02d:%02d:%02d", h, m, s);
  lcdLine(0, line);
  snprintf(line, sizeof line, "Temp %d.%d C", (int)bmpC, abs((int)(bmpC * 10) % 10));
  lcdLine(1, line);
  snprintf(line, sizeof line, "Humidity %d%%%s", (int)(rh + 0.5), humid ? " HUMID" : "");
  lcdLine(2, line);
  snprintf(line, sizeof line, "Pressure %d hPa", (int)(hpa + 0.5));
  lcdLine(3, line);

  Serial.print("T "); Serial.print(bmpC, 1);
  Serial.print("C  RH "); Serial.print(rh, 0);
  Serial.print("%  P "); Serial.print(hpa, 1);
  Serial.print("hPa  SHT "); Serial.print(shtC, 1);
  Serial.println(humid ? "C  HUMID" : "C");
  delay(300);
}
`;

const weatherStation: BuiltinProject = {
  id: 'cp_weather_station',
  title: 'Four-chip weather station on one I2C bus',
  description:
    'A BMP280, an SHT31, a DS3231 clock and a 20×4 LCD sharing two wires, every byte sent by hand: the ' +
    'BMP280\'s full temperature and pressure compensation from the datasheet, the SHT31\'s single-shot ' +
    'measurement, BCD time from the RTC, and the LCD in 4-bit mode behind its PCF8574. Set the temperature, ' +
    'pressure or humidity on any sensor in the inspector; push the humidity past 70% and the alarm goes off.',
  author: 'creator',
  tags: ['i2c', 'weather', 'lcd', 'sensors'],
  baseLikes: 58,
  createdAt: '2026-10-08T12:20:00.000Z',
  build: () => {
    const p = emptyProject('Four-chip weather station');
    const uno = inst('board.arduino-uno', 40, 300);
    const bmp = inst('comp.bmp280', 360, 60);
    const sht = inst('comp.sht31', 460, 60);
    const rtc = inst('comp.ds3231', 580, 60);
    const lcd = inst('comp.lcd2004', 360, 160);
    const r = inst('comp.resistor', 380, 450, { resistance: 220 });
    const amber = inst('comp.led', 480, 470, { color: 'yellow' });
    const buzzer = inst('comp.buzzer', 560, 450);
    const w = new Wiring(uno, '5V', 'GND_PWR1');
    // The BMP280 is a 3.3 V part; the SHT31 breakout takes 5 V.
    w.link(bmp, 'vcc', uno, '3V3', RED);
    w.link(bmp, 'gnd', uno, 'GND_PWR2', BLACK);
    w.supply(sht);
    w.supply(rtc);
    w.supply(lcd);
    for (const dev of [bmp, sht, rtc, lcd]) {
      w.link(dev, 'sda', uno, 'A4', GREEN);
      w.link(dev, 'scl', uno, 'A5', BLUE);
    }
    w.lamp(uno, 'D9', r, amber, YELLOW);
    w.link(uno, 'D8', buzzer, 'plus', ORANGE);
    w.link(buzzer, 'minus', uno, 'GND_TOP', BLACK);
    p.boardInstances = [uno];
    p.componentInstances = [bmp, sht, rtc, lcd, r, amber, buzzer];
    p.connections = w.connections;
    p.codeFiles = [code('sketch.ino', WEATHER_SKETCH)];
    p.tests = [
      bench(
        'Every sensor answers, and humidity raises the alarm',
        'Readings come off the bus with the datasheet arithmetic; 82% humidity lights the amber LED.',
        [
          { kind: 'serial-contains', text: 'weather station: 4 devices on I2C', withinMs: 800 },
          { kind: 'serial-contains', text: 'T 21.5C', withinMs: 1800 },
          { kind: 'serial-contains', text: 'P 1013.', withinMs: 1800 },
          { kind: 'serial-contains', text: 'RH 82%', withinMs: 2500 },
          { kind: 'serial-contains', text: 'HUMID', withinMs: 2500 },
          { kind: 'pin-becomes-high', pin: 9, withinMs: 2500 },
        ],
        {
          events: [
            { atMs: 300, action: 'set-value', componentId: `${bmp.id}#temperature`, value: 21.5 },
            { atMs: 300, action: 'set-value', componentId: `${bmp.id}#pressure`, value: 1013.4 },
            { atMs: 1500, action: 'set-value', componentId: `${sht.id}#humidity`, value: 82 },
          ],
          timeoutMs: 2600,
        },
      ),
    ];
    return p;
  },
};

// ======================================================= two-board link

const PICO_NODE_SKETCH = `// Two boards, one bus: the sender (Raspberry Pi Pico).
//
// Reads a 4-way DIP switch and puts the value on a 4-bit parallel bus - four
// data wires and a strobe - to the Uno. Each board runs its own sketch in its
// own emulator; the only thing between them is the wires on the canvas.
//
// Protocol: set the four data lines, wait for them to settle, raise STROBE,
// hold it, drop it. The Uno latches the data on the rising edge.

const int DIP[4]  = {2, 3, 4, 5};       // GP2..GP5, switches to ground
const int DATA[4] = {10, 11, 12, 13};   // GP10..GP13 -> Uno D2..D5
const int STROBE = 14;                  // GP14 -> Uno D6
const int LED = 15;                     // GP15 lights while sending

int lastSent = -1;
unsigned long lastSend = 0;

void setup() {
  Serial1.begin(115200);                // the serial monitor
  for (int i = 0; i < 4; i++) {
    pinMode(DIP[i], INPUT_PULLUP);
    pinMode(DATA[i], OUTPUT);
  }
  pinMode(STROBE, OUTPUT);
  pinMode(LED, OUTPUT);
  Serial1.println("sender ready");
}

void send(int value) {
  digitalWrite(LED, HIGH);
  for (int i = 0; i < 4; i++) digitalWrite(DATA[i], (value >> i) & 1);
  delay(5);                             // data settles before the strobe
  digitalWrite(STROBE, HIGH);
  delay(10);
  digitalWrite(STROBE, LOW);
  digitalWrite(LED, LOW);
  Serial1.print("sent ");
  Serial1.println(value);
}

void loop() {
  int value = 0;
  for (int i = 0; i < 4; i++) if (digitalRead(DIP[i]) == LOW) value |= 1 << i;   // ON pulls low
  if (value > 9) value = 9;                                                       // one decimal digit
  // Send on every change, and every half second anyway.
  if (value != lastSent || millis() - lastSend > 500) {
    send(value);
    lastSent = value;
    lastSend = millis();
  }
  delay(20);
}
`;

const UNO_DISPLAY_SKETCH = `// Two boards, one bus: the receiver (Arduino Uno).
//
// Watches the strobe from the Pico; on each rising edge it reads the four
// data lines and shows the digit on a seven-segment display through a CD4511.

const int DATA[4] = {2, 3, 4, 5};    // from Pico GP10..GP13
const int STROBE = 6;                // from Pico GP14
const int BCD[4] = {8, 9, 10, 11};   // to CD4511 A..D
const int GOT_LED = 7;

int lastStrobe = LOW;

void setup() {
  Serial.begin(9600);
  for (int i = 0; i < 4; i++) {
    pinMode(DATA[i], INPUT);
    pinMode(BCD[i], OUTPUT);
  }
  pinMode(STROBE, INPUT);
  pinMode(GOT_LED, OUTPUT);
  Serial.println("receiver ready");
}

void loop() {
  int strobe = digitalRead(STROBE);
  if (strobe == HIGH && lastStrobe == LOW) {
    int value = 0;
    for (int i = 0; i < 4; i++) if (digitalRead(DATA[i]) == HIGH) value |= 1 << i;
    for (int i = 0; i < 4; i++) digitalWrite(BCD[i], (value >> i) & 1);
    digitalWrite(GOT_LED, !digitalRead(GOT_LED));
    Serial.print("Uno shows ");
    Serial.println(value);
  }
  lastStrobe = strobe;
}
`;

const twoBoardLink: BuiltinProject = {
  id: 'cp_two_board_link',
  title: 'Two boards, one bus: Pico to Uno',
  description:
    'Two microcontrollers, each running its own sketch in its own emulator, joined by nothing but wires: the ' +
    'Pico reads a DIP switch and sends the value over a 4-bit parallel bus with a strobe line, and the Uno ' +
    'latches it on the strobe and drives a seven-segment display through a CD4511. Flip the switches on the ' +
    'canvas and the digit changes on the other board. Each board has its own sketch tab.',
  author: 'creator',
  tags: ['multi-board', 'pico', 'parallel-bus', 'cd4511'],
  baseLikes: 46,
  createdAt: '2026-10-02T09:45:00.000Z',
  build: () => {
    const p = emptyProject('Two boards, one bus');
    const pico = inst('board.raspberry-pi-pico', 40, 80);
    const uno = inst('board.arduino-uno', 460, 300);
    const dip = inst('comp.dip-switch-4', 240, 60);
    const rl = inst('comp.resistor', 240, 220, { resistance: 220 });
    const picoLed = inst('comp.led', 330, 240, { color: 'blue' });
    const decoder = inst('comp.cd4511', 820, 60);
    const display = inst('comp.seven-segment', 920, 70);
    const rg = inst('comp.resistor', 820, 300, { resistance: 220 });
    const gotLed = inst('comp.led', 910, 320, { color: 'green' });
    const pw = new Wiring(pico, '3V3', 'GND3');
    const uw = new Wiring(uno, '5V', 'GND_PWR1');

    // The bus: four data lines and a strobe, Pico to Uno, and the grounds joined.
    ['GP10', 'GP11', 'GP12', 'GP13'].forEach((pin, i) => pw.link(pico, pin, uno, `D${i + 2}`, PURPLE));
    pw.link(pico, 'GP14', uno, 'D6', YELLOW);
    pw.link(pico, 'GND1', uno, 'GND_PWR2', BLACK);

    // Pico side: switches to ground, an LED while sending.
    ['GP2', 'GP3', 'GP4', 'GP5'].forEach((pin, i) => {
      pw.link(pico, pin, dip, `a${i + 1}`, BLUE);
      pw.link(dip, `b${i + 1}`, pico, 'GND2', BLACK);
    });
    pw.lamp(pico, 'GP15', rl, picoLed, BLUE);

    // Uno side: BCD to the decoder, segments to the display, an LED per digit received.
    uw.supply(decoder);
    ['D8', 'D9', 'D10', 'D11'].forEach((pin, i) => uw.link(uno, pin, decoder, ['a', 'b', 'c', 'd'][i], GREEN));
    uw.high(decoder, 'nlt', 'nbi');
    uw.low(decoder, 'le');
    for (const sg of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) uw.link(decoder, `s${sg}`, display, sg, ORANGE);
    uw.low(display, 'com1');
    uw.lamp(uno, 'D7', rg, gotLed, GREEN);

    p.boardInstances = [pico, uno];
    p.componentInstances = [dip, rl, picoLed, decoder, display, rg, gotLed];
    p.connections = [...pw.connections, ...uw.connections];
    const picoSketch = code('pico_sender.ino', PICO_NODE_SKETCH);
    const unoSketch = code('uno_receiver.ino', UNO_DISPLAY_SKETCH);
    p.codeFiles = [picoSketch, unoSketch];
    pico.sketchId = picoSketch.id;
    uno.sketchId = unoSketch.id;
    p.tests = [
      bench(
        'The sender puts the switches on the bus',
        'Switches 1 and 3 on make 5, strobed out on GP14. (The bench runs the Pico; both boards run together live.)',
        [
          { kind: 'serial-contains', text: 'sent 0', withinMs: 600 },
          { kind: 'serial-contains', text: 'sent 5', withinMs: 1200 },
          { kind: 'pin-toggles', pin: 14, minToggles: 4, withinMs: 1600 },
        ],
        {
          events: [
            { atMs: 700, action: 'press', componentId: contactStateKey(dip.id, 'sw1') },
            { atMs: 700, action: 'press', componentId: contactStateKey(dip.id, 'sw3') },
          ],
          timeoutMs: 1700,
        },
      ),
    ];
    return p;
  },
  together: {
    description: 'Both boards running at once: the Uno receives what the Pico sends and shows it.',
    contacts: (p) => {
      const dip = p.componentInstances.find((c) => c.definitionId === 'comp.dip-switch-4')!;
      return [contactStateKey(dip.id, 'sw1'), contactStateKey(dip.id, 'sw3')];
    },
    runMs: 1500,
    expectSerial: ['[Arduino Uno R3] Uno shows 5'],
  },
};

export const CREATOR_PROJECTS: BuiltinProject[] = [logicComputer, snake, keypadSafe, weatherStation, twoBoardLink];
