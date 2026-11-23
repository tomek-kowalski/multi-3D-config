"""Samples decor swatches from the supplied board catalog (Transforms / Kronospan decors).

Usage (needs PyMuPDF, Pillow and NumPy: `pip install pymupdf pillow numpy`):
    python -I scripts/clickbed/sample_decor_swatches.py \\
        "../lib/upholstery colors/Transforms_Katalog_Plyt_Meblowych_Premium_2026.pdf" OUT_DIR

Every catalog page shows decor images with the decor code ("8685 SM") on the line directly below and
the Polish name on the next line. For each image this writes:
- OUT_DIR/<code>.jpg      256 px preview texture (configurator view, menu swatches);
- OUT_DIR/hd/<code>.jpg   the catalog image at its native resolution (photorealistic renders);
- OUT_DIR/swatches.json   code, Polish name, catalog group, average colour and grain information.

Grain normalization: the dominant direction of the pattern is measured with a structure tensor on
the real catalog image. When the pattern is clearly directional (wood grain, brushed metal) and runs
vertically in the photo, the image is rotated by 90° so that the grain always runs along the image's
horizontal (u) axis. The 3D models map u along each panel's longer side (convert-clickbed.mjs), so
the grain follows the panel's long dimension. Nothing else in the image is changed.

The catalog itself notes that colours are indicative only. Only the swatches used by the shop's
decors are copied to public/textures/decors (see build_bed_options.py).
"""
import io
import json
import math
import os
import re
import sys

import numpy as np
import pymupdf
from PIL import Image

# Patterns with at least this coherence (0 = isotropic, 1 = perfectly directional) count as grained.
GRAIN_COHERENCE = 0.12


def grain(img: Image.Image) -> dict:
    """Dominant pattern direction from the structure tensor of the grey image."""
    g = np.asarray(img.convert("L").resize((256, 256)), dtype=np.float64)
    gx = np.diff(g, axis=1)[:-1, :]
    gy = np.diff(g, axis=0)[:, :-1]
    jxx, jyy, jxy = (gx * gx).sum(), (gy * gy).sum(), (gx * gy).sum()
    trace = jxx + jyy
    if trace <= 1e-9:
        return {"coherence": 0.0, "angleDeg": None, "direction": "none"}
    root = math.sqrt((jxx - jyy) ** 2 + 4 * jxy * jxy)
    l1, l2 = (trace + root) / 2, (trace - root) / 2
    coherence = ((l1 - l2) / (l1 + l2)) ** 2 if l1 + l2 > 0 else 0.0
    # Gradients are perpendicular to the grain: grain angle = gradient angle + 90°.
    gradient_angle = 0.5 * math.degrees(math.atan2(2 * jxy, jxx - jyy))
    grain_angle = (gradient_angle + 90) % 180
    if coherence < GRAIN_COHERENCE:
        direction = "none"
    else:
        direction = "horizontal" if grain_angle < 45 or grain_angle > 135 else "vertical"
    return {"coherence": round(coherence, 3), "angleDeg": round(grain_angle, 1), "direction": direction}


def main(pdf_path: str, outdir: str) -> None:
    os.makedirs(os.path.join(outdir, "hd"), exist_ok=True)
    doc = pymupdf.open(pdf_path)
    result = []
    for page_index, page in enumerate(doc):
        words = page.get_text("words")
        header = " ".join(w[4] for w in words if w[1] < 50 and w[0] > 300)
        for info in page.get_image_info(xrefs=True):
            x0, y0, x1, y1 = info["bbox"]
            if info["width"] < 300 or (x1 - x0) < 100 or not info.get("xref"):
                continue
            below = sorted((w for w in words if 0 <= w[1] - y1 <= 14 and w[0] >= x0 - 1 and w[2] <= x1 + 1), key=lambda w: w[0])
            line2 = sorted((w for w in words if 14 < w[1] - y1 <= 30 and w[0] >= x0 - 1 and w[2] <= x1 + 1), key=lambda w: w[0])
            if len(below) < 2:
                continue
            code = " ".join(w[4] for w in below)
            name = " ".join(w[4] for w in line2)
            native = Image.open(io.BytesIO(doc.extract_image(info["xref"])["image"])).convert("RGB")
            w, h = native.size
            core = native.crop((int(w * 0.08), int(h * 0.08), int(w * 0.92), int(h * 0.92)))
            g = grain(core)
            if g["direction"] == "vertical":
                core = core.transpose(Image.Transpose.ROTATE_90)
            avg = core.resize((1, 1), Image.Resampling.BOX).getpixel((0, 0))
            key = re.sub(r"[^A-Za-z0-9]+", "-", code).strip("-")
            core.resize((256, 256), Image.Resampling.LANCZOS).save(os.path.join(outdir, f"{key}.jpg"), quality=82)
            core.save(os.path.join(outdir, "hd", f"{key}.jpg"), quality=90)
            result.append({
                "code": code,
                "namePl": name,
                "group": header,
                "page": page_index + 1,
                "hex": "#%02X%02X%02X" % avg,
                "file": f"{key}.jpg",
                "hdSize": list(core.size),
                "grain": g,
                "rotated": g["direction"] == "vertical",
            })
    with open(os.path.join(outdir, "swatches.json"), "w", encoding="utf-8") as fh:
        json.dump(result, fh, ensure_ascii=False, indent=1)
    rotated = sum(1 for r in result if r["rotated"])
    grained = sum(1 for r in result if r["grain"]["direction"] != "none")
    print(f"{len(result)} swatches, {grained} with directional grain, {rotated} rotated to horizontal")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
