const STORAGE_KEY = "wave-room-session-id";

export function getSessionId() {
  const existing = window.localStorage.getItem(STORAGE_KEY);
  if (existing) {
    return existing;
  }

  const sessionId = crypto.randomUUID();
  window.localStorage.setItem(STORAGE_KEY, sessionId);
  return sessionId;
}
