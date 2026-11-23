import type { CaptureOptions, QuoteRendering, RenderingCount } from "@/services/quotation";
import { renderingMetadata, type PhotoRenderer } from "./photoService";
import type { PhotoSettings } from "./photoSettings";

/** JPEG copy of a rendering for the PDF (same pixels, smaller file). */
export async function blobToJpegDataUrl(blob: Blob, quality = 0.9): Promise<string> {
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas unavailable");
    ctx.drawImage(bitmap, 0, 0);
    return canvas.toDataURL("image/jpeg", quality);
  } finally {
    bitmap.close();
  }
}

/**
 * The quotation's capture function: 1–3 photos from the photorealistic pipeline (one configuration
 * snapshot for all of them), each as PNG + JPEG for the PDF + metadata.
 */
export function quoteCapture(
  renderer: PhotoRenderer,
  settings?: Partial<PhotoSettings>,
  toJpeg: (blob: Blob) => Promise<string> = blobToJpegDataUrl,
): (count: RenderingCount, options?: CaptureOptions) => Promise<QuoteRendering[]> {
  return async (count, options = {}) => {
    const photos = await renderer({ count, settings, signal: options.signal, onProgress: options.onProgress });
    return Promise.all(photos.map(async (photo) => ({ png: photo.blob, jpegDataUrl: await toJpeg(photo.blob), meta: renderingMetadata(photo) })));
  };
}
