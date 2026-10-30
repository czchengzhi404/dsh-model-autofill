/**
 * models.dev catalog access: fetch + cache, fuzzy model matching, and the
 * derived capability/limit summary the plugin writes into DSH config.
 *
 * @module dsh-model-autofill/modelsdev
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** Guard rails against implausible catalog entries (some mirrors publish outliers). */
const MAX_CONTEXT = 8_000_000;
const MAX_OUTPUT = 2_000_000;

/** The last path segment of a catalog key (`vendor/model` -> `model`). */
function tail(key) {
  const slash = key.lastIndexOf("/");
  return slash === -1 ? key : key.slice(slash + 1);
}

/**
 * Load the models.dev catalog, preferring a fresh on-disk cache.
 *
 * @param options.endpoint - catalog URL.
 * @param options.cacheFile - cache path; omitted disables caching.
 * @param options.ttlMs - cache freshness window.
 * @param options.timeoutMs - network timeout.
 * @param options.fetchImpl - injectable fetch (tests).
 * @returns the parsed catalog, or `undefined` when neither cache nor network served one.
 */
export async function loadCatalog(options) {
  const { endpoint, cacheFile, ttlMs = 12 * 3600 * 1000, timeoutMs = 20000 } = options;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  if (cacheFile !== undefined) {
    try {
      const cached = JSON.parse(await readFile(cacheFile, "utf8"));
      if (typeof cached?.fetchedAt === "number" && Date.now() - cached.fetchedAt < ttlMs && cached.catalog) {
        return cached.catalog;
      }
    } catch {
      /* no usable cache */
    }
  }

  if (typeof fetchImpl !== "function") return undefined;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(endpoint, { signal: controller.signal, headers: { accept: "application/json" } });
    if (!response.ok) return undefined;
    const catalog = await response.json();
    if (cacheFile !== undefined) {
      try {
        await mkdir(dirname(cacheFile), { recursive: true });
        await writeFile(cacheFile, JSON.stringify({ fetchedAt: Date.now(), catalog }), "utf8");
      } catch {
        /* a cache miss next run is acceptable */
      }
    }
    return catalog;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Find every catalog entry that could describe one model id: an exact id, a
 * `vendor/id` spelling, or a same-family snapshot (`id-0731`, `id.1`, ...).
 *
 * @param catalog - parsed models.dev catalog.
 * @param id - the configured model id.
 * @returns matches in catalog order, tagged with their provider and key.
 */
export function matchModels(catalog, id) {
  const out = [];
  const lower = id.toLowerCase();
  for (const [provider, entry] of Object.entries(catalog ?? {})) {
    const models = entry?.models;
    if (models === null || typeof models !== "object") continue;
    for (const [key, model] of Object.entries(models)) {
      const base = tail(key);
      const baseLower = base.toLowerCase();
      const sameFamily =
        baseLower === lower ||
        baseLower.startsWith(`${lower}-`) ||
        baseLower.startsWith(`${lower}.`);
      if (sameFamily) out.push({ provider, key, model });
    }
  }
  return out;
}

/**
 * Choose the limit pair that best represents a model's own capability.
 *
 * Preference order: the canonical `vendor/id` entry, then an exact id, then the
 * strongest family snapshot. We deliberately avoid "maximum across all
 * providers", which some mirrors inflate far past what any route honours.
 *
 * @param matches - output of {@link matchModels}.
 * @param id - the configured model id.
 * @returns `{ contextWindow?, maxTokens? }`, or an empty object when no entry carried limits.
 */
export function pickLimits(matches, id) {
  const lower = id.toLowerCase();
  const canonical =
    matches.find((entry) => entry.key.includes("/") && tail(entry.key) === id) ??
    matches.find((entry) => entry.key.includes("/") && tail(entry.key).toLowerCase() === lower);
  const exact =
    matches.find((entry) => entry.key === id) ??
    matches.find((entry) => entry.key.toLowerCase() === lower);
  const chosen =
    canonical ??
    exact ??
    matches.reduce((best, entry) => {
      if (best === null) return entry;
      const a = entry.model?.limit ?? {};
      const b = best.model?.limit ?? {};
      if ((a.output ?? 0) !== (b.output ?? 0)) return (a.output ?? 0) > (b.output ?? 0) ? entry : best;
      return (a.context ?? 0) > (b.context ?? 0) ? entry : best;
    }, null);

  const limit = chosen?.model?.limit;
  if (limit === null || typeof limit !== "object") return {};
  const contextWindow = Number.isInteger(limit.context) && limit.context > 0 ? Math.min(limit.context, MAX_CONTEXT) : undefined;
  const maxTokens = Number.isInteger(limit.output) && limit.output > 0 ? Math.min(limit.output, MAX_OUTPUT) : undefined;
  return {
    ...contextWindow === undefined ? {} : { contextWindow },
    ...maxTokens === undefined ? {} : { maxTokens }
  };
}

/**
 * Union the capability signals across every matching entry.
 *
 * Capability is a property of the model, not of one reseller, so a single entry
 * advertising image input is enough to keep the image modality switched on.
 *
 * @param matches - output of {@link matchModels}.
 * @returns `{ vision, reasoning, efforts, toggleOnly }` where `efforts` are the
 *   raw models.dev effort spellings (`none`, `low`, ...) and `toggleOnly` says
 *   the model exposed an on/off switch but no explicit level list.
 */
export function summarizeCapabilities(matches) {
  let vision = false;
  let reasoning = false;
  let toggled = false;
  const efforts = new Set();
  for (const { model } of matches) {
    for (const modality of model?.modalities?.input ?? []) {
      if (modality === "image" || modality === "video") vision = true;
    }
    if (model?.reasoning === true) reasoning = true;
    for (const option of model?.reasoning_options ?? []) {
      if (option?.type === "effort" && Array.isArray(option.values)) {
        for (const value of option.values) efforts.add(String(value));
      }
      if (option?.type === "toggle") toggled = true;
    }
  }
  return { vision, reasoning, efforts: [...efforts], toggleOnly: toggled && efforts.size === 0 };
}

/** Map one models.dev effort spelling onto a DSH reasoning level. */
export function effortToLevel(value) {
  const normalized = String(value).toLowerCase();
  if (normalized === "none" || normalized === "off" || normalized === "disabled") return "off";
  return normalized;
}

/**
 * Apply the output-token safety margin, aligned to 1024, with a 4096 floor.
 *
 * @param value - raw catalog output limit.
 * @param margin - multiplier (default 0.85).
 * @returns the value to store in `maxTokens`.
 */
export function applyMargin(value, margin = 0.85) {
  const scaled = Math.floor((value * margin) / 1024) * 1024;
  return Math.max(scaled, 4096);
}
