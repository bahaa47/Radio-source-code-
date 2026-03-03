import { useState, useEffect, useRef, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Card } from "@/components/ui/card";
import { LiveIndicator } from "@/components/live-indicator";
import { ThemeToggle } from "@/components/theme-toggle";
import { ChatWidget } from "@/components/chat-widget";
import { AnimatedBackground } from "@/components/animated-background";
import { FloatingParticles } from "@/components/floating-particles";
import { AudioVisualizer } from "@/components/audio-visualizer";
import { Play, Pause, Volume2, VolumeX, Radio, Users, MessageCircle, Lock } from "lucide-react";
import { Input } from "@/components/ui/input";
import { useWebSocket } from "@/hooks/use-websocket";
import { motion, useReducedMotion } from "framer-motion";
import { cn } from "@/lib/utils";
import type { ChatMessage } from "@shared/schema";

export default function ListenerPage() {
  const { radioState, tracks, isConnected, ws } = useWebSocket();
  const shouldReduceMotion = useReducedMotion();
  const [isPlaying, setIsPlaying] = useState(false);
  const [volume, setVolume] = useState([75]);
  const [isMuted, setIsMuted] = useState(false);
  const [username, setUsername] = useState("");
  const [usernameEntered, setUsernameEntered] = useState(false);
  const [isChatOpen, setIsChatOpen] = useState(false);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [streamConfig, setStreamConfig] = useState({ streamUrl: "", isEnabled: false });
  const [streamConnected, setStreamConnected] = useState(false);
  const [streamError, setStreamError] = useState<string>("");
  const [isStreamLoading, setIsStreamLoading] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const liveStreamRef = useRef<HTMLAudioElement | null>(null);
  const syncIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const bufferTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const micAudioContextRef = useRef<AudioContext | null>(null);
  const micGainNodeRef = useRef<GainNode | null>(null);
  const micNextStartTimeRef = useRef(0);
  const playMicrophoneAudioRef = useRef<((data: ArrayBuffer) => void) | null>(null);
  const lastTrackIdRef = useRef<string | null>(null);
  const currentTrackUrlRef = useRef<string | null>(null);
  const serverPositionRef = useRef<number>(0);
  const isPlayingRef = useRef<boolean>(false);
  const reconnectAttemptsRef = useRef<number>(0);

  const resolveTrackUrl = useCallback((url: string): string => {
    if (url.startsWith("http://") || url.startsWith("https://")) {
      return url;
    }
    return new URL(url, window.location.origin).href;
  }, []);

  const readyTracks = tracks.filter(t => t.uploadStatus === "ready" || !t.uploadStatus);
  const currentTrack = readyTracks.find((t) => t.id === radioState.currentTrackId);

  const initMicAudioContext = useCallback(async () => {
    if (!micAudioContextRef.current) {
      micAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
      micGainNodeRef.current = micAudioContextRef.current.createGain();
      micGainNodeRef.current.connect(micAudioContextRef.current.destination);
      
      const volumeLevel = isMuted ? 0 : volume[0] / 100;
      micGainNodeRef.current.gain.value = volumeLevel;
      
      micNextStartTimeRef.current = 0;
    }
    
    if (micAudioContextRef.current.state === 'suspended') {
      await micAudioContextRef.current.resume();
    }
  }, [isMuted, volume]);

  const playMicrophoneAudio = useCallback((arrayBuffer: ArrayBuffer) => {
    try {
      if (arrayBuffer.byteLength < 8) return;
      
      const dataView = new DataView(arrayBuffer);
      const sampleRate = dataView.getUint32(0, true);
      const pcmByteLength = dataView.getUint32(4, true);
      
      if (arrayBuffer.byteLength < 8 + pcmByteLength || sampleRate < 8000 || sampleRate > 96000) return;
      
      const pcmSlice = arrayBuffer.slice(8, 8 + pcmByteLength);
      const int16Data = new Int16Array(pcmSlice);
      const pcmData = new Float32Array(int16Data.length);
      for (let i = 0; i < int16Data.length; i++) {
        pcmData[i] = int16Data[i] / 0x8000;
      }
      
      if (!micAudioContextRef.current) {
        const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
        micAudioContextRef.current = new AudioContextClass();
        micGainNodeRef.current = micAudioContextRef.current.createGain();
        micGainNodeRef.current.connect(micAudioContextRef.current.destination);
        
        const volumeLevel = isMuted ? 0 : volume[0] / 100;
        micGainNodeRef.current.gain.value = volumeLevel;
        micNextStartTimeRef.current = 0;
      }
      
      const audioContext = micAudioContextRef.current;
      if (audioContext.state === 'suspended') audioContext.resume();
      if (!micGainNodeRef.current) return;

      const audioBuffer = audioContext.createBuffer(1, pcmData.length, sampleRate);
      audioBuffer.getChannelData(0).set(pcmData);
      
      const currentTime = audioContext.currentTime;
      const bufferDuration = pcmData.length / sampleRate;
      
      if (micNextStartTimeRef.current < currentTime - 0.5) {
        micNextStartTimeRef.current = currentTime + 0.02;
      }
      
      const startTime = Math.max(currentTime + 0.005, micNextStartTimeRef.current);
      const source = audioContext.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(micGainNodeRef.current);
      source.start(startTime);
      micNextStartTimeRef.current = startTime + bufferDuration;
    } catch (error) {
      console.error("Microphone audio playback error:", error);
    }
  }, [isMuted, volume]);

  useEffect(() => {
    playMicrophoneAudioRef.current = playMicrophoneAudio;
  }, [playMicrophoneAudio]);

  const handleStreamCanPlay = useCallback(() => {
    setStreamConnected(true);
    setStreamError("");
  }, []);

  const attemptReconnect = useCallback(() => {
    reconnectAttemptsRef.current += 1;
    if (reconnectAttemptsRef.current > 5) {
      setStreamError("Connection failed after multiple attempts.");
      return;
    }
    
    const delay = Math.min(1000 * Math.pow(2, reconnectAttemptsRef.current - 1), 30000);
    setStreamError(`Connection lost. Reconnecting in ${Math.round(delay / 1000)}s...`);
    
    if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
    
    reconnectTimeoutRef.current = setTimeout(() => {
      if (liveStreamRef.current && streamConfig.streamUrl) {
        liveStreamRef.current.src = streamConfig.streamUrl;
        liveStreamRef.current.play().catch(err => {
          console.error("Reconnect attempt failed:", err);
          attemptReconnect();
        });
      }
    }, delay);
  }, [streamConfig.streamUrl]);

  const handleStreamError = useCallback((e: Event) => {
    const mediaError = (e.target as HTMLAudioElement).error;
    console.error("Live stream error:", mediaError);
    setStreamConnected(false);
    setIsStreamLoading(false);
    setStreamError("Stream error. Check broadcaster status.");
    if (mediaError?.code === 2) attemptReconnect();
  }, [attemptReconnect]);
  
  const handleStreamLoadStart = useCallback(() => {
    setIsStreamLoading(true);
    setStreamError("");
    if (bufferTimeoutRef.current) clearTimeout(bufferTimeoutRef.current);
    bufferTimeoutRef.current = setTimeout(() => {
      if (isStreamLoading && !streamConnected) {
        setStreamError("Buffer stuck. Check stream settings.");
      }
    }, 15000);
  }, [isStreamLoading, streamConnected]);

  useEffect(() => {
    if (!audioRef.current) {
      audioRef.current = new Audio();
      audioRef.current.preload = "auto";
      audioRef.current.crossOrigin = "anonymous";
    }

    const audio = audioRef.current;
    const handleAudioError = (e: Event) => {
      const mediaError = (e.target as HTMLAudioElement).error;
      if (audio.src) {
        console.error("Audio element error:", {
          code: mediaError?.code,
          message: mediaError?.message,
          src: audio.src,
        });
      }
    };

    audio.addEventListener("error", handleAudioError);

    if (!liveStreamRef.current) {
      liveStreamRef.current = new Audio();
      liveStreamRef.current.preload = "none";
      liveStreamRef.current.crossOrigin = "anonymous";
    }
    
    const liveStream = liveStreamRef.current;
    liveStream.addEventListener("canplay", handleStreamCanPlay);
    liveStream.addEventListener("error", handleStreamError);
    liveStream.addEventListener("loadstart", handleStreamLoadStart);

    return () => {
      liveStream.removeEventListener("canplay", handleStreamCanPlay);
      liveStream.removeEventListener("error", handleStreamError);
      liveStream.removeEventListener("loadstart", handleStreamLoadStart);
      audio.removeEventListener("error", handleAudioError);
      if (syncIntervalRef.current) clearInterval(syncIntervalRef.current);
      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
      if (bufferTimeoutRef.current) clearTimeout(bufferTimeoutRef.current);
      if (micAudioContextRef.current) micAudioContextRef.current.close();
    };
  }, [handleStreamCanPlay, handleStreamError, handleStreamLoadStart]);

  useEffect(() => {
    if (!ws) return;
    const handleMessage = async (event: MessageEvent) => {
      try {
        let arrayBuffer: ArrayBuffer | null = null;
        if (event.data instanceof Blob) arrayBuffer = await event.data.arrayBuffer();
        else if (event.data instanceof ArrayBuffer) arrayBuffer = event.data;
        
        if (arrayBuffer && arrayBuffer.byteLength >= 8) {
          if (playMicrophoneAudioRef.current) playMicrophoneAudioRef.current(arrayBuffer);
          return;
        }
        
        if (typeof event.data === 'string') {
          const data = JSON.parse(event.data);
          if (data.type === "initial_state" && data.streamConfig) setStreamConfig(data.streamConfig);
          else if (data.type === "stream_config_updated" && data.config) setStreamConfig(data.config);
          else if (data.type === "playback_sync" || data.type === "track_changed") {
            serverPositionRef.current = data.position;
            if (data.type === "track_changed" && audioRef.current) {
              const start = data.startOffset ?? 0;
              audioRef.current.currentTime = data.position + start;
            } else if (data.type === "playback_sync" && audioRef.current) {
              // Only force seek if drift is large to avoid stuttering
              const start = data.startOffset ?? 0;
              const drift = Math.abs(audioRef.current.currentTime - (data.position + start));
              if (drift > 2) {
                audioRef.current.currentTime = data.position + start;
              }
            }
          }
          else if (data.type === "chat_message") {
            const newMessage: ChatMessage = {
              id: Math.random().toString(),
              username: data.username,
              text: data.text,
              timestamp: Date.now(),
            };
            setChatMessages(prev => [...prev.slice(-49), newMessage]);
            setUnreadCount(prev => prev + 1);
          }
        }
      } catch (error) {
        console.error("WebSocket message error:", error);
      }
    };
    ws.addEventListener("message", handleMessage);
    return () => ws.removeEventListener("message", handleMessage);
  }, [ws]);

  useEffect(() => {
    if (!audioRef.current || !currentTrack || !isPlaying || !radioState.broadcastEnabled) {
      if (syncIntervalRef.current) clearInterval(syncIntervalRef.current);
      if (audioRef.current && (!isPlaying || !radioState.broadcastEnabled)) audioRef.current.pause();
      return;
    }

    const audio = audioRef.current;
    const resolvedUrl = resolveTrackUrl(currentTrack.fileUrl);

    if (currentTrackUrlRef.current !== resolvedUrl) {
      currentTrackUrlRef.current = resolvedUrl;
      audio.src = resolvedUrl;
      const start = currentTrack.startOffset || 0;
      // Use the actual current server playback position, starting from the offset
      audio.currentTime = radioState.playbackPosition + start;
      
      const playAudio = () => {
        if (isPlaying) {
          audio.play().catch(error => {
            console.error("Audio playback error:", error);
            setIsPlaying(false);
          });
        }
      };

      // Ensure the src is actually loaded before setting currentTime again
      audio.onloadedmetadata = () => {
        audio.currentTime = radioState.playbackPosition + start;
        playAudio();
      };
      
      // Also try immediately
      playAudio();
    } else if (isPlaying && audio.paused) {
      audio.play().catch(error => {
        console.error("Audio resume error:", error);
        setIsPlaying(false);
      });
    }

    if (syncIntervalRef.current) clearInterval(syncIntervalRef.current);
    syncIntervalRef.current = setInterval(() => {
      if (!audio.paused && currentTrack) {
        const start = currentTrack.startOffset || 0;
        const end = currentTrack.endOffset || currentTrack.duration;
        const serverPosition = serverPositionRef.current;
        
        // Respect end offset
        if (audio.currentTime >= end) {
          audio.pause();
          return;
        }

        const drift = Math.abs((serverPosition + start) - audio.currentTime);
        if (drift > 2.0) audio.currentTime = serverPosition + start;
      }
    }, 1000);

    return () => { if (syncIntervalRef.current) clearInterval(syncIntervalRef.current); };
  }, [isPlaying, currentTrack, radioState.currentTrackId, resolveTrackUrl, radioState.broadcastEnabled]);

  useEffect(() => { serverPositionRef.current = radioState.playbackPosition; }, [radioState.playbackPosition]);
  useEffect(() => { if (!isConnected) setIsPlaying(false); }, [isConnected]);

  useEffect(() => {
    if (!audioRef.current) return;
    const volumeLevel = isMuted ? 0 : volume[0] / 100;
    audioRef.current.volume = volumeLevel;
    if (liveStreamRef.current) liveStreamRef.current.volume = volumeLevel;
    
    // Also try to communicate volume to the iframe if possible
    // Note: Zeno.fm player iframe usually doesn't support external volume control 
    // via postMessage unless they have a specific API, but we'll keep the internal 
    // audio synchronized.
  }, [isMuted, volume]);

  useEffect(() => {
    if (!audioRef.current || !currentTrack) return;
    if (lastTrackIdRef.current !== currentTrack.id) {
      lastTrackIdRef.current = currentTrack.id;
      const resolvedUrl = resolveTrackUrl(currentTrack.fileUrl);
      currentTrackUrlRef.current = resolvedUrl;
      audioRef.current.src = resolvedUrl;
      audioRef.current.currentTime = radioState.playbackPosition;
      if (isPlaying) audioRef.current.play().catch(console.error);
    }
  }, [currentTrack, isPlaying, resolveTrackUrl, radioState.playbackPosition]);

  useEffect(() => {
    if (streamConfig.isEnabled && streamConfig.streamUrl && !isPlaying && liveStreamRef.current && radioState.broadcastEnabled) {
      liveStreamRef.current.src = streamConfig.streamUrl;
      setStreamError("");
      isPlayingRef.current = true;
      liveStreamRef.current.play().catch(err => {
        console.error("Auto-play live stream failed:", err);
        isPlayingRef.current = false;
        if (err instanceof DOMException && err.name === "NotAllowedError") setStreamError("Autoplay blocked.");
        else setStreamError("Connection failed.");
        setIsPlaying(false);
      });
      setIsPlaying(true);
    } else if (!streamConfig.isEnabled && liveStreamRef.current && isPlaying) {
      liveStreamRef.current.pause();
      isPlayingRef.current = false;
      setIsPlaying(false);
    }
  }, [streamConfig.isEnabled, streamConfig.streamUrl, radioState.broadcastEnabled]);

  useEffect(() => {
    if (!micGainNodeRef.current) return;
    micGainNodeRef.current.gain.value = isMuted ? 0 : volume[0] / 100;
  }, [isMuted, volume]);

  const togglePlay = () => {
    if (!radioState.broadcastEnabled) return;
    if (!liveStreamRef.current) return;
    
    if (streamConfig.isEnabled && streamConfig.streamUrl) {
      if (isPlaying) {
        liveStreamRef.current.pause();
        isPlayingRef.current = false;
      } else {
        if (isStreamLoading) return;
        liveStreamRef.current.src = streamConfig.streamUrl;
        isPlayingRef.current = true;
        liveStreamRef.current.play().catch(console.error);
      }
      setIsPlaying(!isPlaying);
      return;
    }

    if (!audioRef.current || !currentTrack) return;
    if (isPlaying) audioRef.current.pause();
    else audioRef.current.play().catch(console.error);
    setIsPlaying(!isPlaying);
  };

  const toggleMute = () => setIsMuted(!isMuted);

  const handleSendChat = (text: string) => {
    if (!ws || !usernameEntered) return;
    ws.send(JSON.stringify({ type: "chat_message", username, text }));
  };

  const handleSetUsername = () => { if (username.trim()) { initMicAudioContext(); setUsernameEntered(true); } };
  const handleChatOpen = () => { setIsChatOpen(true); setUnreadCount(0); };

  return (
    <div className="min-h-screen relative overflow-hidden">
      <AnimatedBackground />
      <FloatingParticles />

      <div className="absolute top-4 right-4 z-50 flex gap-2">
        {!usernameEntered && (
          <div className="flex gap-2">
            <Input
              type="text"
              placeholder="Your name"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSetUsername()}
              className="h-9 bg-card/90 backdrop-blur-md"
            />
            <Button size="sm" onClick={handleSetUsername}>Enter</Button>
          </div>
        )}
        <ThemeToggle />
      </div>

      {usernameEntered && (
        <Button
          variant="outline"
          size="sm"
          className="absolute top-4 left-4 z-50 bg-card/90 backdrop-blur-md"
          onClick={handleChatOpen}
        >
          <MessageCircle className="w-4 h-4 mr-1" />
          {unreadCount > 0 && <span className="ml-1 bg-destructive text-destructive-foreground rounded-full px-2 text-xs">{unreadCount}</span>}
        </Button>
      )}

      <div className="flex flex-col items-center justify-center min-h-screen px-4 py-12 relative z-10">
        <motion.div
          initial={shouldReduceMotion ? { opacity: 1, y: 0 } : { opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: shouldReduceMotion ? 0 : 0.6 }}
          className="w-full max-w-4xl mx-auto space-y-12"
        >
          <div className="text-center space-y-8">
            <motion.div
              className="inline-flex items-center justify-center w-32 h-32 rounded-full mb-4 relative"
              style={{
                background: "linear-gradient(135deg, hsla(195, 100%, 50%, 0.3), hsla(270, 60%, 65%, 0.3))",
                backdropFilter: "blur(20px)",
                boxShadow: "0 0 60px hsla(195, 100%, 50%, 0.3)",
              }}
              animate={shouldReduceMotion ? {} : {
                boxShadow: [
                  "0 0 60px hsla(195, 100%, 50%, 0.3)",
                  "0 0 80px hsla(270, 60%, 65%, 0.4)",
                  "0 0 60px hsla(195, 100%, 50%, 0.3)",
                ],
              }}
              transition={{ duration: 4, repeat: Infinity }}
            >
              <Radio className="w-16 h-16 text-foreground drop-shadow-lg" />
            </motion.div>
            
            <div className="space-y-3">
              <h1 className="text-6xl font-semibold tracking-tight text-white drop-shadow-lg">RADIO DREAM VOICE</h1>
              <p className="text-xl text-white/80">Your 24/7 streaming radio station</p>
            </div>
            <AudioVisualizer isPlaying={isPlaying} shouldReduceMotion={shouldReduceMotion || false} />
          </div>

          <Card className="p-10 space-y-8 relative overflow-hidden border-white/20 bg-card/80 backdrop-blur-xl shadow-2xl">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <LiveIndicator isLive={radioState.isLive} />
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Users className="w-4 h-4" />
                <span>{radioState.listenerCount} listeners</span>
              </div>
            </div>

            <div className="text-center space-y-1">
              <h2 className="text-3xl font-semibold">{currentTrack?.title || "No tracks"}</h2>
              <p className="text-lg text-muted-foreground">{currentTrack?.artist || "Unknown Artist"}</p>
            </div>

            <div className="flex justify-center py-4">
              <div className="flex flex-col items-center gap-4">
                {radioState.isLive && (
                  <motion.div
                    initial={{ opacity: 0, scale: 0.9 }}
                    animate={{ opacity: 1, scale: 1 }}
                    className="text-destructive font-bold text-xl animate-pulse flex items-center gap-2 mb-2"
                  >
                    <span className="relative flex h-3 w-3">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-destructive opacity-75"></span>
                      <span className="relative inline-flex rounded-full h-3 w-3 bg-destructive"></span>
                    </span>
                    WE ARE NOW LIVE
                  </motion.div>
                )}
                <Button
                  size="icon"
                  className={cn(
                    "h-24 w-24 rounded-full shadow-lg transition-all duration-300",
                    radioState.isLive ? "bg-destructive hover:bg-destructive/90 scale-110 shadow-destructive/50" : ""
                  )}
                  onClick={togglePlay}
                  disabled={!radioState.broadcastEnabled}
                  data-testid="button-play-main"
                >
                  {isPlaying && radioState.broadcastEnabled ? (
                    <Pause className="h-10 w-10" />
                  ) : !radioState.broadcastEnabled ? (
                    <Lock className="h-10 w-10 text-muted-foreground" />
                  ) : (
                    <Play className="h-10 w-10 ml-1" />
                  )}
                </Button>
              </div>
            </div>

            <div className="space-y-6">
              <div className="flex justify-center w-full overflow-hidden rounded-lg border border-white/10 bg-black/20 p-2">
                <iframe 
                  src="https://zeno.fm/player/dream-radio-voice" 
                  width="575" 
                  height="250" 
                  frameBorder="0" 
                  scrolling="no"
                  className="max-w-full"
                ></iframe>
              </div>
              <a 
                href="https://zeno.fm/" 
                target="_blank" 
                rel="noopener noreferrer"
                className="block text-center text-sm text-white/40 hover:text-white/60 transition-colors mt-2"
              >
                A Zeno.FM Station
              </a>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">Volume</span>
                  <span className="text-sm text-muted-foreground">{isMuted ? 0 : volume[0]}%</span>
                </div>
                <div className="flex items-center gap-4">
                  <Button variant="ghost" size="icon" onClick={toggleMute}>
                    {isMuted || volume[0] === 0 ? <VolumeX className="h-5 w-5" /> : <Volume2 className="h-5 w-5" />}
                  </Button>
                  <Slider value={volume} onValueChange={setVolume} max={100} step={1} className="flex-1" disabled={isMuted} />
                </div>
              </div>
            </div>
          </Card>
        </motion.div>
      </div>
      {isChatOpen && (
        <ChatWidget 
          isOpen={isChatOpen}
          onClose={() => setIsChatOpen(false)} 
          messages={chatMessages} 
          onSendMessage={handleSendChat} 
        />
      )}
    </div>
  );
}
