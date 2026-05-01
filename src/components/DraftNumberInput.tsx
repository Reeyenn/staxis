'use client';

// ─── DraftNumberInput ──────────────────────────────────────────────────────
// Drop-in replacement for `<input type="number" value={n} onChange={...}>` that
// allows the field to be visually empty mid-edit instead of snapping to the
// "or default" zero.
//
// THE BUG IT PREVENTS:
//   The naive pattern is:
//     <input value={n} onChange={e => setN(Number(e.target.value) || 0)} />
//   When the user backspaces past every digit, `e.target.value === ''`,
//   `Number('') === 0`, `0 || 0 === 0` — state goes to 0, React rerenders
//   value="0", and now the field is stuck rendering "0" as the user keeps
//   typing. Type "5" then "0" expecting 50 and you get "050". Reeyen
//   reported this on the Prediction Settings modal on 2026-04-30; this
//   component was lifted out so every other admin form can avoid the same
//   trap by swapping `<input type="number">` for `<DraftNumberInput>`.
//
// CONTRACT:
//   • `value`     — current saved number
//   • `onCommit`  — fires whenever the user types a valid number that's
//                   within [min, max]. Empty / out-of-range / NaN does NOT
//                   commit. The parent doesn't see invalid intermediate
//                   states.
//   • `onBlur`    — if the field is left empty / invalid, snaps the
//                   display back to the last committed value. Better UX
//                   than silently clamping to min, which would change the
//                   saved value without telling the user.
//
// USAGE NOTES:
//   • If the parent's value changes externally (e.g. modal reopens with
//     fresh state), the displayed string syncs.
//   • Pass `width` if 64px isn't right for your layout (e.g. wider for
//     decimals).
//   • If your underlying state is in a different unit than what the user
//     types (e.g. minutes stored, hours displayed), do the conversion in
//     the parent — see the Max-hours field in ScheduleTab.

import React, { useEffect, useRef, useState } from 'react';

export interface DraftNumberInputProps {
  value: number;
  onCommit: (n: number) => void;
  min: number;
  max?: number;
  step?: number;
  width?: string;
  className?: string;
  style?: React.CSSProperties;
  placeholder?: string;
  disabled?: boolean;
  /** Optional extra props forwarded to the underlying <input>. */
  inputProps?: Omit<
    React.InputHTMLAttributes<HTMLInputElement>,
    'value' | 'onChange' | 'onBlur' | 'type' | 'min' | 'max' | 'step' | 'disabled' | 'placeholder' | 'className' | 'style'
  >;
}

export function DraftNumberInput({
  value,
  onCommit,
  min,
  max,
  step = 1,
  width,
  className,
  style,
  placeholder,
  disabled,
  inputProps,
}: DraftNumberInputProps) {
  const [draft, setDraft] = useState<string>(String(value));
  const lastValueRef = useRef<number>(value);

  useEffect(() => {
    // Sync display when the parent's value changes from outside (e.g. a
    // modal reopens, or Save resets the form). Skip when our own commit
    // is the source — lastValueRef.current is updated synchronously on
    // commit so this comparison correctly identifies external changes.
    if (lastValueRef.current !== value) {
      setDraft(String(value));
      lastValueRef.current = value;
    }
  }, [value]);

  const inRange = (n: number): boolean =>
    Number.isFinite(n) && n >= min && (max === undefined || n <= max);

  const mergedStyle: React.CSSProperties = {
    width: width ?? '64px',
    textAlign: 'center',
    padding: '8px 4px',
    ...(style ?? {}),
  };

  return (
    <input
      {...(inputProps ?? {})}
      className={className ?? 'input'}
      type="number"
      min={min}
      max={max}
      step={step}
      value={draft}
      placeholder={placeholder}
      disabled={disabled}
      onChange={e => {
        const v = e.target.value;
        setDraft(v);
        if (v === '') return; // allow visually empty mid-edit
        const n = Number(v);
        if (inRange(n)) {
          onCommit(n);
          lastValueRef.current = n;
        }
      }}
      onBlur={() => {
        const n = Number(draft);
        if (draft === '' || !inRange(n)) {
          // User left the field invalid — restore the last committed
          // value rather than silently clamping (which would change the
          // saved number without the user realising).
          setDraft(String(lastValueRef.current));
        }
      }}
      style={mergedStyle}
    />
  );
}
