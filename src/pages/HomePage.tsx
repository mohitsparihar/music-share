import { FormEvent, useState } from "react";
import { useNavigate } from "react-router-dom";
import { API_BASE_URL } from "../lib/config";
import { getSessionId } from "../lib/session";
import { setRoomToken } from "../lib/tokens";
import type { CreateRoomResponse } from "../lib/types";

export function HomePage() {
  const navigate = useNavigate();
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSubmitting(true);
    setError("");

    try {
      const response = await fetch(`${API_BASE_URL}/api/rooms`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          url,
          sessionId: getSessionId(),
        }),
      });

      const payload = (await response.json()) as CreateRoomResponse | { message: string };
      if (!response.ok || !("room" in payload)) {
        throw new Error("message" in payload ? payload.message : "Unable to create room.");
      }

      setRoomToken(payload.room.roomId, payload.hostToken);
      navigate(`/room/${payload.room.roomId}`);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Unable to create room.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <main className="shell hero-shell">
      <section className="hero-card">
        <p className="eyebrow">WaveRoom</p>
        <h1>Broadcast YouTube music in sync.</h1>
        <p className="hero-copy">
          Paste a YouTube video or playlist, create a room, and everyone on the same link hears the
          same track at the same moment.
        </p>

        <form className="create-form" onSubmit={handleSubmit}>
          <label htmlFor="youtube-url">YouTube video or playlist URL</label>
          <input
            id="youtube-url"
            name="youtube-url"
            placeholder="https://www.youtube.com/watch?v=..."
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            autoComplete="off"
          />
          <button disabled={isSubmitting}>{isSubmitting ? "Creating room..." : "Create room"}</button>
        </form>

        {error ? <p className="error-text">{error}</p> : null}
      </section>
    </main>
  );
}
