type Props = {
  variant: "join" | "resume";
  onAccept: () => void;
};

export function TapToJoin({ variant, onAccept }: Props) {
  const heading = variant === "join" ? "Tap to hear the room" : "Tap to resume playback";
  const body =
    variant === "join"
      ? "Playback is already syncing. Tap once to enable audio on this device."
      : "Playback was interrupted. Tap to catch up to the live position.";

  return (
    <button type="button" className="tap-to-join" onClick={onAccept}>
      <div>
        <p className="eyebrow">WaveRoom</p>
        <h2>{heading}</h2>
        <p className="hero-copy">{body}</p>
        <span className="tap-to-join__cta">{variant === "join" ? "Tap to enable audio" : "Tap to resume"}</span>
      </div>
    </button>
  );
}
