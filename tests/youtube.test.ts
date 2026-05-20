import { describe, expect, test } from "bun:test";
import { getCurrentPosition, parseYouTubeUrl } from "../shared/youtube";

describe("parseYouTubeUrl", () => {
  test("parses a standard video url", () => {
    expect(parseYouTubeUrl("https://www.youtube.com/watch?v=abc123")).toEqual({
      kind: "video",
      videoId: "abc123",
    });
  });

  test("parses a short youtu.be url", () => {
    expect(parseYouTubeUrl("https://youtu.be/abc123")).toEqual({
      kind: "video",
      videoId: "abc123",
    });
  });

  test("parses a mobile m.youtube.com url", () => {
    expect(parseYouTubeUrl("https://m.youtube.com/watch?v=abc123")).toEqual({
      kind: "video",
      videoId: "abc123",
    });
  });

  test("parses a shorts url", () => {
    expect(parseYouTubeUrl("https://www.youtube.com/shorts/abc123")).toEqual({
      kind: "video",
      videoId: "abc123",
    });
  });

  test("parses an embed url", () => {
    expect(parseYouTubeUrl("https://www.youtube.com/embed/abc123")).toEqual({
      kind: "video",
      videoId: "abc123",
    });
  });

  test("parses a playlist url", () => {
    expect(parseYouTubeUrl("https://www.youtube.com/watch?v=abc123&list=PL123")).toEqual({
      kind: "playlist",
      playlistId: "PL123",
      initialVideoId: "abc123",
    });
  });

  test("parses a playlist-only url with no v parameter", () => {
    expect(parseYouTubeUrl("https://www.youtube.com/playlist?list=PL123")).toEqual({
      kind: "playlist",
      playlistId: "PL123",
      initialVideoId: null,
    });
  });

  test("rejects non-youtube urls", () => {
    expect(() => parseYouTubeUrl("https://example.com/audio")).toThrow(
      "Only YouTube video and playlist URLs are supported.",
    );
  });

  test("rejects malformed urls", () => {
    expect(() => parseYouTubeUrl("not a url")).toThrow("Enter a valid URL.");
  });

  test("rejects youtube urls with no video or playlist", () => {
    expect(() => parseYouTubeUrl("https://www.youtube.com/feed/trending")).toThrow(
      "Could not find a YouTube video or playlist in that URL.",
    );
  });
});

describe("getCurrentPosition", () => {
  test("returns paused time when paused", () => {
    expect(getCurrentPosition(null, 42, "paused")).toBe(42);
  });
});
