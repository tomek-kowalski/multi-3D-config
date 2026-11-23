import { describe, expect, it } from "vitest";
import { SHOW_GEOMETRY_DEBUG, showKeepFreeVolume, technicalOverlays } from "./debug";

describe("technical geometry overlays", () => {
  it("are off for customers: selecting, colliding or opening a module draws no technical volumes", () => {
    expect(SHOW_GEOMETRY_DEBUG).toBe(false);
    for (const selected of [true, false])
      for (const colliding of [true, false])
        expect(technicalOverlays(selected, colliding)).toEqual({ selection: false, collision: false, envelope: false });
    expect(showKeepFreeVolume(true)).toBe(false);
  });

  it("can be shown by developers when explicitly enabled", () => {
    expect(technicalOverlays(true, false, true)).toEqual({ selection: true, collision: false, envelope: true });
    expect(technicalOverlays(false, true, true)).toEqual({ selection: false, collision: true, envelope: false });
    expect(showKeepFreeVolume(true, true)).toBe(true);
    expect(showKeepFreeVolume(false, true)).toBe(false);
  });
});
