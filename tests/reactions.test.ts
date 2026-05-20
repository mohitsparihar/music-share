import { describe, expect, test } from "bun:test";
import { RoomManager } from "../server/room-manager";

function setupRoom() {
  const manager = new RoomManager();
  const { room, hostToken } = manager.createRoom({
    url: "https://www.youtube.com/watch?v=abc123",
    creatorSessionId: "host-1",
  });
  manager.joinRoom({ roomId: room.roomId, sessionId: "host-1", connectionId: "c-host" });
  manager.joinRoom({ roomId: room.roomId, sessionId: "lis-1", connectionId: "c-lis" });
  return { manager, room, hostToken };
}

describe("submitReaction", () => {
  test("allows up to 3 reactions per second per session", () => {
    const { manager, room } = setupRoom();
    const t0 = 1_000_000;
    expect(manager.submitReaction({ roomId: room.roomId, sessionId: "lis-1", emoji: "🎵", now: t0 }).ok).toBe(true);
    expect(manager.submitReaction({ roomId: room.roomId, sessionId: "lis-1", emoji: "🎵", now: t0 + 100 }).ok).toBe(true);
    expect(manager.submitReaction({ roomId: room.roomId, sessionId: "lis-1", emoji: "🎵", now: t0 + 200 }).ok).toBe(true);
    const blocked = manager.submitReaction({
      roomId: room.roomId,
      sessionId: "lis-1",
      emoji: "🎵",
      now: t0 + 300,
    });
    expect(blocked.ok).toBe(false);
  });

  test("a one-second gap re-opens the window", () => {
    const { manager, room } = setupRoom();
    const t0 = 1_000_000;
    for (let i = 0; i < 3; i++) {
      manager.submitReaction({ roomId: room.roomId, sessionId: "lis-1", emoji: "🎵", now: t0 + i });
    }
    expect(manager.submitReaction({ roomId: room.roomId, sessionId: "lis-1", emoji: "🎵", now: t0 + 1_500 }).ok).toBe(true);
  });

  test("rejects reactions from non-members", () => {
    const { manager, room } = setupRoom();
    const result = manager.submitReaction({
      roomId: room.roomId,
      sessionId: "stranger",
      emoji: "🎵",
    });
    expect(result.ok).toBe(false);
  });
});

describe("track:metadata", () => {
  test("host can attach metadata to the current track and joiners see it in the snapshot", () => {
    const { manager, room, hostToken } = setupRoom();
    const result = manager.handleEvent({
      type: "track:metadata",
      roomId: room.roomId,
      sessionId: "host-1",
      token: hostToken,
      metadata: {
        videoId: "abc123",
        title: "Some Song",
        author: "Some Artist",
        thumbnailUrl: "https://i.ytimg.com/vi/abc123/hqdefault.jpg",
      },
    });
    expect(result).toEqual({ roomId: room.roomId });
    expect(manager.getSnapshot(room.roomId).currentTrackMetadata?.title).toBe("Some Song");
  });

  test("stale metadata for a different videoId is ignored", () => {
    const { manager, room, hostToken } = setupRoom();
    const result = manager.handleEvent({
      type: "track:metadata",
      roomId: room.roomId,
      sessionId: "host-1",
      token: hostToken,
      metadata: { videoId: "different", title: "Other Song" },
    });
    expect(result).toEqual({ roomId: room.roomId });
    expect(manager.getSnapshot(room.roomId).currentTrackMetadata).toBeNull();
  });
});
