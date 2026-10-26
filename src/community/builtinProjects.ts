// The projects the community page ships with.
//
// Six are posted as Anonymous and three under the site creator's name. Every one
// is a real, wired, validated project with a sketch that compiles and a test
// bench that passes on the emulator (tests/community.builtin.mts), because "open
// a copy" on a project that does not work would be the first thing a new user
// learns about the community.
//
// tools/community/buildBuiltins.mts turns these into server/community/builtin.json.

import { bench, code, emptyProject, inst, wire } from '../project/templates';
import type { CircuitProject } from '../types';

export interface BuiltinProject {
  id: string;
  title: string;
  description: string;
  /** "Anonymous", or the creator. */
  author: 'anonymous' | 'creator';
  tags: string[];
  baseLikes: number;
  createdAt: string;
  build: () => CircuitProject;
}

const RED = '#e03131';
const BLACK = '#212529';
const SIGNAL = '#1971c2';
const ORANGE = '#e8590c';
const GREEN = '#2f9e44';

export const BUILTIN_PROJECTS: BuiltinProject[] = [
  {
    id: 'cp_night_light',
    title: 'Automatic night light',
    description:
      'A light-dependent resistor watches the room and a lamp comes on when it gets dark. Drag the LDR\'s light ' +
      'level down in the inspector and watch it switch. The threshold is one number at the top of the sketch.',
    author: 'anonymous',
    tags: ['ldr', 'beginner', 'sensors'],
    baseLikes: 12,
    createdAt: '2026-09-14T18:22:00.000Z',
    build: () => {
      const p = emptyProject('Automatic night light');
      const uno = inst('board.arduino-uno', 120, 170);
      const ldr = inst('comp.ldr', 500, 90);
      const pulldown = inst('comp.resistor', 500, 200, { resistance: 10000 });
      const r = inst('comp.resistor', 470, 300, { resistance: 220 });
      const lamp = inst('comp.led', 590, 330, { color: 'yellow' });
      p.boardInstances = [uno];
      p.componentInstances = [ldr, pulldown, r, lamp];
      p.connections = [
        wire(ldr, 'p1', uno, '5V', RED),
        wire(ldr, 'p2', uno, 'A0', SIGNAL),
        wire(pulldown, 'p1', uno, 'A0', SIGNAL),
        wire(pulldown, 'p2', uno, 'GND_PWR1', BLACK),
        wire(uno, 'D9', r, 'p1', ORANGE),
        wire(r, 'p2', lamp, 'anode', ORANGE),
        wire(lamp, 'cathode', uno, 'GND_TOP', BLACK),
      ];
      p.codeFiles = [code('sketch.ino', `// Automatic night light: the lamp comes on when the room gets dark.
const int LDR = A0, LAMP = 9;
const int DARK = 300;   // readings below this count as night

void setup() {
  pinMode(LAMP, OUTPUT);
  Serial.begin(9600);
}

void loop() {
  int light = analogRead(LDR);
  bool night = light < DARK;
  digitalWrite(LAMP, night ? HIGH : LOW);
  Serial.print("light ");
  Serial.print(light);
  Serial.println(night ? "  -> lamp ON" : "  -> lamp off");
  delay(200);
}
`)];
      p.tests = [
        bench('The lamp follows the dark', 'Daylight leaves it off; dimming the LDR turns it on.', [
          { kind: 'pin-low', pin: 9, atMs: 400 },
          { kind: 'pin-becomes-high', pin: 9, withinMs: 1600 },
          { kind: 'serial-contains', text: 'lamp ON', withinMs: 1600 },
        ], { events: [{ atMs: 600, action: 'set-value', componentId: ldr.id, value: 0.1 }] }),
      ];
      return p;
    },
  },
  {
    id: 'cp_plant_alarm',
    title: 'Plant thirst alarm',
    description:
      'A soil probe in the pot and a buzzer that chirps when it dries out. These probes read HIGH when dry, ' +
      'which catches everyone out once — set the moisture low in the inspector to hear it.',
    author: 'anonymous',
    tags: ['plants', 'sensors', 'buzzer'],
    baseLikes: 31,
    createdAt: '2026-09-21T09:05:00.000Z',
    build: () => {
      const p = emptyProject('Plant thirst alarm');
      const uno = inst('board.arduino-uno', 120, 170);
      const probe = inst('comp.soil-moisture', 500, 90);
      const buzzer = inst('comp.buzzer', 520, 280);
      p.boardInstances = [uno];
      p.componentInstances = [probe, buzzer];
      p.connections = [
        wire(probe, 'vcc', uno, '5V', RED),
        wire(probe, 'gnd', uno, 'GND_PWR1', BLACK),
        wire(probe, 'vout', uno, 'A0', SIGNAL),
        wire(uno, 'D8', buzzer, 'plus', ORANGE),
        wire(buzzer, 'minus', uno, 'GND_TOP', BLACK),
      ];
      p.codeFiles = [code('sketch.ino', `// Plant thirst alarm. Capacitive probes read HIGH when the soil is dry.
const int PROBE = A0, BUZZER = 8;
const int DRY = 800;

void setup() {
  pinMode(BUZZER, OUTPUT);
  Serial.begin(9600);
}

void loop() {
  int reading = analogRead(PROBE);
  bool thirsty = reading > DRY;
  Serial.print("soil ");
  Serial.print(reading);
  Serial.println(thirsty ? "  thirsty!" : "  ok");
  if (thirsty) {
    for (int i = 0; i < 3; i++) {   // three short chirps
      digitalWrite(BUZZER, HIGH); delay(60);
      digitalWrite(BUZZER, LOW);  delay(60);
    }
  }
  delay(400);
}
`)];
      p.tests = [
        bench('It chirps only when dry', 'Damp soil is quiet; dry soil chirps and says so.', [
          { kind: 'pin-low', pin: 8, atMs: 450 },
          { kind: 'pin-toggles', pin: 8, minToggles: 4, withinMs: 2500 },
          { kind: 'serial-contains', text: 'thirsty!', withinMs: 2500 },
        ], { events: [{ atMs: 600, action: 'set-value', componentId: probe.id, value: 5 }] }),
      ];
      return p;
    },
  },
  {
    id: 'cp_reaction_timer',
    title: 'Reaction timer',
    description:
      'The LED lights, you hit the button, the sketch tells you how long you took. millis() and a busy-wait — ' +
      'about the smallest game there is. Press the button on the canvas when the LED comes on.',
    author: 'anonymous',
    tags: ['game', 'button', 'beginner'],
    baseLikes: 18,
    createdAt: '2026-09-29T20:41:00.000Z',
    build: () => {
      const p = emptyProject('Reaction timer');
      const uno = inst('board.arduino-uno', 120, 170);
      const button = inst('comp.push-button', 480, 90);
      const r = inst('comp.resistor', 470, 230, { resistance: 220 });
      const led = inst('comp.led', 590, 260, { color: 'green' });
      p.boardInstances = [uno];
      p.componentInstances = [button, r, led];
      p.connections = [
        wire(uno, 'D2', button, '1a', SIGNAL),
        wire(button, '2a', uno, 'GND_PWR1', BLACK),
        wire(uno, 'D13', r, 'p1', ORANGE),
        wire(r, 'p2', led, 'anode', ORANGE),
        wire(led, 'cathode', uno, 'GND_TOP', BLACK),
      ];
      p.codeFiles = [code('sketch.ino', `// Reaction timer: press the button as soon as the LED lights.
const int BUTTON = 2, LED = 13;

void setup() {
  pinMode(BUTTON, INPUT_PULLUP);
  pinMode(LED, OUTPUT);
  Serial.begin(9600);
  Serial.println("Get ready...");
}

void loop() {
  delay(1000);
  digitalWrite(LED, HIGH);
  unsigned long start = millis();
  while (digitalRead(BUTTON) == HIGH) {}      // wait for the press
  unsigned long took = millis() - start;
  digitalWrite(LED, LOW);
  Serial.print("Reaction: ");
  Serial.print(took);
  Serial.println(" ms");
  while (digitalRead(BUTTON) == LOW) {}       // and for the release
  Serial.println("Again...");
}
`)];
      p.tests = [
        bench('A press is timed', 'The LED lights after a second, and a press is reported in milliseconds.', [
          { kind: 'pin-becomes-high', pin: 13, withinMs: 1300 },
          { kind: 'serial-contains', text: 'Reaction: ', withinMs: 2200 },
        ], {
          events: [
            { atMs: 1400, action: 'press', componentId: button.id },
            { atMs: 1550, action: 'release', componentId: button.id },
          ],
        }),
      ];
      return p;
    },
  },
  {
    id: 'cp_fever_check',
    title: 'Fever check thermometer',
    description:
      'An LM35 and two LEDs: green under 37.5 °C, red at or above. The conversion is the LM35\'s 10 mV per degree ' +
      'and nothing else. Set the temperature in the inspector — try 39.',
    author: 'anonymous',
    tags: ['temperature', 'lm35', 'health'],
    baseLikes: 24,
    createdAt: '2026-10-03T13:10:00.000Z',
    build: () => {
      const p = emptyProject('Fever check thermometer');
      const uno = inst('board.arduino-uno', 120, 170);
      const lm35 = inst('comp.lm35', 500, 80);
      const rg = inst('comp.resistor', 450, 230, { resistance: 220 });
      const green = inst('comp.led', 560, 250, { color: 'green' });
      const rr = inst('comp.resistor', 450, 320, { resistance: 220 });
      const red = inst('comp.led', 560, 340, { color: 'red' });
      p.boardInstances = [uno];
      p.componentInstances = [lm35, rg, green, rr, red];
      p.connections = [
        wire(lm35, 'vcc', uno, '5V', RED),
        wire(lm35, 'gnd', uno, 'GND_PWR1', BLACK),
        wire(lm35, 'vout', uno, 'A0', SIGNAL),
        wire(uno, 'D10', rg, 'p1', GREEN),
        wire(rg, 'p2', green, 'anode', GREEN),
        wire(green, 'cathode', uno, 'GND_TOP', BLACK),
        wire(uno, 'D11', rr, 'p1', ORANGE),
        wire(rr, 'p2', red, 'anode', ORANGE),
        wire(red, 'cathode', uno, 'GND_TOP', BLACK),
      ];
      p.codeFiles = [code('sketch.ino', `// Fever check: LM35 on A0, 10 mV per degree C.
const int SENSOR = A0, OK_LED = 10, FEVER_LED = 11;
const float FEVER_C = 37.5;

void setup() {
  pinMode(OK_LED, OUTPUT);
  pinMode(FEVER_LED, OUTPUT);
  Serial.begin(9600);
}

void loop() {
  float celsius = analogRead(SENSOR) * 500.0 / 1023.0;
  bool fever = celsius >= FEVER_C;
  digitalWrite(OK_LED, fever ? LOW : HIGH);
  digitalWrite(FEVER_LED, fever ? HIGH : LOW);
  Serial.print("Temperature: ");
  Serial.print(celsius, 1);
  Serial.println(fever ? " C  FEVER" : " C");
  delay(250);
}
`)];
      p.tests = [
        bench('Red means fever', 'Room temperature lights green; 39 °C lights red.', [
          { kind: 'pin-high', pin: 10, atMs: 400 },
          { kind: 'pin-becomes-high', pin: 11, withinMs: 1500 },
          { kind: 'serial-contains', text: 'FEVER', withinMs: 1500 },
        ], { events: [{ atMs: 600, action: 'set-value', componentId: lm35.id, value: 39 }] }),
      ];
      return p;
    },
  },
  {
    id: 'cp_porch_light',
    title: 'Motion-activated porch light',
    description:
      'A PIR sensor and a light that stays on for five seconds after the last movement, timed with millis() so ' +
      'the sketch never blocks. Tick "Motion detected" in the inspector to walk past it.',
    author: 'anonymous',
    tags: ['pir', 'home', 'sensors'],
    baseLikes: 9,
    createdAt: '2026-10-09T07:55:00.000Z',
    build: () => {
      const p = emptyProject('Motion-activated porch light');
      const uno = inst('board.arduino-uno', 120, 170);
      const pir = inst('comp.pir', 500, 80);
      const r = inst('comp.resistor', 460, 250, { resistance: 220 });
      const lamp = inst('comp.led', 580, 280, { color: 'white' });
      p.boardInstances = [uno];
      p.componentInstances = [pir, r, lamp];
      p.connections = [
        wire(pir, 'vcc', uno, '5V', RED),
        wire(pir, 'gnd', uno, 'GND_PWR1', BLACK),
        wire(pir, 'out', uno, 'D2', SIGNAL),
        wire(uno, 'D7', r, 'p1', ORANGE),
        wire(r, 'p2', lamp, 'anode', ORANGE),
        wire(lamp, 'cathode', uno, 'GND_TOP', BLACK),
      ];
      p.codeFiles = [code('sketch.ino', `// Porch light: on for 5 s after the last motion, without blocking.
const int PIR = 2, LAMP = 7;
const unsigned long STAY_ON_MS = 5000;
unsigned long lastMotion = 0;
bool lit = false;

void setup() {
  pinMode(PIR, INPUT);
  pinMode(LAMP, OUTPUT);
  Serial.begin(9600);
}

void loop() {
  if (digitalRead(PIR) == HIGH) {
    if (!lit) Serial.println("motion - lamp on");
    lastMotion = millis();
    lit = true;
  }
  if (lit && millis() - lastMotion > STAY_ON_MS) {
    lit = false;
    Serial.println("quiet - lamp off");
  }
  digitalWrite(LAMP, lit ? HIGH : LOW);
}
`)];
      p.tests = [
        bench('Motion turns the lamp on', 'Dark until something moves.', [
          { kind: 'pin-low', pin: 7, atMs: 400 },
          { kind: 'pin-becomes-high', pin: 7, withinMs: 1200 },
          { kind: 'serial-contains', text: 'lamp on', withinMs: 1200 },
        ], {
          events: [
            { atMs: 600, action: 'set-value', componentId: pir.id, value: 1 },
            { atMs: 800, action: 'set-value', componentId: pir.id, value: 0 },
          ],
        }),
      ];
      return p;
    },
  },
  {
    id: 'cp_parking_beeper',
    title: 'Parking distance beeper',
    description:
      'An HC-SR04 on the garage wall: the closer the car, the faster it beeps, solid under 15 cm. Distance comes ' +
      'from timing the echo pulse, exactly as on the bench. Drag the distance slider to park.',
    author: 'anonymous',
    tags: ['ultrasonic', 'car', 'buzzer'],
    baseLikes: 7,
    createdAt: '2026-10-17T16:30:00.000Z',
    build: () => {
      const p = emptyProject('Parking distance beeper');
      const uno = inst('board.arduino-uno', 120, 170);
      const sonar = inst('comp.ultrasonic', 480, 80);
      const buzzer = inst('comp.buzzer', 520, 280);
      p.boardInstances = [uno];
      p.componentInstances = [sonar, buzzer];
      p.connections = [
        wire(sonar, 'vcc', uno, '5V', RED),
        wire(sonar, 'gnd', uno, 'GND_PWR1', BLACK),
        wire(sonar, 'trig', uno, 'D7', '#7048e8'),
        wire(sonar, 'echo', uno, 'D8', SIGNAL),
        wire(uno, 'D9', buzzer, 'plus', ORANGE),
        wire(buzzer, 'minus', uno, 'GND_TOP', BLACK),
      ];
      p.codeFiles = [code('sketch.ino', `// Parking beeper: beeps faster as the distance shrinks.
const int TRIG = 7, ECHO = 8, BUZZER = 9;

long distanceCm() {
  digitalWrite(TRIG, LOW);  delayMicroseconds(2);
  digitalWrite(TRIG, HIGH); delayMicroseconds(10);
  digitalWrite(TRIG, LOW);
  long us = pulseIn(ECHO, HIGH, 30000);
  return us / 58;
}

void setup() {
  pinMode(TRIG, OUTPUT);
  pinMode(ECHO, INPUT);
  pinMode(BUZZER, OUTPUT);
  Serial.begin(9600);
}

void loop() {
  long cm = distanceCm();
  Serial.print("Distance: ");
  Serial.print(cm);
  Serial.println(" cm");
  if (cm > 0 && cm < 15) {
    digitalWrite(BUZZER, HIGH);          // stop!
    delay(100);
  } else if (cm > 0 && cm < 100) {
    digitalWrite(BUZZER, HIGH); delay(40);
    digitalWrite(BUZZER, LOW);  delay(cm * 4);
  } else {
    digitalWrite(BUZZER, LOW);
    delay(100);
  }
}
`)];
      p.tests = [
        bench('Close means beeping', 'At 40 cm it beeps; the distance is reported.', [
          { kind: 'serial-contains', text: 'Distance: ', withinMs: 800 },
          { kind: 'pin-toggles', pin: 9, minToggles: 4, withinMs: 2500 },
        ], { events: [{ atMs: 0, action: 'set-value', componentId: sonar.id, value: 40 }] }),
      ];
      return p;
    },
  },

  // ------------------------------------------------------------ creator
  {
    id: 'cp_desk_climate',
    title: 'Desk climate monitor',
    description:
      'A BMP280 read with raw Wire calls and the datasheet\'s own compensation, no library, and three LEDs for ' +
      'too cold, comfortable and too warm. Set the sensor\'s temperature in the inspector and the right LED ' +
      'lights. A good first look at what a sensor library is doing for you.',
    author: 'creator',
    tags: ['i2c', 'bmp280', 'weather'],
    baseLikes: 42,
    createdAt: '2026-09-08T11:00:00.000Z',
    build: () => {
      const p = emptyProject('Desk climate monitor');
      const uno = inst('board.arduino-uno', 120, 170);
      const bmp = inst('comp.bmp280', 520, 60);
      const leds = [
        { pin: 'D9', color: 'blue', y: 200 },
        { pin: 'D10', color: 'green', y: 280 },
        { pin: 'D11', color: 'red', y: 360 },
      ].map((l) => ({ ...l, r: inst('comp.resistor', 450, l.y, { resistance: 220 }), led: inst('comp.led', 570, l.y + 20, { color: l.color }) }));
      p.boardInstances = [uno];
      p.componentInstances = [bmp, ...leds.flatMap((l) => [l.r, l.led])];
      p.connections = [
        // A 3.3 V part: on 5 V the real sensor dies, and the validator says so.
        wire(bmp, 'vcc', uno, '3V3', RED),
        wire(bmp, 'gnd', uno, 'GND_PWR1', BLACK),
        wire(bmp, 'sda', uno, 'A4', GREEN),
        wire(bmp, 'scl', uno, 'A5', SIGNAL),
        ...leds.flatMap((l) => [
          wire(uno, l.pin, l.r, 'p1', ORANGE),
          wire(l.r, 'p2', l.led, 'anode', ORANGE),
          wire(l.led, 'cathode', uno, 'GND_TOP', BLACK),
        ]),
      ];
      p.codeFiles = [code('sketch.ino', `// Desk climate monitor - BMP280 over raw I2C, datasheet compensation.
#include <Wire.h>

const uint8_t BMP280 = 0x76;
const int COLD_LED = 9, OK_LED = 10, WARM_LED = 11;
const float COLD_C = 18.0, WARM_C = 26.0;
uint16_t dig_T1; int16_t dig_T2, dig_T3;

uint16_t read16LE(uint8_t reg) {
  Wire.beginTransmission(BMP280); Wire.write(reg); Wire.endTransmission();
  Wire.requestFrom((int)BMP280, 2);
  uint16_t lo = Wire.read(), hi = Wire.read();
  return (hi << 8) | lo;
}

float readCelsius() {
  Wire.beginTransmission(BMP280); Wire.write(0xFA); Wire.endTransmission();
  Wire.requestFrom((int)BMP280, 3);
  int32_t adc = ((int32_t)Wire.read() << 12) | ((int32_t)Wire.read() << 4) | (Wire.read() >> 4);
  int32_t v1 = ((((adc >> 3) - ((int32_t)dig_T1 << 1))) * (int32_t)dig_T2) >> 11;
  int32_t v2 = (((((adc >> 4) - (int32_t)dig_T1) * ((adc >> 4) - (int32_t)dig_T1)) >> 12) * (int32_t)dig_T3) >> 14;
  return ((v1 + v2) * 5 + 128 >> 8) / 100.0;
}

void setup() {
  pinMode(COLD_LED, OUTPUT); pinMode(OK_LED, OUTPUT); pinMode(WARM_LED, OUTPUT);
  Serial.begin(9600);
  Wire.begin();
  dig_T1 = read16LE(0x88);
  dig_T2 = (int16_t)read16LE(0x8A);
  dig_T3 = (int16_t)read16LE(0x8C);
  Wire.beginTransmission(BMP280); Wire.write(0xF4); Wire.write(0x27); Wire.endTransmission();
}

void loop() {
  float c = readCelsius();
  digitalWrite(COLD_LED, c < COLD_C ? HIGH : LOW);
  digitalWrite(OK_LED, c >= COLD_C && c <= WARM_C ? HIGH : LOW);
  digitalWrite(WARM_LED, c > WARM_C ? HIGH : LOW);
  Serial.print(c, 1);
  Serial.println(c < COLD_C ? " C  too cold" : c > WARM_C ? " C  too warm" : " C  comfortable");
  delay(300);
}
`)];
      p.tests = [
        bench('Comfortable, then too warm', 'The default 25 °C is comfortable; 30 °C lights the warm LED.', [
          { kind: 'pin-high', pin: 10, atMs: 500 },
          { kind: 'pin-becomes-high', pin: 11, withinMs: 2000 },
          { kind: 'serial-contains', text: '30.0 C  too warm', withinMs: 2000 },
        ], { events: [{ atMs: 700, action: 'set-value', componentId: `${bmp.id}#temperature`, value: 30 }] }),
      ];
      return p;
    },
  },
  {
    id: 'cp_bubble_level',
    title: 'Five-LED bubble level',
    description:
      'An MPU6050 as a spirit level: pitch from the accelerometer with the usual atan2, shown as a "bubble" ' +
      'that slides along five LEDs. Tilt it with the Pitch slider in the inspector. Raw registers, no library — ' +
      'waking the chip is one write to 0x6B.',
    author: 'creator',
    tags: ['mpu6050', 'i2c', 'tilt'],
    baseLikes: 57,
    createdAt: '2026-09-26T15:30:00.000Z',
    build: () => {
      const p = emptyProject('Five-LED bubble level');
      const uno = inst('board.arduino-uno', 120, 170);
      const mpu = inst('comp.mpu6050', 520, 50);
      const pins = ['D3', 'D4', 'D5', 'D6', 'D7'];
      const colors = ['red', 'yellow', 'green', 'yellow', 'red'];
      const leds = pins.map((pin, i) => ({
        pin,
        r: inst('comp.resistor', 440, 190 + i * 70, { resistance: 220 }),
        led: inst('comp.led', 560, 210 + i * 70, { color: colors[i] }),
      }));
      p.boardInstances = [uno];
      p.componentInstances = [mpu, ...leds.flatMap((l) => [l.r, l.led])];
      p.connections = [
        wire(mpu, 'vcc', uno, '3V3', RED),
        wire(mpu, 'gnd', uno, 'GND_PWR1', BLACK),
        wire(mpu, 'sda', uno, 'A4', GREEN),
        wire(mpu, 'scl', uno, 'A5', SIGNAL),
        ...leds.flatMap((l) => [
          wire(uno, l.pin, l.r, 'p1', ORANGE),
          wire(l.r, 'p2', l.led, 'anode', ORANGE),
          wire(l.led, 'cathode', uno, 'GND_TOP', BLACK),
        ]),
      ];
      p.codeFiles = [code('sketch.ino', `// Five-LED bubble level: MPU6050 pitch shown on D3..D7.
#include <Wire.h>

const uint8_t MPU = 0x68;
const int FIRST_LED = 3;

int16_t read16() { return (Wire.read() << 8) | Wire.read(); }

void setup() {
  for (int i = 0; i < 5; i++) pinMode(FIRST_LED + i, OUTPUT);
  Serial.begin(9600);
  Wire.begin();
  Wire.beginTransmission(MPU); Wire.write(0x6B); Wire.write(0); Wire.endTransmission();  // wake up
}

void loop() {
  Wire.beginTransmission(MPU); Wire.write(0x3B); Wire.endTransmission();
  Wire.requestFrom((int)MPU, 6);
  float ax = read16(), ay = read16(), az = read16();
  float pitch = atan2(-ax, sqrt(ay * ay + az * az)) * 57.29578;

  int bubble = pitch < -20 ? 0 : pitch < -5 ? 1 : pitch <= 5 ? 2 : pitch <= 20 ? 3 : 4;
  for (int i = 0; i < 5; i++) digitalWrite(FIRST_LED + i, i == bubble ? HIGH : LOW);
  Serial.print("pitch ");
  Serial.print(pitch, 1);
  Serial.println(bubble == 2 ? "  level" : "");
  delay(100);
}
`)];
      p.tests = [
        bench('Level, then tilted', 'Flat lights the middle LED; 30° forward slides the bubble to the end.', [
          { kind: 'pin-high', pin: 5, atMs: 400 },
          { kind: 'serial-contains', text: 'level', withinMs: 600 },
          { kind: 'pin-becomes-high', pin: 7, withinMs: 1500 },
        ], { events: [{ atMs: 700, action: 'set-value', componentId: `${mpu.id}#pitch`, value: 30 }] }),
      ];
      return p;
    },
  },
  {
    id: 'cp_pico_crossing',
    title: 'Pico pedestrian crossing',
    description:
      'Traffic lights on a Raspberry Pi Pico with a crossing button: green until someone presses, then amber, ' +
      'then red while it says WALK. A small state machine with no delay() in the button path, so a press is never ' +
      'missed. Output on Serial1, the UART the emulator runs.',
    author: 'creator',
    tags: ['pico', 'state-machine', 'traffic'],
    baseLikes: 35,
    createdAt: '2026-10-12T10:15:00.000Z',
    build: () => {
      const p = emptyProject('Pico pedestrian crossing');
      const pico = inst('board.raspberry-pi-pico', 120, 170);
      const lights = [
        { pin: 'GP13', color: 'red', y: 80 },
        { pin: 'GP14', color: 'yellow', y: 160 },
        { pin: 'GP15', color: 'green', y: 240 },
      ].map((l) => ({ ...l, r: inst('comp.resistor', 460, l.y, { resistance: 220 }), led: inst('comp.led', 580, l.y + 20, { color: l.color }) }));
      const button = inst('comp.push-button', 460, 340);
      p.boardInstances = [pico];
      p.componentInstances = [...lights.flatMap((l) => [l.r, l.led]), button];
      p.connections = [
        ...lights.flatMap((l) => [
          wire(pico, l.pin, l.r, 'p1', ORANGE),
          wire(l.r, 'p2', l.led, 'anode', ORANGE),
          wire(l.led, 'cathode', pico, 'GND4', BLACK),
        ]),
        wire(pico, 'GP16', button, '1a', SIGNAL),
        wire(button, '2a', pico, 'GND5', BLACK),
      ];
      p.codeFiles = [code('sketch.ino', `// Pedestrian crossing on a Pico. Serial1 is the UART the emulator runs.
const int RED = 13, AMBER = 14, GREEN = 15, BUTTON = 16;
enum State { GO, CHANGING, WALK };
State state = GO;
unsigned long since = 0;

void show(bool r, bool a, bool g) {
  digitalWrite(RED, r); digitalWrite(AMBER, a); digitalWrite(GREEN, g);
}

void setup() {
  pinMode(RED, OUTPUT); pinMode(AMBER, OUTPUT); pinMode(GREEN, OUTPUT);
  pinMode(BUTTON, INPUT_PULLUP);
  Serial1.begin(115200);
  show(false, false, true);
  Serial1.println("traffic: GO");
}

void loop() {
  unsigned long now = millis();
  if (state == GO && digitalRead(BUTTON) == LOW) {
    state = CHANGING; since = now;
    show(false, true, false);
    Serial1.println("button: changing");
  } else if (state == CHANGING && now - since > 800) {
    state = WALK; since = now;
    show(true, false, false);
    Serial1.println("WALK");
  } else if (state == WALK && now - since > 2000) {
    state = GO;
    show(false, false, true);
    Serial1.println("traffic: GO");
  }
}
`)];
      p.tests = [
        bench('A press stops the traffic', 'Green until the button, then amber, then red with WALK.', [
          { kind: 'pin-high', pin: 15, atMs: 400 },
          { kind: 'pin-becomes-high', pin: 14, withinMs: 1000 },
          { kind: 'pin-becomes-high', pin: 13, withinMs: 2000 },
          { kind: 'serial-contains', text: 'WALK', withinMs: 2000 },
        ], {
          events: [
            { atMs: 600, action: 'press', componentId: button.id },
            { atMs: 750, action: 'release', componentId: button.id },
          ],
        }),
      ];
      return p;
    },
  },
];
