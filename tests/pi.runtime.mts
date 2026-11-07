// The Raspberry Pi GPIO headers, through the path the app takes: a project
// with main.py, a "build" (a syntax check in the browser), and a run on the
// canvas — an LED, a button, a PWM-dimmed LED and the Serial Monitor.
//
// Nothing here needs the compiler service: a Python board is never compiled.

import { simulationController } from '../src/simulation/simulationController';
import { useSimulationStore } from '../src/simulation/simulationStore';
import { emptyProject, inst, wire } from '../src/project/templates';
import { getBoardDefinition } from '../src/boards/definitions';
import { filesForBoard, programFor } from '../src/project/sketches';
import type { CircuitProject, ComponentInstance } from '../src/types';

let failures = 0;
function check(cond: boolean, msg: string) {
  console.log(cond ? 'PASS:' : 'FAIL:', msg);
  if (!cond) failures++;
}
function section(t: string) {
  console.log(`\n--- ${t}`);
}

/** A project of one Pi header with an LED on GPIO17, a button on GPIO27 and an LED on GPIO18. */
function piProject(boardId: string, script: string) {
  let p: CircuitProject = emptyProject(`pi ${boardId}`);
  const board = inst(boardId, 0, 0);
  const r1 = inst('comp.resistor', 300, 40, { resistance: 220 });
  const led = inst('comp.led', 360, 40, { color: 'red' });
  const r2 = inst('comp.resistor', 300, 140, { resistance: 220 });
  const dim = inst('comp.led', 360, 140, { color: 'green' });
  const btn = inst('comp.push-button', 300, 240);
  p.boardInstances = [board];
  p.componentInstances = [r1, led, r2, dim, btn];
  p.connections = [
    wire(board, 'GPIO17', r1, 'p1'), wire(r1, 'p2', led, 'anode'), wire(led, 'cathode', board, 'GND1'),
    wire(board, 'GPIO18', r2, 'p1'), wire(r2, 'p2', dim, 'anode'), wire(dim, 'cathode', board, 'GND2'),
    wire(board, 'GPIO27', btn, '1a'), wire(btn, '2a', board, 'GND3'),
  ];
  const prog = programFor(p, 'py');
  p = prog.project;
  p.codeFiles = p.codeFiles.map((f) => (f.id === prog.sketchId ? { ...f, content: script } : f));
  p.boardInstances = [{ ...board, sketchId: prog.sketchId }];
  return { p, board: p.boardInstances[0], led, dim, btn };
}

const ledOn = (id: string) => useSimulationStore.getState().visuals[id]?.ledOn === true;
const serial = () => useSimulationStore.getState().serialText;

const GPIOZERO = `from gpiozero import LED, Button, PWMLED
from signal import pause

led = LED(17)
dim = PWMLED(18)
dim.value = 0.3
button = Button(27)
presses = 0

def pressed():
    global presses
    presses += 1
    print(f"pressed {presses}")

button.when_pressed = pressed
led.blink(on_time=0.2, off_time=0.2)
print("ready")
pause()
`;

for (const boardId of ['board.rpi-zero-gpio', 'board.rpi4-gpio']) {
  const def = getBoardDefinition(boardId)!;
  section(`${def.name}: gpiozero`);
  check(def.supportLevel === 'simulated' && def.simulation?.engine === 'python', `${def.name} is simulated by the Python engine`);
  const { p, board, led, dim, btn } = piProject(boardId, GPIOZERO);
  check(filesForBoard(p, board.id).map((f) => f.name).join(',') === 'main.py', 'the board builds main.py and nothing else');
  simulationController.stop();
  const report = await simulationController.build(p);
  check(report.builds[0]?.status === 'built', `main.py builds (${report.builds[0]?.detail})`);
  const started = await simulationController.start();
  check(started, 'and starts');
  if (!started) continue;
  simulationController.pause();
  const seen = new Set<boolean>();
  for (let t = 0; t < 1200; t += 50) {
    simulationController.advance(50);
    simulationController.publishNow();
    seen.add(ledOn(led.id));
  }
  check(seen.has(true) && seen.has(false), 'the LED on GPIO17 blinks on the canvas');
  check(serial().includes('ready'), `print() reaches the Serial Monitor (${JSON.stringify(serial().slice(-30))})`);
  const brightness = useSimulationStore.getState().visuals[dim.id]?.brightness;
  check(typeof brightness === 'number' && brightness > 0.15 && brightness < 0.45, `PWMLED(18).value = 0.3 dims the LED (${brightness?.toFixed?.(2)})`);
  for (let k = 0; k < 3; k++) {
    useSimulationStore.getState().pressButton(btn.id, true);
    simulationController.advance(100);
    useSimulationStore.getState().pressButton(btn.id, false);
    simulationController.advance(100);
  }
  simulationController.publishNow();
  check(/pressed 3/.test(serial()), `three button presses on GPIO27 call when_pressed three times (${JSON.stringify(serial().slice(-40))})`);
  simulationController.stop();
}

