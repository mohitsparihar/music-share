import { describe, expect, test } from "bun:test";
import { parseClientEvent } from "../shared/protocol";

describe("parseClientEvent", () => {
  test("accepts a well-formed control event", () => {
    const result = parseClientEvent({
      type: "playback:seek",
      roomId: "abc123",
      sessionId: "session-1",
      token: "tok",
      position: 12.5,
    });
    expect(result.ok).toBe(true);
  });

  test("rejects unknown event types", () => {
    const result = parseClientEvent({ type: "playback:rewind-time", roomId: "x", sessionId: "y" });
    expect(result.ok).toBe(false);
  });

  test("rejects control events missing a token", () => {
    const result = parseClientEvent({
      type: "playback:play",
      roomId: "abc",
      sessionId: "s",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/token/);
    }
  });

  test("rejects payloads with wrong field types", () => {
    const result = parseClientEvent({
      type: "playback:seek",
      roomId: "abc",
      sessionId: "s",
      token: "t",
      position: "twelve",
    });
    expect(result.ok).toBe(false);
  });

  test("room:join does not require a token", () => {
    const result = parseClientEvent({ type: "room:join", roomId: "abc", sessionId: "s" });
    expect(result.ok).toBe(true);
  });
});
