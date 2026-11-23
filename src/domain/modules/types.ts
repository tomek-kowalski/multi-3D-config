import type { BoxMm } from "../compartments/types";
import type { Millimeters } from "../furniture/types";
import type { Issue, Result } from "../shared/issues";
import type { Placement } from "../spatial/geometry";
import type { WooLineItem } from "../commerce/types";

export type FurnitureTypeId = string;
export type ModuleId = string;
/** e.g. "closed" for static furniture, "folded" / "unfolded" for a wall bed. */
export type OperationalStateId = string;

/** Overall size of the module's footprint box, to which the placement refers. */
export interface ModuleFootprint {
  readonly width: Millimeters;
  readonly depth: Millimeters;
  readonly height: Millimeters;
}

/** How the module is identified in WooCommerce (see src/domain/commerce). */
export type ProductReference =
  | { readonly kind: "product"; readonly productId: number; readonly url?: string }
  | { readonly kind: "sku-bundle"; readonly skus: readonly string[] };

/** A labelled summary row for order review, e.g. ["size", "140 x 200"]. Labels are i18n keys. */
export interface ConfigurationSummaryRow {
  readonly labelKey: string;
  readonly value: string;
}

/**
 * The contract every furniture type implements. The room and arrangement layers only use this
 * interface, so a new furniture type is added by implementing it and registering it — without
 * touching room, arrangement, collision or ordering code.
 *
 * All boxes are in the module's local frame (see src/domain/spatial/geometry.ts), millimetres.
 */
export interface FurnitureTypeDefinition<C = unknown> {
  readonly id: FurnitureTypeId;
  /** Parametric geometry (generated from the configuration) or an imported 3D asset. */
  readonly geometrySource: "parametric" | "imported";
  /** i18n key of the type name. */
  readonly nameKey: string;
  /** Furniture category (descriptive; docking and collisions treat every category alike). */
  readonly category: "cabinet" | "bed";
  createDefault(): C;
  footprint(configuration: C): ModuleFootprint;
  /** Operational states; the first is the rest state. Static furniture has a single state. */
  states(configuration: C): readonly OperationalStateId[];
  /** Occupied volume in a state. */
  collisionBoxes(configuration: C, state: OperationalStateId): readonly BoxMm[];
  /**
   * Space swept while changing between states in normal use, or null for static furniture.
   * It is kept free of walls, openings and other furniture regardless of the displayed state.
   */
  operationEnvelope(configuration: C): readonly BoxMm[] | null;
  validate(configuration: C): readonly Issue[];
  /** JSON-safe, versioned representation of a configuration. */
  serialize(configuration: C): unknown;
  parse(data: unknown): Result<C>;
  productReference(configuration: C): ProductReference;
  /** WooCommerce line items that order this one module. */
  orderItems(configuration: C): Result<readonly WooLineItem[]>;
  /**
   * Set when the product must be fixed to a wall: its back face (local z = 0) has to stand against a
   * wall within WALL_CONTACT_TOLERANCE_MM (src/domain/arrangement/wallContact.ts). `source` names the
   * product information the requirement comes from.
   */
  readonly wallMounting?: { readonly face: "back"; readonly source: string };
  summary(configuration: C): readonly ConfigurationSummaryRow[];
}

/** One placed piece of furniture. Every instance owns its configuration; nothing is shared. */
export interface ModuleInstance<C = unknown> {
  readonly id: ModuleId;
  readonly typeId: FurnitureTypeId;
  readonly configuration: C;
  readonly placement: Placement;
  /** The state shown in the scene (and checked for collisions). */
  readonly state: OperationalStateId;
}
