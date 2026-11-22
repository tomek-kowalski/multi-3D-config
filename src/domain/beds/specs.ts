/**
 * Published dimensions of the ClickBed models (millimetres), per mattress size and per source.
 * Sources disagree in places; every value is kept with its source rather than picking one. The
 * collision volumes use the largest value of all sources and of the supplied 3D model
 * (see bedGeometry.ts), and docs/clickbed-assets.md lists the discrepancies.
 *
 * Sources:
 * - `page`: the product page "Specyfikacja techniczna" table (clickbed.pl, read 2026-11-21);
 * - `pdf`: the spec sheets in lib/furniture-spec (Clickbed O Classico.pdf, Clickbed O Desk.pdf).
 *   There is no spec sheet for ClickBed O.
 *
 * Legend (as on the product pages): W szerokość zabudowy, H wysokość zabudowy, D głębokość zabudowy,
 * DU głębokość łóżka po rozłożeniu, HU wysokość rozłożonego łóżka, HM wysokość materaca,
 * HD wysokość położenia biurka, DD głębokość biurka, WD szerokość biurka.
 */
export type SpecSource = "page" | "pdf";

export type SpecValue = Readonly<Partial<Record<SpecSource, number>>>;

export interface BedSizeSpec {
  readonly W: SpecValue;
  readonly H: SpecValue;
  readonly D: SpecValue;
  readonly DU: SpecValue;
  readonly HU: SpecValue;
  readonly HM: SpecValue;
  /** Desk only. */
  readonly HD?: SpecValue;
  readonly DD?: SpecValue;
  readonly WD?: SpecValue;
}

const both = (page: number, pdf: number): SpecValue => ({ page, pdf });
const page = (value: number): SpecValue => ({ page: value });
const pdf = (value: number): SpecValue => ({ pdf: value });

export const BED_SPECS: Readonly<Record<string, Readonly<Record<string, BedSizeSpec>>>> = {
  "clickbed-o": {
    "90x200": { W: page(2158), H: page(1086), D: page(400), DU: page(1140), HU: page(235), HM: page(200) },
    "120x200": { W: page(2158), H: page(1386), D: page(400), DU: page(1440), HU: page(235), HM: page(200) },
    "140x200": { W: page(2158), H: page(1586), D: page(400), DU: page(1640), HU: page(235), HM: page(200) },
    "160x200": { W: page(2158), H: page(1786), D: page(400), DU: page(1840), HU: page(235), HM: page(200) },
    // The page's table labels this size "200X180".
    "180x200": { W: page(2158), H: page(1986), D: page(400), DU: page(2040), HU: page(235), HM: page(200) },
  },
  "clickbed-o-classico": {
    "140x200": { W: both(2162, 2158), H: both(1586, 1586), D: both(400, 400), DU: both(1640, 1640), HU: both(235, 235), HM: both(200, 200) },
    "160x200": { W: both(2162, 2158), H: both(1786, 1786), D: both(400, 400), DU: both(1840, 1840), HU: both(235, 235), HM: both(200, 200) },
    "180x200": { W: both(2162, 2158), H: both(1986, 1986), D: both(400, 400), DU: both(2040, 2040), HU: both(235, 235), HM: both(200, 200) },
  },
  "clickbed-o-desk": {
    "140x200": { W: both(2162, 2158), H: both(1578, 1589), D: both(400, 400), DU: both(1634, 1640), HU: both(235, 235), HM: both(200, 200), HD: both(720, 720), DD: both(530, 530), WD: pdf(2060) },
    "160x200": { W: both(2162, 2158), H: both(1778, 1789), D: both(400, 400), DU: both(1834, 1840), HU: both(235, 235), HM: both(200, 200), HD: both(720, 720), DD: both(530, 530), WD: pdf(2060) },
    // The page gives DU 1834 for 180 (same as 160); the PDF gives 2040.
    "180x200": { W: both(2162, 2158), H: both(1978, 1989), D: both(400, 400), DU: both(1834, 2040), HU: both(235, 235), HM: both(200, 200), HD: both(720, 720), DD: both(530, 530), WD: pdf(2060) },
  },
};

/** Largest published value (0 when the value is not published at all). */
export function maxSpec(value: SpecValue | undefined): number {
  if (!value) return 0;
  return Math.max(0, ...Object.values(value).filter((v): v is number => typeof v === "number"));
}

/** The value shown to the customer: the product page's, falling back to the spec sheet. */
export function displaySpec(value: SpecValue | undefined): number | null {
  if (!value) return null;
  return value.page ?? value.pdf ?? null;
}
