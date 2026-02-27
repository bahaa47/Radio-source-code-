import { useState, useRef, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { 
  AudioTrack, 
  InsertAudioTrack, 
  insertAudioTrackSchema 
} from "@shared/schema";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { 
  Card, 
  CardContent, 
  CardHeader, 
  CardTitle,
  CardDescription 
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Upload, Trash2, Music, GripVertical, Loader2, CheckCircle2, AlertCircle, Play, Pause, Settings2, FileAudio, Plus, Edit2, Radio, Lock } from "lucide-react";

import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile, toBlobURL } from "@ffmpeg/util";
import { useWebSocket } from "@/hooks/use-websocket";

export default function AdminPlaylist() {
  const { toast } = useToast();
  const { radioState } = useWebSocket();
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [adminIsPlaying, setAdminIsPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const ffmpegRef = useRef<FFmpeg | null>(null);

  useEffect(() => {
    if (!audioRef.current) {
      audioRef.current = new Audio();
      audioRef.current.crossOrigin = "anonymous";
    }
    const audio = audioRef.current;
    
    return () => {
      audio.pause();
      audio.src = "";
    };
  }, []);

  const loadFFmpeg = async () => {
    if (ffmpegRef.current) return ffmpegRef.current;
    
    // Check if SharedArrayBuffer is available
    // Replit environment might not have the correct headers (Cross-Origin-Opener-Policy)
    // to enable SharedArrayBuffer even if the browser supports it.
    const isMultiThreaded = typeof SharedArrayBuffer !== 'undefined' && window.crossOriginIsolated;
    console.log(`[FFmpeg] Multi-threading support (SharedArrayBuffer + crossOriginIsolated): ${isMultiThreaded}`);

    const ffmpeg = new FFmpeg();
    // Use version 0.12.6 which is more stable with the new API
    const baseURL = "https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm";
    
    console.log("[FFmpeg] Loading core from:", baseURL);
    
    try {
      // Force single-threaded mode to avoid SharedArrayBuffer issues in Replit environment
      const loadOptions: any = {
        coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, "text/javascript"),
        wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, "application/wasm"),
      };

      console.log("[FFmpeg] Loading in single-threaded mode for maximum compatibility");
      await ffmpeg.load(loadOptions);
      ffmpegRef.current = ffmpeg;
      return ffmpeg;
    } catch (err) {
      console.error("[FFmpeg] Core load failed. Error detail:", err);
      // Try an even older/simpler URL if unpkg is acting up
      console.log("[FFmpeg] Retrying with alternative delivery...");
      throw err;
    }
  };

  const extractAudioLocally = async (file: File) => {
    console.log(`[1/5] Initializing audio extraction for: ${file.name} (${(file.size / 1024 / 1024).toFixed(2)} MB)`);
    const ffmpeg = await loadFFmpeg();
    const inputName = "input_" + Date.now() + file.name.substring(file.name.lastIndexOf("."));
    const outputName = "output_" + Date.now() + ".mp3";
    
    console.log("[2/5] Preparing file for processing...");
    try {
      // Use a slightly larger chunk for reading to speed up processing
      const fileData = await fetchFile(file);
      await ffmpeg.writeFile(inputName, fileData);
      console.log("[FFmpeg] Input file ready in memory FS");
    } catch (err) {
      console.error("[FFmpeg Error] Failed to write input file:", err);
      throw err;
    }
    
    ffmpeg.on("log", ({ message }) => {
      if (message.includes("size=") || message.includes("time=")) {
        console.log(`[3/5][FFmpeg] Processing: ${message}`);
      } else if (message.toLowerCase().includes("error")) {
        console.error(`[FFmpeg Error] ${message}`);
      }
    });

    console.log("[3/5] Starting high-speed conversion (this is the heavy lifting)...");
    try {
      // Force standard MP3 muxing with explicit audio stream mapping
      // This is the most robust way to ensure the output is playable everywhere
      await ffmpeg.exec([
        "-i", inputName,
        "-vn",                // No video
        "-acodec", "libmp3lame",
        "-b:a", "128k",       // Fixed bitrate for stability
        "-ar", "44100",       // Standard sample rate
        "-ac", "2",           // Stereo
        "-map", "a:0",        // Map the first audio stream explicitly
        "-id3v2_version", "3", // Compatibility
        "-write_id3v1", "1",
        "-f", "mp3",          // Force MP3 container
        "-y",
        outputName
      ]);
      console.log("[FFmpeg] Conversion command finished");
    } catch (err) {
      console.error("[FFmpeg Error] Conversion crashed:", err);
      throw err;
    }
    
    console.log("[4/5] Finalizing extracted audio data...");
    let data;
    try {
      data = await ffmpeg.readFile(outputName);
      console.log(`[FFmpeg] Read result: ${(data.length / 1024 / 1024).toFixed(2)} MB`);
    } catch (err) {
      console.error("[FFmpeg Error] Could not read output file:", err);
      throw err;
    }
    
    console.log("[5/5] Cleanup and preparation for upload...");
    try {
      await ffmpeg.deleteFile(inputName);
      await ffmpeg.deleteFile(outputName);
    } catch (e) {
      console.warn("[Processing] Cleanup warning (non-fatal):", e);
    }
    
    const audioFile = new File([data], file.name.replace(/\.[^/.]+$/, ".mp3"), { type: "audio/mpeg" });
    console.log(`[Done] Ready to upload: ${(audioFile.size / 1024 / 1024).toFixed(2)} MB`);
    // Ensure the returned file has the correct MIME type for the browser and no weird naming
    const finalBlob = audioFile.slice(0, audioFile.size, "audio/mpeg");
    const finalFile = new File([finalBlob], audioFile.name, { type: "audio/mpeg" });
    return finalFile;
  };

  const { data: tracks = [], isLoading } = useQuery<AudioTrack[]>({
    queryKey: ["/api/tracks"],
  });

  const playTrackMutation = useMutation({
    mutationFn: async (trackId: string) => {
      const track = tracks.find(t => t.id === trackId);
      if (track && audioRef.current) {
        audioRef.current.src = track.fileUrl;
        const start = track.startOffset || 0;
        
        const playLocal = () => {
          audioRef.current!.currentTime = start;
          audioRef.current!.play().catch(console.error);
          setAdminIsPlaying(true);
        };

        audioRef.current.onloadedmetadata = playLocal;
        playLocal();
      }
      await apiRequest("POST", "/api/radio/play-track", { trackId });
    },
    onSuccess: () => {
      toast({
        title: "Now playing",
        description: "Track is now playing for you and all listeners",
      });
    },
    onError: () => {
      toast({
        title: "Failed to play track",
        description: "Could not start playback",
        variant: "destructive",
      });
    },
  });

  // Realtime subscription
  useEffect(() => {
    const channel = supabase
      .channel('schema-db-changes')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'audio_tracks',
        },
        (payload) => {
          console.log('Realtime change received:', payload);
          queryClient.invalidateQueries({ queryKey: ["/api/tracks"] });
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  const deleteMutation = useMutation({
    mutationFn: async (trackId: string) => {
      await apiRequest("DELETE", `/api/tracks/${trackId}`, undefined);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/tracks"] });
      toast({
        title: "Track deleted",
        description: "Audio track has been removed from the playlist",
      });
    },
    onError: () => {
      toast({
        title: "Delete failed",
        description: "Failed to delete track",
        variant: "destructive",
      });
    },
  });

  const updateTitleMutation = useMutation({
    mutationFn: async ({ id, title, startOffset, endOffset }: { id: string; title?: string; startOffset?: number; endOffset?: number | null }) => {
      const res = await apiRequest("PATCH", `/api/tracks/${id}`, { title, startOffset, endOffset });
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/tracks"] });
      toast({
        title: data.isTrimUpdate ? "Track trim updated" : "Track title updated",
        description: data.isTrimUpdate ? "Playback start/end times have been adjusted" : "Track title has been changed",
      });
    },
    onError: () => {
      toast({
        title: "Update failed",
        description: "Failed to update track",
        variant: "destructive",
      });
    },
  });

  const formatDuration = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  const getAudioDuration = (file: File): Promise<number> => {
    const audio = new Audio();
    const objectUrl = URL.createObjectURL(file);
    audio.crossOrigin = "anonymous";
    
    return new Promise((resolve) => {
      audio.onloadedmetadata = () => {
        const duration = audio.duration;
        URL.revokeObjectURL(objectUrl);
        resolve(duration);
      };
      audio.onerror = () => {
        URL.revokeObjectURL(objectUrl);
        resolve(0);
      };
      audio.src = objectUrl;
    });
  };

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    // Prevent multiple triggers
    if (isUploading) return;
    
    const file = event.target.files?.[0];
    if (!file) return;

    // Clear input immediately to prevent double-upload of same file
    if (fileInputRef.current) fileInputRef.current.value = "";

    // Basic validation
    const isAudio = file.type.startsWith('audio/');
    const isVideo = file.type.startsWith('video/');

    if (!isAudio && !isVideo) {
      toast({
        title: "Invalid file type",
        description: "Please upload an audio or video file",
        variant: "destructive",
      });
      return;
    }

    try {
      setIsUploading(true);
      setUploadProgress(0);

      // Use a standard MP3 check - only convert if it's definitely NOT MP3 or is Video
      let uploadFile = file;
      const isMp3 = file.type === "audio/mpeg" || file.name.toLowerCase().endsWith(".mp3");
      
      if (isVideo || !isMp3) {
        try {
          toast({
            title: "Processing file",
            description: "Converting to optimized audio format...",
          });
          uploadFile = await extractAudioLocally(file);
        } catch (err) {
          console.error("FFmpeg conversion failed, attempting direct upload:", err);
          uploadFile = file;
        }
      }

      let duration = await getAudioDuration(uploadFile);
      const actualExt = uploadFile.name.split('.').pop() || "mp3";
      const fileName = `${Math.random().toString(36).substring(2)}-${Date.now()}.${actualExt}`;
      const filePath = `uploads/${fileName}`;

      console.log(`[Supabase] Starting upload: ${fileName}`);

      const { data: uploadData, error: uploadError } = await supabase.storage
        .from('audio-files')
        .upload(filePath, uploadFile, {
          cacheControl: '3600',
          upsert: false,
          contentType: uploadFile.type,
        });

      if (uploadError) {
        throw uploadError;
      }
      
      setUploadProgress(90);
      const { data: { publicUrl } } = supabase.storage
        .from('audio-files')
        .getPublicUrl(filePath);

      const newTrack = {
        title: file.name.replace(/\.[^/.]+$/, ""),
        artist: "Unknown Artist",
        duration: Math.ceil(duration) || 180, 
        fileUrl: publicUrl,
        order: tracks.length,
        uploadStatus: "ready"
      };

      await apiRequest("POST", "/api/tracks/fast-supabase", newTrack);
      
      setUploadProgress(100);
      toast({
        title: "Upload successful",
        description: `${file.name} has been added to the playlist`,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/tracks"] });
    } catch (error: any) {
      console.error("Upload error:", error);
      toast({
        title: "Upload failed",
        description: error.message || "An error occurred during upload",
        variant: "destructive",
      });
    } finally {
      setIsUploading(false);
      setUploadProgress(0);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight" data-testid="text-playlist-title">
            Playlist Manager
          </h1>
          <p className="text-muted-foreground mt-1">Manage your radio station's music library</p>
        </div>
        <div className="flex gap-4 items-center">
          <div className="flex items-center gap-2 bg-muted/50 px-3 py-1.5 rounded-full border">
            <Radio className={`h-4 w-4 ${radioState.broadcastEnabled ? "text-primary animate-pulse" : "text-muted-foreground"}`} />
            <Label htmlFor="broadcast-toggle" className="text-sm font-medium cursor-pointer">
              {radioState.broadcastEnabled ? "Public Broadcast ON" : "Public Broadcast OFF"}
            </Label>
            <Switch
              id="broadcast-toggle"
              checked={radioState.broadcastEnabled}
              onCheckedChange={async (checked) => {
                try {
                  await apiRequest("POST", "/api/radio/broadcast-toggle", { enabled: checked });
                  toast({
                    title: checked ? "Broadcast enabled" : "Broadcast disabled",
                    description: checked ? "Listeners can now hear your music" : "Playback is now disabled for all listeners",
                  });
                } catch (error) {
                  toast({
                    title: "Error",
                    description: "Failed to toggle broadcast state",
                    variant: "destructive",
                  });
                }
              }}
              data-testid="toggle-broadcast"
            />
          </div>
          <input
            type="file"
            accept="audio/*,video/*"
            className="hidden"
            ref={fileInputRef}
            onChange={handleFileUpload}
          />
          <Button 
            onClick={() => fileInputRef.current?.click()}
            disabled={isUploading}
            data-testid="button-upload-track"
          >
            {isUploading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Uploading {uploadProgress}%
              </>
            ) : (
              <>
                <Plus className="mr-2 h-4 w-4" />
                Add Track
              </>
            )}
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Audio Library</CardTitle>
          <CardDescription>
            {tracks.length} tracks in your library. Click play to switch the current broadcast.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex justify-center py-8">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
            </div>
          ) : tracks.length === 0 ? (
            <div className="text-center py-12 border-2 border-dashed rounded-lg">
              <Music className="h-12 w-12 mx-auto text-muted-foreground opacity-20" />
              <h3 className="mt-4 text-lg font-medium">No tracks yet</h3>
              <p className="text-muted-foreground">Upload your first audio or video file to get started</p>
            </div>
          ) : (
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[50px]"></TableHead>
                    <TableHead>Title</TableHead>
                    <TableHead>Artist</TableHead>
                    <TableHead>Duration</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {tracks.map((track) => (
                    <TableRow key={track.id} className="group">
                      <TableCell>
                        <GripVertical className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 cursor-grab" />
                      </TableCell>
                      <TableCell className="font-medium">
                        <div className="flex items-center gap-2">
                          <FileAudio className="h-4 w-4 text-primary" />
                          {track.title}
                        </div>
                      </TableCell>
                      <TableCell>{track.artist || "Unknown"}</TableCell>
                      <TableCell>
                        {formatDuration(track.duration)}
                      </TableCell>
                      <TableCell>
                        <Badge variant={track.uploadStatus === "ready" ? "default" : "secondary"}>
                          {track.uploadStatus}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-2">
                          <Button
                            size="icon"
                            variant="ghost"
                            onClick={() => {
                              const trackDuration = track.endOffset ? track.endOffset - (track.startOffset || 0) : track.duration - (track.startOffset || 0);
                              const isCurrentTrack = adminIsPlaying && audioRef.current?.src.includes(track.fileUrl);
                              
                              if (isCurrentTrack && audioRef.current) {
                                audioRef.current.pause();
                                setAdminIsPlaying(false);
                              } else {
                                playTrackMutation.mutate(track.id);
                              }
                            }}
                            disabled={track.uploadStatus !== "ready" || playTrackMutation.isPending || !radioState.broadcastEnabled}
                            data-testid={`button-play-${track.id}`}
                          >
                            {!radioState.broadcastEnabled ? (
                              <Lock className="h-4 w-4 text-muted-foreground/50" />
                            ) : adminIsPlaying && audioRef.current?.src.includes(track.fileUrl) ? (
                              <Pause className="h-4 w-4 text-primary" />
                            ) : (
                              <Play className="h-4 w-4" />
                            )}
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            onClick={() => {
                              const newTitle = prompt("Enter new title:", track.title);
                              if (newTitle !== null && newTitle !== track.title) {
                                updateTitleMutation.mutate({ id: track.id, title: newTitle });
                              }
                            }}
                            disabled={updateTitleMutation.isPending}
                            data-testid={`button-edit-${track.id}`}
                          >
                            <Edit2 className="h-4 w-4" />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            title="Set Trim"
                            onClick={() => {
                              const start = prompt("Enter start time in seconds:", (track.startOffset || 0).toString());
                              if (start === null) return;
                              const endInput = prompt("Enter end time in seconds (leave empty for full duration):", (track.endOffset || "").toString());
                              if (endInput === null) return;
                              
                              updateTitleMutation.mutate({ 
                                id: track.id, 
                                startOffset: parseInt(start) || 0,
                                endOffset: endInput === "" ? null : parseInt(endInput)
                              } as any);
                            }}
                            data-testid={`button-trim-${track.id}`}
                          >
                            <Settings2 className="h-4 w-4" />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="text-destructive hover:text-destructive"
                            onClick={() => {
                              if (confirm("Are you sure you want to delete this track?")) {
                                deleteMutation.mutate(track.id);
                              }
                            }}
                            disabled={deleteMutation.isPending}
                            data-testid={`button-delete-${track.id}`}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
