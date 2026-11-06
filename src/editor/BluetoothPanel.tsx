import { useEffect, useState } from 'react';
import { useSimulationStore } from '../simulation/simulationStore';
import { simulationController } from '../simulation/simulationController';
import type { BleDeviceView } from '../simulation/bluetooth/air';
import type { GattCharacteristic, GattService, ScanEntry } from '../simulation/bluetooth/central';

/**
 * The simulated Bluetooth LE air: which boards are advertising or connected,
 * and the workbench as a central that can connect to one, browse its GATT
 * server, and read, write and subscribe to its characteristics, as a phone
 * running a BLE explorer would.
 */

/** Well-known 16-bit UUIDs, so a listing reads as more than hex. */
const KNOWN: Record<string, string> = {
  '1800': 'Generic Access', '1801': 'Generic Attribute', '180A': 'Device Information', '180F': 'Battery',
  '181A': 'Environmental Sensing', '180D': 'Heart Rate', '1809': 'Health Thermometer', '2A00': 'Device Name',
  '2A01': 'Appearance', '2A05': 'Service Changed', '2A19': 'Battery Level', '2A6E': 'Temperature',
  '2A6F': 'Humidity', '2A37': 'Heart Rate Measurement', '2A29': 'Manufacturer Name', '2AA6': 'Central Address Resolution',
  '6E400001-B5A3-F393-E0A9-E50E24DCCA9E': 'Nordic UART', '6E400002-B5A3-F393-E0A9-E50E24DCCA9E': 'UART RX',
  '6E400003-B5A3-F393-E0A9-E50E24DCCA9E': 'UART TX',
};

function name(uuid: string): string {
  return KNOWN[uuid] ? `${KNOWN[uuid]} (${uuid})` : uuid;
}

function show(bytes: Uint8Array): string {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  const printable = /^[\x20-\x7e]*$/.test(text);
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join(' ');
  return printable && bytes.length > 0 ? `"${text}"  (${hex})` : hex || '(empty)';
}

/** Waits for the board while the simulation runs on its own; gives up after a while. */
function withTimeout<T>(p: Promise<T>, ms = 6000): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error('The board did not answer in time.')), ms))]);
}

