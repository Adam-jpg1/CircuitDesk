// Everything that has to be true before a custom board becomes a board.
//
// This runs on untrusted input. A .cdboard.json arrives from another person and
// may be malformed by accident or on purpose, so nothing here trusts a field's
// type, its length, or that it names something real. The rule is that a
// definition either passes every check and is safe to build from, or it is
// refused with a message that says which pin and why.
//
// The messages matter as much as the checks. "Invalid board" tells somebody
// nothing; "Physical pin SDA maps to GP31, but the RP2040 exposes GP0-GP29"
// tells them exactly what to change. Every error here names the thing that is
// wrong and, where there is one, the range it had to be in.

import {
  CUSTOM_BOARD_LIMITS, CUSTOM_BOARD_SCHEMA_VERSION,
  type CustomBoardDefinition, type CustomBoardPin, type PeripheralAssignment, type PinRole,
} from './schema';
import { processorProfile, hasPad, type ProcessorProfile } from '../boards/processorProfiles';
import { compileProfile, runtimeProfile, checkPipeline } from '../boards/pipelineProfiles';

export interface BoardProblem {
  severity: 'error' | 'warning';
  /** Machine-readable, so the studio can highlight the right field. */
  code: string;
  message: string;
  /** Pin this is about, when it is about one. */
  pinId?: string;
}

const PIN_ROLES: PinRole[] = [
  'digital', 'analog', 'power-5v', 'power-3v3', 'power-vin', 'ground', 'reset', 'aref', 'nc',
];

/** Pin roles that are a supply or a return, and must never be a GPIO pad. */
const POWER_ROLES: PinRole[] = ['power-5v', 'power-3v3', 'power-vin', 'ground'];

/**
 * Ids that are safe to put in a file, a URL and a DOM id.
 *
 * Deliberately narrow. An id ends up in element keys and in cache keys, and a
 * permissive pattern here is how markup or a path separator gets somewhere it
 * was never parsed as data.
 */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/** Text a person typed, with control characters and markup delimiters refused. */
function checkText(
  value: unknown,
  field: string,
  maxLength: number,
  problems: BoardProblem[],
  { required = false, pinId }: { required?: boolean; pinId?: string } = {},
): string | undefined {
  if (value === undefined || value === null || value === '') {
    if (required) problems.push({ severity: 'error', code: 'missing-field', message: `${field} is required.`, pinId });
    return undefined;
  }
  if (typeof value !== 'string') {
    problems.push({ severity: 'error', code: 'wrong-type', message: `${field} must be text.`, pinId });
    return undefined;
  }
  if (value.length > maxLength) {
    problems.push({
      severity: 'error',
      code: 'too-long',
      message: `${field} is ${value.length} characters; the limit is ${maxLength}.`,
      pinId,
    });
    return undefined;
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    problems.push({
      severity: 'error',
      code: 'control-characters',
      message: `${field} contains control characters.`,
      pinId,
    });
    return undefined;
  }
  return value;
}

function checkNumber(
  value: unknown,
  field: string,
  min: number,
  max: number,
  problems: BoardProblem[],
  pinId?: string,
): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    problems.push({ severity: 'error', code: 'wrong-type', message: `${field} must be a finite number.`, pinId });
    return undefined;
  }
  if (value < min || value > max) {
    problems.push({
      severity: 'error',
      code: 'out-of-range',
      message: `${field} is ${value}; it must be between ${min} and ${max}.`,
      pinId,
    });
    return undefined;
  }
  return value;
}

