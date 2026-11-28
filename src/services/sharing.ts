import { buildOrder } from "@/domain/commerce/order";
import type { Arrangement } from "@/domain/arrangement/types";
import { isValidEmail } from "@/domain/shared/email";
import { fail, ok, type Result } from "@/domain/shared/issues";
import { arrangementKey, parseSnapshot, toSnapshotDocument, type Presentation, type Snapshot } from "@/domain/sharing/snapshot";
import { clearPhotoCache } from "@/components/three/photo/photoService";
import { currentCameraView, requestCameraView } from "@/components/three/viewCamera";
import { useArrangementStore } from "@/store/useArrangementStore";
import { usePreviewStore } from "@/store/usePreviewStore";
import { answerCode, bffRequest, type BffClient } from "./bff";
import { clearQuotationCache } from "./quotation";
import type { ShopPrice } from "./woocommerce";

/**
 * Sharing a configuration ("Udostępnij konfigurację") and opening a shared one (/c/{token}).
 *
 * A shared configuration is an immutable snapshot stored by the server; the link token is its only key.
 * Opening it loads a copy into the recipient's own working configuration (copy-on-write): their changes
 * stay in their browser, and sharing again stores a new snapshot with a new link.
 */
export interface ShareLink {
  readonly id: string;
  readonly token: string;
  readonly url: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export const SHARE_RETENTION_DAYS = 60;

/** Links created in this tab, by arrangement: sharing (or e-mailing) the same arrangement again reuses its link. */
const links = new Map<string, ShareLink>();

export function forgetShareLinks(): void {
  links.clear();
}

/** The current working configuration with its presentation (camera, open fronts, wall labels). */
export function captureSnapshot(): Snapshot {
  const state = useArrangementStore.getState();
  const presentation: { -readonly [K in keyof Presentation]: Presentation[K] } = { showWallLabels: state.showWallLabels };
  const camera = currentCameraView();
  if (camera) presentation.camera = camera;
  const open = [...usePreviewStore.getState().openAttachmentIds];
  if (state.selectedModuleId && open.length > 0) presentation.openFronts = { moduleId: state.selectedModuleId, attachmentIds: open };
  return { arrangement: state.arrangement, presentation };
}

/** Stores the snapshot on the server and returns its link (the same link for an unchanged arrangement). */
export function createShareLink(snapshot: Snapshot, backend: BffClient): Promise<Result<ShareLink>> {
  const key = arrangementKey(snapshot.arrangement);
  const existing = links.get(key);
  if (existing && new Date(existing.expiresAt).getTime() > Date.now()) return Promise.resolve(ok(existing));
  // Concurrent requests for the same arrangement share one snapshot.
  let request = pending.get(key);
  if (!request) {
    request = storeShare(key, snapshot, backend).finally(() => pending.delete(key));
    pending.set(key, request);
  }
  return request;
}

const pending = new Map<string, Promise<Result<ShareLink>>>();

async function storeShare(key: string, snapshot: Snapshot, backend: BffClient): Promise<Result<ShareLink>> {
  const answer = await bffRequest(backend, "/api/shares", { method: "POST", json: { snapshot: toSnapshotDocument(snapshot) } });
  const d = answer.data;
  if (answer.status !== 201 || !d || typeof d.url !== "string" || typeof d.token !== "string" || typeof d.id !== "string") {
    return fail({ code: answerCode(answer) });
  }
  const link: ShareLink = { id: d.id, token: d.token, url: d.url, createdAt: String(d.createdAt), expiresAt: String(d.expiresAt) };
  links.set(key, link);
  return ok(link);
}

/** Sends an existing link by e-mail (through the shop's mail system). Never creates a new snapshot. */
export async function emailShareLink(link: ShareLink, email: string, locale: string, backend: BffClient): Promise<Result<true>> {
  if (!isValidEmail(email)) return fail({ code: "invalid_email" });
  const answer = await bffRequest(backend, "/api/shares/email", { method: "POST", json: { token: link.token, email: email.trim(), locale } });
  if (answer.status === 200 && answer.data.sent === true) return ok(true);
  return fail({ code: answer.status === 502 ? "email_failed" : answerCode(answer) });
}

/** The token of a shared-configuration address (/c/{token}), or null. */
export function tokenFromPath(pathname: string): string | null {
  const match = /^\/c\/([A-Za-z0-9_-]{43})\/?$/.exec(pathname);
  return match ? match[1] : null;
}

export interface OpenedShare {
  readonly snapshot: Snapshot;
  readonly expiresAt: string;
}

/** Reads a shared configuration (validated and migrated by the server, validated again here). */
export async function openShareLink(token: string, backend: BffClient): Promise<Result<OpenedShare>> {
  const answer = await bffRequest(backend, "/api/shares/open", { method: "POST", json: { token } });
  if (answer.status !== 200) return fail({ code: answerCode(answer) });
  const snapshot = parseSnapshot(answer.data.snapshot);
  if (!snapshot.ok) return fail({ code: "snapshot_invalid" });
  return ok({ snapshot: snapshot.value, expiresAt: String(answer.data.expiresAt) });
}

/** Temporary rendering and quotation state that belongs to the previous working configuration. */
function clearTemporaryState(): void {
  clearPhotoCache();
  clearQuotationCache();
}

/** "Nowa konfiguracja": a new, independent working configuration (saved quotations and links stay on the server). */
export function startNewConfiguration(): void {
  clearTemporaryState();
  useArrangementStore.getState().startNewWorkspace();
  useArrangementStore.getState().requestView("room");
}

/** Loads a shared snapshot as a new working configuration of this tab, with its presentation. */
export function applySnapshot(snapshot: Snapshot): void {
  clearTemporaryState();
  const store = useArrangementStore.getState();
  store.loadWorkspace(snapshot.arrangement, "shared", { showWallLabels: snapshot.presentation.showWallLabels });
  const fronts = snapshot.presentation.openFronts;
  if (fronts && snapshot.arrangement.modules.some((m) => m.id === fronts.moduleId)) {
    // Selecting the cabinet binds its editing session first; then its doors and drawers open.
    store.selectModule(fronts.moduleId);
    usePreviewStore.getState().setOpen(fronts.attachmentIds, true);
  }
  if (snapshot.presentation.camera) requestCameraView(snapshot.presentation.camera);
  else store.requestView("room");
}

export type AvailabilityCheck =
  | { readonly status: "ok"; readonly total: number | null; readonly currency: string | null; readonly unavailable: readonly string[] }
  | { readonly status: "error" };

/**
 * Current WooCommerce prices and availability of a loaded configuration. Nothing is replaced: an
 * unavailable product or option is reported by its reference. The stored quotation, if any, keeps its
 * own pricing snapshot; this is information, not a binding price.
 */
export async function checkAvailability(
  arrangement: Arrangement,
  fetchPrices: (ids: number[], skus: string[]) => Promise<{ byId: ReadonlyMap<number, ShopPrice>; bySku: ReadonlyMap<string, ShopPrice> }>,
): Promise<AvailabilityCheck> {
  const order = buildOrder(arrangement);
  if (!order.ok) return { status: "ok", total: null, currency: null, unavailable: order.issues.map((i) => String(i.params?.id ?? i.code)) };
  const ids = new Set<number>();
  const skus = new Set<string>();
  for (const m of order.value.modules)
    for (const item of m.items) {
      if (item.kind === "product-options") ids.add(item.productId);
      else skus.add(item.sku);
    }
  let prices: Awaited<ReturnType<typeof fetchPrices>>;
  try {
    prices = await fetchPrices([...ids], [...skus]);
  } catch {
    return { status: "error" };
  }
  const unavailable = new Set<string>();
  let total: number | null = 0;
  let currency: string | null = null;
  for (const m of order.value.modules)
    for (const item of m.items) {
      const reference = item.kind === "product-options" ? `#${item.productId}` : item.sku;
      const price = item.kind === "product-options" ? prices.byId.get(item.productId) : prices.bySku.get(item.sku);
      if (!price || !price.inStock) {
        unavailable.add(reference);
        total = null;
        continue;
      }
      currency = price.currency;
      if (total !== null) total = Math.round((total + price.amount * item.quantity) * 100) / 100;
    }
  return { status: "ok", total: unavailable.size === 0 ? total : null, currency, unavailable: [...unavailable] };
}
