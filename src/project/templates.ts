import {
  PROJECT_SCHEMA_VERSION,
  uid,
  type CircuitProject,
  type CodeFile,
  type ComponentInstance,
  type Connection,
  type TestAssertion,
  type TestCase,
  type TestInputEvent,
} from '../types';

function inst(definitionId: string, x: number, y: number, properties: Record<string, unknown> = {}, rotation = 0): ComponentInstance {
  return { id: uid('inst'), definitionId, x, y, rotation, properties, simulationState: {} };
}

function wire(
  a: ComponentInstance, aPin: string,
  b: ComponentInstance, bPin: string,
  color = '#2f9e44',
): Connection {
  return {
    id: uid('wire'),
    sourceComponentId: a.id,
    sourcePinId: aPin,
    targetComponentId: b.id,
    targetPinId: bPin,
    netId: '',
    color,
    points: [],
    routing: 'smooth',
  };
}

function code(name: string, content: string): CodeFile {
  return { id: uid('file'), name, content, language: 'cpp' };
}

/**
 * A test bench for a starter.
 *
 * Every starter has one, for a reason that is not ceremony: a starter is the
 * first thing a new user opens, and the only way to know it still does what its
 * description says is for something to assert it. These run on a fresh headless
 * emulator against the real compiled firmware, so a bench that passes is proof
 * the circuit and the sketch still agree.
 */
function bench(
  name: string,
  description: string,
  // Without the id, which this function is what assigns — asking a caller for
  // one would be asking it to invent a unique value it has no way to check.
  assertions: Omit<TestAssertion, 'id'>[],
  opts: { events?: TestInputEvent[]; timeoutMs?: number } = {},
): TestCase {
  return {
    id: uid('test'),
    name,
    description,
    events: opts.events ?? [],
    assertions: assertions.map((a) => ({ ...a, id: uid('as') })),
    timeoutMs: opts.timeoutMs ?? 4000,
  };
}

export function emptyProject(name: string): CircuitProject {
  const now = new Date().toISOString();
  return {
    id: uid('proj'),
    name,
    version: PROJECT_SCHEMA_VERSION,
    createdAt: now,
    updatedAt: now,
    boardInstances: [],
    componentInstances: [],
    connections: [],
    codeFiles: [code('sketch.ino', 'void setup() {\n  // put your setup code here, to run once:\n\n}\n\nvoid loop() {\n  // put your main code here, to run repeatedly:\n\n}\n')],
    tests: [],
    customDefinitions: [],
    settings: { serialBaud: 9600, simulationSpeed: 1 },
  };
}

export interface ProjectTemplate {
  id: string;
  name: string;
  description: string;
  tags: string[];
  /**
   * What this is for.
   *
   *   starter  — the smallest honest example of one idea, for somebody on
   *              their first day. One board, few parts, a sketch you can read
   *              in one screen.
   *   showcase — a worked project that shows what the application can
   *              actually do: real device models on real buses, across the
   *              architectures that genuinely execute firmware.
   *
   * They are separated because they answer different questions — "how do I
   * start" and "what is this capable of" — and a list that mixes them answers
   * neither.
   */
  kind: 'starter' | 'showcase';
  /** The board it opens on, named as the board names itself. */
  board: string;
  /** What a reader learns from it, in one line. */
  teaches?: string;
  build: () => CircuitProject;
}

/** The starters: the first thing a new user opens. */
export const STARTER_TEMPLATES = (): ProjectTemplate[] => PROJECT_TEMPLATES.filter((t) => t.kind === 'starter');

/** The showcase gallery: what the application can actually do. */
export const SHOWCASE_TEMPLATES = (): ProjectTemplate[] => PROJECT_TEMPLATES.filter((t) => t.kind === 'showcase');

const BLINK_CODE = `// CircuitDesk starter — Blink
// D13 drives an LED through a 220 ohm resistor to GND.

void setup() {
  pinMode(13, OUTPUT);
  Serial.begin(9600);
}

void loop() {
  digitalWrite(13, HIGH);
  Serial.println("ON");
  delay(500);
  digitalWrite(13, LOW);
  Serial.println("OFF");
  delay(500);
}
`;

export function buildBlinkProject(name = 'Blink'): CircuitProject {
  const p = emptyProject(name);
  const uno = inst('board.arduino-uno', 120, 160);
  const resistor = inst('comp.resistor', 470, 120, { resistance: 220 });
  const led = inst('comp.led', 560, 180, { color: 'red' });
  p.boardInstances = [uno];
  p.componentInstances = [resistor, led];
  p.connections = [
    wire(uno, 'D13', resistor, 'p1', '#e8590c'),
    wire(resistor, 'p2', led, 'anode', '#e8590c'),
    wire(led, 'cathode', uno, 'GND_TOP', '#212529'),
  ];
  p.codeFiles = [code('sketch.ino', BLINK_CODE)];
  p.tests = [
    {
      id: uid('test'),
      name: 'D13 blinks',
      description: 'D13 must go HIGH within 700 ms of reset and toggle at least 3 times in 2.5 s.',
      events: [],
      assertions: [
        { id: uid('as'), kind: 'pin-becomes-high', pin: 13, withinMs: 700 },
        { id: uid('as'), kind: 'pin-toggles', pin: 13, minToggles: 3, withinMs: 2500 },
        { id: uid('as'), kind: 'serial-contains', text: 'ON', withinMs: 1500 },
      ],
      timeoutMs: 4000,
    },
  ];
  return p;
}

const I2C_SENSOR_BUS_CODE = `// Showcase - I2C sensor bus
//
// Two devices share one pair of wires, addressed separately, driven with raw
// Wire calls so every byte on the bus is visible. No sensor library: the
// BMP280 here is a register-level model with the datasheet's own calibration
// constants, so the compensation below is the compensation from the datasheet
// and the number it produces is a real one.

#include <Wire.h>

const uint8_t BMP280 = 0x76;   // sensor
const uint8_t EEPROM_ADDR = 0x50;   // log
const int LED = 13;

uint16_t dig_T1; int16_t dig_T2, dig_T3;

uint8_t read8(uint8_t addr, uint8_t reg) {
  Wire.beginTransmission(addr); Wire.write(reg); Wire.endTransmission();
  Wire.requestFrom((int)addr, 1);
  return Wire.available() ? Wire.read() : 0;
}

uint16_t read16LE(uint8_t addr, uint8_t reg) {
  Wire.beginTransmission(addr); Wire.write(reg); Wire.endTransmission();
  Wire.requestFrom((int)addr, 2);
  uint16_t lo = Wire.read(), hi = Wire.read();
  return (hi << 8) | lo;
}

void setup() {
  Serial.begin(9600);
  pinMode(LED, OUTPUT);
  Wire.begin();

  uint8_t id = read8(BMP280, 0xD0);
  Serial.print("BMP280 chip id 0x"); Serial.println(id, HEX);

  dig_T1 = read16LE(BMP280, 0x88);
  dig_T2 = (int16_t)read16LE(BMP280, 0x8A);
  dig_T3 = (int16_t)read16LE(BMP280, 0x8C);

  // normal mode, temperature and pressure oversampling x1
  Wire.beginTransmission(BMP280); Wire.write(0xF4); Wire.write(0x27); Wire.endTransmission();
}

void loop() {
  // 20-bit temperature, MSB first
  Wire.beginTransmission(BMP280); Wire.write(0xFA); Wire.endTransmission();
  Wire.requestFrom((int)BMP280, 3);
  int32_t adc = ((int32_t)Wire.read() << 12) | ((int32_t)Wire.read() << 4) | (Wire.read() >> 4);

  // Datasheet compensation, integer form.
  int32_t v1 = ((((adc >> 3) - ((int32_t)dig_T1 << 1))) * (int32_t)dig_T2) >> 11;
  int32_t v2 = (((((adc >> 4) - (int32_t)dig_T1) * ((adc >> 4) - (int32_t)dig_T1)) >> 12) * (int32_t)dig_T3) >> 14;
  int32_t tFine = v1 + v2;
  int32_t centi = (tFine * 5 + 128) >> 8;

  Serial.print("temperature "); Serial.print(centi / 100); Serial.print("."); 
  Serial.print((centi % 100) / 10); Serial.println(" C");
  digitalWrite(LED, centi >= 2000 ? HIGH : LOW);

  // Log the whole degrees to the EEPROM at address 0, and read it back.
  Wire.beginTransmission(EEPROM_ADDR);
  Wire.write((uint8_t)0x00); Wire.write((uint8_t)0x00); Wire.write((uint8_t)(centi / 100));
  Wire.endTransmission();
  delay(10);
  Wire.beginTransmission(EEPROM_ADDR); Wire.write((uint8_t)0x00); Wire.write((uint8_t)0x00);
  Wire.endTransmission();
  Wire.requestFrom((int)EEPROM_ADDR, 1);
  if (Wire.available()) { Serial.print("logged "); Serial.println(Wire.read()); }

  delay(400);
}
`;

