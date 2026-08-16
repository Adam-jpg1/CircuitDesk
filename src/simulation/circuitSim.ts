// Binds the circuit graph to the AVR emulator: reads real pin states out of
// the executed firmware and feeds user inputs (buttons, potentiometers,
// sensor sliders) back in as electrical signals. This is a digital-level
// circuit model (documented as such) — full analog SPICE simulation is a
// separate future adapter.

import type { BoardDefinition, CircuitProject, ComponentInstance } from '../types';
import { buildCircuitGraph, splitNode, type CircuitGraph } from '../circuit/nets';
import type { BoardRunner } from './boardRunner';

/**
 * An MCU pin sitting on a net, together with the board instance that owns it.
 *
 * The instance id is what distinguishes two identical boards on one canvas.
 * Without it a pin number is only meaningful when a project contains exactly
 * one MCU, which is the assumption this replaces.
 */
export interface BoardPinEndpoint {
  /** Board instance id from the project, not the board type. */
  instance: string;
  /** Pin index in that board's own runner numbering. */
  pin: number;
  board: BoardDefinition;
}
import { runnerPinIndex, runnerAdcChannel, boardAdcReference } from './boardRunner';
import { avrProfileFor } from '../boards/pinMaps';
import { Ssd1306Device, SSD1306_ADDRESSES } from './devices/ssd1306';
import { Sh1107Device, SH1107_ADDRESSES } from './devices/sh1107';
import { Bmp280Device, BMP280_ADDRESSES } from './devices/bmp280';
import { Mpu6050Device, MPU6050_ADDRESSES } from './devices/mpu6050';
import type { ControlPinReader, I2cDevice, SpiDevice } from './devices/types';
import { Sn74hc595Device, HC595_OUTPUT_PINS } from './devices/sn74hc595';
import { SdCardDevice, type SdCardSnapshotData } from './devices/sdCard';
import { SpiFlashDevice, type SpiFlashSnapshotData } from './devices/spiFlash';
import { spiPinsFor } from './avr/spiPins';
import { getBoardBusProfile } from '../boards/busProfile';
import { Lcd1602Device, LCD1602_ADDRESSES } from './devices/lcd1602';
import { Eeprom24cDevice, EEPROM_ADDRESSES, type Eeprom24cSnapshotData } from './devices/eeprom24c';
import { Ds3231Device, DS3231_ADDRESS } from './devices/ds3231';
import { Mcp4725Device, MCP4725_ADDRESSES } from './devices/mcp4725';
import { Sn74hc165Device, HC165_INPUT_PINS } from './devices/sn74hc165';
import { Bme280Device, BME280_ADDRESSES } from './devices/bme280';
import { Max7219Device } from './devices/max7219';
import {
  Mcp23017Device,
  Pcf857xDevice,
  MCP23017_ADDRESSES,
  PCF8574_ADDRESSES,
  type ExpanderDevice,
} from './devices/portExpanders';
import { Sht31Device, SHT31_ADDRESSES } from './devices/sht31';
import { ANALOG_SENSORS, GPIO_SENSORS } from './devices/analogSensors';
import { contactsOf } from './devices/contactRegistry';
import { LOGIC_PARTS } from './devices/logicParts';
import { Hd44780ParallelDevice, LCD_DATA_PINS_8 } from './devices/lcdParallel';
import { Ws2812Device } from './devices/ws2812';
import { UartLink, type UartPeripheral } from './devices/uartEndpoint';
import { GpsNeo6mDevice } from './devices/gpsNeo6m';
import { Hc05Device } from './devices/hc05';
import { Esp01Device, DEFAULT_ACCESS_POINT } from './devices/esp01';
import { IrMedium } from './devices/irMedium';
import { RfMedium, RF_BAND } from './devices/rfMedium';
import { Nrf24Device } from './devices/nrf24';
import { Sx1278Device } from './devices/sx1278';
import { Ook433Receiver, Ook433Transmitter, OOK_MODULATION, OOK_DEFAULT_KHZ } from './devices/ook433';
import { Max485Device, Rs485Bus } from './devices/rs485';
import { CanBus } from './devices/canBus';
import { Mcp2515Device } from './devices/mcp2515';

/**
 * Two edges no further apart than this are cycles of one carrier.
 *
 * 40 us covers everything from about 12 kHz upwards, which is well below any
 * IR carrier in use, and is two orders of magnitude shorter than the 560 us
 * space that separates NEC marks — so nothing can be mistaken for the other.
 */
const IR_CARRIER_MAX_GAP_US = 40;
/** Silence for this long ends a mark. */
const IR_MARK_END_GAP_US = 60;
/** How much simulated time one settle covers, for anything clocked by it. */
const DEFAULT_SETTLE_MS = 1;
/** A gap this long means the next boundary starts a new burst. */
const IR_BURST_GAP_US = 50000;
/** The same, for on-off keying, whose gaps between packets are much longer. */
const OOK_BURST_GAP_US = 20000;
/**
 * How far ahead of a receiver's clock a burst is delivered.
 *
 * Wide enough to clear the worst skew between two boards taking turns on the
 * shared timeline — a couple of scheduling slices — so no boundary ever has to
 * be clamped into the past.
 */
const IR_DELIVERY_GUARD_US = 2000;

interface IrEmitterState {
  instanceId: string;
  runner: BoardRunner;
  pin: number;
  lastEdgeUs: number;
  carrierHz: number;
  cancelGap: (() => void) | null;
  edges: number;
  /** Start of the mark being emitted, and how many edges it has had. */
  markStartUs: number;
  markEdges: number;
}
import { NEC_CARRIER_HZ } from './devices/necCodec';
import { IrReceiverDevice, IrRemoteDevice, STARTER_REMOTE_KEYS } from './devices/irParts';
import { DfPlayerDevice } from './devices/dfplayer';
import { Ads1115Device, ADS1115_ADDRESSES } from './devices/ads1115';
import { Mcp3008Device, MCP3008_CHANNELS } from './devices/mcp3008';
import { Ds1307Device, DS1307_ADDRESS } from './devices/ds1307';
import { FramDevice, FRAM_ADDRESSES, type FramSnapshotData } from './devices/fram';
import { PersistenceTracker } from './devices/persistence';
import { MotorModel, QuadratureEncoder } from './devices/motorState';
import { CoilStepper, StepDirDriver } from './devices/steppers';
import { Tm1637Device } from './devices/tm1637';
import { TftDisplayDevice } from './devices/tftController';
import { ILI9341_SPEC, ST7735_SPEC, ST7789_SPEC, GC9A01_SPEC } from './devices/tftSpecs';
import { Ssd1331Device } from './devices/ssd1331';
import { Pcd8544Device } from './devices/pcd8544';
import { EpaperDevice } from './devices/epaper';
import { LogicIcDevice, levelOf as levelOfVolts, type Logic } from './devices/logicIc';
import { isContactClosed, contactStateKey } from './devices/contacts';

/** True for the port-expander family, which drives pins as well as answering. */
function isExpander(device: unknown): device is ExpanderDevice {
  return device instanceof Pcf857xDevice || device instanceof Mcp23017Device;
}

export interface NetLevel {
  volts: number | null;
  /** Arduino pin that drives this net, when driven by the MCU. */
  sourcePin: number | null;
  seriesOhms: number;
  conflict: boolean;
}

export interface DisplayVisual {
  /** SSD1306 GDDRAM (1 bit per pixel, page-major), or null when dark. */
  pixels: Uint8Array | null;
  on: boolean;
  revision: number;
}

export interface ComponentVisualState {
  /** Populated for display devices driven by real bus traffic. */
  display?: DisplayVisual;
  /** Live text lines read out of a simulated device model, drawn on the part. */
  readout?: string[];
  ledOn?: boolean;
  brightness?: number;
  rgb?: [number, number, number];
  buzzerOn?: boolean;
  servoAngle?: number;
  segments?: Record<string, boolean>;
  pressed?: boolean;
  toggledOn?: boolean;
  /**
   * A part whose whole body is either doing something or not.
   *
   * An IR receiver's demodulated output is the case that needs it: while it
   * hears a carrier its lens is being hit by light, and the artwork shows that
   * rather than leaving a black lump that never changes.
   */
  on?: boolean;
  potPosition?: number;
  /**
   * A two-axis stick's wiper positions, 0..1 each, centred at 0.5.
   *
   * The same numbers the axes impose on the ADC, so the drawn stick and the
   * voltage firmware reads cannot disagree. A joystick with no supply publishes
   * nothing here, because an unpowered stick's wipers impose nothing.
   */
  axes?: { x: number; y: number };
  value?: number;
  coilOn?: boolean;
  /**
   * Which of a multi-contact part's contacts are engaged, by contact key.
   *
   * A keypad needs this because "pressed" is not one boolean: four keys can be
   * down at once and the artwork has to show which four.
   */
  contacts?: Record<string, boolean>;
  /**
   * One colour per pixel of an addressable strip, in strip order.
   *
   * Separate from `rgb` because that is a single LED's three channels; this is
   * a frame. Empty means the strip's data line reaches no board pin, which is
   * a dark strip rather than a missing one.
   */
  pixelColors?: { r: number; g: number; b: number }[];
  /**
   * Apparent brightness of each element of a multiplexed part, 0..1.
   *
   * Keyed `<commonIndex>.<elementId>` — "2.a" is segment A of the third digit.
   * These are perceived levels, not electrical ones: a scanned digit is dark
   * three quarters of the time and reads here as the average an eye would see.
   */
  elementBrightness?: Record<string, number>;
  /**
   * What a motor or stepper is doing, derived from its terminals.
   *
   * `angleDegrees` is an integrated shaft position, not a commanded one — a
   * motor with a lead disconnected reports `connected: false` and does not
   * move, whatever the firmware asked for.
   */
  motor?: {
    direction: 'stopped' | 'forward' | 'reverse';
    magnitude: number;
    angleDegrees: number;
    connected: boolean;
  };
  /**
   * A colour framebuffer, handed to the canvas as raw RGB565 words.
   *
   * Deliberately not converted to nodes or to a data URL here: a 240x320 panel
   * is 76,800 pixels, and anything per-pixel on this path would run on every
   * publish. The renderer rasterises it once per revision instead.
   *
   * Null means the panel is not showing anything — asleep, display off, or not
   * reachable from a board at all.
   */
  raster?: {
    width: number;
    height: number;
    pixels: Uint16Array;
    inverted: boolean;
    revision: number;
  } | null;
}

export interface SimControls {
  pressedButtons: Set<string>;
  toggleStates: Map<string, boolean>;
  potPositions: Map<string, number>; // 0..1
  sensorValues: Map<string, number>; // ultrasonic cm, tmp36 °C, ldr 0..1
}

export function emptyControls(): SimControls {
  return {
    pressedButtons: new Set(),
    toggleStates: new Map(),
    potPositions: new Map(),
    sensorValues: new Map(),
  };
}

/** Pin types that count as a supply feeding a module's VCC (or an address strap). */
const POWER_PIN_TYPES = ['power-5v', 'power-3v3', 'power-vin'];

interface I2cDeviceModel {
  /** 7-bit address used when the instance has no explicit override. */
  defaultAddress: number;
  create: (ctx: DeviceCreateContext) => I2cDevice;
  /** Pin that selects the alternate address when strapped to a supply (AD0, …). */
  addressSelect?: { pinId: string; alternateAddress: number };
}

/** Everything a device model may need at construction time. */
interface DeviceCreateContext {
  instanceId: string;
  /** Resolved 7-bit I2C address (unused by SPI parts). */
  address: number;
  /** Supply the part is running from, used for logic and reference levels. */
  logicVolts: number;
  /** Emulated microseconds since reset — device timers run off this. */
  nowUs: () => number;
  /** Per-instance saved state, so storage parts keep contents across reloads. */
  saved: Record<string, unknown>;
}

/**
 * Components with a genuine device model behind them. A part missing here is
 * not simulated at the protocol level — it is simply not attached to the bus,
 * so firmware addressing it gets a NACK rather than a fabricated reply.
 */
const I2C_DEVICE_MODELS: Record<string, I2cDeviceModel> = {
  'comp.oled': {
    defaultAddress: SSD1306_ADDRESSES[0],
    create: (ctx) => new Ssd1306Device(ctx.instanceId, ctx.address),
  },
  'comp.ads1115': {
    defaultAddress: ADS1115_ADDRESSES[0],
    create: (ctx) => new Ads1115Device(ctx.instanceId, ctx.address),
  },
  'comp.ds1307': {
    defaultAddress: DS1307_ADDRESS,
    create: (ctx) => new Ds1307Device(ctx.instanceId, ctx.address, () => ctx.nowUs() / 1000),
  },
  'comp.fram': {
    defaultAddress: FRAM_ADDRESSES[0],
    create: (ctx) => {
      const device = new FramDevice(ctx.instanceId, ctx.address);
      device.loadState(ctx.saved.fram as FramSnapshotData | undefined);
      return device;
    },
  },
  'comp.sh1107': {
    defaultAddress: SH1107_ADDRESSES[0],
    create: (ctx) => new Sh1107Device(ctx.instanceId, ctx.address),
  },
  'comp.bmp280': {
    defaultAddress: BMP280_ADDRESSES[0],
    create: (ctx) => new Bmp280Device(ctx.instanceId, ctx.address),
  },
  'comp.mpu6050': {
    defaultAddress: MPU6050_ADDRESSES[0],
    create: (ctx) => new Mpu6050Device(ctx.instanceId, ctx.address),
    addressSelect: { pinId: 'ad0', alternateAddress: MPU6050_ADDRESSES[1] },
  },
  'comp.lcd1602': {
    defaultAddress: LCD1602_ADDRESSES[0],
    create: (ctx) => new Lcd1602Device(ctx.instanceId, ctx.address),
  },
  'comp.eeprom-24c': {
    defaultAddress: EEPROM_ADDRESSES[0],
    create: (ctx) => {
      const device = new Eeprom24cDevice(ctx.instanceId, ctx.address, ctx.nowUs);
      device.loadState(ctx.saved.eeprom as Eeprom24cSnapshotData | undefined);
      return device;
    },
  },
  'comp.ds3231': {
    defaultAddress: DS3231_ADDRESS,
    create: (ctx) => new Ds3231Device(ctx.instanceId, ctx.address, ctx.nowUs),
  },
  'comp.mcp4725': {
    defaultAddress: MCP4725_ADDRESSES[0],
    create: (ctx) => new Mcp4725Device(ctx.instanceId, ctx.address, ctx.logicVolts),
  },
  'comp.pcf8574': {
    defaultAddress: PCF8574_ADDRESSES[0],
    create: (ctx) => new Pcf857xDevice(ctx.instanceId, ctx.address, 8),
  },
  'comp.pcf8575': {
    defaultAddress: PCF8574_ADDRESSES[0],
    create: (ctx) => new Pcf857xDevice(ctx.instanceId, ctx.address, 16),
  },
  'comp.mcp23017': {
    defaultAddress: MCP23017_ADDRESSES[0],
    create: (ctx) => new Mcp23017Device(ctx.instanceId, ctx.address),
  },
  'comp.lcd2004': {
    defaultAddress: LCD1602_ADDRESSES[0],
    create: (ctx) => new Lcd1602Device(ctx.instanceId, ctx.address, { columns: 20, rows: 4 }),
  },
  'comp.bme280': {
    defaultAddress: BME280_ADDRESSES[0],
    create: (ctx) => new Bme280Device(ctx.instanceId, ctx.address),
  },
  'comp.sht31': {
    defaultAddress: SHT31_ADDRESSES[0],
    create: (ctx) => new Sht31Device(ctx.instanceId, ctx.address),
  },
};

/**
 * Components with a genuine SPI device model.
 *
 * `busPins` names the component pins that must reach the board's own SPI
 * lines; `miso: null` marks a part that never drives MISO (a 74HC595), so its
 * absence is not treated as a wiring fault. `cs` names the chip-select pin, or
 * null for parts that have none.
 */
interface SpiDeviceModel {
  busPins: { sck: string; mosi: string; miso: string | null; cs: string | null };
  /**
   * Component pins that are not part of the bus but that the part reads.
   *
   * A TFT's data/command line is the reason this exists. It is a plain GPIO
   * that decides whether the byte on MOSI is a command or a pixel, and it
   * cannot live in the bus: the bus carries bytes, and D/C is not a byte. So
   * the binding resolves each named pin to a board pad and hands the device a
   * live reader, and the device samples it when it matters — which is what the
   * silicon does, and what keeps a driver that sets D/C mid-transaction honest.
   *
   * Optional per pin: a part whose RESET is not wired simply never sees a
   * reset, exactly as on a breadboard where that line is often tied high.
   */
  controlPins?: readonly string[];
  create: (ctx: SpiCreateContext) => SpiDevice;
}

interface SpiCreateContext extends DeviceCreateContext {
  csPinId: string | null;
  /** The shared radio medium, for parts that are radios. */
  radio: RfMedium;
  /** The CAN bus this part's CANH/CANL sit on. */
  canBus: CanBus;
  /**
   * Live level of a control pin, resolved against the board that owns this
   * device. Two identical displays on two boards each read their own wiring.
   */
  readControl: ControlPinReader;
}

/**
 * Character LCDs driven from plain GPIOs, and the glass each one has.
 *
 * The controller is identical across them — this table is only how many
 * characters are in front of it.
 */
/**
 * Addressable-LED parts, and how many pixels each has by default.
 *
 * The count is a property on the instance; this is only the fallback for a part
 * dropped on the canvas and not configured.
 */
const WS2812_DEFAULT_PIXELS: Record<string, number> = {
  'comp.neopixel': 1,
  'comp.neopixel-ring': 16,
  'comp.neopixel-strip': 8,
  'comp.neopixel-matrix': 64,
};

/**
 * Multiplexed parts, and how they are wired.
 *
 * `commons` are the pins that enable one digit or row at a time; `elements`
 * are the shared lines. Which of the two is driven low is the part's polarity:
 * a common-cathode digit lights a segment when the segment is high and the
 * common is low, and a common-anode one is the other way round.
 */
/**
 * Parts whose behaviour is a motor turning, and the terminals it turns from.
 *
 * `ratedVolts` is the nameplate: the drive magnitude is relative to it, so a
 * 3 V vibration motor on 5 V is at full tilt and a 12 V motor on 5 V is not.
 * `ratedRpm` sets how fast the modelled shaft integrates, which is what an
 * encoder counts.
 */
/**
 * Relays, and where their coils are.
 *
 * `pullInVolts` is what the coil needs before the armature moves. A relay
 * module fed 3.3 V from a board whose coil wants 5 V famously does not click,
 * and that is a wiring answer rather than a code one — so it is modelled.
 */
/**
 * Regulators and converters, as behavioural models.
 *
 * Each takes an input and imposes a nominal output, subject to the constraints
 * that actually decide whether one works on a breadboard: it needs a ground, it
 * needs enough headroom above its output (a linear part cannot make 5 V from
 * 5 V), and a module with an enable pin has to be enabled. A boost converter is
 * the same shape with the headroom rule inverted — it needs its input BELOW its
 * output, and above its own minimum.
 *
 * NOT modelled anywhere here, and the descriptions say so: ripple, efficiency,
 * thermal shutdown, transient response, switching frequency and current limit.
 */
const REGULATOR_PARTS: Record<
  string,
  {
    vin: string;
    gnd: string;
    vout: string;
    nominal: number;
    /** Minimum input above the output for a linear part to regulate. */
    dropout: number;
    /** True for a boost: the input must be below the output instead. */
    stepUp?: boolean;
    /** Lowest input it will start from at all. */
    minInput?: number;
    enable?: string;
  }
> = {
  'comp.regulator': { vin: 'vin', gnd: 'gnd', vout: 'vout', nominal: 5, dropout: 2 },
  'comp.regulator-5': { vin: 'vin', gnd: 'gnd', vout: 'vout', nominal: 5, dropout: 2 },
  'comp.regulator-33': { vin: 'vin', gnd: 'gnd', vout: 'vout', nominal: 3.3, dropout: 1.5 },
  // An LDO is defined by its low dropout — that is the whole reason to choose
  // one, and modelling it with the same headroom as a 7805 would erase the
  // difference.
  'comp.ldo': { vin: 'vin', gnd: 'gnd', vout: 'vout', nominal: 3.3, dropout: 0.3, enable: 'en' },
  'comp.buck-converter': { vin: 'vin', gnd: 'gnd', vout: 'vout', nominal: 5, dropout: 1, minInput: 6 },
  'comp.boost-converter': {
    vin: 'vin', gnd: 'gnd', vout: 'vout', nominal: 5, dropout: 0, stepUp: true, minInput: 2,
  },
};

/**
 * Boards whose UART peripheral is genuinely wired to a runner.
 *
 * From tests/uart.audit.mts, which measures this rather than assuming it. A
 * board that is not here has no UART a device can attach to, so no link is
 * created and the part reports a board capability mismatch instead of quietly
 * working. The ESP parts are absent because their UART is a register file that
 * swallows writes — blocker `esp32-uart`.
 */
export const BOARDS_WITH_UART = new Set([
  'board.arduino-uno',
  'board.arduino-nano',
  'board.arduino-mega2560',
  'board.arduino-leonardo',
  'board.raspberry-pi-pico',
  'board.raspberry-pi-pico-w',
]);

