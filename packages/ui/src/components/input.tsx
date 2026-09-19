'use client';

import { useId, type InputHTMLAttributes } from 'react';

import { cn } from '../lib/cn.ts';

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> {
  /** Optional stable id; a generated one is used when omitted. */
  readonly id?: string | undefined;
  /** Rendered as the input's `<label>`, which also names the control. */
  readonly label?: string | undefined;
  /** Short helper text, associated through `aria-describedby`. */
  readonly hint?: string | undefined;
  /** Validation message; its presence marks the control invalid. */
  readonly error?: string | undefined;
}

/**
 * A labelled text control.
 *
 * The label, hint and error are wired to the input by the component itself
 * (`htmlFor`, `aria-describedby`, `aria-invalid`) rather than by each caller, so
 * the accessible name is impossible to forget and a screen reader announces the
 * error the moment it appears. It is a client component because generating the
 * id if the caller does not supply one requires `useId`.
 */
export function Input({ id, label, hint, error, className, ...props }: InputProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const hintId = `${inputId}-hint`;
  const errorId = `${inputId}-error`;
  const describedBy = [
    hint === undefined ? undefined : hintId,
    error === undefined ? undefined : errorId,
  ]
    .filter((value): value is string => value !== undefined)
    .join(' ');
  const invalid = error !== undefined;

  const control = (
    <input
      id={inputId}
      className={cn(
        'h-10 w-full rounded-md border bg-input px-3 text-sm text-foreground',
        'placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2',
        'focus-visible:ring-ring disabled:opacity-50',
        invalid ? 'border-danger' : 'border-border',
        className,
      )}
      aria-invalid={invalid || undefined}
      {...(describedBy === '' ? {} : { 'aria-describedby': describedBy })}
      {...props}
    />
  );

  if (label === undefined) return control;

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={inputId} className="text-sm font-medium text-foreground">
        {label}
      </label>
      {control}
      {hint === undefined ? null : (
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
      {error === undefined ? null : (
        // `role="alert"` announces the message when it appears; the text is also
        // the description, so meaning never rests on colour alone.
        <p id={errorId} role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
