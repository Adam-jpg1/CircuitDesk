// Wire and SPI on the SAMD21 boards reach the parts wired to them.
//
// They used to hang: the SERCOM model answered a USART and nothing else, so
// Wire.endTransmission() waited forever for a flag and SPI.transfer() for a
// byte, and any sketch with an I2C display or sensor froze in setup(). Now a
// SERCOM in I2C master mode runs Wire's transactions on the shared I2C bus,
// one in SPI master mode exchanges bytes on the SPI bus, and the bus pins are
// the ones the PORT multiplexer gave them.
//
// Through the live simulation, on each board, from compiled firmware:
//   * a BMP280 on SDA/SCL answers its chip-ID register (0x58);
//   * an address nobody answers NACKs — endTransmission() returns 2;
//   * an SPI flash on SCK/MOSI/MISO with CS on a GPIO returns its JEDEC ID.

import { simulationController } from '../src/simulation/simulationController';
import { useSimulationStore } from '../src/simulation/simulationStore';
import { emptyProject, inst, wire, code } from '../src/project/templates';

let failures = 0;
let skipped = 0;
function check(cond: boolean, msg: string) {
  console.log(cond ? 'PASS:' : 'FAIL:', msg);
  if (!cond) failures++;
}

const boards = [
  { id: 'board.adafruit-feather', gnd: 'GND1', csPin: 'D10', cs: '10', sck: 'SCK', mosi: 'MOSI', miso: 'MISO' },
  { id: 'board.adafruit-qtpy', gnd: 'GND', csPin: 'A3', cs: 'A3', sck: 'SCK', mosi: 'MOSI', miso: 'MISO' },
  // The XIAO prints its SPI pins A8/SCK, A9/MISO and A10/MOSI.
  { id: 'board.seeed-xiao', gnd: 'GND', csPin: 'A3', cs: 'A3', sck: 'A8', mosi: 'A10', miso: 'A9' },
] as const;

for (const b of boards) {
  console.log(`\n--- ${b.id}`);
  const p = emptyProject(`buses ${b.id}`);
  const board = inst(b.id, 0, 0);
  const bmp = inst('comp.bmp280', 400, 40);
  const flash = inst('comp.spi-flash', 400, 200);
  p.boardInstances = [board];
  p.componentInstances = [bmp, flash];
  p.connections = [
    wire(bmp, 'sda', board, 'SDA'), wire(bmp, 'scl', board, 'SCL'),
    wire(bmp, 'vcc', board, '3V3'), wire(bmp, 'gnd', board, b.gnd),
    wire(flash, 'sck', board, b.sck), wire(flash, 'mosi', board, b.mosi), wire(flash, 'miso', board, b.miso),
    wire(flash, 'cs', board, b.csPin), wire(flash, 'vcc', board, '3V3'), wire(flash, 'gnd', board, b.gnd),
  ];
  p.codeFiles = [code('sketch.ino', `#include <Wire.h>
#include <SPI.h>
const int CS = ${b.cs};
uint8_t reg(uint8_t addr, uint8_t r) {
  Wire.beginTransmission(addr);
  Wire.write(r);
  if (Wire.endTransmission(false) != 0) return 0xEE;
  Wire.requestFrom(addr, (uint8_t)1);
  return Wire.available() ? Wire.read() : 0xEF;
}
void setup() {
  Serial.begin(115200);
  while (!Serial && millis() < 2000) delay(10);
  Wire.begin();
  Serial.print("ID "); Serial.println(reg(0x76, 0xD0), HEX);
  Wire.beginTransmission(0x50);
  Serial.print("NOBODY "); Serial.println(Wire.endTransmission());
  pinMode(CS, OUTPUT);
  digitalWrite(CS, HIGH);
  SPI.begin();
  SPI.beginTransaction(SPISettings(1000000, MSBFIRST, SPI_MODE0));
  digitalWrite(CS, LOW);
  SPI.transfer(0x9F);
  uint8_t a = SPI.transfer(0), m = SPI.transfer(0), c = SPI.transfer(0);
  digitalWrite(CS, HIGH);
  Serial.print("JEDEC "); Serial.print(a, HEX); Serial.print(' '); Serial.print(m, HEX); Serial.print(' '); Serial.println(c, HEX);
}
void loop() {}
`)];
  simulationController.stop();
  const report = await simulationController.build(p);
  if (!report.anyRunnable || !(await simulationController.start())) {
    console.log(`SKIP: ${b.id} did not build or start here (${report.builds.map((x) => x.detail).join('; ')})`);
    skipped++;
    continue;
  }
  simulationController.pause();
  for (let t = 0; t < 1500 && simulationController.advance(50); t += 50);
  simulationController.publishNow();
  const state = useSimulationStore.getState();
  const text = state.serialText ?? '';
  check(state.status !== 'error', `the sketch runs (${state.error ?? 'no error'})`);
  check(/ID 58/.test(text), `a BMP280 on SDA/SCL answers its chip ID (${text.match(/ID \w+/)?.[0] ?? 'nothing'})`);
  check(/NOBODY 2/.test(text), `an address nobody answers NACKs (${text.match(/NOBODY \d+/)?.[0] ?? 'nothing'})`);
  check(/JEDEC EF 40 14/.test(text), `an SPI flash on SCK/MOSI/MISO returns its JEDEC ID (${text.match(/JEDEC[ \w]*/)?.[0] ?? 'nothing'})`);
  simulationController.stop();
}

console.log(`\n--- ${failures} failing, ${skipped} skipped`);
process.exit(failures ? 1 : 0);
