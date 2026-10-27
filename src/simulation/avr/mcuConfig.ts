// Per-MCU avr8js peripheral configuration (registers + interrupt vectors).
//
// avr8js models peripherals as plain configuration data, so supporting a new
// AVR variant means supplying that chip's register addresses and vector table
// entries — no emulator code is modified or duplicated. Vector values use the
// datasheet's "Program Address (Words)" column, matching avr8js's own
// ATmega328P configs.
//
// This module imports avr8js and therefore lives behind the lazily-loaded
// simulator chunk; pure pin data stays in boards/pinMaps.ts.

import {
  ADCReference,
  ADCMuxInputType,
  adcConfig,
  portBConfig,
  portCConfig,
  portDConfig,
  portEConfig,
  portGConfig,
  portHConfig,
  portLConfig,
  timer0Config,
  timer1Config,
  timer2Config,
  usart0Config,
  twiConfig,
  spiConfig,
  type CPU,
  type AVRTimerConfig,
  type ADCConfig,
  type AVRPortConfig,
} from 'avr8js';
import * as gpio from 'avr8js';
import type { AvrPortName } from '../../boards/pinMaps';

/** avr8js does not export its USART config type by name; mirror the shipped one. */
type UsartConfig = typeof usart0Config;
type TwiConfig = typeof twiConfig;
type SpiConfig = typeof spiConfig;

export interface AvrMcuConfig {
  timers: AVRTimerConfig[];
  /**
   * Hardware I2C (TWI). The register block sits at 0xB8-0xBD on every AVR we
   * support; only the interrupt vector differs per chip.
   */
  twi: TwiConfig;
  /**
   * Hardware SPI. SPCR/SPSR/SPDR sit at 0x4C-0x4E on every AVR we support;
   * only the SPI_STC vector differs per chip.
   */
  spi: SpiConfig;
  /** The hardware UART this board's emulated serial stream comes from. */
  usart: UsartConfig;
  adc: ADCConfig;
  /**
   * Optional per-MCU hardware that avr8js has no peripheral class for but
   * whose absence would stop firmware from booting. Kept deliberately narrow.
   */
  installExtras?: (cpu: CPU) => void;
}

export const PORT_CONFIGS: Record<AvrPortName, AVRPortConfig> = {
  A: gpio.portAConfig,
  B: gpio.portBConfig,
  C: gpio.portCConfig,
  D: gpio.portDConfig,
  E: gpio.portEConfig,
  F: gpio.portFConfig,
  G: gpio.portGConfig,
  H: gpio.portHConfig,
  J: gpio.portJConfig,
  K: gpio.portKConfig,
  L: gpio.portLConfig,
};

// ---------------------------------------------------------------- ATmega328P

const ATMEGA328P: AvrMcuConfig = {
  timers: [timer0Config, timer1Config, timer2Config],
  usart: usart0Config,
  adc: adcConfig,
  twi: twiConfig,
  // SPI_STC is vector 18 -> word address (18-1)*2 = 0x22, which is what the
  // shipped avr8js config already carries.
  spi: spiConfig,
};

// --------------------------------------------------------------- ATmega2560

/** ATmega2560 timer 0: registers match the 328P; vectors and OC pins do not. */
const mega2560Timer0: AVRTimerConfig = {
  ...timer0Config,
  compAInterrupt: 0x2a,
  compBInterrupt: 0x2c,
  ovfInterrupt: 0x2e,
  compPortA: portBConfig.PORT, // OC0A → PB7 (pin 13)
  compPinA: 7,
  compPortB: portGConfig.PORT, // OC0B → PG5 (pin 4)
  compPinB: 5,
};

const mega2560Timer1: AVRTimerConfig = {
  ...timer1Config,
  captureInterrupt: 0x20,
  compAInterrupt: 0x22,
  compBInterrupt: 0x24,
  compCInterrupt: 0x26,
  ovfInterrupt: 0x28,
  OCRC: 0x8c,
  compPortA: portBConfig.PORT, // OC1A → PB5 (pin 11)
  compPinA: 5,
  compPortB: portBConfig.PORT, // OC1B → PB6 (pin 12)
  compPinB: 6,
  compPortC: portBConfig.PORT, // OC1C → PB7
  compPinC: 7,
};

