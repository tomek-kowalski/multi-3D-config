"use client";

import { useT } from "@/i18n";

export interface StepOptions {
  /** Increment per click (whole millimetres by default). */
  readonly step?: number;
  readonly min?: number;
  readonly max?: number;
}

function decimals(step: number): number {
  const text = String(step);
  return text.includes(".") ? text.length - text.indexOf(".") - 1 : 0;
}

/**
 * The value one +/− click produces: current ± step, kept within [min, max].
 * - A value outside the range (e.g. a rejected entry) goes to the nearest bound.
 * - A non-numeric entry starts at the minimum (or 0).
 * The result is snapped to the step's decimals so repeated clicks never accumulate float noise.
 */
export function stepValue(current: number, direction: 1 | -1, { step = 1, min, max }: StepOptions = {}): number {
  const clamp = (v: number) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v));
  if (!Number.isFinite(current)) return clamp(min ?? 0);
  if ((min !== undefined && current < min) || (max !== undefined && current > max)) return clamp(current);
  return Number(clamp(current + direction * step).toFixed(decimals(step)));
}

export function canStep(current: number, direction: 1 | -1, { min, max }: StepOptions = {}): boolean {
  if (!Number.isFinite(current)) return true;
  if (direction > 0 && max !== undefined) return current < max;
  if (direction < 0 && min !== undefined) return current > min;
  return true;
}

const BUTTON =
  "flex w-8 shrink-0 select-none items-center justify-center self-stretch text-base font-semibold text-stone-600 transition-colors hover:bg-stone-100 hover:text-stone-900 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-stone-800 disabled:cursor-not-allowed disabled:text-stone-300 disabled:hover:bg-transparent";

/** The − / + button pair placed inside a number field's frame. */
export function StepButton({
  direction,
  label,
  disabled,
  onStep,
}: {
  direction: 1 | -1;
  label: string;
  disabled?: boolean;
  onStep: () => void;
}) {
  const t = useT();
  return (
    <button
      type="button"
      tabIndex={-1}
      disabled={disabled}
      aria-label={t(direction > 0 ? "common.increase" : "common.decrease", { label })}
      // Keep the focus (and the typed text) in the input; the click itself applies the step.
      onMouseDown={(event) => event.preventDefault()}
      onClick={onStep}
      className={`${BUTTON} ${direction < 0 ? "rounded-l-lg border-r border-stone-200" : "rounded-r-lg border-l border-stone-200"}`}
    >
      {direction > 0 ? "+" : "−"}
    </button>
  );
}