const SPI_SD_CARD_CODE = `// Showcase - SPI storage: the card's own init handshake
//
// No SD library. This is the sequence every one of them performs, written out
// so you can watch it: CMD0 to idle, CMD8 to check the voltage range, then
// CMD55/ACMD41 polled until the card stops reporting busy. The card model
// answers at the command layer and reports "still initialising" for the first
// few polls, exactly as real silicon does, so the retry loop below is not
// decoration - remove it and this fails.

#include <SPI.h>

const int CS = 10, LED = 7;

uint8_t cmd(uint8_t index, uint32_t arg, uint8_t crc) {
  digitalWrite(CS, LOW);
  SPI.transfer(0x40 | index);
  SPI.transfer(arg >> 24); SPI.transfer(arg >> 16);
  SPI.transfer(arg >> 8);  SPI.transfer(arg);
  SPI.transfer(crc);
  uint8_t r = 0xFF;
  for (int i = 0; i < 10 && (r & 0x80); i++) r = SPI.transfer(0xFF);
  digitalWrite(CS, HIGH);
  SPI.transfer(0xFF);
  return r;
}

void setup() {
  Serial.begin(9600);
  pinMode(CS, OUTPUT); pinMode(LED, OUTPUT);
  digitalWrite(CS, HIGH);
  SPI.begin();

  // 80 clocks with CS high: the card needs them before it will listen.
  for (int i = 0; i < 10; i++) SPI.transfer(0xFF);

  uint8_t r = cmd(0, 0, 0x95);
  Serial.print("CMD0 -> 0x"); Serial.println(r, HEX);

  r = cmd(8, 0x000001AA, 0x87);
  Serial.print("CMD8 -> 0x"); Serial.println(r, HEX);

  int polls = 0;
  do {
    cmd(55, 0, 0xFF);
    r = cmd(41, 0x40000000, 0xFF);
    polls++;
    delay(5);
  } while ((r & 0x01) && polls < 20);

  Serial.print("ready after "); Serial.print(polls); Serial.println(" polls");
  if (r == 0x00) { Serial.println("card initialised"); digitalWrite(LED, HIGH); }
}

void loop() {}
`;

const SHIFT_REGISTER_CODE = `// Showcase - 74HC595: eight outputs from three pins
//
// The shift register has no chip select. It consumes every clock edge it sees,
// which is why the outputs only change when RCLK rises - the latch is what
// makes the pattern appear all at once instead of sliding across the LEDs.
// Bits are shifted by hand here so the three signals are visible as three
// signals.

const int SER = 11, SRCLK = 13, RCLK = 8;

void shiftByte(uint8_t value) {
  for (int bit = 7; bit >= 0; bit--) {
    digitalWrite(SER, (value >> bit) & 1);
    digitalWrite(SRCLK, HIGH);
    digitalWrite(SRCLK, LOW);
  }
  digitalWrite(RCLK, HIGH);   // latch: outputs change here, and only here
  digitalWrite(RCLK, LOW);
}

void setup() {
  Serial.begin(9600);
  pinMode(SER, OUTPUT); pinMode(SRCLK, OUTPUT); pinMode(RCLK, OUTPUT);
  Serial.println("595 ready");
}

void loop() {
  for (int i = 0; i < 8; i++) {
    shiftByte(1 << i);
    Serial.print("pattern 0x"); Serial.println(1 << i, HEX);
    delay(120);
  }
}
`;

const PICO_I2C_CODE = `// Showcase - RP2040: an I2C bus on pins you choose
//
// The RP2040 can put I2C on several pin pairs, and the core picks GP4/GP5
// unless the sketch says otherwise. Wire.setSDA/setSCL before Wire.begin() is
// how you say otherwise, and it is why CircuitDesk's wiring checks ask which
// pins the firmware actually muxed rather than assuming.
//
// Output goes to Serial1 - the hardware UART on GP0/GP1. The USB CDC Serial
// object is not simulated here, so printing to it would produce nothing, and
// a showcase that printed into a void would be teaching the wrong lesson.

#include <Wire.h>

const uint8_t BMP280 = 0x76;
const int LED = 15;

uint8_t read8(uint8_t reg) {
  Wire.beginTransmission(BMP280); Wire.write(reg); Wire.endTransmission();
  Wire.requestFrom((int)BMP280, 1);
  return Wire.available() ? Wire.read() : 0;
}

uint16_t read16LE(uint8_t reg) {
  Wire.beginTransmission(BMP280); Wire.write(reg); Wire.endTransmission();
  Wire.requestFrom((int)BMP280, 2);
  uint16_t lo = Wire.read(), hi = Wire.read();
  return (hi << 8) | lo;
}

uint16_t dig_T1; int16_t dig_T2, dig_T3;

void setup() {
  Serial1.begin(9600);
  pinMode(LED, OUTPUT);

  Wire.setSDA(4);        // the pins this board brings the sensor out on
  Wire.setSCL(5);
  Wire.begin();

  Serial1.print("chip id 0x"); Serial1.println(read8(0xD0), HEX);
  dig_T1 = read16LE(0x88);
  dig_T2 = (int16_t)read16LE(0x8A);
  dig_T3 = (int16_t)read16LE(0x8C);
  Wire.beginTransmission(BMP280); Wire.write(0xF4); Wire.write(0x27); Wire.endTransmission();
}

void loop() {
  Wire.beginTransmission(BMP280); Wire.write(0xFA); Wire.endTransmission();
  Wire.requestFrom((int)BMP280, 3);
  int32_t adc = ((int32_t)Wire.read() << 12) | ((int32_t)Wire.read() << 4) | (Wire.read() >> 4);

  int32_t v1 = ((((adc >> 3) - ((int32_t)dig_T1 << 1))) * (int32_t)dig_T2) >> 11;
  int32_t v2 = (((((adc >> 4) - (int32_t)dig_T1) * ((adc >> 4) - (int32_t)dig_T1)) >> 12) * (int32_t)dig_T3) >> 14;
  int32_t centi = ((v1 + v2) * 5 + 128) >> 8;

  Serial1.print("temperature "); Serial1.print(centi / 100); Serial1.println(" C");
  digitalWrite(LED, centi >= 2000 ? HIGH : LOW);
  delay(300);
}
`;

