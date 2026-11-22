import { describe, expect, it } from "vitest";
import { addModule, setModuleState } from "../arrangement/operations";
import type { Arrangement } from "../arrangement/types";
import { DEFAULT_ROOM } from "../room/defaults";
import { addOpening } from "../room/operations";
import { exportArrangementJson, importArrangementJson } from "./arrangementJson";

function unwrap<T>(r: { ok: true; value: T } | { ok: false; issues: readonly unknown[] }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.value;
}

function sample(): Arrangement {
  const { room } = unwrap(addOpening(DEFAULT_ROOM, "door", "front"));
  let a: Arrangement = { room, modules: [] };
  a = unwrap(addModule(a, "cabinet")).arrangement;
  a = unwrap(addModule(a, "clickbed-o-desk")).arrangement;
  return unwrap(setModuleState(a, "module-2", "unfolded")).arrangement;
}

describe("arrangement JSON", () => {
  it("round-trips room, modules, placements, states and configurations", () => {
    const arrangement = sample();
    expect(unwrap(importArrangementJson(exportArrangementJson(arrangement)))).toEqual(arrangement);
  });

  it("stores each module configuration in its type's own versioned format", () => {
    const doc = JSON.parse(exportArrangementJson(sample()));
    expect(doc.format).toBe("multi3d-arrangement");
    expect(doc.modules[0].configuration.schemaVersion).toBe(5); // cabinet document v5
    expect(doc.modules[1].configuration.schemaVersion).toBe(1); // bed configuration v1
    expect(doc.modules[1].productReference).toMatchObject({ productId: 4184 });
  });

  it("rejects broken files without guessing", () => {
    expect(importArrangementJson("{").ok).toBe(false);
    const doc = JSON.parse(exportArrangementJson(sample()));
    expect(importArrangementJson(JSON.stringify({ ...doc, schemaVersion: 99 })).ok).toBe(false);
    const unknownType = structuredClone(doc);
    unknownType.modules[0].typeId = "sofa";
    expect(importArrangementJson(JSON.stringify(unknownType))).toMatchObject({ ok: false, issues: [{ code: "unknown_furniture_type" }] });
    const badBed = structuredClone(doc);
    badBed.modules[1].configuration.bed.decorCategory = "metal";
    badBed.modules[1].configuration.bed.frontDecor = "nope";
    expect(importArrangementJson(JSON.stringify(badBed)).ok).toBe(false);
    const duplicate = structuredClone(doc);
    duplicate.modules[1].id = duplicate.modules[0].id;
    expect(importArrangementJson(JSON.stringify(duplicate)).ok).toBe(false);
  });
});
