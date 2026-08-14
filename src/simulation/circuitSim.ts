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
import { PersistenceTracker } from './devices/persistence';
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
  potPosition?: number;
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
    const i2c: I2cDevice[] = [];
    const spi: SpiDevice[] = [];
    for (const [instanceId, owner] of this.runners) {
      i2c.push(...this.setupI2cDevices(owner, instanceId));
      spi.push(...this.setupSpiDevices(owner, instanceId));
      this.setupParallelLcds(owner, instanceId);
      this.setupAddressableLeds(owner, instanceId);
      this.setupTwoWireDisplays(owner, instanceId);
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
        if (pin.type === 'ground') this.groundNets.add(net.id);
        // What a rail is at is decided by whatever actually sources it.
        //
        // A board's 5V or 3V3 pin is a real supply. A module's VCC pin is an
        // *input* — it is typed as a supply pin so wiring rules can check that
        // it is fed, but the module does not generate anything. Letting a
        // module's pin set the rail meant a 5V-labelled part wired to a Pico's
        // 3V3 made the whole net read 5V, and everything downstream of it —
        // ADC readings, logic thresholds — was then wrong by a third.
        const sources = def?.isBoard === true;
        if (pin.type === 'power-5v') {
          if (sources) this.supplyNets.set(net.id, 5);
          else declaredByModules.set(net.id, Math.max(declaredByModules.get(net.id) ?? 0, 5));
        }
        if (pin.type === 'power-3v3') {
          if (sources) this.supplyNets.set(net.id, 3.3);
          else declaredByModules.set(net.id, Math.max(declaredByModules.get(net.id) ?? 0, 3.3));
        }
        if (pin.type === 'power-vin' && !this.supplyNets.has(net.id)) {
          const inst = this.graph.instances.find((i) => i.id === instId);
          const v = typeof inst?.properties.voltage === 'number' ? (inst.properties.voltage as number) : 9;
          if (def && !def.isBoard && def.simulationAdapterId === 'sim.supply') this.supplyNets.set(net.id, v);
        }
      }
    }
    for (const [netId, volts] of declaredByModules) {
      if (!this.supplyNets.has(netId)) this.supplyNets.set(netId, volts);
    }
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
          enabled: (c) => isContactClosed(c.pressedButtons, inst.id, contact),
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
      const i2cPinIds = (board.metadata.i2cPins as string[] | undefined) ?? [];
      for (const pinId of i2cPinIds) {
        const n = runnerPinIndex(board, pinId);
        if (n !== undefined) busPins.add(n);
      }
      sdaPin = i2cPinIds[0] ? runnerPinIndex(board, i2cPinIds[0]) : undefined;
      sclPin = i2cPinIds[1] ? runnerPinIndex(board, i2cPinIds[1]) : undefined;
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
      const spec = def ? MULTIPLEXED_PARTS[def.id] : undefined;
      if (!spec) continue;
      for (const pinId of [...spec.commons, ...spec.elements]) {
        const netId = this.netOfInstancePin(inst.id, pinId);
        if (netId) this.switchedNets.add(netId);
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

    // RESET is a level, not a byte, so a display only learns about it when
    // something asks. Sampling once per slice is enough: a reset pulse is held
    // for milliseconds, not microseconds, by every driver that issues one.
    for (const device of this.spiDevices) {
      const resettable = device as { settle?: () => void };
      if (typeof resettable.settle === 'function') resettable.settle();
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
      } else if (existing.volts !== volts && existing.seriesOhms === 0 && seriesOhms === 0) {
        existing.conflict = true;
        if (volts < existing.volts) existing.volts = volts; // ground wins, like real shorts (roughly)
      }
    };

    for (const netId of this.groundNets) setLevel(netId, 0, null, 0);
    for (const [netId, v] of this.supplyNets) if (!this.groundNets.has(netId)) setLevel(netId, v, null, 0);

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
            state.value = controls.potPositions.get(`${inst.id}#x`) ?? 0.5;
            this.driveJoystickAxes(inst.id, controls, runner, levelOf);
          }
          visuals.set(inst.id, state);
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
