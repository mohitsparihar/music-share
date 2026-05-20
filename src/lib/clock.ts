import { API_BASE_URL } from "./config";

type Sample = { offsetMs: number; rttMs: number };

let bestSample: Sample | null = null;
let lastSyncAt = 0;

const RESYNC_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_SAMPLES = 5;
const SAMPLE_GAP_MS = 150;

export async function syncClock(samples = DEFAULT_SAMPLES): Promise<Sample> {
  let best: Sample | null = null;

  for (let i = 0; i < samples; i++) {
    try {
      const sample = await collectSample();
      if (!best || sample.rttMs < best.rttMs) {
        best = sample;
      }
    } catch {
      // Drop bad samples — keep going.
    }
    if (i < samples - 1) {
      await delay(SAMPLE_GAP_MS);
    }
  }

  if (!best) {
    // Couldn't reach the server. Fall back to no offset.
    best = { offsetMs: 0, rttMs: Number.POSITIVE_INFINITY };
  }

  bestSample = best;
  lastSyncAt = Date.now();
  return best;
}

export function getServerNow(): number {
  return Date.now() + (bestSample?.offsetMs ?? 0);
}

export function getOffsetMs(): number {
  return bestSample?.offsetMs ?? 0;
}

export function shouldResync(now = Date.now()): boolean {
  return !bestSample || now - lastSyncAt > RESYNC_INTERVAL_MS;
}

async function collectSample(): Promise<Sample> {
  const t0 = Date.now();
  const response = await fetch(`${API_BASE_URL}/api/time`);
  const t2 = Date.now();
  if (!response.ok) {
    throw new Error("time sync failed");
  }
  const body = (await response.json()) as { serverTimeMs: number };
  const t1 = body.serverTimeMs;
  const rttMs = t2 - t0;
  const offsetMs = t1 - (t0 + t2) / 2;
  return { offsetMs, rttMs };
}

function delay(ms: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, ms));
}
