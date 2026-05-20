import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { RoomManager } from "../server/room-manager";
import { SqlitePersistence } from "../server/persistence/sqlite";

const DB_PATH = "./test-persistence.sqlite";

function freshPersistence() {
  return new SqlitePersistence(DB_PATH);
}

beforeEach(() => {
  try {
    unlinkSync(DB_PATH);
  } catch {
    // file didn't exist
  }
});

afterEach(() => {
  try {
    unlinkSync(DB_PATH);
    unlinkSync(`${DB_PATH}-wal`);
    unlinkSync(`${DB_PATH}-shm`);
  } catch {
    // ignore
  }
});

describe("SqlitePersistence", () => {
  test("round-trips a room and its tokens across a simulated restart", () => {
    const persistA = freshPersistence();
    const managerA = new RoomManager({ persistence: persistA });
    const { room, hostToken } = managerA.createRoom({
      url: "https://www.youtube.com/watch?v=abc123",
      creatorSessionId: "host-1",
    });

    managerA.joinRoom({ roomId: room.roomId, sessionId: "host-1", connectionId: "c-1" });
    const playResult = managerA.handleEvent({
      type: "playback:play",
      roomId: room.roomId,
      sessionId: "host-1",
      token: hostToken,
    });
    expect(playResult).toEqual({ roomId: room.roomId });
    expect(managerA.getSnapshot(room.roomId).playbackStatus).toBe("playing");
    persistA.close();

    const persistB = freshPersistence();
    const managerB = new RoomManager({ persistence: persistB });
    managerB.restore(persistB.loadAll());

    // Reloaded rooms are forced paused regardless of saved status.
    const restored = managerB.getSnapshot(room.roomId);
    expect(restored.playbackStatus).toBe("paused");
    expect(restored.startedAt).toBeNull();

    // The host token survives the restart.
    const seek = managerB.handleEvent({
      type: "playback:seek",
      roomId: room.roomId,
      sessionId: "host-1",
      token: hostToken,
      position: 42,
    });
    expect(seek).toEqual({ roomId: room.roomId });
    expect(managerB.getSnapshot(room.roomId).pausedAt).toBe(42);
    persistB.close();
  });

  test("reapStale deletes rooms older than the cutoff", () => {
    const persistence = freshPersistence();
    const manager = new RoomManager({ persistence });
    const { room } = manager.createRoom({
      url: "https://www.youtube.com/watch?v=abc123",
      creatorSessionId: "host-1",
    });

    // Sanity: nothing is older than a minute ago.
    expect(persistence.reapStale(60_000)).toBe(0);

    // Anything older than 0ms == everything.
    expect(persistence.reapStale(-1)).toBeGreaterThan(0);

    const managerB = new RoomManager({ persistence });
    managerB.restore(persistence.loadAll());
    expect(() => managerB.getSnapshot(room.roomId)).toThrow("Room not found.");
    persistence.close();
  });
});
