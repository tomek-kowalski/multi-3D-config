import { readFileSync } from "node:fs";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import { describe, expect, it } from "vitest";
import { addModule } from "@/domain/arrangement/operations";
import type { Arrangement } from "@/domain/arrangement/types";
import { buildQuote, type PriceLookup } from "@/domain/commerce/quote";
import { DEFAULT_ROOM } from "@/domain/room/defaults";
import { isMessageKey, translate } from "@/i18n";
import { buildQuotePdf, type PdfFonts } from "./quotePdf";

const FONT_DIR = join(__dirname, "../../public/fonts");
const fonts: PdfFonts = {
  regular: readFileSync(join(FONT_DIR, "DejaVuSans.ttf")).toString("base64"),
  bold: readFileSync(join(FONT_DIR, "DejaVuSans-Bold.ttf")).toString("base64"),
};
/** A valid 4 × 4 RGB PNG built with zlib (stands in for a 3D rendering). */
function png(): string {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(4, 0);
  header.writeUInt32BE(4, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const rows = Buffer.concat(Array.from({ length: 4 }, () => Buffer.from([0, ...Array(12).fill(180)])));
  const file = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${file.toString("base64")}`;
}
const PNG = png();
const image = (mode: "pathtraced" | "raster" = "pathtraced") => ({ dataUrl: PNG, width: 1920, height: 1080, mode, samples: mode === "pathtraced" ? 192 : 1 });

function quote() {
  let a: Arrangement = { room: DEFAULT_ROOM, modules: [] };
  for (const type of ["cabinet", "clickbed-o"]) {
    const r = addModule(a, type);
    if (!r.ok) throw new Error();
    a = r.value.arrangement;
  }
  const prices: PriceLookup = {
    byId: new Map([[4000, { amount: 10390, currency: "PLN" }]]),
    bySku: new Map(),
  };
  const q = buildQuote(a, prices, { number: "OF-20261124-ŁÓDŹ".replace("ŁÓDŹ", "ABCD"), createdAt: new Date("2026-11-24T10:00:00Z") });
  if (!q.ok) throw new Error();
  return q.value;
}

const t = (key: string, params?: Readonly<Record<string, string | number>>) => (isMessageKey(key) ? translate("pl", key, params) : key);

async function readPdf(bytes: Uint8Array) {
  const pdf = await getDocument({ data: bytes.slice(), useSystemFonts: false }).promise;
  let text = "";
  let images = 0;
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    text += content.items.map((item) => ("str" in item ? item.str : "")).join(" ") + "\n";
    const ops = await page.getOperatorList();
    images += ops.fnArray.filter((fn) => fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject).length;
  }
  return { text, images, pages: pdf.numPages };
}

describe("quotation PDF", () => {
  it("is a PDF with number, date, every module, prices and the total", async () => {
    const bytes = buildQuotePdf({ quote: quote(), images: [image()], fonts, t, locale: "pl-PL" });
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
    const { text } = await readPdf(bytes);
    expect(text).toContain("OF-20261124-ABCD");
    expect(text).toContain("24 listopada 2026");
    expect(text).toContain("Szafka modułowa");
    expect(text).toContain("ClickBed O");
    expect(text).toMatch(/10\s?390,00\s?zł/);
    expect(text).toContain("cena do potwierdzenia"); // the cabinet had no shop price
    expect(text).toContain("Razem");
    expect(text).toContain("Wykończenie korpusu: Dąb naturalny"); // localized finish, not the raw id
  });

  it("renders Polish characters with the embedded font", async () => {
    const { text } = await readPdf(buildQuotePdf({ quote: quote(), images: [], fonts, t, locale: "pl-PL" }));
    for (const word of ["Grubość płyty", "Wymiary (szer. × wys. × gł.)", "Wykończenie korpusu", "Półka", "Oświetlenie LED", "24 listopada 2026"]) {
      expect(text.replace(/\s+/g, " ")).toContain(word);
    }
  });

  it("says how each rendering was made: a raster fallback is never captioned as photorealistic", async () => {
    const { text } = await readPdf(buildQuotePdf({ quote: quote(), images: [image(), image("raster")], fonts, t, locale: "pl-PL" }));
    const flat = text.replace(/\s+/g, " ");
    expect(flat).toContain("Wizualizacja 1 z 2 — fotorealistyczny rendering (path tracing, 192 próbek na piksel)");
    expect(flat).toContain("Wizualizacja 2 z 2 — podgląd rastrowy (bez path tracingu, nie jest renderingiem fotorealistycznym)");
  });

  it("includes exactly the given renderings", async () => {
    for (const count of [1, 2, 3]) {
      const { images } = await readPdf(buildQuotePdf({ quote: quote(), images: Array.from({ length: count }, () => image()), fonts, t, locale: "pl-PL" }));
      expect(images).toBe(count);
    }
  });

  it("can be produced in English", async () => {
    const en = (key: string, params?: Readonly<Record<string, string | number>>) => (isMessageKey(key) ? translate("en", key, params) : key);
    const { text } = await readPdf(buildQuotePdf({ quote: quote(), images: [], fonts, t: en, locale: "en-GB" }));
    expect(text).toContain("Quotation number");
    expect(text).toContain("Modular cabinet");
  });
});
