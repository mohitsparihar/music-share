// In dev, the Vite server (5173) talks to the Bun API server (3001), so set
// VITE_API_BASE_URL=http://localhost:3001 in .env.local. In prod, the Bun server serves the
// built SPA from the same origin, so we can omit the env var and use the current location.
function resolveApiBaseUrl(): string {
  const explicit = import.meta.env.VITE_API_BASE_URL;
  if (explicit) return explicit;
  if (typeof window !== "undefined") {
    if (window.location.port === "5173") {
      return `${window.location.protocol}//${window.location.hostname}:3001`;
    }
    return window.location.origin;
  }
  return "http://localhost:3001";
}

export const API_BASE_URL = resolveApiBaseUrl();

export function getWebSocketUrl(sessionId: string) {
  const apiUrl = new URL(API_BASE_URL);
  apiUrl.protocol = apiUrl.protocol === "https:" ? "wss:" : "ws:";
  apiUrl.pathname = "/ws";
  apiUrl.searchParams.set("sessionId", sessionId);
  return apiUrl.toString();
}
