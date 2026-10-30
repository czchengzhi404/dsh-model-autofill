/**
 * Catalog loading: the bundled offline snapshot, a fresh live refresh when the
 * network allows, and an on-disk cache in between.
 *
 * Sources are isolated and layered — a failed fetch never loses the bundled
 * snapshot or a stale cache, and the caller is told which sources were used so
 * the report can be honest about freshness.
 *
 * @module dsh-model-autofill/catalog
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

/** Path of the snapshot shipped in the package. */
export const SNAPSHOT_URL = new URL("../data/models.dev.json", import.meta.url);

/**
 * Read the bundled snapshot.
 *
 * @param url - snapshot location; defaults to the packaged file.
 * @returns the parsed catalog, or `undefined` when the snapshot is missing.
 */
export async function readSnapshot(url = SNAPSHOT_URL) {
  try {
    return JSON.parse(await readFile(url, "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * Layer one catalog over another, per provider and per model key.
 *
 * @param base - lower layer (snapshot).
 * @param over - higher layer (cache or live), wins key by key.
 * @returns a merged catalog; `over` when `base` is missing and vice versa.
 */
export function mergeCatalog(base, over) {
  if (base === undefined) return over ?? {};
  if (over === undefined) return base;
  const merged = { ...base };
  for (const [provider, entry] of Object.entries(over)) {
    const lower = merged[provider]?.models;
    merged[provider] = {
      ...merged[provider],
      ...entry,
      models: lower === undefined ? entry.models : { ...lower, ...entry.models }
    };
  }
  return merged;
}

/**
 * Load the catalog from snapshot + cache + network, in that order of trust.
 *
 * @param options.snapshot - preloaded bundled snapshot.
 * @param options.endpoint - catalog URL.
 * @param options.cacheFile - cache path; omitted disables caching.
 * @param options.ttlMs - cache freshness window.
 * @param options.timeoutMs - network timeout.
 * @param options.fetchImpl - injectable fetch (tests).
 * @returns `{ catalog, sources }` where sources ∈ bundled | cache | live | stale-cache.
 */
export async function loadCatalog(options) {
  const { snapshot, endpoint, cacheFile, ttlMs = 24 * 3600 * 1000, timeoutMs = 20000 } = options;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const sources = snapshot === undefined ? [] : ["bundled"];

  let cached;
  if (cacheFile !== undefined) {
    try {
      cached = JSON.parse(await readFile(cacheFile, "utf8"));
    } catch {
      cached = undefined;
    }
  }

  if (cached?.catalog !== undefined && typeof cached.fetchedAt === "number" && Date.now() - cached.fetchedAt < ttlMs) {
    return { catalog: mergeCatalog(snapshot, cached.catalog), sources: [...sources, "cache"] };
  }

  if (typeof fetchImpl === "function") {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(endpoint, { signal: controller.signal, headers: { accept: "application/json" } });
      if (response.ok) {
        const live = await response.json();
        if (cacheFile !== undefined) {
          try {
            await mkdir(dirname(cacheFile), { recursive: true });
            await writeFile(cacheFile, JSON.stringify({ fetchedAt: Date.now(), catalog: live }), "utf8");
          } catch {
            /* a cache miss next run is acceptable */
          }
        }
        return { catalog: mergeCatalog(snapshot, live), sources: [...sources, "live"] };
      }
    } catch {
      /* fall through to the stale cache */
    } finally {
      clearTimeout(timer);
    }
  }

  if (cached?.catalog !== undefined) {
    return { catalog: mergeCatalog(snapshot, cached.catalog), sources: [...sources, "stale-cache"] };
  }
  return { catalog: snapshot ?? {}, sources };
}
