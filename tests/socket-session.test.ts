import { describe, expect, test } from "bun:test";
import { bindEventToSocketSession } from "../server/socket-session";

describe("bindEventToSocketSession", () => {
  test("overrides forged session ids with the socket session", () => {
    const event = bindEventToSocketSession(
      {
        type: "playback:seek",
        roomId: "room-1",
        sessionId: "forged-session",
        token: "token-1",
        position: 12,
      },
      "socket-session",
    );

    expect(event.sessionId).toBe("socket-session");
    expect(event).toEqual({
      type: "playback:seek",
      roomId: "room-1",
      sessionId: "socket-session",
      token: "token-1",
      position: 12,
    });
  });
});
