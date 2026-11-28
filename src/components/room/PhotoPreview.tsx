"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { PhotoRenderError, type PhotoProgress, type RenderedPhoto } from "@/components/three/photo/photoEngine";
import { getPhotoRenderer } from "@/components/three/photo/photoService";
import { PHOTO_QUALITIES, type PhotoQualityRequest } from "@/components/three/photo/photoSettings";
import { useT } from "@/i18n";
import { downloadBlob } from "@/services/download";
import { buttonClass, primaryButtonClass, Segmented } from "@/components/ui/fields";

type State =
  | { kind: "rendering"; progress: PhotoProgress | null; preview: string | null }
  | { kind: "done"; photo: RenderedPhoto; url: string }
  | { kind: "error"; code: string };

/** File name of a downloaded photo: wizualizacja-YYYYMMDD-HHMM.png (local time). */
export function photoFileName(date: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `wizualizacja-${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}.png`;
}

/**
 * "Renderuj obraz": renders the current configuration with the photorealistic pipeline and shows the
 * result. While rendering: progress and Cancel. Done: the image, how it was made (path traced with N
 * samples, or the clearly labelled raster preview), "Pobierz PNG", "Renderuj ponownie", "Zamknij".
 * The interactive view stays usable and unchanged; closing the dialog cancels a running render.
 */
export function PhotoPreview({ onClose }: { onClose: () => void }) {
  const t = useT();
  const [quality, setQuality] = useState<PhotoQualityRequest>("auto");
  const [state, setState] = useState<State>({ kind: "rendering", progress: null, preview: null });
  const controller = useRef<AbortController | null>(null);
  const url = useRef<string | null>(null);
  const previewUrl = useRef<string | null>(null);
  const open = useRef(true);

  const release = () => {
    if (url.current) URL.revokeObjectURL(url.current);
    url.current = null;
  };
  const releasePreview = () => {
    if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
    previewUrl.current = null;
  };

  const render = useCallback(
    async (reuse: boolean, q: PhotoQualityRequest) => {
      controller.current?.abort();
      const abort = new AbortController();
      controller.current = abort;
      releasePreview();
      setState({ kind: "rendering", progress: null, preview: null });
      const renderer = getPhotoRenderer();
      if (!renderer) {
        setState({ kind: "error", code: "no_renderer" });
        return;
      }
      const showPreview = (image: Blob) => {
        if (abort.signal.aborted) return;
        releasePreview();
        const next = URL.createObjectURL(image);
        previewUrl.current = next;
        setState((s) => (s.kind === "rendering" ? { ...s, preview: next } : s));
      };
      const finish = (photo: RenderedPhoto) => {
        if (!open.current) return;
        release();
        releasePreview();
        url.current = URL.createObjectURL(photo.blob);
        setState({ kind: "done", photo, url: url.current });
      };
      const request = (quality: PhotoQualityRequest, again: boolean) =>
        renderer({
          count: 1,
          settings: { quality },
          reuse: !again,
          signal: abort.signal,
          onProgress: (progress) => {
            if (!abort.signal.aborted) setState((s) => ({ kind: "rendering", progress, preview: s.kind === "rendering" ? s.preview : null }));
          },
          onPreview: (_view, image) => showPreview(image),
        });
      // 1. The fast photorealistic image first (seconds): the customer sees a useful result right away.
      let fast: RenderedPhoto | null = null;
      try {
        [fast] = await request("fast", !reuse && q === "fast");
        if (abort.signal.aborted) return;
        if (q === "fast") return finish(fast);
        showPreview(fast.blob);
        // 2. Path tracing (or "auto" on a fast GPU) refines it; on a slow GPU "auto" is the fast image (cached).
        const [photo] = await request(q, !reuse);
        if (abort.signal.aborted) return;
        finish(photo);
      } catch (error) {
        if (controller.current !== abort && !abort.signal.aborted) return; // superseded by a newer render
        const code = error instanceof PhotoRenderError ? error.code : "failed";
        // Path tracing cancelled or failed: the finished fast image stays available.
        if (fast) return finish(fast);
        if (controller.current === abort) setState({ kind: "error", code });
      }
    },
    [],
  );

  useEffect(() => {
    // Start once when opened, after the dialog has been painted.
    open.current = true;
    const timer = setTimeout(() => void render(true, "auto"), 0);
    return () => {
      open.current = false;
      clearTimeout(timer);
      controller.current?.abort();
      release();
      releasePreview();
    };
  }, [render]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const rendering = state.kind === "rendering";
  const progress = state.kind === "rendering" ? state.progress : null;
  const preview = state.kind === "rendering" ? state.preview : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-stone-950/50 p-4" data-photo-preview>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="photo-preview-title"
        className="flex max-h-[calc(100dvh-2rem)] w-[min(64rem,100%)] flex-col overflow-hidden rounded-2xl bg-white shadow-2xl"
      >
        <div className="flex items-center justify-between gap-3 border-b border-stone-200 px-5 py-3">
          <h2 id="photo-preview-title" className="text-base font-semibold text-stone-900">
            {t("photo.title")}
          </h2>
          <button type="button" className={`${buttonClass} px-3 py-1.5 text-xs`} onClick={onClose}>
            ✕ {t("photo.close")}
          </button>
        </div>

        <div className="space-y-4 overflow-y-auto px-5 py-4">
          <div className="relative aspect-video w-full overflow-hidden rounded-xl bg-stone-100">
            {state.kind === "done" && (
              // eslint-disable-next-line @next/next/no-img-element -- a local blob URL, not an optimizable asset
              <img src={state.url} alt={t("photo.alt")} className="h-full w-full object-contain" data-photo-image />
            )}
            {preview && (
              // The image so far (still converging); replaced by the final image when done.
              // eslint-disable-next-line @next/next/no-img-element -- a local blob URL, not an optimizable asset
              <img src={preview} alt="" className="h-full w-full object-contain" data-photo-progressive />
            )}
            {rendering && (
              <div
                className={`absolute flex flex-col items-center justify-center gap-3 p-6 text-center ${
                  preview ? "inset-x-0 bottom-0 bg-white/85 py-3 backdrop-blur" : "inset-0"
                }`}
              >
                <p role="status" className="text-sm text-stone-700" data-photo-status>
                  {progress === null || progress.phase === "preparing"
                    ? t("photo.preparing")
                    : progress.phase === "compiling"
                      ? t("photo.compiling")
                      : progress.mode === "pathtraced"
                      ? t("photo.progressPathtraced", { samples: Math.floor(progress.samples), target: progress.targetSamples })
                      : t("photo.progressRaster", { frames: Math.floor(progress.samples), target: progress.targetSamples })}
                </p>
                <progress className="h-2 w-2/3" max={1} value={progress?.fraction ?? 0} aria-label={t("photo.progress")} />
                <p className="text-xs text-stone-500">{Math.round((progress?.fraction ?? 0) * 100)}%</p>
              </div>
            )}
            {state.kind === "error" && (
              <div role="alert" className="absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-red-800">
                {t(`photo.error.${state.code}` as Parameters<typeof t>[0])}
              </div>
            )}
          </div>

          {state.kind === "done" && <PhotoBadge photo={state.photo} />}
          {state.kind === "done" && <AppearanceNotice photo={state.photo} />}

          <Segmented
            label={t("photo.quality")}
            value={quality}
            options={(["auto", ...PHOTO_QUALITIES] as const).map((q) => ({ value: q, label: t(`photo.quality.${q}`) }))}
            onChange={(v) => setQuality(v as PhotoQualityRequest)}
          />
        </div>

        <div className="flex flex-wrap justify-end gap-2 border-t border-stone-200 px-5 py-3">
          {rendering && (
            <button type="button" className={buttonClass} onClick={() => controller.current?.abort()}>
              {t("photo.cancel")}
            </button>
          )}
          <button type="button" className={buttonClass} disabled={rendering} onClick={() => void render(false, quality)}>
            {t("photo.rerender")}
          </button>
          <button
            type="button"
            className={primaryButtonClass}
            disabled={state.kind !== "done"}
            onClick={() => state.kind === "done" && downloadBlob(state.photo.blob, photoFileName(new Date()))}
          >
            {t("photo.downloadPng")}
          </button>
          <button type="button" className={buttonClass} onClick={onClose}>
            {t("photo.close")}
          </button>
        </div>
      </div>
    </div>
  );
}

