declare global {
  interface Window {
    YT?: typeof YT;
    onYouTubeIframeAPIReady?: () => void;
  }
}

export type YouTubePlayer = YT.Player;

let apiPromise: Promise<typeof YT> | null = null;

export function loadYouTubeApi() {
  if (window.YT?.Player) {
    return Promise.resolve(window.YT);
  }

  if (apiPromise) {
    return apiPromise;
  }

  apiPromise = new Promise<typeof YT>((resolve) => {
    const script = document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api";
    script.async = true;
    document.body.appendChild(script);

    window.onYouTubeIframeAPIReady = () => {
      resolve(window.YT!);
    };
  });

  return apiPromise;
}

// Drift correction parameters. The "nudge" tier was removed: YouTube's IFrame Player API only
// honors specific playback rates (0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2) so 0.95 / 1.05
// silently snap to 1.0 and nudging is a no-op. We rely on hard seeks above a tight threshold.
export const DRIFT_IGNORE_S = 0.4;
export const CORRECTION_COOLDOWN_MS = 1500;

// Retained for backward compatibility with tests; nudge is no longer emitted.
export const DRIFT_NUDGE_MAX_S = DRIFT_IGNORE_S;
export const NUDGE_DURATION_MS = 0;

export type CorrectionDecision =
  | { kind: "none" }
  | { kind: "seek" };

export function decideCorrection(
  driftSeconds: number,
  msSinceLastCorrection: number,
): CorrectionDecision {
  if (Math.abs(driftSeconds) < DRIFT_IGNORE_S) {
    return { kind: "none" };
  }
  if (msSinceLastCorrection < CORRECTION_COOLDOWN_MS) {
    return { kind: "none" };
  }
  return { kind: "seek" };
}
