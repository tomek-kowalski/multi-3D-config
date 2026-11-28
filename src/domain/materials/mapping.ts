import type { MapAlignment, MappingSpec, MeterPair } from "./contracts";

export interface TextureTransform {
  readonly repeat: MeterPair;
  readonly offset: MeterPair;
  readonly rotationRad: number;
}

/**
 * Physical mapping → sampler transform. The geometry states how its UV0 relates to the surface (the
 * slot binding's MappingSpec); the map states how much surface one image covers (its alignment's
 * measured coverage). Together they give the repeat that keeps the image at its physical size, so a
 * resized part shows more of the pattern instead of a stretched one. Grain direction and origin live
 * in UV0 (physicalUv.ts), so the transform has no rotation and every material sharing an image can
 * share one canonical transform (one texture object, one path-tracer layer).
 *
 * Returns null when the mapping cannot place a physical map (no mapping, or normalized UVs without a
 * known physical span): the caller omits that map and reports "unsupported-map-alignment".
 */
export function resolveTextureTransform(mapping: MappingSpec | undefined, alignment: MapAlignment): TextureTransform | null {
  if (!mapping) return null;
  const [cu, cv] = alignment.coverageM;
  if (!(cu > 0 && cv > 0)) return null;
  if (mapping.kind === "projected-metres" || mapping.kind === "part-metres" || mapping.uvUnits === "metres") {
    return { repeat: [1 / cu, 1 / cv], offset: [0, 0], rotationRad: 0 };
  }
  if (!mapping.coverageM) return null;
  const [su, sv] = mapping.coverageM;
  if (!(su > 0 && sv > 0)) return null;
  return { repeat: [su / cu, sv / cv], offset: [0, 0], rotationRad: 0 };
}