/** UART devices, and which of their pins carry which direction. */
export const UART_DEVICE_PARTS: Record<
  string,
  {
    /** Device pin that DRIVES the board's RX. */
    tx: string;
    /** Device pin the board's TX drives. */
    rx: string;
    create: (instanceId: string, baud: number) => UartPeripheral;
  }
> = {
  'comp.gps': { tx: 'tx', rx: 'rx', create: (id, baud) => new GpsNeo6mDevice(id, baud) },
  'comp.hc05': { tx: 'txd', rx: 'rxd', create: (id, baud) => new Hc05Device(id, baud) },
  'comp.dfplayer': { tx: 'tx', rx: 'rx', create: (id, baud) => new DfPlayerDevice(id, baud) },
  'comp.esp01': { tx: 'tx', rx: 'rx', create: (id, baud) => new Esp01Device(id, baud) },
};

const RELAY_PARTS: Record<string, { coil: string; coilReturn: string; pullInVolts: number }> = {
  'comp.relay': { coil: 'in', coilReturn: 'gnd', pullInVolts: 2.5 },
  'comp.relay-dpdt': { coil: 'in', coilReturn: 'gnd', pullInVolts: 2.5 },
};

const MOTOR_PARTS: Record<
  string,
  { plus: string; minus: string; ratedVolts: number; ratedRpm: number; encoderPpr?: number }
> = {
  'comp.dc-motor': { plus: 'm1', minus: 'm2', ratedVolts: 6, ratedRpm: 300 },
  'comp.gearmotor': { plus: 'm1', minus: 'm2', ratedVolts: 6, ratedRpm: 90 },
  'comp.vibration-motor': { plus: 'm1', minus: 'm2', ratedVolts: 3, ratedRpm: 12000 },
  'comp.dc-motor-encoder': { plus: 'm1', minus: 'm2', ratedVolts: 6, ratedRpm: 200, encoderPpr: 11 },
  'comp.solenoid': { plus: 'p1', minus: 'p2', ratedVolts: 12, ratedRpm: 0 },
};

/** Steppers whose four coils firmware drives directly. */
const COIL_STEPPER_PARTS: Record<string, { coils: string[]; stepsPerRevolution: number }> = {
  // Counted in half-steps: a 200-full-step bipolar motor is 400, and a
  // 28BYJ-48's gearbox gives the familiar 4096 per output revolution.
  'comp.stepper': { coils: ['in1', 'in2', 'in3', 'in4'], stepsPerRevolution: 400 },
  'comp.stepper-28byj': { coils: ['in1', 'in2', 'in3', 'in4'], stepsPerRevolution: 4096 },
};

/** Step/direction drivers, which sequence the coils on the far side themselves. */
const STEP_DIR_PARTS: Record<string, { fullStepsPerRevolution: number }> = {
  'comp.a4988': { fullStepsPerRevolution: 200 },
};

const MULTIPLEXED_PARTS: Record<
  string,
  { commons: string[]; elements: string[]; commonCathode: boolean }
> = {
  'comp.seven-segment-ca': {
    commons: ['com1'],
    elements: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'dp'],
    commonCathode: false,
  },
  'comp.seven-segment-2': {
    commons: ['d1', 'd2'],
    elements: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'dp'],
    commonCathode: true,
  },
  'comp.seven-segment-4': {
    commons: ['d1', 'd2', 'd3', 'd4'],
    elements: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'dp'],
    commonCathode: true,
  },
  'comp.led-matrix': {
    // Rows are the commons, columns the shared lines — the usual bare-matrix
    // wiring, and the one every scanning example assumes.
    commons: ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8'],
    elements: ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8'],
    commonCathode: true,
  },
};

const PARALLEL_LCD_GEOMETRY: Record<string, { columns: number; rows: number }> = {
  'comp.lcd1602-parallel': { columns: 16, rows: 2 },
  'comp.lcd2004-parallel': { columns: 20, rows: 4 },
};

const SPI_DEVICE_MODELS: Record<string, SpiDeviceModel> = {
  'comp.hc595': {
    busPins: { sck: 'srclk', mosi: 'ser', miso: null, cs: null },
    create: (ctx) => new Sn74hc595Device(ctx.instanceId, ctx.logicVolts),
  },
  'comp.nrf24l01': {
    // CSN selects the chip for a transaction; CE enables the radio. They are
    // different signals and the model treats them as different signals.
    busPins: { sck: 'sck', mosi: 'mosi', miso: 'miso', cs: 'csn' },
    controlPins: ['ce'],
    create: (ctx) => new Nrf24Device(ctx.instanceId, ctx.csPinId ?? 'csn', ctx.radio, ctx.nowUs),
  },
  'comp.mcp2515': {
    busPins: { sck: 'sck', mosi: 'si', miso: 'so', cs: 'cs' },
    controlPins: ['int'],
    create: (ctx) => new Mcp2515Device(ctx.instanceId, ctx.csPinId ?? 'cs', ctx.canBus),
  },
  'comp.lora-sx1278': {
    busPins: { sck: 'sck', mosi: 'mosi', miso: 'miso', cs: 'nss' },
    controlPins: ['rst', 'dio0'],
    create: (ctx) => new Sx1278Device(ctx.instanceId, ctx.csPinId ?? 'nss', ctx.radio, ctx.nowUs),
  },
  'comp.sd-card': {
    busPins: { sck: 'sck', mosi: 'mosi', miso: 'miso', cs: 'cs' },
    create: (ctx) => {
      const device = new SdCardDevice(ctx.instanceId, ctx.csPinId ?? 'cs');
      device.loadState(ctx.saved.sdCard as SdCardSnapshotData | undefined);
      return device;
    },
  },
  'comp.hc165': {
    // Parallel-in / serial-out: it drives MISO and reads nothing from MOSI.
    busPins: { sck: 'cp', mosi: null as unknown as string, miso: 'qh', cs: null },
    create: (ctx) => new Sn74hc165Device(ctx.instanceId),
  },
  'comp.max7219': {
    // DIN is the data line; the part never drives MISO on its own — DOUT is
    // the chain output, which the next device's DIN listens to.
    busPins: { sck: 'clk', mosi: 'din', miso: null, cs: 'cs' },
    create: (ctx) => new Max7219Device(ctx.instanceId, ctx.csPinId),
  },
  // Colour TFTs. All four share one device class and differ only by spec —
  // and the spec is what stops one controller accepting another's commands.
  'comp.ili9341': {
    busPins: { sck: 'sck', mosi: 'mosi', miso: null, cs: 'cs' },
    controlPins: ['dc', 'rst'],
    create: (ctx) => new TftDisplayDevice(ctx.instanceId, ctx.csPinId, ILI9341_SPEC),
  },
  'comp.st7735': {
    busPins: { sck: 'sck', mosi: 'mosi', miso: null, cs: 'cs' },
    controlPins: ['dc', 'rst'],
    create: (ctx) => new TftDisplayDevice(ctx.instanceId, ctx.csPinId, ST7735_SPEC),
  },
  'comp.st7789': {
    busPins: { sck: 'sck', mosi: 'mosi', miso: null, cs: 'cs' },
    controlPins: ['dc', 'rst'],
    create: (ctx) => new TftDisplayDevice(ctx.instanceId, ctx.csPinId, ST7789_SPEC),
  },
  'comp.gc9a01': {
    busPins: { sck: 'sck', mosi: 'mosi', miso: null, cs: 'cs' },
    controlPins: ['dc', 'rst'],
    create: (ctx) => new TftDisplayDevice(ctx.instanceId, ctx.csPinId, GC9A01_SPEC),
  },
  'comp.ssd1331': {
    busPins: { sck: 'sck', mosi: 'mosi', miso: null, cs: 'cs' },
    controlPins: ['dc', 'rst'],
    create: (ctx) => new Ssd1331Device(ctx.instanceId, ctx.csPinId),
  },
  'comp.epaper29': {
    busPins: { sck: 'sck', mosi: 'mosi', miso: null, cs: 'cs' },
    controlPins: ['dc', 'rst'],
    create: (ctx) => new EpaperDevice(ctx.instanceId, ctx.csPinId, () => ctx.nowUs() / 1000),
  },
  'comp.mcp3008': {
    busPins: { sck: 'clk', mosi: 'din', miso: 'dout', cs: 'cs' },
    create: (ctx) => new Mcp3008Device(ctx.instanceId, ctx.csPinId),
  },
  'comp.nokia5110': {
    busPins: { sck: 'sck', mosi: 'mosi', miso: null, cs: 'cs' },
    controlPins: ['dc', 'rst'],
    create: (ctx) => new Pcd8544Device(ctx.instanceId, ctx.csPinId),
  },
  'comp.spi-flash': {
    busPins: { sck: 'sck', mosi: 'mosi', miso: 'miso', cs: 'cs' },
    create: (ctx) => {
      const device = new SpiFlashDevice(ctx.instanceId, ctx.csPinId ?? 'cs', ctx.nowUs);
      device.loadState(ctx.saved.spiFlash as SpiFlashSnapshotData | undefined);
      return device;
    },
  },
};

/** Control pins a 74HC595 needs beyond the shift clock and data line. */
interface Hc595Wiring {
  device: Sn74hc595Device;
  /** Board pin the RCLK (latch) line reaches, or null when unwired. */
  latchPin: number | null;
  oeNet: string | undefined;
  clearNet: string | undefined;
}

/** Control and parallel-input wiring for a 74HC165. */
interface Hc165Wiring {
  device: Sn74hc165Device;
  loadNet: string | undefined;
  enableNet: string | undefined;
  inputNets: (string | undefined)[];
}

interface ConductiveEdge {
  a: string;
  b: string;
  ohms: number;
  kind: 'resistor' | 'switch' | 'pot' | 'diode' | 'channel';
  enabled: (controls: SimControls) => boolean;
}

interface UltrasonicState {
  trigPin: number | null;
  echoPin: number | null;
  trigHighAtUs: number;
  cancelEcho: (() => void)[];
}

export class CircuitBinding {
  readonly graph: CircuitGraph;
  readonly boardInstance: ComponentInstance | null;
  readonly boardDef: BoardDefinition | null;
  private edges: ConductiveEdge[] = [];
  /**
   * MCU pins on each net, for the primary runner only.
   *
   * Kept as bare pin numbers because everything that consumes it — the
   * ultrasonic pairing, the bus rebinding, an LED's source pin — belongs to
   * one board by nature. Cross-board work uses `netEndpoints` below.
   */
  private netBoardPins = new Map<string, number[]>();

  /**
   * Every MCU pin on every net, carrying which board instance owns it.
   *
   * This is what makes more than one board on a canvas possible. A bare pin
   * number is ambiguous the moment a project holds two of the same part: GPIO8
   * on one ESP32-C3 and GPIO8 on another are different pads on different
   * chips, and a net driven by one must not be attributed to the other.
   */
  private netEndpoints = new Map<string, BoardPinEndpoint[]>();

  /** Runners by board instance id. A single-board project simply has one. */
  private runners = new Map<string, BoardRunner>();

  /**
   * Nets where two outputs disagreed on the last update.
   *
   * Reported rather than resolved. Two pins driving one wire in opposite
   * directions is a short through both output stages, and presenting it as a
   * settled HIGH or LOW would hide the single most damaging wiring mistake a
   * student can make.
   */
  readonly contendedNets = new Set<string>();
  /** netId → emulated ADC channels reachable on that net (board-profile-aware). */
  private netAdcChannels = new Map<string, number[]>();
  private groundNets = new Set<string>();
  private supplyNets = new Map<string, number>();

  /**
   * Every individual source contribution, before any of them is merged.
   *
   * `supplyNets` is a map, so two sources on one net collapse into whichever
   * was indexed last — and a 5 V supply wired to a 3.3 V one would quietly
   * become one of the two rather than the fault it is. Keeping the
   * contributions separately and pushing each through `setLevel` is what lets
   * the existing contention rule see both.
   */
  private sourceContributions: { netId: string; volts: number }[] = [];

  /**
   * What each module says it expects on a pin — metadata, not electricity.
   *
   * A part that declares "VCC, 3.3 V" is stating a requirement so validation
   * can check it is met and the inspector can say what the part wants. It is
   * not a source, and it does not reach the solver at all: it contributes zero
   * volts and zero conductance to every net.
   *
   * This was previously folded into `supplyNets` and later applied through a
   * megohm, and both were wrong. A megohm is still a source — a high-impedance
   * CMOS or ADC input draws essentially nothing, so it would read that fake
   * rail as a real voltage, and an unpowered sensor would appear to work.
   */
  private declaredRails = new Map<string, number>();

  /** What a part expects on a net, for validation and the inspector only. */
  declaredRailVolts(netId: string): number | undefined {
    return this.declaredRails.get(netId);
  }
  private ultrasonic = new Map<string, UltrasonicState>();
  private netOfInstancePin = (instanceId: string, pinId: string): string | undefined =>
    this.graph.netOf.get(`${instanceId}:${pinId}`);

  constructor(
    readonly project: CircuitProject,
    readonly runner: BoardRunner | null,
    /**
     * Runners for every simulated board, keyed by board instance id.
     *
     * Omitted by single-board callers, which pass `runner` alone and get the
     * same behaviour they always had. When supplied, `runner` is still the
     * primary board — the one whose logic level and bus devices the
     * component models use — and the rest participate through the nets.
     */
    runnersByInstance?: Map<string, BoardRunner>,
  ) {
    this.graph = buildCircuitGraph(project);
    // Bind ONLY to a board whose definition declares genuine simulation
    // support. Boards without a simulator never fall back to another
    // board's profile — with no simulated board, no MCU pins are bound.
    this.boardInstance =
      project.boardInstances.find((b) => {
        const def = this.graph.definitions.get(b.id);
        return def?.isBoard && def.simulation?.supported === true;
      }) ?? null;
    const bd = this.boardInstance ? this.graph.definitions.get(this.boardInstance.id) : undefined;
    this.boardDef = bd?.isBoard ? bd : null;

    if (runnersByInstance) for (const [id, r] of runnersByInstance) this.runners.set(id, r);
    else if (runner && this.boardInstance) this.runners.set(this.boardInstance.id, runner);

    this.indexNets();
    this.buildEdges();
    this.setupLogicDevices();
    this.markMultiplexedNets();
    if (runner) this.setupUltrasonic(runner);
    this.rebindBuses();
  }

  /**
   * Attaches device models to whichever pins the buses are currently on.
   *
   * Every board with a bus, not only the first one. With several boards on a
   * canvas the LCD may be wired to the second board's I2C pins, and binding
   * only the primary's bus would leave a display that is correctly wired doing
   * nothing at all. Each board attaches the devices wired to *its* pads.
   */
  private rebindBuses(): void {
    this.boundBusPins = this.busPinSignature();
    // Edge subscriptions and latch wiring belong to the whole binding, not to
    // one board, so they are cleared once here rather than inside the per-board
    // setup — otherwise the second board would drop the first board's listeners.
    this.releaseListeners();
    this.hc595.clear();
    this.hc165.clear();
    this.parallelLcds.clear();
    this.addressableLeds.clear();
    this.twoWireDisplays.clear();
    this.uartLinks.clear();
    for (const link of this.irReceivers.values()) link.cancels.forEach((c) => c());
    this.irReceivers.clear();
    this.irEmitterListeners.forEach((off) => off());
    this.irEmitterListeners = [];
    for (const emitter of this.irEmitters.values()) emitter.cancelGap?.();
    this.irEmitters.clear();
    for (const link of this.ookReceivers.values()) link.cancels.forEach((c) => c());
    this.ookReceivers.clear();
    this.ookTransmitters.clear();
    this.rs485Nodes.clear();
    this.rs485Buses.clear();
    this.canBuses.clear();
    const i2c: I2cDevice[] = [];
    const spi: SpiDevice[] = [];
    for (const [instanceId, owner] of this.runners) {
      i2c.push(...this.setupI2cDevices(owner, instanceId));
      spi.push(...this.setupSpiDevices(owner, instanceId));
      this.setupParallelLcds(owner, instanceId);
      this.setupAddressableLeds(owner, instanceId);
      this.setupTwoWireDisplays(owner, instanceId);
      this.setupUartLinks(owner, instanceId);
      this.setupIrReceivers(owner, instanceId);
      this.setupIrEmitters(owner, instanceId);
      this.setupOokParts(owner, instanceId);
      this.setupRs485(owner, instanceId);
    }
    this.i2cDevices = i2c;
    this.spiDevices = spi;
    // releaseListeners() above dropped the switched-net subscriptions along
    // with the bus ones, so they are re-established here rather than only in
    // the constructor — a re-bind must not leave a keypad unwatched.
    this.watchSwitchedNets();
  }

  /**
   * Nets that a mechanical contact can bridge.
   *
   * Kept because these are the nets whose resolution cannot wait for the next
   * slice boundary — see `watchSwitchedNets`.
   */
  private switchedNets = new Set<string>();

  /** Edge subscriptions held for switched-net resolution. */
  private switchedPinListeners: (() => void)[] = [];

  /** Guards against a solve triggering another solve through its own writes. */
  private resolving = false;

  /**
   * Re-solves the moment firmware drives a pin that a contact can bridge.
   *
   * Nets are normally settled once per world slice, which is a millisecond —
   * fine for a wire whose level changes slowly relative to that. It is not
   * fine for matrix scanning, where firmware drives a row low, reads a column
   * and drives the row high again inside a few microseconds. Settling once per
   * slice would show the column whichever row happened to be low at the last
   * boundary, so one pressed key would be decoded on several rows: a phantom
   * key produced by the simulator rather than by the circuit.
   *
   * So pins on switched nets get a real edge subscription, exactly as the SPI
   * chip-select and 74HC595 latch lines do. The cost is bounded because it is
   * only the pins a contact can actually reach: a project with no switches
   * subscribes to nothing, and one with a 4×4 keypad subscribes to eight pins.
   */
  private watchSwitchedNets(): void {
    for (const off of this.switchedPinListeners) off();
    this.switchedPinListeners = [];
    if (this.switchedNets.size === 0) return;

    // Which of each board's pins sit on a switched net.
    const byInstance = new Map<string, Set<number>>();
    for (const netId of this.switchedNets) {
      for (const endpoint of this.netEndpoints.get(netId) ?? []) {
        const set = byInstance.get(endpoint.instance) ?? new Set<number>();
        set.add(endpoint.pin);
        byInstance.set(endpoint.instance, set);
      }
    }

    for (const [instanceId, pins] of byInstance) {
      const runner = this.runners.get(instanceId);
      if (!runner || pins.size === 0) continue;
      this.switchedPinListeners.push(
        runner.addPinListener((pin) => {
          if (!pins.has(pin)) return;
          if (this.resolving || !this.controlsRef) return;
          this.resolving = true;
          try {
            this.update(this.controlsRef);
          } finally {
            this.resolving = false;
          }
        }),
      );
    }
  }

  /**
   * Identifies the current bus pin assignment across every board, for change
   * detection.
   *
   * All boards, because the sketch that opens a bus may not be the primary
   * board's: with an ESP32 first on the canvas and an LCD on a Pico's GP4/GP5,
   * watching only the primary would never notice the Pico's `Wire.begin()` and
   * the display would stay unattached forever.
   */
  private busPinSignature(): string {
    const parts: string[] = [];
    for (const [instanceId, runner] of this.runners) {
      if (!runner.activeI2cPins && !runner.activeSpiPins) continue;
      const i2c = runner.activeI2cPins?.() ?? {};
      const spi = runner.activeSpiPins?.() ?? {};
      parts.push(
        `${instanceId}=${i2c.sda ?? '-'}/${i2c.scl ?? '-'}|${spi.sck ?? '-'}/${spi.mosi ?? '-'}/${spi.miso ?? '-'}`,
      );
    }
    return parts.length === 0 ? 'static' : parts.join(';');
  }

  /**
   * The bus pins the last device binding was built against.
   *
   * On an RP2040 the buses do not exist until the firmware muxes them, which
   * happens inside `Wire.begin()` / `SPI.begin()` — after the circuit has been
   * bound. Re-binding when the assignment changes is what lets devices attach
   * at the moment the sketch actually opens the bus, without polling anything
   * expensive: this is two integer comparisons per frame.
   */
  private boundBusPins = '';

  private hc595 = new Map<string, Hc595Wiring>();
  private hc165 = new Map<string, Hc165Wiring>();
  private spiDevices: SpiDevice[] = [];
  private i2cDevices: I2cDevice[] = [];
  private unsubscribeLatches: (() => void)[] = [];
  private persistedWrites = new Map<string, number>();

  /**
   * Copies a storage device's contents into the project only when it actually
   * changed. Re-encoding a card image every frame would be wasted work.
   */
  private persistDevice(inst: ComponentInstance, writeCounter: number, save: () => void): void {
    if (this.persistedWrites.get(inst.id) === writeCounter) return;
    this.persistedWrites.set(inst.id, writeCounter);
    if (writeCounter > 0) save();
  }

  /** Drops edge subscriptions held for this binding (called on re-bind). */
  releaseListeners(): void {
    this.unsubscribeLatches.forEach((off) => off());
    this.unsubscribeLatches = [];
    // Switched-net subscriptions go too: this binding is being replaced, and a
    // listener that outlived it would re-solve a circuit that no longer exists.
    this.switchedPinListeners.forEach((off) => off());
    this.switchedPinListeners = [];
    this.serialTaps.forEach((off) => off());
    this.serialTaps.clear();
  }

