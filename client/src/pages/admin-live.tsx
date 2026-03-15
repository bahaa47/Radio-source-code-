import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Label } from "@/components/ui/label";
import { LiveIndicator } from "@/components/live-indicator";
import { Skeleton } from "@/components/ui/skeleton";
import { Mic, Radio, Users, Volume2, AlertCircle, Settings2, Monitor } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useMicrophone } from "@/hooks/use-microphone";
import { useSystemAudio } from "@/hooks/use-system-audio";
import { useAudioDevices } from "@/hooks/use-audio-devices";
import { speak } from "@/lib/text-to-speech";
import { useRef, useEffect, useState } from "react";
import { Link } from "wouter";
import type { RadioState } from "@shared/schema";

export default function AdminLive() {
  const { toast } = useToast();
  const [audioMode, setAudioMode] = useState<"microphone" | "system">("microphone");
  const [showSystemAudioPrompt, setShowSystemAudioPrompt] = useState(false);
  const [systemAudioConfirmed, setSystemAudioConfirmed] = useState(false);
  const { isActive, micLevel, error, currentDeviceId, startMicrophone, stopMicrophone } = useMicrophone();
  const { isActive: systemAudioActive, audioLevel: systemAudioLevel, error: systemAudioError, startSystemAudio, stopSystemAudio } = useSystemAudio();
  const { devices, selectedDeviceId } = useAudioDevices();
  const wsRef = useRef<WebSocket | null>(null);
  
  const selectedDevice = devices.find(d => d.deviceId === selectedDeviceId);
  const activeDevice = currentDeviceId ? devices.find(d => d.deviceId === currentDeviceId) : null;

  const { data: radioState, isLoading } = useQuery<RadioState>({
    queryKey: ["/api/radio/state"],
    refetchInterval: 3000,
  });

  const updateLiveMutation = useMutation({
    mutationFn: async (data: { isLive?: boolean; backgroundVolume?: number }) => {
      return await apiRequest("POST", "/api/radio/live", data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/radio/state"] });
    },
  });

  useEffect(() => {
    return () => {
      stopMicrophone();
      stopSystemAudio();
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [stopMicrophone, stopSystemAudio]);

  const handleGoLive = async () => {
    const newLiveState = !radioState?.isLive;
    
    if (newLiveState) {
      try {
        const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        const ws = new WebSocket(`${wsProtocol}//${window.location.host}/ws`);
        wsRef.current = ws;

        ws.onopen = async () => {
          const sendAudioCallback = (pcmBuffer: ArrayBuffer, sampleRate: number) => {
            if (ws.readyState === WebSocket.OPEN && pcmBuffer.byteLength > 0) {
              try {
                const headerBuffer = new ArrayBuffer(8);
                const headerView = new DataView(headerBuffer);
                headerView.setUint32(0, sampleRate, true);
                headerView.setUint32(4, pcmBuffer.byteLength, true);
                
                const combinedBuffer = new Uint8Array(8 + pcmBuffer.byteLength);
                combinedBuffer.set(new Uint8Array(headerBuffer), 0);
                combinedBuffer.set(new Uint8Array(pcmBuffer), 8);
                
                ws.send(combinedBuffer.buffer);
              } catch (error) {
                console.error("Failed to send audio data:", error);
              }
            }
          };

          if (audioMode === "system") {
            startSystemAudio(sendAudioCallback);
          } else {
            startMicrophone(sendAudioCallback, selectedDeviceId);
          }
        };

        ws.onerror = (error) => {
          console.error("WebSocket error:", error);
          toast({
            title: "Connection Error",
            description: "Lost connection to broadcast server. Please try again.",
            variant: "destructive",
          });
        };

        await new Promise((resolve) => {
          const checkConnection = () => {
            if (ws.readyState === WebSocket.OPEN) {
              resolve(null);
            } else {
              setTimeout(checkConnection, 100);
            }
          };
          checkConnection();
          setTimeout(() => resolve(null), 2000);
        });

        updateLiveMutation.mutate(
          { isLive: newLiveState },
          {
            onSuccess: () => {
              const msg = audioMode === "system" ? "system audio" : "microphone";
              speak(`You're live. Broadcasting ${msg} to all listeners now.`);
              toast({
                title: "You're live!",
                description: `Broadcasting ${msg} to all listeners now.`,
              });
            },
          }
        );
      } catch (err) {
        stopMicrophone();
        stopSystemAudio();
        if (wsRef.current) {
          wsRef.current.close();
          wsRef.current = null;
        }
        const errMsg = audioMode === "system" ? "system audio" : "microphone";
        toast({
          title: `${audioMode === "system" ? "System Audio" : "Microphone"} Error`,
          description: err instanceof Error ? err.message : `Failed to access ${errMsg}`,
          variant: "destructive",
        });
      }
    } else {
      stopMicrophone();
      stopSystemAudio();
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }

      updateLiveMutation.mutate(
        { isLive: newLiveState },
        {
          onSuccess: () => {
            speak("Broadcast ended. Automated playback resumed.");
            toast({
              title: "Broadcast ended",
              description: "Automated playback resumed.",
            });
          },
        }
      );
    }
  };

  const handleVolumeChange = (value: number[]) => {
    updateLiveMutation.mutate({ backgroundVolume: value[0] });
  };

  const handleEmergencyStop = () => {
    stopMicrophone();
    stopSystemAudio();
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }

    updateLiveMutation.mutate(
      { isLive: false },
      {
        onSuccess: () => {
          speak("Emergency stop activated. Live broadcast stopped immediately.");
          toast({
            title: "Emergency stop activated",
            description: "Live broadcast stopped immediately.",
            variant: "destructive",
          });
        },
      }
    );
  };

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Live Controls</h1>
          <p className="text-muted-foreground">Broadcast live to your listeners</p>
        </div>
        <div className="grid gap-6 md:grid-cols-2">
          <Card>
            <CardContent className="pt-6">
              <Skeleton className="h-40 w-full" />
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <Skeleton className="h-40 w-full" />
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  const isLive = radioState?.isLive || false;
  const backgroundVolume = radioState?.backgroundVolume || 30;
  const listenerCount = radioState?.listenerCount || 0;
  const currentAudioError = audioMode === "system" ? systemAudioError : error;
  const currentIsActive = audioMode === "system" ? systemAudioActive : isActive;
  const currentAudioLevel = audioMode === "system" ? systemAudioLevel : micLevel;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight" data-testid="text-live-title">
          Live Controls
        </h1>
        <p className="text-muted-foreground">
          Broadcast live to your listeners
        </p>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Broadcast Status</CardTitle>
            <CardDescription>
              Current live streaming state
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">Status</span>
              <LiveIndicator isLive={isLive} />
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Current Listeners</span>
                <div className="flex items-center gap-2" data-testid="text-live-listener-count">
                  <Users className="w-4 h-4 text-muted-foreground" />
                  <span className="text-sm">{listenerCount}</span>
                </div>
              </div>
            </div>

            <Button
              size="lg"
              variant={isLive ? "destructive" : "default"}
              className="w-full"
              onClick={handleGoLive}
              disabled={updateLiveMutation.isPending}
              data-testid="button-go-live"
            >
              {isLive ? (
                <>
                  <Radio className="w-5 h-5 mr-2" />
                  End Broadcast
                </>
              ) : (
                <>
                  <Mic className="w-5 h-5 mr-2" />
                  Go Live
                </>
              )}
            </Button>

            {isLive && (
              <Button
                size="sm"
                variant="outline"
                className="w-full border-destructive text-destructive hover:bg-destructive hover:text-destructive-foreground"
                onClick={handleEmergencyStop}
                disabled={updateLiveMutation.isPending}
                data-testid="button-emergency-stop"
              >
                <AlertCircle className="w-4 h-4 mr-2" />
                Emergency Stop
              </Button>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Audio Controls</CardTitle>
            <CardDescription>
              Manage broadcast audio levels
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <Label className="text-sm font-medium">Broadcast Mode</Label>
              </div>
              <div className="flex gap-2">
                <Button
                  variant={audioMode === "microphone" ? "default" : "outline"}
                  size="sm"
                  onClick={() => {
                    setAudioMode("microphone");
                    setSystemAudioConfirmed(false);
                  }}
                  className="flex-1"
                  data-testid="button-mode-microphone"
                >
                  <Mic className="w-4 h-4 mr-1" />
                  Microphone
                </Button>
                <Button
                  variant={audioMode === "system" ? "default" : "outline"}
                  size="sm"
                  onClick={() => {
                    setShowSystemAudioPrompt(true);
                  }}
                  className="flex-1"
                  data-testid="button-mode-system"
                >
                  <Monitor className="w-4 h-4 mr-1" />
                  System Audio
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                {audioMode === "system" 
                  ? "Broadcasts all audio from your computer (browser tabs, apps, etc.)" 
                  : "Broadcasts from your microphone or connected mixer"}
              </p>
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <Label className="text-sm font-medium">
                  {audioMode === "system" ? "System Audio Source" : "Audio Device"}
                </Label>
                {audioMode === "microphone" && (
                  <Link href="/admin/audio-sources">
                    <Button variant="ghost" size="sm" data-testid="button-configure-audio">
                      <Settings2 className="w-4 h-4 mr-1" />
                      Configure
                    </Button>
                  </Link>
                )}
              </div>
              <div className="flex items-center gap-3 p-3 rounded-lg border bg-muted/50">
                <div className="p-2 rounded-md bg-primary/10">
                  {audioMode === "system" ? (
                    <Monitor className="w-4 h-4 text-primary" />
                  ) : (
                    <Mic className="w-4 h-4 text-primary" />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate" data-testid="text-selected-device">
                    {audioMode === "system"
                      ? "Computer Audio"
                      : selectedDevice?.label || "Default Audio Input"}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {audioMode === "system"
                      ? currentIsActive ? "Broadcasting system audio" : "Select source when going live"
                      : currentIsActive && activeDevice 
                        ? `Broadcasting from: ${activeDevice.label}` 
                        : "Selected for broadcast"}
                  </p>
                </div>
                {currentIsActive && (
                  <Badge variant="default" className="shrink-0">Active</Badge>
                )}
              </div>
            </div>
            
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <Label htmlFor="audio-level" className="text-sm font-medium">
                  {audioMode === "system" ? "System Audio" : "Input"} Level
                </Label>
                <span className="text-sm text-muted-foreground">{currentIsActive ? `${currentAudioLevel}%` : "Inactive"}</span>
              </div>
              <Progress value={currentIsActive ? currentAudioLevel : 0} className="h-2" id="audio-level" />
              <p className="text-xs text-muted-foreground">
                {currentIsActive ? "Audio is being captured" : "Start broadcast to see audio levels"}
              </p>
              {currentAudioError && (
                <p className="text-xs text-destructive">{currentAudioError}</p>
              )}
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <Label htmlFor="background-volume" className="text-sm font-medium">
                  Background Music Volume
                </Label>
                <span className="text-sm text-muted-foreground">{backgroundVolume}%</span>
              </div>
              <div className="flex items-center gap-4">
                <Volume2 className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                <Slider
                  id="background-volume"
                  value={[backgroundVolume]}
                  onValueChange={handleVolumeChange}
                  max={100}
                  step={1}
                  className="flex-1"
                  disabled={!isLive || updateLiveMutation.isPending}
                  data-testid="slider-background-volume"
                />
              </div>
              <p className="text-xs text-muted-foreground">
                {isLive
                  ? "Adjust how loud the background music plays during your broadcast"
                  : "Only adjustable during live broadcast"}
              </p>
            </div>
          </CardContent>
        </Card>
      </div>

      <Alert>
        <AlertCircle className="h-4 w-4" />
        <AlertDescription>
          When you go live, all listeners will hear audio from your selected source. Configure
          your mixer or audio device in the <Link href="/admin/audio-sources" className="font-medium underline underline-offset-4" data-testid="link-audio-sources-inline">Audio Sources</Link> settings.
        </AlertDescription>
      </Alert>

      <AlertDialog open={showSystemAudioPrompt} onOpenChange={setShowSystemAudioPrompt} data-testid="dialog-system-audio-confirm">
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Enable System Audio Capture?</AlertDialogTitle>
            <AlertDialogDescription>
              When you go live with system audio, all audio playing on your computer will be broadcast to listeners—this includes audio from web browsers, applications, music, videos, and any other sound source on your laptop.
              
              This is ideal when your phone connects to your laptop to broadcast all content seamlessly.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogAction
            onClick={() => {
              setAudioMode("system");
              setSystemAudioConfirmed(true);
              setShowSystemAudioPrompt(false);
              toast({
                title: "System Audio Enabled",
                description: "All laptop audio will be captured when you go live.",
              });
            }}
            data-testid="button-confirm-system-audio"
          >
            Broadcast All Laptop Audio
          </AlertDialogAction>
          <AlertDialogCancel data-testid="button-cancel-system-audio">
            Stay with Microphone
          </AlertDialogCancel>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
