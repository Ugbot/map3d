import { describe, expect, it } from "vitest";
import { computeSun } from "../time/SunCalc";

describe("computeSun", () => {
  it("peaks near noon and is below horizon at midnight", () => {
    const noon = computeSun(12);
    const midnight = computeSun(0);
    expect(noon.altitude).toBeGreaterThan(0.99);
    expect(midnight.altitude).toBeLessThan(0);
  });

  it("returns finite colours at every hour", () => {
    for (let h = 0; h < 24; h += 0.25) {
      const s = computeSun(h);
      for (const c of [s.directional, s.ambientSky, s.ambientGround, s.horizon, s.zenith]) {
        expect(Number.isFinite(c.r)).toBe(true);
        expect(Number.isFinite(c.g)).toBe(true);
        expect(Number.isFinite(c.b)).toBe(true);
        expect(c.r).toBeGreaterThanOrEqual(0);
        expect(c.r).toBeLessThanOrEqual(1);
      }
    }
  });
});