  /**
   * Taps a board's transmitted bytes so a wired module hears them.
   *
   * The board-to-device direction cannot be polled the way the other one is:
   * a byte leaves the UART the moment the firmware writes it, and the settle
   * that runs between slices would see only that some unknown number of bytes
   * had gone by. So the runner's serial-out callback is chained — whatever was
   * there first still runs, so the serial monitor keeps its attribution — and
   * every byte is offered to the links belonging to THIS board.
   *
   * Chained rather than replaced, and released on re-bind, because stacking a
   * second tap on the same runner would deliver every byte twice.
   */
  private tapBoardSerial(runner: BoardRunner): void {
    if (this.serialTaps.has(runner)) return;
    const downstream = runner.onSerialByte;
    runner.onSerialByte = (byte: number) => {
      downstream?.(byte);
      this.rs485ByteFromBoard(runner, byte);
      const nowUs = runner.timeMs * 1000;
      for (const { link, runner: owner } of this.uartLinks.values()) {
        if (owner !== runner) continue;
        // The rate as it is at this byte, not as it was at the last settle: a
        // sketch that changes Serial.begin() mid-run must corrupt from the
        // byte it changed on.
        link.setBoardConfig({ baud: runner.uartBaudRate ?? link.boardBaud });
        link.boardTransmitted(byte, nowUs);
      }
    };
    this.serialTaps.set(runner, () => {
      runner.onSerialByte = downstream;
    });
  }

  /**
   * Attaches SPI device models for parts genuinely wired to the board's SPI
   * bus. A device whose SCK, MOSI, MISO, power or ground is missing is not
   * attached at all, so firmware talking to it reads back an idle bus rather
   * than a fabricated reply.
   */
  /**
   * Character LCDs wired straight to GPIOs, rather than through a bus.
   *
   * There is nothing to decode here: the panel latches on the falling edge of
   * E and reads whatever RS and the data lines are holding at that instant. So
   * the binding subscribes to those pins as edges — the same treatment the
   * 74HC595's latch gets, and for the same reason: an E pulse is microseconds
   * long and polling once a frame would miss every one of them.
   *
   * Levels are seeded from the emulator at bind time as well as tracked from
   * edges. A data line that firmware sets once and leaves alone produces no
   * further edges, and a panel that only knew about changes would read it as
   * low forever.
   */
  /**
   * WS2812 strips, watched as raw edges on their data pin.
   *
   * There is nothing else to hook: the part's entire protocol is the time
   * between one edge and the next. The timestamp comes from the runner's own
   * cycle counter at the moment the listener fires, which is what makes a
   * 400 ns pulse distinguishable from an 800 ns one — wall time could not.
   */
  private setupAddressableLeds(runner: BoardRunner, boardInstanceId: string): void {
    for (const inst of this.graph.instances) {
      const def = this.graph.definitions.get(inst.id);
      const fallback = def ? WS2812_DEFAULT_PIXELS[def.id] : undefined;
      if (fallback === undefined) continue;

      const dinNet = this.netOfInstancePin(inst.id, 'din');
      const dinPin =
        dinNet === undefined
          ? null
          : (this.netEndpoints.get(dinNet) ?? []).find((e) => e.instance === boardInstanceId)?.pin ?? null;
      // Its data line reaches no pad on this board. Another board may drive it,
      // and a strip chained off another strip's DOUT is driven by nothing at
      // all — which is the documented limit, not a silent failure.
      if (dinPin === null) continue;

      const count = Math.max(1, Math.floor(Number(inst.properties.pixelCount ?? fallback)));
      const existing = this.addressableLedDevices.get(inst.id);
      const device =
        existing && existing.pixelCount === count ? existing : new Ws2812Device(inst.id, count);
      this.addressableLedDevices.set(inst.id, device);
      this.addressableLeds.set(inst.id, { device, runner });

      this.unsubscribeLatches.push(
        runner.addPinListener((pin, high) => {
          if (pin === dinPin) device.onEdge(high, runner.timeMs * 1e6);
        }),
      );
    }
  }

  /**
   * TM1637 modules, watched as edges on their two wires.
   *
   * Not on the I2C bus, deliberately: the part has no address, clocks its bits
   * least significant first, and is reached through two plain GPIOs. Attaching
   * it to the I2C bus would make an ordinary TM1637 sketch fail and an I2C scan
   * find a device that is not there.
   */
  /**
   * UART devices, linked to a board only when the wires genuinely reach it.
   *
   * Three conditions, all necessary. The board has to have a UART peripheral at
   * all — the audit says which do. The device's TX has to sit on a net that
   * reaches that board's RX pad, and its RX on the board's TX pad. And the
   * board must be THIS board instance: two Picos with a GPS each, wired
   * identically, get one link apiece and never see each other's sentences.
   *
   * A device that fails any of them gets no link, and therefore no traffic —
   * which is what a GPS wired to the wrong pins does on a bench.
   */
  private setupUartLinks(runner: BoardRunner, boardInstanceId: string): void {
    const board = this.boardDefinitionOf(boardInstanceId);
    if (!board || !BOARDS_WITH_UART.has(board.id)) return;

    // The board's own UART pads, by capability rather than by pin name — a
    // Pico's are GP0/GP1 and an Uno's are D0/D1.
    const padWithCap = (cap: string): string | undefined =>
      board.pins.find((p) => p.capabilities.includes(cap as never))?.id;
    const boardRxPin = padWithCap('uart-rx');
    const boardTxPin = padWithCap('uart-tx');
    if (!boardRxPin || !boardTxPin) return;

    const boardRxNet = this.netOfInstancePin(boardInstanceId, boardRxPin);
    const boardTxNet = this.netOfInstancePin(boardInstanceId, boardTxPin);

    for (const inst of this.graph.instances) {
      const def = this.graph.definitions.get(inst.id);
      const spec = def ? UART_DEVICE_PARTS[def.id] : undefined;
      if (!spec) continue;

      // The device drives the board's RX, and the board's TX drives the
      // device's RX. Crossed, as the wires are on a bench.
      const deviceTxNet = this.netOfInstancePin(inst.id, spec.tx);
      const deviceRxNet = this.netOfInstancePin(inst.id, spec.rx);
      if (!deviceTxNet || deviceTxNet !== boardRxNet) continue;

      const powered = this.netFedByOther(this.netOfInstancePin(inst.id, 'vcc'), inst.id, POWER_PIN_TYPES);
      const grounded = this.netFedByOther(this.netOfInstancePin(inst.id, 'gnd'), inst.id, ['ground']);
      if (!powered || !grounded) continue;

      const existing = this.uartDeviceCache.get(inst.id);
      const device: UartPeripheral = existing ?? spec.create(inst.id, Number(inst.properties.baud ?? 9600));
      this.uartDeviceCache.set(inst.id, device);

      const link = new UartLink(boardInstanceId, device);
      // A device whose RX is not wired still transmits — that is a perfectly
      // normal GPS install — but the board cannot configure it.
      if (deviceRxNet !== boardTxNet) link.noteContention(0);
      this.uartLinks.set(inst.id, { link, runner });
      // Only a device whose RX is genuinely on the board's TX net hears it, so
      // the tap goes in once a link exists and the direction is real.
      if (deviceRxNet === boardTxNet) this.tapBoardSerial(runner);
    }
  }

  private setupTwoWireDisplays(runner: BoardRunner, boardInstanceId: string): void {
    const boardPinOn = (netId: string | undefined): number | null =>
      netId === undefined
        ? null
        : (this.netEndpoints.get(netId) ?? []).find((e) => e.instance === boardInstanceId)?.pin ?? null;

    for (const inst of this.graph.instances) {
      const def = this.graph.definitions.get(inst.id);
      if (def?.id !== 'comp.tm1637') continue;

      const clk = boardPinOn(this.netOfInstancePin(inst.id, 'clk'));
      const dio = boardPinOn(this.netOfInstancePin(inst.id, 'dio'));
      // Both wires have to reach this board. One of the two is a module that
      // can never be spoken to, which is a dark display rather than a fault.
      if (clk === null || dio === null) continue;

      const device = this.twoWireDeviceCache.get(inst.id) ?? new Tm1637Device(inst.id);
      this.twoWireDeviceCache.set(inst.id, device);
      this.twoWireDisplays.set(inst.id, device);

      // Seed, then follow. A line firmware sets once produces no later edge.
      device.onPinLevel('clk', runner.digitalPinLevel(clk) !== 'low');
      device.onPinLevel('dio', runner.digitalPinLevel(dio) !== 'low');

      this.unsubscribeLatches.push(
        runner.addPinListener((pin, high) => {
          if (pin === dio) device.onPinLevel('dio', high);
          if (pin === clk) device.onPinLevel('clk', high);
        }),
      );
    }
  }

  private setupParallelLcds(runner: BoardRunner, boardInstanceId: string): void {
    const boardPinOn = (netId: string | undefined): number | null =>
      netId === undefined
        ? null
        : (this.netEndpoints.get(netId) ?? []).find((e) => e.instance === boardInstanceId)?.pin ?? null;

    for (const inst of this.graph.instances) {
      const def = this.graph.definitions.get(inst.id);
      if (!def || !PARALLEL_LCD_GEOMETRY[def.id]) continue;

      const enPin = boardPinOn(this.netOfInstancePin(inst.id, 'e'));
      // No enable line reaching this board means this board cannot drive it.
      // Another board might, so this is a skip rather than a fault.
      if (enPin === null) continue;

      const watched = new Map<string, number>();
      for (const pinId of ['rs', ...LCD_DATA_PINS_8]) {
        const pin = boardPinOn(this.netOfInstancePin(inst.id, pinId));
        if (pin !== null) watched.set(pinId, pin);
      }

      const device =
        this.parallelLcdDevices.get(inst.id) ??
        new Hd44780ParallelDevice(inst.id, PARALLEL_LCD_GEOMETRY[def.id]);
      this.parallelLcdDevices.set(inst.id, device);
      // Eight-bit only when all eight data lines actually reach the board. A
      // four-wire build is the common one and must not be guessed into eight.
      device.setBusWidth(LCD_DATA_PINS_8.every((pinId) => watched.has(pinId)));

      // Seed from the live pins, then follow the edges.
      for (const [pinId, pin] of watched) {
        device.onPinLevel(pinId, runner.digitalPinLevel(pin) === 'high');
      }
      this.parallelLcds.set(inst.id, device);

      const byPin = new Map<number, string>();
      for (const [pinId, pin] of watched) byPin.set(pin, pinId);
      this.unsubscribeLatches.push(
        runner.addPinListener((pin, high) => {
          const pinId = byPin.get(pin);
          if (pinId !== undefined) device.onPinLevel(pinId, high);
          // E last, so RS and the data lines are already current when it falls.
          if (pin === enPin) device.onPinLevel('e', high);
        }),
      );
    }
  }

  private setupSpiDevices(runner: BoardRunner, boardInstanceId: string): SpiDevice[] {
    // Control-pin pads per instance, kept so an edge subscription can be
    // attached after sync() has decided which devices actually exist.
    const controlPadsByInstance = new Map<string, Map<string, number>>();
    const board = this.boardDefinitionOf(boardInstanceId);
    // Engines whose hardware SPI controller is not yet bridged to the shared
    // device models expose no bus. Attaching nothing is the honest outcome:
    // firmware talking to SPI reads an idle bus rather than a fabricated reply.
    const spiBus = runner.spiBus;
    if (!spiBus) return [];
    if (!board) {
      spiBus.sync([]);
      return [];
    }
    // Where this board's SPI lines are. An AVR bonds SCK/MOSI/MISO to fixed
    // port pins, so they come from the MCU; an RP2040 can mux them onto several
    // pin groups, so the runner reports the ones the firmware actually chose.
    const profile = avrProfileFor(board);
    const busPins = runner.activeSpiPins
      ? runner.activeSpiPins()
      : profile
        ? spiPinsFor(profile)
        : { sck: undefined, mosi: undefined, miso: undefined };
    const logicVolts = Number(board.metadata.logicVoltage ?? 5);

    // This board's pad on that net, not any board's — see setupI2cDevices.
    const netHasPin = (netId: string | undefined, pin: number | undefined): boolean =>
      netId !== undefined &&
      pin !== undefined &&
      (this.netEndpoints.get(netId) ?? []).some((e) => e.instance === boardInstanceId && e.pin === pin);

    /**
     * This board's first pad on a net — used to resolve chip-select and latch
     * lines. A CS wired to another board's GPIO is not a CS this board can
     * assert, so it must not be borrowed.
     */
    const boardPinOn = (netId: string | undefined): number | null =>
      netId === undefined
        ? null
        : (this.netEndpoints.get(netId) ?? []).find((e) => e.instance === boardInstanceId)?.pin ?? null;

    const netFedBy = (netId: string | undefined, instanceId: string, types: string[]): boolean => {
      if (netId === undefined) return false;
      const net = this.graph.nets.find((n) => n.id === netId);
      if (!net) return false;
      for (const node of net.nodes) {
        const [otherId, pinId] = splitNode(node);
        if (otherId === instanceId) continue;
        const otherDef = this.graph.definitions.get(otherId);
        const pin = otherDef?.pins.find((p) => p.id === pinId);
        if (pin && types.includes(pin.type)) return true;
      }
      return false;
    };

    const wanted: { instanceId: string; csPin: number | null; create: () => SpiDevice }[] = [];
    /** Control readers by instance, applied after sync so cached devices update too. */
    const controlReaders = new Map<string, ControlPinReader>();
    for (const inst of this.graph.instances) {
      const def = this.graph.definitions.get(inst.id);
      const model = def ? SPI_DEVICE_MODELS[def.id] : undefined;
      if (!model) continue;

      const powered = netFedBy(this.netOfInstancePin(inst.id, 'vcc'), inst.id, POWER_PIN_TYPES);
      const grounded = netFedBy(this.netOfInstancePin(inst.id, 'gnd'), inst.id, ['ground']);
      const onSck = netHasPin(this.netOfInstancePin(inst.id, model.busPins.sck), busPins.sck);
      const onMosi =
        model.busPins.mosi === null ||
        netHasPin(this.netOfInstancePin(inst.id, model.busPins.mosi), busPins.mosi);
      const onMiso =
        model.busPins.miso === null ||
        netHasPin(this.netOfInstancePin(inst.id, model.busPins.miso), busPins.miso);
      if (!powered || !grounded || !onSck || !onMosi || !onMiso) continue;

      // A part with a chip select must have it on a real board pin; without one
      // nothing can ever assert it, so the device stays off the bus.
      let csPin: number | null = null;
      if (model.busPins.cs !== null) {
        csPin = boardPinOn(this.netOfInstancePin(inst.id, model.busPins.cs));
        if (csPin === null) continue;
      }

      // Control lines resolved against THIS board's pads. A display's D/C
      // wired to another board's GPIO is not one this board can assert, so it
      // reads as unwired rather than being borrowed — the same rule the chip
      // select already follows.
      const controlPads = new Map<string, number>();
      for (const pinId of model.controlPins ?? []) {
        const pad = boardPinOn(this.netOfInstancePin(inst.id, pinId));
        if (pad !== null) controlPads.set(pinId, pad);
      }
      const readControl: ControlPinReader = (pinId) => {
        const pad = controlPads.get(pinId);
        if (pad === undefined) return undefined;
        const level = runner.digitalPinLevel(pad);
        return level === undefined ? undefined : level === 'high';
      };

      const csPinId = model.busPins.cs;
      controlReaders.set(inst.id, readControl);
      controlPadsByInstance.set(inst.id, controlPads);
      wanted.push({
        instanceId: inst.id,
        csPin,
        create: () =>
          model.create({
            instanceId: inst.id,
            address: 0, // SPI parts are selected by CS, not by address
            csPinId,
            readControl,
            logicVolts,
            radio: this.rfMedium,
            canBus: this.canBusFor(inst.id),
            nowUs: () => runner.timeMs * 1000,
            saved: inst.simulationState,
          }),
      });
    }

    const devices = spiBus.sync(wanted);

    // sync() reuses a device that already exists, so a freshly built reader
    // would otherwise only reach parts that were new this bind.
    for (const device of devices) {
      const read = controlReaders.get(device.instanceId);
      if (read && device.attachControls) device.attachControls(read);

      // A radio's CE has to be watched as an edge, not sampled. RF24's write()
      // raises it for ten microseconds and drops it again, and a per-slice
      // sample would see it low both times and never transmit anything.
      if (device instanceof Nrf24Device) {
        const cePad = controlPadsByInstance.get(device.instanceId)?.get('ce');
        if (cePad !== undefined) {
          this.unsubscribeLatches.push(
            runner.addPinListener((pin, high) => {
              if (pin === cePad) device.setCe(high);
            }),
          );
        }
      }
    }

    // Chip select changes between transactions, when no byte is being clocked,
    // so it has to be watched as a pin edge. Polling once per frame would let a
    // device miss its own deselect and treat the next command as a continuation.
    const csPins = new Set(spiBus.chipSelectPins);
    if (csPins.size > 0) {
      this.unsubscribeLatches.push(
        runner.addPinListener((pin) => {
          if (csPins.has(pin)) spiBus.refreshSelection((p) => runner.digitalPinLevel(p));
        }),
      );
    }

    // Shift registers latch on an RCLK edge, which is far too short to catch by
    // polling once per frame — subscribe to real pin edges instead.
    for (const device of devices) {
      if (!(device instanceof Sn74hc595Device)) continue;
      const instId = device.instanceId;
      const latchPin = boardPinOn(this.netOfInstancePin(instId, 'rclk'));
      this.hc595.set(instId, {
        device,
        latchPin,
        oeNet: this.netOfInstancePin(instId, 'oe'),
        clearNet: this.netOfInstancePin(instId, 'srclr'),
      });
      if (latchPin === null) continue;
      this.unsubscribeLatches.push(
        runner.addPinListener((pin, high) => {
          if (pin === latchPin && high) device.latch();
        }),
      );
    }

    for (const device of devices) {
      if (!(device instanceof Sn74hc165Device)) continue;
      const instId = device.instanceId;
      const inputNets = HC165_INPUT_PINS.map((pinId) => this.netOfInstancePin(instId, pinId));
      this.hc165.set(instId, {
        device,
        loadNet: this.netOfInstancePin(instId, 'pl'),
        enableNet: this.netOfInstancePin(instId, 'ce'),
        inputNets,
      });

      // Inputs tied straight to a rail are known before the solver ever runs,
      // and firmware can pulse PL before the first frame — so seed them now.
      let seeded = 0;
      inputNets.forEach((netId, bit) => {
        if (netId && this.supplyNets.has(netId) && !this.groundNets.has(netId)) seeded |= 1 << bit;
      });
      device.setInputs(seeded);

      // PL is asynchronous and the pulse is microseconds long: it has to be
      // watched as an edge, exactly like the 74HC595's latch.
      const loadPin = boardPinOn(this.netOfInstancePin(instId, 'pl'));
      if (loadPin === null) continue;
      this.unsubscribeLatches.push(
        runner.addPinListener((pin, high) => {
          if (pin === loadPin) device.setParallelLoad(!high);
        }),
      );
    }

    return devices;
  }

  private indexNets(): void {
    this.sourceContributions = [];
    this.declaredRails.clear();
    // Rails a module *claims* but does not source. Applied only where nothing
    // real is feeding the net, so a part wired to nothing still shows the
    // voltage it expects rather than reading as dead.
    const declaredByModules = new Map<string, number>();
    for (const net of this.graph.nets) {
      for (const node of net.nodes) {
        const [instId, pinId] = splitNode(node);
        const def = this.graph.definitions.get(instId);
        const pin = def?.pins.find((p) => p.id === pinId);
        if (!pin) continue;
        if (def?.isBoard && def.simulation?.supported === true) {
          // Ownership-carrying index, built for every simulated board on the
          // canvas rather than only the primary one.
          const ownerPin = runnerPinIndex(def, pinId);
          if (ownerPin !== undefined) {
            const list = this.netEndpoints.get(net.id) ?? [];
            list.push({ instance: instId, pin: ownerPin, board: def });
            this.netEndpoints.set(net.id, list);
          }
        }
        if (def?.isBoard && instId === this.boardInstance?.id && this.boardDef) {
          // Resolved through the board's own architecture: an RP2040 pad is
          // GP15, not "Arduino pin 15", and never resolves through the AVR map.
          const runnerPin = runnerPinIndex(this.boardDef, pinId);
          if (runnerPin !== undefined) {
            const arr = this.netBoardPins.get(net.id) ?? [];
            arr.push(runnerPin);
            this.netBoardPins.set(net.id, arr);
          }
          const channel = runnerAdcChannel(this.boardDef, pinId);
          if (channel !== undefined) {
            const chans = this.netAdcChannels.get(net.id) ?? [];
            chans.push(channel);
            this.netAdcChannels.set(net.id, chans);
          }
        }
        // Ground is sourced, not declared. A board's GND pin and a battery's
        // negative terminal are real references; a sensor module's GND pin is
        // an input, and a module wired to nothing does not become the circuit's
        // reference just by having the pin.
        if (pin.type === 'ground' && (def?.isBoard === true || def?.simulationAdapterId === 'sim.supply')) {
          this.groundNets.add(net.id);
        }
        // What a rail is at is decided by whatever actually sources it.
        //
        // A board's 5V or 3V3 pin is a real supply. A module's VCC pin is an
        // *input* — it is typed as a supply pin so wiring rules can check that
        // it is fed, but the module does not generate anything. Letting a
        // module's pin set the rail meant a 5V-labelled part wired to a Pico's
        // 3V3 made the whole net read 5V, and everything downstream of it —
        // ADC readings, logic thresholds — was then wrong by a third.
        const sources = def?.isBoard === true;
        // A regulator's output is not a declaration. It is produced, or it is
        // not — an unpowered 7805 does not put 5 V on anything, and letting its
        // output pin claim a rail would make "no input" look identical to
        // "regulating", which is the whole thing the model has to get right.
        const regulated = def ? REGULATOR_PARTS[def.id] : undefined;
        if (regulated && pinId === regulated.vout) continue;
        if (pin.type === 'power-5v') {
          if (sources) this.addSource(net.id, 5);
          else declaredByModules.set(net.id, Math.max(declaredByModules.get(net.id) ?? 0, 5));
        }
        if (pin.type === 'power-3v3') {
          if (sources) this.addSource(net.id, 3.3);
          else declaredByModules.set(net.id, Math.max(declaredByModules.get(net.id) ?? 0, 3.3));
        }
        if (pin.type === 'power-vin') {
          const inst = this.graph.instances.find((i) => i.id === instId);
          // The part's own declared voltage is the fallback, not a fixed 9 —
          // that constant was fine when the only VIN source was a 9 V battery
          // and turned a 1.5 V cell into a 9 V one the moment there was more
          // than one kind of source.
          const v =
            typeof inst?.properties.voltage === 'number'
              ? (inst.properties.voltage as number)
              : pin.voltage ?? 9;
          if (def && !def.isBoard && def.simulationAdapterId === 'sim.supply') this.addSource(net.id, v);
        }
      }
    }
    // Declarations are recorded and deliberately go no further. Nothing below
    // this line may put them into supplyNets, sourceContributions or a level:
    // an unpowered module's VCC pin is a floating pin, and a floating pin is
    // not a pin at 5 V.
    this.declaredRails = declaredByModules;
  }

