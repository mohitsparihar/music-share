import { describe, expect, test } from "bun:test";
import { RoomManager } from "../server/room-manager";

describe("RoomManager", () => {
  test("creates a room and the creator joins as host", () => {
    const manager = new RoomManager();
    const { room, hostToken } = manager.createRoom({
      url: "https://www.youtube.com/watch?v=abc123",
      creatorSessionId: "host-1",
    });

    expect(hostToken).toMatch(/^[0-9a-f]{64}$/);

    const joined = manager.joinRoom({
      roomId: room.roomId,
      sessionId: "host-1",
      connectionId: "conn-1",
    });

    expect(joined.viewerRole).toBe("host");
    expect(joined.room.memberCount).toBe(1);
  });

  test("blocks control events without a valid token", () => {
    const manager = new RoomManager();
    const { room } = manager.createRoom({
      url: "https://www.youtube.com/watch?v=abc123",
      creatorSessionId: "host-1",
    });

    manager.joinRoom({
      roomId: room.roomId,
      sessionId: "listener-1",
      connectionId: "conn-2",
    });

    const result = manager.handleEvent({
      type: "playback:play",
      roomId: room.roomId,
      sessionId: "listener-1",
      token: "not-a-real-token",
    });

    expect(result).toEqual({
      roomId: room.roomId,
      error: "You do not have permission to control this room.",
    });
  });

  test("rejects a host token paired with a different sessionId", () => {
    const manager = new RoomManager();
    const { room, hostToken } = manager.createRoom({
      url: "https://www.youtube.com/watch?v=abc123",
      creatorSessionId: "host-1",
    });

    const result = manager.handleEvent({
      type: "playback:play",
      roomId: room.roomId,
      sessionId: "impersonator",
      token: hostToken,
    });

    expect(result).toEqual({
      roomId: room.roomId,
      error: "You do not have permission to control this room.",
    });
  });

  test("public snapshot no longer exposes host or admin session ids", () => {
    const manager = new RoomManager();
    const { room } = manager.createRoom({
      url: "https://www.youtube.com/watch?v=abc123",
      creatorSessionId: "host-1",
    });

    expect(room).not.toHaveProperty("hostSessionId");
    expect(room).not.toHaveProperty("adminSessionIds");
  });

  test("promoting an admin mints a token they can use to seek", () => {
    const manager = new RoomManager();
    const { room, hostToken } = manager.createRoom({
      url: "https://www.youtube.com/watch?v=abc123",
      creatorSessionId: "host-1",
    });

    manager.joinRoom({
      roomId: room.roomId,
      sessionId: "host-1",
      connectionId: "conn-host",
    });
    manager.joinRoom({
      roomId: room.roomId,
      sessionId: "admin-1",
      connectionId: "conn-admin",
    });

    const promote = manager.handleEvent({
      type: "role:promote-admin",
      roomId: room.roomId,
      sessionId: "host-1",
      token: hostToken,
      targetSessionId: "admin-1",
    });

    if (!promote || "error" in promote) {
      throw new Error("expected promote to succeed");
    }

    const grant = promote.grants?.[0];
    expect(grant?.role).toBe("admin");
    expect(grant?.targetSessionId).toBe("admin-1");
    expect(grant?.token).toMatch(/^[0-9a-f]{64}$/);

    const seek = manager.handleEvent({
      type: "playback:seek",
      roomId: room.roomId,
      sessionId: "admin-1",
      token: grant!.token,
      position: 99,
    });

    expect(seek).toEqual({ roomId: room.roomId });
    expect(manager.getSnapshot(room.roomId).pausedAt).toBe(99);
  });

  test("revoking an admin invalidates their token", () => {
    const manager = new RoomManager();
    const { room, hostToken } = manager.createRoom({
      url: "https://www.youtube.com/watch?v=abc123",
      creatorSessionId: "host-1",
    });

    manager.joinRoom({ roomId: room.roomId, sessionId: "host-1", connectionId: "c-host" });
    manager.joinRoom({ roomId: room.roomId, sessionId: "admin-1", connectionId: "c-admin" });

    const promote = manager.handleEvent({
      type: "role:promote-admin",
      roomId: room.roomId,
      sessionId: "host-1",
      token: hostToken,
      targetSessionId: "admin-1",
    });

    if (!promote || "error" in promote) throw new Error("expected promote ok");
    const adminToken = promote.grants![0].token;

    manager.handleEvent({
      type: "role:revoke-admin",
      roomId: room.roomId,
      sessionId: "host-1",
      token: hostToken,
      targetSessionId: "admin-1",
    });

    const blocked = manager.handleEvent({
      type: "playback:seek",
      roomId: room.roomId,
      sessionId: "admin-1",
      token: adminToken,
      position: 5,
    });

    expect(blocked).toEqual({
      roomId: room.roomId,
      error: "You do not have permission to control this room.",
    });
  });

  test("admins cannot report playlist track changes", () => {
    const manager = new RoomManager();
    const { room, hostToken } = manager.createRoom({
      url: "https://www.youtube.com/watch?v=abc123&list=PL123",
      creatorSessionId: "host-1",
    });

    manager.joinRoom({ roomId: room.roomId, sessionId: "host-1", connectionId: "c-host" });
    manager.joinRoom({ roomId: room.roomId, sessionId: "admin-1", connectionId: "c-admin" });

    const promote = manager.handleEvent({
      type: "role:promote-admin",
      roomId: room.roomId,
      sessionId: "host-1",
      token: hostToken,
      targetSessionId: "admin-1",
    });

    if (!promote || "error" in promote) throw new Error("expected promote ok");
    const adminToken = promote.grants![0].token;

    const report = manager.handleEvent({
      type: "playback:report-track",
      roomId: room.roomId,
      sessionId: "admin-1",
      token: adminToken,
      currentTrackIndex: 3,
      currentVideoId: "xyz789",
      playbackStatus: "playing",
      position: 27,
    });

    expect(report).toEqual({
      roomId: room.roomId,
      error: "Only the host can report playlist track changes.",
    });
    expect(manager.getSnapshot(room.roomId).currentTrackIndex).toBe(0);
  });
});
