/**
 * dsh-model-autofill — provider onboarding + capability autofill for DSH.
 *
 * Two halves, both going through the same config-editor path the Settings UI
 * uses (`ctx.settings.mutate`, revision-checked, landing in `cordis.patch.yml`):
 *
 *  1. **Onboarding** — `provider_import` takes a baseURL plus an API-key
 *     reference (recommended) or an inline key (opt-in), probes `/models` to
 *     settle the `/v1` suffix, writes the provider, and stores the key in the
 *     DSH credential store so only `apiKeyEnv` reaches the config file.
 *     `provider_sync_models` discovers a route's live models and adds them.
 *  2. **Autofill** — `contextWindow`, `maxTokens`, `input`/`inputModalities`,
 *     `reasoningEfforts`/`reasoningLevels` and `name` are filled from
 *     models.dev, per model, never with a uniform guess. Field names and
 *     accepted levels are read from the live schema, not hard-coded.
 *
 * Runs at boot (bounded retry ladder), on `settings/document-updated` and
 * config reload (debounced), and on a long recheck interval; every pass fills
 * only what is still missing, so a pass with nothing to do writes nothing.
 *
 * @module dsh-model-autofill
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";

import { SNAPSHOT_URL, loadCatalog, readSnapshot } from "./catalog.js";
import { describeSchema } from "./schema.js";
import { discoverWithCredential, probeBaseURL, resolveApiKey } from "./probe.js";
import { planDocument } from "./plan.js";
import { wireTriggers } from "./triggers.js";

export const name = "model-autofill";
/**
 * `credentials` is deliberately NOT injected: some profiles (a bare headless
 * one, for instance) mount no credential service, and a hard dependency would
 * leave the plugin permanently pending. It is looked up lazily instead, and the
 * one feature that needs it (storing an inline key) reports clearly when absent.
 */
export const inject = ["settings", "tools"];

/**
 * Shared tool output contract.
 *
 * `defineTool` compiles a value schema with `allowRequired: false` and demands
 * an explicit `additionalProperties`, so the object stays flat and unmarked.
 */
export const TOOL_OUTPUT = {
  schema: {
    type: "object",
    properties: { summary: { type: "string" } },
    additionalProperties: false
  },
  render: (_args, value) => [{ type: "text", text: String(value?.summary ?? "") }]
};

/**
 * Mark a config field as user-editable, when the installed schemastery can.
 *
 * `.volatile()` exists in the schemastery shipped with current DSH releases but
 * not in older ones — and a profile may resolve an older runtime's copy, in
 * which case calling it throws while the module is loading. Degrading to an
 * unmarked field keeps the plugin loadable; the native settings form then simply
 * omits that option.
 */
const mark = (schema) => (typeof schema?.volatile === "function" ? schema.volatile() : schema);

/**
 * Plugin options.
 *
 * Every user-facing option is marked volatile: that is what makes DSH's
 * built-in settings form render it (`dsh-settings` only builds a form for
 * entries that declare volatile fields). No client-side code is needed — the
 * shell's generic form editor writes the change back into `cordis.patch.yml`.
 * Deployment paths (`cacheFile`, `snapshotPath`) stay unmarked.
 */
export const Config = z.object({
  enabled: mark(z.boolean().default(true)),
  /** Configurable entries to audit; the first is the pi-ai adapter, the second the DeepSeek one. */
  namespaces: mark(z.array(z.string()).default(["llm-pi-ai", "llm-deepseek"])),
  autoFillOnStart: mark(z.boolean().default(true)),
  watchSettings: mark(z.boolean().default(true)),
  debounceMs: mark(z.number().default(800)),
  bootDelays: mark(z.array(z.number()).default([1000, 3000, 8000])),
  recheckMs: mark(z.number().default(6 * 3600 * 1000)),
  /** Overwrite existing, non-empty fields. */
  force: mark(z.boolean().default(false)),
  /** Fail-closed: only fill ids present in `mapping`. */
  strict: mark(z.boolean().default(false)),
  mapping: mark(z.dict(z.union([z.string(), z.const(false)])).default({})),
  providers: mark(z.array(z.string()).default([])),
  excludeProviders: mark(z.array(z.string()).default([])),
  fill: z
    .object({
      limits: mark(z.boolean().default(true)),
      input: mark(z.boolean().default(true)),
      reasoning: mark(z.boolean().default(true)),
      name: mark(z.boolean().default(true))
    })
    .default({}),
  nameStyle: mark(z.union([z.const("plain"), z.const("vendor")]).default("plain")),
  /** Protocols whose reasoning wire spelling this plugin is confident about. */
  reasoningProtocols: mark(z.array(z.string()).default(["openai-completions", "openai-responses"])),
  forceReasoning: mark(z.boolean().default(false)),
  toggleLevels: mark(z.array(z.string()).default(["off", "low", "high", "max"])),
  margin: mark(z.number().default(0.85)),
  endpoint: mark(z.string().default("https://models.dev/api.json")),
  cacheTtlMs: mark(z.number().default(24 * 3600 * 1000)),
  cacheFile: z.string(),
  snapshotPath: z.string(),
  timeoutMs: mark(z.number().default(20000)),
  credentialRef: mark(z.string().default("{NAME}_API_KEY"))
});