const mega2560Timer2: AVRTimerConfig = {
  ...timer2Config,
  compAInterrupt: 0x1a,
  compBInterrupt: 0x1c,
  ovfInterrupt: 0x1e,
  compPortA: portBConfig.PORT, // OC2A → PB4 (pin 10)
  compPinA: 4,
  compPortB: portHConfig.PORT, // OC2B → PH6 (pin 9)
  compPinB: 6,
};

/** Timers 3-5 are 16-bit units that exist only on the Mega. */
const mega2560Timer3: AVRTimerConfig = {
  ...timer1Config, // inherit 16-bit shape + dividers
  captureInterrupt: 0x3e,
  compAInterrupt: 0x40,
  compBInterrupt: 0x42,
  compCInterrupt: 0x44,
  ovfInterrupt: 0x46,
  TIFR: 0x38,
  TIMSK: 0x71,
  TCCRA: 0x90,
  TCCRB: 0x91,
  TCCRC: 0x92,
  TCNT: 0x94,
  ICR: 0x96,
  OCRA: 0x98,
  OCRB: 0x9a,
  OCRC: 0x9c,
  compPortA: portEConfig.PORT, // OC3A → PE3 (pin 5)
  compPinA: 3,
  compPortB: portEConfig.PORT, // OC3B → PE4 (pin 2)
  compPinB: 4,
  compPortC: portEConfig.PORT, // OC3C → PE5 (pin 3)
  compPinC: 5,
  externalClockPort: 0,
  externalClockPin: 0,
};

const mega2560Timer4: AVRTimerConfig = {
  ...timer1Config,
  captureInterrupt: 0x52,
  compAInterrupt: 0x54,
  compBInterrupt: 0x56,
  compCInterrupt: 0x58,
  ovfInterrupt: 0x5a,
  TIFR: 0x39,
  TIMSK: 0x72,
  TCCRA: 0xa0,
  TCCRB: 0xa1,
  TCCRC: 0xa2,
  TCNT: 0xa4,
  ICR: 0xa6,
  OCRA: 0xa8,
  OCRB: 0xaa,
  OCRC: 0xac,
  compPortA: portHConfig.PORT, // OC4A → PH3 (pin 6)
  compPinA: 3,
  compPortB: portHConfig.PORT, // OC4B → PH4 (pin 7)
  compPinB: 4,
  compPortC: portHConfig.PORT, // OC4C → PH5 (pin 8)
  compPinC: 5,
  externalClockPort: 0,
  externalClockPin: 0,
};

const mega2560Timer5: AVRTimerConfig = {
  ...timer1Config,
  captureInterrupt: 0x5c,
  compAInterrupt: 0x5e,
  compBInterrupt: 0x60,
  compCInterrupt: 0x62,
  ovfInterrupt: 0x64,
  TIFR: 0x3a,
  TIMSK: 0x73,
  TCCRA: 0x120,
  TCCRB: 0x121,
  TCCRC: 0x122,
  TCNT: 0x124,
  ICR: 0x126,
  OCRA: 0x128,
  OCRB: 0x12a,
  OCRC: 0x12c,
  compPortA: portLConfig.PORT, // OC5A → PL3 (pin 46)
  compPinA: 3,
  compPortB: portLConfig.PORT, // OC5B → PL4 (pin 45)
  compPinB: 4,
  compPortC: portLConfig.PORT, // OC5C → PL5 (pin 44)
  compPinC: 5,
  externalClockPort: 0,
  externalClockPin: 0,
};

/** USART0 registers match the 328P; the vector table does not. */
const mega2560Usart0: UsartConfig = {
  ...usart0Config,
  rxCompleteInterrupt: 0x32,
  dataRegisterEmptyInterrupt: 0x34,
  txCompleteInterrupt: 0x36,
};

/**
 * ATmega2560 ADC: 16 single-ended channels. Channels 8-15 are selected with
 * the MUX5 bit in ADCSRB, which avr8js applies as bit 0x20 of the mux index.
 */
