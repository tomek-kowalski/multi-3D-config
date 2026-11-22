"""Extracts the WooCommerce + ThemeComplete Extra Product Options (EPO) form of ClickBed product pages.

Usage (from the repository root):
    python -I scripts/clickbed/extract_epo.py OUT.json PAGE1.html [PAGE2.html ...]

Input: product pages saved from the shop (e.g. `curl -sL https://clickbed.pl/<slug>/ -o <slug>.html`).
Output: one entry per page with the WooCommerce product id, and for every EPO field its form name
(`tmcp_select_0`, ...), label, the exact option values the shop's form posts (e.g. `140 x 200_0`)
and the conditional-display logic. No prices are extracted: WooCommerce stays the price authority.
The HTML is parsed as data only (regular expressions, standard library); nothing from it is executed.
"""
import html
import json
import re
import sys


def text(fragment: str) -> str:
    fragment = re.sub(r"<span[^>]*tm-epo-required[^>]*>.*?</span>", "", fragment, flags=re.S)
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", fragment))).strip()


def extract(path: str) -> dict:
    src = open(path, encoding="utf-8").read()
    product_id = int(re.search(r'name="add-to-cart" value="(\d+)"', src).group(1))
    canonical = re.search(r'<link rel="canonical" href="([^"]+)"', src)
    fields = []
    for block in re.split(r'(?=<div[^>]*class="[^"]*cpf-type-)', src)[1:]:
        names = re.findall(r'name="(tmcp_[a-z]+_\d+(?:_\d+)?)"', block)
        if not names:
            continue
        kind = re.search(r"cpf-type-([a-z]+)", block).group(1)
        uniqid = re.search(r'data-uniqid="([^"]+)"', block)
        label = re.search(r'tm-epo-element-label[^"]*"[^>]*>(.*?)</(?:label|h\d|div)>', block, re.S)
        logic = re.search(r'data-logic="([^"]*)"', block)
        values = [html.unescape(v) for v in re.findall(r'<option[^>]*value="([^"]+)"', block)]
        values += [html.unescape(v) for v in re.findall(r'<input[^>]*type="(?:radio|checkbox)"[^>]*value="([^"]+)"', block)]
        parsed_logic = None
        if logic and logic.group(1) not in ("", "false"):
            parsed_logic = json.loads(html.unescape(logic.group(1)))
        fields.append({
            "name": names[0],
            "type": kind,
            "uniqid": uniqid.group(1) if uniqid else None,
            "label": text(label.group(1)) if label else "",
            # The form posts these strings verbatim; the display label is the part before the last "_".
            "values": values,
            "logic": parsed_logic,
        })
    return {"productId": product_id, "url": canonical.group(1) if canonical else None, "fields": fields}


if __name__ == "__main__":
    out, pages = sys.argv[1], sys.argv[2:]
    data = [extract(p) for p in pages]
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=1)
    for product in data:
        print(product["productId"], product["url"])
        for f in product["fields"]:
            print("  %-20s %-9s %-45s %d" % (f["name"], f["type"], f["label"][:45], len(f["values"])))
