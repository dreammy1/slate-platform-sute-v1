import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import type { ButtonHTMLAttributes } from 'react';

import { cn } from '../lib/cn.ts';

/**
 * Variants are declared once, in terms of semantic tokens only (ADR 008 §3):
 * no palette literal appears here, so a rebrand or the theme runtime changes the
 * button without touching this file.
 */
const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md font-medium ' +
    'transition-colors ease-standard focus-visible:outline-none focus-visible:ring-2 ' +
    'focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background ' +
    'disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        primary: 'bg-primary text-primary-foreground hover:opacity-90',
        secondary: 'border border-border bg-surface text-surface-foreground hover:bg-muted',
        ghost: 'bg-transparent text-foreground hover:bg-muted',
        danger: 'bg-danger text-danger-foreground hover:opacity-90',
      },
      size: {
        sm: 'h-8 px-3 text-sm',
        md: 'h-10 px-4 text-sm',
        lg: 'h-11 px-6 text-base',
      },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  /**
   * Render the child element instead of a `<button>`, keeping the styling and the
   * accessible name the child provides. Use it for links: `<Button asChild>` with
   * an `<a>` produces an anchor that navigates, not a button that pretends to.
   */
  readonly asChild?: boolean;
}

/**
 * The button primitive. Server-safe: it holds no state and no browser API, so a
 * Server Component may render it (as long as it passes no event handler).
 */
export function Button({ className, variant, size, asChild = false, type, ...props }: ButtonProps) {
  const classes = cn(buttonVariants({ variant, size }), className);

  if (asChild) {
    // `type` is a button-only attribute and is dropped rather than forwarded to
    // whatever element the caller supplies (an anchor would reject it).
    return <Slot className={classes} {...props} />;
  }

  return <button type={type ?? 'button'} className={classes} {...props} />;
}
