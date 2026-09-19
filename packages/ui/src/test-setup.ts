/**
 * jsdom gaps that Radix primitives depend on (SLATE-300), plus the Testing
 * Library cleanup hook.
 *
 * jsdom implements neither layout nor the observer/pointer APIs, and Radix
 * components use them for scroll locking, focus management and pointer capture.
 * These stubs are deliberately inert: the behaviours under test are roles,
 * names, keyboard interaction and focus movement, none of which need layout.
 *
 * The shared Vitest preset runs with `globals: false`, so Testing Library cannot
 * register its own `afterEach` cleanup; it is wired explicitly here, which keeps
 * each test file's DOM from leaking into the next one.
 */

import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

class ResizeObserverStub {
  observe(): void {
    /* no layout in jsdom */
  }
  unobserve(): void {
    /* no layout in jsdom */
  }
  disconnect(): void {
    /* no layout in jsdom */
  }
}

const globalScope = globalThis as unknown as Record<string, unknown>;
if (typeof globalScope['ResizeObserver'] === 'undefined') {
  globalScope['ResizeObserver'] = ResizeObserverStub;
}

if (typeof window !== 'undefined') {
  if (typeof window.matchMedia !== 'function') {
    // Defaults to "no preference": individual tests override this to assert the
    // `system` theme path.
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  }

  const elementPrototype = Element.prototype as unknown as Record<string, unknown>;
  elementPrototype['scrollIntoView'] ??= () => undefined;
  elementPrototype['hasPointerCapture'] ??= () => false;
  elementPrototype['setPointerCapture'] ??= () => undefined;
  elementPrototype['releasePointerCapture'] ??= () => undefined;
}

afterEach(() => {
  cleanup();
});
