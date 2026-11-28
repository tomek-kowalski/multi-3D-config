import { Color } from "three";
import { materialRegistry } from "@/domain/materials";
import { cabinetFinishSelection } from "@/domain/materials/bindings";
import type { MaterialId } from "@/domain/furniture/materials";

export interface MaterialAppearance {
  readonly color: string;
  readonly roughness: number;
  /** Panel outline color: darker than light finishes, lighter than dark ones, so edges stay readable. */
  readonly edgeColor: string;
}

const cache = new Map<MaterialId, MaterialAppearance>();

/**
 * Scalar summary of a cabinet finish (colour, roughness, outline colour), resolved through the universal
 * material registry — the single source of finish appearance. Rendering itself uses the PBR factory.
 */
export function getMaterialAppearance(id: MaterialId): MaterialAppearance {
  let appearance = cache.get(id);
  if (!appearance) {
    const resolved = materialRegistry.resolve(cabinetFinishSelection(id));
    const color = resolved.source === "registry" && resolved.color.kind === "solid" ? resolved.color.srgbHex : "#808080";
    const roughness = resolved.finish?.roughness ?? 0.7;
    const edge = new Color(color);
    const { l } = edge.getHSL({ h: 0, s: 0, l: 0 });
    edge.offsetHSL(0, 0, l < 0.35 ? 0.14 : -0.22);
    appearance = { color, roughness, edgeColor: `#${edge.getHexString()}` };
    cache.set(id, appearance);
  }
  return appearance;
}
