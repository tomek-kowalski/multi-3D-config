"""Process the approved Poly Haven CC0 sets into runtime tiers.

usage: python -I process.py <download dir> <output dir (public/textures/pbr)> <stats json>

Tiers (see docs/material-phase4ab-assets.md):
  albedo    standard 1K JPEG, enhanced 2K JPEG (veneers/plaster: the original files, byte-identical;
            floors: rotated 90 deg CCW and re-encoded, quality 92, 4:4:4)
  normal    standard 512 PNG, enhanced 1K PNG: decoded from the 2K OpenGL map, box-filtered,
            renormalized, re-encoded 8-bit RGB (floors: rotated, vector rotated with the image)
  roughness standard 256 PNG, enhanced 1K PNG: from the 2K map (16-bit where supplied), box-filtered,
            8-bit grey (three samples roughness from G; a grey PNG decodes to R=G=B)
"""
import hashlib, json, os, shutil, sys
import numpy as np
from PIL import Image

SRC, OUT, STATS = sys.argv[1], sys.argv[2], sys.argv[3]

ASSETS = {
    # asset: (physical size m, rotate so planks/grain run along u, has albedo in runtime)
    "oak_veneer_02": (1.0, False, True),
    "oak_veneer_03": (1.0, False, True),
    "walnut_veneer_02": (1.0, False, True),
    "white_plaster_02": (1.0, False, False),
    "wood_floor": (1.7, True, True),
    "laminate_floor_03": (2.08, True, True),
    "herringbone_parquet": (3.4, True, True),
}