export function BluetoothPanel() {
  const status = useSimulationStore((s) => s.status);
  const running = status === 'running' || status === 'paused';
  const [devices, setDevices] = useState<BleDeviceView[]>([]);
  const [scan, setScan] = useState<ScanEntry[]>([]);
  const [connected, setConnected] = useState<string | null>(null);
  const [services, setServices] = useState<GattService[]>([]);
  const [values, setValues] = useState<Record<number, string>>({});
  const [subscribed, setSubscribed] = useState<Record<number, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [writeText, setWriteText] = useState<Record<number, string>>({});

  useEffect(() => {
    if (!running) {
      setDevices([]);
      setScan([]);
      setConnected(null);
      setServices([]);
      return;
    }
    const air = simulationController.bluetoothAir;
    const refresh = () => {
      setDevices(air.devices());
      setScan(simulationController.bluetoothCentral.scan());
    };
    refresh();
    const off = air.onChange(refresh);
    const timer = setInterval(refresh, 1000);
    const central = simulationController.bluetoothCentral;
    central.onNotify = (handle, value) => setValues((v) => ({ ...v, [handle]: show(value) }));
    central.onDisconnect = () => {
      setConnected(null);
      setServices([]);
      setSubscribed({});
    };
    return () => {
      off();
      clearInterval(timer);
    };
  }, [running, status]);

  const act = async (f: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await f();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const connect = (entry: ScanEntry) =>
    act(async () => {
      const central = simulationController.bluetoothCentral;
      await withTimeout(central.connect(entry.address));
      setConnected(entry.label);
      await withTimeout(central.exchangeMtu());
      setServices(await withTimeout(central.discover(), 15000));
      setValues({});
    });

  const read = (c: GattCharacteristic) =>
    act(async () => {
      const v = await withTimeout(simulationController.bluetoothCentral.read(c.valueHandle));
      setValues((s) => ({ ...s, [c.valueHandle]: show(v) }));
    });

  const write = (c: GattCharacteristic) =>
    act(async () => {
      const text = writeText[c.valueHandle] ?? '';
      await withTimeout(simulationController.bluetoothCentral.write(c.valueHandle, new TextEncoder().encode(text), c.properties.write));
    });

  const subscribe = (c: GattCharacteristic) =>
    act(async () => {
      const on = !subscribed[c.valueHandle];
      await withTimeout(simulationController.bluetoothCentral.subscribe(c, on));
      setSubscribed((s) => ({ ...s, [c.valueHandle]: on }));
    });

  const cell = { paddingRight: 14 } as const;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, overflow: 'auto', padding: '8px 10px', gap: 8, fontSize: 12.5 }}>
      <div>
        <strong>Boards with Bluetooth</strong>
        {!running ? (
          <div style={{ color: 'var(--text-2)' }}>Run the simulation to see which boards advertise.</div>
        ) : devices.length === 0 ? (
          <div style={{ color: 'var(--text-2)' }}>
            No board has started Bluetooth. ESP32, ESP32-S3, ESP32-CAM and ESP32-C3 sketches start it with BLEDevice::init(), and Pico W sketches with BLE.begin().
          </div>
        ) : (
          <table style={{ borderCollapse: 'collapse', marginTop: 4 }}>
            <thead>
              <tr style={{ textAlign: 'left', color: 'var(--text-2)' }}>
                <th style={cell}>Board</th>
                <th style={cell}>Address</th>
                <th style={cell}>Advertising</th>
                <th style={cell}>Name</th>
                <th>Links</th>
              </tr>
            </thead>
            <tbody>
              {devices.map((d) => (
                <tr key={d.label + d.address}>
                  <td style={cell}>{d.label}</td>
                  <td style={{ ...cell, fontFamily: 'monospace' }}>{d.address}</td>
                  <td style={cell}>{d.advertising ? (d.connectable ? 'yes, connectable' : 'yes') : 'no'}</td>
                  <td style={cell}>{d.name ?? '—'}</td>
                  <td>{d.connections}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div>
        <strong>Connect from the workbench</strong>
        {connected ? (
          <div style={{ marginTop: 4 }}>
            Connected to {connected}.{' '}
            <button className="btn sm" disabled={busy} onClick={() => simulationController.bluetoothCentral.disconnect()}>
              Disconnect
            </button>
          </div>
        ) : scan.length === 0 ? (
          <div style={{ color: 'var(--text-2)' }}>{running ? 'Nothing is advertising.' : ''}</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 4 }}>
            {scan.map((e) => (
              <div key={e.address}>
                <button className="btn sm" disabled={busy || !e.connectable} onClick={() => void connect(e)}>
                  {busy ? 'Working…' : 'Connect'}
                </button>{' '}
                {e.name ?? e.label} <span style={{ fontFamily: 'monospace', color: 'var(--text-2)' }}>{e.address}</span>
                {e.services.length > 0 && <span style={{ color: 'var(--text-2)' }}> · {e.services.map(name).join(', ')}</span>}
              </div>
            ))}
          </div>
        )}
        <div style={{ color: 'var(--text-2)', fontSize: 11.5, marginTop: 4 }}>
          The workbench acts as a phone would: it connects, lists the board's GATT services, and reads, writes and
          subscribes. Pairing and encryption are not simulated.
        </div>
      </div>

      {error && <div style={{ color: '#ff8a80' }}>{error}</div>}

      {services.map((svc) => (
        <div key={svc.start} style={{ borderTop: '1px solid var(--border)', paddingTop: 6 }}>
          <strong>{name(svc.uuid)}</strong>
          {svc.characteristics.map((c) => (
            <div key={c.valueHandle} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, padding: '3px 0 3px 12px' }}>
              <span style={{ minWidth: 220 }}>{name(c.uuid)}</span>
              {c.properties.read && (
                <button className="btn sm" disabled={busy} onClick={() => void read(c)}>
                  Read
                </button>
              )}
              {(c.properties.notify || c.properties.indicate) && c.cccdHandle !== undefined && (
                <button className="btn sm" disabled={busy} onClick={() => void subscribe(c)}>
                  {subscribed[c.valueHandle] ? 'Unsubscribe' : c.properties.notify ? 'Notify' : 'Indicate'}
                </button>
              )}
              {(c.properties.write || c.properties.writeWithoutResponse) && (
                <>
                  <input
                    aria-label={`Value to write to ${c.uuid}`}
                    style={{ width: 120 }}
                    value={writeText[c.valueHandle] ?? ''}
                    onChange={(e) => setWriteText((s) => ({ ...s, [c.valueHandle]: e.target.value }))}
                  />
                  <button className="btn sm" disabled={busy} onClick={() => void write(c)}>
                    Write
                  </button>
                </>
              )}
              {values[c.valueHandle] !== undefined && <span style={{ fontFamily: 'monospace' }}>{values[c.valueHandle]}</span>}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
