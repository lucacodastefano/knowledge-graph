/** Longest URL kept; anything longer is almost surely not a citation. */
const MAX_URL = 2048;
/** Sources kept per node per call: a node is supported by a few pages, not a whole search result list. */
export const MAX_SOURCES_PER_NODE = 10;

export interface NormalizedSource {
  url: string;
  domain: string;
}

/**
 * Canonical form of a cited URL, so the same page cited twice is one source: http(s) only, no credentials,
 * no `utm_*` tracking parameters, no #fragment, no trailing slash. Returns null for anything else (ignored, not an error).
 */
export function normalizeSourceUrl(raw: string): NormalizedSource | null {
  const text = raw.trim();
  if (!text || text.length > MAX_URL) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname) return null;
  // Rebuild the query only when tracking parameters are dropped, so other parameters keep their encoding.
  const tracking = [...url.searchParams.keys()].filter((key) => /^utm_/i.test(key));
  for (const key of tracking) url.searchParams.delete(key);
  const search = tracking.length === 0 ? url.search : url.searchParams.size > 0 ? `?${url.searchParams.toString()}` : '';
  const path = url.pathname.replace(/\/+$/, '');
  return { url: `${url.protocol}//${url.host}${path}${search}`, domain: url.hostname.replace(/^www\./, '') };
}

/** Distinct valid sources of a list, in order; invalid entries are dropped. */
export function normalizeSources(urls: readonly unknown[] | undefined): NormalizedSource[] {
  const out = new Map<string, NormalizedSource>();
  for (const u of urls ?? []) {
    if (typeof u !== 'string') continue;
    const s = normalizeSourceUrl(u);
    if (s && !out.has(s.url)) out.set(s.url, s);
    if (out.size >= MAX_SOURCES_PER_NODE) break;
  }
  return [...out.values()];
}