  /**
   * Records one source driving one net.
   *
   * Kept as a list as well as folded into `supplyNets`, because the map is what
   * everything downstream reads for "what is this rail" and the list is what
   * makes two disagreeing sources visible as a conflict rather than as a
   * silently chosen winner.
   */
  private addSource(netId: string, volts: number): void {
    this.sourceContributions.push({ netId, volts });
    if (!this.supplyNets.has(netId)) this.supplyNets.set(netId, volts);
  }

  private buildEdges(): void {
    for (const inst of this.graph.instances) {
      const def = this.graph.definitions.get(inst.id);
      if (!def || def.isBoard) continue;
      const net = (pinId: string) => this.netOfInstancePin(inst.id, pinId);

      // Mechanical contacts first, from one shared description. A button, a
      // DIP bank and every key on a keypad are the same thing electrically, so
      // they become switch edges here rather than each getting a case below.
      // A part with contacts may still add other edges of its own.
      for (const contact of contactsOf(def.id, inst)) {
        const [a, b] = [net(contact.a), net(contact.b)];
        if (!a || !b) continue;
        this.edges.push({
          a,
          b,
          ohms: contact.ohms ?? 0,
          kind: 'switch',
          // A relay's contacts are moved by its coil rather than by a finger,
          // so they read the energised set instead of the pressed one. Same
          // contact model, different actuator — which is what a relay is.
          enabled: RELAY_PARTS[def.id]
            ? () => isContactClosed(this.energisedRelays, inst.id, contact)
            : (c) => isContactClosed(c.pressedButtons, inst.id, contact),
        });
        // Both ends are switched nets: a level driven onto one of them can
        // reach the other within a single instruction, so they cannot wait for
        // the next slice boundary to be resolved. See `watchSwitchedNets`.
        this.switchedNets.add(a);
        this.switchedNets.add(b);
      }

      switch (def.id) {
        case 'comp.resistor': {
          const [a, b] = [net('p1'), net('p2')];
          const ohms = Number(inst.properties.resistance ?? 220);
          if (a && b) this.edges.push({ a, b, ohms, kind: 'resistor', enabled: () => true });
          break;
        }
        case 'comp.ldr': {
          const [a, b] = [net('p1'), net('p2')];
          if (a && b) this.edges.push({ a, b, ohms: 10_000, kind: 'resistor', enabled: () => true });
          break;
        }
        case 'comp.toggle-switch': {
          // Kept on its own control because a toggle is a latched state rather
          // than a held one: `toggleStates` is what the UI and saved projects
          // already use for it.
          const [com, no, nc] = [net('com'), net('no'), net('nc')];
          if (com && no)
            this.edges.push({ a: com, b: no, ohms: 0, kind: 'switch', enabled: (c) => c.toggleStates.get(inst.id) === true });
          if (com && nc)
            this.edges.push({ a: com, b: nc, ohms: 0, kind: 'switch', enabled: (c) => c.toggleStates.get(inst.id) !== true });
          break;
        }
        case 'comp.diode': {
          const [a, b] = [net('anode'), net('cathode')];
          if (a && b) this.edges.push({ a, b, ohms: 1, kind: 'diode', enabled: () => true });
          break;
        }
        case 'comp.level-converter': {
          for (const [h, l] of [['hv1', 'lv1'], ['hv2', 'lv2']] as const) {
            const [a, b] = [net(h), net(l)];
            if (a && b) this.edges.push({ a, b, ohms: 0, kind: 'channel', enabled: () => true });
          }
          break;
        }
        default:
          break;
      }
    }
  }

  /**
   * Attaches IR receivers wired to this board.
   *
   * A module needs power, ground and its OUT pin on one of this board's pads,
   * exactly like every other part: a receiver with VCC unwired is not attached
   * and its pin stays wherever the board's own pull-up leaves it, which is what
   * an unpowered TSOP does.
   */
  private setupIrReceivers(runner: BoardRunner, boardInstanceId: string): void {
    for (const inst of this.graph.instances) {
      const def = this.graph.definitions.get(inst.id);
      if (def?.id !== 'comp.ir-receiver') continue;

      const outNet = this.netOfInstancePin(inst.id, 'out');
      const outPin = outNet
        ? (this.netEndpoints.get(outNet) ?? []).find((e) => e.instance === boardInstanceId)?.pin ?? null
        : null;
      if (outPin === null) continue;

      const powered = this.netFedByOther(this.netOfInstancePin(inst.id, 'vcc'), inst.id, POWER_PIN_TYPES);
      const grounded = this.netFedByOther(this.netOfInstancePin(inst.id, 'gnd'), inst.id, ['ground']);
      if (!powered || !grounded) continue;

      const cached = this.irDeviceCache.get(inst.id);
      const device =
        cached instanceof IrReceiverDevice ? cached : new IrReceiverDevice(inst.id, Number(inst.properties.carrierHz ?? NEC_CARRIER_HZ));
      this.irDeviceCache.set(inst.id, device);
      device.centreHz = Number(inst.properties.carrierHz ?? NEC_CARRIER_HZ);
      this.irReceivers.set(inst.id, { device, runner, outPin, cancels: [], cursorUs: -1, deliveredUs: -1, offsetUs: 0 });
    }
  }

  /**
   * Rebuilds every receiver's pin schedule from the medium.
   *
   * A demodulated output changes at mark boundaries, which are tens of
   * microseconds apart — far finer than a settle — so the transitions are
   * scheduled on the runner's own microsecond timeline rather than sampled.
   * The whole schedule is rebuilt whenever a new burst arrives, because a
   * second emitter starting mid-frame changes the union the receiver sees.
   */
  private pumpIrReceivers(): void {
    for (const link of this.irReceivers.values()) {
      const centre = link.device.centreHz;
      const nowUs = link.runner.timeMs * 1000;

      // Every boundary this receiver has not consumed yet, in order. An open
      // mark's start counts: it is a real transition even though its end is
      // still unknown.
      const boundaries = new Set(
        this.irMedium.transitionsAfter(centre, link.cursorUs, Math.max(this.irMedium.latestEnd(), nowUs)),
      );
      for (const start of this.irMedium.openStarts(centre)) {
        if (start > link.cursorUs) boundaries.add(start);
      }

      for (const at of [...boundaries].sort((a, b) => a - b)) {
        // Boards take turns on the shared timeline, so a receiver's board can
        // already be past the instant another board's LED lit. Delivering at
        // the absolute time would drop those boundaries, or worse collapse two
        // of them onto one instant, which is a pulse the pin never makes.
        //
        // So a burst gets ONE offset, chosen when it starts and wide enough to
        // clear the skew, and every boundary in it is delivered at that same
        // offset. The intervals — which are the entire content of an IR
        // protocol — are preserved exactly; the frame simply arrives a couple
        // of milliseconds later than it left. A constant delay is meaningless
        // to a decoder that measures gaps. Dropped marks are not.
        if (link.cursorUs < 0 || at - link.cursorUs > IR_BURST_GAP_US) {
          link.offsetUs = Math.max(0, nowUs + IR_DELIVERY_GUARD_US - at);
        }
        let deliverUs = at + link.offsetUs;
        // A backstop, never expected to fire: two boundaries must never land
        // on the same microsecond, or the pin would not move at all.
        if (deliverUs <= link.deliveredUs) deliverUs = link.deliveredUs + 1;
        link.cursorUs = at;
        link.deliveredUs = deliverUs;

        const apply = () => {
          const state = this.irMedium.sample(centre, at);
          link.device.setIlluminated(state.illuminated, deliverUs);
          link.runner.setDigitalInput(link.outPin, !state.illuminated);
        };
        if (deliverUs <= nowUs) apply();
        else link.cancels.push(link.runner.addMicrosecondEvent(deliverUs - nowUs, apply));
      }
    }
  }

  /**
   * Attaches the RS-485 transceivers wired to this board.
   *
   * The bus is identified by the net its A line sits on, so every transceiver
   * wired A-to-A shares one — which is what makes three nodes on one pair a
   * bus rather than three private links. DE and /RE are real board pads read
   * as edges, because a turnaround happens between two bytes and a per-slice
   * sample would miss it.
   */
  private setupRs485(runner: BoardRunner, boardInstanceId: string): void {
    const padOn = (instanceId: string, pinId: string): number | null => {
      const net = this.netOfInstancePin(instanceId, pinId);
      return net ? (this.netEndpoints.get(net) ?? []).find((e) => e.instance === boardInstanceId)?.pin ?? null : null;
    };

    for (const inst of this.graph.instances) {
      const def = this.graph.definitions.get(inst.id);
      if (def?.id !== 'comp.max485') continue;

      const aNet = this.netOfInstancePin(inst.id, 'a');
      if (!aNet) continue;
      const diPin = padOn(inst.id, 'di');
      const roPin = padOn(inst.id, 'ro');
      // The transceiver has to be on THIS board's UART pads to be this board's
      // transceiver. One with neither is somebody else's.
      if (diPin === null && roPin === null) continue;

      const powered = this.netFedByOther(this.netOfInstancePin(inst.id, 'vcc'), inst.id, POWER_PIN_TYPES);
      const grounded = this.netFedByOther(this.netOfInstancePin(inst.id, 'gnd'), inst.id, ['ground']);
      if (!powered || !grounded) continue;

      const bus = this.rs485Buses.get(aNet) ?? new Rs485Bus(aNet);
      this.rs485Buses.set(aNet, bus);
      const device = this.rs485DeviceCache.get(inst.id) ?? new Max485Device(inst.id);
      this.rs485DeviceCache.set(inst.id, device);
      device.setDriverEnable(false);
      bus.setDriver(inst.id, false);
      this.rs485Nodes.set(inst.id, { device, bus, runner, boardInstanceId });

      const dePin = padOn(inst.id, 'de');
      const rePin = padOn(inst.id, 're');
      const watch = (pad: number | null, apply: (high: boolean) => boolean) => {
        if (pad === null) return;
        this.irEmitterListeners.push(
          runner.addPinListener((pin, high) => {
            if (pin !== pad) return;
            if (!apply(high)) return;
            bus.setDriver(inst.id, device.driving);
          }),
        );
      };
      watch(dePin, (high) => device.setDriverEnable(high));
      watch(rePin, (high) => device.setReceiverEnable(!high));

      // The bytes themselves come off the USART, which is where an AVR puts
      // them — the TX pad is never driven, so there are no edges to carry.
      if (diPin !== null) this.tapBoardSerial(runner);
    }
  }

  /**
   * A byte leaving one board, offered to the pair its transceiver sits on.
   *
   * DE decides whether it reaches the bus at all; every node with its receiver
   * enabled hears it, INCLUDING THE SENDER if it forgot to raise /RE — which
   * is exactly the echo that catches people out. Two drivers enabled at once
   * mangle it for everybody rather than one of them winning.
   */
  private rs485ByteFromBoard(runner: BoardRunner, byte: number): void {
    for (const [instId, node] of this.rs485Nodes) {
      if (node.runner !== runner) continue;
      const carried = node.bus.carry(byte, instId);
      if (!carried) continue;
      node.device.noteSent();
      for (const listener of this.rs485Nodes.values()) {
        if (listener.bus !== node.bus) continue;
        const heard = listener.device.receive(carried);
        if (heard === null) continue;
        listener.runner.queueSerialInput(String.fromCharCode(heard));
      }
    }
  }

  /**
   * Attaches the 433 MHz parts wired to this board.
   *
   * The transmitter needs its DATA pin on one of this board's pads plus power
   * and ground; the receiver needs the same, and drives its DATA pin from the
   * medium. Neither has a protocol — the encoding lives in the sketch, which
   * is exactly why these modules get used for everything.
   */
  private setupOokParts(runner: BoardRunner, boardInstanceId: string): void {
    for (const inst of this.graph.instances) {
      const def = this.graph.definitions.get(inst.id);
      if (def?.id !== 'comp.rf433-tx' && def?.id !== 'comp.rf433-rx') continue;

      const dataNet = this.netOfInstancePin(inst.id, 'data');
      const dataPin = dataNet
        ? (this.netEndpoints.get(dataNet) ?? []).find((e) => e.instance === boardInstanceId)?.pin ?? null
        : null;
      if (dataPin === null) continue;
      const powered = this.netFedByOther(this.netOfInstancePin(inst.id, 'vcc'), inst.id, POWER_PIN_TYPES);
      const grounded = this.netFedByOther(this.netOfInstancePin(inst.id, 'gnd'), inst.id, ['ground']);
      if (!powered || !grounded) continue;

      const khz = Number(inst.properties.frequencyKhz ?? OOK_DEFAULT_KHZ);
      const cached = this.ookDeviceCache.get(inst.id);

      if (def.id === 'comp.rf433-tx') {
        const device = cached instanceof Ook433Transmitter ? cached : new Ook433Transmitter(inst.id, khz);
        device.frequencyKhz = khz;
        this.ookDeviceCache.set(inst.id, device);
        this.ookTransmitters.set(inst.id, device);
        this.irEmitterListeners.push(
          runner.addPinListener((pin, high) => {
            if (pin !== dataPin) return;
            this.ookKeyed(device, high);
          }),
        );
      } else {
        const device = cached instanceof Ook433Receiver ? cached : new Ook433Receiver(inst.id, khz);
        device.frequencyKhz = khz;
        this.ookDeviceCache.set(inst.id, device);
        this.ookReceivers.set(inst.id, {
          device, runner, dataPin, cancels: [], cursorUs: -1, deliveredUs: -1, offsetUs: 0,
        });
      }
    }
  }

  /** The DATA pin moved: the carrier goes on or off at that instant. */
  private ookKeyed(device: Ook433Transmitter, high: boolean): void {
    if (high === device.isKeyed) return;
    device.noteKeyed(high);
    const nowUs = this.irTimeUs();
    if (high) {
      this.rfMedium.beginLive(device.instanceId, device.frequencyKhz, nowUs, { modulation: OOK_MODULATION });
    } else {
      this.rfMedium.endLive(device.instanceId, nowUs);
    }
    this.pumpOokReceivers();
  }

  /**
   * Rebuilds every OOK receiver's pin schedule from the medium.
   *
   * The same machinery the infrared receivers use, for the same reason: the
   * boundaries are microseconds apart, boards take turns on the timeline, and
   * a burst gets one offset so the intervals survive exactly even when the
   * receiving board is already past the instant the carrier came on.
   */
  private pumpOokReceivers(): void {
    for (const link of this.ookReceivers.values()) {
      const nowUs = link.runner.timeMs * 1000;
      const listener = {
        band: RF_BAND,
        channel: link.device.frequencyKhz,
        match: { modulation: OOK_MODULATION },
      };
      const boundaries = new Set(this.rfMedium.waveformTransitions(listener, link.cursorUs, Number.MAX_SAFE_INTEGER));
      for (const start of this.rfMedium.openStarts(listener)) {
        if (start > link.cursorUs) boundaries.add(start);
      }

      for (const at of [...boundaries].sort((a, b) => a - b)) {
        if (link.cursorUs < 0 || at - link.cursorUs > OOK_BURST_GAP_US) {
          link.offsetUs = Math.max(0, nowUs + IR_DELIVERY_GUARD_US - at);
        }
        let deliverUs = at + link.offsetUs;
        if (deliverUs <= link.deliveredUs) deliverUs = link.deliveredUs + 1;
        link.cursorUs = at;
        link.deliveredUs = deliverUs;

        const apply = () => {
          const state = this.rfMedium.sampleWaveform(listener, at);
          link.device.setEnergised(state.energised, deliverUs, state.sources);
          link.runner.setDigitalInput(link.dataPin, state.energised);
        };
        if (deliverUs <= nowUs) apply();
        else link.cancels.push(link.runner.addMicrosecondEvent(deliverUs - nowUs, apply));
      }
    }
  }

  /**
   * Attaches IR LEDs the firmware itself drives.
   *
   * The anode has to be on one of this board's pads and the cathode has to
   * reach a real ground, because an LED with its cathode in the air does not
   * light. Nothing is emitted from the wiring alone: light only exists while
   * the pin is actually toggling.
   */
  private setupIrEmitters(runner: BoardRunner, boardInstanceId: string): void {
    for (const inst of this.graph.instances) {
      const def = this.graph.definitions.get(inst.id);
      if (def?.id !== 'comp.ir-led') continue;

      const anodeNet = this.netOfInstancePin(inst.id, 'anode');
      const pin = anodeNet
        ? (this.netEndpoints.get(anodeNet) ?? []).find((e) => e.instance === boardInstanceId)?.pin ?? null
        : null;
      if (pin === null) continue;
      if (!this.netFedByOther(this.netOfInstancePin(inst.id, 'cathode'), inst.id, ['ground'])) continue;

      const state: IrEmitterState = {
        instanceId: inst.id,
        runner,
        pin,
        lastEdgeUs: -1,
        carrierHz: 0,
        cancelGap: null,
        edges: 0,
        markStartUs: -1,
        markEdges: 0,
      };
      this.irEmitters.set(inst.id, state);
      this.irEmitterListeners.push(runner.addPinListener((changed) => {
        if (changed !== state.pin) return;
        this.irEdge(state);
      }));
    }
  }

  /**
   * One edge on an IR LED's pin.
   *
   * A demodulating receiver does not see individual carrier cycles; it sees
   * whether a carrier is there. So the model does what the receiver's own
   * bandpass does: two edges close enough together are a carrier, and the
   * frequency is MEASURED from their spacing rather than assumed. A sketch
   * that generates 56 kHz emits 56 kHz here and a 38 kHz module will not hear
   * it — which is the mistake this is worth modelling for.
   *
   * The mark ends when the toggling stops, found with a timer rearmed on every
   * edge. A NEC space is 560 us at the shortest, twenty times the gap that
   * ends a mark, so there is no ambiguity between "between cycles" and
   * "between marks".
   */
  private irEdge(state: IrEmitterState): void {
    const nowUs = state.runner.timeMs * 1000;
    state.edges++;
    const gap = state.lastEdgeUs >= 0 ? nowUs - state.lastEdgeUs : Infinity;

    if (gap <= IR_CARRIER_MAX_GAP_US) {
      if (!this.irMedium.isLive(state.instanceId)) {
        // The mark began at the first of the two edges, not the second.
        state.markStartUs = state.lastEdgeUs;
        state.markEdges = 2;
        state.carrierHz = 1_000_000 / (2 * gap);
        this.irMedium.beginLive(state.instanceId, state.carrierHz, state.markStartUs);
        this.pumpIrReceivers();
      } else {
        // Averaged over the whole mark rather than taken from one cycle. A
        // sketch's carrier loop has a longer gap at each mark boundary, and
        // judging the burst on that one cycle would throw an in-band mark out
        // of band — which is not what a bandpass does.
        state.markEdges++;
        const span = nowUs - state.markStartUs;
        if (span > 0) {
          state.carrierHz = ((state.markEdges - 1) * 1_000_000) / (2 * span);
          this.irMedium.setLiveCarrier(state.instanceId, state.carrierHz);
        }
      }
    }
    state.lastEdgeUs = nowUs;

    state.cancelGap?.();
    state.cancelGap = state.runner.addMicrosecondEvent(IR_MARK_END_GAP_US, () => {
      state.cancelGap = null;
      if (!this.irMedium.isLive(state.instanceId)) return;
      // The light stopped at the last edge, not when the timer noticed.
      this.irMedium.endLive(state.instanceId, nowUs);
      this.pumpIrReceivers();
    });
  }

