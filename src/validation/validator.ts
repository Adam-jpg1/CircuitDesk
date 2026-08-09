// Rule-based electrical + code cross-reference validation over the circuit graph.

import { uid, type CircuitProject, type ValidationIssue, type PinDefinition } from '../types';
import { buildCircuitGraph, splitNode, type CircuitGraph } from '../circuit/nets';
import { arduinoPinNumber } from '../boards/pinMaps';
import { analyzeCodePins } from '../compiler/codeAnalysis';
import { resolvePin } from '../project/partsRegistry';

interface NetInfo {
  id: string;
  pins: { instId: string; pinId: string; pin: PinDefinition; isBoard: boolean; defId: string }[];
  hasGround: boolean;
  maxSupplyVolts: number;
  boardDigitalPins: number[];
}

function issue(
  ruleId: string,
  severity: ValidationIssue['severity'],
  title: string,
  description: string,
  opts: Partial<Pick<ValidationIssue, 'why' | 'suggestedFix' | 'affectedComponentIds' | 'affectedConnectionIds'>> = {},
): ValidationIssue {
  return {
    id: uid('issue'),
    ruleId,
    severity,
    title,
    description,
    why: opts.why,
    suggestedFix: opts.suggestedFix,
    affectedComponentIds: opts.affectedComponentIds ?? [],
    affectedConnectionIds: opts.affectedConnectionIds ?? [],
  };
}

function collectNetInfo(graph: CircuitGraph): Map<string, NetInfo> {
  const out = new Map<string, NetInfo>();
  for (const net of graph.nets) {
    const info: NetInfo = { id: net.id, pins: [], hasGround: false, maxSupplyVolts: 0, boardDigitalPins: [] };
    for (const node of net.nodes) {
      const [instId, pinId] = splitNode(node);
      const def = graph.definitions.get(instId);
      const pin = resolvePin(def, pinId);
      if (!def || !pin) continue;
      info.pins.push({ instId, pinId, pin, isBoard: Boolean(def.isBoard), defId: def.id });
      if (pin.type === 'ground') info.hasGround = true;
      if (pin.type === 'power-5v') info.maxSupplyVolts = Math.max(info.maxSupplyVolts, 5);
      if (pin.type === 'power-3v3') info.maxSupplyVolts = Math.max(info.maxSupplyVolts, 3.3);
      if (pin.type === 'power-vin') info.maxSupplyVolts = Math.max(info.maxSupplyVolts, pin.voltage ?? 9);
      if (def.isBoard && (pin.type === 'digital' || pin.type === 'analog')) {
        const n = arduinoPinNumber(def, pinId);
        if (n !== undefined) info.boardDigitalPins.push(n);
      }
    }
    out.set(net.id, info);
  }
  return out;
}

