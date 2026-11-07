// InvenSense MPU-6050 6-axis accelerometer + gyroscope on I2C.
//
// The device holds a simulated motion state (acceleration in g, angular rate in
// °/s, die temperature in °C) and publishes the RAW two's-complement counts a
// real MPU-6050 would produce for that state at the currently selected full
// scale. Firmware divides by the sensitivity from its own datasheet reading and
// arrives back at the motion values — the sketch's arithmetic is never
// short-circuited.
//
// The part boots asleep (PWR_MGMT_1 = 0x40). Until firmware clears the SLEEP
// bit the measurement registers read back as zero, exactly as on real silicon,
// so a driver that forgets the wake-up write genuinely fails here too.
//
// NOT modelled, and deliberately not pretended: the FIFO, the DMP (motion
// processing firmware), the INT pin and its timing, self-test, the auxiliary
// I2C master on XDA/XCL, sample-rate/DLPF timing (samples are always current
// rather than paced by SMPLRT_DIV), and sensor noise. Registers outside the map
// below are recorded as unhandled accesses rather than answered with invented
// data.

import type { DeviceSnapshot } from './types';
import { RegisterI2cDevice } from './registerDevice';

export const MPU6050_ADDRESSES = [0x68, 0x69] as const;
export const MPU6050_WHO_AM_I = 0x68;

const REG_SMPLRT_DIV = 0x19;
const REG_CONFIG = 0x1a;
const REG_GYRO_CONFIG = 0x1b;
const REG_ACCEL_CONFIG = 0x1c;
const REG_INT_PIN_CFG = 0x37;
const REG_INT_ENABLE = 0x38;
const REG_INT_STATUS = 0x3a;
// 0x3B..0x48 is one contiguous big-endian block: accel X/Y/Z, temperature
// (0x41), gyro X/Y/Z — which is why drivers burst-read 14 bytes from 0x3B.
const REG_ACCEL_XOUT_H = 0x3b;
const REG_GYRO_ZOUT_L = 0x48;
const REG_SIGNAL_PATH_RESET = 0x68;
const REG_USER_CTRL = 0x6a;
const REG_PWR_MGMT_1 = 0x6b;
const REG_PWR_MGMT_2 = 0x6c;
const REG_WHO_AM_I = 0x75;

/** LSB per g for AFS_SEL 0..3 (±2/4/8/16 g). */
const ACCEL_LSB_PER_G = [16384, 8192, 4096, 2048];
/** LSB per °/s for FS_SEL 0..3 (±250/500/1000/2000 °/s). */
const GYRO_LSB_PER_DPS = [131, 65.5, 32.8, 16.4];

/** Clamps to the signed 16-bit range the ADC can actually express. */
function toInt16(value: number): number {
  const clamped = Math.max(-32768, Math.min(32767, Math.round(value)));
  return clamped < 0 ? clamped + 0x10000 : clamped;
}

export interface Mpu6050Motion {
  /** Proper acceleration in g along each body axis. */
  accelG: { x: number; y: number; z: number };
  /** Angular rate in degrees per second about each body axis. */
  gyroDps: { x: number; y: number; z: number };
  /** Die temperature in °C. */
  temperatureC: number;
}

export class Mpu6050Device extends RegisterI2cDevice {
  /** Simulated motion state — the UI can drive these later. At rest, flat. */
  motion: Mpu6050Motion = {
    accelG: { x: 0, y: 0, z: 1 },
    gyroDps: { x: 0, y: 0, z: 0 },
    temperatureC: 36.53,
  };

  private pwrMgmt1 = 0x40; // datasheet reset value: asleep, internal 8 MHz clock
  private pwrMgmt2 = 0x00;
  private config = 0x00;
  private gyroConfig = 0x00;
  private accelConfig = 0x00;
  private smplrtDiv = 0x00;
  private intPinCfg = 0x00;
  private intEnable = 0x00;
  private userCtrl = 0x00;

  constructor(instanceId: string, address: number = MPU6050_ADDRESSES[0]) {
    super(instanceId, address);
  }

  /** False until firmware clears the SLEEP bit in PWR_MGMT_1. */
  get isAwake(): boolean {
    return (this.pwrMgmt1 & 0x40) === 0;
  }

  get accelFullScaleG(): number {
    return [2, 4, 8, 16][(this.accelConfig >> 3) & 0x03];
  }

  get gyroFullScaleDps(): number {
    return [250, 500, 1000, 2000][(this.gyroConfig >> 3) & 0x03];
  }