/** How the image was made — a raster preview is never presented as photorealistic. */
export function PhotoBadge({ photo }: { photo: RenderedPhoto }) {
  const t = useT();
  const size = `${photo.width}×${photo.height}`;
  if (photo.mode === "pathtraced") {
    return (
      <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-900" data-photo-mode="pathtraced" data-photo-timings={JSON.stringify(photo.timings)}>
        {t("photo.badgePathtraced", { samples: photo.samples, size, seconds: Math.round(photo.durationMs / 1000) })}
      </p>
    );
  }
  return (
    <p className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900" data-photo-mode="raster" data-photo-timings={JSON.stringify(photo.timings)}>
      {t(photo.fallbackReason ? "photo.badgeRasterFallback" : "photo.badgeRaster", { size, frames: photo.samples, seconds: Math.round(photo.durationMs / 1000) })}{" "}
      {photo.fallbackReason && t(`photo.fallback.${photo.fallbackReason}` as Parameters<typeof t>[0])}
    </p>
  );
}

/**
 * Manufacturer appearances the image could not show as authorized — kept apart from renderer fallbacks
 * (PhotoBadge): decors without a catalog swatch (neutral indicator, also noted in the image itself) and
 * authorized images that failed to load (the decor's own mean colour; rendering again retries).
 */
export function AppearanceNotice({ photo }: { photo: RenderedPhoto }) {
  const t = useT();
  const unavailable = photo.appearance?.unavailable ?? [];
  const failed = photo.appearance?.failed ?? [];
  const reduced = (photo.reductions?.length ?? 0) > 0;
  if (unavailable.length === 0 && failed.length === 0 && !reduced) return null;
  return (
    <div className="space-y-1 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900" data-photo-appearance>
      {unavailable.length > 0 && <p data-photo-unavailable>{t("photo.appearance.unavailable", { decors: unavailable.join(", ") })}</p>}
      {failed.length > 0 && <p data-photo-texture-failed>{t("photo.appearance.failed", { decors: failed.join(", ") })}</p>}
      {reduced && <p data-photo-reductions>{t("photo.reductions")}</p>}
    </div>
  );
}
