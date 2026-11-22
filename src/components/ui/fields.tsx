"use client";

import { useId, useState, type ReactNode } from "react";
import type { Issue } from "@/domain/shared/issues";
import { formatIssue, useT } from "@/i18n";
import { CheckIcon } from "@/components/configurator/SectionHeading";
import { canStep, StepButton, stepValue } from "./stepper";

export const buttonClass =
  "rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm font-medium text-stone-800 transition-colors hover:bg-stone-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-800 disabled:cursor-not-allowed disabled:opacity-50";
export const primaryButtonClass =
  "rounded-lg bg-stone-900 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-stone-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-800 disabled:cursor-not-allowed disabled:bg-stone-400";
export const dangerButtonClass =
  "rounded-lg border border-red-200 bg-white px-3 py-2 text-sm font-medium text-red-700 transition-colors hover:bg-red-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-700";

export function IssueList({ issues }: { issues: readonly Issue[] }) {
  const t = useT();
  if (issues.length === 0) return null;
  return (
    <ul role="alert" className="space-y-1 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
      {issues.map((issue, i) => (
        <li key={i}>{formatIssue(t, issue)}</li>
      ))}
    </ul>
  );
}

/**
 * Whole-millimetre number input with − / + buttons. The text is kept locally while typing and
 * committed on Enter or blur; a rejected value stays visible with its error until corrected (typed
 * values are never clamped). The buttons step by `buttonStep` within [min, max] and commit at once.
 */
export function MmField({
  label,
  value,
  onCommit,
  unit = "mm",
  hint,
  step = 1,
  buttonStep = 1,
  min,
  max,
}: {
  label: string;
  value: number;
  /** Returns the issues of a rejected value, or none. */
  onCommit: (value: number) => readonly Issue[];
  unit?: string;
  hint?: string;
  /** Precision accepted by the input. */
  step?: number;
  /** Increment of the − / + buttons. */
  buttonStep?: number;
  min?: number;
  max?: number;
}) {
  const id = useId();
  const [text, setText] = useState(String(value));
  const [synced, setSynced] = useState(value);
  const [issues, setIssues] = useState<readonly Issue[]>([]);
  if (!Object.is(value, synced)) {
    setSynced(value);
    setText(String(value));
    setIssues([]);
  }
  const commit = () => {
    const parsed = text.trim() === "" ? Number.NaN : Number(text.replace(",", "."));
    if (Object.is(parsed, value)) {
      setIssues([]);
      return;
    }
    setIssues(onCommit(parsed));
  };
  const invalid = issues.length > 0;
  const typed = text.trim() === "" ? Number.NaN : Number(text.replace(",", "."));
  const current = Number.isFinite(typed) ? typed : value;
  const stepOptions = { step: buttonStep, min, max };
  const stepBy = (direction: 1 | -1) => {
    const next = stepValue(current, direction, stepOptions);
    setText(String(next));
    if (Object.is(next, value)) {
      setIssues([]);
      return;
    }
    setIssues(onCommit(next));
  };
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="text-sm font-medium text-stone-800">
          {label}
        </label>
        {hint && <span className="text-xs tabular-nums text-stone-500">{hint}</span>}
      </div>
      <div
        className={`flex items-center rounded-lg border bg-white focus-within:ring-2 ${
          invalid ? "border-red-400 focus-within:ring-red-200" : "border-stone-300 focus-within:border-stone-500 focus-within:ring-stone-200"
        }`}
      >
        <StepButton direction={-1} label={label} disabled={!canStep(current, -1, stepOptions)} onStep={() => stepBy(-1)} />
        <input
          id={id}
          type="number"
          inputMode="numeric"
          step={step}
          min={min}
          max={max}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") {
              setText(String(value));
              setIssues([]);
            }
          }}
          aria-invalid={invalid}
          className="w-full min-w-0 bg-transparent px-2 py-2 text-sm tabular-nums text-stone-900 outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        />
        <span className="select-none pr-2 text-xs text-stone-500" aria-hidden="true">
          {unit}
        </span>
        <StepButton direction={1} label={label} disabled={!canStep(current, 1, stepOptions)} onStep={() => stepBy(1)} />
      </div>
      <IssueList issues={issues} />
    </div>
  );
}

/** Colour choice: preset swatches plus a free colour picker. */
export function ColorField({
  label,
  value,
  presets,
  onChange,
}: {
  label: string;
  value: string;
  presets: readonly string[];
  onChange: (color: `#${string}`) => void;
}) {
  const t = useT();
  const id = useId();
  return (
    <fieldset className="space-y-1.5">
      <legend className="flex w-full items-baseline justify-between gap-2">
        <span className="text-sm font-medium text-stone-800">{label}</span>
        <span className="font-mono text-xs text-stone-500">{value.toUpperCase()}</span>
      </legend>
      <div className="flex flex-wrap items-center gap-1.5">
        {presets.map((color) => {
          const selected = color.toUpperCase() === value.toUpperCase();
          return (
            <button
              key={color}
              type="button"
              title={color}
              aria-label={`${label}: ${color}`}
              aria-pressed={selected}
              onClick={() => onChange(color as `#${string}`)}
              className={`relative size-7 rounded-full border border-black/15 shadow-inner focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-900 ${
                selected ? "ring-2 ring-blue-600 ring-offset-2" : ""
              }`}
              style={{ backgroundColor: color }}
            >
              {selected && (
                <span className="absolute -right-1 -top-1 flex size-3.5 items-center justify-center rounded-full bg-blue-600 text-white ring-2 ring-white">
                  <CheckIcon className="size-2.5" />
                </span>
              )}
            </button>
          );
        })}
        <label htmlFor={id} className="ml-1 flex cursor-pointer items-center gap-1.5 rounded-lg border border-stone-300 px-2 py-1 text-xs text-stone-700 hover:bg-stone-100">
          <input id={id} type="color" value={value} onChange={(e) => onChange(e.target.value.toUpperCase() as `#${string}`)} className="size-5 cursor-pointer border-0 bg-transparent p-0" />
          {t("common.customColor")}
        </label>
      </div>
    </fieldset>
  );
}

export function SelectField<V extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: V;
  options: readonly { value: V; label: string }[];
  onChange: (value: V) => void;
}) {
  const id = useId();
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="text-sm font-medium text-stone-800">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value as V)}
        className="w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm text-stone-900 focus:border-stone-500 focus:outline-none focus:ring-2 focus:ring-stone-200"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/** Segmented choice (2–6 short options). */
export function Segmented<V extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: V;
  options: readonly { value: V; label: string }[];
  onChange: (value: V) => void;
}) {
  return (
    <fieldset className="space-y-1.5">
      <legend className="text-sm font-medium text-stone-800">{label}</legend>
      <div className="flex flex-wrap gap-1 rounded-lg bg-stone-100 p-1">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            aria-pressed={o.value === value}
            onClick={() => onChange(o.value)}
            className={`flex-1 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-stone-800 ${
              o.value === value ? "bg-white text-stone-900 shadow-sm" : "text-stone-600 hover:text-stone-900"
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

export function Card({ children, selected = false }: { children: ReactNode; selected?: boolean }) {
  return (
    <div className={`space-y-3 rounded-xl border p-3 ${selected ? "border-blue-300 bg-blue-50/40" : "border-stone-200 bg-stone-50/60"}`}>{children}</div>
  );
}
