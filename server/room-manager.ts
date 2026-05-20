import type {
  ClientEvent,
  ParticipantRole,
  ParticipantSnapshot,
  PlaybackStatus,
  RoomSnapshot,
  TrackMetadata,
} from "../shared/protocol";
import { generateRoomId, getCurrentPosition, parseYouTubeUrl } from "../shared/youtube";
import type { PersistedRoom, Persistence } from "./persistence/sqlite";

type RoomParticipant = {
  sessionId: string;
  connectionId: string;
  firstJoinedAt: number;
};

type ParticipantMeta = {
  label: string;
  firstJoinedAt: number;
};

type TokenRecord = {
  token: string;
  role: Exclude<ParticipantRole, "listener">;
  sessionId: string;
};

type RoomState = {
  roomId: string;
  source: RoomSnapshot["source"];
  playbackStatus: PlaybackStatus;
  currentTrackIndex: number;
  currentVideoId: string | null;
  currentTrackMetadata: TrackMetadata | null;
  startedAt: number | null;
  pausedAt: number;
  updatedAt: number;
  hostSessionId: string;
  adminSessionIds: Set<string>;
  participants: Map<string, RoomParticipant>;
  participantMeta: Map<string, ParticipantMeta>;
  hostFailoverTimer: ReturnType<typeof setTimeout> | null;
  // token -> { role, sessionId }. Lookups are O(1); we walk it for role lookups by sessionId.
  tokens: Map<string, { role: Exclude<ParticipantRole, "listener">; sessionId: string }>;
  // Per-session reaction timestamps (sliding window) for rate-limit.
  reactionWindow: Map<string, number[]>;
};

type CreateRoomInput = {
  url: string;
  creatorSessionId: string;
};

export type CreateRoomResult = {
  room: RoomSnapshot;
  hostToken: string;
};

type JoinRoomInput = {
  roomId: string;
  sessionId: string;
  connectionId: string;
};

export type RoleGrant = {
  targetSessionId: string;
  role: Exclude<ParticipantRole, "listener">;
  token: string;
};

export type RoleRevoke = {
  targetSessionId: string;
  role: Exclude<ParticipantRole, "listener">;
};

type DisconnectResult = {
  roomId: string;
  grants?: RoleGrant[];
} | null;

type HandleEventOk = {
  roomId: string;
  grants?: RoleGrant[];
  revokes?: RoleRevoke[];
};

type HandleEventResult = HandleEventOk | { roomId: string; error: string } | null;

const HOST_GRACE_MS = 15_000;
const REACTION_WINDOW_MS = 1000;
const REACTION_LIMIT_PER_WINDOW = 3;

export class RoomManager {
  private rooms = new Map<string, RoomState>();
  private connectionToRoom = new Map<string, string>();
  private persistence?: Persistence;
  private hostGraceMs: number;

  constructor(options: { persistence?: Persistence; hostGraceMs?: number } = {}) {
    this.persistence = options.persistence;
    this.hostGraceMs = options.hostGraceMs ?? HOST_GRACE_MS;
  }

  restore(rooms: PersistedRoom[]) {
    for (const persisted of rooms) {
      // Persisted rooms come back paused, regardless of what state they were in at shutdown:
      // resuming "as if nothing happened" feels broken to clients whose audio just cut out.
      const room: RoomState = {
        roomId: persisted.roomId,
        source: persisted.source,
        playbackStatus: "paused",
        currentTrackIndex: persisted.currentTrackIndex,
        currentVideoId: persisted.currentVideoId,
        currentTrackMetadata: persisted.currentTrackMetadata ?? null,
        startedAt: null,
        pausedAt: persisted.pausedAt,
        updatedAt: persisted.updatedAt,
        hostSessionId: persisted.hostSessionId,
        adminSessionIds: new Set(persisted.adminSessionIds),
        participants: new Map(),
        participantMeta: new Map(
          persisted.participantMeta.map((m) => [
            m.sessionId,
            { label: m.label, firstJoinedAt: m.firstJoinedAt },
          ]),
        ),
        hostFailoverTimer: null,
        tokens: new Map(persisted.tokens.map((t) => [t.token, { role: t.role, sessionId: t.sessionId }])),
        reactionWindow: new Map(),
      };
      this.rooms.set(persisted.roomId, room);
    }
  }