/** The upper-cased, `_`-separated form of a provider key. */
function constantCase(value) {
  return value
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
}

/** Build the credential reference for one provider. */
export function credentialRefFor(provider, template) {
  return template.replace(/\{NAME\}/g, constantCase(provider));
}

/** Default catalog cache path under the DSH home. */
function defaultCacheFile() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.length > 0 ? process.env.DSH_HOME : join(homedir(), ".dsh");
  return join(home, "cache", "dsh-model-autofill", "modelsdev.json");
}

/** Parse a comma/newline/space separated model list. */
export function parseModelList(text) {
  if (typeof text !== "string") return undefined;
  const ids = text
    .split(/[\s,]+/)
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  return ids.length === 0 ? undefined : [...new Set(ids)];
}

/** Keep configured model entries, appending newly named ids in order. */
export function mergeModelList(existing, ids) {
  const rows = Array.isArray(existing) ? existing.map((row) => ({ ...row })) : [];
  const known = new Set(rows.map((row) => row?.id));
  for (const id of ids) {
    if (known.has(id)) continue;
    known.add(id);
    rows.push({ id, name: id });
  }
  return rows;
}

/** Render a change report as plain text. */
export function renderReport(title, result, dryRun) {
  const lines = [title, dryRun ? "mode: dry-run (nothing written)" : "mode: applied"];
  if (result.applied?.length > 0) lines.push("", "changed:", ...result.applied.map((line) => `  - ${line}`));
  if (result.skipped?.length > 0) lines.push("", `already complete or unmatched (${result.skipped.length}): ${result.skipped.join(", ")}`);
  if (result.notes?.length > 0) lines.push("", "notes:", ...result.notes.map((note) => `  - ${note}`));
  return lines.join("\n");
}

/**
 * Unwrap cordis' volatile-config accessors into plain data.
 *
 * A field marked `.volatile()` reaches the plugin as a reactive accessor with
 * `.get()` — that is how a settings-form edit reaches a running plugin. Reading
 * through `.get()` recursively yields plain values, so every pass sees the
 * current options instead of a snapshot taken at boot.
 *
 * @param value - a resolved config value, possibly an accessor tree.
 * @returns plain data.
 */
export function plain(value) {
  if (value === null || typeof value !== "object") return value;
  if (typeof value.get === "function") return plain(value.get());
  if (Array.isArray(value)) return value.map((entry) => plain(entry));
  const out = {};
  for (const [key, entry] of Object.entries(value)) out[key] = plain(entry);
  return out;
}

/**
 * Register the plugin.
 *
 * @param ctx - cordis context carrying `settings`, `credentials`, and `tools`.
 * @param config - resolved plugin configuration (volatile fields are accessors).
 */
