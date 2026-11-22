/**
 * A validation or operation problem. Domain code never formats user-facing text for the new
 * room/arrangement/product layers: it returns a stable `code` plus parameters, and the UI turns them
 * into a localized message (see src/i18n).
 */
export interface Issue {
  readonly code: string;
  readonly params?: Readonly<Record<string, string | number>>;
  /** Dotted path of the offending value, e.g. `openings.door-1.width`. */
  readonly path?: string;
}

export type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly issues: readonly Issue[] };

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function fail<T = never>(...issues: Issue[]): Result<T> {
  return { ok: false, issues };
}
