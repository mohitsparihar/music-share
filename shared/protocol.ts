import { z } from "zod";

export const playbackStatusSchema = z.enum(["playing", "paused"]);
export type PlaybackStatus = z.infer<typeof playbackStatusSchema>;

export const roomSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("video"), videoId: z.string().min(1) }),
  z.object({
    kind: z.literal("playlist"),
    playlistId: z.string().min(1),
    initialVideoId: z.string().min(1).nullable().optional(),
  }),
]);
export type RoomSource = z.infer<typeof roomSourceSchema>;
export type VideoSource = Extract<RoomSource, { kind: "video" }>;
export type PlaylistSource = Extract<RoomSource, { kind: "playlist" }>;

export const participantRoleSchema = z.enum(["host", "admin", "listener"]);
export type ParticipantRole = z.infer<typeof participantRoleSchema>;

export const participantSnapshotSchema = z.object({
  sessionId: z.string(),
  label: z.string(),
  role: participantRoleSchema,
  connected: z.boolean(),
});
export type ParticipantSnapshot = z.infer<typeof participantSnapshotSchema>;

export const trackMetadataSchema = z.object({
  videoId: z.string().min(1),
  title: z.string().min(1).max(300),
  author: z.string().max(200).optional(),
  thumbnailUrl: z.string().url().max(500).optional(),
});
export type TrackMetadata = z.infer<typeof trackMetadataSchema>;

export const roomSnapshotSchema = z.object({
  roomId: z.string(),
  source: roomSourceSchema,
  playbackStatus: playbackStatusSchema,
  currentTrackIndex: z.number().int().nonnegative(),
  currentVideoId: z.string().min(1).nullable(),
  currentTrackMetadata: trackMetadataSchema.nullable(),
  startedAt: z.number().nullable(),
  pausedAt: z.number(),
  updatedAt: z.number(),
  memberCount: z.number().int().nonnegative(),
  participants: z.array(participantSnapshotSchema),
});
export type RoomSnapshot = z.infer<typeof roomSnapshotSchema>;

export const createRoomResponseSchema = z.object({
  room: roomSnapshotSchema,
  hostToken: z.string().min(1),
});
export type CreateRoomResponse = z.infer<typeof createRoomResponseSchema>;

const baseControl = {
  roomId: z.string().min(1),
  sessionId: z.string().min(1),
  token: z.string().min(1),
};

export const clientEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("room:join"),
    roomId: z.string().min(1),
    sessionId: z.string().min(1),
  }),
  z.object({
    type: z.literal("playback:play"),
    ...baseControl,
  }),
  z.object({
    type: z.literal("playback:pause"),
    ...baseControl,
    pausedAt: z.number(),
  }),
  z.object({
    type: z.literal("playback:seek"),
    ...baseControl,
    position: z.number(),
  }),
  z.object({
    type: z.literal("playback:next"),
    ...baseControl,
  }),
  z.object({
    type: z.literal("playback:previous"),
    ...baseControl,
  }),
  z.object({
    type: z.literal("playback:replace-source"),
    ...baseControl,
    url: z.string().min(1),
  }),
  z.object({
    type: z.literal("playback:report-track"),
    ...baseControl,
    currentTrackIndex: z.number().int(),
    currentVideoId: z.string().min(1).nullable(),
    playbackStatus: playbackStatusSchema,
    position: z.number(),
  }),
  z.object({
    type: z.literal("role:promote-admin"),
    ...baseControl,
    targetSessionId: z.string().min(1),
  }),
  z.object({
    type: z.literal("role:revoke-admin"),
    ...baseControl,
    targetSessionId: z.string().min(1),
  }),
  z.object({
    type: z.literal("track:metadata"),
    ...baseControl,
    metadata: trackMetadataSchema,
  }),
  z.object({
    type: z.literal("reaction:send"),
    roomId: z.string().min(1),
    sessionId: z.string().min(1),
    emoji: z.string().min(1).max(8),
  }),
]);
export type ClientEvent = z.infer<typeof clientEventSchema>;

export const serverEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("room:state"), room: roomSnapshotSchema, viewerRole: participantRoleSchema }),
  z.object({ type: z.literal("presence:update"), room: roomSnapshotSchema, viewerRole: participantRoleSchema }),
  z.object({
    type: z.literal("role:granted"),
    role: z.enum(["host", "admin"]),
    token: z.string().min(1),
  }),
  z.object({
    type: z.literal("role:revoked"),
    role: z.enum(["host", "admin"]),
  }),
  z.object({
    type: z.literal("reaction:broadcast"),
    emoji: z.string(),
    fromSessionId: z.string(),
  }),
  z.object({ type: z.literal("error"), message: z.string() }),
  z.object({ type: z.literal("system"), message: z.string() }),
]);
export type ServerEvent = z.infer<typeof serverEventSchema>;

export function parseClientEvent(raw: unknown): { ok: true; event: ClientEvent } | { ok: false; error: string } {
  const result = clientEventSchema.safeParse(raw);
  if (result.success) {
    return { ok: true, event: result.data };
  }
  const first = result.error.issues[0];
  const path = first?.path.join(".") || "payload";
  return { ok: false, error: `Invalid ${path}: ${first?.message ?? "bad request"}` };
}