  /**
   * Presses on the virtual remotes, and the bursts they put in the air.
   *
   * The remote is not wired to anything and does not need to be — it is a
   * light source. It cannot name a receiver, so it cannot reach one it should
   * not, and two remotes held at once collide in the medium rather than being
   * arbitrated anywhere.
   */
  private updateIr(controls: SimControls): void {
    const nowUs = this.irTimeUs();

    for (const inst of this.graph.instances) {
      const def = this.graph.definitions.get(inst.id);
      if (def?.id !== 'comp.ir-remote') continue;

      const cached = this.irDeviceCache.get(inst.id);
      const remote = cached instanceof IrRemoteDevice ? cached : new IrRemoteDevice(inst.id);
      this.irDeviceCache.set(inst.id, remote);
      this.irRemotes.set(inst.id, remote);
      remote.address = Number(inst.properties.address ?? 0) & 0xffff;
      remote.extended = inst.properties.extended === true;
      remote.carrierHz = Number(inst.properties.carrierHz ?? NEC_CARRIER_HZ);

      const pressed = new Set<string>();
      for (const button of STARTER_REMOTE_KEYS) {
        if (controls.pressedButtons.has(contactStateKey(inst.id, button.key))) pressed.add(button.key);
      }
      for (const burst of remote.update(pressed, nowUs)) {
        this.irMedium.emit(inst.id, remote.carrierHz, burst);
      }
    }

    this.pumpIrReceivers();
    for (const link of this.irReceivers.values()) {
      link.device.flushIfIdle(link.runner.timeMs * 1000);
    }
    // Marks that finished more than a frame ago cannot affect anything.
    this.irMedium.prune(nowUs - 100000);
  }

  /** The shared timeline, as the medium sees it. Every runner is on it. */
  private irTimeUs(): number {
    let us = 0;
    for (const r of this.runners.values()) us = Math.max(us, r.timeMs * 1000);
    return us;
  }

  private setupUltrasonic(runner: BoardRunner): void {
    for (const inst of this.graph.instances) {
      const def = this.graph.definitions.get(inst.id);
      if (def?.id !== 'comp.ultrasonic') continue;
      const trigNet = this.netOfInstancePin(inst.id, 'trig');
      const echoNet = this.netOfInstancePin(inst.id, 'echo');
      const trigPin = trigNet ? this.netBoardPins.get(trigNet)?.[0] ?? null : null;
      const echoPin = echoNet ? this.netBoardPins.get(echoNet)?.[0] ?? null : null;
      this.ultrasonic.set(inst.id, { trigPin, echoPin, trigHighAtUs: -1, cancelEcho: [] });
    }
    if (this.ultrasonic.size === 0) return;

    const previous = runner.onPinChange;
    runner.onPinChange = (pin, high) => {
      previous?.(pin, high);
      for (const [instId, state] of this.ultrasonic) {
        if (pin !== state.trigPin || state.echoPin === null) continue;
        const nowUs = runner.timeMs * 1000;
        if (high) {
          state.trigHighAtUs = nowUs;
        } else if (state.trigHighAtUs >= 0 && nowUs - state.trigHighAtUs >= 9) {
          // Valid >=10us trigger pulse: reply with an echo pulse whose width
          // encodes the user-set distance (58 us per cm).
          state.cancelEcho.forEach((c) => c());
          state.cancelEcho = [];
          const inst = this.graph.instances.find((i) => i.id === instId);
          const distanceCm = Number(
            (inst?.simulationState.distanceCm as number | undefined) ?? this.controlsRef?.sensorValues.get(instId) ?? 100,
          );
          const widthUs = Math.max(58, distanceCm * 58);
          const echoPin = state.echoPin;
          state.cancelEcho.push(
            runner.addMicrosecondEvent(200, () => runner.setDigitalInput(echoPin, true)),
            runner.addMicrosecondEvent(200 + widthUs, () => runner.setDigitalInput(echoPin, false)),
          );
          state.trigHighAtUs = -1;
        }
      }
    };
  }


  /**
   * Attaches I2C device models for parts that are genuinely wired to the
   * board's I2C bus. A display with SDA/SCL on the wrong pins, or with no
   * power, is not attached at all — so firmware addressing it gets a NACK,
   * exactly as it would on a breadboard.
   */
  private setupI2cDevices(runner: BoardRunner, boardInstanceId: string): I2cDevice[] {
    const board = this.boardDefinitionOf(boardInstanceId);
    // See setupSpiDevices: an engine with no bridged I2C controller attaches
    // no devices rather than pretending they replied.
    const i2cBus = runner.i2cBus;
    if (!i2cBus) return [];
    if (!board) {
      i2cBus.sync([]);
      return [];
    }
    // Board-side SDA/SCL as runner pin indices. An AVR's TWI lines are fixed
    // silicon, so they come from the board's own metadata (A4/A5 on Uno,
    // D20/D21 on Mega, D2/D3 on Leonardo). An RP2040 can put I2C on several
    // pin pairs and a sketch may call Wire.setSDA(), so the runner reports
    // whichever pads are currently muxed to the I2C function.
    const busPins = new Set<number>();
    let sdaPin: number | undefined;
    let sclPin: number | undefined;
    if (runner.activeI2cPins) {
      const active = runner.activeI2cPins();
      sdaPin = active.sda;
      sclPin = active.scl;
      if (sdaPin !== undefined) busPins.add(sdaPin);
      if (sclPin !== undefined) busPins.add(sclPin);
    } else {
      // Through the board's bus profile rather than its metadata: a native
      // board's TWI pins are in its metadata, a custom board's come from its
      // processor and its pad map, and the profile is the one place that knows
      // both. Reading metadata here meant a custom AVR board's I2C_DATA pin
      // could be wired perfectly and no device would ever attach to it.
      const profile = getBoardBusProfile(board);
      for (const channel of profile?.channels ?? []) {
        const sdaId = channel.defaults['i2c-sda'];
        const sclId = channel.defaults['i2c-scl'];
        if (!sdaId || !sclId) continue;
        // The first I2C channel with both lines brought out is the one
        // `Wire` starts on, which is the bus a device with no further
        // configuration is sitting on.
        sdaPin = runnerPinIndex(board, sdaId);
        sclPin = runnerPinIndex(board, sclId);
        for (const pinId of [...(channel.pins['i2c-sda'] ?? []), ...(channel.pins['i2c-scl'] ?? [])]) {
          const n = runnerPinIndex(board, pinId);
          if (n !== undefined) busPins.add(n);
        }
        break;
      }
    }

    // This board's pad on that net, not any board's: two Picos both have a
    // GP4, and a device on one of them is not on the other.
    const netHasPin = (netId: string | undefined, pin: number | undefined): boolean =>
      netId !== undefined &&
      pin !== undefined &&
      (this.netEndpoints.get(netId) ?? []).some((e) => e.instance === boardInstanceId && e.pin === pin);

    /**
     * True when some OTHER instance drives this net with a pin of one of the
     * given types. A module's own VCC/GND pins are typed as power/ground, so
     * membership in supplyNets alone would let an unconnected board claim it
     * is powered — the device must be fed from outside itself.
     */
    const netFedBy = (netId: string | undefined, instanceId: string, types: string[]): boolean => {
      if (netId === undefined) return false;
      const net = this.graph.nets.find((n) => n.id === netId);
      if (!net) return false;
      for (const node of net.nodes) {
        const [otherId, pinId] = splitNode(node);
        if (otherId === instanceId) continue;
        const otherDef = this.graph.definitions.get(otherId);
        const pin = otherDef?.pins.find((p) => p.id === pinId);
        if (pin && types.includes(pin.type)) return true;
      }
      return false;
    };

    const wanted: { instanceId: string; create: () => I2cDevice }[] = [];
    for (const inst of this.graph.instances) {
      const def = this.graph.definitions.get(inst.id);
      const model = def ? I2C_DEVICE_MODELS[def.id] : undefined;
      if (!model) continue;
      const sdaNet = this.netOfInstancePin(inst.id, 'sda');
      const sclNet = this.netOfInstancePin(inst.id, 'scl');
      const vccNet = this.netOfInstancePin(inst.id, 'vcc');
      const gndNet = this.netOfInstancePin(inst.id, 'gnd');
      const wiredToBus = netHasPin(sdaNet, sdaPin) && netHasPin(sclNet, sclPin);
      const powered = netFedBy(vccNet, inst.id, POWER_PIN_TYPES);
      const grounded = netFedBy(gndNet, inst.id, ['ground']);
      if (!wiredToBus || !powered || !grounded) continue;

      // Explicit property wins; otherwise an address-select pin tied to a
      // supply picks the alternate address, exactly like the AD0 strap.
      const raw = inst.properties.i2cAddress;
      const explicit = raw === undefined || raw === '' ? Number.NaN : Number(raw);
      let address: number;
      if (Number.isFinite(explicit)) {
        address = explicit;
      } else if (
        model.addressSelect &&
        netFedBy(this.netOfInstancePin(inst.id, model.addressSelect.pinId), inst.id, POWER_PIN_TYPES)
      ) {
        address = model.addressSelect.alternateAddress;
      } else {
        address = model.defaultAddress;
      }
      wanted.push({
        instanceId: inst.id,
        create: () =>
          model.create({
            instanceId: inst.id,
            address,
            logicVolts: Number(board.metadata.logicVoltage ?? 5),
            nowUs: () => runner.timeMs * 1000,
            saved: inst.simulationState,
          }),
      });
    }
    return i2cBus.sync(wanted);
  }

  /**
   * A device model by instance, from whichever board's bus holds it.
   *
   * Visuals must not be read off the primary board alone. An LCD wired to the
   * second board's I2C pads is attached to *that* board's bus, and consulting
   * only the first would draw a blank display for a display that is working.
   * With one board this is the same single lookup it always was.
   */
  private i2cDeviceFor(instanceId: string): I2cDevice | undefined {
    for (const runner of this.runners.values()) {
      const device = runner.i2cBus?.deviceFor(instanceId);
      if (device) return device;
    }
    return undefined;
  }

  /** As `i2cDeviceFor`, for parts on a board's SPI bus. */
  private spiDeviceFor(instanceId: string): SpiDevice | undefined {
    for (const runner of this.runners.values()) {
      const device = runner.spiBus?.deviceFor(instanceId);
      if (device) return device;
    }
    return undefined;
  }

  /**
   * Feeds a joystick's two wipers to the ADC channels they are wired to.
   *
   * The axes really are two potentiometers across the module's supply, so this
   * imposes a wiper voltage the same way the potentiometer part does rather
   * than handing the firmware an axis number. A stick whose VRx is wired to a
   * pin with no ADC drives nothing, which is the correct outcome.
   */
  private driveJoystickAxes(
    instanceId: string,
    controls: SimControls,
    runner: BoardRunner | null,
    levelOf: (netId: string | undefined) => NetLevel | undefined,
  ): void {
    if (!runner) return;
    const supply = this.joystickSupply(instanceId, levelOf);
    // Unpowered: the wipers impose nothing at all, so the pin reads whatever
    // else is holding it rather than a value the hardware could not produce.
    if (supply <= 0) return;
    for (const [pinId, axis] of [['vrx', 'x'], ['vry', 'y']] as const) {
      const netId = this.netOfInstancePin(instanceId, pinId);
      const channel = netId ? this.netAdcChannels.get(netId)?.[0] : undefined;
      if (channel === undefined) continue;
      // Centred is half scale, which is what a real stick at rest reads.
      const position = controls.potPositions.get(`${instanceId}#${axis}`) ?? 0.5;
      runner.setAnalogVolts(channel, supply * position);
    }
  }

  /**
   * The voltage actually reaching a joystick's VCC pin.
   *
   * Read from the solved net rather than from the supply index, because a
   * module's own VCC pin is an input: it is typed as a supply pin so wiring
   * rules can check it, but what the potentiometers are actually across is
   * whatever the board put on that wire. A stick on a 3.3V rail must not read
   * as though it were on 5V.
   */
  private joystickSupply(
    instanceId: string,
    levelOf: (netId: string | undefined) => NetLevel | undefined,
  ): number {
    const vccNet = this.netOfInstancePin(instanceId, 'vcc');
    const solved = levelOf(vccNet)?.volts;
    if (solved != null && solved > 0) return solved;
    return vccNet ? this.supplyNets.get(vccNet) ?? 0 : 0;
  }

  /** Running logic parts, by component instance id. */
  private logicDevices = new Map<string, LogicIcDevice>();

  /**
   * Directly-wired character LCDs, live for this binding.
   *
   * Two maps because a re-bind is a wiring edit, not a power cycle: the device
   * (and the text on it) survives in `parallelLcdDevices`, while
   * `parallelLcds` holds only the ones currently reachable from a board.
   */
  private parallelLcdDevices = new Map<string, Hd44780ParallelDevice>();
  private parallelLcds = new Map<string, Hd44780ParallelDevice>();

  /** WS2812 strips, kept across re-binds for the same reason the LCDs are. */
  private addressableLedDevices = new Map<string, Ws2812Device>();
  /**
   * The strips currently reachable, each with the board that drives it.
   *
   * The runner is carried here because a frame latches on elapsed time rather
   * than on an edge, and "elapsed" means elapsed on the clock of the board
   * whose pin is driving this strip — which on a two-board canvas is not
   * necessarily the primary one.
   */
  private addressableLeds = new Map<string, { device: Ws2812Device; runner: BoardRunner }>();

  /** TM1637 modules, kept across re-binds the way the other parts are. */
  private twoWireDeviceCache = new Map<string, Tm1637Device>();
  private twoWireDisplays = new Map<string, Tm1637Device>();

  /** UART devices, kept across re-binds so a GPS does not lose its fix. */
  private uartDeviceCache = new Map<string, UartPeripheral>();
  private uartLinks = new Map<string, { link: UartLink; runner: BoardRunner }>();

  /** Serial-out taps, keyed by runner, so a re-bind cannot stack them. */
  private serialTaps = new Map<BoardRunner, () => void>();

  /** The baud last pushed from a part's property, so AT+UART= is not undone. */
  private appliedUartBaud = new Map<string, number>();

  /**
   * The room's infrared, shared by every IR part on the canvas.
   *
   * One medium rather than a link per pair, because IR is not addressed: a
   * remote flashes an LED and whoever can see it sees it. Kept on the binding
   * so a re-bind does not throw away a burst that is still in flight.
   */
  private readonly irMedium = new IrMedium();
  /**
   * The room's radio, shared by every RF part on the canvas.
   *
   * One medium for every family, so an nRF24 and a LoRa module on the same
   * band are representable and a second radio family is a register map rather
   * than another transport.
   */
  private readonly rfMedium = new RfMedium();
  private irReceivers = new Map<
    string,
    {
      device: IrReceiverDevice;
      runner: BoardRunner;
      outPin: number;
      cancels: (() => void)[];
      /** Last medium boundary consumed, so none is applied twice or missed. */
      cursorUs: number;
      /** When that boundary reached this receiver's own clock. */
      deliveredUs: number;
      /** Delay applied to every boundary of the current burst. */
      offsetUs: number;
    }
  >();
  private irRemotes = new Map<string, IrRemoteDevice>();
  private irEmitters = new Map<string, IrEmitterState>();
  private irEmitterListeners: (() => void)[] = [];

  /** On-off-keyed 433 MHz parts: a waveform path, not a packet radio. */
  private ookTransmitters = new Map<string, Ook433Transmitter>();
  private ookReceivers = new Map<
    string,
    {
      device: Ook433Receiver;
      runner: BoardRunner;
      dataPin: number;
      cancels: (() => void)[];
      cursorUs: number;
      deliveredUs: number;
      offsetUs: number;
    }
  >();
  private ookDeviceCache = new Map<string, Ook433Transmitter | Ook433Receiver>();

  /**
   * CAN: one bus object per CANH net on the canvas.
   *
   * Same idea as the RS-485 pair — controllers wired CANH-to-CANH share a
   * wire, and a project with two independent buses gets two objects that know
   * nothing about each other.
   */
  private canBuses = new Map<string, CanBus>();
  private canBusFor(instanceId: string): CanBus {
    const key = this.netOfInstancePin(instanceId, 'canh') ?? `solo:${instanceId}`;
    const existing = this.canBuses.get(key);
    if (existing) return existing;
    const bus = new CanBus(key);
    this.canBuses.set(key, bus);
    return bus;
  }
  /** A CAN bus, for tests and the inspector. */
  canBusOf(instanceId: string): CanBus | undefined {
    const key = this.netOfInstancePin(instanceId, 'canh');
    return key ? this.canBuses.get(key) : undefined;
  }

  /** RS-485: one bus object per differential pair on the canvas. */
  private rs485Buses = new Map<string, Rs485Bus>();
  private rs485Nodes = new Map<
    string,
    { device: Max485Device; bus: Rs485Bus; runner: BoardRunner; boardInstanceId: string }
  >();
  private rs485DeviceCache = new Map<string, Max485Device>();

  /** A transceiver's model, for the canvas and the inspector. */
  rs485DeviceFor(instanceId: string): Max485Device | undefined {
    return this.rs485DeviceCache.get(instanceId);
  }
  /** The bus a transceiver sits on, for tests and the inspector. */
  rs485BusFor(instanceId: string): Rs485Bus | undefined {
    return this.rs485Nodes.get(instanceId)?.bus;
  }

  /** An OOK part's model, for the canvas and the inspector. */
  ookDeviceFor(instanceId: string): Ook433Transmitter | Ook433Receiver | undefined {
    return this.ookDeviceCache.get(instanceId);
  }
  /** Models kept across re-binds, so a receiver does not forget what it saw. */
  private irDeviceCache = new Map<string, IrReceiverDevice | IrRemoteDevice>();

  /** An IR part's model, for the canvas and the inspector. */
  irDeviceFor(instanceId: string): IrReceiverDevice | IrRemoteDevice | undefined {
    return this.irDeviceCache.get(instanceId);
  }
  /** The shared medium, for the inspector and for tests. */
  get infrared(): IrMedium {
    return this.irMedium;
  }

  /** A UART device's link, for the canvas and the inspector. */
  uartLinkFor(instanceId: string): UartLink | undefined {
    return this.uartLinks.get(instanceId)?.link;
  }
  uartDeviceFor(instanceId: string): UartPeripheral | undefined {
    return this.uartDeviceCache.get(instanceId);
  }

  /** A TM1637's model, for the canvas and the inspector. */
  tm1637For(instanceId: string): Tm1637Device | undefined {
    return this.twoWireDisplays.get(instanceId);
  }

  /** A strip's model, for the canvas and the inspector. */
  addressableLedFor(instanceId: string): Ws2812Device | undefined {
    return this.addressableLeds.get(instanceId)?.device;
  }

  /** A directly-wired LCD's model, for the canvas and the inspector. */
  parallelLcdFor(instanceId: string): Hd44780ParallelDevice | undefined {
    return this.parallelLcds.get(instanceId);
  }

  /** Last resolved level of each logic clock net, for edge detection. */
  private logicClockLevels = new Map<string, Logic>();

  /** Nets a logic part reports as oscillating, so the UI can say so. */
  readonly unstableNets = new Set<string>();

  /**
   * Apparent brightness of every multiplexed element on the canvas.
   *
   * Lives on the binding rather than on a device because these parts have no
   * device model at all — they are LEDs and wire, and what makes them a display
   * is the firmware scanning them.
   */
  private readonly persistence = new PersistenceTracker();

  /**
   * Contact keys held closed by an energised relay coil.
   *
   * Updated once per settle from the coil voltage, which means the contacts
   * follow the coil by one slice. That is not a shortcut — a real relay takes
   * five to ten milliseconds to pull in, and one simulation slice is one
   * millisecond, so the modelled armature is if anything faster than the metal
   * one. It also breaks the loop cleanly: a relay whose contacts feed its own
   * coil oscillates at a bounded rate here, as a buzzer made from a relay
   * genuinely does.
   */
  private energisedRelays = new Set<string>();

  /**
   * Motors, steppers and drivers, kept across re-binds.
   *
   * A wiring edit rebinds the circuit; it does not unwind a shaft. Keeping the
   * models means a stepper that has taken four hundred steps still has taken
   * four hundred steps after a wire is moved, which is what the hardware would
   * do and what makes the position meaningful at all.
   */
  private readonly motors = new Map<string, MotorModel>();
  private readonly encoders = new Map<string, QuadratureEncoder>();
  private readonly coilSteppers = new Map<string, CoilStepper>();
  private readonly stepDrivers = new Map<string, StepDirDriver>();

  /** A motor's model, for the canvas and the inspector. */
  motorFor(instanceId: string): MotorModel | undefined {
    return this.motors.get(instanceId);
  }
  coilStepperFor(instanceId: string): CoilStepper | undefined {
    return this.coilSteppers.get(instanceId);
  }
  stepDriverFor(instanceId: string): StepDirDriver | undefined {
    return this.stepDrivers.get(instanceId);
  }

