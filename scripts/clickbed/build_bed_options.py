"""Builds the ClickBed option snapshot used by the configurator from the extracted EPO form.

Usage (from the repository root):
    python -I scripts/clickbed/build_bed_options.py EPO.json SWATCHES.json OUT.json

- EPO.json: output of extract_epo.py (the shop's product form, WooCommerce product ids, exact posted values).
- SWATCHES.json: decor swatches sampled from the supplied catalog
  (lib/upholstery colors/Transforms_Katalog_Plyt_Meblowych_Premium_2026.pdf) by sample_decor_swatches.py.

The decor lists, categories and add-ons come only from the shop form. The catalog only contributes the
preview colour/texture of a decor (matched by decor code + surface structure, e.g. "8685 SM").
Decors without a catalog swatch are kept (they are orderable) and flagged `swatch: null`.
"""
import json
import re
import sys

LABEL_SIZE = "Rozmiar materaca"
LABEL_CATEGORY = "Wybierz kategorie dekoru"
LABEL_FRONT = "Kolor frontu"
LABEL_BODY = "Kolor obudowy"
LABEL_MATTRESS = "Materac Velora Silver"
LABEL_FIRMNESS = "Twardość materaca"
ADDON_LABELS = {
    "Półka": "shelf",
    "Oświetlenie LED": "led",
    "Otwieranie elektryczne na pilota": "electricOpening",
    "Dodatkowy zamek z kluczykiem": "extraLock",
}


def display(value: str) -> str:
    """The shop posts `<label>_<index>`; the label is everything before the last underscore."""
    return value.rsplit("_", 1)[0].replace("\xa0", " ").strip()


def size_key(label: str) -> str:
    w, l = re.findall(r"\d+", label)
    return f"{w}x{l}"


def rule_values(field):
    out = []
    for group in (field["logic"] or {}).get("rules", []):
        for rule in group:
            out.append(rule["value"].replace("%20", " "))
    return sorted(set(out))


def decor_key(code_structure: str) -> str:
    return code_structure.split(";")[0].strip()


def build(epo, swatches):
    swatch_by_key = {s["code"].replace("\xa0", " ").strip(): s for s in swatches}
    swatch_by_code = {}
    for s in swatches:
        swatch_by_code.setdefault(s["code"].split()[0], s)
    products, missing = [], set()
    for product in epo:
        fields = product["fields"]
        size_field = next(f for f in fields if f["label"] == LABEL_SIZE)
        sizes = [{"key": size_key(display(v)), "label": display(v), "value": v} for v in size_field["values"]]
        by_label = lambda label: [f for f in fields if f["label"] == label]
        # Per-size selects (category, mattress) are shown by a logic rule on the size label.
        def per_size(label):
            mapping = {}
            for f in by_label(label):
                for v in rule_values(f):
                    mapping[size_key(v)] = f["name"]
            return mapping
        category_fields = per_size(LABEL_CATEGORY)
        mattress_fields = per_size(LABEL_MATTRESS)
        category_values = by_label(LABEL_CATEGORY)[0]["values"]
        categories = []
        for value in category_values:
            label = display(value)
            front = [f for f in by_label(LABEL_FRONT) if label in rule_values(f)]
            body = [f for f in by_label(LABEL_BODY) if label in rule_values(f)]
            assert len(front) == 1 and len(body) == 1, (product["productId"], label, front, body)
            decors = []
            for v_front, v_body in zip(front[0]["values"], body[0]["values"]):
                name = display(v_front)
                # "<code> <structure> <name>", e.g. "8685 SM Snow White"; metal decors have no structure
                # symbol ("AL01 Brushed Aluminium").
                m = re.match(r"^(\S+)\s+([A-Z]{2}(?:;[A-Z]{2})?)\s+(.*)$", name) or re.match(r"^(\S+)\s+()(.*)$", name)
                code, structure, decor_name = m.group(1), m.group(2), m.group(3)
                key = decor_key(f"{code} {structure}")
                swatch, match = swatch_by_key.get(key), "exact"
                if not swatch:
                    # Same decor code = same colour and pattern; the structure symbol is the surface finish.
                    swatch, match = swatch_by_code.get(code), "code"
                if not swatch:
                    missing.add(key)
                decors.append({
                    "id": f"{code}-{structure}".replace(";", "-").strip("-"),
                    "code": code,
                    "structure": structure,
                    "name": decor_name,
                    "frontValue": v_front,
                    "bodyValue": v_body,
                    "swatch": None if not swatch else {"hex": swatch["hex"], "texture": swatch["file"], "namePl": swatch["namePl"], "catalogCode": swatch["code"], "match": match},
                })
            categories.append({
                "id": re.sub(r"[^a-z0-9]+", "-", label.lower()).strip("-"),
                "label": label,
                "value": value,
                "frontField": front[0]["name"],
                "bodyField": body[0]["name"],
                "decors": decors,
            })
        # The mattress is optional: products without it simply have no mattress/firmness fields.
        firmness_fields = by_label(LABEL_FIRMNESS)
        mattress_values = by_label(LABEL_MATTRESS)
        addons = []
        for f in fields:
            if f["label"] in ADDON_LABELS:
                addons.append({"id": ADDON_LABELS[f["label"]], "label": f["label"], "field": f["name"],
                               "values": {display(v).lower(): v for v in f["values"]}})
        terms = next(f for f in fields if f["type"] == "checkbox")
        products.append({
            "productId": product["productId"],
            "url": product["url"],
            "sizes": [
                dict(s, categoryField=category_fields[s["key"]], **({"mattressField": mattress_fields[s["key"]]} if s["key"] in mattress_fields else {}))
                for s in sizes
            ],
            "sizeField": size_field["name"],
            "categories": categories,
            **({"mattress": {"values": {display(v).lower(): v for v in mattress_values[0]["values"]}}} if mattress_values else {}),
            **({"firmness": {"field": firmness_fields[0]["name"], "values": [{"label": display(v), "value": v} for v in firmness_fields[0]["values"]]}} if firmness_fields else {}),
            "addons": addons,
            "termsField": terms["name"],
            "termsValue": terms["values"][0],
            "termsLabel": display(terms["values"][0]),
        })
    return products, sorted(missing)


if __name__ == "__main__":
    epo = json.load(open(sys.argv[1], encoding="utf-8"))
    swatches = json.load(open(sys.argv[2], encoding="utf-8"))
    products, missing = build(epo, swatches)
    doc = {"source": "clickbed.pl product pages (WooCommerce + ThemeComplete EPO form), extracted 2026-11-21",
           "missingSwatches": missing, "products": products}
    with open(sys.argv[3], "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=False, indent=1)
    total = sum(len(c["decors"]) for p in products for c in p["categories"])
    print("products", len(products), "decor entries", total, "missing swatches", len(missing), missing)
