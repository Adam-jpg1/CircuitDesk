// Turning a custom board into a board the rest of the app already understands.
//
// Nothing downstream of this file knows what a custom board is. The canvas, the
// validator, the compiler client, the simulation world and the adapters all take
// a `BoardDefinition`, and a custom board becomes one here — with its own
// identity, its own pins, and the processor, compile and runtime profiles it
// chose. That is what makes a custom board participate "like a native board":
// it does not participate LIKE one, it IS one by the time anything sees it.
//
// Two things this deliberately does not do.
//
// It does not invent capability. `supportedApis` and `supportedPeripherals` come
// from the runtime profile, unedited. A board file cannot type "Simulated"; the
// most it can do is choose a runtime, and the runtime says what it does. A board
// that picks the C6 runtime inherits the C6's silence about UART and ADC.
//
// It does not fall back. A board with no processor gets no compiler and no
// runtime, and Run says so. It is never built for some other chip.

import type { BoardDefinition, PinDefinition, PinCapability, PinType } from '../types';
import { UNITS_PER_MM } from '../types';
import { processorProfile } from '../boards/processorProfiles';
import { compileProfile, runtimeProfile } from '../boards/pipelineProfiles';
import type { CustomBoardDefinition, CustomBoardPin } from './schema';

/** Capabilities implied by a pin's role, before the pad adds any. */
function roleCapabilities(pin: CustomBoardPin): PinCapability[] {
  switch (pin.type) {
    case 'digital':
      return ['digital-in', 'digital-out'];
    case 'analog':
      return ['analog-in'];
    case 'power-5v':
    case 'power-3v3':
    case 'power-vin':
      return ['power'];
    case 'ground':
      return ['ground'];
    default:
      return [];
  }
}

/**
 * What a pin can actually do: its role, plus what the pad it reaches supports.
 *
 * Derived rather than trusted. A board file may claim PWM on a pin; if the pad
 * behind it is not a PWM pad on this processor, validation has already refused
 * the board, and nothing here would add the capability anyway.
 */
function capabilitiesFor(pin: CustomBoardPin, processorProfileId: string | null): PinCapability[] {
  const caps = new Set<PinCapability>(roleCapabilities(pin));
  const processor = processorProfileId ? processorProfile(processorProfileId) : undefined;
  if (processor && pin.pad) {
    if (processor.adcChannels[pin.pad] !== undefined) caps.add('analog-in');
    if (processor.pwmPads.includes(pin.pad)) caps.add('pwm');
    if (processor.interruptPads.includes(pin.pad)) caps.add('interrupt');
    for (const controller of processor.i2c) {
      if (controller.signals.sda?.includes(pin.pad)) caps.add('i2c-sda');
      if (controller.signals.scl?.includes(pin.pad)) caps.add('i2c-scl');
    }
    for (const controller of processor.spi) {
      if (controller.signals.sck?.includes(pin.pad)) caps.add('spi-sck');
      if (controller.signals.mosi?.includes(pin.pad)) caps.add('spi-mosi');
      if (controller.signals.miso?.includes(pin.pad)) caps.add('spi-miso');
      if (controller.signals.ss?.includes(pin.pad)) caps.add('spi-ss');
    }
    for (const controller of processor.uarts) {
      if (controller.signals.tx?.includes(pin.pad)) caps.add('uart-tx');
      if (controller.signals.rx?.includes(pin.pad)) caps.add('uart-rx');
    }
  }
  // Anything the board declared that is a real capability name and is not a bus
  // or timing claim the pad has to back up.
  for (const declared of pin.capabilities) {
    if (declared === 'digital-in' || declared === 'digital-out' || declared === 'power' || declared === 'ground') {
      caps.add(declared);
    }
  }
  return [...caps];
}

/**
 * Every name a pin answers to.
 *
 * The processor pad is one of them, deliberately: a sketch or an import written
 * against `GP15` finds the pin whose label is `MOTOR_PWM`, which is the same
 * physical thing. The pin's own id stays the identity that wires are stored
 * against.
 */
function aliasesFor(pin: CustomBoardPin): string[] {
  const aliases = new Set<string>(pin.aliases ?? []);
  if (pin.pad) aliases.add(pin.pad);
  aliases.delete(pin.id);
  return [...aliases];
}

export interface ResolvedCustomBoard {
  board: BoardDefinition;
  /** Physical pin id -> processor pad, for the runner and the validator. */
  padMap: Record<string, string>;
}

/**
 * Builds the BoardDefinition a validated custom board describes.
 *
 * Assumes the definition has already been through `validateCustomBoard`: this
 * is the construction step, not a second line of defence, and calling it on
 * unvalidated input would build a board out of whatever was in the file.
 */
