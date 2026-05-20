import { describe, expect, test } from "bun:test";
import { RoomManager, type RoleGrant } from "../server/room-manager";

const GRACE_MS = 30;

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("host failover", () => {
  test("transfers to a connected admin after the grace window expires", async () => {
    const grants: Array<{ roomId: string; grants: RoleGrant[] }> = [];
    const manager = new RoomManager({ hostGraceMs: GRACE_MS });
    manager.onPendingGrants = (roomId, g) => grants.push({ roomId, grants: g });

    const { room, hostToken } = manager.createRoom({
      url: "https://www.youtube.com/watch?v=abc123",
      creatorSessionId: "host-1",
    });
    manager.joinRoom({ roomId: room.roomId, sessionId: "host-1", connectionId: "c-host" });
    manager.joinRoom({ roomId: room.roomId, sessionId: "admin-1", connectionId: "c-admin" });

    manager.handleEvent({
      type: "role:promote-admin",
      roomId: room.roomId,
      sessionId: "host-1",
      token: hostToken,
      targetSessionId: "admin-1",
    });

    manager.disconnect("c-host");
    await wait(GRACE_MS * 3);

    expect(grants).toHaveLength(1);
    const grant = grants[0].grants[0];
    expect(grant.role).toBe("host");
    expect(grant.targetSessionId).toBe("admin-1");

    // The newly-minted host token works; the old host token is revoked.
    const seekWithOldToken = manager.handleEvent({
      type: "playback:seek",
      roomId: room.roomId,
      sessionId: "host-1",
      token: hostToken,
      position: 9,
    });
    expect(seekWithOldToken).toEqual({
      roomId: room.roomId,
      error: "You do not have permission to control this room.",
    });

    const seekWithNewToken = manager.handleEvent({
      type: "playback:seek",
      roomId: room.roomId,
      sessionId: "admin-1",
      token: grant.token,
      position: 9,
    });
    expect(seekWithNewToken).toEqual({ roomId: room.roomId });
  });

  test("host reconnecting within the grace window cancels the failover", async () => {
    const grants: Array<{ roomId: string; grants: RoleGrant[] }> = [];
    const manager = new RoomManager({ hostGraceMs: GRACE_MS });
    manager.onPendingGrants = (roomId, g) => grants.push({ roomId, grants: g });

    const { room } = manager.createRoom({
      url: "https://www.youtube.com/watch?v=abc123",
      creatorSessionId: "host-1",
    });
    manager.joinRoom({ roomId: room.roomId, sessionId: "host-1", connectionId: "c-host" });
    manager.joinRoom({ roomId: room.roomId, sessionId: "listener-1", connectionId: "c-lis" });

    manager.disconnect("c-host");
    // Host reconnects from a new tab before the timer fires.
    manager.joinRoom({ roomId: room.roomId, sessionId: "host-1", connectionId: "c-host-2" });
    await wait(GRACE_MS * 3);

    expect(grants).toHaveLength(0);
    expect(manager.getViewerRole(room.roomId, "host-1")).toBe("host");
  });

  test("promotes the earliest listener when no admins are connected", async () => {
    const grants: Array<{ roomId: string; grants: RoleGrant[] }> = [];
    const manager = new RoomManager({ hostGraceMs: GRACE_MS });
    manager.onPendingGrants = (roomId, g) => grants.push({ roomId, grants: g });

    const { room } = manager.createRoom({
      url: "https://www.youtube.com/watch?v=abc123",
      creatorSessionId: "host-1",
    });
    manager.joinRoom({ roomId: room.roomId, sessionId: "host-1", connectionId: "c-host" });
    manager.joinRoom({ roomId: room.roomId, sessionId: "early", connectionId: "c-early" });
    await wait(5);
    manager.joinRoom({ roomId: room.roomId, sessionId: "late", connectionId: "c-late" });

    manager.disconnect("c-host");
    await wait(GRACE_MS * 3);

    expect(grants).toHaveLength(1);
    expect(grants[0].grants[0].targetSessionId).toBe("early");
  });
});