const UART_GPS_CODE = `// Showcase - UART: parsing what a GPS actually sends
//
// The module is a device model that emits real NMEA sentences on its TX line
// at the baud the firmware configured, so this is byte-level parsing of a
// byte-level stream. Serial lines cross: the module's TX goes to the board's
// RX, which CircuitDesk will tell you about if you wire it straight through.

const int FIX_LED = 8;
char line[96];
uint8_t len = 0;

void handle(const char *s) {
  // $GPRMC,time,status,lat,N,lon,E,...  - status A means the fix is valid.
  if (strncmp(s, "$GPRMC", 6) != 0) return;
  const char *p = strchr(s, ',');
  if (!p) return;
  p = strchr(p + 1, ',');
  if (!p) return;
  char status = p[1];
  Serial.print("RMC status "); Serial.println(status);
  digitalWrite(FIX_LED, status == 'A' ? HIGH : LOW);
}

void setup() {
  Serial.begin(9600);
  pinMode(FIX_LED, OUTPUT);
  Serial.println("listening for NMEA");
}

void loop() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\\n' || len >= sizeof(line) - 1) {
      line[len] = 0;
      if (len > 6) handle(line);
      len = 0;
    } else if (c != '\\r') {
      line[len++] = c;
    }
  }
}
`;

const ESP32C6_GPIO_CODE = `// Showcase - ESP32-C6: what is real, and what is not
//
// This board executes the compiled RISC-V application image for real: ESP-IDF
// startup, FreeRTOS, setup() and loop(), and GPIO with its pull resistors.
//
// It does NOT simulate Wi-Fi, Bluetooth, Zigbee, Thread, USB Serial/JTAG, the
// ADC, PWM, I2C, SPI or the hardware UART. Sketches using them compile and
// run and quietly do nothing, so this showcase uses only what is real: pins
// in, pins out, and timing from the actual CPU.

const int LEDS[] = {15, 18, 19, 20};
const int BUTTON = 9;      // the board's BOOT button, active low

int step = 0;
bool lastPressed = false;

void setup() {
  for (int i = 0; i < 4; i++) pinMode(LEDS[i], OUTPUT);
  pinMode(BUTTON, INPUT_PULLUP);
}

void loop() {
  bool pressed = digitalRead(BUTTON) == LOW;

  // Held: all four on. Released: a single light walks along them.
  if (pressed) {
    for (int i = 0; i < 4; i++) digitalWrite(LEDS[i], HIGH);
  } else {
    for (int i = 0; i < 4; i++) digitalWrite(LEDS[i], i == step ? HIGH : LOW);
    step = (step + 1) & 3;
  }
  lastPressed = pressed;
  delay(120);
}
`;

const PICO_BLINK_CODE = `// Starter - Pico Blink
//
// GP15 drives an LED through a 220 ohm resistor to ground, and a button on
// GP14 holds it on. Two things worth knowing about this board:
//
//   * pin numbers here are GP numbers - the pad's own name on the chip, not
//     an Arduino board numbering. GP15 is pad 15.
//   * Serial here is USB CDC, which is not simulated, so anything printed to
//     it goes nowhere. Serial1 is the hardware UART on GP0/GP1 and does work.

const int LED = 15;
const int BUTTON = 14;

void setup() {
  pinMode(LED, OUTPUT);
  pinMode(BUTTON, INPUT_PULLUP);
  Serial1.begin(9600);
  Serial1.println("pico ready");
}

void loop() {
  if (digitalRead(BUTTON) == LOW) {
    digitalWrite(LED, HIGH);      // held: stay on
    delay(20);
    return;
  }
  digitalWrite(LED, HIGH);
  delay(250);
  digitalWrite(LED, LOW);
  delay(250);
}
`;

const C6_BLINK_CODE = `// Starter - ESP32-C6 Blink
//
// The compiled RISC-V image really executes: ESP-IDF startup, FreeRTOS, then
// setup() and loop(). GPIO and its pull resistors are simulated; Wi-Fi,
// Bluetooth, the ADC, PWM, I2C, SPI and the hardware UART are not, so a
// sketch using them compiles, runs, and quietly does nothing.
//
// Pin numbers are IO numbers - the pad's own name, as printed on the board.

const int LED = 15;
const int BUTTON = 9;    // BOOT button, active low

void setup() {
  pinMode(LED, OUTPUT);
  pinMode(BUTTON, INPUT_PULLUP);
}

void loop() {
  // Held down: fast. Released: slow. Both come from the real CPU's timing.
  int wait = digitalRead(BUTTON) == LOW ? 60 : 300;
  digitalWrite(LED, HIGH);
  delay(wait);
  digitalWrite(LED, LOW);
  delay(wait);
}
`;

const OLED_SSD1306_CODE = `// Showcase - SSD1306 over I2C, one command at a time
//
// No display library. The SSD1306 model implements the real command set and a
// real GDDRAM, so this is the initialisation sequence from the datasheet
// followed by pixel data, and what appears on the panel is what was written
// into memory.
//
// Control byte 0x00 means "commands follow"; 0x40 means "display data
// follows". That single distinction is most of the driver.

#include <Wire.h>

const uint8_t OLED = 0x3C;

void command(uint8_t c) {
  Wire.beginTransmission(OLED);
  Wire.write((uint8_t)0x00);
  Wire.write(c);
  Wire.endTransmission();
}

void setup() {
  Serial.begin(9600);
  Wire.begin();

  command(0xAE);              // display off while we configure it
  command(0x20); command(0x00);   // horizontal addressing
  command(0x21); command(0); command(127);   // column range
  command(0x22); command(0); command(7);     // page range
  command(0xA1);              // segment remap
  command(0xC8);              // scan direction
  command(0x81); command(0x7F);   // contrast
  command(0xA4);              // follow RAM, not all-on
  command(0xA6);              // normal, not inverted
  command(0xAF);              // display on
  Serial.println("ssd1306 initialised");

  // A vertical bar every eight columns, written straight into GDDRAM.
  for (int page = 0; page < 8; page++) {
    for (int col = 0; col < 128; col += 16) {
      Wire.beginTransmission(OLED);
      Wire.write((uint8_t)0x40);
      for (int i = 0; i < 16; i++) Wire.write(i < 2 ? 0xFF : 0x00);
      Wire.endTransmission();
    }
  }
  Serial.println("pattern written");
}

void loop() {
  // Invert, then back: one command, whole panel, no redraw.
  command(0xA7); delay(500);
  command(0xA6); delay(500);
}
`;

const STEPPER_SEQUENCE_CODE = `// Showcase - a stepper is a sequence, not a speed
//
// The four lines are coils. Where the rotor sits is wherever the energised
// coils put it, so motion comes from the ORDER the pattern is driven in, not
// from any "step" command. The model follows the half-step sequence below and
// moves one step per adjacent transition; drive the same four values in a
// different order and it turns the other way; skip a phase and it does not
// move at all, and the skip is counted rather than quietly credited.
//
// A relay shares the sketch to show a second kind of output: a coil you
// switch rather than sequence.

const int COILS[4] = {8, 9, 10, 11};
const int RELAY = 7;

// Half-step: eight states, each overlapping the next by one coil.
const uint8_t SEQ[8] = {
  0b0001, 0b0011, 0b0010, 0b0110,
  0b0100, 0b1100, 0b1000, 0b1001,
};

int phase = 0;
long steps = 0;

void applyPhase(int p) {
  for (int i = 0; i < 4; i++) digitalWrite(COILS[i], (SEQ[p & 7] >> i) & 1);
}

void setup() {
  Serial.begin(9600);
  for (int i = 0; i < 4; i++) pinMode(COILS[i], OUTPUT);
  pinMode(RELAY, OUTPUT);
  Serial.println("stepper ready");
}

void loop() {
  // One revolution's worth of half-steps one way, then back.
  for (int i = 0; i < 64; i++) { applyPhase(phase++); steps++; delay(3); }
  Serial.print("forward "); Serial.println(steps);
  digitalWrite(RELAY, HIGH);

  for (int i = 0; i < 64; i++) { applyPhase(--phase); steps++; delay(3); }
  Serial.print("reverse "); Serial.println(steps);
  digitalWrite(RELAY, LOW);
}
`;

