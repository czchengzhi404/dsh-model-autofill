/**
 * Turn a configurable entry's current value into the list of `settings.mutate`
 * operations that bring its models up to their catalog capabilities.
 *
 * Handles the differences between adapter namespaces without hard-coding them:
 * the modality field (`input` vs `inputModalities`), the reasoning field
 * (`reasoningEfforts` dict vs `reasoningLevels` array), and routes that carry no
 * explicit `models` list at all (filled through `modelOverrides` instead).
 *
 * @module dsh-model-autofill/plan
 */
import { applyMargin, effortToLevel, matchModels, pickLimits, summarizeCapabilities } from "./modelsdev.js";

/** Exact catalog lookup (no family fallback) used by strict mode and overrides. */
function exactEntries(catalog, id) {
  const out = [];
  for (const [provider, entry] of Object.entries(catalog ?? {})) {
    for (const [key, model] of Object.entries(entry?.models ?? {})) {
      const base = key.includes("/") ? key.slice(key.lastIndexOf("/") + 1) : key;
      if (key === id || base === id) out.push({ provider, key, model });
    }
  }
  return out;
}

/**
 * Resolve the catalog evidence for one configured model id.
 *
 * In strict mode only explicitly declared mappings are honoured, and the
 * mapping is looked up exactly — the fail-closed posture.
 *
 * @returns `{ matches, entry, skipped }`; `skipped` explains a refusal.
 */
export function resolveEntry(catalog, id, config) {
  const mapping = config.mapping ?? {};
  if (config.strict === true) {
    const mapped = Object.hasOwn(mapping, id) ? mapping[id] : undefined;
    if (mapped === undefined) return { skipped: "not in the explicit mapping" };
    if (mapped === false) return { skipped: "disabled by the explicit mapping" };
    const matches = exactEntries(catalog, mapped);
    if (matches.length === 0) return { skipped: `mapped catalog id "${mapped}" not found` };
    return { matches, entry: matches[0] };
  }
  const matches = matchModels(catalog, id);
  if (matches.length === 0) return { skipped: "no catalog match" };
  const preferred = matches.find((entry) => entry.key.includes("/") && entry.key.slice(entry.key.lastIndexOf("/") + 1) === id) ?? matches[0];
  return { matches, entry: preferred };
}

/** Display name for one catalog entry, optionally vendor-prefixed. */
function displayName(entry, style) {
  const name = typeof entry?.model?.name === "string" && entry.model.name.length > 0 ? entry.model.name : undefined;
  if (name === undefined) return undefined;
  if (style !== "vendor") return name;
  const vendor = entry.key.includes("/") ? entry.key.slice(0, entry.key.indexOf("/")) : entry.provider;
  return `${vendor}: ${name}`;
}

/** Ordered modality list for a vision model, restricted to the live vocabulary. */
function modalitiesFor(shape) {
  const declared = shape.modalities?.values ?? ["text", "image"];
  const ordered = declared.filter((value) => value === "text" || value === "image");
  return ordered.includes("image") ? ordered : [...ordered, "image"];
}

/** Whether this route's protocol may receive a reasoning-effort declaration. */
function protocolAllowsReasoning(api, config) {
  if (config.forceReasoning === true) return true;
  if (api === undefined) return true;
  return (config.reasoningProtocols ?? []).includes(api);
}

/**
 * Plan one model row.
 *
 * @param args.model - the configured row (or a discovered id with no fields).
 * @param args.pathBase - op path prefix, e.g. `["providers","p","models",0]`.
 * @param args.profile - owning profile, for protocol checks.
 * @param args.shape - {@link describeSchema} result for the namespace.
 * @returns `{ ops, changes, notes, matched }`.
 */