/** The pads a pin's role is allowed to reach on this processor. */
function checkPadForRole(
  pin: CustomBoardPin,
  processor: ProcessorProfile,
  boardName: string,
  problems: BoardProblem[],
): void {
  if (pin.pad === null || pin.pad === undefined) {
    // A GPIO pin that reaches no pad is a pin firmware can never touch. Not an
    // error — plenty of boards have test points and unconnected headers — but
    // worth saying, because a user who meant to map it will not otherwise find
    // out until their sketch does nothing.
    if (pin.type === 'digital' || pin.type === 'analog') {
      problems.push({
        severity: 'warning',
        code: 'pin-unmapped',
        message: `${boardName}: ${pin.label} is a signal pin with no processor pad, so firmware cannot drive or read it.`,
        pinId: pin.id,
      });
    }
    return;
  }

  if (POWER_ROLES.includes(pin.type)) {
    problems.push({
      severity: 'error',
      code: 'power-pin-mapped',
      message:
        `${boardName}: ${pin.label} is a ${pin.type} pin but maps to processor pad ${pin.pad}. ` +
        'Supply and ground pins connect to the board\'s power net, not to a GPIO.',
      pinId: pin.id,
    });
    return;
  }

  if (!hasPad(processor, pin.pad)) {
    const pads = processor.pads;
    const range = pads.length > 0 ? `${pads[0]}-${pads[pads.length - 1]}` : 'none';
    problems.push({
      severity: 'error',
      code: 'pad-not-on-processor',
      message:
        `${boardName}: physical pin ${pin.label} maps to ${pin.pad}, ` +
        `but the ${processor.name} exposes ${range} in this profile.`,
      pinId: pin.id,
    });
    return;
  }

  if (pin.type === 'analog' && processor.adcChannels[pin.pad] === undefined) {
    problems.push({
      severity: 'error',
      code: 'pad-has-no-adc',
      message:
        `${boardName}: ${pin.label} is declared analog and maps to ${pin.pad}, ` +
        `which is not an ADC input on the ${processor.name}. ` +
        `Its ADC pads are ${Object.keys(processor.adcChannels).join(', ') || 'none in this profile'}.`,
      pinId: pin.id,
    });
  }

  if (pin.capabilities.includes('pwm') && !processor.pwmPads.includes(pin.pad)) {
    problems.push({
      severity: 'error',
      code: 'pad-has-no-pwm',
      message:
        `${boardName}: ${pin.label} claims PWM and maps to ${pin.pad}, ` +
        `which the ${processor.name} profile does not drive with PWM.`,
      pinId: pin.id,
    });
  }
}

/**
 * Validates a candidate definition and reports everything wrong with it.
 *
 * Returns problems rather than throwing, and reports ALL of them rather than
 * the first: somebody fixing an imported pin map wants the list, not one error
 * at a time.
 */