const mega2560AdcChannels: ADCConfig['muxChannels'] = (() => {
  const channels: ADCConfig['muxChannels'] = {};
  for (let i = 0; i < 8; i++) {
    channels[i] = { type: ADCMuxInputType.SingleEnded as const, channel: i };
    channels[0x20 + i] = { type: ADCMuxInputType.SingleEnded as const, channel: 8 + i };
  }
  return channels;
})();

const mega2560Adc: ADCConfig = {
  ...adcConfig,
  // ADC is vector 30 on the ATmega2560 → word address (30-1)*2 = 0x3A.
  // 0x38 is the analog comparator (vector 29) — using it would vector ADC
  // completions into the wrong handler whenever a sketch enables ADIE.
  adcInterrupt: 0x3a,
  numChannels: 16,
  muxInputMask: 0x3f, // MUX4:0 plus MUX5 (0x20)
  muxChannels: mega2560AdcChannels,
  adcReferences: [
    ADCReference.AREF,
    ADCReference.AVCC,
    ADCReference.Internal1V1,
    ADCReference.Internal2V56,
  ],
};

/** ATmega2560: TWI is vector 40 -> word address (40-1)*2 = 0x4E. */
const mega2560Twi: TwiConfig = { ...twiConfig, twiInterrupt: 0x4e };

/**
 * ATmega2560: SPI_STC is vector 25 -> word address (25-1)*2 = 0x30. The 328P's
 * 0x22 is TIMER0_OVF territory on this chip, so reusing the shipped config
 * would vector SPI completions into a timer handler whenever SPIE is set.
 */
const mega2560Spi: SpiConfig = { ...spiConfig, spiInterrupt: 0x30 };

const ATMEGA2560: AvrMcuConfig = {
  timers: [mega2560Timer0, mega2560Timer1, mega2560Timer2, mega2560Timer3, mega2560Timer4, mega2560Timer5],
  usart: mega2560Usart0,
  adc: mega2560Adc,
  twi: mega2560Twi,
  spi: mega2560Spi,
};

// --------------------------------------------------------------- ATmega32U4

/**
 * Timer0 on the ATmega32U4: same registers as the 328P, different vectors and
 * output-compare pins (OC0A → PB7 = D11, OC0B → PD0 = D3). T0 is PD7 here.
 */
const atmega32u4Timer0: AVRTimerConfig = {
  ...timer0Config,
  compAInterrupt: 0x2a,
  compBInterrupt: 0x2c,
  ovfInterrupt: 0x2e,
  compPortA: portBConfig.PORT,
  compPinA: 7,
  compPortB: portDConfig.PORT,
  compPinB: 0,
  externalClockPort: portDConfig.PORT,
  externalClockPin: 7,
};

/** Timer1: OC1A → PB5 (D9), OC1B → PB6 (D10), OC1C → PB7 (D11). T1 is PD6. */
const atmega32u4Timer1: AVRTimerConfig = {
  ...timer1Config,
  captureInterrupt: 0x20,
  compAInterrupt: 0x22,
  compBInterrupt: 0x24,
  compCInterrupt: 0x26,
  ovfInterrupt: 0x28,
  OCRC: 0x8c,
  compPortA: portBConfig.PORT,
  compPinA: 5,
  compPortB: portBConfig.PORT,
  compPinB: 6,
  compPortC: portBConfig.PORT,
  compPinC: 7,
  externalClockPort: portDConfig.PORT,
  externalClockPin: 6,
};

/**
 * Timer3 is a 16-bit unit with the same register block as the Mega's Timer3,
 * but the 32U4 only bonds out OC3A (PC6 = D5) — OC3B/OC3C have no pin, so they
 * are left unconnected rather than pointed at some other port.
 */
const atmega32u4Timer3: AVRTimerConfig = {
  ...timer1Config,
  captureInterrupt: 0x3e,
  compAInterrupt: 0x40,
  compBInterrupt: 0x42,
  compCInterrupt: 0x44,
  ovfInterrupt: 0x46,
  TIFR: 0x38,
  TIMSK: 0x71,
  TCCRA: 0x90,
  TCCRB: 0x91,
  TCCRC: 0x92,
  TCNT: 0x94,
  ICR: 0x96,
  OCRA: 0x98,
  OCRB: 0x9a,
  OCRC: 0x9c,
  compPortA: portCConfig.PORT,
  compPinA: 6,
  compPortB: 0,
  compPinB: 0,
  compPortC: 0,
  compPinC: 0,
  externalClockPort: 0,
  externalClockPin: 0,
};