def srgb_to_linear(c):
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def box(a, f):
    h, w = a.shape[:2]
    return a.reshape(h // f, f, w // f, f, *a.shape[2:]).mean(axis=(1, 3))


def read_normal(path):
    im = np.asarray(Image.open(path).convert("RGB")).astype(np.float64)
    n = im / 255.0 * 2.0 - 1.0
    return n / np.linalg.norm(n, axis=-1, keepdims=True)


def rot_normal(n):
    """Rotate the image 90 deg CCW and the tangent-space vector with it: (x, y) -> (-y, x) (x right, y up)."""
    r = np.rot90(n, 1).copy()
    x, y = r[..., 0].copy(), r[..., 1].copy()
    r[..., 0], r[..., 1] = -y, x
    return r


def encode_normal(n):
    n = n / np.linalg.norm(n, axis=-1, keepdims=True)
    return Image.fromarray(np.clip(np.round((n * 0.5 + 0.5) * 255.0), 0, 255).astype(np.uint8), "RGB")


def read_gray(path):
    im = Image.open(path)
    a = np.asarray(im)
    if a.dtype == np.uint16 or im.mode.startswith("I"):
        return a.astype(np.float64) / 65535.0
    a = np.asarray(im.convert("RGB")).astype(np.float64) / 255.0
    return a[..., 1]


def md5(p):
    return hashlib.md5(open(p, "rb").read()).hexdigest()


def groove_sign(n, axis):
    """Mean slope of the normal across the strongest seams: >0 means grooves (seams lower than planks)."""
    comp = n[..., 0] if axis == "x" else n[..., 1]
    prof = np.abs(comp).mean(0 if axis == "x" else 1)
    idx = np.argsort(prof)[-6:]
    s = []
    for i in idx:
        if 3 <= i < len(prof) - 3:
            if axis == "x":  # seam column: left side tilts +x, right side -x for a groove
                s.append(n[:, i - 2, 0].mean() - n[:, i + 2, 0].mean())
            else:  # seam row (row index grows downwards = -y): the side above tilts -y, below +y
                s.append(n[i + 2, :, 1].mean() - n[i - 2, :, 1].mean())
    return float(np.mean(s)) if s else 0.0


stats = {}
os.makedirs(OUT, exist_ok=True)
for asset, (size_m, rotate, albedo) in ASSETS.items():
    src = os.path.join(SRC, asset)
    out = os.path.join(OUT, asset)
    os.makedirs(out, exist_ok=True)
    rec = {"coverageM": [size_m, size_m], "rotatedCcw90": rotate, "files": {}, "sources": {}}

    # ---- albedo ----
    if albedo:
        for tier, res in (("standard", "1k"), ("enhanced", "2k")):
            sp = os.path.join(src, f"{asset}_diff_{res}.jpg")
            dp = os.path.join(out, f"albedo_{res}.jpg")
            rec["sources"][f"albedo_{res}"] = {"file": os.path.basename(sp), "md5": md5(sp)}
            if rotate:
                Image.open(sp).convert("RGB").rotate(90, expand=True).save(dp, quality=92, subsampling=0, optimize=True)
            else:
                shutil.copyfile(sp, dp)
            a = np.asarray(Image.open(dp).convert("RGB")).astype(np.float64) / 255.0
            lin = srgb_to_linear(a)
            lum = lin @ np.array([0.2126, 0.7152, 0.0722])
            rec["files"][f"albedo_{res}.jpg"] = {
                "tier": tier, "size": list(Image.open(dp).size), "bytes": os.path.getsize(dp),
                "meanLinearRgb": [round(float(v), 5) for v in lin.reshape(-1, 3).mean(0)],
                "luminanceMean": round(float(lum.mean()), 5), "luminanceStd": round(float(lum.std()), 5),
                "p1": [round(float(v), 4) for v in np.percentile(lin.reshape(-1, 3), 1, axis=0)],
                "p99": [round(float(v), 4) for v in np.percentile(lin.reshape(-1, 3), 99, axis=0)],
            }

    # ---- normal ----
    sp = os.path.join(src, f"{asset}_nor_gl_2k.png")
    rec["sources"]["normal_2k"] = {"file": os.path.basename(sp), "md5": md5(sp)}
    n2k = read_normal(sp)
    rec["grooveSignSource"] = {"x": groove_sign(n2k, "x"), "y": groove_sign(n2k, "y")}
    if rotate:
        n2k = rot_normal(n2k)
        rec["grooveSignRotated"] = {"x": groove_sign(n2k, "x"), "y": groove_sign(n2k, "y")}
    for tier, f, name in (("enhanced", 2, "normal_1k.png"), ("standard", 4, "normal_512.png")):
        n = box(n2k, f)
        n = n / np.linalg.norm(n, axis=-1, keepdims=True)
        img = encode_normal(n)
        dp = os.path.join(out, name)
        img.save(dp, optimize=True)
        back = np.asarray(Image.open(dp)).astype(np.float64) / 255.0 * 2 - 1
        rec["files"][name] = {
            "tier": tier, "size": list(img.size), "bytes": os.path.getsize(dp),
            "slopeStdXY": [round(float(v), 4) for v in back[..., :2].reshape(-1, 2).std(0)],
            "lengthMeanAfterQuantization": round(float(np.linalg.norm(back, axis=-1).mean()), 4),
        }

    # ---- roughness ----
    sp = os.path.join(src, f"{asset}_rough_2k.png")
    rec["sources"]["roughness_2k"] = {"file": os.path.basename(sp), "md5": md5(sp), "mode": Image.open(sp).mode}
    r2k = read_gray(sp)
    if rotate:
        r2k = np.rot90(r2k, 1)
    for tier, f, name in (("enhanced", 2, "roughness_1k.png"), ("standard", 8, "roughness_256.png")):
        r = box(r2k, f)
        img = Image.fromarray(np.clip(np.round(r * 255.0), 0, 255).astype(np.uint8), "L")
        dp = os.path.join(out, name)
        img.save(dp, optimize=True)
        back = np.asarray(Image.open(dp)).astype(np.float64) / 255.0
        rec["files"][name] = {
            "tier": tier, "size": list(img.size), "bytes": os.path.getsize(dp),
            "mean": round(float(back.mean()), 4), "std": round(float(back.std()), 4),
            "p5": round(float(np.percentile(back, 5)), 4), "p95": round(float(np.percentile(back, 95)), 4),
        }
    for name in rec["files"]:
        rec["files"][name]["md5"] = md5(os.path.join(out, name))
    stats[asset] = rec
    print(asset, json.dumps({k: (v["bytes"], v["size"]) for k, v in rec["files"].items()}), rec.get("grooveSignSource"), rec.get("grooveSignRotated"), flush=True)

json.dump(stats, open(STATS, "w"), indent=1)