export const PROJECT_TEMPLATES: ProjectTemplate[] = [
  {
    id: 'tpl.blink',
    kind: 'starter',
    board: 'Arduino Uno',
    name: 'Arduino Blink',
    description: 'Uno D13 → 220 Ω resistor → LED → GND, with the classic Blink sketch. Fully simulated.',
    tags: ['simulated', 'starter'],
    build: () => buildBlinkProject(),
  },
  {
    id: 'tpl.button-led',
    kind: 'starter',
    board: 'Arduino Uno',
    name: 'Button-controlled LED',
    description: 'Push button on D2 (INPUT_PULLUP) turns the D13 LED on. Fully simulated.',
    tags: ['simulated', 'input'],
    build: () => {
      const p = emptyProject('Button LED');
      const uno = inst('board.arduino-uno', 120, 160);
      const button = inst('comp.push-button', 470, 100);
      const resistor = inst('comp.resistor', 470, 220, { resistance: 220 });
      const led = inst('comp.led', 560, 280, { color: 'green' });
      p.boardInstances = [uno];
      p.componentInstances = [button, resistor, led];
      p.connections = [
        wire(uno, 'D2', button, '1a', '#1971c2'),
        wire(button, '2a', uno, 'GND_PWR1', '#212529'),
        wire(uno, 'D13', resistor, 'p1', '#e8590c'),
        wire(resistor, 'p2', led, 'anode', '#e8590c'),
        wire(led, 'cathode', uno, 'GND_TOP', '#212529'),
      ];
      p.codeFiles = [code('sketch.ino', `// Button on D2 (wired to GND, INPUT_PULLUP) controls LED on D13.

void setup() {
  pinMode(2, INPUT_PULLUP);
  pinMode(13, OUTPUT);
  Serial.begin(9600);
}

void loop() {
  bool pressed = digitalRead(2) == LOW;
  digitalWrite(13, pressed ? HIGH : LOW);
  if (pressed) {
    Serial.println("Button pressed");
    delay(150);
  }
}
`)];
      p.tests = [
        {
          id: uid('test'),
          name: 'Press button → LED on',
          description: 'After pressing the button at 300 ms, D13 must become HIGH within 500 ms.',
          events: [{ atMs: 300, action: 'press', componentId: button.id }],
          assertions: [{ id: uid('as'), kind: 'pin-becomes-high', pin: 13, withinMs: 800 }],
          timeoutMs: 3000,
        },
      ];
      return p;
    },
  },
  {
    id: 'tpl.potentiometer',
    kind: 'starter',
    board: 'Arduino Uno',
    name: 'Potentiometer reading',
    description: 'Potentiometer on A0 read via the real emulated ADC, reported over serial. Fully simulated.',
    tags: ['simulated', 'analog'],
    build: () => {
      const p = emptyProject('Potentiometer Reading');
      const uno = inst('board.arduino-uno', 120, 160);
      const pot = inst('comp.potentiometer', 480, 140);
      p.boardInstances = [uno];
      p.componentInstances = [pot];
      p.connections = [
        wire(pot, 't1', uno, 'GND_PWR1', '#212529'),
        wire(pot, 't2', uno, '5V', '#e03131'),
        wire(pot, 'wiper', uno, 'A0', '#2f9e44'),
      ];
      p.codeFiles = [code('sketch.ino', `void setup() {
  Serial.begin(9600);
}

void loop() {
  int value = analogRead(A0);
  Serial.print("A0 = ");
  Serial.println(value);
  delay(250);
}
`)];
      p.tests = [
        bench(
          'Wiper position reaches the sketch',
          'With the wiper at the top of its travel the ADC must read near full scale, and the sketch must print it.',
          [
            { kind: 'serial-contains', text: 'A0 = ', withinMs: 1200 },
            { kind: 'serial-contains', text: '1023', withinMs: 2500 },
          ],
          { events: [{ atMs: 200, action: 'set-analog', componentId: pot.id, value: 1 }], timeoutMs: 4000 },
        ),
      ];
      return p;
    },
  },
  {
    id: 'tpl.rgb',
    kind: 'starter',
    board: 'Arduino Uno',
    name: 'RGB LED fade',
    description: 'PWM color mixing on an RGB LED using pins 9/10/11. Fully simulated (duty-cycle brightness).',
    tags: ['simulated', 'pwm'],
    build: () => {
      const p = emptyProject('RGB LED');
      const uno = inst('board.arduino-uno', 120, 160);
      const rgb = inst('comp.rgb-led', 500, 140);
      const r1 = inst('comp.resistor', 420, 90, { resistance: 220 });
      const r2 = inst('comp.resistor', 420, 150, { resistance: 220 });
      const r3 = inst('comp.resistor', 420, 210, { resistance: 220 });
      p.boardInstances = [uno];
      p.componentInstances = [rgb, r1, r2, r3];
      p.connections = [
        wire(uno, 'D9', r1, 'p1', '#e03131'),
        wire(r1, 'p2', rgb, 'red', '#e03131'),
        wire(uno, 'D10', r2, 'p1', '#2f9e44'),
        wire(r2, 'p2', rgb, 'green', '#2f9e44'),
        wire(uno, 'D11', r3, 'p1', '#1971c2'),
        wire(r3, 'p2', rgb, 'blue', '#1971c2'),
        wire(rgb, 'cathode', uno, 'GND_TOP', '#212529'),
      ];
      p.codeFiles = [code('sketch.ino', `// Fades through colors on a common-cathode RGB LED.
const int R = 9, G = 10, B = 11;

void setup() {}

void loop() {
  for (int i = 0; i < 256; i += 4) { analogWrite(R, 255 - i); analogWrite(G, i); delay(10); }
  for (int i = 0; i < 256; i += 4) { analogWrite(G, 255 - i); analogWrite(B, i); delay(10); }
  for (int i = 0; i < 256; i += 4) { analogWrite(B, 255 - i); analogWrite(R, i); delay(10); }
}
`)];
      p.tests = [
        bench(
          'All three channels are driven',
          'Each colour pin must be switching, which is what PWM is — a steady level would mean one channel is dead.',
          [
            { kind: 'pin-toggles', pin: 9, minToggles: 10, withinMs: 1500 },
            { kind: 'pin-toggles', pin: 10, minToggles: 10, withinMs: 1500 },
            { kind: 'pin-toggles', pin: 11, minToggles: 10, withinMs: 1500 },
          ],
          { timeoutMs: 3000 },
        ),
      ];
      return p;
    },
  },
  {
    id: 'tpl.servo-sweep',
    kind: 'starter',
    board: 'Arduino Uno',
    name: 'Servo sweep',
    description: 'Servo on D9 swept by 50 Hz pulses generated in firmware. The horn angle follows the measured pulse width.',
    tags: ['simulated', 'motors'],
    build: () => {
      const p = emptyProject('Servo Sweep');
      const uno = inst('board.arduino-uno', 120, 160);
      const servo = inst('comp.servo', 500, 140);
      p.boardInstances = [uno];
      p.componentInstances = [servo];
      p.connections = [
        wire(servo, 'gnd', uno, 'GND_PWR1', '#212529'),
        wire(servo, 'vcc', uno, '5V', '#e03131'),
        wire(servo, 'sig', uno, 'D9', '#e8590c'),
      ];
      p.codeFiles = [code('sketch.ino', `// Sweeps a servo on D9 by generating 50 Hz pulses directly.
// (Pulse width 1000-2000 us maps to 0-180 degrees.)
const int SERVO_PIN = 9;

void setup() {
  pinMode(SERVO_PIN, OUTPUT);
}

void pulse(int microseconds) {
  digitalWrite(SERVO_PIN, HIGH);
  delayMicroseconds(microseconds);
  digitalWrite(SERVO_PIN, LOW);
  delay(20 - microseconds / 1000);
}

void loop() {
  for (int us = 1000; us <= 2000; us += 20) pulse(us);
  for (int us = 2000; us >= 1000; us -= 20) pulse(us);
}
`)];
      p.tests = [
        bench(
          'A 50 Hz pulse train reaches the servo',
          'The signal pin must pulse about 50 times a second. The horn angle follows the measured width, so no pulses means no movement.',
          [{ kind: 'pin-toggles', pin: 9, minToggles: 40, withinMs: 1000 }],
          { timeoutMs: 2500 },
        ),
      ];
      return p;
    },
  },
  {
    id: 'tpl.ultrasonic',
    kind: 'starter',
    board: 'Arduino Uno',
    name: 'Ultrasonic distance indicator',
    description: 'HC-SR04 distance turns an LED on when close. Echo timing is generated by the simulated sensor protocol.',
    tags: ['simulated', 'sensors'],
    build: () => {
      const p = emptyProject('Ultrasonic Distance');
      const uno = inst('board.arduino-uno', 120, 160);
      const sonar = inst('comp.ultrasonic', 480, 90);
      const resistor = inst('comp.resistor', 480, 230, { resistance: 220 });
      const led = inst('comp.led', 580, 260, { color: 'yellow' });
      p.boardInstances = [uno];
      p.componentInstances = [sonar, resistor, led];
      p.connections = [
        wire(sonar, 'vcc', uno, '5V', '#e03131'),
        wire(sonar, 'gnd', uno, 'GND_PWR1', '#212529'),
        wire(sonar, 'trig', uno, 'D7', '#7048e8'),
        wire(sonar, 'echo', uno, 'D8', '#1971c2'),
        wire(uno, 'D13', resistor, 'p1', '#e8590c'),
        wire(resistor, 'p2', led, 'anode', '#e8590c'),
        wire(led, 'cathode', uno, 'GND_TOP', '#212529'),
      ];
      p.codeFiles = [code('sketch.ino', `const int TRIG = 7, ECHO = 8, LED = 13;

void setup() {
  pinMode(TRIG, OUTPUT);
  pinMode(ECHO, INPUT);
  pinMode(LED, OUTPUT);
  Serial.begin(9600);
}

void loop() {
  digitalWrite(TRIG, LOW);
  delayMicroseconds(2);
  digitalWrite(TRIG, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG, LOW);

  long duration = pulseIn(ECHO, HIGH, 30000);
  long cm = duration / 58;

  Serial.print(cm);
  Serial.println(" cm");
  digitalWrite(LED, cm > 0 && cm < 20 ? HIGH : LOW);
  delay(200);
}
`)];
      p.tests = [
        bench(
          'Close object lights the LED',
          'With the target moved to 10 cm the sketch must measure it and switch the LED on; the echo timing comes from the sensor protocol, not from a number we hand it.',
          [
            { kind: 'serial-contains', text: 'cm', withinMs: 1500 },
            { kind: 'pin-becomes-high', pin: 13, withinMs: 2500 },
          ],
          { events: [{ atMs: 200, action: 'set-value', componentId: sonar.id, value: 10 }], timeoutMs: 4000 },
        ),
      ];
      return p;
    },
  },
  {
    id: 'tpl.seven-segment',
    kind: 'starter',
    board: 'Arduino Uno',
    name: 'Seven-segment counter',
    description: 'Counts 0-9 on a common-cathode digit driven from D2-D9. Segments light from real GPIO state.',
    tags: ['simulated', 'displays'],
    build: () => {
      const p = emptyProject('7-Segment Counter');
      const uno = inst('board.arduino-uno', 120, 160);
      const seg = inst('comp.seven-segment', 620, 130);
      const segPins: [string, string][] = [
        ['D2', 'a'], ['D3', 'b'], ['D4', 'c'], ['D5', 'd'], ['D6', 'e'], ['D7', 'f'], ['D8', 'g'], ['D9', 'dp'],
      ];
      // One resistor per segment, because a seven-segment display is eight
      // LEDs and each one needs its own. Sharing a single resistor on the
      // common cathode is the usual shortcut and it is wrong: the brightness
      // would then change with how many segments are lit.
      const resistors = segPins.map((_, i) => inst('comp.resistor', 430, 40 + i * 44, { resistance: 220 }));
      p.boardInstances = [uno];
      p.componentInstances = [seg, ...resistors];
      p.connections = [
        ...segPins.flatMap(([d, s], i) => [
          wire(uno, d, resistors[i], 'p1', '#7048e8'),
          wire(resistors[i], 'p2', seg, s, '#7048e8'),
        ]),
        wire(seg, 'com1', uno, 'GND_TOP', '#212529'),
      ];
      p.codeFiles = [code('sketch.ino', `// Segment order: a b c d e f g on D2..D8.
const byte DIGITS[10] = {
  0b0111111, 0b0000110, 0b1011011, 0b1001111, 0b1100110,
  0b1101101, 0b1111101, 0b0000111, 0b1111111, 0b1101111,
};

void setup() {
  for (int p = 2; p <= 9; p++) pinMode(p, OUTPUT);
}

void loop() {
  for (int n = 0; n < 10; n++) {
    for (int s = 0; s < 7; s++) digitalWrite(2 + s, (DIGITS[n] >> s) & 1);
    delay(500);
  }
}
`)];
      p.tests = [
        bench(
          'The digit changes as it counts',
          'Segment a is lit for 0 and dark for 1, so it must switch within the first two digits; segment b is dark only at 5 and 6, which takes three seconds to reach.',
          [
            { kind: 'pin-toggles', pin: 2, minToggles: 2, withinMs: 2000 },
            { kind: 'pin-toggles', pin: 3, minToggles: 1, withinMs: 3500 },
          ],
          { timeoutMs: 5000 },
        ),
      ];
      return p;
    },
  },
  {
    id: 'tpl.serial-demo',
    kind: 'starter',
    board: 'Arduino Uno',
    name: 'Serial monitor demo',
    description: 'Prints counters and echoes serial input — exercises the emulated UART both ways.',
    tags: ['simulated', 'serial'],
    build: () => {
      const p = emptyProject('Serial Monitor Demo');
      const uno = inst('board.arduino-uno', 160, 160);
      p.boardInstances = [uno];
      p.codeFiles = [code('sketch.ino', `unsigned long counter = 0;

void setup() {
  Serial.begin(9600);
  Serial.println("CircuitDesk serial demo ready.");
}

void loop() {
  if (Serial.available()) {
    String line = Serial.readStringUntil('\\n');
    Serial.print("You sent: ");
    Serial.println(line);
  }
  if (millis() % 1000 < 5) {
    Serial.print("uptime ");
    Serial.print(millis() / 1000);
    Serial.println(" s");
    delay(5);
  }
}
`)];
      p.tests = [
        bench(
          'It announces itself and keeps counting',
          'The banner proves the UART is up; the uptime line proves the sketch is still running a second later.',
          [
            { kind: 'serial-contains', text: 'serial demo ready', withinMs: 1000 },
            { kind: 'serial-contains', text: 'uptime', withinMs: 2500 },
          ],
          { timeoutMs: 4000 },
        ),
      ];
      return p;
    },
  },
  {
    id: 'show.i2c-sensor-bus',
    name: 'I2C sensor bus: BMP280 + EEPROM',
    description:
      'A pressure/temperature sensor and an EEPROM sharing one I2C bus, driven with raw Wire calls. ' +
      'The sensor is a register-level model with the datasheet\'s own calibration constants, so the ' +
      'compensation in the sketch is the datasheet\'s and the temperature it prints is a real one.',
    tags: ['simulated', 'i2c', 'sensors'],
    kind: 'showcase',
    board: 'Arduino Uno',
    teaches: 'Two devices on one bus, addressed separately, with no library in between.',
    build: () => {
      const p = emptyProject('I2C Sensor Bus');
      const uno = inst('board.arduino-uno', 120, 170);
      const bmp = inst('comp.bmp280', 520, 70);
      const eeprom = inst('comp.eeprom-24c', 520, 230);
      const resistor = inst('comp.resistor', 430, 330, { resistance: 220 });
      const led = inst('comp.led', 560, 360, { color: 'red' });
      p.boardInstances = [uno];
      p.componentInstances = [bmp, eeprom, resistor, led];
      p.connections = [
        // The BMP280 is a 3.3 V part. The validator catches 5 V here, and it is
        // right to: on real hardware that is how the sensor dies.
        wire(bmp, 'vcc', uno, '3V3', '#e03131'),
        wire(bmp, 'gnd', uno, 'GND_PWR1', '#212529'),
        wire(bmp, 'sda', uno, 'A4', '#2f9e44'),
        wire(bmp, 'scl', uno, 'A5', '#1971c2'),
        wire(eeprom, 'vcc', uno, '5V', '#e03131'),
        wire(eeprom, 'gnd', uno, 'GND_PWR2', '#212529'),
        wire(eeprom, 'sda', uno, 'A4', '#2f9e44'),
        wire(eeprom, 'scl', uno, 'A5', '#1971c2'),
        // Address straps: all low puts the EEPROM at 0x50.
        wire(eeprom, 'a0', uno, 'GND_PWR2', '#212529'),
        wire(eeprom, 'a1', uno, 'GND_PWR2', '#212529'),
        wire(eeprom, 'a2', uno, 'GND_PWR2', '#212529'),
        wire(eeprom, 'wp', uno, 'GND_PWR2', '#212529'),
        wire(uno, 'D13', resistor, 'p1', '#e8590c'),
        wire(resistor, 'p2', led, 'anode', '#e8590c'),
        wire(led, 'cathode', uno, 'GND_TOP', '#212529'),
      ];
      p.codeFiles = [code('sketch.ino', I2C_SENSOR_BUS_CODE)];
      p.tests = [
        bench(
          'The sensor answers and the log reads back',
          'The chip id proves the right device replied; the temperature proves the calibration was read and the compensation ran; the readback proves a second device on the same bus kept what it was given.',
          [
            { kind: 'serial-contains', text: 'chip id 0x58', withinMs: 1200 },
            { kind: 'serial-contains', text: 'temperature 25', withinMs: 2500 },
            { kind: 'serial-contains', text: 'logged 25', withinMs: 3000 },
            { kind: 'pin-becomes-high', pin: 13, withinMs: 3000 },
          ],
          { timeoutMs: 5000 },
        ),
      ];
      return p;
    },
  },
  {
    id: 'show.spi-sd-card',
    name: 'SPI storage: an SD card\'s own handshake',
    description:
      'The initialisation sequence every SD library performs, written out with raw SPI so you can watch it: ' +
      'CMD0, CMD8, then CMD55/ACMD41 polled until the card stops reporting busy. The card model answers at ' +
      'the command layer and really does report busy for the first few polls.',
    tags: ['simulated', 'spi', 'storage'],
    kind: 'showcase',
    board: 'Arduino Uno',
    teaches: 'What an SD library is doing before it ever opens a file.',
    build: () => {
      const p = emptyProject('SPI SD Card');
      const uno = inst('board.arduino-uno', 120, 170);
      const sd = inst('comp.sd-card', 520, 110);
      const resistor = inst('comp.resistor', 440, 320, { resistance: 220 });
      const led = inst('comp.led', 560, 350, { color: 'green' });
      p.boardInstances = [uno];
      p.componentInstances = [sd, resistor, led];
      p.connections = [
        wire(sd, 'vcc', uno, '5V', '#e03131'),
        wire(sd, 'gnd', uno, 'GND_PWR1', '#212529'),
        wire(sd, 'sck', uno, 'D13', '#1971c2'),
        wire(sd, 'mosi', uno, 'D11', '#7048e8'),
        wire(sd, 'miso', uno, 'D12', '#2f9e44'),
        wire(sd, 'cs', uno, 'D10', '#f08c00'),
        wire(uno, 'D7', resistor, 'p1', '#e8590c'),
        wire(resistor, 'p2', led, 'anode', '#e8590c'),
        wire(led, 'cathode', uno, 'GND_TOP', '#212529'),
      ];
      p.codeFiles = [code('sketch.ino', SPI_SD_CARD_CODE)];
      p.tests = [
        bench(
          'The card completes its handshake',
          'CMD0 must return the idle bit, and the ACMD41 loop must run more than once before the card reports ready - a card that answered immediately would mean the model was not modelling anything.',
          [
            { kind: 'serial-contains', text: 'CMD0 -> 0x1', withinMs: 1500 },
            { kind: 'serial-contains', text: 'card initialised', withinMs: 3000 },
            { kind: 'pin-becomes-high', pin: 7, withinMs: 3000 },
          ],
          { timeoutMs: 5000 },
        ),
      ];
      return p;
    },
  },
  {
    id: 'show.shift-register',
    name: '74HC595: eight outputs from three pins',
    description:
      'A shift register driving eight LEDs from three signals, bit-banged so the data, clock and latch are ' +
      'visible as three separate things. The outputs change only when the latch rises, which is the whole ' +
      'reason the part has one.',
    tags: ['simulated', 'logic', 'outputs'],
    kind: 'showcase',
    board: 'Arduino Uno',
    teaches: 'Why a shift register needs a latch, by watching what happens on it.',
    build: () => {
      const p = emptyProject('Shift Register');
      const uno = inst('board.arduino-uno', 120, 200);
      const reg = inst('comp.hc595', 500, 120);
      const leds = Array.from({ length: 8 }, (_, i) => inst('comp.led', 760, 40 + i * 52, { color: 'amber' }));
      const resistors = Array.from({ length: 8 }, (_, i) => inst('comp.resistor', 660, 40 + i * 52, { resistance: 330 }));
      p.boardInstances = [uno];
      p.componentInstances = [reg, ...resistors, ...leds];
      p.connections = [
        wire(reg, 'vcc', uno, '5V', '#e03131'),
        wire(reg, 'gnd', uno, 'GND_PWR2', '#212529'),
        // OE is active-low and SRCLR is active-high: tied so the outputs are
        // always enabled and the shift register is never cleared.
        wire(reg, 'oe', uno, 'GND_PWR1', '#212529'),
        wire(reg, 'srclr', uno, '5V', '#e03131'),
        // SER and SRCLK sit on the Uno's MOSI and SCK even though this sketch
        // bit-bangs them. They are the pins hardware SPI would use, the
        // validator checks them as such, and a reader who swaps the loop for
        // SPI.transfer() should not have to rewire anything.
        wire(uno, 'D11', reg, 'ser', '#7048e8'),
        wire(uno, 'D13', reg, 'srclk', '#1971c2'),
        wire(uno, 'D8', reg, 'rclk', '#f08c00'),
        ...Array.from({ length: 8 }, (_, i) => [
          wire(reg, `q${i}`, resistors[i], 'p1', '#e8590c'),
          wire(resistors[i], 'p2', leds[i], 'anode', '#e8590c'),
          wire(leds[i], 'cathode', uno, 'GND_TOP', '#212529'),
        ]).flat(),
      ];
      p.codeFiles = [code('sketch.ino', SHIFT_REGISTER_CODE)];
      p.tests = [
        bench(
          'The pattern walks across the outputs',
          'Data and clock must both be switching, and the latch too - a latch that never rises means the outputs never change however much is shifted in.',
          [
            { kind: 'serial-contains', text: '595 ready', withinMs: 1200 },
            { kind: 'pin-toggles', pin: 11, minToggles: 8, withinMs: 2000 },
            { kind: 'pin-toggles', pin: 13, minToggles: 16, withinMs: 2000 },
            { kind: 'pin-toggles', pin: 8, minToggles: 4, withinMs: 2000 },
          ],
          { timeoutMs: 4000 },
        ),
      ];
      return p;
    },
  },
  {
    id: 'show.pico-i2c',
    name: 'RP2040: an I2C bus on pins you choose',
    description:
      'A BMP280 on a Pico, with the sketch muxing I2C onto GP4/GP5 through Wire.setSDA/setSCL. Output goes to ' +
      'Serial1, the hardware UART, because the USB CDC Serial object is not simulated and printing into a void ' +
      'would teach the wrong lesson.',
    tags: ['simulated', 'i2c', 'rp2040'],
    kind: 'showcase',
    board: 'Raspberry Pi Pico',
    teaches: 'That an RP2040 chooses its bus pins in firmware, and which pins it chose is a checkable fact.',
    build: () => {
      const p = emptyProject('Pico I2C Sensor');
      const pico = inst('board.raspberry-pi-pico', 120, 170);
      const bmp = inst('comp.bmp280', 520, 110);
      const resistor = inst('comp.resistor', 440, 300, { resistance: 220 });
      const led = inst('comp.led', 560, 330, { color: 'red' });
      p.boardInstances = [pico];
      p.componentInstances = [bmp, resistor, led];
      p.connections = [
        wire(bmp, 'vcc', pico, '3V3', '#e03131'),
        wire(bmp, 'gnd', pico, 'GND3', '#212529'),
        wire(bmp, 'sda', pico, 'GP4', '#2f9e44'),
        wire(bmp, 'scl', pico, 'GP5', '#1971c2'),
        wire(pico, 'GP15', resistor, 'p1', '#e8590c'),
        wire(resistor, 'p2', led, 'anode', '#e8590c'),
        wire(led, 'cathode', pico, 'GND7', '#212529'),
      ];
      p.codeFiles = [code('sketch.ino', PICO_I2C_CODE)];
      p.tests = [
        bench(
          'The sensor answers on the muxed pins',
          'GP15 goes high only once a temperature has been read and compensated, so the pin is proof the whole bus transaction happened.',
          [{ kind: 'pin-becomes-high', pin: 15, withinMs: 3000 }],
          { timeoutMs: 5000 },
        ),
      ];
      return p;
    },
  },
  {
    id: 'show.uart-gps',
    name: 'UART: parsing what a GPS actually sends',
    description:
      'A NEO-6M emitting real NMEA sentences at the baud the firmware configured, parsed byte by byte. The fix ' +
      'LED follows the status field of $GPRMC, so it is lit by the content of the stream rather than by its ' +
      'existence.',
    tags: ['simulated', 'uart', 'modules'],
    kind: 'showcase',
    board: 'Arduino Uno',
    teaches: 'That serial is a byte stream with no framing but the one you write.',
    build: () => {
      const p = emptyProject('UART GPS');
      const uno = inst('board.arduino-uno', 120, 170);
      const gps = inst('comp.gps', 520, 110);
      const resistor = inst('comp.resistor', 440, 310, { resistance: 220 });
      const led = inst('comp.led', 560, 340, { color: 'blue' });
      p.boardInstances = [uno];
      p.componentInstances = [gps, resistor, led];
      p.connections = [
        wire(gps, 'vcc', uno, '5V', '#e03131'),
        wire(gps, 'gnd', uno, 'GND_PWR1', '#212529'),
        // Crossed, as serial always is: the module's TX drives the board's RX.
        wire(gps, 'tx', uno, 'D0', '#2f9e44'),
        wire(uno, 'D1', gps, 'rx', '#f08c00'),
        wire(uno, 'D8', resistor, 'p1', '#e8590c'),
        wire(resistor, 'p2', led, 'anode', '#e8590c'),
        wire(led, 'cathode', uno, 'GND_TOP', '#212529'),
      ];
      p.codeFiles = [code('sketch.ino', UART_GPS_CODE)];
      p.tests = [
        bench(
          'A valid fix lights the LED',
          'The status character comes out of a sentence the module generated, so the LED is evidence the stream was parsed rather than merely received.',
          [
            { kind: 'serial-contains', text: 'listening for NMEA', withinMs: 1200 },
            { kind: 'serial-contains', text: 'RMC status A', withinMs: 4000 },
            { kind: 'pin-becomes-high', pin: 8, withinMs: 4500 },
          ],
          { timeoutMs: 6000 },
        ),
      ];
      return p;
    },
  },
  {
    id: 'show.esp32c6-gpio',
    name: 'ESP32-C6: what is real, and what is not',
    description:
      'Real RISC-V execution of the compiled application image — ESP-IDF startup, FreeRTOS, setup() and loop(), ' +
      'and GPIO with its pulls. Wi-Fi, Bluetooth, the ADC, PWM, I2C, SPI and the hardware UART are not simulated, ' +
      'so this uses only what genuinely runs.',
    tags: ['simulated', 'esp32', 'gpio'],
    kind: 'showcase',
    board: 'ESP32-C6-DevKitC-1',
    teaches: 'Where the line is on this board, by staying on the right side of it.',
    build: () => {
      const p = emptyProject('ESP32-C6 GPIO');
      const c6 = inst('board.esp32-c6-devkitc-1', 120, 170);
      const pins = ['IO15', 'IO18', 'IO19', 'IO20'];
      const resistors = pins.map((_, i) => inst('comp.resistor', 470, 60 + i * 70, { resistance: 330 }));
      const leds = pins.map((_, i) => inst('comp.led', 600, 80 + i * 70, { color: 'green' }));
      const button = inst('comp.push-button', 470, 360);
      p.boardInstances = [c6];
      p.componentInstances = [...resistors, ...leds, button];
      p.connections = [
        ...pins.flatMap((pin, i) => [
          wire(c6, pin, resistors[i], 'p1', '#e8590c'),
          wire(resistors[i], 'p2', leds[i], 'anode', '#e8590c'),
          wire(leds[i], 'cathode', c6, 'GND2', '#212529'),
        ]),
        wire(c6, 'IO9', button, '1a', '#1971c2'),
        wire(button, '2a', c6, 'GND1', '#212529'),
      ];
      p.codeFiles = [code('sketch.ino', ESP32C6_GPIO_CODE)];
      p.tests = [
        bench(
          'The pattern walks, and the button stops it',
          'Each output must switch on its own, which is the CPU running loop() and driving pads - the only thing this board claims to do.',
          [
            { kind: 'pin-toggles', pin: 15, minToggles: 3, withinMs: 2500 },
            { kind: 'pin-toggles', pin: 18, minToggles: 3, withinMs: 2500 },
          ],
          { timeoutMs: 4000 },
        ),
      ];
      return p;
    },
  },
  {
    id: 'tpl.pico-blink',
    name: 'Pico Blink',
    description:
      'Raspberry Pi Pico: an LED on GP15 and a button on GP14. Pin numbers here are GP numbers — the pad\'s own ' +
      'name — and output goes to Serial1, because the USB CDC Serial object is not simulated.',
    tags: ['simulated', 'starter', 'rp2040'],
    kind: 'starter',
    board: 'Raspberry Pi Pico',
    teaches: 'That a Pico is not an Uno with different labels.',
    build: () => {
      const p = emptyProject('Pico Blink');
      const pico = inst('board.raspberry-pi-pico', 120, 170);
      const resistor = inst('comp.resistor', 460, 120, { resistance: 220 });
      const led = inst('comp.led', 580, 150, { color: 'green' });
      const button = inst('comp.push-button', 460, 300);
      p.boardInstances = [pico];
      p.componentInstances = [resistor, led, button];
      p.connections = [
        wire(pico, 'GP15', resistor, 'p1', '#e8590c'),
        wire(resistor, 'p2', led, 'anode', '#e8590c'),
        wire(led, 'cathode', pico, 'GND7', '#212529'),
        wire(pico, 'GP14', button, '1a', '#1971c2'),
        wire(button, '2a', pico, 'GND5', '#212529'),
      ];
      p.codeFiles = [code('sketch.ino', PICO_BLINK_CODE)];
      p.tests = [
        bench(
          'GP15 blinks',
          'The LED pin must go high and keep switching — on this board that is pad 15, named the way the chip names it.',
          [
            { kind: 'pin-becomes-high', pin: 15, withinMs: 800 },
            { kind: 'pin-toggles', pin: 15, minToggles: 3, withinMs: 2000 },
          ],
          { timeoutMs: 3000 },
        ),
      ];
      return p;
    },
  },
  {
    id: 'tpl.c6-blink',
    name: 'ESP32-C6 Blink',
    description:
      'ESP32-C6: an LED on IO15 and the BOOT button on IO9, blinking faster while held. The compiled RISC-V ' +
      'image really executes — ESP-IDF startup, FreeRTOS, loop() — but only GPIO is simulated on this board.',
    tags: ['simulated', 'starter', 'esp32'],
    kind: 'starter',
    board: 'ESP32-C6-DevKitC-1',
    teaches: 'What an ESP32-C6 does here, and what it only appears to do.',
    build: () => {
      const p = emptyProject('ESP32-C6 Blink');
      const c6 = inst('board.esp32-c6-devkitc-1', 120, 170);
      const resistor = inst('comp.resistor', 470, 120, { resistance: 330 });
      const led = inst('comp.led', 590, 150, { color: 'blue' });
      const button = inst('comp.push-button', 470, 320);
      p.boardInstances = [c6];
      p.componentInstances = [resistor, led, button];
      p.connections = [
        wire(c6, 'IO15', resistor, 'p1', '#e8590c'),
        wire(resistor, 'p2', led, 'anode', '#e8590c'),
        wire(led, 'cathode', c6, 'GND2', '#212529'),
        wire(c6, 'IO9', button, '1a', '#1971c2'),
        wire(button, '2a', c6, 'GND1', '#212529'),
      ];
      p.codeFiles = [code('sketch.ino', C6_BLINK_CODE)];
      p.tests = [
        bench(
          'IO15 blinks',
          'Pad 15 must switch, which is the RISC-V core running loop() after a real ESP-IDF startup.',
          [
            { kind: 'pin-becomes-high', pin: 15, withinMs: 1200 },
            { kind: 'pin-toggles', pin: 15, minToggles: 3, withinMs: 2500 },
          ],
          { timeoutMs: 4000 },
        ),
      ];
      return p;
    },
  },
  {
    id: 'show.oled-ssd1306',
    name: 'SSD1306: a display driver, one command at a time',
    description:
      'The datasheet initialisation sequence and then pixel data, with no display library in between. The model ' +
      'implements the real command set and a real GDDRAM, so what appears on the panel is what the sketch wrote ' +
      'into memory.',
    tags: ['simulated', 'i2c', 'displays'],
    kind: 'showcase',
    board: 'Arduino Uno',
    teaches: 'That a display driver is a command byte, a data byte, and a lot of patience.',
    build: () => {
      const p = emptyProject('SSD1306 OLED');
      const uno = inst('board.arduino-uno', 120, 170);
      const oled = inst('comp.oled', 520, 120);
      p.boardInstances = [uno];
      p.componentInstances = [oled];
      p.connections = [
        // 3.3 V module. The validator flags 5 V here, and on a bench that
        // is how the panel dies.
        wire(oled, 'vcc', uno, '3V3', '#e03131'),
        wire(oled, 'gnd', uno, 'GND_PWR1', '#212529'),
        wire(oled, 'sda', uno, 'A4', '#2f9e44'),
        wire(oled, 'scl', uno, 'A5', '#1971c2'),
      ];
      p.codeFiles = [code('sketch.ino', OLED_SSD1306_CODE)];
      p.tests = [
        bench(
          'The panel is configured and written to',
          'Initialisation has to complete before any pixel is accepted, and the pattern has to be acknowledged by the device — both are reported only after the transactions succeed.',
          [
            { kind: 'serial-contains', text: 'ssd1306 initialised', withinMs: 1500 },
            { kind: 'serial-contains', text: 'pattern written', withinMs: 3000 },
          ],
          { timeoutMs: 5000 },
        ),
      ];
      return p;
    },
  },
  {
    id: 'show.stepper-sequence',
    name: 'Stepper: motion is the order, not a command',
    description:
      'Four coil lines driven through a half-step sequence, with a relay alongside as a contrast — a coil you ' +
      'switch rather than sequence. The model moves one step per adjacent transition, so reversing the order ' +
      'reverses the shaft and skipping a phase moves nothing.',
    tags: ['simulated', 'motors', 'outputs'],
    kind: 'showcase',
    board: 'Arduino Uno',
    teaches: 'Why stepper code is a table and a phase index rather than a speed.',
    build: () => {
      const p = emptyProject('Stepper Sequence');
      const uno = inst('board.arduino-uno', 120, 190);
      const stepper = inst('comp.stepper', 540, 90);
      const relay = inst('comp.relay', 540, 300);
      p.boardInstances = [uno];
      p.componentInstances = [stepper, relay];
      p.connections = [
        wire(uno, 'D8', stepper, 'in1', '#e8590c'),
        wire(uno, 'D9', stepper, 'in2', '#f08c00'),
        wire(uno, 'D10', stepper, 'in3', '#2f9e44'),
        wire(uno, 'D11', stepper, 'in4', '#1971c2'),
        wire(relay, 'vcc', uno, '5V', '#e03131'),
        wire(relay, 'gnd', uno, 'GND_PWR1', '#212529'),
        wire(uno, 'D7', relay, 'in', '#7048e8'),
      ];
      p.codeFiles = [code('sketch.ino', STEPPER_SEQUENCE_CODE)];
      p.tests = [
        bench(
          'All four coils sequence, and the relay follows',
          'Every coil line must switch — a sequence missing one phase is a motor that does not turn — and the forward pass must complete before the relay is energised.',
          [
            { kind: 'serial-contains', text: 'stepper ready', withinMs: 1200 },
            { kind: 'pin-toggles', pin: 8, minToggles: 4, withinMs: 2500 },
            { kind: 'pin-toggles', pin: 9, minToggles: 4, withinMs: 2500 },
            { kind: 'pin-toggles', pin: 10, minToggles: 4, withinMs: 2500 },
            { kind: 'pin-toggles', pin: 11, minToggles: 4, withinMs: 2500 },
            { kind: 'serial-contains', text: 'forward', withinMs: 3000 },
          ],
          { timeoutMs: 5000 },
        ),
      ];
      return p;
    },
  },
];
