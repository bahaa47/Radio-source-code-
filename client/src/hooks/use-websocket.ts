import { useEffect, useRef, useState } from "react";
import type { RadioState, AudioTrack } from "@shared/schema";

interface WebSocketMessage {
  type: string;
  state?: RadioState;
  tracks?: AudioTrack[];
  count?: number;
  trackId?: string;
  position?: number;
}

export function useWebSocket() {
  const [radioState, setRadioState] = useState<RadioState>({
    currentTrackId: null,
    playbackPosition: 0,
    isLive: false,
    backgroundVolume: 30,
    listenerCount: 0,
    broadcastEnabled: true,
    syncMethod: "auto",
  });
  const [tracks, setTracks] = useState<AudioTrack[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const [ws, setWs] = useState<WebSocket | null>(null);

  useEffect(() => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;
    setWs(ws);

    ws.onopen = () => {
      setIsConnected(true);
    };

    ws.onmessage = (event) => {
      try {
        const data: WebSocketMessage = JSON.parse(event.data);

        switch (data.type) {
          case "initial_state":
            if (data.state) setRadioState(data.state);
            if (data.tracks) setTracks(data.tracks);
            break;
          case "radio_state_updated":
            if (data.state) setRadioState(data.state);
            break;
          case "playlist_updated":
            if (data.tracks) setTracks(data.tracks);
            break;
          case "listener_count_updated":
            if (data.count !== undefined) {
              setRadioState((prev) => ({ ...prev, listenerCount: data.count! }));
            }
            break;
          case "track_changed":
            if (data.trackId !== undefined && data.position !== undefined) {
              setRadioState((prev) => ({
                ...prev,
                currentTrackId: data.trackId!,
                playbackPosition: data.position!,
              }));
            }
            break;
          case "playback_sync":
            if (data.position !== undefined) {
              setRadioState((prev) => ({
                ...prev,
                playbackPosition: data.position!,
              }));
            }
            break;
        }
      } catch (error) {
        console.error("WebSocket message error:", error);
      }
    };

    ws.onclose = () => {
      setIsConnected(false);
    };

    ws.onerror = (error) => {
      console.error("WebSocket error:", error);
      setIsConnected(false);
    };

    return () => {
      ws.close();
    };
  }, []);

  return { radioState, tracks, isConnected, ws };
}
