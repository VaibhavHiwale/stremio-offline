import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Served statically by the service (CLAUDE.md §5) — relative base so the
// built assets work regardless of which base URL the service resolves the
// request under (LAN IP, *.stremio.rocks domain, tunnel hostname, ...).
export default defineConfig({
  plugins: [react()],
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/downloads": "http://127.0.0.1:11470",
      "/debrid-accounts": "http://127.0.0.1:11470",
      "/storage": "http://127.0.0.1:11470",
      "/settings": "http://127.0.0.1:11470",
      "/health": "http://127.0.0.1:11470",
      "/diagnostics": "http://127.0.0.1:11470",
      "/ws": { target: "ws://127.0.0.1:11470", ws: true },
    },
  },
});
