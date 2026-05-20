import { Database } from "bun:sqlite";
import type { PlaybackStatus, ParticipantRole, RoomSource, TrackMetadata } from "../../shared/protocol";

export type PersistedRoom = {
  roomId: string;
  source: RoomSource;
  playbackStatus: PlaybackStatus;
  currentTrackIndex: number;
  currentVideoId: string | null;
  currentTrackMetadata: TrackMetadata | null;
  startedAt: number | null;
  pausedAt: number;
  updatedAt: number;
  hostSessionId: string;
  adminSessionIds: string[];
  tokens: Array<{
    token: string;
    role: Exclude<ParticipantRole, "listener">;
    sessionId: string;
  }>;
  participantMeta: Array<{
    sessionId: string;
    label: string;
    firstJoinedAt: number;
  }>;
};

export interface Persistence {
  saveRoom(room: PersistedRoom): void;
  deleteRoom(roomId: string): void;
  loadAll(): PersistedRoom[];
  reapStale(olderThanMs: number): number;
}

export class SqlitePersistence implements Persistence {
  private db: Database;

  constructor(path: string) {
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS rooms (
        room_id TEXT PRIMARY KEY,
        source_json TEXT NOT NULL,
        playback_status TEXT NOT NULL,
        current_track_index INTEGER NOT NULL,
        current_video_id TEXT,
        current_track_metadata_json TEXT,
        started_at INTEGER,
        paused_at REAL NOT NULL,
        updated_at INTEGER NOT NULL,
        host_session_id TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS admins (
        room_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        PRIMARY KEY (room_id, session_id),
        FOREIGN KEY (room_id) REFERENCES rooms (room_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS tokens (
        token TEXT PRIMARY KEY,
        room_id TEXT NOT NULL,
        role TEXT NOT NULL,
        session_id TEXT NOT NULL,
        FOREIGN KEY (room_id) REFERENCES rooms (room_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS participant_meta (
        room_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        label TEXT NOT NULL,
        first_joined_at INTEGER NOT NULL,
        PRIMARY KEY (room_id, session_id),
        FOREIGN KEY (room_id) REFERENCES rooms (room_id) ON DELETE CASCADE
      );
    `);

    this.migrate();
  }

  private migrate() {
    const columns = this.db.prepare("PRAGMA table_info(rooms)").all() as Array<{ name: string }>;
    const names = new Set(columns.map((c) => c.name));
    if (!names.has("current_track_metadata_json")) {
      this.db.exec("ALTER TABLE rooms ADD COLUMN current_track_metadata_json TEXT;");
    }
  }

  saveRoom(room: PersistedRoom): void {
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO rooms (
            room_id, source_json, playback_status, current_track_index,
            current_video_id, current_track_metadata_json, started_at, paused_at, updated_at, host_session_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(room_id) DO UPDATE SET
            source_json = excluded.source_json,
            playback_status = excluded.playback_status,
            current_track_index = excluded.current_track_index,
            current_video_id = excluded.current_video_id,
            current_track_metadata_json = excluded.current_track_metadata_json,
            started_at = excluded.started_at,
            paused_at = excluded.paused_at,
            updated_at = excluded.updated_at,
            host_session_id = excluded.host_session_id`,
        )
        .run(
          room.roomId,
          JSON.stringify(room.source),
          room.playbackStatus,
          room.currentTrackIndex,
          room.currentVideoId,
          room.currentTrackMetadata ? JSON.stringify(room.currentTrackMetadata) : null,
          room.startedAt,
          room.pausedAt,
          room.updatedAt,
          room.hostSessionId,
        );

      this.db.prepare("DELETE FROM admins WHERE room_id = ?").run(room.roomId);
      const insertAdmin = this.db.prepare(
        "INSERT INTO admins (room_id, session_id) VALUES (?, ?)",
      );
      for (const sessionId of room.adminSessionIds) {
        insertAdmin.run(room.roomId, sessionId);
      }

      this.db.prepare("DELETE FROM tokens WHERE room_id = ?").run(room.roomId);
      const insertToken = this.db.prepare(
        "INSERT INTO tokens (token, room_id, role, session_id) VALUES (?, ?, ?, ?)",
      );
      for (const t of room.tokens) {
        insertToken.run(t.token, room.roomId, t.role, t.sessionId);
      }

      this.db.prepare("DELETE FROM participant_meta WHERE room_id = ?").run(room.roomId);
      const insertMeta = this.db.prepare(
        "INSERT INTO participant_meta (room_id, session_id, label, first_joined_at) VALUES (?, ?, ?, ?)",
      );
      for (const meta of room.participantMeta) {
        insertMeta.run(room.roomId, meta.sessionId, meta.label, meta.firstJoinedAt);
      }
    });

    tx();
  }

  deleteRoom(roomId: string): void {
    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM admins WHERE room_id = ?").run(roomId);
      this.db.prepare("DELETE FROM tokens WHERE room_id = ?").run(roomId);
      this.db.prepare("DELETE FROM participant_meta WHERE room_id = ?").run(roomId);
      this.db.prepare("DELETE FROM rooms WHERE room_id = ?").run(roomId);
    });
    tx();
  }

