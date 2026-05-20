import type { RoomSource } from "./protocol";

const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "youtu.be",
]);

export function parseYouTubeUrl(rawUrl: string): RoomSource {
  let url: URL;

  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Enter a valid URL.");
  }

  if (!YOUTUBE_HOSTS.has(url.hostname)) {
    throw new Error("Only YouTube video and playlist URLs are supported.");
  }

  const playlistId = url.searchParams.get("list");
  const videoId = extractVideoId(url);

  if (playlistId) {
    return {
      kind: "playlist",
      playlistId,
      initialVideoId: videoId ?? null,
    };
  }

  if (videoId) {
    return {
      kind: "video",
      videoId,
    };
  }

  throw new Error("Could not find a YouTube video or playlist in that URL.");
}

export function extractVideoId(url: URL): string | null {
  if (url.hostname === "youtu.be") {
    const id = url.pathname.slice(1);
    return id || null;
  }

  if (url.pathname === "/watch") {
    return url.searchParams.get("v");
  }

  if (url.pathname.startsWith("/shorts/") || url.pathname.startsWith("/embed/")) {
    const [, , videoId] = url.pathname.split("/");
    return videoId || null;
  }

  return null;
}

export function generateRoomId(): string {
  return Math.random().toString(36).slice(2, 8);
}

export function getCurrentPosition(startedAt: number | null, pausedAt: number, status: "playing" | "paused") {
  if (status === "paused" || startedAt === null) {
    return pausedAt;
  }

  return pausedAt + (Date.now() - startedAt) / 1000;
}