  /**
   * Puts every multiplexed part's pins on the switched-net list.
   *
   * A scan drives a common low, sets the segment lines, and moves on inside a
   * few hundred microseconds. Settling once per millisecond slice would sample
   * whichever digit happened to be enabled at the boundary and miss the rest,
   * so these nets get the same edge subscriptions a keypad's rows get.
   */
  private markMultiplexedNets(): void {
    for (const inst of this.graph.instances) {
      const def = this.graph.definitions.get(inst.id);
      if (!def) continue;

      const spec = MULTIPLEXED_PARTS[def.id];
      if (spec) {
        for (const pinId of [...spec.commons, ...spec.elements]) {
          const netId = this.netOfInstancePin(inst.id, pinId);
          if (netId) this.switchedNets.add(netId);
        }
      }

      // A stepper's coil lines and an A4988's STEP pin move far faster than a
      // slice: a sketch stepping at 1 kHz changes them every 500 us, and
      // settling once a millisecond would see a fraction of the transitions
      // and count a fraction of the steps.
      const coils = COIL_STEPPER_PARTS[def.id];
      if (coils) {
        for (const pinId of coils.coils) {
          const netId = this.netOfInstancePin(inst.id, pinId);
          if (netId) this.switchedNets.add(netId);
        }
      }
      if (STEP_DIR_PARTS[def.id]) {
        for (const pinId of ['step', 'dir', 'en']) {
          const netId = this.netOfInstancePin(inst.id, pinId);
          if (netId) this.switchedNets.add(netId);
        }
      }
    }
  }

  /**
   * Advances every motor, stepper and driver from the settled net levels.
   *
   * Everything here reads voltages and pin levels; nothing reads firmware
   * intent. A motor turns because there is a difference across its terminals, a
   * stepper moves because the coil pattern changed to an adjacent one, and an
   * A4988 steps because an edge arrived on STEP while ENABLE was low. That is
   * the whole point: a missing ground, a backwards bridge or an unwired enable
   * pin all produce a part that does nothing, exactly as on a bench.
   */
  private updateMotors(levels: Map<string, NetLevel>, nowMs: number): void {
    const voltsOn = (instanceId: string, pinId: string): number | null => {
      const netId = this.netOfInstancePin(instanceId, pinId);
      if (!netId) return null; // not wired: floating, which is not zero
      const v = levels.get(netId)?.volts;
      return v == null ? null : v;
    };
    const isHigh = (instanceId: string, pinId: string): boolean => {
      const v = voltsOn(instanceId, pinId);
      return v != null && v >= 1.6;
    };

    for (const inst of this.graph.instances) {
      const def = this.graph.definitions.get(inst.id);
      if (!def) continue;

      const motorSpec = MOTOR_PARTS[def.id];
      if (motorSpec) {
        let motor = this.motors.get(inst.id);
        if (!motor) {
          motor = new MotorModel(inst.id, motorSpec.ratedVolts, motorSpec.ratedRpm);
          this.motors.set(inst.id, motor);
          if (motorSpec.encoderPpr) {
            this.encoders.set(inst.id, new QuadratureEncoder(motorSpec.encoderPpr));
          }
        }
        motor.update(voltsOn(inst.id, motorSpec.plus), voltsOn(inst.id, motorSpec.minus), nowMs);
        continue;
      }

      const coilSpec = COIL_STEPPER_PARTS[def.id];
      if (coilSpec) {
        let stepper = this.coilSteppers.get(inst.id);
        if (!stepper) {
          stepper = new CoilStepper(inst.id, coilSpec.stepsPerRevolution);
          this.coilSteppers.set(inst.id, stepper);
        }
        const [a, b, c, d] = coilSpec.coils.map((pinId) => isHigh(inst.id, pinId));
        stepper.setCoils(a, b, c, d, nowMs);
        continue;
      }

      if (STEP_DIR_PARTS[def.id]) {
        let driver = this.stepDrivers.get(inst.id);
        if (!driver) {
          driver = new StepDirDriver(inst.id, STEP_DIR_PARTS[def.id].fullStepsPerRevolution);
          this.stepDrivers.set(inst.id, driver);
        }
        // ENABLE is active low, and an unwired pin is NOT low — a floating
        // enable on an A4988 board is pulled low by its own resistor, so the
        // part is enabled when nothing drives it, which is what the hardware
        // does and why most sketches never touch the pin.
        const enableVolts = voltsOn(inst.id, 'en');
        driver.setEnable(enableVolts == null || enableVolts < 1.6);
        driver.setMicrostepping(isHigh(inst.id, 'ms1'), isHigh(inst.id, 'ms2'), isHigh(inst.id, 'ms3'));
        driver.setDirection(isHigh(inst.id, 'dir'));
        driver.setStep(isHigh(inst.id, 'step'));
      }
    }
  }

  /** Creates a device per logic-part instance on the canvas. */
  private setupLogicDevices(): void {
    this.logicDevices.clear();
    for (const inst of this.graph.instances) {
      const def = this.graph.definitions.get(inst.id);
      const spec = def ? LOGIC_PARTS[def.id] : undefined;
      if (!spec) continue;
      // Supply comes from the part's own Vcc net so a 3.3V-powered gate uses
      // 3.3V thresholds. Unpowered parts are skipped entirely below.
      const vccNet = this.netOfInstancePin(inst.id, 'vcc');
      const supply = (vccNet ? this.supplyNets.get(vccNet) : undefined) ?? 5;
      this.logicDevices.set(inst.id, new LogicIcDevice(inst.id, spec, supply));
      // Inputs and clocks are switched nets: firmware driving a clock must be
      // seen at once rather than at the next slice boundary.
      for (const pin of spec.pins) {
        if (pin.direction !== 'in') continue;
        const netId = this.netOfInstancePin(inst.id, pin.id);
        if (netId) this.switchedNets.add(netId);
      }
    }
  }

  /**
   * Whether a logic part has power on both rails.
   *
   * An unpowered 74HC does not output logic levels — it does nothing at all.
   * Modelling that honestly is what makes "I forgot to wire Vcc" a discoverable
   * mistake rather than a circuit that mysteriously works.
   */
  private logicPowered(instanceId: string, levels: Map<string, NetLevel>): boolean {
    const vccNet = this.netOfInstancePin(instanceId, 'vcc');
    const gndNet = this.netOfInstancePin(instanceId, 'gnd');
    if (!vccNet || !gndNet) return false;
    // Both rails must be fed from outside the part. Its own Vcc and GND pins
    // are typed as power pins so wiring rules can check them, but a chip does
    // not power itself — and without this an IC dropped on the canvas with
    // nothing connected would appear to work.
    if (!this.netFedByOther(vccNet, instanceId, POWER_PIN_TYPES)) return false;
    if (!this.netFedByOther(gndNet, instanceId, ['ground'])) return false;
    const vcc = levels.get(vccNet)?.volts ?? this.supplyNets.get(vccNet) ?? null;
    return vcc !== null && vcc > 1;
  }

  /**
   * True when some OTHER instance drives this net with a pin of the given
   * types.
   *
   * The exclusion is the whole point: a module's own VCC or GND pin sitting on
   * a net does not mean the net is powered or grounded, it means the module
   * would like it to be.
   */
  private netFedByOther(netId: string | undefined, instanceId: string, types: string[]): boolean {
    if (netId === undefined) return false;
    const net = this.graph.nets.find((n) => n.id === netId);
    if (!net) return false;
    for (const node of net.nodes) {
      const [otherId, pinId] = splitNode(node);
      if (otherId === instanceId) continue;
      const otherDef = this.graph.definitions.get(otherId);
      const pin = otherDef?.pins.find((p) => p.id === pinId);
      if (pin && types.includes(pin.type)) return true;
    }
    return false;
  }

  /**
   * Runs every logic part to a fixed point and drives its outputs onto nets.
   *
   * Clock edges are taken once per settle, from the level a clock net had at
   * the end of the previous settle — so a pulse is one edge however many
   * rounds the combinational logic then needs to stabilise.
   */
  private settleLogic(
    levels: Map<string, NetLevel>,
    setLevel: (netId: string, volts: number, sourcePin: number | null, seriesOhms: number) => void,
    propagate: () => void,
    drivenNets: Set<string>,
  ): void {
    this.unstableNets.clear();

    const levelAt = (instanceId: string, pinId: string): Logic => {
      const netId = this.netOfInstancePin(instanceId, pinId);
      if (!netId) return 'x';
      const device = this.logicDevices.get(instanceId);
      return levelOfVolts(levels.get(netId)?.volts ?? null, device?.supply ?? 5);
    };
    const voltsAt = (instanceId: string, pinId: string): number | null => {
      const netId = this.netOfInstancePin(instanceId, pinId);
      return netId ? levels.get(netId)?.volts ?? null : null;
    };

    // Edges first, using the previous settle's levels — one pulse, one edge.
    for (const [instanceId, device] of this.logicDevices) {
      if (!this.logicPowered(instanceId, levels)) continue;
      for (const { pin, edge } of device.clockPins) {
        const netId = this.netOfInstancePin(instanceId, pin);
        if (!netId) continue;
        const key = `${instanceId}:${pin}`;
        const now = levelOfVolts(levels.get(netId)?.volts ?? null, device.supply);
        const before = this.logicClockLevels.get(key) ?? 'x';
        this.logicClockLevels.set(key, now);
        const rose = before === 0 && now === 1;
        const fell = before === 1 && now === 0;
        if ((edge === 'rising' && rose) || (edge === 'falling' && fell)) {
          device.clockEdge(pin, edge, (p) => levelAt(instanceId, p), (p) => voltsAt(instanceId, p));
        }
      }
    }

    // Then combinational settling.
    const MAX_ROUNDS = 10;
    let previous = '';
    for (let round = 0; round < MAX_ROUNDS; round++) {
      let signature = '';
      for (const [instanceId, device] of this.logicDevices) {
        if (!this.logicPowered(instanceId, levels)) continue;
        const outputs = device.evaluate(
          (p) => levelAt(instanceId, p),
          (p) => voltsAt(instanceId, p),
        );
        for (const [pinId, value] of Object.entries(outputs)) {
          signature += `${instanceId}:${pinId}=${value};`;
          // High-Z and unknown drive nothing at all. That is the difference
          // between a released bus and a bus held low, and collapsing them
          // would make every tri-state part pointless.
          if (value === 'z' || value === 'x') continue;
          const netId = this.netOfInstancePin(instanceId, pinId);
          if (!netId) continue;
          setLevel(netId, value === 1 ? device.supply : 0, null, 0);
          drivenNets.add(netId);
        }
      }
      propagate();
      if (signature === previous) return;
      previous = signature;
    }

    // Still moving after the round limit: the circuit oscillates. Reported,
    // not silently frozen at whatever the last round happened to produce.
    for (const [instanceId, device] of this.logicDevices) {
      for (const pin of device.spec.pins) {
        if (pin.direction !== 'out') continue;
        const netId = this.netOfInstancePin(instanceId, pin.id);
        if (netId) this.unstableNets.add(netId);
      }
    }
  }

  /**
   * The voltage actually reaching a module's VCC pin, or zero if nothing is.
   *
   * A module's own VCC pin is an input. It is typed as a power pin so wiring
   * rules can check that it is fed, but the module does not power itself — so
   * a sensor dropped on the canvas with nothing connected imposes nothing,
   * which is what a real one on a bench does.
   */
  private moduleSupply(instanceId: string, levels: Map<string, NetLevel>): number {
    const vccNet = this.netOfInstancePin(instanceId, 'vcc');
    if (!vccNet) return 0;
    if (!this.netFedByOther(vccNet, instanceId, POWER_PIN_TYPES)) return 0;
    return levels.get(vccNet)?.volts ?? this.supplyNets.get(vccNet) ?? 0;
  }

  /** When each holding sensor last saw its trigger, in world milliseconds. */
  private gpioSensorTriggeredAt = new Map<string, number>();

  /**
   * Whether a digital sensor's output is asserted right now.
   *
   * A PIR does not follow the motion — it latches high and holds for its
   * retrigger period, which is why firmware written for one has to debounce
   * differently from a button. Sensors with no hold follow directly.
   */
  private gpioSensorHold(instanceId: string, raw: boolean, holdMs: number, controls: SimControls): boolean {
    if (holdMs <= 0) return raw;
    const now = this.runner?.timeMs ?? 0;
    if (raw) {
      this.gpioSensorTriggeredAt.set(instanceId, now);
      return true;
    }
    const since = this.gpioSensorTriggeredAt.get(instanceId);
    return since !== undefined && now - since < holdMs;
  }

  /** The definition of one board instance, whichever board it is. */
  private boardDefinitionOf(instanceId: string): BoardDefinition | null {
    const def = this.graph.definitions.get(instanceId);
    return def?.isBoard ? def : null;
  }

  private controlsRef: SimControls | null = null;

