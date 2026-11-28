import { describe, expect, it } from "vitest";
import { addModule, setPlacement } from "@/domain/arrangement/operations";
import type { Arrangement } from "@/domain/arrangement/types";
import { buildOrder } from "@/domain/commerce/order";
import { DEFAULT_ROOM } from "@/domain/room/defaults";
import { addOpening } from "@/domain/room/operations";
import { toArrangementDocument } from "@/domain/serialization/arrangementJson";
import { arrangementKey, parseSnapshot, parseSnapshotJson, snapshotJson, toSnapshotDocument, SNAPSHOT_FORMAT } from "./snapshot";

function arrangement(): Arrangement {
  const opening = addOpening({ ...DEFAULT_ROOM, width: 5200 }, "window", "back");
  if (!opening.ok) throw new Error();
  let a: Arrangement = { room: { ...opening.value.room, openings: opening.value.room.openings.map((o) => ({ ...o, open: true })) }, modules: [] };
  for (const type of ["cabinet", "clickbed-o"]) {
    const r = addModule(a, type);
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    a = r.value.arrangement;
  }
  const moved = setPlacement(a, a.modules[1].id, { rotationDeg: 90 });
  return moved.ok ? moved.value.arrangement : a;
}

describe("configuration snapshot", () => {
  it("round-trips the complete arrangement and its presentation", () => {
    const a = arrangement();
    const presentation = { camera: { position: [4.5, 3.25, 6] as const, target: [2, 0.5, 1.5] as const }, showWallLabels: false };
    const parsed = parseSnapshotJson(snapshotJson({ arrangement: a, presentation }));
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
    expect(arrangementKey(parsed.value.arrangement)).toBe(arrangementKey(a));
    expect(parsed.value.arrangement.room.openings[0].open).toBe(true);
    expect(parsed.value.arrangement.modules[1].placement.rotationDeg).toBe(90);
    expect(parsed.value.presentation).toEqual(presentation);
  });

  it("is deterministic (same configuration, same JSON)", () => {
    const a = arrangement();
    expect(snapshotJson({ arrangement: a, presentation: {} })).toBe(snapshotJson({ arrangement: a, presentation: {} }));
  });

  it("migrates a bare arrangement document and an order payload", () => {
    const a = arrangement();
    const fromDocument = parseSnapshot(toArrangementDocument(a));
    const order = buildOrder(a);
    if (!order.ok) throw new Error();
    const fromOrder = parseSnapshot(JSON.parse(JSON.stringify(order.value)));
    expect(fromDocument.ok && arrangementKey(fromDocument.value.arrangement)).toBe(arrangementKey(a));
    expect(fromOrder.ok && arrangementKey(fromOrder.value.arrangement)).toBe(arrangementKey(a));
  });

  it("keeps only known fields: nothing personal or private survives canonicalization", () => {
    const a = arrangement();
    const doc = JSON.parse(snapshotJson({ arrangement: a, presentation: {} }));
    doc.email = "klient@example.pl";
    doc.cart = [{ sku: "X" }];
    doc.presentation = { camera: { position: [1, 2, 3], target: [0, 0, 0] }, session: "secret", price: 100 };
    doc.arrangement.customerName = "Jan";
    const parsed = parseSnapshot(doc);
    if (!parsed.ok) throw new Error();
    const json = snapshotJson(parsed.value);
    expect(json).not.toMatch(/klient@|secret|customerName|"cart"|"price"/);
    expect(JSON.parse(json).format).toBe(SNAPSHOT_FORMAT);
  });

  it("drops open fronts of unknown modules and invalid camera values", () => {
    const a = arrangement();
    const doc = toSnapshotDocument({ arrangement: a, presentation: {} });
    const parsed = parseSnapshot({
      ...doc,
      presentation: { camera: { position: [1, "x", 3], target: [0, 0, 0] }, openFronts: { moduleId: "nope", attachmentIds: ["a"] } },
    });
    expect(parsed.ok && parsed.value.presentation).toEqual({});
    const kept = parseSnapshot({ ...doc, presentation: { openFronts: { moduleId: a.modules[0].id, attachmentIds: ["door-2", "door-1", "door-1"] } } });
    expect(kept.ok && kept.value.presentation.openFronts).toEqual({ moduleId: a.modules[0].id, attachmentIds: ["door-1", "door-2"] });
  });

  it("rejects invalid, unsupported and oversized snapshots", () => {
    expect(parseSnapshotJson("{")).toMatchObject({ ok: false, issues: [{ code: "invalid_json" }] });
    expect(parseSnapshot({ format: "something" })).toMatchObject({ ok: false });
    expect(parseSnapshot({ format: SNAPSHOT_FORMAT, schemaVersion: 99, arrangement: {} })).toMatchObject({ ok: false, issues: [{ code: "unsupported_version" }] });
    const doc = toSnapshotDocument({ arrangement: arrangement(), presentation: {} });
    expect(parseSnapshot({ ...doc, arrangement: { ...doc.arrangement, room: { ...doc.arrangement.room, width: -5 } } }).ok).toBe(false);
    expect(parseSnapshotJson(" ".repeat(600_000))).toMatchObject({ ok: false, issues: [{ code: "snapshot_too_large" }] });
  });
});
