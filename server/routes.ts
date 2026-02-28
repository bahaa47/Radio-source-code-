import type { Express } from "express";
import express from "express";
import { createServer, type Server } from "http";
import { WebSocketServer, WebSocket } from "ws";
import multer from "multer";
import path from "path";
import bcrypt from "bcrypt";
import { parseFile } from "music-metadata";
import { execSync } from "child_process";
import { storage } from "./storage";
import { insertAudioTrackSchema, insertUserSchema } from "@shared/schema";
import type { RadioState } from "@shared/schema";
import { uploadToStorage, deleteFromStorage, downloadFromStorage, getStorageUrl } from "./object-storage";

interface ChunkedUpload {
  id: string;
  filename: string;
  mimeType: string;
  totalChunks: number;
  receivedChunks: Map<number, Buffer>;
  title: string;
  artist: string | null;
  duration: number;
  createdAt: number;
}

const activeUploads = new Map<string, ChunkedUpload>();

setInterval(() => {
  const now = Date.now();
  const timeout = 10 * 60 * 1000;
  Array.from(activeUploads.entries()).forEach(([id, upload]) => {
    if (now - upload.createdAt > timeout) {
      activeUploads.delete(id);
    }
  });
}, 60 * 1000);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 100 * 1024 * 1024,
  },
  fileFilter: (req, file, cb) => {
    const allowedAudioTypes = ["audio/mpeg", "audio/mp3", "audio/wav", "audio/ogg", "audio/aac", "audio/flac"];
    const allowedVideoTypes = ["video/mp4", "video/webm", "video/quicktime", "video/x-msvideo", "video/mpeg"];
    const allowedTypes = [...allowedAudioTypes, ...allowedVideoTypes];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Invalid file type. Audio or video files are allowed."));
    }
  },
});

const connectedClients = new Set<WebSocket>();

