import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import type { StreamConfig } from "@shared/schema";
import { AlertCircle, CheckCircle } from "lucide-react";

export default function AdminStreamConfig() {
  const { toast } = useToast();
  const [streamUrl, setStreamUrl] = useState("");
  const [isEnabled, setIsEnabled] = useState(false);

  const { data: config, isLoading } = useQuery<StreamConfig>({
    queryKey: ["/api/stream/config"],
    refetchInterval: 5000,
  });

  useEffect(() => {
    if (config) {
      setStreamUrl(config.streamUrl);
      setIsEnabled(config.isEnabled);
    }
  }, [config]);

  const updateStreamMutation = useMutation({
    mutationFn: async (data: { streamUrl?: string; isEnabled?: boolean }) =>
      apiRequest("POST", "/api/stream/config", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/stream/config"] });
      toast({
        description: "Stream configuration updated successfully",
      });
    },
    onError: () => {
      toast({
        variant: "destructive",
        description: "Failed to update stream configuration",
      });
    },
  });

  const handleSave = () => {
    if (!streamUrl.trim()) {
      toast({
        variant: "destructive",
        description: "Please enter a valid stream URL",
      });
      return;
    }
    
    updateStreamMutation.mutate({
      streamUrl: streamUrl.trim(),
      isEnabled: isEnabled,
    });
  };

  if (isLoading) {
    return <div>Loading...</div>;
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">
          Live Stream Configuration
        </h1>
        <p className="text-secondary mt-2">
          Connect to your Shoutcast or Icecast server to broadcast live audio
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Stream Settings</CardTitle>
          <CardDescription>
            Connect to your Shoutcast or Icecast server to broadcast live audio
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-2">
            <Label htmlFor="stream-url">Stream URL</Label>
            <Input
              id="stream-url"
              data-testid="input-stream-url"
              placeholder="http://server-ip:port/stream"
              value={streamUrl}
              onChange={(e) => setStreamUrl(e.target.value)}
              disabled={updateStreamMutation.isPending || isLoading}
            />
            <p className="text-sm text-secondary">
              Example: http://192.168.1.100:8000/live or http://radio.example.com:8080/stream
            </p>
          </div>

          <div className="flex items-center justify-between p-4 rounded-lg bg-muted">
            <div className="space-y-1">
              <Label htmlFor="enable-stream">Enable Live Stream</Label>
              <p className="text-sm text-secondary">
                Toggle to enable or disable the live stream
              </p>
            </div>
            <Switch
              id="enable-stream"
              data-testid="switch-enable-stream"
              checked={isEnabled}
              onCheckedChange={setIsEnabled}
              disabled={updateStreamMutation.isPending || isLoading}
            />
          </div>

          {config?.isEnabled && config?.streamUrl && (
            <div className="flex items-start gap-3 p-4 rounded-lg bg-green-50 dark:bg-green-950">
              <CheckCircle className="h-5 w-5 text-green-600 dark:text-green-400 mt-0.5 flex-shrink-0" />
              <div>
                <p className="font-medium text-green-900 dark:text-green-100">
                  Stream is Active
                </p>
                <p className="text-sm text-green-800 dark:text-green-200 mt-1">
                  {config.streamUrl}
                </p>
                <p className="text-sm text-green-700 dark:text-green-300 mt-2">
                  Listeners can now tune in to your live stream
                </p>
              </div>
            </div>
          )}

          {(!config?.isEnabled || !config?.streamUrl) && (
            <div className="flex items-start gap-3 p-4 rounded-lg bg-yellow-50 dark:bg-yellow-950">
              <AlertCircle className="h-5 w-5 text-yellow-600 dark:text-yellow-400 mt-0.5 flex-shrink-0" />
              <div>
                <p className="font-medium text-yellow-900 dark:text-yellow-100">
                  Stream Not Configured
                </p>
                <p className="text-sm text-yellow-800 dark:text-yellow-200 mt-1">
                  {!config?.streamUrl
                    ? "Please enter a valid stream URL"
                    : "Stream is disabled. Enable it to allow listeners to tune in"}
                </p>
              </div>
            </div>
          )}

          <Button
            data-testid="button-save-stream"
            onClick={handleSave}
            disabled={
              updateStreamMutation.isPending ||
              isLoading ||
              !streamUrl.trim()
            }
            className="w-full"
          >
            {updateStreamMutation.isPending ? "Saving..." : "Save Configuration"}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Setup Instructions</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <div>
            <h3 className="font-semibold mb-2">1. Set Up Your Server</h3>
            <p className="text-secondary">
              Sign up for a Shoutcast or Icecast radio hosting service, or set up your own server.
              You'll receive:
            </p>
            <ul className="list-disc list-inside text-secondary mt-2 space-y-1">
              <li>Server IP address</li>
              <li>Port number</li>
              <li>Source/Admin password</li>
              <li>Stream URL</li>
            </ul>
          </div>

          <div>
            <h3 className="font-semibold mb-2">2. Configure Winamp</h3>
            <p className="text-secondary">
              On your local computer:
            </p>
            <ul className="list-disc list-inside text-secondary mt-2 space-y-1">
              <li>Install the Shoutcast Source DSP plugin for Winamp</li>
              <li>Go to Preferences → DSP/Effect</li>
              <li>Select the Shoutcast plugin</li>
              <li>Enter your server details (IP, Port, Password)</li>
              <li>Set encoder to MP3 or AAC</li>
            </ul>
          </div>

          <div>
            <h3 className="font-semibold mb-2">3. Start Broadcasting</h3>
            <p className="text-secondary">
              Click "Connect" in the Shoutcast plugin. Audio played in Winamp will now be
              encoded and sent to your server in real-time.
            </p>
          </div>

          <div>
            <h3 className="font-semibold mb-2">4. Configure This Page</h3>
            <p className="text-secondary">
              Paste your stream URL above and enable the stream. Visitors can now listen live!
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
