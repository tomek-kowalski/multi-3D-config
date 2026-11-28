import { MeshStandardMaterial, type BufferGeometry, type Material, type Object3D } from "three";
import type { MaterialRegistry, MaterialQualityProfile, MeshMaterialBinding, RendererCapabilities, ResolvedMaterial, SlotId } from "@/domain/materials/contracts";
import { selectionKey } from "@/domain/materials/registry";
import { createPbrMaterial } from "./createPbrMaterial";
import type { MaterialInstance, MaterialIssue, PbrMaterialFactory, TextureResources } from "./runtimeContracts";

/**
 * Geometry ↔ material binding (architecture §4). A mesh supplies stable slot names, a selection per
 * slot, a physical mapping for textured surfaces and, for multi-material meshes, which material index
 * each geometry group uses. The binding is stored on the mesh (userData.materialBinding), so the photo
 * snapshot rebuilds exactly the same appearance — per group — from the same frozen selections.
 */

export interface MaterialRuntime {
  readonly registry: MaterialRegistry;
  readonly capabilities: RendererCapabilities;
  readonly quality: MaterialQualityProfile;
  readonly textures: TextureResources;
  readonly factory?: PbrMaterialFactory;
}

/** What a mesh carries for the photo renderer: its binding and the authored materials it overrides. */
export interface FrozenMaterialBinding {
  readonly binding: MeshMaterialBinding;
  /** Authored (imported model) material per slot, for "authored" selections. Immutable source data. */
  readonly authored: Readonly<Record<SlotId, Material | null>>;
}

export class InvalidBindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidBindingError";
  }
}

/** Every problem of a binding against its geometry (empty when valid). */
export function validateBinding(binding: MeshMaterialBinding, geometry?: BufferGeometry | null): string[] {
  const issues: string[] = [];
  const slots = new Set<SlotId>();
  if (binding.slots.length === 0) issues.push("no slots");
  for (const s of binding.slots) {
    if (slots.has(s.slotId)) issues.push(`duplicate slot ${s.slotId}`);
    slots.add(s.slotId);
  }
  const indices = new Set<number>();
  for (const g of binding.groups) {
    if (!slots.has(g.slotId)) issues.push(`group ${g.materialIndex} uses missing slot ${g.slotId}`);
    if (!Number.isInteger(g.materialIndex) || g.materialIndex < 0) issues.push(`invalid material index ${g.materialIndex}`);
    if (indices.has(g.materialIndex)) issues.push(`material index ${g.materialIndex} bound twice`);
    indices.add(g.materialIndex);
  }
  const count = binding.groups.length > 0 ? Math.max(...binding.groups.map((g) => g.materialIndex)) + 1 : 1;
  for (let i = 0; i < count; i++) if (binding.groups.length > 0 && !indices.has(i)) issues.push(`material index ${i} unbound`);
  if (geometry && binding.groups.length > 0) {
    for (const group of geometry.groups) {
      if ((group.materialIndex ?? 0) >= count) issues.push(`geometry group uses material index ${group.materialIndex} beyond ${count - 1}`);
    }
  }
  return issues;
}

export function bindingKey(binding: MeshMaterialBinding): string {
  return JSON.stringify([
    binding.slots.map((s) => [s.slotId, selectionKey(s.selection), s.side, s.mapping ?? null]),
    binding.groups.map((g) => [g.materialIndex, g.slotId]),
  ]);
}

export interface SlotMaterialSet {
  /** Ordered material array (index = geometry group materialIndex); one entry for single-material meshes. */
  readonly materials: readonly MeshStandardMaterial[];
  readonly bySlot: ReadonlyMap<SlotId, MaterialInstance>;
  readonly resolved: ReadonlyMap<SlotId, ResolvedMaterial>;
  readonly ready: Promise<void>;
  issues(): MaterialIssue[];
  dispose(): void;
}

const isDevelopment = () => typeof process !== "undefined" && process.env.NODE_ENV !== "production";

