import { HDRI_URL } from "../materials/hdriSource";
import { EXTERIOR } from "./exterior";
import { BACKDROP_COLOR, PHOTO_SCENE_LIGHTING } from "./photoScene";
import { QUALITY_PRESETS } from "./photoSettings";
import { RASTER_LIGHTING, RASTER_METAL_ENVIRONMENT_INTENSITY, ROOM_PROBE_SIZE } from "./rasterBackend";

function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/**
 * Fingerprint of the photo renderers' tunable inputs: lighting, environment, backdrop, window exterior,
 * metal reflections, quality presets. Part of every photo cache key, so changing any of these values
 * invalidates completed renderings automatically. (Materials and texture assets are covered by the
 * material registry revision; changes to rendering *code* still need a RENDERER_VERSION bump.)
 */
export const RENDERING_FINGERPRINT = hash(
  JSON.stringify([HDRI_URL, BACKDROP_COLOR, PHOTO_SCENE_LIGHTING, EXTERIOR, RASTER_LIGHTING, RASTER_METAL_ENVIRONMENT_INTENSITY, ROOM_PROBE_SIZE, QUALITY_PRESETS]),
);