/**
 * The 32U4's hardware UART is USART1 (Arduino's `Serial1` on D0/D1) and it
 * lives at 0xC8, NOT at the 328P's 0xC0 — on this chip 0xC0 is TCCR4A, so
 * reusing usart0Config would alias the UART onto Timer4's registers.
 */
const atmega32u4Usart1: UsartConfig = {
  ...usart0Config,
  rxCompleteInterrupt: 0x32,
  dataRegisterEmptyInterrupt: 0x34,
  txCompleteInterrupt: 0x36,
  UCSRA: 0xc8,
  UCSRB: 0xc9,
  UCSRC: 0xca,
  UBRRL: 0xcc,
  UBRRH: 0xcd,
  UDR: 0xce,
};

/**
 * ADC channels 0-7 only. The 32U4 reaches channels 8-13 through MUX5, which
 * is bit 5 of ADCSRB on this chip — avr8js hardcodes MUX5 as bit 3 (the
 * ATmega2560 position), so those channels cannot be selected correctly and are
 * declared unsupported instead of being wired up to return the wrong pin.
 * Masking with MUX4:0 keeps channels 0-7 correct regardless of ADCSRB bit 3.
 */
const atmega32u4AdcChannels: ADCConfig['muxChannels'] = (() => {
  const channels: ADCConfig['muxChannels'] = {};
  for (let i = 0; i < 8; i++) channels[i] = { type: ADCMuxInputType.SingleEnded as const, channel: i };
  return channels;
})();

const atmega32u4Adc: ADCConfig = {
  ...adcConfig,
  adcInterrupt: 0x3a,
  numChannels: 8,
  muxInputMask: 0x1f,
  muxChannels: atmega32u4AdcChannels,
  // REFS1:0 → AREF, AVCC, reserved, internal 2.56 V (no 1.1 V band gap here).
  adcReferences: [ADCReference.AREF, ADCReference.AVCC, ADCReference.Reserved, ADCReference.Internal2V56],
};

/**
 * The single piece of USB hardware that has to exist for a Leonardo sketch to
 * reach setup(): the USB PLL lock flag.
 *
 * The Arduino 32U4 core calls USBDevice.attach() from main() before setup(),
 * and that spins on `while (!(PLLCSR & (1<<PLOCK)))`. On real silicon the PLL
 * locks a few microseconds after PLLE is set; with no model at all the flag
 * never appears and firmware hangs forever in the boot loop. Reflecting PLLE
 * into PLOCK models exactly that one behavior.
 *
 * The USB controller itself is modelled separately (avr/usb32u4.ts), and the
 * runner attaches it for this MCU.
 */
const PLLCSR = 0x49;
const PLLE = 0b10;
const PLOCK = 0b1;

function installAtmega32u4Extras(cpu: CPU): void {
  cpu.writeHooks[PLLCSR] = (value: number) => {
    cpu.data[PLLCSR] = value & PLLE ? value | PLOCK : value & ~PLOCK;
    return true;
  };
}

/** ATmega32U4: TWI is vector 37 -> word address (37-1)*2 = 0x48. */
const atmega32u4Twi: TwiConfig = { ...twiConfig, twiInterrupt: 0x48 };

/** ATmega32U4: SPI_STC is vector 25 -> word address (25-1)*2 = 0x30. */
const atmega32u4Spi: SpiConfig = { ...spiConfig, spiInterrupt: 0x30 };

const ATMEGA32U4: AvrMcuConfig = {
  timers: [atmega32u4Timer0, atmega32u4Timer1, atmega32u4Timer3],
  usart: atmega32u4Usart1,
  adc: atmega32u4Adc,
  twi: atmega32u4Twi,
  spi: atmega32u4Spi,
  installExtras: installAtmega32u4Extras,
};

export const MCU_CONFIGS: Record<'atmega328p' | 'atmega2560' | 'atmega32u4', AvrMcuConfig> = {
  atmega328p: ATMEGA328P,
  atmega2560: ATMEGA2560,
  atmega32u4: ATMEGA32U4,
};