function broadcastToClients(data: any) {
  const message = JSON.stringify(data);
  connectedClients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

export async function registerRoutes(app: Express): Promise<Server> {
  app.use("/uploads", express.static(path.join(process.cwd(), "uploads")));

  try {
    const existingAdmin = await storage.getUserByUsername("admin");
    if (!existingAdmin) {
      const hashedPassword = await bcrypt.hash("admin123", 10);
      await storage.createUser({
        username: "admin",
        password: hashedPassword,
      });
      console.log("Default admin user created (username: admin, password: admin123)");
    }
  } catch (dbError: any) {
    console.log("In-memory storage ready. Default admin: admin/admin123");
  }


  app.post("/api/auth/login", async (req, res) => {
    try {
      const { username, password } = req.body;

      const user = await storage.getUserByUsername(username);
      if (!user) {
        return res.status(401).json({ error: "Invalid credentials" });
      }

      const isValid = await bcrypt.compare(password, user.password);
      if (!isValid) {
        return res.status(401).json({ error: "Invalid credentials" });
      }

      if (req.session) {
        req.session.userId = user.id;
      }

      res.json({ success: true, user: { id: user.id, username: user.username } });
    } catch (error) {
      res.status(500).json({ error: "Login failed" });
    }
  });

  app.post("/api/auth/register", async (req, res) => {
    try {
      const validatedData = insertUserSchema.parse(req.body);
      
      const existingUser = await storage.getUserByUsername(validatedData.username);
      if (existingUser) {
        return res.status(400).json({ error: "Username already exists" });
      }

      const hashedPassword = await bcrypt.hash(validatedData.password, 10);
      const user = await storage.createUser({
        username: validatedData.username,
        password: hashedPassword,
      });

      res.json({ success: true, user: { id: user.id, username: user.username } });
    } catch (error) {
      res.status(500).json({ error: "Registration failed" });
    }
  });

  app.post("/api/auth/logout", async (req, res) => {
    if (req.session) {
      req.session.destroy((err) => {
        if (err) {
          return res.status(500).json({ error: "Logout failed" });
        }
        res.json({ success: true });
      });
    } else {
      res.json({ success: true });
    }
  });

  app.post("/api/tracks/fast-supabase", async (req, res) => {
    try {
      const trackData = insertAudioTrackSchema.parse(req.body);
      const track = await storage.createTrack(trackData);

      broadcastToClients({
        type: "playlist_updated",
        tracks: await storage.getAllTracks(),
      });

      res.json(track);
    } catch (error) {
      console.error("Supabase track save error:", error);
      res.status(500).json({ error: "Failed to save track reference" });
    }
  });

  app.get("/api/tracks", async (req, res) => {
    try {
      const tracks = await storage.getAllTracks();
      res.json(tracks);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch tracks" });
    }
  });

  app.post("/api/tracks/fast", upload.single("audio"), async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "No file uploaded" });
      }

      const duration = parseInt(req.body.duration);
      const title = req.body.title || req.file.originalname.replace(/\.[^/.]+$/, "");
      const artist = req.body.artist || null;

      if (!duration || duration <= 0) {
        return res.status(400).json({ error: "Valid duration is required" });
      }

      let fileBuffer = req.file.buffer;
      let ext = path.extname(req.file.originalname);
      const isVideo = req.file.mimetype.startsWith("video/");
      
      const uniqueKey = `audio/${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
      const mimeType = req.file.mimetype;

      const trackData = insertAudioTrackSchema.parse({
        title,
        artist,
        duration: duration || 180,
        fileUrl: getStorageUrl(uniqueKey),
        order: (await storage.getAllTracks()).length,
        uploadStatus: "uploading",
      });

      const track = await storage.createTrack(trackData);

      broadcastToClients({
        type: "playlist_updated",
        tracks: await storage.getAllTracks(),
      });

      res.json(track);

      setImmediate(async () => {
        try {
          let processedBuffer = fileBuffer;
          let processedMimeType = mimeType;
          let processedKey = uniqueKey;

          if (isVideo) {
            try {
              console.log(`Processing video to audio: ${uniqueKey}`);
              const inputPath = path.join(process.cwd(), "uploads", `temp_${Date.now()}${ext}`);
              const outputPath = inputPath.replace(ext, ".mp3");
              
              const fs = await import("fs/promises");
              await fs.writeFile(inputPath, fileBuffer);
              
              execSync(`ffmpeg -i "${inputPath}" -vn -acodec libmp3lame -q:a 4 -y "${outputPath}"`);
              
              processedBuffer = await fs.readFile(outputPath);
              processedMimeType = "audio/mpeg";
              processedKey = uniqueKey.replace(ext, ".mp3");
              
              await fs.unlink(inputPath);
              await fs.unlink(outputPath);
              
              // Update track URL if it changed
              await storage.updateTrack(track.id, { 
                fileUrl: getStorageUrl(processedKey) 
              });
            } catch (ffmpegErr) {
              console.error("Server-side FFmpeg failed:", ffmpegErr);
            }
          }

          const storageUrl = await uploadToStorage(processedKey, processedBuffer, processedMimeType);
          await storage.updateTrack(track.id, { 
            uploadStatus: "ready",
            fileUrl: storageUrl.startsWith("http") ? storageUrl : getStorageUrl(processedKey)
          });
          broadcastToClients({
            type: "track_ready",
            trackId: track.id,
            tracks: await storage.getAllTracks(),
          });
        } catch (uploadError) {
          console.error("Background upload failed:", uploadError);
          await storage.updateTrack(track.id, { uploadStatus: "failed" });
          broadcastToClients({
            type: "track_upload_failed",
            trackId: track.id,
            tracks: await storage.getAllTracks(),
          });
        }
      });
    } catch (error) {
      console.error("Fast upload error:", error);
      res.status(500).json({ error: "Failed to upload track" });
    }
  });

  const chunkUpload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: 2 * 1024 * 1024,
    },
  });

  app.post("/api/tracks/chunk/init", async (req, res) => {
    try {
      const { filename, mimeType, totalChunks, title, artist, duration } = req.body;

      if (!filename || !mimeType || !totalChunks || !duration) {
        return res.status(400).json({ error: "Missing required fields" });
      }

      const uploadId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

      const chunkedUpload: ChunkedUpload = {
        id: uploadId,
        filename,
        mimeType,
        totalChunks: parseInt(totalChunks),
        receivedChunks: new Map(),
        title: title || filename.replace(/\.[^/.]+$/, ""),
        artist: artist || null,
        duration: parseInt(duration),
        createdAt: Date.now(),
      };

      activeUploads.set(uploadId, chunkedUpload);

      res.json({ uploadId, message: "Upload initialized" });
    } catch (error) {
      console.error("Chunk init error:", error);
      res.status(500).json({ error: "Failed to initialize upload" });
    }
  });

  app.post("/api/tracks/chunk/:uploadId", chunkUpload.single("chunk"), async (req, res) => {
    try {
      const { uploadId } = req.params;
      const chunkIndex = parseInt(req.body.chunkIndex);

      const upload = activeUploads.get(uploadId);
      if (!upload) {
        return res.status(404).json({ error: "Upload not found or expired" });
      }

      if (!req.file) {
        return res.status(400).json({ error: "No chunk data" });
      }

      if (isNaN(chunkIndex) || chunkIndex < 0 || chunkIndex >= upload.totalChunks) {
        return res.status(400).json({ error: `Invalid chunk index: ${chunkIndex}` });
      }

      if (upload.receivedChunks.has(chunkIndex)) {
        return res.status(400).json({ error: `Duplicate chunk index: ${chunkIndex}` });
      }

      upload.receivedChunks.set(chunkIndex, req.file.buffer);
      upload.createdAt = Date.now();

      const receivedCount = upload.receivedChunks.size;
      const progress = Math.round((receivedCount / upload.totalChunks) * 100);

      res.json({
        received: receivedCount,
        total: upload.totalChunks,
        progress,
      });
    } catch (error) {
      console.error("Chunk upload error:", error);
      res.status(500).json({ error: "Failed to upload chunk" });
    }
  });

  app.post("/api/tracks/chunk/:uploadId/complete", async (req, res) => {
    try {
      const { uploadId } = req.params;

      const chunkedUpload = activeUploads.get(uploadId);
      if (!chunkedUpload) {
        return res.status(404).json({ error: "Upload not found or expired" });
      }

      if (chunkedUpload.receivedChunks.size !== chunkedUpload.totalChunks) {
        return res.status(400).json({
          error: `Missing chunks: received ${chunkedUpload.receivedChunks.size}/${chunkedUpload.totalChunks}`,
        });
      }

      const sortedChunks: Buffer[] = [];
      for (let i = 0; i < chunkedUpload.totalChunks; i++) {
        const chunk = chunkedUpload.receivedChunks.get(i);
        if (!chunk) {
          return res.status(400).json({ error: `Missing chunk ${i}` });
        }
        sortedChunks.push(chunk);
      }
      let fileBuffer = Buffer.concat(sortedChunks);

      activeUploads.delete(uploadId);

      let ext = path.extname(chunkedUpload.filename);
      let finalMimeType = chunkedUpload.mimeType;
      let finalDuration = chunkedUpload.duration;
      
      const uniqueKey = `audio/${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;

      const trackData = insertAudioTrackSchema.parse({
        title: chunkedUpload.title,
        artist: chunkedUpload.artist,
        duration: finalDuration,
        fileUrl: getStorageUrl(uniqueKey),
        order: (await storage.getAllTracks()).length,
        uploadStatus: "uploading",
      });

      const track = await storage.createTrack(trackData);

      broadcastToClients({
        type: "playlist_updated",
        tracks: await storage.getAllTracks(),
      });

      res.json(track);

      setImmediate(async () => {
        try {
          await uploadToStorage(uniqueKey, fileBuffer, finalMimeType);
          await storage.updateTrack(track.id, { uploadStatus: "ready" });
          broadcastToClients({
            type: "track_ready",
            trackId: track.id,
            tracks: await storage.getAllTracks(),
          });
        } catch (uploadError) {
          console.error("Background upload failed:", uploadError);
          await storage.updateTrack(track.id, { uploadStatus: "failed" });
          broadcastToClients({
            type: "track_upload_failed",
            trackId: track.id,
            tracks: await storage.getAllTracks(),
          });
        }
      });
    } catch (error) {
      console.error("Chunk complete error:", error);
      res.status(500).json({ error: "Failed to complete upload" });
    }
  });

  app.get("/api/audio/:key(*)", async (req, res) => {
    try {
      const key = decodeURIComponent(req.params.key);
      const buffer = await downloadFromStorage(key);
      
      if (!buffer) {
        return res.status(404).json({ error: "Audio file not found" });
      }

      const ext = path.extname(key).toLowerCase();
      const mimeTypes: Record<string, string> = {
        ".mp3": "audio/mpeg",
        ".wav": "audio/wav",
        ".ogg": "audio/ogg",
        ".aac": "audio/aac",
        ".flac": "audio/flac",
        ".mp4": "video/mp4",
        ".webm": "video/webm",
        ".mov": "video/quicktime",
        ".avi": "video/x-msvideo",
      };

      res.setHeader("Content-Type", mimeTypes[ext] || "audio/mpeg");
      res.setHeader("Content-Length", buffer.length);
      res.setHeader("Accept-Ranges", "bytes");
      res.send(buffer);
    } catch (error) {
      console.error("Audio serve error:", error);
      res.status(500).json({ error: "Failed to serve audio" });
    }
  });

  app.post("/api/tracks", upload.single("audio"), async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "No file uploaded" });
      }

      let audioBuffer = req.file.buffer;
      let isVideo = req.file.mimetype.startsWith("video/");
      let ext = path.extname(req.file.originalname);

      let duration = parseInt(req.body.duration) || 0;
      let title = req.body.title || req.file.originalname.replace(/\.[^/.]+$/, "");
      let artist = req.body.artist || null;

      const uniqueKey = `audio/${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
      await uploadToStorage(uniqueKey, audioBuffer, req.file.mimetype);

      const trackData = insertAudioTrackSchema.parse({
        title,
        artist,
        duration: duration || 180, // Fallback if no duration provided
        fileUrl: getStorageUrl(uniqueKey),
        order: (await storage.getAllTracks()).length,
      });

      const track = await storage.createTrack(trackData);

      broadcastToClients({
        type: "playlist_updated",
        tracks: await storage.getAllTracks(),
      });

      res.json(track);
    } catch (error) {
      console.error("Upload error:", error);
      res.status(500).json({ error: "Failed to upload track" });
    }
  });

  app.patch("/api/tracks/:id", async (req, res) => {
    try {
      const { title, startOffset, endOffset } = req.body;
      
      const updates: any = {};
      if (title !== undefined) updates.title = title;
      if (startOffset !== undefined) updates.startOffset = Number(startOffset);
      if (endOffset !== undefined) updates.endOffset = endOffset === "" || endOffset === null ? null : Number(endOffset);

      const track = await storage.updateTrack(req.params.id, updates);
      if (!track) {
        return res.status(404).json({ error: "Track not found" });
      }

      const isTrimUpdate = startOffset !== undefined || endOffset !== undefined;

      broadcastToClients({
        type: "playlist_updated",
        tracks: await storage.getAllTracks(),
      });

      res.json({ ...track, isTrimUpdate });
    } catch (error) {
      res.status(500).json({ error: "Failed to update track" });
    }
  });

  app.delete("/api/tracks/:id", async (req, res) => {
    try {
      const track = await storage.getTrack(req.params.id);
      if (track) {
        if (track.fileUrl.startsWith("/api/audio/")) {
          const key = decodeURIComponent(track.fileUrl.replace("/api/audio/", ""));
          await deleteFromStorage(key);
        } else if (track.fileUrl.startsWith("/uploads/")) {
          const fs = await import("fs/promises");
          const fileName = track.fileUrl.replace("/uploads/", "");
          const filePath = path.join(process.cwd(), "uploads", fileName);
          try {
            await fs.unlink(filePath);
          } catch (fileError) {
            console.error("Failed to delete file:", fileError);
          }
        }
      }
      
      await storage.deleteTrack(req.params.id);
      
      broadcastToClients({
        type: "playlist_updated",
        tracks: await storage.getAllTracks(),
      });

      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Failed to delete track" });
    }
  });

  app.get("/api/radio/state", async (req, res) => {
    try {
      const state = await storage.getRadioState();
      res.json(state);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch radio state" });
    }
  });

  app.get("/api/analytics", async (req, res) => {
    try {
      const analytics = await storage.getListenerAnalytics(60);
      res.json(analytics);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch analytics" });
    }
  });

  app.post("/api/radio/broadcast-toggle", async (req, res) => {
    try {
      const { enabled } = req.body;
      if (typeof enabled !== "boolean") {
        return res.status(400).json({ error: "Invalid enabled state" });
      }

      await storage.updateRadioState({ broadcastEnabled: enabled });
      const updatedState = await storage.getRadioState();

      broadcastToClients({
        type: "radio_state_updated",
        state: updatedState,
      });

      res.json(updatedState);
    } catch (error) {
      res.status(500).json({ error: "Failed to toggle broadcast" });
    }
  });

  app.post("/api/radio/live", async (req, res) => {
    try {
      const { isLive, backgroundVolume } = req.body;
      const currentState = await storage.getRadioState();

      await storage.updateRadioState({
        isLive: isLive !== undefined ? isLive : currentState.isLive,
        backgroundVolume: backgroundVolume !== undefined ? backgroundVolume : currentState.backgroundVolume,
      });

      const updatedState = await storage.getRadioState();

      broadcastToClients({
        type: "radio_state_updated",
        state: updatedState,
      });

      res.json(updatedState);
    } catch (error) {
      res.status(500).json({ error: "Failed to update live state" });
    }
  });

  app.post("/api/radio/play-track", async (req, res) => {
    try {
      const { trackId } = req.body;

      if (!trackId) {
        return res.status(400).json({ error: "Track ID is required" });
      }

      const track = await storage.getTrack(trackId);
      if (!track) {
        return res.status(404).json({ error: "Track not found" });
      }

      if (track.uploadStatus === "uploading") {
        return res.status(400).json({ error: "Track is still processing" });
      }

      await storage.updateRadioState({
        currentTrackId: trackId,
        playbackPosition: 0,
      });

      broadcastToClients({
        type: "track_changed",
        trackId: trackId,
        position: 0,
        startOffset: track.startOffset || 0,
        endOffset: track.endOffset || null,
      });

      res.json({ success: true, trackId });
    } catch (error) {
      res.status(500).json({ error: "Failed to change track" });
    }
  });

  app.get("/api/stream/config", async (req, res) => {
    try {
      const config = await storage.getStreamConfig();
      res.json(config);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch stream config" });
    }
  });

  app.post("/api/stream/config", async (req, res) => {
    try {
      const { streamUrl, isEnabled } = req.body;
      const currentConfig = await storage.getStreamConfig();

      if (streamUrl && !isValidUrl(streamUrl)) {
        return res.status(400).json({ error: "Invalid stream URL" });
      }

      await storage.updateStreamConfig({
        streamUrl: streamUrl !== undefined ? streamUrl : currentConfig.streamUrl,
        isEnabled: isEnabled !== undefined ? isEnabled : currentConfig.isEnabled,
      });

      const config = await storage.getStreamConfig();

      broadcastToClients({
        type: "stream_config_updated",
        config: config,
      });

      res.json(config);
    } catch (error) {
      res.status(500).json({ error: "Failed to update stream config" });
    }
  });

  function isValidUrl(string: string): boolean {
    try {
      new URL(string);
      return true;
    } catch (_) {
      return false;
    }
  }

  const httpServer = createServer(app);

  const wss = new WebSocketServer({ 
    noServer: true
  });

  // Handle WebSocket upgrade at HTTP server level
  httpServer.on('upgrade', (request, socket, head) => {
    try {
      const url = new URL(request.url || '', `http://${request.headers.host || 'localhost'}`);
      if (url.pathname === '/ws') {
        wss.handleUpgrade(request, socket, head, (ws) => {
          wss.emit('connection', ws, request);
        });
      } else {
        socket.destroy();
      }
    } catch (e) {
      socket.destroy();
    }
  });

  wss.on("connection", async (ws) => {
    connectedClients.add(ws);
    
    const currentState = await storage.getRadioState();
    currentState.listenerCount = connectedClients.size;
    await storage.updateRadioState({ listenerCount: connectedClients.size });
    await storage.recordListenerAnalytics(connectedClients.size);

    const tracks = await storage.getAllTracks();
    const streamConfig = await storage.getStreamConfig();
    ws.send(JSON.stringify({
      type: "initial_state",
      state: currentState,
      tracks: tracks,
      streamConfig: streamConfig,
    }));

    broadcastToClients({
      type: "listener_count_updated",
      count: connectedClients.size,
    });

    ws.on("message", async (message, isBinary) => {
      try {
        if (isBinary) {
          connectedClients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN && client !== ws) {
              client.send(message, { binary: true });
            }
          });
          return;
        }
        
        const messageStr = message.toString();
        const data = JSON.parse(messageStr);
        
        if (data.type === "playback_position") {
          await storage.updateRadioState({
            playbackPosition: data.position,
            currentTrackId: data.trackId,
          });
        } else if (data.type === "chat_message") {
          const chatMessage = {
            id: Math.random().toString(),
            username: data.username || "Anonymous",
            text: data.text,
            timestamp: Date.now(),
          };
          await storage.addChatMessage(chatMessage);
          broadcastToClients({
            type: "chat_message",
            username: chatMessage.username,
            text: chatMessage.text,
          });
        }
      } catch (error) {
        console.error("WebSocket message error:", error);
      }
    });

    ws.on("close", async () => {
      connectedClients.delete(ws);
      const updatedState = await storage.getRadioState();
      updatedState.listenerCount = connectedClients.size;
      await storage.updateRadioState({ listenerCount: connectedClients.size });
      
      broadcastToClients({
        type: "listener_count_updated",
        count: connectedClients.size,
      });
    });
  });

  let playbackInterval: NodeJS.Timeout | null = null;

  async function startPlaybackLoop() {
    if (playbackInterval) return;

    playbackInterval = setInterval(async () => {
      const state = await storage.getRadioState();
      const allTracks = await storage.getAllTracks();
      const tracks = allTracks.filter(t => t.uploadStatus === "ready" || !t.uploadStatus);

      await storage.recordListenerAnalytics(connectedClients.size);

      if (tracks.length === 0 || state.isLive) return;

      if (state.currentTrackId === null) {
        await storage.updateRadioState({
          currentTrackId: tracks[0].id,
          playbackPosition: 0,
        });
        
        broadcastToClients({
          type: "track_changed",
          trackId: tracks[0].id,
          position: 0,
          startOffset: tracks[0].startOffset || 0,
          endOffset: tracks[0].endOffset || null,
        });
        return;
      }

      const currentTrackIndex = tracks.findIndex(t => t.id === state.currentTrackId);
      if (currentTrackIndex === -1) {
        if (tracks.length > 0) {
          await storage.updateRadioState({
            currentTrackId: tracks[0].id,
            playbackPosition: 0,
          });
          broadcastToClients({
            type: "track_changed",
            trackId: tracks[0].id,
            position: 0,
            startOffset: tracks[0].startOffset || 0,
            endOffset: tracks[0].endOffset || null,
          });
        }
        return;
      }

      const currentTrack = tracks[currentTrackIndex];
      const start = currentTrack.startOffset || 0;
      const end = currentTrack.endOffset || currentTrack.duration;
      const effectiveDuration = end - start;
      const newPosition = state.playbackPosition + 1;

      if (newPosition >= effectiveDuration) {
        const nextTrackIndex = (currentTrackIndex + 1) % tracks.length;
        const nextTrack = tracks[nextTrackIndex];
        
        await storage.updateRadioState({
          currentTrackId: nextTrack.id,
          playbackPosition: 0,
        });

        broadcastToClients({
          type: "track_changed",
          trackId: nextTrack.id,
          position: 0,
          startOffset: nextTrack.startOffset || 0,
          endOffset: nextTrack.endOffset || null,
        });
      } else {
        await storage.updateRadioState({
          playbackPosition: newPosition,
        });

        broadcastToClients({
          type: "playback_sync",
          trackId: state.currentTrackId,
          position: newPosition,
          startOffset: start,
        });
      }
    }, 1000);
  }

  startPlaybackLoop();

  return httpServer;
}