export function validateProject(project: CircuitProject): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const graph = buildCircuitGraph(project);
  const nets = collectNetInfo(graph);
  const netOf = (instId: string, pinId: string) => graph.netOf.get(`${instId}:${pinId}`);
  const netInfo = (instId: string, pinId: string) => {
    const n = netOf(instId, pinId);
    return n ? nets.get(n) : undefined;
  };
  const code = analyzeCodePins(project.codeFiles);
  const board = project.boardInstances[0];
  const boardDef = board ? graph.definitions.get(board.id) : undefined;
  const boardLogicVoltage = boardDef?.isBoard ? Number(boardDef.metadata.logicVoltage ?? 5) : 5;

  const connectionsOf = (instId: string, pinId?: string) =>
    project.connections
      .filter(
        (c) =>
          (c.sourceComponentId === instId && (!pinId || c.sourcePinId === pinId)) ||
          (c.targetComponentId === instId && (!pinId || c.targetPinId === pinId)),
      )
      .map((c) => c.id);

  const hasAnyComponents = project.componentInstances.length > 0;
  const hasAnyConnections = project.connections.length > 0;

  // --- missing ground / power ---
  if (hasAnyComponents && hasAnyConnections) {
    const anyGround = [...nets.values()].some((n) => n.hasGround && n.pins.length > 1);
    if (!anyGround) {
      issues.push(
        issue('missing-ground', 'error', 'No ground connection', 'No component is connected to a ground (GND) pin.', {
          why: 'Every circuit needs a complete return path to ground; without it no current can flow.',
          suggestedFix: 'Wire the low side of your circuit to one of the board GND pins.',
        }),
      );
    }
  }

  for (const inst of project.componentInstances) {
    const def = graph.definitions.get(inst.id);
    if (!def || def.isBoard) continue;
    const name = inst.label || def.name;

    // required power pins connected & powered
    for (const pin of def.pins) {
      if (pin.type === 'power-5v' || pin.type === 'power-3v3') {
        const conns = connectionsOf(inst.id, pin.id);
        if (conns.length === 0) {
          issues.push(
            issue('missing-power', 'warning', `${name}: ${pin.label} not connected`,
              `The supply pin ${pin.label} of ${name} is not connected to any power source.`, {
                affectedComponentIds: [inst.id],
                suggestedFix: `Wire ${pin.label} to the board ${pin.type === 'power-5v' ? '5V' : '3.3V'} pin.`,
              }),
          );
        } else {
          const info = netInfo(inst.id, pin.id);
          if (info && info.maxSupplyVolts === 0) {
            issues.push(
              issue('missing-power', 'warning', `${name}: ${pin.label} has no supply`,
                `${pin.label} is wired, but nothing on its net provides power.`, {
                  affectedComponentIds: [inst.id],
                  affectedConnectionIds: conns,
                }),
            );
          }
        }
      }
      if (pin.type === 'ground' && def.category !== 'Breadboards') {
        const conns = connectionsOf(inst.id, pin.id);
        if (conns.length > 0) {
          const info = netInfo(inst.id, pin.id);
          if (info && !info.hasGround) {
            // wired but the net never reaches a real ground
          }
        }
      }
    }

    // --- LED rules ---
    if (def.validationRules.includes('led-needs-resistor')) {
      const anodePins = def.pins.filter((p) => p.type === 'anode');
      const cathodePins = def.pins.filter((p) => p.type === 'cathode');
      for (const anode of anodePins) {
        const aInfo = netInfo(inst.id, anode.id);
        const cInfo = cathodePins[0] ? netInfo(inst.id, cathodePins[0].id) : undefined;
        if (!aInfo || !cInfo) continue;
        const anodeDirectlyDriven = aInfo.boardDigitalPins.length > 0 || aInfo.maxSupplyVolts >= 3;
        const cathodeDirectlyGrounded = cInfo.hasGround;
        if (anodeDirectlyDriven && cathodeDirectlyGrounded) {
          issues.push(
            issue('led-needs-resistor', 'error', `${name}: no current-limiting resistor`,
              `${name} (${anode.label}) is driven directly with no series resistor anywhere in the path.`, {
                why: 'Without a resistor an LED draws far more than the 20 mA pin limit — in real hardware this damages the LED and can damage the GPIO pin.',
                suggestedFix: 'Put a 220 Ω–1 kΩ resistor in series with the LED.',
                affectedComponentIds: [inst.id],
                affectedConnectionIds: connectionsOf(inst.id),
              }),
          );
        }
        // reversed polarity
        if (cInfo.maxSupplyVolts >= 3 && aInfo.hasGround) {
          issues.push(
            issue('led-polarity', 'error', `${name}: reversed polarity`,
              `The cathode of ${name} is wired toward the supply and the anode toward ground.`, {
                why: 'LEDs only conduct in one direction; reversed, it will never light.',
                suggestedFix: 'Swap the two LED connections.',
                affectedComponentIds: [inst.id],
                affectedConnectionIds: connectionsOf(inst.id),
              }),
          );
        }
      }
    }

    // --- motors need drivers ---
    if (def.validationRules.includes('motor-needs-driver')) {
      for (const pin of def.pins) {
        const info = netInfo(inst.id, pin.id);
        if (info && info.boardDigitalPins.length > 0) {
          issues.push(
            issue('motor-needs-driver', 'error', `${name} wired directly to a GPIO pin`,
              `${name} draws far more current than a GPIO pin can source.`, {
                why: 'DC motors typically draw hundreds of mA plus inductive kickback; GPIO pins are limited to ~20-40 mA.',
                suggestedFix: 'Drive the motor through a transistor/MOSFET or a motor driver module, with a flyback diode.',
                affectedComponentIds: [inst.id],
                affectedConnectionIds: connectionsOf(inst.id, pin.id),
              }),
          );
          break;
        }
      }
    }
  }

  // --- 5V into 3.3V-only pins ---
  for (const [, info] of nets) {
    if (info.maxSupplyVolts < 5) {
      const anyBoard5vOut = info.boardDigitalPins.length > 0 && boardLogicVoltage === 5;
      if (!anyBoard5vOut) continue;
    }
    for (const entry of info.pins) {
      const throughConverter = entry.defId === 'comp.level-converter';
      if (throughConverter) continue;
      if (entry.pin.voltage === 3.3 && (entry.pin.type === 'digital' || entry.pin.type === 'power-3v3') && !entry.isBoard) {
        const fiveVoltSource =
          info.maxSupplyVolts >= 5 ||
          (info.boardDigitalPins.length > 0 && boardLogicVoltage === 5);
        if (fiveVoltSource) {
          const inst = graph.instances.find((i) => i.id === entry.instId);
          const def = graph.definitions.get(entry.instId);
          issues.push(
            issue('voltage-level', 'error', `5 V signal into 3.3 V-only pin`,
              `${def?.name ?? 'Component'} pin ${entry.pin.label} is rated for 3.3 V but its net carries 5 V.`, {
                why: 'Overdriving a 3.3 V input can permanently damage the part.',
                suggestedFix: 'Use a logic level converter or a voltage divider between the 5 V signal and this pin.',
                affectedComponentIds: inst ? [inst.id] : [],
                affectedConnectionIds: connectionsOf(entry.instId, entry.pinId),
              }),
          );
        }
      }
    }
  }

  // --- output-to-output shorts (uses code pinMode info) ---
  for (const [, info] of nets) {
    const outputs = info.boardDigitalPins.filter((p) => code.modes.get(p) === 'OUTPUT');
    if (outputs.length >= 2) {
      issues.push(
        issue('output-short', 'error', `Two outputs shorted together`,
          `Board pins ${outputs.map((p) => (p >= 14 ? `A${p - 14}` : `D${p}`)).join(' and ')} are wired to the same net and both are configured as OUTPUT in code.`, {
            why: 'If one drives HIGH while the other drives LOW, a large short-circuit current flows between the pins.',
            suggestedFix: 'Remove one of the connections, or reconfigure one pin as an input.',
          }),
      );
    }
    if (info.maxSupplyVolts >= 3 && info.hasGround) {
      const direct = info.pins.every((p) => p.pin.type !== 'passive');
      if (direct && info.pins.some((p) => p.pin.type.startsWith('power')) ) {
        issues.push(
          issue('supply-short', 'error', 'Power shorted to ground',
            'A supply pin and a ground pin are wired to the same net with no load between them.', {
              why: 'This is a dead short across the supply.',
              suggestedFix: 'Remove the wire connecting power directly to ground.',
            }),
        );
      }
    }
  }

  // --- GPIO over-current (LED with tiny resistor) ---
  for (const inst of project.componentInstances) {
    const def = graph.definitions.get(inst.id);
    if (def?.id !== 'comp.resistor') continue;
    const ohms = Number(inst.properties.resistance ?? 220);
    if (ohms > 0 && ohms < 120) {
      const infoA = netInfo(inst.id, 'p1');
      const infoB = netInfo(inst.id, 'p2');
      if ((infoA?.boardDigitalPins.length || infoB?.boardDigitalPins.length)) {
        issues.push(
          issue('gpio-overcurrent', 'warning', `Series resistance is only ${ohms} Ω`,
            `A GPIO pin drives through ${ohms} Ω — roughly ${(5 / ohms * 1000).toFixed(0)} mA, above the 20 mA per-pin limit.`, {
              suggestedFix: 'Use at least 150-220 Ω for 5 V GPIO loads.',
              affectedComponentIds: [inst.id],
            }),
        );
      }
    }
  }

  // --- code ↔ circuit cross-checks ---
  // Code↔circuit pin cross-checks only apply to AVR boards with Arduino
  // numbering; a Pico's GP pins are never interpreted as D0-D13.
  if (board && boardDef?.isBoard && (boardDef.architecture ?? 'other') === 'avr') {
    const boardArduinoPins = new Set<number>();
    for (const pin of boardDef.pins) {
      const n = arduinoPinNumber(boardDef, pin.id);
      if (n !== undefined) boardArduinoPins.add(n);
    }
    const connectedArduinoPins = new Set<number>();
    for (const c of project.connections) {
      for (const [instId, pinId] of [[c.sourceComponentId, c.sourcePinId], [c.targetComponentId, c.targetPinId]] as const) {
        if (instId === board.id) {
          const n = arduinoPinNumber(boardDef, pinId);
          if (n !== undefined) connectedArduinoPins.add(n);
        }
      }
    }
    for (const pin of code.usedPins) {
      if (!boardArduinoPins.has(pin)) {
        issues.push(
          issue('code-nonexistent-pin', 'error', `Code references pin ${pin} which does not exist on ${boardDef.name}`,
            `pinMode/digitalWrite/analogRead calls reference pin ${pin}, but the selected board has no such pin.`, {
              suggestedFix: 'Change the pin number in code or switch to a board that has this pin.',
            }),
        );
      } else if (!connectedArduinoPins.has(pin) && project.componentInstances.length > 0) {
        const label = pin >= 14 ? `A${pin - 14}` : `D${pin}`;
        issues.push(
          issue('code-pin-unconnected', 'info', `Code uses ${label} but nothing is wired to it`,
            `The sketch reads or writes ${label}, but no wire is attached to that pin on the canvas.`, {
              suggestedFix: `Wire a component to ${label}, or update the code.`,
            }),
        );
      }
    }
    // floating inputs read by code
    for (const [pin, mode] of code.modes) {
      if (mode === 'INPUT' && connectedArduinoPins.has(pin)) {
        const pinDefId = pin >= 14 ? `A${pin - 14}` : `D${pin}`;
        const info = netInfo(board.id, pinDefId);
        if (info) {
          const hasDriverOrPull =
            info.maxSupplyVolts > 0 || info.hasGround ||
            info.pins.some((p) => ['comp.resistor', 'comp.potentiometer'].includes(p.defId));
          const hasSwitch = info.pins.some((p) => ['comp.push-button', 'comp.toggle-switch'].includes(p.defId));
          if (hasSwitch && !hasDriverOrPull) {
            issues.push(
              issue('floating-input', 'warning', `Floating input on ${pinDefId}`,
                `${pinDefId} is configured as INPUT and wired to a switch, but has no pull-up or pull-down resistor.`, {
                  why: 'When the switch is open the pin floats and reads random values.',
                  suggestedFix: `Use pinMode(${pin}, INPUT_PULLUP) and wire the switch to GND, or add an external pull resistor.`,
                }),
            );
          }
        }
      }
    }
  }

  // --- I2C / UART pin checks ---
  for (const inst of project.componentInstances) {
    const def = graph.definitions.get(inst.id);
    if (!def || def.isBoard) continue;
    for (const pin of def.pins) {
      const wants = pin.capabilities.find((c) => c === 'i2c-sda' || c === 'i2c-scl' || c === 'uart-tx' || c === 'uart-rx');
      if (!wants) continue;
      const info = netInfo(inst.id, pin.id);
      if (!info || info.pins.length <= 1) continue;
      const boardPins = info.pins.filter((p) => p.isBoard);
      if (boardPins.length === 0) continue;
      const ok = boardPins.some((bp) => {
        if (wants === 'i2c-sda') return bp.pin.capabilities.includes('i2c-sda');
        if (wants === 'i2c-scl') return bp.pin.capabilities.includes('i2c-scl');
        if (wants === 'uart-tx') return bp.pin.capabilities.includes('uart-rx') || bp.pin.capabilities.includes('digital-in');
        return bp.pin.capabilities.includes('uart-tx') || bp.pin.capabilities.includes('digital-out');
      });
      if (!ok && (wants === 'i2c-sda' || wants === 'i2c-scl')) {
        issues.push(
          issue('i2c-pins', 'warning', `${def.name}: ${pin.label} not on an I2C-capable pin`,
            `${pin.label} should connect to the board's ${wants === 'i2c-sda' ? 'SDA (A4)' : 'SCL (A5)'} pin for hardware I2C.`, {
              affectedComponentIds: [inst.id],
              affectedConnectionIds: connectionsOf(inst.id, pin.id),
              suggestedFix: wants === 'i2c-sda' ? 'Move this wire to A4/SDA.' : 'Move this wire to A5/SCL.',
            }),
        );
      }
      if (wants === 'uart-tx') {
        const wrongTx = boardPins.some((bp) => bp.pin.capabilities.includes('uart-tx'));
        if (wrongTx) {
          issues.push(
            issue('uart-pins', 'warning', `${def.name}: TX wired to TX`,
              `The module's TX output is wired to the board's TX pin — serial lines must cross (TX→RX).`, {
                affectedComponentIds: [inst.id],
                suggestedFix: 'Swap the two serial wires so module TX goes to board RX.',
              }),
          );
        }
      }
    }
  }

  // --- duplicate I2C devices (same default address) ---
  const i2cDevicesBySda = new Map<string, string[]>();
  for (const inst of project.componentInstances) {
    const def = graph.definitions.get(inst.id);
    const sdaPin = def?.pins.find((p) => p.capabilities.includes('i2c-sda'));
    if (!def || def.isBoard || !sdaPin) continue;
    const n = netOf(inst.id, sdaPin.id);
    if (!n) continue;
    const key = `${n}|${def.id}`;
    i2cDevicesBySda.set(key, [...(i2cDevicesBySda.get(key) ?? []), inst.id]);
  }
  for (const [key, ids] of i2cDevicesBySda) {
    if (ids.length >= 2) {
      issues.push(
        issue('i2c-duplicate-address', 'warning', 'Two identical I2C devices on one bus',
          `Two identical I2C parts share the same bus (${key.split('|')[1]}). They likely have the same address and will conflict.`, {
            affectedComponentIds: ids,
            suggestedFix: 'Change one device\'s address jumper (if available) or use a different bus/multiplexer.',
          }),
      );
    }
  }

  // --- unconnected pins on placed two-pin parts ---
  for (const inst of project.componentInstances) {
    const def = graph.definitions.get(inst.id);
    if (!def || def.isBoard || def.category === 'Breadboards') continue;
    if (def.pins.length <= 4 && project.connections.length > 0) {
      const unconnected = def.pins.filter((p) => p.type !== 'nc' && connectionsOf(inst.id, p.id).length === 0);
      if (unconnected.length > 0 && unconnected.length < def.pins.length) {
        issues.push(
          issue('unconnected-pin', 'info', `${inst.label || def.name}: ${unconnected.map((p) => p.label).join(', ')} unconnected`,
            'Some pins of this part are not wired to anything.', {
              affectedComponentIds: [inst.id],
            }),
        );
      }
    }
  }

  // --- honest simulation-support notices ---
  const unsupported = project.componentInstances.filter((i) => {
    const def = graph.definitions.get(i.id);
    return def && !def.isBoard && def.supportLevel !== 'simulated' && def.category !== 'Breadboards';
  });
  if (unsupported.length > 0) {
    const names = [...new Set(unsupported.map((i) => graph.definitions.get(i.id)?.name ?? '?'))];
    issues.push(
      issue('unsupported-simulation', 'info', `${unsupported.length} part(s) are not firmware-simulated`,
        `${names.slice(0, 5).join(', ')}${names.length > 5 ? '…' : ''} — these parts are validated for wiring but do not react during simulation. Their support badges say so.`, {
          affectedComponentIds: unsupported.map((i) => i.id),
        }),
    );
  }

  const order = { error: 0, warning: 1, info: 2 } as const;
  return issues.sort((a, b) => order[a.severity] - order[b.severity]);
}