  /** The seven measurement words, as raw counts at the selected full scale. */
  private measurementWords(): number[] {
    if (!this.isAwake) return [0, 0, 0, 0, 0, 0, 0];
    const aLsb = ACCEL_LSB_PER_G[(this.accelConfig >> 3) & 0x03];
    const gLsb = GYRO_LSB_PER_DPS[(this.gyroConfig >> 3) & 0x03];
    const { accelG, gyroDps, temperatureC } = this.motion;
    return [
      toInt16(accelG.x * aLsb),
      toInt16(accelG.y * aLsb),
      toInt16(accelG.z * aLsb),
      // Datasheet: temperature in °C = raw / 340 + 36.53.
      toInt16((temperatureC - 36.53) * 340),
      toInt16(gyroDps.x * gLsb),
      toInt16(gyroDps.y * gLsb),
      toInt16(gyroDps.z * gLsb),
    ];
  }

  protected readRegister(reg: number): number | null {
    if (reg >= REG_ACCEL_XOUT_H && reg <= REG_GYRO_ZOUT_L) {
      const offset = reg - REG_ACCEL_XOUT_H;
      const word = this.measurementWords()[offset >> 1];
      return offset % 2 === 0 ? (word >> 8) & 0xff : word & 0xff;
    }
    switch (reg) {
      case REG_WHO_AM_I:
        return MPU6050_WHO_AM_I;
      case REG_PWR_MGMT_1:
        return this.pwrMgmt1;
      case REG_PWR_MGMT_2:
        return this.pwrMgmt2;
      case REG_CONFIG:
        return this.config;
      case REG_GYRO_CONFIG:
        return this.gyroConfig;
      case REG_ACCEL_CONFIG:
        return this.accelConfig;
      case REG_SMPLRT_DIV:
        return this.smplrtDiv;
      case REG_INT_PIN_CFG:
        return this.intPinCfg;
      case REG_INT_ENABLE:
        return this.intEnable;
      case REG_INT_STATUS:
        // Data-ready latches immediately in this model; no FIFO overflow.
        return this.isAwake ? 0x01 : 0x00;
      case REG_USER_CTRL:
        return this.userCtrl;
      default:
        return null;
    }
  }

  protected writeRegister(reg: number, value: number): boolean {
    switch (reg) {
      case REG_PWR_MGMT_1:
        if (value & 0x80) {
          this.reset();
          this.note('device reset');
          return true;
        }
        this.pwrMgmt1 = value;
        this.note(`pwr_mgmt_1=0x${value.toString(16)} (${this.isAwake ? 'awake' : 'sleep'})`);
        return true;
      case REG_PWR_MGMT_2:
        this.pwrMgmt2 = value;
        return true;
      case REG_CONFIG:
        this.config = value;
        return true;
      case REG_GYRO_CONFIG:
        this.gyroConfig = value;
        this.note(`gyro range ±${this.gyroFullScaleDps} °/s`);
        return true;
      case REG_ACCEL_CONFIG:
        this.accelConfig = value;
        this.note(`accel range ±${this.accelFullScaleG} g`);
        return true;
      case REG_SMPLRT_DIV:
        this.smplrtDiv = value;
        return true;
      case REG_INT_PIN_CFG:
        this.intPinCfg = value;
        return true;
      case REG_INT_ENABLE:
        this.intEnable = value;
        return true;
      case REG_USER_CTRL:
        this.userCtrl = value;
        return true;
      case REG_SIGNAL_PATH_RESET:
        this.note('signal path reset');
        return true;
      default:
        return false;
    }
  }

  reset(): void {
    this.pwrMgmt1 = 0x40;
    this.pwrMgmt2 = 0x00;
    this.config = 0x00;
    this.gyroConfig = 0x00;
    this.accelConfig = 0x00;
    this.smplrtDiv = 0x00;
    this.intPinCfg = 0x00;
    this.intEnable = 0x00;
    this.userCtrl = 0x00;
    this.pointer = 0;
    this.unknownReads = [];
    this.unknownWrites = [];
    this.log = [];
  }

  snapshot(): DeviceSnapshot {
    const { accelG, gyroDps, temperatureC } = this.motion;
    return {
      status:
        `MPU-6050 @0x${this.address.toString(16)}: ${this.isAwake ? 'awake' : 'sleep'}, ` +
        `accel ${accelG.x.toFixed(2)}/${accelG.y.toFixed(2)}/${accelG.z.toFixed(2)} g ` +
        `(±${this.accelFullScaleG} g), gyro ${gyroDps.x.toFixed(0)}/${gyroDps.y.toFixed(0)}/` +
        `${gyroDps.z.toFixed(0)} °/s (±${this.gyroFullScaleDps} °/s), ${temperatureC.toFixed(1)} °C`,
      log: [...this.log],
    };
  }
}
