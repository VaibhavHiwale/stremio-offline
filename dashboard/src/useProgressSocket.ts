import type { DownloadItem } from "@stremio-offline/shared";
import { useEffect, useRef, useState } from "react";

interface SnapshotMessage {
  type: "snapshot";
  items: DownloadItem[];
  timestamp: string;
}

export type ConnectionState = "connecting" | "open" | "closed";

/** Live progress for in-flight downloads via WS /ws/progress (P9) — reconnects with backoff on drop, same "pause, don't fail" spirit as the rest of this app. */
export function useProgressSocket(): { activeItems: DownloadItem[]; connectionState: ConnectionState } {
  const [activeItems, setActiveItems] = useState<DownloadItem[]>([]);
  const [connectionState, setConnectionState] = useState<ConnectionState>("connecting");
  const attemptRef = useRef(0);

  useEffect(() => {
    let socket: WebSocket | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;

    function connect(): void {
      if (cancelled) return;
      setConnectionState("connecting");
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(`${protocol}//${window.location.host}/ws/progress`);

      socket.onopen = () => {
        attemptRef.current = 0;
        setConnectionState("open");
      };
      socket.onmessage = (event) => {
        try {
          const message = JSON.parse(String(event.data)) as SnapshotMessage;
          if (message.type === "snapshot") setActiveItems(message.items);
        } catch {
          // Ignore a malformed frame rather than tearing down the connection over it.
        }
      };
      socket.onclose = () => {
        if (cancelled) return;
        setConnectionState("closed");
        const delay = Math.min(1000 * 2 ** attemptRef.current, 15_000);
        attemptRef.current += 1;
        reconnectTimer = setTimeout(connect, delay);
      };
      socket.onerror = () => socket?.close();
    }

    connect();
    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, []);

  return { activeItems, connectionState };
}
