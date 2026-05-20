import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useParams } from "react-router-dom";
import type { ClientEvent, ParticipantRole, RoomSnapshot } from "../lib/types";
import { API_BASE_URL, getWebSocketUrl } from "../lib/config";
import { readJsonResponse } from "../lib/http";
import { decideCorrection, loadYouTubeApi, type YouTubePlayer } from "../lib/player";
import { getServerNow, syncClock } from "../lib/clock";
import { getSessionId } from "../lib/session";
import { clearRoomToken, getRoomToken, setRoomToken } from "../lib/tokens";
import { ReconnectingSocket } from "../lib/ws";
import { TapToJoin } from "../components/TapToJoin";
import { NowPlayingCard } from "../components/NowPlayingCard";
import { ReactionDock, ReactionLayer } from "../components/ReactionDock";

export function RoomPage() {
  const { roomId = "" } = useParams();
  const sessionId = useMemo(() => getSessionId(), []);
  const [room, setRoom] = useState<RoomSnapshot | null>(null);
  const [role, setRole] = useState<ParticipantRole>("listener");
  const [token, setToken] = useState<string | null>(() => getRoomToken(roomId));
  const [error, setError] = useState("");
  const [replaceUrl, setReplaceUrl] = useState("");
  const [autoplayNotice, setAutoplayNotice] = useState("");
  const [hasGesture, setHasGesture] = useState(false);
  const [gestureVariant, setGestureVariant] = useState<"join" | "resume">("join");
  const [playerReady, setPlayerReady] = useState(false);
  const [isMutedAutoplay, setIsMutedAutoplay] = useState(false);
  const [connectionState, setConnectionState] = useState<
    "connecting" | "open" | "reconnecting" | "closed"
  >("connecting");
  const [floatingReactions, setFloatingReactions] = useState<
    Array<{ id: number; emoji: string; left: number }>
  >([]);
  const [displayPosition, setDisplayPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isScrubbing, setIsScrubbing] = useState(false);
  const [scrubValue, setScrubValue] = useState(0);
  const reactionIdRef = useRef(0);
  const lastMetadataReportRef = useRef<string>("");
  const socketRef = useRef<ReconnectingSocket | null>(null);
  const playerRef = useRef<YouTubePlayer | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const lastSourceRef = useRef<string>("");
  const lastAnchorRef = useRef<string>("");
  const lastReportedTrackRef = useRef<string>("");
  const lastCorrectionAtRef = useRef<number>(0);
  const scrubbingRef = useRef(false);
  // Mirrors of state, refreshed each render. The drift loop reads from these so it
  // doesn't have to re-subscribe (and reset its interval) on every room/role/token change.
  const roomRef = useRef<RoomSnapshot | null>(null);
  const roleRef = useRef<ParticipantRole>("listener");
  const tokenRef = useRef<string | null>(null);
  roomRef.current = room;
  roleRef.current = role;
  tokenRef.current = token;

  const [clockSynced, setClockSynced] = useState(false);

  useEffect(() => {
    syncClock()
      .then(() => setClockSynced(true))
      .catch(() => setClockSynced(true)); // even on failure, unblock the apply
  }, []);

  // Once the clock offset is known, force a one-time re-snap so any video that was loaded
  // under a zero offset jumps to the corrected live position. The anchor signature itself
  // hasn't changed (startedAt/pausedAt are server-sent), so the apply effect won't notice —
  // we explicitly re-seek here.
  useEffect(() => {
    if (!clockSynced || !playerReady || !room) return;
    const player = playerRef.current;
    if (!player) return;
    try {
      player.seekTo(getLivePosition(room), true);
      lastCorrectionAtRef.current = Date.now();
    } catch {
      // Player may not be ready yet.
    }
    // Only do this once per clock-sync flip; subsequent room updates are handled by the apply effect.
  }, [clockSynced, playerReady]);

  // When the local role flips (e.g. host failover promotes us from listener to host), the
  // playlist load mode changes (host = loadPlaylist, others = loadVideoById). Reset the
  // source signature so the apply effect re-applies under the new role.
  useEffect(() => {
    lastSourceRef.current = "";
  }, [role]);

  // Smooth scrubber UI updates. Reads getCurrentTime/getDuration on a fast tick.
  // Reads are pause when the user is dragging the scrubber so their handle stays where
  // they put it.
  useEffect(() => {
    if (!playerReady) return;
    const interval = window.setInterval(() => {
      if (scrubbingRef.current) return;
      const player = playerRef.current;
      if (!player) return;
      try {
        const t = player.getCurrentTime?.() ?? 0;
        setDisplayPosition(t);
        const d = player.getDuration?.() ?? 0;
        if (d > 0) {
          setDuration((prev) => (prev !== d ? d : prev));
        }
      } catch {
        // Player not ready yet; ignore.
      }
    }, 250);
    return () => window.clearInterval(interval);
  }, [playerReady]);

  useEffect(() => {
    let cancelled = false;

    async function bootstrapRoom() {
      try {
        const response = await fetch(
          `${API_BASE_URL}/api/rooms/${roomId}?sessionId=${encodeURIComponent(sessionId)}`,
        );
        const payload = await readJsonResponse<
          | { room: RoomSnapshot; viewerRole: ParticipantRole }
          | { message: string }
        >(response);

        if (!response.ok || !payload || !("room" in payload)) {
          const message =
            payload && "message" in payload ? payload.message : "Unable to load room.";
          throw new Error(message);
        }

        if (!cancelled) {
          setRoom(payload.room);
          setRole(payload.viewerRole);
          setReplaceUrl(buildSourceUrl(payload.room));
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : "Unable to load room.");
        }
      }
    }

    bootstrapRoom();
    return () => {
      cancelled = true;
    };
  }, [roomId, sessionId]);

  useEffect(() => {
    const socket = new ReconnectingSocket({
      url: getWebSocketUrl(sessionId),
      onOpen: () => {
        socket.send({ type: "room:join", roomId, sessionId });
      },
      onStateChange: setConnectionState,
      onMessage: (payload) => {
        if (payload.type === "error") {
          setError(payload.message);
          return;
        }

        if (payload.type === "system") {
          setAutoplayNotice(payload.message);
          return;
        }

        if (payload.type === "role:granted") {
          setRoomToken(roomId, payload.token);
          setToken(payload.token);
          setRole(payload.role);
          return;
        }

        if (payload.type === "role:revoked") {
          clearRoomToken(roomId);
          setToken(null);
          setRole("listener");
          return;
        }

        if (payload.type === "reaction:broadcast") {
          pushReaction(payload.emoji);
          return;
        }

        setRoom(payload.room);
        setRole(payload.viewerRole);
        setReplaceUrl(buildSourceUrl(payload.room));
      },
    });
    socketRef.current = socket;

    return () => {
      socket.close();
      socketRef.current = null;
    };
  }, [roomId, sessionId]);

  useEffect(() => {
    let disposed = false;

    async function initPlayer() {
      if (!containerRef.current || playerRef.current) {
        return;
      }

      const YT = await loadYouTubeApi();
      if (disposed || !containerRef.current) {
        return;
      }

      playerRef.current = new YT.Player(containerRef.current, {
        width: "100%",
        height: "100%",
        playerVars: {
          controls: 0,
          rel: 0,
          modestbranding: 1,
          playsinline: 1,
          disablekb: 1,
          fs: 0,
          iv_load_policy: 3,
        },
        events: {
          onReady: () => {
            if (!disposed) setPlayerReady(true);
          },
        },
      });
    }

    initPlayer();

    return () => {
      disposed = true;
      playerRef.current?.destroy();
      playerRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!room || !playerRef.current || !playerReady) {
      return;
    }

    const player = playerRef.current;

    // Two distinct change signals:
    //   - sourceSig: video / playlist track changed -> the player needs a fresh load.
    //   - anchorSig: timeline anchor changed (play/pause/seek) -> seek + play/pause only.
    // Reloading on every status change is what was causing the "not in sync" jitter — the
    // player would snap back to startSeconds on every play/pause broadcast.
    const sourceSig = JSON.stringify([room.source, room.currentTrackIndex, room.currentVideoId]);
    const anchorSig = JSON.stringify([room.playbackStatus, room.startedAt, room.pausedAt]);

    const sourceChanged = sourceSig !== lastSourceRef.current;
    const anchorChanged = anchorSig !== lastAnchorRef.current;

    if (!sourceChanged && !anchorChanged) {
      return;
    }

    if (sourceChanged) {
      lastSourceRef.current = sourceSig;
      lastAnchorRef.current = anchorSig;

      // Skip the reload if the player is already on the target track. This avoids the
      // round-trip glitch where the host's auto-advance fires report-track, the server
      // broadcasts the new index/videoId, and the host's apply effect would otherwise
      // reload the same video the player is already playing.
      const alreadyOnTarget =
        room.source.kind === "playlist"
        && role === "host"
        && (player.getPlaylistIndex?.() ?? -1) === room.currentTrackIndex
        && player.getVideoData?.().video_id === room.currentVideoId;

      if (!alreadyOnTarget) {
        applyRoomState(player, room, role);
      }

      if (room.playbackStatus === "playing") {
        try {
          if (!hasGesture) {
            player.mute();
            setIsMutedAutoplay(true);
            setAutoplayNotice("Joined live in muted mode. Tap the player to hear audio.");
          }
          player.playVideo();
        } catch {
          setGestureVariant("resume");
          setAutoplayNotice("Your browser blocked autoplay. Tap once to start this room.");
        }
      }

      // The video load + buffering will leave us a second or two behind the live timeline.
      // Reset the correction cooldown so the drift loop can hard-seek us forward immediately
      // on its next tick, and schedule one explicit re-snap at +2s for the post-buffer state.
      lastCorrectionAtRef.current = 0;
      window.setTimeout(() => {
        const p = playerRef.current;
        const snap = roomRef.current;
        if (!p || !snap || snap.playbackStatus !== "playing") return;
        try {
          p.seekTo(getLivePosition(snap), true);
          lastCorrectionAtRef.current = Date.now();
        } catch {
          // ignore
        }
      }, 2000);
      return;
    }

    // Anchor-only change: just realign the timeline without reloading.
    lastAnchorRef.current = anchorSig;
    const livePosition = getLivePosition(room);
    try {
      player.seekTo(livePosition, true);
      if (room.playbackStatus === "playing") {
        player.playVideo();
      } else {
        player.pauseVideo();
      }
      // Reset cooldown so the drift loop can catch any post-seek buffering offset.
      lastCorrectionAtRef.current = 0;
    } catch {
      // Player may have been torn down.
    }
  }, [room, hasGesture, playerReady, role]);

  useEffect(() => {
    if (!playerReady) {
      return;
    }

    const interval = window.setInterval(() => {
      const player = playerRef.current;
      const currentRoom = roomRef.current;
      if (!player || !currentRoom) return;
      if (document.visibilityState === "hidden") return;
      if (currentRoom.playbackStatus !== "playing") return;

      const targetPosition = getLivePosition(currentRoom);
      const actualPosition = player.getCurrentTime?.() ?? 0;
      const driftSeconds = targetPosition - actualPosition;
      const msSinceLast = Date.now() - lastCorrectionAtRef.current;
      const decision = decideCorrection(driftSeconds, msSinceLast);

      if (decision.kind === "seek" && !scrubbingRef.current) {
        player.seekTo(targetPosition, true);
        lastCorrectionAtRef.current = Date.now();
      }

      const currentRole = roleRef.current;
      const currentToken = tokenRef.current;
      if (currentRole === "host" || currentRole === "admin") {
        const currentIndex = player.getPlaylistIndex?.() ?? 0;
        const videoData = player.getVideoData?.();
        const currentVideoId = videoData?.video_id ?? currentRoom.currentVideoId;
        const status = player.getPlayerState?.() === window.YT?.PlayerState.PLAYING ? "playing" : "paused";
        const position = player.getCurrentTime?.() ?? 0;
        const reportKey = `${currentIndex}:${currentVideoId}:${status}:${Math.floor(position)}`;

        if (
          currentToken &&
          currentRole === "host" &&
          currentRoom.source.kind === "playlist" &&
          reportKey !== lastReportedTrackRef.current &&
          (currentIndex !== currentRoom.currentTrackIndex || currentVideoId !== currentRoom.currentVideoId)
        ) {
          lastReportedTrackRef.current = reportKey;
          send({
            type: "playback:report-track",
            roomId,
            sessionId,
            token: currentToken,
            currentTrackIndex: currentIndex,
            currentVideoId,
            playbackStatus: status,
            position,
          });
        }

        if (
          currentToken &&
          videoData?.video_id &&
          videoData.title &&
          videoData.video_id === currentRoom.currentVideoId
        ) {
          const metaKey = `${videoData.video_id}:${videoData.title}`;
          if (metaKey !== lastMetadataReportRef.current) {
            lastMetadataReportRef.current = metaKey;
            send({
              type: "track:metadata",
              roomId,
              sessionId,
              token: currentToken,
              metadata: {
                videoId: videoData.video_id,
                title: videoData.title,
                author: videoData.author,
                thumbnailUrl: `https://i.ytimg.com/vi/${videoData.video_id}/hqdefault.jpg`,
              },
            });
          }
        }
      }
    }, 1000);

    function onVisibilityChange() {
      if (document.visibilityState !== "visible") return;
      const player = playerRef.current;
      const snapshot = roomRef.current;
      if (!player || !snapshot || snapshot.playbackStatus !== "playing") return;
      player.seekTo(getLivePosition(snapshot), true);
      lastCorrectionAtRef.current = Date.now();
    }
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [playerReady, roomId, sessionId]);

  function send(payload: ClientEvent) {
    socketRef.current?.send(payload);
  }

  function pushReaction(emoji: string) {
    const id = ++reactionIdRef.current;
    const left = 10 + Math.random() * 80;
    setFloatingReactions((current) => [...current, { id, emoji, left }]);
    window.setTimeout(() => {
      setFloatingReactions((current) => current.filter((r) => r.id !== id));
    }, 1800);
  }

  function sendReaction(emoji: string) {
    send({ type: "reaction:send", roomId, sessionId, emoji });
  }

  function acceptGesture() {
    setHasGesture(true);

    // The video may already be playing muted from the autoplay path. Just unmute and re-snap
    // to the live position; never reload (that would cause an audible glitch).
    const player = playerRef.current;
    if (player && room) {
      try {
        player.unMute();
        setIsMutedAutoplay(false);
        setAutoplayNotice("");
        const livePosition = getLivePosition(room);
        player.seekTo(livePosition, true);
        if (room.playbackStatus === "playing") {
          player.playVideo();
        }
      } catch {
        // Player not ready yet; the apply effect will resync once playerReady fires.
      }
    }
  }

  type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
  type ControlIntent = DistributiveOmit<
    Extract<ClientEvent, { token: string }>,
    "roomId" | "sessionId" | "token"
  >;
  function sendControl(payload: ControlIntent) {
    if (!token) {
      setError("You don't have permission to control this room.");
      return;
    }
    send({ ...payload, roomId, sessionId, token } as ClientEvent);
  }

  function handlePlay() {
    playerRef.current?.playVideo();
    sendControl({ type: "playback:play" });
  }

  function handlePause() {
    const pausedAt = playerRef.current?.getCurrentTime?.() ?? getLivePosition(room);
    playerRef.current?.pauseVideo();
    sendControl({ type: "playback:pause", pausedAt });
  }

  function handleSeek(deltaSeconds: number) {
    const player = playerRef.current;
    if (!player || !room) {
      return;
    }

    const nextPosition = Math.max(0, (player.getCurrentTime?.() ?? getLivePosition(room)) + deltaSeconds);
    player.seekTo(nextPosition, true);
    sendControl({ type: "playback:seek", position: nextPosition });
  }

  function handleScrubStart() {
    scrubbingRef.current = true;
    setIsScrubbing(true);
    setScrubValue(displayPosition);
  }

  function handleScrubChange(value: number) {
    setScrubValue(value);
  }

  function handleScrubCommit() {
    scrubbingRef.current = false;
    setIsScrubbing(false);
    if (role !== "host" && role !== "admin") return;
    const player = playerRef.current;
    const target = Math.max(0, scrubValue);
    if (player) {
      try {
        player.seekTo(target, true);
      } catch {
        // Player may be loading; the broadcast below will still update room state.
      }
    }
    sendControl({ type: "playback:seek", position: target });
  }

  function handleReplaceSource() {
    if (!replaceUrl.trim()) {
      return;
    }

    sendControl({ type: "playback:replace-source", url: replaceUrl.trim() });
  }

  function handleFullscreen() {
    containerRef.current?.requestFullscreen().catch(() => {
      setAutoplayNotice("Fullscreen was blocked by the browser.");
    });
  }

  const canControl = role === "host" || role === "admin";
  const roomLink = typeof window === "undefined" ? "" : window.location.href;
  const showTapOverlay = room ? (!hasGesture && (gestureVariant === "resume" || isMutedAutoplay || room.playbackStatus === "playing")) : false;
  const displayedScrubValue = isScrubbing
    ? scrubValue
    : Math.min(displayPosition, duration || displayPosition);
  const scrubberRatio = duration > 0 ? Math.min(1, displayedScrubValue / duration) : 0;

  return (
    <main className="shell room-shell">
      <section className="room-layout">
        <div className="player-panel">
          <div className="player-stage">
            <div ref={containerRef} className="player-frame" />
            <ReactionLayer reactions={floatingReactions} />
            {showTapOverlay ? (
              <TapToJoin variant={gestureVariant} onAccept={acceptGesture} />
            ) : null}
          </div>

          {room ? (
            <NowPlayingCard
              metadata={room.currentTrackMetadata}
              currentVideoId={room.currentVideoId}
            />
          ) : null}

          <ReactionDock
            onSend={sendReaction}
            disabled={connectionState !== "open" || !room}
          />

          <div className="scrubber">
            <span className="scrubber__time">
              {formatTime(isScrubbing ? scrubValue : displayPosition)}
            </span>
            <input
              type="range"
              min={0}
              max={duration || 1}
              step={0.1}
              value={displayedScrubValue}
              style={
                {
                  "--scrubber-ratio": scrubberRatio.toString(),
                } as CSSProperties
              }
              disabled={!canControl || !duration}
              onPointerDown={handleScrubStart}
              onPointerUp={handleScrubCommit}
              onKeyDown={() => {
                scrubbingRef.current = true;
                setIsScrubbing(true);
              }}
              onKeyUp={handleScrubCommit}
              onChange={(e) => handleScrubChange(Number(e.target.value))}
            />
            <span className="scrubber__time">{formatTime(duration)}</span>
          </div>

          <div className="control-strip">
            {canControl ? (
              <>
                <button onClick={() => sendControl({ type: "playback:previous" })}>Prev</button>
                <button onClick={() => handleSeek(-10)}>-10s</button>
                <button onClick={handlePlay}>Play</button>
                <button onClick={handlePause}>Pause</button>
                <button onClick={() => handleSeek(10)}>+10s</button>
                <button onClick={() => sendControl({ type: "playback:next" })}>Next</button>
              </>
            ) : null}
            <button onClick={handleFullscreen}>Fullscreen</button>
          </div>
        </div>

        <aside className="sidebar">
          <div className="sidebar-card">
            <p className="eyebrow">Room</p>
            <h2>{roomId}</h2>
            <p className="meta-line">
              {room ? `${room.memberCount} listener${room.memberCount === 1 ? "" : "s"} online` : "Loading room..."}
            </p>
            <p className="meta-line">You are: {role}</p>
            {connectionState !== "open" ? (
              <p className="meta-line">
                {connectionState === "reconnecting"
                  ? "Reconnecting…"
                  : connectionState === "connecting"
                    ? "Connecting…"
                    : "Disconnected"}
              </p>
            ) : null}
            <button
              className="ghost-button"
              onClick={() => navigator.clipboard.writeText(roomLink).catch(() => undefined)}
            >
              Copy room link
            </button>
          </div>

          {canControl ? (
            <div className="sidebar-card">
              <p className="eyebrow">Source</p>
              <label htmlFor="replace-url">Replace video or playlist</label>
              <input
                id="replace-url"
                value={replaceUrl}
                onChange={(event) => setReplaceUrl(event.target.value)}
                placeholder="Paste a YouTube URL"
              />
              <button onClick={handleReplaceSource}>Load source</button>
            </div>
          ) : null}

          {role === "host" && room ? (
            <div className="sidebar-card">
              <p className="eyebrow">Admins</p>
              <div className="participant-list">
                {room.participants
                  .filter((participant) => participant.role !== "host")
                  .map((participant) => {
                    const isAdmin = participant.role === "admin";
                    return (
                      <div className="participant-row" key={participant.sessionId}>
                        <div>
                          <strong>{participant.label}</strong>
                          <p>{participant.connected ? "Connected" : "Away"}</p>
                        </div>
                        <button
                          className="ghost-button"
                          onClick={() =>
                            sendControl({
                              type: isAdmin ? "role:revoke-admin" : "role:promote-admin",
                              targetSessionId: participant.sessionId,
                            })
                          }
                        >
                          {isAdmin ? "Revoke admin" : "Make admin"}
                        </button>
                      </div>
                    );
                  })}
              </div>
            </div>
          ) : null}

          {error ? <p className="error-text">{error}</p> : null}
          {autoplayNotice ? <p className="notice-text">{autoplayNotice}</p> : null}
        </aside>
      </section>
    </main>
  );
}