  private persistRoom(roomId: string) {
    if (!this.persistence) return;
    const room = this.rooms.get(roomId);
    if (!room) return;
    this.persistence.saveRoom(snapshotForPersistence(room));
  }

  createRoom(input: CreateRoomInput): CreateRoomResult {
    const source = parseYouTubeUrl(input.url);
    const roomId = generateUniqueRoomId(this.rooms);
    const now = Date.now();

    const room: RoomState = {
      roomId,
      source,
      playbackStatus: "paused",
      currentTrackIndex: 0,
      currentVideoId: source.kind === "video" ? source.videoId : source.initialVideoId ?? null,
      currentTrackMetadata: null,
      startedAt: null,
      pausedAt: 0,
      updatedAt: now,
      hostSessionId: input.creatorSessionId,
      adminSessionIds: new Set(),
      participants: new Map(),
      participantMeta: new Map([
        [
          input.creatorSessionId,
          {
            label: "Host",
            firstJoinedAt: now,
          },
        ],
      ]),
      hostFailoverTimer: null,
      tokens: new Map(),
      reactionWindow: new Map(),
    };

    const hostToken = mintToken();
    room.tokens.set(hostToken, { role: "host", sessionId: input.creatorSessionId });

    this.rooms.set(roomId, room);
    this.persistRoom(roomId);
    return {
      room: this.getSnapshot(roomId),
      hostToken,
    };
  }

  getSnapshot(roomId: string): RoomSnapshot {
    const room = this.rooms.get(roomId);
    if (!room) {
      throw new Error("Room not found.");
    }

    const connectedSessions = new Set([...room.participants.values()].map((participant) => participant.sessionId));
    const participants: ParticipantSnapshot[] = [...room.participantMeta.entries()]
      .sort((a, b) => a[1].firstJoinedAt - b[1].firstJoinedAt)
      .map(([sessionId, meta]) => ({
        sessionId,
        label: meta.label,
        role: getRole(room, sessionId),
        connected: connectedSessions.has(sessionId),
      }));

    return {
      roomId: room.roomId,
      source: room.source,
      playbackStatus: room.playbackStatus,
      currentTrackIndex: room.currentTrackIndex,
      currentVideoId: room.currentVideoId,
      currentTrackMetadata: room.currentTrackMetadata,
      startedAt: room.startedAt,
      pausedAt: room.pausedAt,
      updatedAt: room.updatedAt,
      memberCount: connectedSessions.size,
      participants,
    };
  }

  joinRoom(input: JoinRoomInput): { room: RoomSnapshot; viewerRole: ParticipantRole } {
    const room = this.rooms.get(input.roomId);
    if (!room) {
      throw new Error("Room not found.");
    }

    if (room.hostSessionId === input.sessionId && room.hostFailoverTimer) {
      clearTimeout(room.hostFailoverTimer);
      room.hostFailoverTimer = null;
    }

    if (!room.participantMeta.has(input.sessionId)) {
      room.participantMeta.set(input.sessionId, {
        label: `Listener ${room.participantMeta.size + 1}`,
        firstJoinedAt: Date.now(),
      });
    }

    room.participants.set(input.connectionId, {
      sessionId: input.sessionId,
      connectionId: input.connectionId,
      firstJoinedAt: Date.now(),
    });
    room.updatedAt = Date.now();
    this.connectionToRoom.set(input.connectionId, input.roomId);

    return {
      room: this.getSnapshot(input.roomId),
      viewerRole: getRole(room, input.sessionId),
    };
  }

