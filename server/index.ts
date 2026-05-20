import type { ServerWebSocket } from "bun";
import type {
  CreateRoomResponse,
  ParticipantRole,
  ServerEvent,
} from "../shared/protocol";
import { parseClientEvent } from "../shared/protocol";
import { RoomManager, type RoleGrant, type RoleRevoke } from "./room-manager";
import { SqlitePersistence } from "./persistence/sqlite";
import { bindEventToSocketSession } from "./socket-session";

const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN ?? "http://localhost:5173";
const PORT = Number(process.env.PORT ?? 3001);
const DB_PATH = process.env.DB_PATH ?? "./wave-room.sqlite";
const REAP_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

const persistence = new SqlitePersistence(DB_PATH);
const reapedCount = persistence.reapStale(REAP_AFTER_MS);
if (reapedCount > 0) {
  console.log(`Reaped ${reapedCount} stale room(s).`);
}

const roomManager = new RoomManager({ persistence });
roomManager.restore(persistence.loadAll());
type RoomSocket = ServerWebSocket<{
  connectionId: string;
  sessionId: string;
  roomId: string | null;
}>;

const clients = new Map<string, RoomSocket>();

roomManager.onPendingGrants = (roomId, grants) => {
  deliverGrants(roomId, grants);
  broadcastRoom(roomId);
};

const server = Bun.serve<{
  connectionId: string;
  sessionId: string;
  roomId: string | null;
}>({
  port: PORT,
  fetch(req, server) {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") {
      return cors(req, new Response(null, { status: 204 }));
    }

    if (url.pathname === "/ws") {
      const sessionId = url.searchParams.get("sessionId");
      if (!sessionId) {
        return new Response("Missing sessionId", { status: 400 });
      }

      const connectionId = crypto.randomUUID();
      const upgraded = server.upgrade(req, {
        data: {
          connectionId,
          sessionId,
          roomId: null,
        },
      });

      if (upgraded) {
        return undefined;
      }

      return new Response("Upgrade failed", { status: 400 });
    }

    if (req.method === "POST" && url.pathname === "/api/rooms") {
      return handleCreateRoom(req);
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/rooms/")) {
      return handleGetRoom(req, url);
    }

    if (req.method === "GET" && url.pathname === "/api/time") {
      return cors(req, Response.json({ serverTimeMs: Date.now() }));
    }

    return serveStatic(url);
  },
  websocket: {
    idleTimeout: 60,
    sendPings: true,
    open(socket) {
      clients.set(socket.data.connectionId, socket);
    },
    close(socket) {
      clients.delete(socket.data.connectionId);
      const result = roomManager.disconnect(socket.data.connectionId);
      if (result) {
        broadcastRoom(result.roomId);
      }
    },
    message(socket, rawMessage) {
      try {
        let raw: unknown;
        try {
          raw = JSON.parse(String(rawMessage));
        } catch {
          send(socket, { type: "error", message: "Malformed JSON." });
          return;
        }

        const parsed = parseClientEvent(raw);
        if (!parsed.ok) {
          send(socket, { type: "error", message: parsed.error });
          return;
        }
        const event = parsed.event;
        const sessionBoundEvent = bindEventToSocketSession(event, socket.data.sessionId);

        if (sessionBoundEvent.type === "room:join") {
          const joinResult = roomManager.joinRoom({
            roomId: sessionBoundEvent.roomId,
            sessionId: sessionBoundEvent.sessionId,
            connectionId: socket.data.connectionId,
          });
          socket.data.roomId = sessionBoundEvent.roomId;
          send(socket, {
            type: "room:state",
            room: joinResult.room,
            viewerRole: joinResult.viewerRole,
          });
          broadcastRoom(sessionBoundEvent.roomId, { excludeConnectionId: socket.data.connectionId });
          return;
        }

        if (sessionBoundEvent.type === "reaction:send") {
          const reactionResult = roomManager.submitReaction({
            roomId: sessionBoundEvent.roomId,
            sessionId: sessionBoundEvent.sessionId,
            emoji: sessionBoundEvent.emoji,
          });
          if (!reactionResult.ok) {
            send(socket, { type: "error", message: reactionResult.error });
            return;
          }
          broadcastReaction(sessionBoundEvent.roomId, reactionResult.emoji, reactionResult.fromSessionId);
          return;
        }

        const result = roomManager.handleEvent(sessionBoundEvent);
        if (!result) {
          return;
        }

        if ("error" in result) {
          send(socket, { type: "error", message: result.error });
          return;
        }

        if (result.grants?.length) {
          deliverGrants(result.roomId, result.grants);
        }
        if (result.revokes?.length) {
          deliverRevokes(result.roomId, result.revokes);
        }

        broadcastRoom(result.roomId);
      } catch (error) {
        send(socket, {
          type: "error",
          message: error instanceof Error ? error.message : "Unexpected server error.",
        });
      }
    },
  },
});

