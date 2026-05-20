import { describe, expect, test } from "bun:test";
import {
  CORRECTION_COOLDOWN_MS,
  DRIFT_IGNORE_S,
  decideCorrection,
} from "../src/lib/player";

const COLD = CORRECTION_COOLDOWN_MS + 1;

describe("decideCorrection", () => {
  test("drift below the ignore threshold returns none", () => {
    expect(decideCorrection(DRIFT_IGNORE_S - 0.01, COLD)).toEqual({ kind: "none" });
    expect(decideCorrection(-(DRIFT_IGNORE_S - 0.01), COLD)).toEqual({ kind: "none" });
  });

  test("drift above threshold triggers a hard seek (no nudge tier)", () => {
    expect(decideCorrection(DRIFT_IGNORE_S + 0.01, COLD).kind).toBe("seek");
    expect(decideCorrection(-(DRIFT_IGNORE_S + 0.01), COLD).kind).toBe("seek");
    expect(decideCorrection(5, COLD).kind).toBe("seek");
  });

  test("cooldown suppresses corrections even when drift is large", () => {
    expect(decideCorrection(5, 0).kind).toBe("none");
    expect(decideCorrection(5, CORRECTION_COOLDOWN_MS - 1).kind).toBe("none");
    expect(decideCorrection(5, COLD).kind).toBe("seek");
  });
});