  disconnect(connectionId: string): DisconnectResult {
    const roomId = this.connectionToRoom.get(connectionId);
    if (!roomId) {
      return null;
    }

    this.connectionToRoom.delete(connectionId);
    const room = this.rooms.get(roomId);
    if (!room) {
      return null;
    }

    const participant = room.participants.get(connectionId);
    room.participants.delete(connectionId);
    room.updatedAt = Date.now();

    if (!participant) {
      return { roomId };
    }

    // If this was the session's last connection, drop their reaction window so it doesn't leak.
    if (!hasConnectedSession(room, participant.sessionId)) {
      room.reactionWindow.delete(participant.sessionId);
    }

    if (
      participant.sessionId === room.hostSessionId &&
      !hasConnectedSession(room, room.hostSessionId) &&
      !room.hostFailoverTimer
    ) {
      room.hostFailoverTimer = setTimeout(() => {
        room.hostFailoverTimer = null;
        if (!hasConnectedSession(room, room.hostSessionId)) {
          const grants = transferHost(room);
          if (grants.length > 0) {
            this.persistRoom(roomId);
            this.onPendingGrants?.(roomId, grants);
          }
        }
      }, this.hostGraceMs);
    }

    return {
      roomId,
    };
  }

  // Async callback for failover-driven role grants. Wire from server to fan out role:granted events.
  onPendingGrants?: (roomId: string, grants: RoleGrant[]) => void;

  handleEvent(event: ClientEvent): HandleEventResult {
    const result = this.handleEventInner(event);
    if (result && !("error" in result)) {
      this.persistRoom(result.roomId);
    }
    return result;
  }

