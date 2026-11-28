import {
  MATERIAL_CATEGORIES,
  TEXTURE_COLOR_SPACE,
  type AssetId,
  type BaseColor,
  type FinishProfile,
  type LegacyResolver,
  type MaterialDefinition,
  type MaterialMap,
  type MaterialRegistry,
  type MaterialSelection,
  type DecorDefinition,
  type ProfileId,
  type RegistryData,
  type ResolutionIssue,
  type SurfaceAssignment,
  type RegistryResolvedMaterial,
  type ResolvedMaterial,
  type SurfaceProfile,
  type TextureAsset,
} from "./contracts";

/** Finish shown for a manufacturer appearance without an authorized image (the unavailable indicator). */
export const UNAVAILABLE_FINISH_ID = "finish/unavailable-neutral";

/** Formats the runtime can load (three ImageLoader); KTX2 is not implemented. */
const LOADABLE_FORMATS = new Set(["jpeg", "png"]);

/** A selection that names nothing registered (a programming or data error, never a customer choice). */
export class MaterialResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MaterialResolutionError";
  }
}

const HEX = /^#[0-9a-f]{6}$/i;

export function isSrgbHex(value: unknown): value is string {
  return typeof value === "string" && HEX.test(value);
}

/** Stable key of a selection (rendering identity; equal selections give equal keys). */
export function selectionKey(selection: MaterialSelection): string {
  switch (selection.kind) {
    case "registered":
      return `r:${selection.id}`;
    case "legacy":
      return `l:${selection.namespace}:${selection.key.join("/")}`;
    case "configured-color":
      return `c:${selection.templateId}:${selection.srgbHex.toLowerCase()}`;
    case "authored": {
      const o = selection.overrides;
      if (!o) return "a:";
      return `a:${o.baseColor ? selectionKey(o.baseColor) : ""}|${o.finishProfileId ?? ""}|${o.surfaceProfileId ?? ""}`;
    }
  }
}