section('RPi.GPIO: BOARD numbering, PWM, edge detection and input()');
{
  const { p, led, dim, btn } = piProject(
    'board.rpi4-gpio',
    `import RPi.GPIO as GPIO
import time
GPIO.setmode(GPIO.BOARD)
GPIO.setup(11, GPIO.OUT)          # physical pin 11 is GPIO17
GPIO.setup(12, GPIO.OUT)          # pin 12 is GPIO18
GPIO.setup(13, GPIO.IN, pull_up_down=GPIO.PUD_UP)   # pin 13 is GPIO27
pwm = GPIO.PWM(12, 200)
pwm.start(75)
falls = 0
def on_fall(channel):
    global falls
    falls += 1
GPIO.add_event_detect(13, GPIO.FALLING, callback=on_fall, bouncetime=20)
name = input("name? ")
print("hello", name)
try:
    while True:
        GPIO.output(11, not GPIO.input(13))
        time.sleep(0.01)
        if falls >= 2:
            print("two falls")
            break
finally:
    GPIO.cleanup()
`,
  );
  simulationController.stop();
  await simulationController.build(p);
  const started = await simulationController.start();
  check(started, 'the RPi.GPIO script starts');
  if (started) {
    simulationController.pause();
    simulationController.advance(200);
    simulationController.publishNow();
    const b = useSimulationStore.getState().visuals[dim.id]?.brightness;
    check(typeof b === 'number' && b > 0.6 && b < 0.9, `GPIO.PWM at 75% duty dims the LED on pin 12 (${b?.toFixed?.(2)})`);
    check(serial().includes('name? '), 'input() prompts on the Serial Monitor');
    simulationController.sendSerial('Ada\n');
    simulationController.advance(100);
    simulationController.publishNow();
    check(serial().includes('hello Ada'), `and reads the line typed there (${JSON.stringify(serial().slice(-20))})`);
    check(!ledOn(led.id), 'the input on pin 13 reads its pull-up, so pin 11 is off');
    useSimulationStore.getState().pressButton(btn.id, true);
    simulationController.advance(100);
    simulationController.publishNow();
    check(ledOn(led.id), 'pressing the button pulls pin 13 low and the loop turns pin 11 on');
    useSimulationStore.getState().pressButton(btn.id, false);
    simulationController.advance(100);
    useSimulationStore.getState().pressButton(btn.id, true);
    simulationController.advance(100);
    simulationController.publishNow();
    check(serial().includes('two falls'), 'two falling edges reach the event callback');
  }
  simulationController.stop();
}

section('errors are reported as Python reports them');
{
  const { p } = piProject('board.rpi-zero-gpio', 'from gpiozero import LED\nled = LED(17\nprint("x")\n');
  simulationController.stop();
  const report = await simulationController.build(p);
  check(report.builds[0]?.status === 'compile-failed' && /SyntaxError/.test(report.builds[0]?.detail ?? ''), `a syntax error fails the build (${report.builds[0]?.detail})`);
}
{
  const { p } = piProject('board.rpi-zero-gpio', 'import time\nprint("start")\ntime.sleep(0.1)\nprint(undefined_thing)\n');
  simulationController.stop();
  await simulationController.build(p);
  if (await simulationController.start()) {
    simulationController.pause();
    simulationController.advance(300);
    simulationController.publishNow();
    check(/line 4[\s\S]*NameError: name 'undefined_thing' is not defined/.test(serial()), `a runtime error prints a traceback with its line (${JSON.stringify(serial().slice(-80))})`);
  }
  simulationController.stop();
}
{
  const { p } = piProject('board.rpi-zero-gpio', 'import numpy\n');
  simulationController.stop();
  await simulationController.build(p);
  if (await simulationController.start()) {
    simulationController.pause();
    simulationController.advance(50);
    simulationController.publishNow();
    check(/ModuleNotFoundError: No module named 'numpy'/.test(serial()), 'a module the runtime does not have is a ModuleNotFoundError that says what is available');
  }
  simulationController.stop();
}

section('a busy loop still lets time pass');
{
  const { p, led } = piProject('board.rpi-zero-gpio', 'import RPi.GPIO as GPIO, time\nGPIO.setmode(GPIO.BCM)\nGPIO.setup(17, GPIO.OUT)\nstart = time.monotonic()\nwhile time.monotonic() - start < 0.5:\n    pass\nGPIO.output(17, 1)\nprint("half a second of spinning")\n');
  simulationController.stop();
  await simulationController.build(p);
  if (await simulationController.start()) {
    simulationController.pause();
    simulationController.advance(400);
    simulationController.publishNow();
    check(!ledOn(led.id), 'before 0.5 s the loop is still spinning');
    simulationController.advance(300);
    simulationController.publishNow();
    check(ledOn(led.id) && serial().includes('half a second'), 'and after it, the loop has ended on simulated time');
  }
  simulationController.stop();
}

void (null as unknown as ComponentInstance);
console.log(`\n--- ${failures} failing`);
process.exit(failures ? 1 : 0);
