"use client";

import type { ReactNode } from "react";
import type { BedConfiguration } from "@/domain/beds/bedType";
import { BED_PRODUCTS } from "@/domain/beds/catalog";
import { CABINET_TYPE_ID } from "@/domain/modules/cabinetType";
import type { CabinetConfiguration } from "@/domain/furniture/types";
import type { FurnitureTypeId, ModuleInstance } from "@/domain/modules/types";
import { CabinetParts } from "../FurnitureRenderer";
import { BedModel } from "./BedModel";

/**
 * 3D view per furniture type, drawn in the module's local frame (origin at the footprint's
 * back-left-bottom corner, front towards +Z). `editing`: this module is open in the configuration menu.
 */
export type ModuleRenderer = (props: { module: ModuleInstance; editing: boolean }) => ReactNode;

const RENDERERS = new Map<FurnitureTypeId, ModuleRenderer>([
  [
    CABINET_TYPE_ID,
    ({ module, editing }) => <CabinetParts configuration={module.configuration as CabinetConfiguration} interactive={editing} />,
  ],
  ...BED_PRODUCTS.map(
    (product) =>
      [
        product.typeId,
        ({ module }: { module: ModuleInstance }) => (
          <BedModel typeId={product.typeId} productId={product.productId} configuration={module.configuration as BedConfiguration} state={module.state} />
        ),
      ] as const,
  ),
]);

export function getModuleRenderer(typeId: FurnitureTypeId): ModuleRenderer {
  const renderer = RENDERERS.get(typeId);
  if (!renderer) throw new Error(`No 3D renderer registered for "${typeId}"`);
  return renderer;
}
