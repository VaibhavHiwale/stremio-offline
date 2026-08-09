import { useState } from "react";
import { DownloadList } from "./components/DownloadList";
import { SettingsView } from "./components/SettingsView";

type Tab = "downloads" | "settings";

export default function App(): React.JSX.Element {
  const [tab, setTab] = useState<Tab>("downloads");

  return (
    <div className="app">
      <header className="app-header">
        <h1>Stremio Offline</h1>
        <nav className="tabs">
          <button className={tab === "downloads" ? "tab tab--active" : "tab"} onClick={() => setTab("downloads")}>
            Downloads
          </button>
          <button className={tab === "settings" ? "tab tab--active" : "tab"} onClick={() => setTab("settings")}>
            Settings
          </button>
        </nav>
      </header>
      <main className="app-main">{tab === "downloads" ? <DownloadList /> : <SettingsView />}</main>
    </div>
  );
}
