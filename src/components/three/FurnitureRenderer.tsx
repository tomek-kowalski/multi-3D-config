"use client";

import { useMemo } from "react";
import { buildFurniture, type FurnitureModel } from "@/domain/geometry/buildFurniture";
import type { CabinetConfiguration } from "@/domain/furniture/types";
import type { PanelPart } from "@/domain/geometry/types";
import { useConfiguratorStore } from "@/store/useConfiguratorStore";
import { CompartmentRegions } from "./CompartmentRegions";
import { HandleMesh } from "./HandleMesh";
import { MovingAssembly, type MovingGroup } from "./MovingAssembly";
import { PanelMesh } from "./PanelMesh";
import { mmToM } from "./units";

/** Static panels render directly; parts and handles sharing a motion group render as one moving assembly. */
function groupParts({ panels, hardware, motion }: FurnitureModel) {
  const staticParts: PanelPart[] = [];
  const groups = new Map<string, { group: MovingGroup; parts: PanelPart[]; handles: MovingGroup["handles"][number][] }>();
  const dependents = new Map<string, Set<string>>();
  for (const limit of motion.values()) {
    if (!limit.requiresOpen) continue;
    const set = dependents.get(limit.requiresOpen) ?? new Set<string>();
    set.add(limit.attachmentId);
    dependents.set(limit.requiresOpen, set);
  }

  const entryFor = (part: { motion?: PanelPart["motion"]; attachmentId?: string; compartmentId?: string }) => {
    const { motion: partMotion, attachmentId, compartmentId } = part;
    if (!partMotion || !attachmentId || !compartmentId) return null;
    let entry = groups.get(partMotion.groupId);
    if (!entry) {
      const parts: PanelPart[] = [];
      const handles: MovingGroup["handles"][number][] = [];
      entry = {
        parts,
        handles,
        group: {
          groupId: partMotion.groupId,
          attachmentId,
          compartmentId,
          motion: partMotion,
          parts,
          handles,
          limit: motion.get(partMotion.groupId),
          dependents: [...(dependents.get(attachmentId) ?? [])],
        },
      };
      groups.set(partMotion.groupId, entry);
    }
    return entry;
  };

  for (const part of panels) {
    const entry = entryFor(part);
    if (entry) entry.parts.push(part);
    else staticParts.push(part);
  }
  const staticHandles = [];
  for (const handle of hardware) {
    const entry = entryFor(handle);
    if (entry) entry.handles.push(handle);
    else staticHandles.push(handle);
  }
  return { staticParts, staticHandles, movingGroups: [...groups.values()].map((entry) => entry.group) };
}

/**
 * The parts of one cabinet in its own frame (origin at the lower-left-back corner, front towards +Z).
 * - `interactive`: the cabinet being edited — doors and drawers animate, compartments are clickable
 *   (both bound to the cabinet editing session's stores).
 * - otherwise: a static, closed rendering of any configuration (other cabinets in the room).
 */
export function CabinetParts({ configuration, interactive }: { configuration: CabinetConfiguration; interactive: boolean }) {
  const { staticParts, staticHandles, movingGroups } = useMemo(() => groupParts(buildFurniture(configuration)), [configuration]);
  return (
    <>
      {staticParts.map((panel) => (
        <PanelMesh key={panel.id} panel={panel} />
      ))}
      {staticHandles.map((handle) => (
        <HandleMesh key={handle.id} part={handle} />
      ))}
      {interactive
        ? movingGroups.map((group) => <MovingAssembly key={group.groupId} group={group} />)
        : movingGroups.map((group) => (
            <group key={group.groupId}>
              {group.parts.map((part) => (
                <PanelMesh key={part.id} panel={part} />
              ))}
              {group.handles.map((handle) => (
                <HandleMesh key={handle.id} part={handle} />
              ))}
            </group>
          ))}
      {interactive && <CompartmentRegions />}
    </>
  );
}

/**
 * Renders the committed configuration. Rejected user input never reaches the store's
 * configuration, so the model stays intact while the form shows errors.
 */
export function FurnitureRenderer() {
  const configuration = useConfiguratorStore((state) => state.configuration);

  return (
    // Domain origin is the lower-left-back corner and the front faces +Z; center the carcass on the floor origin.
    <group position={[-mmToM(configuration.width) / 2, 0, -mmToM(configuration.depth) / 2]}>
      <CabinetParts configuration={configuration} interactive />
    </group>
  );
}