  loadAll(): PersistedRoom[] {
    const roomRows = this.db
      .prepare(
        `SELECT room_id, source_json, playback_status, current_track_index,
                current_video_id, current_track_metadata_json, started_at, paused_at, updated_at, host_session_id
         FROM rooms`,
      )
      .all() as Array<{
      room_id: string;
      source_json: string;
      playback_status: PlaybackStatus;
      current_track_index: number;
      current_video_id: string | null;
      current_track_metadata_json: string | null;
      started_at: number | null;
      paused_at: number;
      updated_at: number;
      host_session_id: string;
    }>;

    const adminRows = this.db
      .prepare("SELECT room_id, session_id FROM admins")
      .all() as Array<{ room_id: string; session_id: string }>;
    const tokenRows = this.db
      .prepare("SELECT token, room_id, role, session_id FROM tokens")
      .all() as Array<{
      token: string;
      room_id: string;
      role: Exclude<ParticipantRole, "listener">;
      session_id: string;
    }>;
    const metaRows = this.db
      .prepare("SELECT room_id, session_id, label, first_joined_at FROM participant_meta")
      .all() as Array<{
      room_id: string;
      session_id: string;
      label: string;
      first_joined_at: number;
    }>;

    return roomRows.map((row) => ({
      roomId: row.room_id,
      source: JSON.parse(row.source_json) as RoomSource,
      playbackStatus: row.playback_status,
      currentTrackIndex: row.current_track_index,
      currentVideoId: row.current_video_id,
      currentTrackMetadata: row.current_track_metadata_json
        ? (JSON.parse(row.current_track_metadata_json) as TrackMetadata)
        : null,
      startedAt: row.started_at,
      pausedAt: row.paused_at,
      updatedAt: row.updated_at,
      hostSessionId: row.host_session_id,
      adminSessionIds: adminRows.filter((r) => r.room_id === row.room_id).map((r) => r.session_id),
      tokens: tokenRows
        .filter((r) => r.room_id === row.room_id)
        .map((r) => ({ token: r.token, role: r.role, sessionId: r.session_id })),
      participantMeta: metaRows
        .filter((r) => r.room_id === row.room_id)
        .map((r) => ({
          sessionId: r.session_id,
          label: r.label,
          firstJoinedAt: r.first_joined_at,
        })),
    }));
  }

  reapStale(olderThanMs: number): number {
    const cutoff = Date.now() - olderThanMs;
    const result = this.db
      .prepare("DELETE FROM rooms WHERE updated_at < ?")
      .run(cutoff);
    return Number(result.changes);
  }

  close() {
    this.db.close();
  }
}