  private handleEventInner(event: ClientEvent): HandleEventResult {
    if (event.type === "room:join" || event.type === "reaction:send") {
      // room:join is handled by the server entrypoint; reactions go through submitReaction.
      return null;
    }

    const room = this.rooms.get(event.roomId);
    if (!room) {
      return { roomId: event.roomId, error: "Room not found." };
    }

    const tokenRecord = verifyToken(room, event.token);
    if (!tokenRecord || tokenRecord.sessionId !== event.sessionId) {
      return { roomId: event.roomId, error: "You do not have permission to control this room." };
    }

    switch (event.type) {
      case "playback:play": {
        room.playbackStatus = "playing";
        room.startedAt = Date.now();
        room.updatedAt = Date.now();
        return { roomId: room.roomId };
      }
      case "playback:pause": {
        room.playbackStatus = "paused";
        room.pausedAt = clampPosition(event.pausedAt);
        room.startedAt = null;
        room.updatedAt = Date.now();
        return { roomId: room.roomId };
      }
      case "playback:seek": {
        room.pausedAt = clampPosition(event.position);
        room.startedAt = room.playbackStatus === "playing" ? Date.now() : null;
        room.updatedAt = Date.now();
        return { roomId: room.roomId };
      }
      case "playback:next": {
        room.currentTrackIndex += 1;
        room.currentVideoId = null;
        room.currentTrackMetadata = null;
        room.pausedAt = 0;
        room.startedAt = room.playbackStatus === "playing" ? Date.now() : null;
        room.updatedAt = Date.now();
        return { roomId: room.roomId };
      }
      case "playback:previous": {
        room.currentTrackIndex = Math.max(0, room.currentTrackIndex - 1);
        room.currentVideoId = null;
        room.currentTrackMetadata = null;
        room.pausedAt = 0;
        room.startedAt = room.playbackStatus === "playing" ? Date.now() : null;
        room.updatedAt = Date.now();
        return { roomId: room.roomId };
      }
      case "playback:replace-source": {
        const source = parseYouTubeUrl(event.url);
        room.source = source;
        room.currentTrackIndex = 0;
        room.currentVideoId = source.kind === "video" ? source.videoId : source.initialVideoId ?? null;
        room.currentTrackMetadata = null;
        room.pausedAt = 0;
        room.startedAt = null;
        room.playbackStatus = "paused";
        room.updatedAt = Date.now();
        return { roomId: room.roomId };
      }
      case "playback:report-track": {
        if (tokenRecord.role !== "host") {
          return { roomId: room.roomId, error: "Only the host can report playlist track changes." };
        }
        if (event.currentVideoId !== room.currentVideoId) {
          // Track changed — drop stale metadata; a fresh track:metadata report will replace it.
          room.currentTrackMetadata = null;
        }
        room.currentTrackIndex = Math.max(0, event.currentTrackIndex);
        room.currentVideoId = event.currentVideoId;
        room.playbackStatus = event.playbackStatus;
        room.pausedAt = clampPosition(event.position);
        room.startedAt = event.playbackStatus === "playing" ? Date.now() : null;
        room.updatedAt = Date.now();
        return { roomId: room.roomId };
      }
      case "role:promote-admin": {
        if (tokenRecord.role !== "host") {
          return { roomId: room.roomId, error: "Only the host can promote admins." };
        }
        if (event.targetSessionId === room.hostSessionId) {
          return { roomId: room.roomId, error: "The host cannot be promoted." };
        }
        if (room.adminSessionIds.has(event.targetSessionId)) {
          return { roomId: room.roomId };
        }
        room.adminSessionIds.add(event.targetSessionId);
        const adminToken = mintToken();
        room.tokens.set(adminToken, { role: "admin", sessionId: event.targetSessionId });
        room.updatedAt = Date.now();
        return {
          roomId: room.roomId,
          grants: [{ targetSessionId: event.targetSessionId, role: "admin", token: adminToken }],
        };
      }
      case "track:metadata": {
        if (event.metadata.videoId !== room.currentVideoId) {
          // Ignore stale metadata reports — the track has already advanced.
          return { roomId: room.roomId };
        }
        room.currentTrackMetadata = event.metadata;
        room.updatedAt = Date.now();
        return { roomId: room.roomId };
      }
      case "role:revoke-admin": {
        if (tokenRecord.role !== "host") {
          return { roomId: room.roomId, error: "Only the host can revoke admins." };
        }
        if (!room.adminSessionIds.has(event.targetSessionId)) {
          return { roomId: room.roomId };
        }
        room.adminSessionIds.delete(event.targetSessionId);
        revokeTokensFor(room, event.targetSessionId, "admin");
        room.updatedAt = Date.now();
        return {
          roomId: room.roomId,
          revokes: [{ targetSessionId: event.targetSessionId, role: "admin" }],
        };
      }
    }
  }

  submitReaction(input: {
    roomId: string;
    sessionId: string;
    emoji: string;
    now?: number;
  }): { ok: true; fromSessionId: string; emoji: string } | { ok: false; error: string } {
    const room = this.rooms.get(input.roomId);
    if (!room) {
      return { ok: false, error: "Room not found." };
    }

    if (!hasConnectedSession(room, input.sessionId) && room.hostSessionId !== input.sessionId) {
      return { ok: false, error: "Join the room before reacting." };
    }

    const now = input.now ?? Date.now();
    const window = room.reactionWindow.get(input.sessionId) ?? [];
    const recent = window.filter((t) => now - t < REACTION_WINDOW_MS);
    if (recent.length >= REACTION_LIMIT_PER_WINDOW) {
      room.reactionWindow.set(input.sessionId, recent);
      return { ok: false, error: "Too many reactions — slow down." };
    }
    recent.push(now);
    room.reactionWindow.set(input.sessionId, recent);

    return { ok: true, fromSessionId: input.sessionId, emoji: input.emoji };
  }

  getViewerRole(roomId: string, sessionId: string): ParticipantRole {
    const room = this.rooms.get(roomId);
    if (!room) {
      throw new Error("Room not found.");
    }

    return getRole(room, sessionId);
  }