export function resolveCustomBoard(definition: CustomBoardDefinition): ResolvedCustomBoard {
  const processor = definition.processorProfileId ? processorProfile(definition.processorProfileId) : undefined;
  const compile = compileProfile(definition.compileProfileId);
  const runtime = runtimeProfile(definition.runtimeProfileId);

  const pins: PinDefinition[] = definition.pins.map((pin) => {
    const aliases = aliasesFor(pin);
    return {
      id: pin.id,
      label: pin.label,
      x: pin.xMm * UNITS_PER_MM,
      y: pin.yMm * UNITS_PER_MM,
      type: pin.type as PinType,
      capabilities: capabilitiesFor(pin, definition.processorProfileId),
      ...(aliases.length > 0 ? { aliases } : {}),
      ...(pin.voltage !== undefined ? { voltage: pin.voltage } : {}),
      ...(pin.description ? { description: pin.description } : {}),
    };
  });

  const padMap: Record<string, string> = {};
  for (const pin of definition.pins) if (pin.pad) padMap[pin.id] = pin.pad;

  // Compilation is claimed only when a toolchain genuinely targets this
  // processor. `supported` is what the compile path reads, and a board with no
  // processor must not set it.
  const canCompile = Boolean(
    processor && compile && compile.adapter !== 'none' && compile.processorProfileIds.includes(processor.id),
  );
  // And execution only when an emulator genuinely runs it AND accepts what the
  // toolchain emits. Either half missing means no simulation, honestly.
  const canRun = Boolean(
    canCompile &&
    processor && runtime && runtime.engine !== 'none' &&
    runtime.processorProfileIds.includes(processor.id) &&
    compile && runtime.acceptsFormats.includes(compile.artifactFormat),
  );

  const board: BoardDefinition = {
    id: definition.id,
    name: definition.identity.name,
    family: processor ? processor.name : 'Custom board',
    ...(definition.identity.creator ? { manufacturer: definition.identity.creator } : {}),
    architecture: processor?.boardArchitecture ?? 'other',
    processor: processor?.name ?? 'None (wiring only)',
    widthMm: definition.outline.widthMm,
    heightMm: definition.outline.heightMm,
    artwork: definition.outline.artworkSvg
      ? { kind: 'svg', svg: definition.outline.artworkSvg }
      : { kind: 'builtin', builtinId: 'custom-board' },
    pins,
    processorProfileId: definition.processorProfileId ?? undefined,
    compileProfileId: definition.compileProfileId,
    runtimeProfileId: definition.runtimeProfileId,
    padMap,
    compiler: canCompile
      ? {
          provider: 'arduino-cli',
          fqbn: definition.fqbnOverride ?? compile!.fqbn,
          requiredCore: compile!.requiredCore,
          supported: true,
          note: `Built with the ${compile!.name} pipeline for the ${processor!.name}.`,
        }
      : {
          provider: 'none',
          supported: false,
          note: processor
            ? `${definition.identity.name} has no compile pipeline configured.`
            : `${definition.identity.name} has no processor, so nothing is compiled for it.`,
        },
    simulation: canRun
      ? {
          engine: runtime!.engine,
          supported: true,
          // Straight from the runtime profile. A board cannot add to this list;
          // that is what stops an import from declaring itself simulated.
          supportedApis: [...runtime!.supportedApis],
          supportedPeripherals: [...runtime!.supportedPeripherals],
        }
      : { engine: 'none', supported: false, supportedApis: [], supportedPeripherals: [] },
    supportLevel: canRun ? 'simulated' : canCompile ? 'compile' : 'wiring',
    metadata: {
      custom: true,
      customRevision: definition.revision,
      logicVoltage: processor?.logicVolts ?? 3.3,
      color: definition.outline.color ?? '#1e3a5f',
      ...(processor ? { limitation: describeLimits(definition) } : {}),
      ...(definition.identity.hardwareVersion ? { hardwareVersion: definition.identity.hardwareVersion } : {}),
      ...(definition.metadata ?? {}),
    },
    description: definition.identity.description,
    isBoard: true,
  };

  return { board, padMap };
}

/**
 * The honest sentence about what this board will not do.
 *
 * Assembled from the processor's own list, so a custom C6 board says the same
 * thing the native C6 board says — a custom board inherits its processor's
 * limits and cannot talk its way out of them.
 */
export function describeLimits(definition: CustomBoardDefinition): string {
  const processor = definition.processorProfileId ? processorProfile(definition.processorProfileId) : undefined;
  if (!processor) {
    return 'No processor is configured, so this board wires and validates but does not run firmware.';
  }
  const runtime = runtimeProfile(definition.runtimeProfileId);
  if (!runtime || runtime.engine === 'none') {
    return `${processor.name} firmware is not executed by CircuitDesk for this board: it compiles only.`;
  }
  return `Runs on the ${runtime.name}. Not modelled: ${processor.notModelled.join('; ')}.`;
}

/**
 * A capability summary for the Board Studio, from the four things that decide it.
 *
 * The board contributes which pins exist; the processor which pads and buses;
 * the compile profile whether firmware can be produced; the runtime what
 * executing it actually does. Nothing here is typed in by an importer.
 */
export function capabilitySummary(definition: CustomBoardDefinition): {
  processor: string;
  compile: string;
  runtime: string;
  supported: string[];
  notSimulated: string[];
  supportLevel: 'simulated' | 'compile' | 'wiring';
} {
  const { board } = resolveCustomBoard(definition);
  const processor = definition.processorProfileId ? processorProfile(definition.processorProfileId) : undefined;
  const compile = compileProfile(definition.compileProfileId);
  const runtime = runtimeProfile(definition.runtimeProfileId);
  return {
    processor: processor?.name ?? 'None (wiring only)',
    compile: board.compiler?.supported ? compile?.name ?? 'None' : 'None',
    runtime: board.simulation?.supported ? runtime?.name ?? 'None' : 'None',
    supported: board.simulation?.supported ? [...runtime!.supportedApis] : [],
    notSimulated: processor ? [...processor.notModelled] : ['everything: no processor is configured'],
    supportLevel: board.supportLevel as 'simulated' | 'compile' | 'wiring',
  };
}
