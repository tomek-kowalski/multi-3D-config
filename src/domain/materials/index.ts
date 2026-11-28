import { MATERIAL_SEED } from "./bindings";
import { createMaterialRegistry } from "./registry";

/** The application's material registry (seeded with every existing finish, decor and colour role). */
export const materialRegistry = createMaterialRegistry(MATERIAL_SEED);

export * from "./contracts";
export * from "./bindings";
export { createMaterialRegistry, MaterialResolutionError, resolvedMaps, selectionKey, isSrgbHex } from "./registry";
export { resolveTextureTransform } from "./mapping";
export { pbrAssetId, pbrRegistrationId, pbrTextureAssets, type PbrSetId } from "./pbrAssets";