  getLivePosition(roomId: string): number {
    const room = this.rooms.get(roomId);
    if (!room) {
      throw new Error("Room not found.");
    }

    return getCurrentPosition(room.startedAt, room.pausedAt, room.playbackStatus);
  }
}

function clampPosition(position: number) {
  if (Number.isNaN(position) || !Number.isFinite(position)) {
    return 0;
  }

  return Math.max(0, position);
}

function generateUniqueRoomId(rooms: Map<string, RoomState>) {
  let roomId = generateRoomId();
  while (rooms.has(roomId)) {
    roomId = generateRoomId();
  }
  return roomId;
}

function getRole(room: RoomState, sessionId: string): ParticipantRole {
  if (room.hostSessionId === sessionId) {
    return "host";
  }

  if (room.adminSessionIds.has(sessionId)) {
    return "admin";
  }

  return "listener";
}

function mintToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function verifyToken(room: RoomState, token: string | undefined) {
  if (!token || typeof token !== "string") {
    return null;
  }
  const record = room.tokens.get(token);
  if (!record) {
    return null;
  }
  // Cross-check that role still matches current room state (defends against stale tokens after revoke/transfer).
  if (record.role === "host" && record.sessionId !== room.hostSessionId) {
    return null;
  }
  if (record.role === "admin" && !room.adminSessionIds.has(record.sessionId)) {
    return null;
  }
  return record;
}

function revokeTokensFor(room: RoomState, sessionId: string, role: Exclude<ParticipantRole, "listener">) {
  for (const [token, record] of room.tokens) {
    if (record.sessionId === sessionId && record.role === role) {
      room.tokens.delete(token);
    }
  }
}

function hasConnectedSession(room: RoomState, sessionId: string) {
  return [...room.participants.values()].some((participant) => participant.sessionId === sessionId);
}

function transferHost(room: RoomState): RoleGrant[] {
  const previousHost = room.hostSessionId;
  const nextAdmin = [...room.adminSessionIds].find((sessionId) => hasConnectedSession(room, sessionId));

  const grants: RoleGrant[] = [];
  let newHost: string | null = null;

  if (nextAdmin) {
    newHost = nextAdmin;
    room.adminSessionIds.delete(nextAdmin);
    revokeTokensFor(room, nextAdmin, "admin");
  } else {
    const fallback = [...room.participants.values()]
      .sort((a, b) => a.firstJoinedAt - b.firstJoinedAt)
      .find((participant) => participant.sessionId !== previousHost);
    if (fallback) {
      newHost = fallback.sessionId;
    }
  }

  if (!newHost) {
    return grants;
  }

  // Revoke the old host's token. The old host, if it ever reconnects, lands as listener.
  revokeTokensFor(room, previousHost, "host");

  room.hostSessionId = newHost;
  room.updatedAt = Date.now();

  const hostToken = mintToken();
  room.tokens.set(hostToken, { role: "host", sessionId: newHost });
  grants.push({ targetSessionId: newHost, role: "host", token: hostToken });

  return grants;
}

function snapshotForPersistence(room: RoomState): PersistedRoom {
  return {
    roomId: room.roomId,
    source: room.source,
    playbackStatus: room.playbackStatus,
    currentTrackIndex: room.currentTrackIndex,
    currentVideoId: room.currentVideoId,
    currentTrackMetadata: room.currentTrackMetadata,
    startedAt: room.startedAt,
    pausedAt: room.pausedAt,
    updatedAt: room.updatedAt,
    hostSessionId: room.hostSessionId,
    adminSessionIds: [...room.adminSessionIds],
    tokens: [...room.tokens.entries()].map(([token, record]) => ({
      token,
      role: record.role,
      sessionId: record.sessionId,
    })),
    participantMeta: [...room.participantMeta.entries()].map(([sessionId, meta]) => ({
      sessionId,
      label: meta.label,
      firstJoinedAt: meta.firstJoinedAt,
    })),
  };
}
