import { useState, useRef, useEffect, useCallback } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Switch } from "@/components/ui/switch";
import { 
  Mic, 
  RefreshCw, 
  Play, 
  Square, 
  Check, 
  AlertCircle, 
  Headphones,
  Settings2,
  Cable,
  Smartphone,
  Zap
} from "lucide-react";
import { useAudioDevices, type AudioDevice } from "@/hooks/use-audio-devices";
import { useToast } from "@/hooks/use-toast";

export default function AdminAudioSources() {
  const { toast } = useToast();
  const {
    devices,
    selectedDeviceId,
    selectedDevice,
    isLoading,
    error,
    hasPermission,
    autoSwitch,
    hasExternalDevice,
    selectDevice,
    toggleAutoSwitch,
    refreshDevices,
    requestPermission,
  } = useAudioDevices();

  const [isTesting, setIsTesting] = useState(false);
  const [testLevel, setTestLevel] = useState(0);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animationFrameRef = useRef<number | null>(null);

  const updateLevel = useCallback(() => {
    if (!analyserRef.current) return;

    const dataArray = new Uint8Array(analyserRef.current.frequencyBinCount);
    analyserRef.current.getByteFrequencyData(dataArray);

    const average = dataArray.reduce((a, b) => a + b) / dataArray.length;
    setTestLevel(Math.min(100, Math.round((average / 255) * 100)));

    animationFrameRef.current = requestAnimationFrame(updateLevel);
  }, []);

  const cleanupAudio = useCallback(() => {
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }

    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }

    if (analyserRef.current) {
      try {
        analyserRef.current.disconnect();
      } catch (e) {
      }
      analyserRef.current = null;
    }

    if (audioContextRef.current) {
      try {
        if (audioContextRef.current.state !== 'closed') {
          audioContextRef.current.close();
        }
      } catch (e) {
      }
      audioContextRef.current = null;
    }

    setIsTesting(false);
    setTestLevel(0);
  }, []);

  const startTest = async () => {
    if (!selectedDeviceId) {
      toast({
        title: "No device selected",
        description: "Please select an audio device first",
        variant: "destructive",
      });
      return;
    }

    if (isTesting) {
      toast({
        title: "Test in progress",
        description: "Audio test is already running. Stop it first before starting a new test.",
        variant: "destructive",
      });
      return;
    }

    cleanupAudio();

    try {
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioContextClass) {
        toast({
          title: "Audio not supported",
          description: "Your browser doesn't support audio analysis. Try using Chrome or Safari.",
          variant: "destructive",
        });
        return;
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: { exact: selectedDeviceId },
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      streamRef.current = stream;

      const audioContext = new AudioContextClass();
      audioContextRef.current = audioContext;

      if (audioContext.state === 'suspended') {
        await audioContext.resume();
      }

      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);
      analyserRef.current = analyser;

      setIsTesting(true);
      updateLevel();

      toast({
        title: "Testing audio",
        description: "Speak or play audio through your mixer to see the levels",
      });
    } catch (err) {
      cleanupAudio();
      
      const errorMessage = err instanceof Error ? err.message : "Unknown error";
      let description = "Unable to access the selected audio device";
      
      if (errorMessage.includes("NotAllowedError") || errorMessage.includes("Permission")) {
        description = "Microphone permission was denied. Please allow access and try again.";
      } else if (errorMessage.includes("NotFoundError") || errorMessage.includes("not found")) {
        description = "The selected device was not found. It may have been disconnected.";
      } else if (errorMessage.includes("NotReadableError") || errorMessage.includes("in use")) {
        description = "The device is being used by another application. Please close other apps using the microphone.";
      }
      
      toast({
        title: "Failed to access device",
        description,
        variant: "destructive",
      });
    }
  };

  const stopTest = cleanupAudio;

  useEffect(() => {
    return () => {
      cleanupAudio();
    };
  }, [cleanupAudio]);

  const handleSelectDevice = (device: AudioDevice) => {
    if (isTesting) {
      stopTest();
    }
    if (device?.deviceId) {
      selectDevice(device.deviceId);
      toast({
        title: "Device selected",
        description: `${device.label} will be used for broadcasting`,
      });
    }
  };

  const getDeviceIcon = (device: AudioDevice) => {
    if (device.isExternal) {
      const label = device.label.toLowerCase();
      if (label.includes("mixer") || label.includes("interface") || label.includes("line")) {
        return <Settings2 className="w-5 h-5" />;
      }
      if (label.includes("headset") || label.includes("headphone")) {
        return <Headphones className="w-5 h-5" />;
      }
      return <Cable className="w-5 h-5" />;
    }
    return <Smartphone className="w-5 h-5" />;
  };

  const getDeviceType = (device: AudioDevice): string => {
    const label = device.label.toLowerCase();
    if (label.includes("mixer") || label.includes("interface")) {
      return "Mixer/Interface";
    }
    if (label.includes("line")) {
      return "Line Input";
    }
    if (label.includes("headset")) {
      return "Headset";
    }
    if (label.includes("usb")) {
      return "USB Audio";
    }
    if (label.includes("bluetooth")) {
      return "Bluetooth";
    }
    if (label.includes("webcam") || label.includes("camera")) {
      return "Camera Mic";
    }
    if (device.isExternal) {
      return "External Input";
    }
    return "Built-in Mic";
  };

  const handleAutoSwitchToggle = (enabled: boolean) => {
    toggleAutoSwitch(enabled);
    toast({
      title: enabled ? "Auto-switch enabled" : "Auto-switch disabled",
      description: enabled 
        ? "Audio will switch automatically when external devices are connected" 
        : "You'll need to manually select audio sources",
    });
  };

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Audio Sources</h1>
          <p className="text-muted-foreground mt-1">Connect your mixer or audio device</p>
        </div>
        <div className="grid gap-4">
          {[1, 2, 3].map((i) => (
            <Card key={i}>
              <CardContent className="pt-6">
                <Skeleton className="h-16 w-full" />
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight" data-testid="text-audio-sources-title">
            Audio Sources
          </h1>
          <p className="text-muted-foreground mt-1 text-sm sm:text-base">
            Connect your mixer or audio device
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={refreshDevices}
          disabled={isLoading}
          className="self-start"
          data-testid="button-refresh-devices"
        >
          <RefreshCw className="w-4 h-4 mr-2" />
          Refresh
        </Button>
      </div>

      {!hasPermission && (
        <Alert>
          <AlertCircle className="h-4 w-4 flex-shrink-0" />
          <AlertDescription className="flex flex-col sm:flex-row sm:items-center gap-2 sm:justify-between">
            <span className="text-sm">Permission required to access audio devices</span>
            <Button
              size="sm"
              onClick={requestPermission}
              className="self-start sm:self-auto"
              data-testid="button-request-permission"
            >
              Grant Permission
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="grid gap-4">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-lg sm:text-xl">
              <Zap className="w-5 h-5 flex-shrink-0" />
              Smart Audio Switching
            </CardTitle>
            <CardDescription className="text-sm">
              Automatically switch between your phone's microphone and external audio sources
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-start sm:items-center justify-between gap-3">
              <div className="space-y-1 flex-1 min-w-0">
                <Label className="text-sm font-medium">Auto-switch audio source</Label>
                <p className="text-xs sm:text-sm text-muted-foreground">
                  When enabled, automatically uses external devices (mixer, USB audio) when connected. 
                  Falls back to built-in mic when disconnected.
                </p>
              </div>
              <Switch
                checked={autoSwitch}
                onCheckedChange={handleAutoSwitchToggle}
                className="flex-shrink-0"
                data-testid="switch-auto-audio"
              />
            </div>
            
            <div className={`flex items-center gap-3 p-3 rounded-lg ${
              hasExternalDevice 
                ? "bg-primary/10 text-primary" 
                : "bg-muted text-muted-foreground"
            }`}>
              {hasExternalDevice ? (
                <>
                  <Cable className="w-5 h-5 flex-shrink-0" />
                  <div className="min-w-0">
                    <p className="text-sm font-medium">External device connected</p>
                    <p className="text-xs opacity-80">
                      {autoSwitch ? "Using external audio source" : "Manual selection active"}
                    </p>
                  </div>
                </>
              ) : (
                <>
                  <Smartphone className="w-5 h-5 flex-shrink-0" />
                  <div className="min-w-0">
                    <p className="text-sm font-medium">No external device detected</p>
                    <p className="text-xs opacity-80">
                      {autoSwitch ? "Using built-in microphone" : "Connect a mixer or audio interface"}
                    </p>
                  </div>
                </>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Available Audio Devices</CardTitle>
            <CardDescription>
              {autoSwitch 
                ? "Devices are selected automatically based on connection status"
                : "Select the audio source you want to use for broadcasting"}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {devices.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                <Mic className="w-12 h-12 mx-auto mb-4 opacity-50" />
                <p>No audio devices found</p>
                <p className="text-sm">Connect a mixer or microphone and click refresh</p>
              </div>
            ) : (
              devices.map((device, index) => (
                <div
                  key={device.deviceId}
                  className={`flex flex-col sm:flex-row sm:items-center sm:justify-between p-3 sm:p-4 rounded-lg border transition-colors cursor-pointer hover-elevate active:scale-[0.98] ${
                    selectedDeviceId === device.deviceId
                      ? "border-primary bg-primary/5"
                      : "border-border"
                  }`}
                  onClick={() => handleSelectDevice(device)}
                  data-testid={`device-item-${index}`}
                >
                  <div className="flex items-center gap-3 sm:gap-4 min-w-0 flex-1">
                    <div className={`p-2 rounded-md flex-shrink-0 ${
                      selectedDeviceId === device.deviceId
                        ? "bg-primary text-primary-foreground"
                        : device.isExternal 
                          ? "bg-accent text-accent-foreground"
                          : "bg-muted text-muted-foreground"
                    }`}>
                      {getDeviceIcon(device)}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="font-medium text-sm sm:text-base truncate max-w-[200px] sm:max-w-none">{device.label}</p>
                        {device.isExternal && (
                          <Badge variant="outline" className="text-xs px-1.5 py-0 flex-shrink-0 hidden sm:inline-flex">
                            External
                          </Badge>
                        )}
                      </div>
                      <p className="text-xs sm:text-sm text-muted-foreground">{getDeviceType(device)}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 sm:gap-3 mt-2 sm:mt-0 ml-11 sm:ml-0">
                    <Badge 
                      variant={selectedDeviceId === device.deviceId ? "default" : "secondary"}
                      className={`text-xs ${device.isExternal && selectedDeviceId !== device.deviceId ? "bg-accent/50" : ""}`}
                    >
                      {device.isExternal ? "External" : "Built-in"}
                    </Badge>
                    {selectedDeviceId === device.deviceId && (
                      <div className="w-5 h-5 sm:w-6 sm:h-6 rounded-full bg-primary flex items-center justify-center flex-shrink-0">
                        <Check className="w-3 h-3 sm:w-4 sm:h-4 text-primary-foreground" />
                      </div>
                    )}
                  </div>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-lg sm:text-xl">Test Audio Input</CardTitle>
            <CardDescription className="text-sm">
              Test your selected device to make sure it's working before going live
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <div className="min-w-0 flex-1">
                <Label className="text-sm font-medium">Selected Device</Label>
                <p className="text-xs sm:text-sm text-muted-foreground truncate">
                  {selectedDeviceId
                    ? devices.find((d) => d.deviceId === selectedDeviceId)?.label || "Unknown device"
                    : "No device selected"}
                </p>
              </div>
              <Button
                variant={isTesting ? "destructive" : "default"}
                onClick={isTesting ? stopTest : startTest}
                disabled={!selectedDeviceId || isLoading}
                className="self-start sm:self-auto flex-shrink-0"
                data-testid="button-test-audio"
              >
                {isTesting ? (
                  <>
                    <Square className="w-4 h-4 mr-2" />
                    Stop Test
                  </>
                ) : (
                  <>
                    <Play className="w-4 h-4 mr-2" />
                    Test Audio
                  </>
                )}
              </Button>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <Label className="text-sm font-medium">Input Level</Label>
                <span className="text-xs sm:text-sm text-muted-foreground">
                  {isTesting ? `${testLevel}%` : "Inactive"}
                </span>
              </div>
              <Progress 
                value={testLevel} 
                className="h-3"
                data-testid="progress-audio-level"
              />
              <p className="text-xs text-muted-foreground">
                {isTesting
                  ? "Speak into your microphone or play audio through your mixer"
                  : "Tap 'Test Audio' to check your input levels"}
              </p>
            </div>
          </CardContent>
        </Card>
      </div>

      <Alert>
        <Mic className="h-4 w-4 flex-shrink-0" />
        <AlertDescription className="text-xs sm:text-sm">
          {autoSwitch ? (
            <>
              <strong>Auto-switch is enabled.</strong> When you connect a mixer or audio interface, 
              it will automatically be used for broadcasting. When disconnected, the app falls back 
              to your device's built-in microphone.
            </>
          ) : (
            <>
              The selected audio source will be used when you go live from the Live Controls page.
              Make sure to test your audio levels before broadcasting.
            </>
          )}
        </AlertDescription>
      </Alert>
    </div>
  );
}
