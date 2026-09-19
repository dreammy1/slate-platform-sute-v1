// @vitest-environment node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * The design-token contract (SLATE-300, ADR 008 §3).
 *
 * These are the assertions that keep "tokens are the single source of truth" from
 * being a comment: the contrast pairs are computed from the token file itself, the
 * Tailwind preset must map every token that exists, and no component may declare a
 * colour of its own.
 */

const sourceDirectory = fileURLToPath(new URL('..', import.meta.url));
const tokensFile = join(sourceDirectory, 'styles', 'tokens.css');
const presetFile = fileURLToPath(new URL('../../../config/tailwind/theme.css', import.meta.url));

/** The minimum ratio WCAG 2.2 AA requires for normal-size text. */
const AA_NORMAL_TEXT = 4.5;

/** Pairs that a consumer is allowed to place together, and must stay legible. */
const TEXT_PAIRS = [
  ['--slate-foreground', '--slate-background'],
  ['--slate-surface-foreground', '--slate-surface'],
  ['--slate-muted-foreground', '--slate-background'],
  ['--slate-primary-foreground', '--slate-primary'],
  ['--slate-danger-foreground', '--slate-danger'],
  ['--slate-success-foreground', '--slate-success'],
] as const;

/** Reads `--slate-*` declarations out of one CSS block. */
function parseTokens(css: string, selector: string): Record<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const block = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 's').exec(css)?.[1] ?? '';
  const tokens: Record<string, string> = {};
  for (const match of block.matchAll(/(--slate-[\w-]+)\s*:\s*([^;]+);/g)) {
    tokens[match[1]!] = match[2]!.trim();
  }
  return tokens;
}

/** WCAG relative luminance of a `#rrggbb` value. */
function luminance(colour: string): number {
  const hex = /^#([0-9a-f]{6})$/i.exec(colour);
  if (hex === null) throw new Error(`"${colour}" is not a six-digit hex colour`);
  const value = Number.parseInt(hex[1]!, 16);
  const channels = [(value >> 16) & 255, (value >> 8) & 255, value & 255].map((channel) => {
    const ratio = channel / 255;
    return ratio <= 0.03928 ? ratio / 12.92 : ((ratio + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

/** WCAG contrast ratio between two colours. */
function contrast(foreground: string, background: string): number {
  const first = luminance(foreground);
  const second = luminance(background);
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Every file under `src`, so the colour scan cannot miss a new folder. */
function sourceFiles(directory: string): readonly string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx|css)$/.test(entry) ? [path] : [];
  });
}

const tokens = readFileSync(tokensFile, 'utf8');
const light = parseTokens(tokens, ':root');
const dark = parseTokens(tokens, '.dark');

describe('design tokens', () => {
  it('declares a value for every documented pair in both themes', () => {
    for (const [foreground, background] of TEXT_PAIRS) {
      expect(light[foreground], `${foreground} in the light theme`).toMatch(/^#/);
      expect(light[background], `${background} in the light theme`).toMatch(/^#/);
      // Every colour token must be re-declared for dark; a missing one silently
      // inherits the light value.
      expect(dark[foreground], `${foreground} in the dark theme`).toMatch(/^#/);
      expect(dark[background], `${background} in the dark theme`).toMatch(/^#/);
    }
  });

  it('re-declares nothing that the root does not define', () => {
    for (const name of Object.keys(dark)) {
      expect(light[name], `${name} is overridden but never declared`).toBeDefined();
    }
  });

  it.each(TEXT_PAIRS)('keeps %s on %s at WCAG AA in both themes', (foreground, background) => {
    const lightRatio = contrast(light[foreground]!, light[background]!);
    const darkRatio = contrast(dark[foreground]!, dark[background]!);

    expect(
      lightRatio,
      `light ${foreground} on ${background} is ${lightRatio.toFixed(2)}:1`,
    ).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    expect(
      darkRatio,
      `dark ${foreground} on ${background} is ${darkRatio.toFixed(2)}:1`,
    ).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
  });

  it('maps every declared token into the Tailwind preset', () => {
    const preset = readFileSync(presetFile, 'utf8');
    for (const name of Object.keys(light)) {
      // A token with no mapping produces no utility, which is only noticed in the
      // browser — so it is asserted here instead.
      expect(preset, `${name} is missing from the Tailwind preset`).toContain(`var(${name})`);
    }
  });

  it('declares colour values only in the token file', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(sourceDirectory)) {
      if (file.endsWith(join('styles', 'tokens.css')) || file.includes('__tests__')) continue;
      const contents = readFileSync(file, 'utf8');
      if (/#[0-9a-f]{3,8}\b/i.test(contents) || /(rgb|hsl)a?\(/i.test(contents)) {
        offenders.push(file.replace(sourceDirectory, 'src'));
      }
    }
    expect(offenders).toEqual([]);
  });
});