export function planModel({ model, pathBase, profile, shape, catalog, config }) {
  const ops = [];
  const changes = [];
  const notes = [];
  const want = config.fill;

  const resolved = resolveEntry(catalog, model.id, config);
  if (resolved.skipped !== undefined) return { ops, changes, notes: [`${model.id}: ${resolved.skipped}`], matched: false };
  const { matches, entry } = resolved;
  const set = (key, value) => ops.push({ op: "set", path: [...pathBase, key], value });

  if (want.name && shape.fields?.name !== false) {
    const next = displayName(entry, config.nameStyle);
    const current = model.name;
    if (next !== undefined && next !== current && (current === undefined || current === model.id || config.force)) {
      set("name", next);
      changes.push(`name=${next}`);
    }
  }

  if (want.limits) {
    const limits = pickLimits(matches, model.id);
    if (limits.contextWindow !== undefined && (model.contextWindow === undefined || config.force)) {
      set("contextWindow", limits.contextWindow);
      changes.push(`contextWindow=${limits.contextWindow}`);
    }
    if (limits.maxTokens !== undefined && (model.maxTokens === undefined || config.force)) {
      const value = applyMargin(limits.maxTokens, config.margin);
      set("maxTokens", value);
      changes.push(`maxTokens=${value}`);
    }
  }

  const capabilities = summarizeCapabilities(matches);

  if (want.input && shape.modalities !== undefined && capabilities.vision) {
    const field = shape.modalities.field;
    const declared = Array.isArray(model[field]) ? model[field] : [];
    // A non-empty list is a user declaration: leave it alone unless forced.
    if (declared.length === 0 || (config.force && !declared.includes("image"))) {
      const next = modalitiesFor(shape);
      if (next.join(",") !== declared.join(",")) {
        set(field, next);
        changes.push(`${field}=[${next.join(",")}]`);
      }
    }
  }

  if (want.reasoning && shape.reasoning !== undefined && capabilities.reasoning) {
    if (!protocolAllowsReasoning(profile.api, config)) {
      notes.push(`${model.id}: reasoning skipped for protocol "${profile.api}" (set forceReasoning to override)`);
    } else {
      const raw = capabilities.efforts.length > 0 ? capabilities.efforts : capabilities.toggleOnly ? config.toggleLevels : [];
      const levels = [...new Set(raw.map(effortToLevel))];
      const known = levels.filter((level) => shape.reasoning.values.includes(level));
      for (const level of levels.filter((level) => !shape.reasoning.values.includes(level))) {
        notes.push(`${model.id}: unknown reasoning level "${level}" ignored`);
      }
      const usable = [...new Set(["off", ...known])].filter((level) => shape.reasoning.values.includes(level));
      if (!usable.some((level) => level !== "off")) {
        notes.push(`${model.id}: no usable reasoning level`);
      } else if (model[shape.reasoning.field] === undefined || config.force) {
        if (shape.reasoning.shape === "dict") {
          const map = {};
          for (const level of shape.reasoning.values) {
            if (usable.includes(level)) map[level] = level === "off" ? null : level;
          }
          set(shape.reasoning.field, map);
        } else {
          set(shape.reasoning.field, usable);
        }
        changes.push(`${shape.reasoning.field}=${usable.join("/")}`);
      }
    }
  }

  return { ops, changes, notes, matched: true };
}

/**
 * Plan a whole document (one namespace, every configured provider).
 *
 * @param args.document - one `settings.describe()` row.
 * @param args.shape - {@link describeSchema} result for that row.
 * @returns `{ ops, applied, skipped, notes }`.
 */
export function planDocument({ namespace, document, shape, catalog, config }) {
  const providers = document.value?.providers ?? {};
  const ops = [];
  const applied = [];
  const skipped = [];
  const notes = [];
  const allow = config.providers;
  const deny = config.excludeProviders ?? [];

  for (const [providerName, profile] of Object.entries(providers)) {
    if (Array.isArray(allow) && allow.length > 0 && !allow.includes(providerName)) continue;
    if (deny.includes(providerName)) {
      notes.push(`${providerName}: excluded by configuration`);
      continue;
    }
    const label = (text) => `${providerName}/${text}`;
    const collect = (result, name) => {
      ops.push(...result.ops);
      notes.push(...result.notes.map((note) => `${providerName}: ${note}`));
      if (result.changes.length > 0) applied.push(label(`${name}: ${result.changes.join(", ")}`));
      else skipped.push(label(name));
    };

    const models = Array.isArray(profile.models) ? profile.models : [];
    if (models.length > 0) {
      models.forEach((model, index) => {
        const result = planModel({
          model,
          pathBase: ["providers", providerName, "models", index],
          profile,
          shape,
          catalog,
          config
        });
        collect(result, model.id ?? `#${index}`);
      });
      continue;
    }

    if (shape.overridesKey !== undefined) {
      const overrides = profile[shape.overridesKey] ?? {};
      const ids = Object.keys(overrides);
      if (ids.length === 0) {
        notes.push(`${providerName}: no explicit models and no ${shape.overridesKey} entries; run provider_sync_models to discover ids first`);
        continue;
      }
      for (const id of ids) {
        const result = planModel({
          model: { id, ...overrides[id] },
          pathBase: ["providers", providerName, shape.overridesKey, id],
          profile,
          shape,
          catalog,
          config
        });
        collect(result, id);
      }
      continue;
    }

    notes.push(`${providerName}: no models configured`);
  }

  return { ops, applied, skipped, notes };
}