export function apply(ctx, config) {
  /** Merge defaults over the current, unwrapped options. */
  const readOptions = () => {
    const raw = plain(config ?? {});
    return {
      ...raw,
      namespaces: raw.namespaces ?? ["llm-pi-ai", "llm-deepseek"],
      excludeProviders: raw.excludeProviders ?? [],
      providers: raw.providers ?? [],
      mapping: raw.mapping ?? {},
      bootDelays: raw.bootDelays ?? [1000, 3000, 8000],
      reasoningProtocols: raw.reasoningProtocols ?? ["openai-completions", "openai-responses"],
      toggleLevels: raw.toggleLevels ?? ["off", "low", "high", "max"],
      fill: { limits: true, input: true, reasoning: true, name: true, ...(raw.fill ?? {}) },
      margin: raw.margin ?? 0.85,
      endpoint: raw.endpoint ?? "https://models.dev/api.json",
      cacheTtlMs: raw.cacheTtlMs ?? 24 * 3600 * 1000,
      timeoutMs: raw.timeoutMs ?? 20000,
      debounceMs: raw.debounceMs ?? 800,
      recheckMs: raw.recheckMs ?? 6 * 3600 * 1000,
      credentialRef: raw.credentialRef ?? "{NAME}_API_KEY",
      strict: raw.strict === true,
      force: raw.force === true,
      forceReasoning: raw.forceReasoning === true,
      nameStyle: raw.nameStyle ?? "plain",
      enabled: raw.enabled !== false,
      autoFillOnStart: raw.autoFillOnStart !== false,
      watchSettings: raw.watchSettings !== false
    };
  };

  // Wiring-time snapshot: namespaces and timers are fixed when the plugin starts.
  // Every pass re-reads the options so a settings-form edit applies immediately.
  const wiring = readOptions();

  /** Locate the settings form for one configurable plugin entry. */
  const findDocument = (namespace) => ctx.settings.describe().find((document) => document.ns === namespace);

  /** Load the catalog: bundled snapshot, then cache, then live. */
  async function catalog() {
    const resolved = readOptions();
    const snapshot = await readSnapshot(
      resolved.snapshotPath === undefined ? SNAPSHOT_URL : pathToFileURL(resolved.snapshotPath)
    );
    return loadCatalog({
      snapshot,
      endpoint: resolved.endpoint,
      cacheFile: resolved.cacheFile ?? defaultCacheFile(),
      ttlMs: resolved.cacheTtlMs,
      timeoutMs: resolved.timeoutMs
    });
  }

  /** Write ops against a freshly described document (revision-checked). */
  async function mutate(namespace, ops) {
    if (ops.length === 0) return;
    const document = findDocument(namespace);
    if (document === undefined) throw new Error(`dsh-model-autofill: no configurable entry "${namespace}"`);
    await ctx.settings.mutate(namespace, ops, document.revision);
  }

  /** Fill one provider or every configured provider. */
  async function fill({ provider, dryRun, force, reason = "manual" } = {}) {
    const resolved = readOptions();
    const { catalog: data, sources } = await catalog();
    const applied = [];
    const skipped = [];
    const notes = [];
    let writes = 0;

    for (const namespace of resolved.namespaces) {
      const document = findDocument(namespace);
      if (document === undefined) continue;
      const shape = describeSchema(document.schema);
      if (shape.fields === undefined) continue;

      const scoped = provider === undefined ? document : restrictToProvider(document, provider);
      if (scoped === undefined) continue;

      const plan = planDocument({
        namespace,
        document: scoped,
        shape,
        catalog: data,
        config: { ...resolved, force: force ?? resolved.force }
      });
      if (!dryRun && plan.ops.length > 0) {
        await mutate(namespace, plan.ops);
        writes += plan.ops.length;
      }
      applied.push(...plan.applied.map((line) => `${namespace}: ${line}`));
      skipped.push(...plan.skipped.map((line) => `${namespace}: ${line}`));
      notes.push(...plan.notes.map((line) => `${namespace}: ${line}`));
    }

    notes.unshift(`catalog sources: ${sources.join(" + ") || "none"}; pass: ${reason}`);
    return { ops: writes, applied, skipped, notes, sources };
  }

  /** Narrow a described document to one provider without mutating the original. */
  function restrictToProvider(document, provider) {
    const profile = document.value?.providers?.[provider];
    if (profile === undefined) return undefined;
    return { ...document, value: { ...document.value, providers: { [provider]: profile } } };
  }

  const autofillTool = defineTool({
    name: "model_capabilities_autofill",
    description:
      "Fill missing model metadata (contextWindow, maxTokens, input/inputModalities, reasoning levels, display name) from models.dev. Fills only empty fields unless `force` is set; `dryRun` reports the intended edits without writing.",
    parameters: {
      provider: { type: "string", description: "Provider route key; omit to audit every configured provider." },
      force: { type: "boolean", description: "Overwrite fields that already carry a value." },
      dryRun: { type: "boolean", description: "Report the intended edits without writing." }
    },
    output: TOOL_OUTPUT,
    async execute(args) {
      const result = await fill({ provider: args.provider, dryRun: args.dryRun === true, force: args.force === true });
      return { summary: renderReport("model capabilities", result, args.dryRun === true) };
    },
    presentCall(args) {
      return { card: "generic", title: `Autofill model capabilities${args.provider ? ` (${args.provider})` : ""}`, kind: "read" };
    }
  });

  const importTool = defineTool({
    name: "provider_import",
    description:
      "Import an OpenAI-compatible provider: probe and normalize the base URL (/v1 added or removed), write the provider into the config, and fill each model's metadata. Prefer `apiKeyEnv` (a credential name) so no secret passes through the session; `apiKey` stores the key in the DSH credential store instead.",
    parameters: {
      name: { type: "string", required: true, description: "Provider route key, e.g. `myrelay`." },
      baseURL: { type: "string", required: true, description: "Endpoint host or full URL; `/v1` is added or removed to match what the endpoint serves." },
      apiKeyEnv: { type: "string", description: "Credential name to reference (recommended). The key is read host-side from the DSH credential store and never appears in this conversation." },
      apiKey: { type: "string", description: "Inline key, stored in the DSH credential store. Note: passing a secret through the session means the transcript may retain it." },
      models: { type: "string", description: "Comma or newline separated model ids. Omit to adopt everything `/models` advertises." },
      displayName: { type: "string", description: "Human-readable provider name." },
      dryRun: { type: "boolean", description: "Report the intended edits without writing." }
    },
    output: TOOL_OUTPUT,
    async execute(args) {
      const resolved = readOptions();
      const namespace = resolved.namespaces[0] ?? "llm-pi-ai";
      const document = findDocument(namespace);
      if (document === undefined) throw new Error(`dsh-model-autofill: no configurable entry "${namespace}"`);

      const credentialRef = args.apiKeyEnv ?? credentialRefFor(args.name, resolved.credentialRef);
      const probeKey = args.apiKey ?? (await resolveApiKey(ctx, credentialRef));
      const probe = await probeBaseURL(args.baseURL, probeKey, resolved.timeoutMs);
      const requested = parseModelList(args.models);
      const ids = requested ?? probe.models;
      if (ids === undefined || ids.length === 0) {
        throw new Error("dsh-model-autofill: no models to import — pass `models`, or make the endpoint answer GET /models");
      }

      const providers = document.value?.providers ?? {};
      const existing = providers[args.name] ?? {};
      const profile = {
        ...existing,
        api: "openai-completions",
        baseURL: probe.baseURL,
        apiKeyEnv: credentialRef,
        models: mergeModelList(existing.models, ids),
        ...(args.displayName === undefined ? {} : { displayName: args.displayName })
      };
      const dryRun = args.dryRun === true;
      if (!dryRun) {
        await mutate(namespace, [{ op: "set", path: ["providers", args.name], value: profile }]);
        if (typeof args.apiKey === "string" && args.apiKey.length > 0) await ctx.credentials.set(credentialRef, args.apiKey);
      }

      const lines = [
        `provider "${args.name}" ${dryRun ? "would be" : "is"} configured`,
        `  baseURL: ${probe.baseURL}${probe.probed ? " (probed)" : " (endpoint did not answer /models; kept as given)"}`,
        `  credential: ${credentialRef}${
          args.apiKey !== undefined && args.apiKey.length > 0
            ? dryRun
              ? " (would be stored; the key travelled through this session)"
              : " (stored; note the key travelled through this session)"
            : " (referenced; resolve it from the credential store)"
        }`,
        `  models: ${ids.length}`
      ];
      const filled = await fill({ provider: args.name, dryRun });
      return { summary: `${lines.join("\n")}\n\n${renderReport("model metadata", filled, dryRun)}` };
    },
    presentCall(args) {
      return { card: "generic", title: `Import provider ${args.name}`, kind: "write" };
    }
  });

  const syncTool = defineTool({
    name: "provider_sync_models",
    description:
      "Discover a configured provider's live models from its /models endpoint (using its stored credential) and add the ones the config does not list yet — into `models`, or into `modelOverrides` for catalog-backed routes that carry no explicit list — then fill their metadata.",
    parameters: {
      provider: { type: "string", required: true, description: "Provider route key." },
      models: { type: "string", description: "Comma or newline separated ids to add; omit to add everything the endpoint advertises." },
      dryRun: { type: "boolean", description: "Report the intended edits without writing." }
    },
    output: TOOL_OUTPUT,
    async execute(args) {
      const resolved = readOptions();
      const namespace = resolved.namespaces.find((ns) => findDocument(ns)?.value?.providers?.[args.provider] !== undefined);
      const document = namespace === undefined ? undefined : findDocument(namespace);
      if (namespace === undefined || document === undefined) {
        throw new Error(`dsh-model-autofill: provider "${args.provider}" is not configured in any watched namespace`);
      }
      const shape = describeSchema(document.schema);
      const profile = document.value.providers[args.provider];
      const discovery = await discoverWithCredential(ctx, profile.baseURL, profile.apiKeyEnv, resolved.timeoutMs);
      const ids = parseModelList(args.models) ?? discovery.models;
      if (ids.length === 0) throw new Error("dsh-model-autofill: the endpoint advertised no models and no list was passed");
      const dryRun = args.dryRun === true;

      const ops = [];
      let added = 0;
      if (Array.isArray(profile.models) && profile.models.length > 0) {
        const merged = mergeModelList(profile.models, ids);
        added = merged.length - profile.models.length;
        if (added > 0) ops.push({ op: "set", path: ["providers", args.provider, "models"], value: merged });
      } else if (shape.overridesKey !== undefined) {
        const overrides = { ...(profile[shape.overridesKey] ?? {}) };
        for (const id of ids) {
          if (Object.hasOwn(overrides, id)) continue;
          overrides[id] = {};
          added += 1;
        }
        if (added > 0) ops.push({ op: "set", path: ["providers", args.provider, shape.overridesKey], value: overrides });
      } else {
        throw new Error(`dsh-model-autofill: provider "${args.provider}" has no models list and its namespace exposes no overrides dict`);
      }

      if (!dryRun && ops.length > 0) await mutate(namespace, ops);
      const filled = await fill({ provider: args.provider, dryRun });
      const header = [
        `provider "${args.provider}": ${added} new model id(s) ${dryRun ? "would be" : ""} added`,
        `  /models: ${discovery.probed ? discovery.baseURL : "unreachable (kept the configured baseURL)"}`,
        `  credential: ${discovery.authenticated ? "resolved" : "not resolvable (probe ran unauthenticated)"}`
      ].join("\n");
      return { summary: `${header}\n\n${renderReport("model metadata", filled, dryRun)}` };
    },
    presentCall(args) {
      return { card: "generic", title: `Sync models for ${args.provider}`, kind: "write" };
    }
  });

  ctx.tools.register(autofillTool);
  ctx.tools.register(importTool);
  ctx.tools.register(syncTool);

  if (wiring.enabled && wiring.watchSettings) {
    ctx.logger?.info?.(
      "model-autofill: ready; watching %s (%s), fill=%s, strict=%s",
      wiring.namespaces.join(", "),
      wiring.autoFillOnStart ? "boot+runtime" : "runtime only",
      Object.entries(wiring.fill)
        .filter(([, on]) => on)
        .map(([key]) => key)
        .join("/"),
      wiring.strict
    );
    const dispose = wireTriggers(ctx, {
      namespaces: wiring.namespaces,
      debounceMs: wiring.debounceMs,
      bootDelays: wiring.autoFillOnStart ? wiring.bootDelays : [],
      recheckMs: wiring.recheckMs,
      logger: ctx.logger,
      run: async (reason) => {
        const result = await fill({ dryRun: false, reason });
        if (result.ops > 0) ctx.logger?.info?.("model-autofill: %s pass wrote %d field(s)", reason, result.ops);
      }
    });
    if (typeof ctx.effect === "function") ctx.effect(() => dispose);
    else if (typeof ctx.on === "function") ctx.on("dispose", dispose);
  }
}
