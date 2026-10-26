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
  assertions: TestAssertion[],
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
  build: () => CircuitProject;
}

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

export const PROJECT_TEMPLATES: ProjectTemplate[] = [
  {
    id: 'tpl.blink',
    name: 'Arduino Blink',
    description: 'Uno D13 → 220 Ω resistor → LED → GND, with the classic Blink sketch. Fully simulated.',
    tags: ['simulated', 'starter'],
    build: () => buildBlinkProject(),
  },
  {
    id: 'tpl.button-led',
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
];
