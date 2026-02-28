import { sql } from "drizzle-orm";
import { pgTable, text, varchar, integer, boolean, real } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
});

export const audioTracks = pgTable("audio_tracks", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  title: text("title").notNull(),
  artist: text("artist"),
  duration: integer("duration").notNull(),
  startOffset: integer("start_offset").default(0),
  endOffset: integer("end_offset"),
  fileUrl: text("file_url").notNull(),
  order: integer("order").notNull().default(0),
  uploadStatus: text("upload_status").default("ready"),
});

export const insertUserSchema = createInsertSchema(users).pick({
  username: true,
  password: true,
});

export const insertAudioTrackSchema = createInsertSchema(audioTracks).omit({
  id: true,
});

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;
export type AudioTrack = typeof audioTracks.$inferSelect;
export type InsertAudioTrack = z.infer<typeof insertAudioTrackSchema>;

export interface RadioState {
  currentTrackId: string | null;
  playbackPosition: number;
  isLive: boolean;
  backgroundVolume: number;
  listenerCount: number;
  broadcastEnabled: boolean;
  syncMethod: "manual" | "auto";
}

export interface AdminLiveState {
  isLive: boolean;
  backgroundVolume: number;
}

export interface ChatMessage {
  id: string;
  username: string;
  text: string;
  timestamp: number;
}

export interface ListenerAnalytics {
  timestamp: number;
  listenerCount: number;
}

export interface StreamConfig {
  streamUrl: string;
  isEnabled: boolean;
}
