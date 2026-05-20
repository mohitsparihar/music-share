import type { ClientEvent } from "../shared/protocol";

export function bindEventToSocketSession(event: ClientEvent, sessionId: string): ClientEvent {
  return { ...event, sessionId } as ClientEvent;
}