function hash(text: string): string {
  // FNV-1a 32-bit: a compact, deterministic revision of the registered data.
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

function mapsOf(color: BaseColor | undefined, surface: SurfaceProfile | undefined, finish: FinishProfile | undefined): MaterialMap[] {
  const maps: MaterialMap[] = [];
  if (color?.kind === "map") maps.push(color.map);
  if (surface) for (const m of Object.values(surface.maps)) if (m) maps.push(m);
  if (finish?.clearcoat?.normal) maps.push(finish.clearcoat.normal);
  if (finish?.sheen?.colorMap) maps.push(finish.sheen.colorMap);
  if (finish?.sheen?.roughnessMap) maps.push(finish.sheen.roughnessMap);
  return maps;
}

/**
 * The universal material registry: validated definitions, profiles and texture assets, and the
 * translation of every kind of selection (registered ID, existing legacy identifier, configured
 * colour, authored model material with overrides) into one resolved appearance.
 */
export function createMaterialRegistry(seed: RegistryData = {}): MaterialRegistry {
  const materials = new Map<string, MaterialDefinition>();
  const finishes = new Map<ProfileId, FinishProfile>();
  const surfaces = new Map<ProfileId, SurfaceProfile>();
  const textures = new Map<AssetId, TextureAsset>();
  const legacy = new Map<string, LegacyResolver>();
  const assignments = new Map<string, SurfaceAssignment>();
  let revision = "";

  const recomputeRevision = () => {
    const data = [
      [...materials.values()],
      [...finishes.values()],
      [...surfaces.values()],
      [...textures.values()].map((t) => [t.id, t.variants, t.statistics ?? null]),
      [...legacy.keys()],
      [...assignments.values()],
    ];
    revision = hash(JSON.stringify(data));
  };

  const getFinishProfile = (id: ProfileId) => {
    const f = finishes.get(id);
    if (!f) throw new MaterialResolutionError(`Unknown finish profile "${id}"`);
    return f;
  };
  const getSurfaceProfile = (id: ProfileId) => {
    const s = surfaces.get(id);
    if (!s) throw new MaterialResolutionError(`Unknown surface profile "${id}"`);
    return s;
  };
  const getTextureAsset = (id: AssetId) => {
    const t = textures.get(id);
    if (!t) throw new MaterialResolutionError(`Unknown texture asset "${id}"`);
    return t;
  };

  const validateMaps = (owner: string, maps: readonly MaterialMap[], issues: string[]) => {
    for (const map of maps) {
      const asset = textures.get(map.assetId);
      if (!asset) {
        issues.push(`${owner}: unknown texture asset ${map.assetId}`);
        continue;
      }
      if (asset.colorSpace !== TEXTURE_COLOR_SPACE[asset.semantic]) issues.push(`${owner}: ${asset.id} has colour space ${asset.colorSpace} for ${asset.semantic}`);
      const [w, h] = map.alignment.coverageM;
      if (!(w > 0 && h > 0)) issues.push(`${owner}: ${asset.id} needs a positive physical coverage`);
      if (map.alignment.kind === "decor-registered" && !map.alignment.phaseM.every((v) => Number.isFinite(v))) {
        issues.push(`${owner}: ${asset.id} registered map needs a finite registration phase`);
      }
      issues.push(...validateAsset(asset).map((i) => `${owner}: ${i}`));
    }
  };

  /** Loader and semantic compatibility of an asset's files. */
  const validateAsset = (asset: TextureAsset): string[] => {
    const issues: string[] = [];
    for (const [tier, variant] of Object.entries(asset.variants)) {
      if (!variant) continue;
      if (!variant.url.startsWith("/")) issues.push(`${asset.id} ${tier} URL must be a local path`);
      if (!LOADABLE_FORMATS.has(variant.format)) issues.push(`${asset.id} ${tier}: format ${variant.format} cannot be loaded (KTX2 is not implemented)`);
      // Lossy compression artefacts become false relief or gloss: data maps must be lossless.
      if (asset.colorSpace === "data" && variant.format !== "png") issues.push(`${asset.id} ${tier}: ${asset.semantic} maps must be lossless PNG, not ${variant.format}`);
      if (!(variant.width > 0 && variant.height > 0)) issues.push(`${asset.id} ${tier}: missing pixel dimensions`);
    }
    return issues;
  };

  const validate = (): string[] => {
    const issues: string[] = [];
    for (const s of surfaces.values()) {
      if (!MATERIAL_CATEGORIES.includes(s.category)) issues.push(`${s.id}: unknown category ${s.category}`);
      validateMaps(s.id, Object.values(s.maps).filter((m): m is MaterialMap => !!m), issues);
      const reg = s.sharing.kind === "decor-registered" ? s.sharing.registrationId : null;
      for (const m of Object.values(s.maps)) {
        if (!m) continue;
        if (m.alignment.kind === "decor-registered" && m.alignment.registrationId !== reg) {
          issues.push(`${s.id}: registered map ${m.assetId} must share the profile's registration`);
        }
        if (reg && m.alignment.kind !== "decor-registered") issues.push(`${s.id}: a decor-registered profile may only hold registered maps`);
        // Directional relief (grain, brushing) is only shared with evidence of the same structure.
        if (s.sharing.kind === "universal-isotropic" && m.alignment.kind === "surface-repeat" && m.alignment.directional) {
          issues.push(`${s.id}: directional map ${m.assetId} cannot be shared as universal-isotropic`);
        }
      }
    }
    for (const a of assignments.values()) {
      const profile = surfaces.get(a.surfaceProfileId);
      if (!profile) {
        issues.push(`${a.id}: unknown surface ${a.surfaceProfileId}`);
        continue;
      }
      if (Object.keys(a.match).length === 0) issues.push(`${a.id}: a surface assignment needs at least one match field`);
      if (profile.sharing.kind === "decor-registered" && profile.sharing.registrationId !== a.registrationId) {
        issues.push(`${a.id}: ${profile.id} is registered to ${profile.sharing.registrationId}, the assignment to ${a.registrationId ?? "nothing"}`);
      }
    }
    for (const f of finishes.values()) {
      for (const [name, v] of [
        ["roughness", f.roughness],
        ["metalness", f.metalness],
      ] as const) {
        if (!(v >= 0 && v <= 1)) issues.push(`${f.id}: ${name} ${v} outside 0–1`);
      }
      if (!(f.specularIntensity >= 0 && f.specularIntensity <= 1)) issues.push(`${f.id}: specularIntensity outside 0–1`);
      if (f.maxLinearAlbedo !== undefined && !(f.maxLinearAlbedo > 0 && f.maxLinearAlbedo <= 1)) issues.push(`${f.id}: maxLinearAlbedo outside (0, 1]`);
      validateMaps(f.id, mapsOf(undefined, undefined, f), issues);
    }
    for (const m of materials.values()) {
      if (!MATERIAL_CATEGORIES.includes(m.category)) issues.push(`${m.id}: unknown category ${m.category}`);
      if (!finishes.has(m.finishProfileId)) issues.push(`${m.id}: unknown finish ${m.finishProfileId}`);
      if (!surfaces.has(m.surfaceProfileId)) issues.push(`${m.id}: unknown surface ${m.surfaceProfileId}`);
      if (m.color.kind === "solid" && !isSrgbHex(m.color.srgbHex)) issues.push(`${m.id}: invalid colour ${m.color.srgbHex}`);
      if (m.color.kind === "map") {
        validateMaps(m.id, [m.color.map], issues);
        const asset = textures.get(m.color.map.assetId);
        if (m.color.calibration) {
          if (!isSrgbHex(m.color.calibration.targetSrgbHex)) issues.push(`${m.id}: invalid calibration colour ${m.color.calibration.targetSrgbHex}`);
          const mean = asset?.statistics?.meanLinearRgb;
          if (!mean || !mean.every((c) => c > 0)) issues.push(`${m.id}: calibrated colour needs the image's measured mean (${m.color.map.assetId})`);
        }
      }
      // Relief and gloss registered to a print must lie in register with this material's own print.
      const surface = surfaces.get(m.surfaceProfileId);
      if (surface?.sharing.kind === "decor-registered") {
        const albedo = m.color.kind === "map" ? m.color.map.alignment : null;
        const reg = surface.sharing.registrationId;
        if (albedo?.kind !== "decor-registered" || albedo.registrationId !== reg) {
          issues.push(`${m.id}: ${surface.id} is registered to ${reg}, the base colour is not`);
        } else {
          for (const map of Object.values(surface.maps)) {
            if (map?.alignment.kind !== "decor-registered") continue;
            const same = (a: readonly number[], b: readonly number[]) => a.every((v, i) => Math.abs(v - b[i]) < 1e-9);
            if (!same(map.alignment.coverageM, albedo.coverageM) || !same(map.alignment.phaseM, albedo.phaseM)) {
              issues.push(`${m.id}: ${map.assetId} is not in register with the base colour (coverage/phase)`);
            }
          }
        }
      }
    }
    for (const t of textures.values()) {
      const s = t.statistics;
      if (s?.meanValue !== undefined && !(s.meanValue > 0 && s.meanValue <= 1)) issues.push(`${t.id}: meanValue outside (0, 1]`);
    }
    return issues;
  };

  const register = (data: RegistryData): string[] => {
    data.textures?.forEach((t) => textures.set(t.id, t));
    data.surfaces?.forEach((s) => surfaces.set(s.id, s));
    data.finishes?.forEach((f) => finishes.set(f.id, f));
    data.materials?.forEach((m) => materials.set(m.id, m));
    data.legacy?.forEach((l) => legacy.set(l.namespace, l));
    data.surfaceAssignments?.forEach((a) => assignments.set(a.id, a));
    recomputeRevision();
    return validate();
  };

  /** A profile without maps (same id suffix, same category): nothing in it can contradict the decor. */
  const unmapped = (profile: SurfaceProfile): SurfaceProfile =>
    Object.keys(profile.maps).length === 0 ? profile : { ...profile, id: `${profile.id}#unmapped`, maps: {} };

  const specificity = (a: SurfaceAssignment) => (a.match.decorId ? 8 : 0) + (a.match.code ? 4 : 0) + (a.match.structure ? 2 : 0) + (a.match.manufacturer ? 1 : 0);

  const surfaceForDecor = (decor: DecorDefinition, fallbackProfileId: ProfileId): { surface: SurfaceProfile; issues: ResolutionIssue[] } => {
    const matches = [...assignments.values()].filter(
      (a) =>
        (a.match.decorId === undefined || a.match.decorId === decor.id) &&
        (a.match.code === undefined || a.match.code === decor.code) &&
        (a.match.structure === undefined || a.match.structure === decor.structure) &&
        (a.match.manufacturer === undefined || a.match.manufacturer === decor.manufacturer),
    );
    // Most specific first; ties broken by id so the choice is deterministic.
    matches.sort((a, b) => specificity(b) - specificity(a) || a.id.localeCompare(b.id));
    const chosen = matches[0];
    const profile = getSurfaceProfile(chosen?.surfaceProfileId ?? fallbackProfileId);
    const maps = Object.values(profile.maps).filter((m): m is MaterialMap => !!m);
    if (maps.length === 0) return { surface: profile, issues: [] };
    const albedo = decor.baseColor.kind === "map" ? decor.baseColor.map : null;
    let compatible = true;
    if (decor.baseColor.kind !== "map") compatible = false; // no authorized image: nothing to register to
    if (profile.sharing.kind === "verified-structure") {
      const sharing = profile.sharing;
      compatible &&= sharing.manufacturer === decor.manufacturer && sharing.structures.includes(decor.structure);
    }
    if (profile.sharing.kind === "decor-registered") {
      const registrationId = profile.sharing.registrationId;
      compatible &&= chosen?.registrationId === registrationId && decor.registrationId === registrationId;
      for (const m of maps) {
        if (m.alignment.kind !== "decor-registered" || !albedo) {
          compatible = false;
          continue;
        }
        const [cu, cv] = m.alignment.coverageM;
        const [au, av] = albedo.alignment.coverageM;
        const [pu, pv] = m.alignment.phaseM;
        const [du, dv] = chosen?.registrationPhaseM ?? [Number.NaN, Number.NaN];
        // In register: the same physical coverage and the same tile phase as the decor's print.
        compatible &&= Math.abs(cu - au) < 1e-6 && Math.abs(cv - av) < 1e-6 && Math.abs(pu - du) < 1e-6 && Math.abs(pv - dv) < 1e-6;
      }
    }
    // Directional relief must run with the printed grain: only where the decor's image is directional.
    const directional = maps.some((m) => m.alignment.kind === "surface-repeat" && m.alignment.directional);
    if (directional && !(albedo?.alignment.kind === "surface-repeat" && albedo.alignment.directional)) compatible = false;
    return compatible ? { surface: profile, issues: [] } : { surface: unmapped(profile), issues: ["incompatible-surface-registration"] };
  };

  /** A manufacturer appearance without an authorized image is shown neutrally (dielectric, no maps). */
  const neutralIfUnavailable = <T extends ResolvedMaterial>(resolved: T): T => {
    if (resolved.color?.kind !== "unavailable") return resolved;
    return { ...resolved, finish: getFinishProfile(UNAVAILABLE_FINISH_ID), surface: resolved.surface ? unmapped(resolved.surface) : undefined };
  };

  const fromDefinition = (def: MaterialDefinition, color: BaseColor, id: string, label: string): RegistryResolvedMaterial =>
    neutralIfUnavailable({
      source: "registry",
      id,
      label,
      category: def.category,
      color,
      surface: getSurfaceProfile(def.surfaceProfileId),
      finish: getFinishProfile(def.finishProfileId),
      availability: color.kind === "unavailable" ? "missing-authorized-swatch" : "available",
    });

  const registry: MaterialRegistry = {
    get revision() {
      return revision;
    },
    getTextureAsset,
    getFinishProfile,
    getSurfaceProfile,
    surfaceForDecor,
    register,
    validate,
    resolve(selection: MaterialSelection): ResolvedMaterial {
      switch (selection.kind) {
        case "registered": {
          const def = materials.get(selection.id);
          if (!def) throw new MaterialResolutionError(`Unknown material "${selection.id}"`);
          if (def.color.kind === "configured") throw new MaterialResolutionError(`"${def.id}" is a template: select it with a configured colour`);
          if (def.color.kind === "decor") throw new MaterialResolutionError(`"${def.id}" is a decor material: select the decor`);
          return fromDefinition(def, def.color, def.id, def.id);
        }
        case "configured-color": {
          const def = materials.get(selection.templateId);
          if (!def || def.color.kind !== "configured") throw new MaterialResolutionError(`Unknown colour template "${selection.templateId}"`);
          if (!isSrgbHex(selection.srgbHex)) throw new MaterialResolutionError(`Invalid configured colour "${selection.srgbHex}"`);
          const hex = selection.srgbHex.toUpperCase();
          return fromDefinition(def, { kind: "solid", srgbHex: hex }, `${def.id}#${hex}`, hex);
        }
        case "legacy": {
          const resolver = legacy.get(selection.namespace);
          const resolved = resolver?.resolve(selection.key, registry) ?? null;
          if (!resolved) throw new MaterialResolutionError(`Unknown ${selection.namespace} selection "${selection.key.join("/")}"`);
          return neutralIfUnavailable(resolved);
        }
        case "authored": {
          const o = selection.overrides ?? {};
          const base = o.baseColor ? registry.resolve(o.baseColor) : null;
          if (base?.color?.kind === "unavailable") {
            return neutralIfUnavailable({
              source: "authored",
              id: `authored(${selectionKey(selection)})`,
              label: base.label,
              color: base.color,
              decor: base.decor,
              availability: base.availability,
              surface: o.surfaceProfileId ? getSurfaceProfile(o.surfaceProfileId) : undefined,
            });
          }
          return {
            source: "authored",
            id: `authored(${selectionKey(selection)})`,
            label: base?.label ?? "authored",
            color: base?.color,
            decor: base?.decor,
            availability: base?.availability ?? "available",
            finish: o.finishProfileId ? getFinishProfile(o.finishProfileId) : undefined,
            surface: o.surfaceProfileId ? getSurfaceProfile(o.surfaceProfileId) : undefined,
          };
        }
      }
    },
  };
  register(seed);
  return registry;
}

/** Every texture map a resolved material references (base colour, surface and finish maps). */
export function resolvedMaps(resolved: ResolvedMaterial): MaterialMap[] {
  return mapsOf(resolved.color, resolved.surface, resolved.finish);
}