export function validateCustomBoard(raw: unknown): { problems: BoardProblem[]; board?: CustomBoardDefinition } {
  const problems: BoardProblem[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { problems: [{ severity: 'error', code: 'not-an-object', message: 'A board definition must be an object.' }] };
  }
  const d = raw as Partial<CustomBoardDefinition>;

  // ---- identity
  const schemaVersion = checkText(d.schemaVersion, 'schemaVersion', 16, problems, { required: true });
  if (schemaVersion && schemaVersion.split('.')[0] !== CUSTOM_BOARD_SCHEMA_VERSION.split('.')[0]) {
    problems.push({
      severity: 'error',
      code: 'schema-version',
      message: `This board was written for schema ${schemaVersion}; this build reads ${CUSTOM_BOARD_SCHEMA_VERSION}.`,
    });
  }
  const id = checkText(d.id, 'id', CUSTOM_BOARD_LIMITS.maxIdLength, problems, { required: true });
  if (id !== undefined) {
    if (!ID_PATTERN.test(id)) {
      problems.push({
        severity: 'error',
        code: 'bad-id',
        message: `Board id "${id}" may only contain letters, numbers, dots, dashes and underscores.`,
      });
    }
    if (!id.startsWith('custom.')) {
      problems.push({
        severity: 'error',
        code: 'bad-id-prefix',
        message: `Board id "${id}" must start with "custom." so it can never collide with a built-in board.`,
      });
    }
  }
  const revision = checkNumber(d.revision, 'revision', 1, 1_000_000, problems);
  const identity = (d.identity ?? {}) as Partial<CustomBoardDefinition['identity']>;
  const name = checkText(identity.name, 'identity.name', CUSTOM_BOARD_LIMITS.maxNameLength, problems, { required: true });
  checkText(identity.creator, 'identity.creator', CUSTOM_BOARD_LIMITS.maxNameLength, problems);
  checkText(identity.description, 'identity.description', CUSTOM_BOARD_LIMITS.maxDescriptionLength, problems);
  checkText(identity.hardwareVersion, 'identity.hardwareVersion', 32, problems);
  const boardName = name ?? 'This board';

  // ---- outline
  const outline = (d.outline ?? {}) as Partial<CustomBoardDefinition['outline']>;
  const widthMm = checkNumber(outline.widthMm, 'outline.widthMm', CUSTOM_BOARD_LIMITS.minBoardMm, CUSTOM_BOARD_LIMITS.maxBoardMm, problems);
  const heightMm = checkNumber(outline.heightMm, 'outline.heightMm', CUSTOM_BOARD_LIMITS.minBoardMm, CUSTOM_BOARD_LIMITS.maxBoardMm, problems);
  if (outline.artworkSvg !== undefined) {
    if (typeof outline.artworkSvg !== 'string') {
      problems.push({ severity: 'error', code: 'wrong-type', message: 'outline.artworkSvg must be text.' });
    } else if (outline.artworkSvg.length > CUSTOM_BOARD_LIMITS.maxArtworkBytes) {
      problems.push({
        severity: 'error',
        code: 'artwork-too-large',
        message: `The board artwork is ${Math.round(outline.artworkSvg.length / 1024)} KB; the limit is ${CUSTOM_BOARD_LIMITS.maxArtworkBytes / 1024} KB.`,
      });
    }
  }
  if (outline.color !== undefined && !/^#[0-9a-fA-F]{6}$/.test(String(outline.color))) {
    problems.push({ severity: 'error', code: 'bad-color', message: 'outline.color must be a #rrggbb value.' });
  }

  // ---- pipeline
  const processorId = d.processorProfileId ?? null;
  let processor: ProcessorProfile | undefined;
  if (processorId !== null) {
    if (typeof processorId !== 'string') {
      problems.push({ severity: 'error', code: 'wrong-type', message: 'processorProfileId must be text or null.' });
    } else {
      processor = processorProfile(processorId);
      if (!processor) {
        problems.push({
          severity: 'error',
          code: 'unknown-processor',
          message: `"${processorId}" is not a processor CircuitDesk knows. Choose one from the processor list, or none for a wiring-only board.`,
        });
      }
    }
  }
  const compile = typeof d.compileProfileId === 'string' ? compileProfile(d.compileProfileId) : undefined;
  const runtime = typeof d.runtimeProfileId === 'string' ? runtimeProfile(d.runtimeProfileId) : undefined;
  if (!compile) {
    problems.push({
      severity: 'error',
      code: 'unknown-compile-profile',
      message: `"${String(d.compileProfileId)}" is not a compile profile CircuitDesk provides.`,
    });
  }
  if (!runtime) {
    problems.push({
      severity: 'error',
      code: 'unknown-runtime-profile',
      message: `"${String(d.runtimeProfileId)}" is not a runtime profile CircuitDesk provides.`,
    });
  }
  if (processorId !== null && processor && compile && runtime) {
    for (const mismatch of checkPipeline(processorId, compile, runtime)) {
      problems.push({ severity: 'error', code: mismatch.code, message: `${boardName}: ${mismatch.message}` });
    }
  }
  if (processorId === null && compile && compile.adapter !== 'none') {
    problems.push({
      severity: 'error',
      code: 'no-processor-but-compiles',
      message: `${boardName} has no processor, so it cannot use the ${compile.name} toolchain. Choose "No compilation".`,
    });
  }
  // An override may only name an FQBN its own profile declares. Without this,
  // a board file could name any build target on the compiler service.
  if (d.fqbnOverride !== undefined) {
    const override = checkText(d.fqbnOverride, 'fqbnOverride', 120, problems);
    // The targets this pipeline declares: its own, plus the alternates it lists
    // for the SAME chip. Anything else is refused here and, independently, by
    // the compiler service — a board file is untrusted input and this list is
    // the only thing standing between it and a build target it chose itself.
    const allowed = compile ? [compile.fqbn, ...(compile.alternateFqbns ?? [])].filter(Boolean) : [];
    if (override !== undefined && compile && !allowed.includes(override)) {
      problems.push({
        severity: 'error',
        code: 'fqbn-not-in-profile',
        message:
          `${boardName} asks to be built as "${override}", which is not a target of the ${compile.name} profile. ` +
          `That profile builds: ${allowed.join(', ') || 'nothing'}.`,
      });
    }
  }

  // ---- pins
  const rawPins = Array.isArray(d.pins) ? d.pins : [];
  if (!Array.isArray(d.pins)) {
    problems.push({ severity: 'error', code: 'wrong-type', message: 'pins must be a list.' });
  }
  if (rawPins.length === 0) {
    problems.push({ severity: 'error', code: 'no-pins', message: `${boardName} has no pins. A board needs at least one.` });
  }
  if (rawPins.length > CUSTOM_BOARD_LIMITS.maxPins) {
    problems.push({
      severity: 'error',
      code: 'too-many-pins',
      message: `${boardName} declares ${rawPins.length} pins; the limit is ${CUSTOM_BOARD_LIMITS.maxPins}.`,
    });
  }

  const pins: CustomBoardPin[] = [];
  const seenIds = new Set<string>();
  const padOwners = new Map<string, string[]>();
  for (const [index, entry] of rawPins.slice(0, CUSTOM_BOARD_LIMITS.maxPins).entries()) {
    if (!entry || typeof entry !== 'object') {
      problems.push({ severity: 'error', code: 'bad-pin', message: `Pin ${index + 1} is not an object.` });
      continue;
    }
    const p = entry as Partial<CustomBoardPin>;
    const pinId = checkText(p.id, `pins[${index}].id`, CUSTOM_BOARD_LIMITS.maxIdLength, problems, { required: true });
    if (pinId === undefined) continue;
    if (!ID_PATTERN.test(pinId)) {
      problems.push({
        severity: 'error',
        code: 'bad-pin-id',
        message: `Pin id "${pinId}" may only contain letters, numbers, dots, dashes and underscores.`,
        pinId,
      });
      continue;
    }
    if (seenIds.has(pinId)) {
      problems.push({
        severity: 'error',
        code: 'duplicate-pin-id',
        message: `${boardName} declares pin id "${pinId}" more than once. Wires are stored against pin ids, so they must be unique.`,
        pinId,
      });
      continue;
    }
    seenIds.add(pinId);

    const label = checkText(p.label, `pins[${index}].label`, CUSTOM_BOARD_LIMITS.maxLabelLength, problems, { required: true, pinId }) ?? pinId;
    const type = PIN_ROLES.includes(p.type as PinRole) ? (p.type as PinRole) : undefined;
    if (!type) {
      problems.push({
        severity: 'error',
        code: 'bad-pin-type',
        message: `Pin ${label} has type "${String(p.type)}"; it must be one of ${PIN_ROLES.join(', ')}.`,
        pinId,
      });
      continue;
    }
    const xMm = checkNumber(p.xMm, `pins[${index}].xMm`, -CUSTOM_BOARD_LIMITS.maxBoardMm, CUSTOM_BOARD_LIMITS.maxBoardMm, problems, pinId);
    const yMm = checkNumber(p.yMm, `pins[${index}].yMm`, -CUSTOM_BOARD_LIMITS.maxBoardMm, CUSTOM_BOARD_LIMITS.maxBoardMm, problems, pinId);
    if (xMm === undefined || yMm === undefined) continue;
    if (widthMm !== undefined && heightMm !== undefined && (xMm > widthMm || yMm > heightMm)) {
      problems.push({
        severity: 'warning',
        code: 'pin-outside-board',
        message: `Pin ${label} sits at ${xMm}, ${yMm} mm, outside the ${widthMm} × ${heightMm} mm outline.`,
        pinId,
      });
    }

    const pad = p.pad === null || p.pad === undefined ? null : checkText(p.pad, `pins[${index}].pad`, 24, problems, { pinId }) ?? null;
    const capabilities = Array.isArray(p.capabilities)
      ? p.capabilities.filter((c): c is string => typeof c === 'string' && c.length <= 24).slice(0, 16)
      : [];
    const aliases = Array.isArray(p.aliases)
      ? p.aliases
          .filter((a): a is string => typeof a === 'string' && ID_PATTERN.test(a))
          .slice(0, CUSTOM_BOARD_LIMITS.maxAliasesPerPin)
      : undefined;

    const pin: CustomBoardPin = {
      id: pinId,
      label,
      pad,
      xMm,
      yMm,
      type,
      capabilities,
      ...(aliases && aliases.length > 0 ? { aliases } : {}),
      ...(typeof p.voltage === 'number' && Number.isFinite(p.voltage) ? { voltage: p.voltage } : {}),
      ...(typeof p.description === 'string' ? { description: p.description.slice(0, 200) } : {}),
    };
    pins.push(pin);
    if (pad) padOwners.set(pad, [...(padOwners.get(pad) ?? []), pin.label]);
  }

  // Two physical pins on one pad. Legal on real hardware — a header and a test
  // point often share a net — but it has to be deliberate, because the usual
  // cause is a mistake in an imported pin map that would make two pins move
  // together for no visible reason.
  for (const [pad, owners] of padOwners) {
    if (owners.length > 1) {
      problems.push({
        severity: 'warning',
        code: 'pad-shared',
        message:
          `${boardName}: ${owners.join(' and ')} both map to ${pad}. ` +
          'They will behave as one signal: intended for a test point, a mistake otherwise.',
      });
    }
  }

  if (processor) {
    for (const pin of pins) checkPadForRole(pin, processor, boardName, problems);
  } else if (processorId === null) {
    const mapped = pins.filter((p) => p.pad !== null);
    if (mapped.length > 0) {
      problems.push({
        severity: 'warning',
        code: 'pads-without-processor',
        message: `${boardName} has no processor, so the pad mapping on ${mapped.length} pin(s) is recorded but unused.`,
      });
    }
  }

  // ---- peripherals
  if (d.peripherals !== undefined) {
    if (!Array.isArray(d.peripherals)) {
      problems.push({ severity: 'error', code: 'wrong-type', message: 'peripherals must be a list.' });
    } else {
      for (const [index, entry] of d.peripherals.slice(0, 16).entries()) {
        const a = entry as Partial<PeripheralAssignment>;
        if (!a || !['i2c', 'spi', 'uart'].includes(String(a.kind))) {
          problems.push({ severity: 'error', code: 'bad-peripheral', message: `peripherals[${index}] must name i2c, spi or uart.` });
          continue;
        }
        const group = processor
          ? a.kind === 'i2c' ? processor.i2c : a.kind === 'spi' ? processor.spi : processor.uarts
          : [];
        const controller = group.find((c) => c.id === a.controller);
        if (processor && !controller) {
          problems.push({
            severity: 'error',
            code: 'unknown-controller',
            message:
              `${boardName}: ${a.kind} controller "${String(a.controller)}" is not on the ${processor.name}. ` +
              `It has ${group.map((c) => c.id).join(', ') || 'none in this profile'}.`,
          });
          continue;
        }
        for (const [signal, boardPinId] of Object.entries(a.pins ?? {})) {
          const pin = pins.find((x) => x.id === boardPinId);
          if (!pin) {
            problems.push({
              severity: 'error',
              code: 'peripheral-pin-missing',
              message: `${boardName}: ${a.kind} ${signal} names pin "${String(boardPinId)}", which this board does not have.`,
            });
            continue;
          }
          const allowed = controller?.signals[signal];
          if (controller && !allowed) {
            problems.push({
              severity: 'error',
              code: 'unknown-signal',
              message: `${boardName}: ${controller.id} has no signal called "${signal}".`,
              pinId: pin.id,
            });
          } else if (allowed && pin.pad && !allowed.includes(pin.pad)) {
            problems.push({
              severity: 'error',
              code: 'signal-pad-not-allowed',
              message:
                `${boardName}: ${pin.label} is assigned as ${controller!.id} ${signal.toUpperCase()} and maps to ${pin.pad}, ` +
                `which cannot carry that signal. ${controller!.id} ${signal.toUpperCase()} can use ${allowed.join(', ')}.`,
              pinId: pin.id,
            });
          }
        }
      }
    }
  }

  // ---- metadata: bounded strings only, never behaviour
  if (d.metadata !== undefined) {
    if (typeof d.metadata !== 'object' || d.metadata === null || Array.isArray(d.metadata)) {
      problems.push({ severity: 'error', code: 'wrong-type', message: 'metadata must be an object of short strings.' });
    } else {
      const entries = Object.entries(d.metadata);
      if (entries.length > 32) {
        problems.push({ severity: 'error', code: 'too-much-metadata', message: 'metadata may hold at most 32 entries.' });
      }
      for (const [key, value] of entries.slice(0, 32)) {
        if (typeof value !== 'string' || value.length > 200 || key.length > 40) {
          problems.push({
            severity: 'error',
            code: 'bad-metadata',
            message: `metadata.${key.slice(0, 40)} must be a string of at most 200 characters.`,
          });
        }
      }
    }
  }

  if (problems.some((p) => p.severity === 'error')) return { problems };

  const board: CustomBoardDefinition = {
    schemaVersion: CUSTOM_BOARD_SCHEMA_VERSION,
    id: id!,
    revision: revision!,
    identity: {
      name: name!,
      ...(identity.creator ? { creator: identity.creator } : {}),
      ...(identity.description ? { description: identity.description } : {}),
      ...(identity.hardwareVersion ? { hardwareVersion: identity.hardwareVersion } : {}),
    },
    outline: {
      widthMm: widthMm!,
      heightMm: heightMm!,
      ...(typeof outline.artworkSvg === 'string' ? { artworkSvg: outline.artworkSvg } : {}),
      ...(outline.color ? { color: outline.color } : {}),
    },
    pins,
    processorProfileId: processorId,
    compileProfileId: d.compileProfileId!,
    runtimeProfileId: d.runtimeProfileId!,
    ...(d.fqbnOverride ? { fqbnOverride: d.fqbnOverride } : {}),
    ...(Array.isArray(d.peripherals) ? { peripherals: d.peripherals as CustomBoardDefinition['peripherals'] } : {}),
    ...(d.metadata && typeof d.metadata === 'object' ? { metadata: d.metadata as Record<string, string> } : {}),
    ...(typeof d.createdAt === 'string' ? { createdAt: d.createdAt } : {}),
    ...(typeof d.updatedAt === 'string' ? { updatedAt: d.updatedAt } : {}),
  };
  return { problems, board };
}

export const isError = (p: BoardProblem): boolean => p.severity === 'error';
