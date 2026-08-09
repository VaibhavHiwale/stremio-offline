import type { DebridAccount, DebridService, Settings, StorageTarget } from "@stremio-offline/shared";
import { useEffect, useState } from "react";
import { api } from "../api";

const DEBRID_SERVICES: DebridService[] = ["realdebrid", "alldebrid", "premiumize", "debridlink", "torbox"];

function GeneralSettings(): React.JSX.Element {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void api.getSettings().then(setSettings);
  }, []);

  async function save(patch: Partial<Settings>): Promise<void> {
    setSaving(true);
    try {
      setSettings(await api.updateSettings(patch));
    } finally {
      setSaving(false);
    }
  }

  if (!settings) return <p>Loading…</p>;

  return (
    <section className="panel">
      <h2>General</h2>
      <label className="field">
        Default quality
        <select value={settings.defaultQuality} onChange={(e) => void save({ defaultQuality: e.target.value as Settings["defaultQuality"] })}>
          {["480p", "720p", "1080p", "1440p", "4k", "original"].map((q) => (
            <option key={q} value={q}>
              {q}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        Max concurrent downloads
        <input
          type="number"
          min={1}
          value={settings.maxConcurrentDownloads}
          onChange={(e) => void save({ maxConcurrentDownloads: Number(e.target.value) })}
        />
      </label>
      <label className="field">
        Subtitle languages (comma-separated)
        <input
          type="text"
          defaultValue={settings.subtitleLangs.join(", ")}
          onBlur={(e) =>
            void save({
              subtitleLangs: e.target.value
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean),
            })
          }
        />
      </label>
      <label className="field field--inline">
        <input type="checkbox" checked={settings.autoDeleteAfterWatch} onChange={(e) => void save({ autoDeleteAfterWatch: e.target.checked })} />
        Auto-delete after watched (default for new downloads)
      </label>
      {saving && <span className="saving-indicator">Saving…</span>}
    </section>
  );
}

function DebridAccountsPanel(): React.JSX.Element {
  const [accounts, setAccounts] = useState<(DebridAccount & { apiKey: string })[]>([]);
  const [service, setService] = useState<DebridService>("realdebrid");
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function refresh(): Promise<void> {
    setAccounts((await api.listDebridAccounts()).accounts);
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function add(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    try {
      await api.addDebridAccount(service, apiKey);
      setApiKey("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function remove(target: DebridService): Promise<void> {
    await api.removeDebridAccount(target);
    await refresh();
  }

  return (
    <section className="panel">
      <h2>Debrid accounts</h2>
      <p className="panel__hint">Resolved in priority order: Real-Debrid, AllDebrid, Premiumize, DebridLink, TorBox.</p>
      {accounts.length > 0 && (
        <ul className="list">
          {accounts.map((a) => (
            <li key={a.service}>
              <span>{a.service}</span>
              <code>{a.apiKey}</code>
              <button className="button--danger" onClick={() => void remove(a.service)}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={add} className="inline-form">
        <select value={service} onChange={(e) => setService(e.target.value as DebridService)}>
          {DEBRID_SERVICES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <input type="password" placeholder="API key" value={apiKey} onChange={(e) => setApiKey(e.target.value)} required />
        <button type="submit">Add</button>
      </form>
      {error && <p className="error-banner">{error}</p>}
    </section>
  );
}

function StorageTargetsPanel(): React.JSX.Element {
  const [targets, setTargets] = useState<StorageTarget[]>([]);
  const [label, setLabel] = useState("");
  const [path, setPath] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function refresh(): Promise<void> {
    setTargets((await api.getStorageUsage()).targets);
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function add(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    try {
      await api.addStorageTarget(label, path);
      setLabel("");
      setPath("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <section className="panel">
      <h2>Storage targets</h2>
      <ul className="list">
        {targets.map((t) => (
          <li key={t.id}>
            <span>
              {t.label} {t.isDefault ? "(default)" : ""}
            </span>
            <code>{t.path}</code>
            <span>
              {(t.bytesFree / 1e9).toFixed(1)} GB free / {(t.bytesTotal / 1e9).toFixed(1)} GB
            </span>
          </li>
        ))}
      </ul>
      <form onSubmit={add} className="inline-form">
        <input type="text" placeholder="Label" value={label} onChange={(e) => setLabel(e.target.value)} required />
        <input type="text" placeholder="Path on the server" value={path} onChange={(e) => setPath(e.target.value)} required />
        <button type="submit">Add</button>
      </form>
      {error && <p className="error-banner">{error}</p>}
    </section>
  );
}

export function SettingsView(): React.JSX.Element {
  return (
    <div className="settings-view">
      <GeneralSettings />
      <DebridAccountsPanel />
      <StorageTargetsPanel />
    </div>
  );
}
