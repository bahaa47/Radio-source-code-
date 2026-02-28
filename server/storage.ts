import { type User, type InsertUser, type AudioTrack, type InsertAudioTrack, type RadioState, type ChatMessage, type ListenerAnalytics, type StreamConfig } from "@shared/schema";

export interface IStorage {
  getUser(id: string): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;
  
  getAllTracks(): Promise<AudioTrack[]>;
  getTrack(id: string): Promise<AudioTrack | undefined>;
  createTrack(track: InsertAudioTrack): Promise<AudioTrack>;
  updateTrack(id: string, updates: Partial<AudioTrack>): Promise<AudioTrack | undefined>;
  deleteTrack(id: string): Promise<void>;
  updateTrackOrder(trackId: string, newOrder: number): Promise<void>;
  
  getRadioState(): Promise<RadioState>;
  updateRadioState(state: Partial<RadioState>): Promise<void>;

  addChatMessage(message: ChatMessage): Promise<void>;
  getChatMessages(limit: number): Promise<ChatMessage[]>;
  
  recordListenerAnalytics(count: number): Promise<void>;
  getListenerAnalytics(minutesBack: number): Promise<ListenerAnalytics[]>;
  
  getStreamConfig(): Promise<StreamConfig>;
  updateStreamConfig(config: Partial<StreamConfig>): Promise<void>;
}

export class MemStorage implements IStorage {
  private users: Map<string, User>;
  private tracks: Map<string, AudioTrack>;
  private radioState: RadioState;
  private chatMessages: ChatMessage[] = [];
  private listenerAnalytics: ListenerAnalytics[] = [];
  private streamConfig: StreamConfig;
  private nextUserId: number = 1;
  private nextTrackId: number = 1;

  constructor() {
    this.users = new Map();
    this.tracks = new Map();
    this.radioState = {
      currentTrackId: null,
      playbackPosition: 0,
      isLive: false,
      backgroundVolume: 30,
      listenerCount: 0,
      broadcastEnabled: true,
      syncMethod: "auto",
    };
    this.streamConfig = {
      streamUrl: "",
      isEnabled: false,
    };
  }

  async getUser(id: string): Promise<User | undefined> {
    return this.users.get(id);
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    return Array.from(this.users.values()).find(u => u.username === username);
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const id = (this.nextUserId++).toString();
    const user: User = { ...insertUser, id };
    this.users.set(id, user);
    return user;
  }

  async getAllTracks(): Promise<AudioTrack[]> {
    return Array.from(this.tracks.values()).sort((a, b) => a.order - b.order);
  }

  async getTrack(id: string): Promise<AudioTrack | undefined> {
    return this.tracks.get(id);
  }

  async createTrack(insertTrack: InsertAudioTrack): Promise<AudioTrack> {
    const id = (this.nextTrackId++).toString();
    const track: AudioTrack = { 
      ...insertTrack, 
      id,
      artist: insertTrack.artist ?? null,
      uploadStatus: insertTrack.uploadStatus ?? "ready",
      order: insertTrack.order ?? 0,
      startOffset: insertTrack.startOffset ?? 0,
      endOffset: insertTrack.endOffset ?? null
    };
    this.tracks.set(id, track);
    return track;
  }

  async updateTrack(id: string, updates: Partial<AudioTrack>): Promise<AudioTrack | undefined> {
    const track = this.tracks.get(id);
    if (!track) return undefined;
    const updatedTrack = { ...track, ...updates };
    this.tracks.set(id, updatedTrack);
    return updatedTrack;
  }

  async deleteTrack(id: string): Promise<void> {
    this.tracks.delete(id);
  }

  async updateTrackOrder(trackId: string, newOrder: number): Promise<void> {
    const track = this.tracks.get(trackId);
    if (track) {
      track.order = newOrder;
    }
  }

  async getRadioState(): Promise<RadioState> {
    return { ...this.radioState };
  }

  async updateRadioState(state: Partial<RadioState>): Promise<void> {
    this.radioState = { ...this.radioState, ...state };
  }

  async addChatMessage(message: ChatMessage): Promise<void> {
    this.chatMessages.push(message);
    if (this.chatMessages.length > 100) {
      this.chatMessages = this.chatMessages.slice(-100);
    }
  }

  async getChatMessages(limit: number): Promise<ChatMessage[]> {
    return this.chatMessages.slice(-limit);
  }

  async recordListenerAnalytics(count: number): Promise<void> {
    this.listenerAnalytics.push({
      timestamp: Date.now(),
      listenerCount: count,
    });
    if (this.listenerAnalytics.length > 1440) {
      this.listenerAnalytics = this.listenerAnalytics.slice(-1440);
    }
  }

  async getListenerAnalytics(minutesBack: number): Promise<ListenerAnalytics[]> {
    const cutoff = Date.now() - minutesBack * 60 * 1000;
    return this.listenerAnalytics.filter(a => a.timestamp >= cutoff);
  }

  async getStreamConfig(): Promise<StreamConfig> {
    return { ...this.streamConfig };
  }

  async updateStreamConfig(config: Partial<StreamConfig>): Promise<void> {
    this.streamConfig = { ...this.streamConfig, ...config };
  }
}

export const storage = new MemStorage();