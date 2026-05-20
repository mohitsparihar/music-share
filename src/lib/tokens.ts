const PREFIX = "wave-room:token:";

export function getRoomToken(roomId: string): string | null {
  return window.localStorage.getItem(PREFIX + roomId);
}

export function setRoomToken(roomId: string, token: string) {
  window.localStorage.setItem(PREFIX + roomId, token);
}

export function clearRoomToken(roomId: string) {
  window.localStorage.removeItem(PREFIX + roomId);
}
