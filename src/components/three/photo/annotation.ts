/**
 * Burns a visible note into an exported image (bottom band, legible at any size). Used when a photo
 * shows manufacturer decors that have no authorized swatch: the indicative neutral colour must never
 * travel without its explanation (downloads, quotation PDFs, e-mails).
 */
export async function annotateImage(image: Blob, text: string, format: "png" | "jpeg" = "png"): Promise<Blob> {
  const bitmap = await createImageBitmap(image);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return image;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const fontPx = Math.max(12, Math.round(canvas.height * 0.02));
  const pad = Math.round(fontPx * 0.7);
  ctx.font = `600 ${fontPx}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  // Wrap to the image width.
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width > canvas.width - 2 * pad && line) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  const band = lines.length * fontPx * 1.3 + pad * 1.4;
  ctx.fillStyle = "rgba(120, 53, 15, 0.86)";
  ctx.fillRect(0, canvas.height - band, canvas.width, band);
  ctx.fillStyle = "#fffbeb";
  ctx.textBaseline = "top";
  lines.forEach((l, i) => ctx.fillText(l, pad, canvas.height - band + pad * 0.7 + i * fontPx * 1.3));
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Image encoding failed"))), format === "png" ? "image/png" : "image/jpeg", 0.85),
  );
}
