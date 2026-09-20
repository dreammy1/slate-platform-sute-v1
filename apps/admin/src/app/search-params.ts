/**
 * Search-parameter helpers shared by the admin module pages (SLATE-302).
 *
 * Pages read their outcome from the query string a server action redirects to,
 * so a mutation never needs client state to report its result.
 */

/** Decoded search params exactly as Next.js hands them to a page. */
export type SearchParams = Record<string, string | string[] | undefined>;

/** Reads a single string parameter; an empty or repeated value reads as absent. */
export function singleParam(params: SearchParams, key: string): string | undefined {
  const value = params[key];
  if (typeof value !== 'string' || value === '') return undefined;
  return value;
}

/** The outcome banner: an error text, else the success text, else nothing. */
export function outcomeBanner(
  params: SearchParams,
  successKey: string,
  successText: string,
): string | undefined {
  const error = singleParam(params, 'error');
  if (error !== undefined) return error;
  return singleParam(params, successKey) === undefined ? undefined : successText;
}
