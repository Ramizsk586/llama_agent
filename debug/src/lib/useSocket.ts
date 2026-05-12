import { useEffect, useRef, useState } from "react";

export interface SocketEvent {
  event: string;
  data: unknown;
  at: number;
}

declare const __BOOP_SERVER_PORT__: string;

export function useSocket(onEvent?: (e: SocketEvent) => void) {
  const [connected, setConnected] = useState(false);
  const handlerRef = useRef(onEvent);
  handlerRef.current = onEvent;

  useEffect(() => {
    let cancelled = false;
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    function connect() {
      if (cancelled) return;
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      const serverPort = __BOOP_SERVER_PORT__;
      const host = serverPort && location.port === "5173"
        ? `${location.hostname}:${serverPort}`
        : location.host;
      const url = `${proto}//${host}/ws`;
      ws = new WebSocket(url);
      ws.onopen = () => setConnected(true);
      ws.onclose = () => {
        setConnected(false);
        reconnectTimer = setTimeout(connect, 1500);
      };
      ws.onerror = () => ws?.close();
      ws.onmessage = (evt) => {
        try {
          const parsed = JSON.parse(evt.data) as SocketEvent;
          handlerRef.current?.(parsed);
        } catch {
          /* ignore */
        }
      };
    }

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ws?.close();
    };
  }, []);

  return { connected };
}
