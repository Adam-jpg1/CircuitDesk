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
  portEConfig,
  portGConfig,
  portHConfig,
  portLConfig,
  timer0Config,
  timer1Config,
  timer2Config,
  usart0Config,
  type AVRTimerConfig,
  type ADCConfig,
  type AVRPortConfig,
} from 'avr8js';
import * as gpio from 'avr8js';
import type { AvrPortName } from '../../boards/pinMaps';

/** avr8js does not export its USART config type by name; mirror the shipped one. */
type UsartConfig = typeof usart0Config;

export interface AvrMcuConfig {
  timers: AVRTimerConfig[];
  /** Primary Serial (USART0). Additional USARTs are listed as unsupported. */
  usart: UsartConfig;
  adc: ADCConfig;
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

const ATMEGA2560: AvrMcuConfig = {
  timers: [mega2560Timer0, mega2560Timer1, mega2560Timer2, mega2560Timer3, mega2560Timer4, mega2560Timer5],
  usart: mega2560Usart0,
  adc: mega2560Adc,
};

export const MCU_CONFIGS: Record<'atmega328p' | 'atmega2560', AvrMcuConfig> = {
  atmega328p: ATMEGA328P,
  atmega2560: ATMEGA2560,
};
