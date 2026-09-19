'use client';

import * as Dialog from '@radix-ui/react-dialog';
import type { ReactNode } from 'react';

import { cn } from '../lib/cn.ts';
import { Button } from './button.tsx';

export interface ModalProps {
  /** The control that opens the modal. Its accessible name becomes the trigger's. */
  readonly trigger: ReactNode;
  /**
   * The dialog's accessible name. Required: an unnamed dialog is unusable with a
   * screen reader, and Radix warns when there is no title.
   */
  readonly title: string;
  readonly description?: string | undefined;
  readonly children?: ReactNode;
  readonly footer?: ReactNode;
  readonly open?: boolean | undefined;
  readonly defaultOpen?: boolean | undefined;
  readonly onOpenChange?: ((open: boolean) => void) | undefined;
  readonly contentClassName?: string | undefined;
}

/**
 * A modal dialog built on Radix `Dialog` (ADR 008 §4): focus trapping, initial
 * focus, focus restoration, `Escape` handling, scroll locking and the
 * `role="dialog"`/`aria-modal` wiring are the primitive's responsibility, not
 * something this component re-implements.
 *
 * Client-only: it holds interaction state and renders a portal.
 */
export function Modal({
  trigger,
  title,
  description,
  children,
  footer,
  open,
  defaultOpen,
  onOpenChange,
  contentClassName,
}: ModalProps) {
  return (
    <Dialog.Root
      {...(open === undefined ? {} : { open })}
      {...(defaultOpen === undefined ? {} : { defaultOpen })}
      {...(onOpenChange === undefined ? {} : { onOpenChange })}
    >
      <Dialog.Trigger asChild>{trigger}</Dialog.Trigger>
      <Dialog.Portal>
        {/* The overlay is decoration: it dims the page and blocks the pointer,
            while `Escape` and the close control remain the accessible exits. */}
        <Dialog.Overlay className="fixed inset-0 z-40 bg-foreground/50" />
        <Dialog.Content
          // Radix 1.1 no longer emits `aria-modal` itself (it contains focus and
          // locks scroll through other means). The attribute is still the signal
          // assistive technology uses to treat the rest of the page as inert, so
          // the primitive declares it explicitly instead of depending on the
          // bundler's Radix version (ADR 008 §4).
          aria-modal={true}
          className={cn(
            'fixed left-1/2 top-1/2 z-50 w-[min(32rem,calc(100vw-2rem))] -translate-x-1/2',
            '-translate-y-1/2 rounded-lg border border-border bg-background p-6 shadow-md',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            contentClassName,
          )}
          // Without a description Radix expects this to be explicitly absent,
          // rather than pointing `aria-describedby` at nothing.
          {...(description === undefined ? { 'aria-describedby': undefined } : {})}
        >
          <Dialog.Title className="text-base font-semibold text-foreground">{title}</Dialog.Title>
          {description === undefined ? null : (
            <Dialog.Description className="mt-1 text-sm text-muted-foreground">
              {description}
            </Dialog.Description>
          )}
          {children === undefined ? null : <div className="mt-4">{children}</div>}
          {footer === undefined ? null : (
            <div className="mt-6 flex flex-wrap justify-end gap-2">{footer}</div>
          )}
          <Dialog.Close asChild>
            <Button variant="ghost" size="sm" className="absolute right-3 top-3">
              Close
            </Button>
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