/** Visible placeholder for a binding that cannot be resolved (production only; development throws). */
function diagnosticPlaceholder(): MaterialInstance {
  const material = new MeshStandardMaterial({ color: "#FF00FF", roughness: 1 });
  material.name = "invalid-binding";
  const resolved: ResolvedMaterial = { source: "authored", id: "invalid-binding", label: "invalid binding", availability: "available" };
  return { material, issues: ["invalid-binding"], ready: Promise.resolve(), resolved, dispose: () => material.dispose() };
}

/** Builds one material per slot through the shared factory and orders them by material index. */
export function createSlotMaterials(binding: MeshMaterialBinding, runtime: MaterialRuntime, authored: Readonly<Record<SlotId, Material | null>> = {}): SlotMaterialSet {
  const problems = validateBinding(binding);
  if (problems.length > 0) {
    if (isDevelopment()) throw new InvalidBindingError(problems.join("; "));
    console.error("Invalid material binding:", problems);
  }
  const factory = runtime.factory ?? { create: createPbrMaterial };
  const bySlot = new Map<SlotId, MaterialInstance>();
  const resolvedBySlot = new Map<SlotId, ResolvedMaterial>();
  for (const slot of binding.slots) {
    let instance: MaterialInstance;
    try {
      const resolved = runtime.registry.resolve(slot.selection);
      resolvedBySlot.set(slot.slotId, resolved);
      instance = factory.create({
        resolved,
        side: slot.side,
        mapping: slot.mapping,
        capabilities: runtime.capabilities,
        quality: runtime.quality,
        textures: runtime.textures,
        registry: runtime.registry,
        authored: authored[slot.slotId] ?? null,
      });
    } catch (error) {
      if (isDevelopment()) throw error;
      console.error(`Material slot "${slot.slotId}" could not be resolved:`, error);
      instance = diagnosticPlaceholder();
    }
    bySlot.set(slot.slotId, instance);
  }
  let placeholder: MaterialInstance | null = null;
  const pick = (slotId: SlotId | undefined) => (slotId !== undefined ? bySlot.get(slotId)?.material : undefined) ?? (placeholder ??= diagnosticPlaceholder()).material;
  const materials =
    binding.groups.length === 0
      ? [pick(binding.slots[0]?.slotId)]
      : [...binding.groups].sort((a, b) => a.materialIndex - b.materialIndex).map((g) => pick(g.slotId));
  return {
    materials,
    bySlot,
    resolved: resolvedBySlot,
    ready: Promise.all([...bySlot.values()].map((i) => i.ready)).then(() => undefined),
    issues: () => [...new Set([...bySlot.values()].flatMap((i) => i.issues))],
    dispose() {
      bySlot.forEach((i) => i.dispose());
      placeholder?.dispose();
    },
  };
}

/**
 * Bindings by mesh. Kept outside userData: R3F reassigns userData props on re-render, and the binding
 * must survive that for as long as the installed materials do.
 */
const BINDINGS = new WeakMap<Object3D, FrozenMaterialBinding>();

/** Records the binding of a mesh (read by the photo snapshot). */
export function attachMaterialBinding(object: Object3D, frozen: FrozenMaterialBinding): void {
  BINDINGS.set(object, frozen);
}

export function detachMaterialBinding(object: Object3D, frozen?: FrozenMaterialBinding): void {
  if (!frozen || BINDINGS.get(object) === frozen) BINDINGS.delete(object);
}

export function readMaterialBinding(object: Object3D): FrozenMaterialBinding | null {
  return BINDINGS.get(object) ?? null;
}

/** Installs the set's materials on a mesh: a single material, or the ordered array for its groups. */
export function installMaterials(mesh: { material: Material | Material[] }, set: SlotMaterialSet, binding: MeshMaterialBinding): void {
  mesh.material = binding.groups.length === 0 ? set.materials[0] : [...set.materials];
}
