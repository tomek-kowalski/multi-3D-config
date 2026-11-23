import { DataTexture, DataUtils, FloatType, HalfFloatType, RGBAFormat } from "three";
import { describe, expect, it } from "vitest";
import { environmentTint, RASTER_LIGHTING } from "./rasterBackend";

/** An equirectangular environment: `sky` colour in the upper half, `ground` in the lower half. */
function equirect(sky: [number, number, number], ground: [number, number, number], half = false) {
  const width = 32;
  const height = 16;
  const data = half ? new Uint16Array(width * height * 4) : new Float32Array(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const c = y < height / 2 ? sky : ground;
      for (let k = 0; k < 3; k++) data[(y * width + x) * 4 + k] = half ? DataUtils.toHalfFloat(c[k]) : c[k];
      data[(y * width + x) * 4 + 3] = half ? DataUtils.toHalfFloat(1) : 1;
    }
  return new DataTexture(data, width, height, RGBAFormat, half ? HalfFloatType : FloatType);
}

describe("fast renderer lighting", () => {
  it("takes the daylight colour from the HDRI's sky (normalized, ground ignored)", () => {
    const warm = environmentTint(equirect([4, 3, 2], [0, 0, 1]));
    expect(warm.r).toBeGreaterThan(warm.g);
    expect(warm.g).toBeGreaterThan(warm.b);
    expect(0.2126 * warm.r + 0.7152 * warm.g + 0.0722 * warm.b).toBeCloseTo(1, 5);
    // Half-float HDRIs (HDRLoader's default) give the same colour.
    const fromHalf = environmentTint(equirect([4, 3, 2], [0, 0, 1], true));
    expect(fromHalf.r).toBeCloseTo(warm.r, 2);
    expect(fromHalf.b).toBeCloseTo(warm.b, 2);
  });

  it("is neutral for a grey sky and for missing data", () => {
    const grey = environmentTint(equirect([2, 2, 2], [9, 0, 0]));
    expect([grey.r, grey.g, grey.b].map((v) => +v.toFixed(5))).toEqual([1, 1, 1]);
    expect(environmentTint(new DataTexture(null, 0, 0)).getHexString()).toBe("ffffff");
  });

  it("keeps the calibrated light balance (unshadowed fill well below the shadowed light, see RASTER_LIGHTING)", () => {
    expect(RASTER_LIGHTING).toEqual({ environmentIntensity: 0.35, bounceIntensity: 0.6, keyIntensity: 2.3, skyIntensity: 2.1 });
  });
});