  /** Solves net levels, feeds inputs to the emulator, returns per-component visuals. */
  update(controls: SimControls): {
    visuals: Map<string, ComponentVisualState>;
    netLevels: Map<string, NetLevel>;
  } {
    this.controlsRef = controls;
    const runner = this.runner;
    // A sketch opens its buses during setup(), which is after this binding was
    // built, so the device attachment follows the pins rather than preceding
    // them. sync() keeps existing devices by instance id, so re-binding does
    // not wipe an SSD1306's display RAM or an EEPROM's contents.
    if (this.busPinSignature() !== this.boundBusPins) this.rebindBuses();

    // A WS2812 frame is latched by a gap, not by an edge, so a sketch that
    // writes the strip once and then sits in an empty loop produces no further
    // edges and would never show anything. Giving each strip the current time
    // once per slice is what closes that.
    for (const { device, runner: owner } of this.addressableLeds.values()) {
      device.settle(owner.timeMs * 1e6);
    }

    // UART links: let each device produce, then hand the board whatever the
    // wire has had time to deliver. Bytes go through the runner's real serial
    // input, so they arrive at the firmware's UART peripheral rather than
    // being handed to a sketch by some side channel.
    // The GPS's simulated position comes from the part's properties, applied
    // every settle so moving the sliders moves the sentences. Never from a
    // host location.
    for (const inst of this.graph.instances) {
      const device = this.uartDeviceCache.get(inst.id);
      if (!(device instanceof GpsNeo6mDevice)) continue;
      const num = (key: string, fallback: number): number => {
        const v = Number(inst.properties[key]);
        return Number.isFinite(v) ? v : fallback;
      };
      device.fix.latitude = num('latitude', device.fix.latitude);
      device.fix.longitude = num('longitude', device.fix.longitude);
      device.fix.altitudeMetres = num('altitude', device.fix.altitudeMetres);
      device.fix.speedKnots = num('speedKnots', device.fix.speedKnots);
      device.fix.headingDegrees = num('heading', device.fix.headingDegrees);
      device.fix.satellites = Math.round(num('satellites', device.fix.satellites));
      device.fix.hasFix = inst.properties.hasFix !== false;
      device.setBaud(num('baud', 9600));
    }


    for (const { link, runner: owner } of this.uartLinks.values()) {
      const nowUs = owner.timeMs * 1000;
      link.setBoardConfig({ baud: owner.uartBaudRate ?? 9600 });
      link.poll(nowUs);
      const bytes = link.drainToBoard(nowUs);
      if (bytes.length > 0) {
        owner.queueSerialInput(String.fromCharCode(...bytes));
      }
    }

    // RESET is a level, not a byte, so a display only learns about it when
    // something asks. Sampling once per slice is enough: a reset pulse is held
    // for milliseconds, not microseconds, by every driver that issues one.
    for (const device of this.spiDevices) {
      const resettable = device as { settle?: () => void };
      if (typeof resettable.settle === 'function') resettable.settle();
    }

    // CAN, one bit at a time. The bus is stepped for as many bits as its
    // bitrate fits into this slice, so a 500 kbit/s bus really does move five
    // hundred bits per millisecond and a frame really does take its airtime.
    for (const bus of this.canBuses.values()) {
      const bits = Math.min(4000, Math.round((bus.agreedBitrate * DEFAULT_SETTLE_MS) / 1000));
      for (let i = 0; i < bits; i++) bus.stepBit();
    }

    // Radios, receive first and transmit second, across the whole canvas.
    //
    // The order is the hardware's, not the scheduler's. An acknowledgement
    // leaves about 130 microseconds after the packet it answers, long before
    // the sender's retransmit delay expires. If a transmitter evaluated its
    // timeout before the receiver on the other board had looked, it would
    // retransmit a packet that had in fact arrived — and the receiver would
    // get it twice.
    for (const device of this.spiDevices) {
      if (device instanceof Nrf24Device || device instanceof Sx1278Device) device.radioReceive();
    }
    for (const device of this.spiDevices) {
      if (device instanceof Nrf24Device || device instanceof Sx1278Device) device.radioTransmit();
    }

    const highVolts = Number(this.boardDef?.metadata.logicVoltage ?? 5);
    // A CMOS input switches around half the supply, so the threshold comes
    // from the board rather than being fixed at an AVR's 2.5 V.
    const inputThreshold = highVolts / 2;
    const levels = new Map<string, NetLevel>();
    const setLevel = (netId: string, volts: number, sourcePin: number | null, seriesOhms: number) => {
      const existing = levels.get(netId);
      if (!existing || existing.volts === null) {
        levels.set(netId, { volts, sourcePin, seriesOhms, conflict: false });
      } else if (seriesOhms < existing.seriesOhms) {
        // A stiffer source wins over a weaker one, which is what a real
        // divider does. This is how a regulator's output beats the ground it
        // is already connected to through its load: a 0-ohm driver against a
        // one-kilohm path is not a contest. Without it, whichever reached the
        // net first would stick, and a regulator feeding anything at all would
        // read as whatever its load was tied to.
        levels.set(netId, { volts, sourcePin, seriesOhms, conflict: existing.conflict });
      } else if (existing.volts !== volts && existing.seriesOhms === 0 && seriesOhms === 0) {
        existing.conflict = true;
        if (volts < existing.volts) existing.volts = volts; // ground wins, like real shorts (roughly)
      }
    };

    for (const netId of this.groundNets) setLevel(netId, 0, null, 0);
    // Every contribution separately, so two sources that disagree collide here
    // rather than being reduced to one value before anything can notice.
    for (const { netId, volts } of this.sourceContributions) {
      if (!this.groundNets.has(netId)) setLevel(netId, volts, null, 0);
    }
    for (const [netId, v] of this.supplyNets) {
      if (this.groundNets.has(netId)) continue;
      // A declared-only rail is deliberately weak: it shows the module at the
      // voltage it expects and loses to anything that actually sources.
      setLevel(netId, v, null, 0);
    }

    // MCU-driven nets, from every running board's real pin state.
    //
    // Each endpoint is asked of its own runner. Two boards driving one net in
    // opposite directions is a genuine electrical fault, and setLevel already
    // records that as a conflict rather than quietly picking a winner — which
    // is the behaviour a learner needs to see, since on real hardware it is
    // the thing that damages a pin.
    this.contendedNets.clear();
    for (const [netId, endpoints] of this.netEndpoints) {
      for (const endpoint of endpoints) {
        const owner = this.runners.get(endpoint.instance);
        if (!owner) continue;
        const level = owner.digitalPinLevel(endpoint.pin);
        if (level !== 'high' && level !== 'low') continue;
        const volts = level === 'high' ? Number(endpoint.board.metadata.logicVoltage ?? highVolts) : 0;
        setLevel(netId, volts, endpoint.instance === this.boardInstance?.id ? endpoint.pin : null, 0);
      }
      if (levels.get(netId)?.conflict) this.contendedNets.add(netId);
    }

    // Propagate through conductive elements to a fixpoint (bounded iterations).
    const propagate = () => {
      for (let iter = 0; iter < 12; iter++) {
        let changed = false;
        for (const edge of this.edges) {
          if (!edge.enabled(controls)) continue;
          const la = levels.get(edge.a);
          const lb = levels.get(edge.b);
          if (la?.volts != null && (lb?.volts == null)) {
            levels.set(edge.b, { volts: la.volts, sourcePin: la.sourcePin, seriesOhms: la.seriesOhms + edge.ohms, conflict: false });
            changed = true;
          } else if (lb?.volts != null && (la?.volts == null)) {
            levels.set(edge.a, { volts: lb.volts, sourcePin: lb.sourcePin, seriesOhms: lb.seriesOhms + edge.ohms, conflict: false });
            changed = true;
          }
        }
        if (!changed) break;
      }
    };
    propagate();

    // Devices that drive their own output pins (a 74HC595's Q0-Q7) act as
    // sources on top of the MCU's pins, so their nets are seeded and the graph
    // is settled a second time. Control inputs are sampled from the first pass,
    // which is where a grounded OE or a firmware-driven line has landed.
    // Control inputs are sampled from the first pass, which is where a grounded
    // OE or a firmware-driven line has landed.
    for (const [, wiring] of this.hc595) {
      const oe = levels.get(wiring.oeNet ?? '')?.volts;
      const clear = levels.get(wiring.clearNet ?? '')?.volts;
      // OE is active low. A floating OE is electrically undefined on real HC
      // logic, so the outputs are treated as disabled rather than guessed.
      wiring.device.setOutputEnable(oe != null && oe <= 0.8);
      if (clear != null && clear <= 0.8) wiring.device.clearShiftRegister();
    }

    // A 74HC165 reads the world: its parallel inputs come from real net levels,
    // and PL/CE gate whether it captures and shifts at all.
    for (const [, wiring] of this.hc165) {
      let bits = 0;
      wiring.inputNets.forEach((netId, bit) => {
        const volts = levels.get(netId ?? '')?.volts;
        if (volts != null && volts >= 2.0) bits |= 1 << bit;
      });
      wiring.device.setInputs(bits);
      // PL is driven by the edge subscription above, not sampled here: a load
      // pulse is over long before the next frame.
      const ce = levels.get(wiring.enableNet ?? '')?.volts;
      // CE is active low, but an unwired CE on these breakouts is normally
      // grounded; a floating one is reported as inhibited rather than assumed.
      wiring.device.setClockEnable(ce == null || ce <= 0.8);
    }

    // Devices that drive their own output pins (a 74HC595's Q0-Q7, an MCP4725's
    // VOUT) act as sources on top of the MCU's pins, so their nets are seeded
    // and the graph is settled a second time.
    const drivenNets = new Set<string>();
    const driveOutputs = (device: { instanceId: string; analogOut(pinId: string): number | null }, pinIds: readonly string[]) => {
      for (const pinId of pinIds) {
        const volts = device.analogOut(pinId);
        if (volts === null) continue; // high impedance drives nothing
        const netId = this.netOfInstancePin(device.instanceId, pinId);
        if (netId) {
          setLevel(netId, volts, null, 0);
          drivenNets.add(netId);
        }
      }
    };
    for (const device of this.spiDevices) {
      if (device instanceof Sn74hc595Device) driveOutputs(device, HC595_OUTPUT_PINS);
    }
    for (const device of this.i2cDevices) {
      if (device instanceof Mcp4725Device) driveOutputs(device, ['vout']);
    }
    // Port expanders: eight or sixteen more GPIOs, on real wires.
    //
    // Read first — an expander input has to see what the circuit put on the
    // pin — then drive, because a pin configured as an output is a source like
    // any other. A quasi-bidirectional pin released to its pull-up drives
    // nothing firmly, which is exactly what lets a button pull it low.
    for (const device of this.i2cDevices) {
      if (!isExpander(device)) continue;
      for (let i = 0; i < device.pinCount; i++) {
        const netId = this.netOfInstancePin(device.instanceId, `p${i}`);
        if (!netId) {
          device.setInputLevel(i, null);
          continue;
        }
        const volts = levels.get(netId)?.volts ?? null;
        device.setInputLevel(i, volts === null ? null : volts >= highVolts / 2);
      }
    }
    for (const device of this.i2cDevices) {
      if (!isExpander(device)) continue;
      for (let i = 0; i < device.pinCount; i++) {
        const netId = this.netOfInstancePin(device.instanceId, `p${i}`);
        if (!netId) continue;
        const state = device.pinState(i);
        if (state === 'drive-low') {
          setLevel(netId, 0, null, 0);
          drivenNets.add(netId);
        } else if (state === 'drive-high') {
          setLevel(netId, highVolts, null, 0);
          drivenNets.add(netId);
        } else if (state === 'weak-high' && levels.get(netId)?.volts == null) {
          // A pull-up, not a driver: it only wins where nothing else is
          // holding the wire, which is how these parts read their inputs.
          setLevel(netId, highVolts, null, 47_000);
          drivenNets.add(netId);
        }
      }
    }

    // An e-paper drives BUSY while it is updating, and every driver library
    // polls that pin before sending its next command. Driving it for real is
    // what makes a sketch with a correct wait block for a plausible time and a
    // sketch with a broken one misbehave the way it would on the bench.
    for (const device of this.spiDevices) {
      if (!(device instanceof EpaperDevice)) continue;
      const netId = this.netOfInstancePin(device.instanceId, 'busy');
      if (!netId) continue;
      setLevel(netId, device.isBusy ? highVolts : 0, null, 0);
      drivenNets.add(netId);
    }

    // H-bridges drive their outputs from their inputs.
    //
    // Done before the motors so a motor on the far side sees this frame's
    // bridge state rather than last frame's. The rules are the L298N's own: an
    // output follows its input only while that half's enable is high, and with
    // the enable low the output is off — which is why a sketch that forgets
    // ENA gets a motor that never turns however it drives IN1 and IN2.
    for (const inst of this.graph.instances) {
      const def = this.graph.definitions.get(inst.id);
      if (def?.id !== 'comp.motor-driver') continue;
      const supplyNet = this.netOfInstancePin(inst.id, 'vcc');
      const supply = supplyNet ? (levels.get(supplyNet)?.volts ?? null) : null;
      // No motor supply means no output, whatever the logic side is doing.
      if (supply == null || supply < 1) continue;

      const inputHigh = (pinId: string): boolean => {
        const netId = this.netOfInstancePin(inst.id, pinId);
        const v = netId ? levels.get(netId)?.volts : undefined;
        return v != null && v >= highVolts / 2;
      };
      const halves: [string, string, string, string, string][] = [
        ['ena', 'in1', 'in2', 'out1', 'out2'],
        ['enb', 'in3', 'in4', 'out3', 'out4'],
      ];
      for (const [en, inA, inB, outA, outB] of halves) {
        // An unwired enable on an L298N board is jumpered high, which is how
        // these modules ship and why most sketches never touch the pin.
        const enNet = this.netOfInstancePin(inst.id, en);
        const enabled = enNet === undefined ? true : inputHigh(en);
        for (const [outPin, inPin] of [
          [outA, inA],
          [outB, inB],
        ]) {
          const outNet = this.netOfInstancePin(inst.id, outPin);
          if (!outNet) continue;
          if (!enabled) continue; // coasting: the output is not driven at all
          setLevel(outNet, inputHigh(inPin) ? supply : 0, null, 0);
          drivenNets.add(outNet);
        }
      }
    }

    // A ULN2003 is seven Darlington sinks: a high on an input pulls the
    // matching output to ground, and a low leaves it floating. It cannot
    // source, which is exactly why a 28BYJ-48 wired to one has its common on
    // the supply rather than on ground.
    for (const inst of this.graph.instances) {
      const def = this.graph.definitions.get(inst.id);
      if (def?.id !== 'comp.uln2003') continue;
      for (let i = 1; i <= 7; i++) {
        const inNet = this.netOfInstancePin(inst.id, `in${i}`);
        const outNet = this.netOfInstancePin(inst.id, `out${i}`);
        if (!outNet) continue;
        const v = inNet ? levels.get(inNet)?.volts : undefined;
        if (v != null && v >= highVolts / 2) {
          setLevel(outNet, 0, null, 0);
          drivenNets.add(outNet);
        }
      }
    }

    // External ADCs read the wire.
    //
    // Done here, from the settled levels, so the number firmware gets back over
    // I2C or SPI is the voltage the circuit actually produced. Nothing anywhere
    // can set a reading: an unwired input is passed as null and reads as an
    // unwired input rather than as a confident zero.
    const voltsOnPin = (instanceId: string, pinId: string): number | null => {
      const netId = this.netOfInstancePin(instanceId, pinId);
      if (!netId) return null;
      return levels.get(netId)?.volts ?? null;
    };
    for (const device of this.i2cDevices) {
      if (!(device instanceof Ads1115Device)) continue;
      for (let ch = 0; ch < 4; ch++) {
        device.setInputVolts(ch, voltsOnPin(device.instanceId, `a${ch}`));
      }
    }
    for (const device of this.spiDevices) {
      if (!(device instanceof Mcp3008Device)) continue;
      for (let ch = 0; ch < MCP3008_CHANNELS; ch++) {
        device.setInputVolts(ch, voltsOnPin(device.instanceId, `ch${ch}`));
      }
      // The reference is a wire too: the same input reads differently on a
      // part running from 3.3 V and one from 5 V.
      device.setReference(voltsOnPin(device.instanceId, 'vref'));
    }

    // Regulators and converters. Done before everything that reads a rail, so a
    // sensor on a regulated 3.3 V line sees 3.3 V this frame rather than last.
    for (const inst of this.graph.instances) {
      const def = this.graph.definitions.get(inst.id);
      const reg = def ? REGULATOR_PARTS[def.id] : undefined;
      if (!reg) continue;

      const outNet = this.netOfInstancePin(inst.id, reg.vout);
      if (!outNet) continue;
      // A regulator with no ground reference is not a regulator. Fed from
      // outside the part, for the same reason a relay coil's return is.
      const gndNet = this.netOfInstancePin(inst.id, reg.gnd);
      if (!this.netFedByOther(gndNet, inst.id, ['ground'])) continue;

      const inNet = this.netOfInstancePin(inst.id, reg.vin);
      const vin = inNet ? (levels.get(inNet)?.volts ?? null) : null;
      if (vin === null) continue;

      if (reg.enable) {
        // An enable pin left unwired is pulled up on every module that has
        // one, so absent means enabled; driven low means off.
        const enNet = this.netOfInstancePin(inst.id, reg.enable);
        const en = enNet ? (levels.get(enNet)?.volts ?? null) : null;
        if (en !== null && en < 1.0) continue;
      }

      const nominal = Number(inst.properties.outputVoltage ?? reg.nominal);
      if (vin < (reg.minInput ?? 0)) continue;
      // The headroom rule, which is the difference between a part that works
      // on a bench and one that does not: a linear regulator cannot make 5 V
      // from 5 V, and a boost cannot step down.
      if (reg.stepUp) {
        if (vin >= nominal) continue;
      } else if (vin < nominal + reg.dropout) {
        continue;
      }
      setLevel(outNet, nominal, null, 0);
      drivenNets.add(outNet);
    }

    // The HC-05's KEY pin decides whether it answers AT commands or is
    // transparent, and it is a real wire — a module with KEY unwired is in
    // data mode, which is why an AT sketch on one gets no reply.
    for (const inst of this.graph.instances) {
      const device = this.uartDeviceCache.get(inst.id);
      if (device instanceof Hc05Device) {
        const keyNet = this.netOfInstancePin(inst.id, 'en');
        const v = keyNet ? (levels.get(keyNet)?.volts ?? null) : null;
        device.setKeyPin(v !== null && v >= 1.6);
        // The property is applied when the USER changes it, not on every
        // slice: AT+UART= sets the module's own rate, and re-asserting the
        // property here would undo the command the sketch just issued.
        const wanted = Number(inst.properties.baud ?? 9600);
        if (this.appliedUartBaud.get(inst.id) !== wanted) {
          this.appliedUartBaud.set(inst.id, wanted);
          device.setBaud(wanted);
        }
      } else if (device instanceof DfPlayerDevice) {
        device.setTrackCount(Number(inst.properties.trackCount ?? 10));
      } else if (device instanceof Esp01Device) {
        // CH_PD high and RST released, both read from the solved circuit. A
        // floating CH_PD is the classic ESP-01 fault and it behaves like one.
        const chpdNet = this.netOfInstancePin(inst.id, 'ch_pd');
        const rstNet = this.netOfInstancePin(inst.id, 'rst');
        const chpd = chpdNet ? (levels.get(chpdNet)?.volts ?? null) : null;
        const rst = rstNet ? (levels.get(rstNet)?.volts ?? null) : null;
        device.setChipEnable(chpd !== null && chpd >= 1.6 && !(rst !== null && rst < 1.6));
        device.setAccessPoint({
          ssid: String(inst.properties.ssid ?? DEFAULT_ACCESS_POINT.ssid),
          password: String(inst.properties.password ?? DEFAULT_ACCESS_POINT.password),
        });
        const wanted = Number(inst.properties.baud ?? 115200);
        if (this.appliedUartBaud.get(inst.id) !== wanted) {
          this.appliedUartBaud.set(inst.id, wanted);
          device.setBaud(wanted);
        }
      }
    }

    // Infrared. After the levels, because a receiver's schedule is only worth
    // rebuilding once the wiring behind it has settled.
    this.updateIr(controls);
    for (const [instId, link] of this.irReceivers) {
      const outNet = this.netOfInstancePin(instId, 'out');
      if (!outNet) continue;
      // A TSOP's output is a real driver: it pulls hard to ground while it
      // hears a carrier, and idles high through an internal pull-up of about
      // 30 k. That weakness matters — anything else driving this net wins,
      // which is what would happen on a breadboard. The microsecond schedule
      // sets the pin between settles; this is the same state, so that anything
      // else on the wire sees it too.
      const low = link.device.outputLow;
      setLevel(outNet, low ? 0 : highVolts, null, low ? 0 : 30000);
    }

    // Radios. IRQ is an open-drain output that the chip pulls LOW while an
    // unmasked interrupt is asserted and releases otherwise — so a sketch that
    // waits on a falling edge sees one only when something genuinely happened.
    for (const device of this.spiDevices) {
      if (device instanceof Nrf24Device) {
        const irqNet = this.netOfInstancePin(device.instanceId, 'irq');
        if (!irqNet) continue;
        const asserted = device.irqAsserted;
        setLevel(irqNet, asserted ? 0 : highVolts, null, asserted ? 0 : 30000);
      } else if (device instanceof Mcp2515Device) {
        const intNet = this.netOfInstancePin(device.instanceId, 'int');
        if (!intNet) continue;
        const asserted = device.irqAsserted;
        setLevel(intNet, asserted ? 0 : highVolts, null, asserted ? 0 : 30000);
      } else if (device instanceof Sx1278Device) {
        // DIO0 is the other polarity: an SX127x drives it HIGH on TxDone or
        // RxDone, which is why LoRa sketches attach a RISING interrupt.
        const dioNet = this.netOfInstancePin(device.instanceId, 'dio0');
        if (!dioNet) continue;
        const asserted = device.irqAsserted;
        setLevel(dioNet, asserted ? highVolts : 0, null, 0);
      }
    }
    // The 433 MHz receivers, whose DATA pin is a real output.
    this.pumpOokReceivers();
    for (const [instId, link] of this.ookReceivers) {
      const dataNet = this.netOfInstancePin(instId, 'data');
      if (!dataNet) continue;
      const high = link.device.outputHigh;
      setLevel(dataNet, high ? highVolts : 0, null, 0);
    }

    // Traffic older than a hundred milliseconds cannot affect anything: the
    // longest airtime here is well under a millisecond and every receiver
    // holds a cursor past it.
    this.rfMedium.prune(this.irTimeUs() - 100000);

    // Relay coils. Read before the contacts are next solved, so the armature
    // follows the coil by one slice — see `energisedRelays`.
    for (const inst of this.graph.instances) {
      const def = this.graph.definitions.get(inst.id);
      const relay = def ? RELAY_PARTS[def.id] : undefined;
      if (!relay) continue;
      const coilNet = this.netOfInstancePin(inst.id, relay.coil);
      const returnNet = this.netOfInstancePin(inst.id, relay.coilReturn);
      // The return has to be fed from OUTSIDE the relay. A module's own ground
      // pin declares 0 V on whatever net it sits on, so without this rule a
      // relay with its ground never wired would happily energise against its
      // own declaration — and "I forgot the ground" is exactly the bug worth
      // reproducing. Same rule the bus devices use for their supplies.
      const returnFed = this.netFedByOther(returnNet, inst.id, ['ground']);
      const coilVolts = coilNet ? (levels.get(coilNet)?.volts ?? null) : null;
      const returnVolts = returnNet ? (levels.get(returnNet)?.volts ?? null) : null;
      const across =
        returnFed && coilVolts !== null && returnVolts !== null ? coilVolts - returnVolts : null;
      // A coil needs most of its rated voltage to pull in.
      const energised = across !== null && Math.abs(across) >= relay.pullInVolts;
      for (const contact of contactsOf(def!.id, inst)) {
        const key = contactStateKey(inst.id, contact.key);
        if (energised) this.energisedRelays.add(key);
        else this.energisedRelays.delete(key);
      }
    }

    // Motors and steppers, driven from what is actually on their terminals.
    //
    // Deliberately after the logic settle and the expanders: a motor wired to
    // an H-bridge that is wired to a shift register has to see the voltage the
    // whole chain produced, not the one it had before the chain resolved.
    this.updateMotors(levels, this.runner?.timeMs ?? 0);

    // An encoder motor drives its two channels from the shaft the motor model
    // integrated. Ninety degrees apart, so firmware can tell direction from the
    // order the edges arrive in — which it cannot do from a pulse count.
    for (const [instanceId, encoder] of this.encoders) {
      const motor = this.motors.get(instanceId);
      if (!motor) continue;
      const position = motor.position;
      for (const [pinId, level] of [
        ['enca', encoder.channelA(position)],
        ['encb', encoder.channelB(position)],
      ] as [string, boolean][]) {
        const netId = this.netOfInstancePin(instanceId, pinId);
        if (!netId) continue;
        setLevel(netId, level ? highVolts : 0, null, 0);
        drivenNets.add(netId);
      }
    }

    // Logic ICs, settled to a fixed point.
    //
    // A gate's output is another gate's input, so one pass is not enough: a
    // counter feeding a decoder feeding a display needs the chain to settle
    // before anything reads it. Each round re-evaluates every part from the
    // current net levels and drives the results back on, until nothing moves
    // or the round limit is hit — which is what an oscillating circuit (a ring
    // of inverters) genuinely does, and is reported rather than looped on.
    if (this.logicDevices.size > 0) {
      this.settleLogic(levels, setLevel, propagate, drivenNets);
    }

    if (drivenNets.size > 0) {
      propagate();
      // A device output landing on an analog-capable pin has to reach the
      // emulator's ADC, or firmware would read 0 from a pin that is genuinely
      // being driven. Only device-driven nets are fed here, so the sensor
      // adapters below keep full control of their own channels.
      if (runner) {
        for (const netId of drivenNets) {
          const volts = levels.get(netId)?.volts;
          if (volts == null) continue;
          for (const channel of this.netAdcChannels.get(netId) ?? []) {
            runner.setAnalogVolts(channel, volts);
          }
        }
      }
    }

    const levelOf = (netId: string | undefined): NetLevel | undefined =>
      netId ? levels.get(netId) : undefined;

    // Feed digital inputs back into every running board.
    //
    // Every board, not only the primary one: a second MCU reading a wire is
    // exactly the case the multi-board world exists for, and feeding only the
    // primary would leave it reading a pad nothing ever touched. Each board's
    // own logic threshold is used, since a 3.3 V part and a 5 V part on the
    // same wire do not switch at the same voltage.
    for (const [netId, endpoints] of this.netEndpoints) {
      const level = levels.get(netId);
      for (const endpoint of endpoints) {
        const owner = this.runners.get(endpoint.instance);
        if (!owner) continue;
        const state = owner.digitalPinLevel(endpoint.pin);
        if (state !== 'input' && state !== 'input-pullup') continue;
        const threshold = Number(endpoint.board.metadata.logicVoltage ?? highVolts) / 2;
        if (level?.volts != null) {
          owner.setDigitalInput(endpoint.pin, level.volts >= threshold);
        } else {
          // Nothing on the canvas is holding this pad, so its own
          // configuration decides: an enabled pull-up reads high, and a
          // plain floating input keeps whatever it had.
          owner.setDigitalInput(endpoint.pin, null);
        }
      }
    }

    // Per-component behavior + visuals.
    const visuals = new Map<string, ComponentVisualState>();
    const duty = runner ? runner.snapshot() : null;

    for (const inst of this.graph.instances) {
      const def = this.graph.definitions.get(inst.id);
      if (!def || def.isBoard) continue;
      const net = (pinId: string) => this.netOfInstancePin(inst.id, pinId);

      switch (def.simulationAdapterId) {
        case 'sim.led': {
          const anode = levelOf(net('anode'));
          const cathode = levelOf(net('cathode'));
          const fV = Number(inst.properties.forwardVoltage ?? 2);
          const on =
            anode?.volts != null && cathode?.volts != null && anode.volts - cathode.volts >= fV - 0.4;
          let brightness = on ? 1 : 0;
          if (on && duty && anode?.sourcePin != null && runner?.isOutput(anode.sourcePin)) {
            brightness = duty.duty[anode.sourcePin];
          }
          visuals.set(inst.id, { ledOn: on && brightness > 0.02, brightness });
          break;
        }
        case 'sim.rgb-led': {
          const cathode = levelOf(net('cathode'));
          const channels: [string, number][] = [['red', 0], ['green', 1], ['blue', 2]];
          const rgb: [number, number, number] = [0, 0, 0];
          for (const [pinId, idx] of channels) {
            const level = levelOf(net(pinId));
            if (level?.volts != null && cathode?.volts != null && level.volts - cathode.volts >= 1.6) {
              rgb[idx] =
                duty && level.sourcePin != null && runner?.isOutput(level.sourcePin)
                  ? duty.duty[level.sourcePin]
                  : 1;
            }
          }
          visuals.set(inst.id, { rgb, ledOn: rgb.some((c) => c > 0.02) });
          break;
        }
        case 'sim.push-button':
          visuals.set(inst.id, { pressed: controls.pressedButtons.has(inst.id) });
          break;
        // Multi-contact parts report every contact, because "is it pressed" is
        // not a single boolean once a part has more than one thing to press.
        case 'sim.slide-switch':
        case 'sim.limit-switch':
        case 'sim.dip-switch':
        case 'sim.keypad':
        case 'sim.rotary-encoder':
        case 'sim.joystick': {
          const engaged: Record<string, boolean> = {};
          for (const contact of contactsOf(def.id, inst)) {
            engaged[contact.key] = controls.pressedButtons.has(contactStateKey(inst.id, contact.key));
          }
          const state: ComponentVisualState = { contacts: engaged };
          if (def.simulationAdapterId === 'sim.joystick') {
            const x = controls.potPositions.get(`${inst.id}#x`) ?? 0.5;
            const y = controls.potPositions.get(`${inst.id}#y`) ?? 0.5;
            state.value = x;
            state.axes = { x, y };
            this.driveJoystickAxes(inst.id, controls, runner, levelOf);
          }
          visuals.set(inst.id, state);
          break;
        }
        case 'sim.ir-remote': {
          // The keys come from the same table the codes do, so a key that
          // lights up is the key whose command went into the air.
          const engaged: Record<string, boolean> = {};
          for (const button of STARTER_REMOTE_KEYS) {
            engaged[button.key] = controls.pressedButtons.has(contactStateKey(inst.id, button.key));
          }
          visuals.set(inst.id, { contacts: engaged });
          break;
        }
        case 'sim.max485': {
          const device = this.rs485DeviceCache.get(inst.id);
          visuals.set(inst.id, { on: device instanceof Max485Device && device.driving });
          break;
        }
        case 'sim.rf433-tx': {
          const device = this.ookDeviceCache.get(inst.id);
          visuals.set(inst.id, { on: device instanceof Ook433Transmitter && device.isKeyed });
          break;
        }
        case 'sim.rf433-rx': {
          const device = this.ookDeviceCache.get(inst.id);
          visuals.set(inst.id, { on: device instanceof Ook433Receiver && device.outputHigh });
          break;
        }
        case 'sim.ir-led':
          // Lit means "a carrier is genuinely going out right now", which is a
          // different thing from the pin being high.
          visuals.set(inst.id, { on: this.irMedium.isLive(inst.id) });
          break;
        case 'sim.ir-receiver': {
          const device = this.irDeviceCache.get(inst.id);
          visuals.set(inst.id, { on: device instanceof IrReceiverDevice && device.outputLow });
          break;
        }
        case 'sim.toggle-switch':
          visuals.set(inst.id, { toggledOn: controls.toggleStates.get(inst.id) === true });
          break;
        case 'sim.potentiometer': {
          const pos = controls.potPositions.get(inst.id) ?? 0.5;
          visuals.set(inst.id, { potPosition: pos });
          if (runner) {
            const wiperNet = net('wiper');
            const channel = wiperNet ? this.netAdcChannels.get(wiperNet)?.[0] : undefined;
            if (channel !== undefined) {
              const v1 = levelOf(net('t1'))?.volts ?? 0;
              const v2 = levelOf(net('t2'))?.volts ?? 5;
              runner.setAnalogVolts(channel, v1 + pos * (v2 - v1));
            }
          }
          break;
        }
        case 'sim.buzzer': {
          const plus = levelOf(net('plus'));
          const minus = levelOf(net('minus'));
          const on = plus?.volts != null && minus?.volts != null && plus.volts - minus.volts >= 2.5;
          let level = on ? 1 : 0;
          if (on && duty && plus?.sourcePin != null && runner?.isOutput(plus.sourcePin)) {
            level = duty.duty[plus.sourcePin];
          }
          visuals.set(inst.id, { buzzerOn: on && level > 0.02 });
          break;
        }
        case 'sim.servo': {
          const sig = levelOf(net('sig'));
          let angle = (inst.simulationState.angle as number | undefined) ?? 90;
          if (duty && sig?.sourcePin != null) {
            const width = duty.pulseWidthUs[sig.sourcePin];
            if (width >= 400 && width <= 2800) {
              angle = Math.max(0, Math.min(180, ((width - 1000) / 1000) * 180));
              inst.simulationState.angle = angle;
            }
          }
          visuals.set(inst.id, { servoAngle: angle });
          break;
        }
        case 'sim.tm1637': {
          const device = this.tm1637For(inst.id);
          if (device) {
            // Segment bytes as the panel shows them. The TM1637 holds a whole
            // frame, so there is no scan to average — unlike the bare digits.
            const brightness: Record<string, number> = {};
            for (let d = 0; d < device.shown.length; d++) {
              const byte = device.shown[d];
              ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'dp'].forEach((seg, i) => {
                brightness[`${d}.${seg}`] = ((byte >> i) & 1) === 1 ? 1 : 0;
              });
            }
            visuals.set(inst.id, { elementBrightness: brightness, value: device.brightnessLevel });
          } else {
            visuals.set(inst.id, { elementBrightness: {} });
          }
          break;
        }
        case 'sim.motor': {
          const motor = this.motorFor(inst.id);
          if (motor) {
            const state = motor.current;
            visuals.set(inst.id, {
              motor: {
                direction: state.direction,
                magnitude: state.magnitude,
                angleDegrees: motor.angleDegrees,
                connected: state.connected,
              },
              value: state.magnitude,
            });
          } else {
            visuals.set(inst.id, {});
          }
          break;
        }
        case 'sim.stepper': {
          const stepper = this.coilStepperFor(inst.id);
          const driver = this.stepDriverFor(inst.id);
          if (stepper) {
            visuals.set(inst.id, {
              motor: {
                direction: 'stopped',
                magnitude: stepper.isHolding ? 1 : 0,
                angleDegrees: stepper.angleDegrees,
                connected: stepper.isHolding,
              },
              value: stepper.stepCount,
            });
          } else if (driver) {
            visuals.set(inst.id, {
              motor: {
                direction: 'stopped',
                magnitude: driver.isEnabled ? 1 : 0,
                angleDegrees: driver.angleDegrees,
                connected: driver.isEnabled,
              },
              value: driver.microstepCount,
            });
          } else {
            visuals.set(inst.id, {});
          }
          break;
        }
        case 'sim.multiplexed': {
          const spec = MULTIPLEXED_PARTS[def.id];
          if (!spec) {
            visuals.set(inst.id, {});
            break;
          }
          const nowMs = runner?.timeMs ?? 0;
          // Which commons are enabled: a common-cathode digit is selected when
          // its common is pulled low, a common-anode one when it is driven
          // high. Undriven means not selected — a scan that forgot a pinMode
          // lights nothing, as on a breadboard.
          const enabled = spec.commons.map((pinId) => {
            const level = levelOf(net(pinId));
            if (level?.volts == null) return false;
            return spec.commonCathode ? level.volts < 0.8 : level.volts >= 1.6;
          });
          // And which element lines are asserted, on the opposite polarity.
          const asserted = spec.elements.map((pinId) => {
            const level = levelOf(net(pinId));
            if (level?.volts == null) return false;
            return spec.commonCathode ? level.volts >= 1.6 : level.volts < 0.8;
          });

          const litNow: Record<string, boolean> = {};
          for (let c = 0; c < spec.commons.length; c++) {
            for (let e = 0; e < spec.elements.length; e++) {
              const key = `${inst.id}#${c}.${spec.elements[e]}`;
              const on = enabled[c] && asserted[e];
              litNow[key] = on;
              this.persistence.set(key, on, nowMs);
            }
          }

          // What the eye would see. Reported per common and per element so a
          // renderer can draw four digits from one part.
          const brightness: Record<string, number> = {};
          for (const key of Object.keys(litNow)) {
            brightness[key.slice(inst.id.length + 1)] = this.persistence.level(key, nowMs);
          }
          visuals.set(inst.id, { elementBrightness: brightness });
          break;
        }
        case 'sim.seven-segment': {
          const com1 = levelOf(net('com1'));
          const grounded = com1?.volts != null && com1.volts < 0.5;
          const segments: Record<string, boolean> = {};
          for (const seg of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'dp']) {
            const level = levelOf(net(seg));
            segments[seg] = Boolean(grounded && level?.volts != null && level.volts >= 1.6);
          }
          visuals.set(inst.id, { segments });
          break;
        }
        case 'sim.tmp36': {
          const temp = controls.sensorValues.get(inst.id) ?? 25;
          visuals.set(inst.id, { value: temp });
          if (runner) {
            const outNet = net('vout');
            const channel = outNet ? this.netAdcChannels.get(outNet)?.[0] : undefined;
            if (channel !== undefined) runner.setAnalogVolts(channel, 0.5 + temp * 0.01);
          }
          break;
        }
        // Analog sensors: impose the voltage a real part would produce, on
        // whatever ADC channel the output pin actually reaches. Unwired or
        // unpowered, they impose nothing at all.
        case 'sim.analog-sensor': {
          const spec = ANALOG_SENSORS[def.id];
          if (!spec) break;
          const value = controls.sensorValues.get(inst.id) ?? Number(inst.properties[spec.quantity.key] ?? spec.quantity.default);
          visuals.set(inst.id, { value });
          const supply = this.moduleSupply(inst.id, levels);
          if (runner && supply > 0) {
            const outNet = net(spec.outputPin);
            const channel = outNet ? this.netAdcChannels.get(outNet)?.[0] : undefined;
            if (channel !== undefined) {
              runner.setAnalogVolts(channel, Math.min(supply, Math.max(0, spec.volts(value, supply))));
            }
          }
          break;
        }
        // Digital sensors: drive their one output line onto the net. A PIR
        // holds after triggering; a tilt switch follows directly.
        case 'sim.gpio-sensor': {
          const spec = GPIO_SENSORS[def.id];
          if (!spec) break;
          const raw = (controls.sensorValues.get(inst.id) ?? 0) > 0.5 || inst.properties.triggered === true;
          const held = this.gpioSensorHold(inst.id, raw, spec.holdMs, controls);
          visuals.set(inst.id, { value: held ? 1 : 0, ledOn: held });
          const supply = this.moduleSupply(inst.id, levels);
          const outNet = net(spec.outputPin);
          if (outNet && supply > 0) {
            const asserted = spec.activeLow ? !held : held;
            setLevel(outNet, asserted ? supply : 0, null, 0);
            drivenNets.add(outNet);
          }
          break;
        }
        case 'sim.expander': {
          const device = this.i2cDeviceFor(inst.id);
          if (isExpander(device)) {
            const states: string[] = [];
            for (let i = 0; i < device.pinCount; i++) {
              const state = device.pinState(i);
              states.push(state === 'drive-high' || state === 'weak-high' ? '1' : state === 'drive-low' ? '0' : '-');
            }
            visuals.set(inst.id, {
              readout: [states.slice(0, 8).join(''), states.slice(8).join('')].filter((l) => l.length > 0),
              value: device.interruptAsserted ? 1 : 0,
            });
          } else {
            visuals.set(inst.id, {});
          }
          break;
        }
        case 'sim.lcd2004': {
          const device = this.i2cDeviceFor(inst.id);
          if (device instanceof Lcd1602Device) {
            visuals.set(inst.id, { readout: device.isFourBitMode ? device.lines : ['not initialised', '', '', ''] });
          } else {
            visuals.set(inst.id, {});
          }
          break;
        }
        case 'sim.max7219': {
          const device = this.spiDeviceFor(inst.id);
          if (device instanceof Max7219Device) {
            visuals.set(inst.id, {
              display: { pixels: device.pixels, on: device.isAwake, revision: device.writeCounter },
              value: device.litCount,
            });
          } else {
            visuals.set(inst.id, { display: { pixels: null, on: false, revision: 0 } });
          }
          break;
        }
        case 'sim.bme280': {
          const device = this.i2cDeviceFor(inst.id);
          if (device instanceof Bme280Device) {
            device.temperatureC = controls.sensorValues.get(`${inst.id}#temperature`) ?? Number(inst.properties.temperature ?? 22);
            device.pressureHpa = controls.sensorValues.get(`${inst.id}#pressure`) ?? Number(inst.properties.pressure ?? 1013);
            device.humidityPct = controls.sensorValues.get(`${inst.id}#humidity`) ?? Number(inst.properties.humidity ?? 45);
            visuals.set(inst.id, {
              readout: device.isMeasuring
                ? [`${device.temperatureC.toFixed(1)} C  ${device.humidityPct.toFixed(0)}%`, `${device.pressureHpa.toFixed(0)} hPa`]
                : ['sleep'],
            });
          } else {
            visuals.set(inst.id, {});
          }
          break;
        }
        case 'sim.sht31': {
          const device = this.i2cDeviceFor(inst.id);
          if (device instanceof Sht31Device) {
            device.temperatureC = controls.sensorValues.get(`${inst.id}#temperature`) ?? Number(inst.properties.temperature ?? 22);
            device.humidityPct = controls.sensorValues.get(`${inst.id}#humidity`) ?? Number(inst.properties.humidity ?? 45);
            visuals.set(inst.id, {
              readout: [`${device.temperatureC.toFixed(1)} C`, `${device.humidityPct.toFixed(0)} %RH`],
            });
          } else {
            visuals.set(inst.id, {});
          }
          break;
        }
        case 'sim.ldr': {
          const light = controls.sensorValues.get(inst.id) ?? 0.5;
          visuals.set(inst.id, { value: light });
          if (runner) {
            for (const pinId of ['p1', 'p2']) {
              const n = net(pinId);
              const channel = n ? this.netAdcChannels.get(n)?.[0] : undefined;
              if (channel !== undefined) {
                // Simplified divider model, documented in the part description.
                runner.setAnalogVolts(channel, 5 * light);
              }
            }
          }
          break;
        }
        case 'sim.ultrasonic': {
          const cm = controls.sensorValues.get(inst.id) ?? 100;
          inst.simulationState.distanceCm = cm;
          visuals.set(inst.id, { value: cm });
          break;
        }
        case 'sim.ssd1306': {
          const device = this.i2cDeviceFor(inst.id);
          if (device instanceof Ssd1306Device) {
            visuals.set(inst.id, {
              display: { pixels: device.ram, on: device.isOn, revision: device.revision },
              value: device.litPixels,
            });
          } else {
            // Not wired to the bus (or no simulation running): stays dark.
            visuals.set(inst.id, { display: { pixels: null, on: false, revision: 0 } });
          }
          break;
        }
        case 'sim.tft': {
          const device = this.spiDeviceFor(inst.id);
          if (device instanceof TftDisplayDevice) {
            visuals.set(inst.id, {
              raster: device.isVisible
                ? {
                    width: device.fb.width,
                    height: device.fb.height,
                    pixels: device.fb.pixels,
                    inverted: device.isInverted,
                    revision: device.revision,
                  }
                : null,
            });
          } else if (device instanceof Ssd1331Device) {
            visuals.set(inst.id, {
              raster: device.isVisible
                ? {
                    width: device.fb.width,
                    height: device.fb.height,
                    pixels: device.fb.pixels,
                    inverted: device.displayMode === 'inverse',
                    revision: device.revision,
                  }
                : null,
            });
          } else {
            // Not on the bus, or its chip select reaches no board pin.
            visuals.set(inst.id, { raster: null });
          }
          break;
        }
        case 'sim.epaper': {
          const device = this.spiDeviceFor(inst.id);
          if (device instanceof EpaperDevice) {
            // An e-paper always shows something, so the frame is never null:
            // a panel that has never been refreshed shows a blank sheet, which
            // is what one out of its box looks like.
            visuals.set(inst.id, {
              display: { pixels: device.frame(), on: true, revision: device.revision },
              value: device.shownPixelCount,
              readout: device.isBusy ? ['refreshing'] : undefined,
            });
          } else {
            visuals.set(inst.id, { display: { pixels: null, on: false, revision: 0 } });
          }
          break;
        }
        case 'sim.pcd8544': {
          const device = this.spiDeviceFor(inst.id);
          if (device instanceof Pcd8544Device) {
            visuals.set(inst.id, {
              display: { pixels: device.frame(), on: device.isOn, revision: device.revision },
              value: device.litPixels,
            });
          } else {
            visuals.set(inst.id, { display: { pixels: null, on: false, revision: 0 } });
          }
          break;
        }
        case 'sim.neopixel': {
          const strip = this.addressableLedFor(inst.id);
          if (strip) {
            visuals.set(inst.id, {
              pixelColors: strip.pixels.map((c) => ({ ...c })),
              value: strip.litCount,
            });
          } else {
            // Its data line reaches no board pin, so nothing can drive it.
            visuals.set(inst.id, { pixelColors: [] });
          }
          break;
        }
        case 'sim.lcd-parallel': {
          const device = this.parallelLcdFor(inst.id);
          if (device) {
            visuals.set(inst.id, {
              readout: device.isInitialised
                ? device.lines
                : Array.from({ length: device.rows }, (_, i) => (i === 0 ? 'not initialised' : '')),
            });
          } else {
            // Its enable line reaches no board, so nothing can ever latch.
            visuals.set(inst.id, {});
          }
          break;
        }
        case 'sim.sh1107': {
          const device = this.i2cDeviceFor(inst.id);
          if (device instanceof Sh1107Device) {
            visuals.set(inst.id, {
              display: { pixels: device.frame(), on: device.isOn, revision: device.revision },
              value: device.litPixels,
            });
          } else {
            // Not wired to the bus (or no simulation running): stays dark.
            visuals.set(inst.id, { display: { pixels: null, on: false, revision: 0 } });
          }
          break;
        }
        case 'sim.bmp280': {
          const device = this.i2cDeviceFor(inst.id);
          if (device instanceof Bmp280Device) {
            visuals.set(inst.id, {
              readout: device.isMeasuring
                ? [`${device.temperatureC.toFixed(1)} C`, `${device.pressureHpa.toFixed(0)} hPa`]
                : ['sleep'],
            });
          } else {
            // Not wired to the bus (or no simulation running): no readout.
            visuals.set(inst.id, {});
          }
          break;
        }
        case 'sim.mpu6050': {
          const device = this.i2cDeviceFor(inst.id);
          if (device instanceof Mpu6050Device) {
            const { accelG, gyroDps } = device.motion;
            visuals.set(inst.id, {
              readout: device.isAwake
                ? [
                    `${accelG.x.toFixed(2)} ${accelG.y.toFixed(2)} ${accelG.z.toFixed(2)} g`,
                    `${gyroDps.x.toFixed(0)} ${gyroDps.y.toFixed(0)} ${gyroDps.z.toFixed(0)} d/s`,
                  ]
                : ['sleep'],
            });
          } else {
            visuals.set(inst.id, {});
          }
          break;
        }
        case 'sim.hc595': {
          const device = this.spiDeviceFor(inst.id);
          if (device instanceof Sn74hc595Device) {
            const bits = device.outputs;
            visuals.set(inst.id, {
              readout:
                bits === null
                  ? ['outputs Hi-Z', 'check OE']
                  : [`Q7..Q0 ${bits.toString(2).padStart(8, '0')}`, `${device.latchCount} latch`],
            });
          } else {
            visuals.set(inst.id, {});
          }
          break;
        }
        case 'sim.sd-card': {
          const device = this.spiDeviceFor(inst.id);
          if (device instanceof SdCardDevice) {
            this.persistDevice(inst, device.writeCounter, () => {
              inst.simulationState.sdCard = device.saveState();
            });
            visuals.set(inst.id, {
              readout: [device.isInitialised ? 'card ready' : 'not initialised', `${device.storedBlockCount} blk`],
            });
          } else {
            visuals.set(inst.id, {});
          }
          break;
        }
        case 'sim.spi-flash': {
          const device = this.spiDeviceFor(inst.id);
          if (device instanceof SpiFlashDevice) {
            this.persistDevice(inst, device.writeCounter, () => {
              inst.simulationState.spiFlash = device.saveState();
            });
            visuals.set(inst.id, {
              readout: [device.busy ? 'busy' : 'ready', device.writeEnableLatch ? 'WEL set' : 'WEL clear'],
            });
          } else {
            visuals.set(inst.id, {});
          }
          break;
        }
        case 'sim.lcd1602': {
          const device = this.i2cDeviceFor(inst.id);
          if (device instanceof Lcd1602Device) {
            visuals.set(inst.id, {
              readout: device.isFourBitMode ? device.lines : ['not initialised', ''],
              ledOn: device.isBacklit,
            });
          } else {
            visuals.set(inst.id, {});
          }
          break;
        }
        case 'sim.eeprom-24c': {
          const device = this.i2cDeviceFor(inst.id);
          if (device instanceof Eeprom24cDevice) {
            this.persistDevice(inst, device.writeCounter, () => {
              inst.simulationState.eeprom = device.saveState();
            });
            visuals.set(inst.id, {
              readout: [device.busy ? 'write cycle' : 'ready', `${device.nackCount} NACK`],
            });
          } else {
            visuals.set(inst.id, {});
          }
          break;
        }
        case 'sim.ds3231': {
          const device = this.i2cDeviceFor(inst.id);
          if (device instanceof Ds3231Device) {
            const t = device.time;
            const pad = (n: number) => String(n).padStart(2, '0');
            visuals.set(inst.id, {
              readout: [`${pad(t.hour)}:${pad(t.minute)}:${pad(t.second)}`, `${t.year}-${pad(t.month)}-${pad(t.date)}`],
            });
          } else {
            visuals.set(inst.id, {});
          }
          break;
        }
        case 'sim.mcp4725': {
          const device = this.i2cDeviceFor(inst.id);
          if (device instanceof Mcp4725Device) {
            visuals.set(inst.id, {
              readout:
                device.powerDownMode === 0
                  ? [`${device.programmedVolts.toFixed(2)} V`, `code ${device.dacCode}`]
                  : ['powered down', `code ${device.dacCode}`],
              value: device.programmedVolts,
            });
          } else {
            visuals.set(inst.id, {});
          }
          break;
        }
        case 'sim.hc165': {
          const device = this.spiDeviceFor(inst.id);
          if (device instanceof Sn74hc165Device) {
            visuals.set(inst.id, {
              readout: [
                `D7..D0 ${device.parallelInputs.toString(2).padStart(8, '0')}`,
                device.isClockEnabled ? `${device.captureCount} capture` : 'clock inhibited',
              ],
            });
          } else {
            visuals.set(inst.id, {});
          }
          break;
        }
        default: {
          if (def.id === 'comp.relay') {
            const inLevel = levelOf(net('in'));
            visuals.set(inst.id, { coilOn: inLevel?.volts != null && inLevel.volts >= 2.5 });
          }
          break;
        }
      }
    }

    return { visuals, netLevels: levels };
  }
}
