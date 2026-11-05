import { useEffect, useState } from 'react';
import { useEditorStore } from '../app/editorStore';
import { useSimulationStore } from '../simulation/simulationStore';
import { simulationController } from '../simulation/simulationController';
import { accessPointsIn, type StationView } from '../simulation/wifi/network';
import { fetchFromBoard, type HttpResult } from '../simulation/wifi/workbenchHost';

/**
 * The simulated Wi-Fi network: which boards joined which access point and
 * with what address, and a way to open a board's web server from the bench.
 *
 * A page a board serves is shown as text, or as HTML in a sandboxed frame
 * that runs no scripts and can reach nothing: the HTML comes from a sketch,
 * which may be someone else's.
 */
export function WifiPanel() {
  const project = useEditorStore((s) => s.project);
  const status = useSimulationStore((s) => s.status);
  const [stations, setStations] = useState<StationView[]>([]);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<HttpResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rendered, setRendered] = useState(true);

  const running = status === 'running' || status === 'paused';
  useEffect(() => {
    if (!running) {
      setStations([]);
      return;
    }
    const refresh = () => setStations(simulationController.wifiNetwork.stations());
    refresh();
    const off = simulationController.wifiNetwork.onChange(refresh);
    const timer = setInterval(refresh, 1000);
    return () => {
      off();
      clearInterval(timer);
    };
  }, [running, status]);

  const aps = project ? accessPointsIn(project) : [];
  const placedAps = project?.componentInstances.filter((c) => c.definitionId === 'comp.wifi-ap').length ?? 0;

  useEffect(() => {
    if (!url && stations.length > 0) setUrl(`http://${stations[0].hostname ?? stations[0].ip ?? ''}/`);
  }, [stations, url]);

  const open = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      // The simulation runs on its own; the request is answered as it does.
      const r = await fetchFromBoard(simulationController.wifiNetwork, url, (ms) => new Promise((done) => setTimeout(done, ms)), 8000);
      setResult(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const contentType = result?.headers.find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? '';
  const bodyText = result ? new TextDecoder().decode(result.body) : '';
  const isHtml = /html/i.test(contentType);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, overflow: 'auto', padding: '8px 10px', gap: 8, fontSize: 12.5 }}>
      <div>
        <strong>Access points</strong>{' '}
        {aps.length === 0 ? (
          <span style={{ color: 'var(--text-2)' }}>
            {placedAps > 0
              ? 'The access point on the canvas has no valid settings: an SSID, and a password that is empty or at least 8 characters.'
              : 'None. Add a "Wi-Fi Access Point" part from Modules, and use its SSID and password in WiFi.begin().'}
          </span>
        ) : (
          aps.map((ap, i) => (
            <span key={ap.id} style={{ marginRight: 12 }}>
              “{ap.ssid}” {ap.password ? '(WPA2)' : '(open)'} · 192.168.{i + 1}.0/24 · channel {ap.channel}
            </span>
          ))
        )}
      </div>
      <div>
        <strong>Boards on the network</strong>
        {!running ? (
          <div style={{ color: 'var(--text-2)' }}>Run the simulation to see which boards join.</div>
        ) : stations.length === 0 ? (
          <div style={{ color: 'var(--text-2)' }}>
            No board has joined yet. ESP32, ESP32-S3, ESP32-CAM, ESP32-C3, ESP32-C6 and ESP8266 sketches join with WiFi.begin(ssid, password).
          </div>
        ) : (
          <table style={{ borderCollapse: 'collapse', marginTop: 4 }}>
            <thead>
              <tr style={{ textAlign: 'left', color: 'var(--text-2)' }}>
                <th style={{ paddingRight: 16 }}>Board</th>
                <th style={{ paddingRight: 16 }}>Network</th>
                <th style={{ paddingRight: 16 }}>Address</th>
                <th style={{ paddingRight: 16 }}>Hostname</th>
                <th>MAC</th>
              </tr>
            </thead>
            <tbody>
              {stations.map((s) => (
                <tr key={s.mac}>
                  <td style={{ paddingRight: 16 }}>{s.label}</td>
                  <td style={{ paddingRight: 16 }}>{s.ssid}</td>
                  <td style={{ paddingRight: 16 }}>{s.ip ?? 'getting an address…'}</td>
                  <td style={{ paddingRight: 16 }}>{s.hostname ?? '—'}</td>
                  <td style={{ fontFamily: 'monospace' }}>{s.mac}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div>
        <strong>Open a board's web page</strong>
        <div className="serial-input-row" style={{ padding: '4px 0', borderTop: 'none' }}>
          <input
            aria-label="Address of a board's web server"
            placeholder="http://192.168.1.100/"
            value={url}
            disabled={!running}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !busy) void open();
            }}
          />
          <button className="btn sm" disabled={!running || busy || !url} onClick={() => void open()}>
            {busy ? 'Waiting…' : 'Open'}
          </button>
        </div>
        <div style={{ color: 'var(--text-2)', fontSize: 11.5 }}>
          The workbench joins the board's access point as .2. Only boards on the simulated network can be reached; there is no internet behind it.
        </div>
      </div>
      {error && <div style={{ color: '#ff8a80' }}>{error}</div>}
      {result && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minHeight: 0 }}>
          <div>
            <strong>
              {result.status} {result.statusText}
            </strong>{' '}
            <span style={{ color: 'var(--text-2)' }}>
              {contentType || 'no Content-Type'} · {result.body.length} bytes
            </span>
            {isHtml && (
              <label style={{ marginLeft: 12, fontSize: 11.5 }}>
                <input type="checkbox" checked={rendered} onChange={(e) => setRendered(e.target.checked)} /> render HTML
              </label>
            )}
          </div>
          {isHtml && rendered ? (
            <iframe
              title="Page served by the board"
              sandbox=""
              srcDoc={bodyText}
              style={{ width: '100%', minHeight: 220, border: '1px solid var(--border)', background: '#fff' }}
            />
          ) : (
            <pre className="mono-out" style={{ margin: 0, maxHeight: 260 }}>
              {bodyText}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
