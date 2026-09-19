import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Joins class names, letting a caller's override win.
 *
 * `clsx` handles conditionals; `twMerge` resolves conflicts between Tailwind
 * utilities so a component's default (`px-4`) can be overridden by a consumer
 * (`px-6`) instead of both landing in the class list and the loser depending on
 * stylesheet order.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