console.log(`WaveRoom server listening on http://localhost:${server.port}`);

async function handleCreateRoom(req: Request) {
  try {
    const body = (await req.json()) as { url?: string; sessionId?: string };
    if (!body.url || !body.sessionId) {
      return cors(
        req,
        Response.json(
          {
            message: "Both url and sessionId are required.",
          },
          { status: 400 },
        ),
      );
    }

    const { room, hostToken } = roomManager.createRoom({
      url: body.url,
      creatorSessionId: body.sessionId,
    });

    const response: CreateRoomResponse = { room, hostToken };
    return cors(req, Response.json(response, { status: 201 }));
  } catch (error) {
    return cors(
      req,
      Response.json(
        {
          message: error instanceof Error ? error.message : "Unable to create room.",
        },
        { status: 400 },
      ),
    );
  }
}

function handleGetRoom(req: Request, url: URL) {
  const roomId = url.pathname.split("/").pop();
  if (!roomId) {
    return cors(req, Response.json({ message: "Missing room id." }, { status: 400 }));
  }

  try {
    const room = roomManager.getSnapshot(roomId);
    const sessionId = new URL(req.url).searchParams.get("sessionId") ?? "";
    const viewerRole: ParticipantRole = sessionId
      ? roomManager.getViewerRole(roomId, sessionId)
      : "listener";
    return cors(req, Response.json({ room, viewerRole }));
  } catch (error) {
    return cors(
      req,
      Response.json(
        {
          message: error instanceof Error ? error.message : "Unable to fetch room.",
        },
        { status: 404 },
      ),
    );
  }
}

async function serveStatic(url: URL) {
  const distPath = url.pathname === "/" ? "/index.html" : url.pathname;
  const file = Bun.file(`./dist${distPath}`);

  if (await file.exists()) {
    return new Response(file);
  }

  const fallback = Bun.file("./dist/index.html");
  if (await fallback.exists()) {
    return new Response(fallback);
  }

  return new Response("Not found", { status: 404 });
}

function send(socket: RoomSocket, event: ServerEvent) {
  socket.send(JSON.stringify(event));
}

function broadcastRoom(roomId: string, options: { excludeConnectionId?: string } = {}) {
  try {
    const room = roomManager.getSnapshot(roomId);
    for (const socket of clients.values()) {
      if (socket.data.roomId !== roomId) {
        continue;
      }
      if (options.excludeConnectionId && socket.data.connectionId === options.excludeConnectionId) {
        continue;
      }

      const viewerRole = roomManager.getViewerRole(roomId, socket.data.sessionId);
      send(socket, {
        type: "presence:update",
        room,
        viewerRole,
      });
    }
  } catch {
    // Ignore rooms that were never fully joined.
  }
}

function deliverGrants(roomId: string, grants: RoleGrant[]) {
  for (const grant of grants) {
    for (const socket of clients.values()) {
      if (socket.data.roomId !== roomId) continue;
      if (socket.data.sessionId !== grant.targetSessionId) continue;
      send(socket, { type: "role:granted", role: grant.role, token: grant.token });
    }
  }
}

function broadcastReaction(roomId: string, emoji: string, fromSessionId: string) {
  for (const socket of clients.values()) {
    if (socket.data.roomId !== roomId) continue;
    send(socket, { type: "reaction:broadcast", emoji, fromSessionId });
  }
}

function deliverRevokes(roomId: string, revokes: RoleRevoke[]) {
  for (const revoke of revokes) {
    for (const socket of clients.values()) {
      if (socket.data.roomId !== roomId) continue;
      if (socket.data.sessionId !== revoke.targetSessionId) continue;
      send(socket, { type: "role:revoked", role: revoke.role });
    }
  }
}

function cors(req: Request, response: Response) {
  const requestOrigin = req.headers.get("origin");
  const allowedOrigin = resolveAllowedOrigin(requestOrigin);
  const headers = new Headers(response.headers);
  if (allowedOrigin) {
    headers.set("Access-Control-Allow-Origin", allowedOrigin);
    headers.set("Vary", "Origin");
  }
  headers.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type");
  return new Response(response.body, {
    ...response,
    headers,
  });
}

function resolveAllowedOrigin(origin: string | null) {
  if (!origin) {
    return FRONTEND_ORIGIN;
  }

  if (origin === FRONTEND_ORIGIN) {
    return origin;
  }

  try {
    const url = new URL(origin);
    const isLocalhost =
      url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "::1";

    if (isLocalhost) {
      return origin;
    }
  } catch {
    return FRONTEND_ORIGIN;
  }

  return FRONTEND_ORIGIN;
}