function applyRoomState(player: YouTubePlayer, snapshot: RoomSnapshot, role: ParticipantRole) {
  const livePosition = getLivePosition(snapshot);

  if (snapshot.source.kind === "video") {
    if (snapshot.playbackStatus === "playing") {
      player.loadVideoById({ videoId: snapshot.source.videoId, startSeconds: livePosition });
    } else {
      player.cueVideoById({ videoId: snapshot.source.videoId, startSeconds: livePosition });
    }
    return livePosition;
  }

  // For playlists, only the host's player navigates the playlist. Everyone else (admins
  // included) mirrors whatever single videoId the host is currently playing. This is
  // critical for YouTube "radio mix" playlists (RD-prefixed lists) whose contents are
  // personalized per viewer, and for region-locked items in regular playlists where
  // different clients would skip to different next tracks.
  if (role === "host") {
    const playlistArgs = {
      list: snapshot.source.playlistId,
      listType: "playlist" as const,
      index: snapshot.currentTrackIndex,
      startSeconds: livePosition,
    };
    if (snapshot.playbackStatus === "playing") {
      player.loadPlaylist(playlistArgs);
    } else {
      player.cuePlaylist(playlistArgs);
    }
    return livePosition;
  }

  // Non-host with a known currentVideoId: load that specific video directly. If the host
  // hasn't reported a videoId yet, fall back to the URL's initialVideoId if present.
  const videoId =
    snapshot.currentVideoId
    ?? (snapshot.source.kind === "playlist" ? snapshot.source.initialVideoId ?? null : null);
  if (videoId) {
    if (snapshot.playbackStatus === "playing") {
      player.loadVideoById({ videoId, startSeconds: livePosition });
    } else {
      player.cueVideoById({ videoId, startSeconds: livePosition });
    }
  }
  // If neither currentVideoId nor initialVideoId is known, we wait for the host's first report.

  return livePosition;
}

function getLivePosition(room: RoomSnapshot | null) {
  if (!room) {
    return 0;
  }

  if (room.playbackStatus === "paused" || room.startedAt === null) {
    return room.pausedAt;
  }

  return room.pausedAt + (getServerNow() - room.startedAt) / 1000;
}

function formatTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function buildSourceUrl(room: RoomSnapshot | null) {
  if (!room) {
    return "";
  }

  if (room.source.kind === "video") {
    return `https://www.youtube.com/watch?v=${room.source.videoId}`;
  }

  return `https://www.youtube.com/playlist?list=${room.source.playlistId}`;
}
