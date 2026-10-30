/**
 * Self-checking logic tests for the pure modules (no DSH runtime required).
 *
 *   node test/logic.mjs
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describeSchema, extractEnums } from "../lib/schema.js";
import { loadCatalog, mergeCatalog, readSnapshot, SNAPSHOT_URL } from "../lib/catalog.js";
import { applyMargin, effortToLevel, matchModels, pickLimits, summarizeCapabilities } from "../lib/modelsdev.js";
import { probeBaseURL, discoverWithCredential, resolveApiKey } from "../lib/probe.js";
import { planDocument, planModel, resolveEntry } from "../lib/plan.js";

let passed = 0;
const test = async (label, fn) => {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${label}`);
  } catch (error) {
    console.error(`FAIL  ${label}\n      ${error.message}`);
    process.exitCode = 1;
  }
};
const section = (title) => console.log(`\n${title}`);

/* ---------------------------------------------------------------- schema */

// pi-ai shape: `input` array + `reasoningEfforts` union(false, dict(sKey)).
const piAiSchema = {
  uid: 1,
  refs: {
    "1": { type: "object", dict: { providers: 2 } },
    "2": { type: "dict", inner: 3 },
    "3": { type: "object", dict: { models: 4, modelOverrides: 9, apiKeyEnv: 10 } },
    "10": { type: "string" },
    "4": { type: "array", inner: 146 },
    "146": { type: "object", dict: { id: 145, name: 129, contextWindow: 132, maxTokens: 135, input: 141, reasoningEfforts: 143 } },
    "145": { type: "string" },
    "129": { type: "string" },
    "132": { type: "number" },
    "135": { type: "number" },
    "141": { type: "array", inner: 136 },
    "136": { type: "union", list: [138, 140] },
    "138": { type: "const", value: "text" },
    "140": { type: "const", value: "image" },
    "143": { type: "union", list: [142, 128] },
    "142": { type: "const", value: false },
    "128": { type: "dict", inner: 112, sKey: 113 },
    "113": { type: "union", list: [115, 117] },
    "115": { type: "const", value: "off" },
    "117": { type: "const", value: "high" },
    "112": { type: "union", list: [110, 111] },
    "9": { type: "dict", inner: 147 }
  }
};

// DeepSeek-adapter shape: different field names, `reasoningLevels` as an array.
const deepseekSchema = {
  uid: 1,
  refs: {
    "1": { type: "object", dict: { models: 4 } },
    "4": { type: "array", inner: 146 },
    "146": {
      type: "object",
      dict: { id: 145, name: 129, contextWindow: 132, maxTokens: 135, inputModalities: 141, reasoningLevels: 143 }
    },
    "145": { type: "string" },
    "129": { type: "string" },
    "132": { type: "number" },
    "135": { type: "number" },
    "141": { type: "array", inner: 136 },
    "136": { type: "union", list: [138, 140] },
    "138": { type: "const", value: "text" },
    "140": { type: "const", value: "image" },
    "143": { type: "array", inner: 144 },
    "144": { type: "union", list: [115, 117] },
    "115": { type: "const", value: "off" },
    "117": { type: "const", value: "high" }
  }
};

section("schema");
await test("reads pi-ai field names, literals and the overrides key", () => {
  const shape = describeSchema(piAiSchema);
  assert.equal(shape.modalities.field, "input");
  assert.deepEqual(shape.modalities.values, ["text", "image"]);
  assert.equal(shape.reasoning.field, "reasoningEfforts");
  assert.equal(shape.reasoning.shape, "dict");
  assert.deepEqual(shape.reasoning.values, ["off", "high"]);
  assert.equal(shape.overridesKey, "modelOverrides");
});
await test("reads the DeepSeek adapter's field names and array-shaped levels", () => {
  const shape = describeSchema(deepseekSchema);
  assert.equal(shape.modalities.field, "inputModalities");
  assert.equal(shape.reasoning.field, "reasoningLevels");
  assert.equal(shape.reasoning.shape, "array");
  assert.deepEqual(shape.reasoning.values, ["off", "high"]);
  assert.equal(shape.overridesKey, undefined);
});
await test("returns nothing for an unrelated schema", () => {
  assert.deepEqual(describeSchema({ refs: { "1": { type: "string" } } }), {});
  assert.deepEqual(describeSchema(undefined), {});
});
await test("extractEnums stays available for callers", () => {
  assert.deepEqual(extractEnums(piAiSchema), { modalities: ["text", "image"], levels: ["off", "high"] });
});

/* -------------------------------------------------------------- catalog */

section("catalog");
await test("loads the bundled snapshot that ships with the package", async () => {
  const snapshot = await readSnapshot(SNAPSHOT_URL);
  assert.ok(snapshot && Object.keys(snapshot).length > 100, "snapshot should hold the catalog");
  assert.ok(Object.keys(snapshot.deepseek?.models ?? {}).length > 0 || Object.keys(snapshot).some((p) => p.startsWith("deepseek")));
});
await test("merges layers per provider and per model key", () => {
  const merged = mergeCatalog(
    { a: { models: { m1: { name: "snapshot" }, m2: {} } } },
    { a: { models: { m1: { name: "live" }, m3: {} } }, b: { models: {} } }
  );
  assert.equal(merged.a.models.m1.name, "live");
  assert.deepEqual(Object.keys(merged.a.models).sort(), ["m1", "m2", "m3"]);
  assert.ok(merged.b);
});

const dir = await mkdtemp(join(process.cwd(), ".autofill-test-"));
const cacheFile = join(dir, "catalog.json");
const snapshot = { deepseek: { models: { "deepseek/deepseek-v4-pro": { limit: { context: 1000000, output: 384000 } } } } };
await test("falls back to the bundled snapshot when the network fails", async () => {
  const { catalog, sources } = await loadCatalog({
    snapshot,
    endpoint: "x",
    cacheFile: join(dir, "none.json"),
    fetchImpl: async () => ({ ok: false }),
    timeoutMs: 500
  });
  assert.deepEqual(sources, ["bundled"]);
  assert.ok(catalog.deepseek.models["deepseek/deepseek-v4-pro"]);
});
await test("layers a live fetch over the snapshot and caches it", async () => {
  let hits = 0;
  const fetchImpl = async () => {
    hits += 1;
    return { ok: true, json: async () => ({ reseller: { models: { "deepseek-v4-pro-0813": { limit: { context: 5, output: 5 } } } } }) };
  };
  const first = await loadCatalog({ snapshot, endpoint: "x", cacheFile, fetchImpl, timeoutMs: 500 });
  assert.deepEqual(first.sources, ["bundled", "live"]);
  assert.ok(first.catalog.reseller);
  const second = await loadCatalog({ snapshot, endpoint: "x", cacheFile, fetchImpl, timeoutMs: 500 });
  assert.deepEqual(second.sources, ["bundled", "cache"]);
  assert.equal(hits, 1, "the second load must not refetch");
});
await test("uses a stale cache when the network fails again", async () => {
  const { catalog, sources } = await loadCatalog({
    snapshot,
    endpoint: "x",
    cacheFile,
    ttlMs: -1,
    fetchImpl: async () => {
      throw new Error("offline");
    },
    timeoutMs: 200
  });
  assert.deepEqual(sources, ["bundled", "stale-cache"]);
  assert.ok(catalog.reseller, "the stale cache still contributes");
});

/* ------------------------------------------------------------- modelsdev */

section("modelsdev");
const catalog = {
  deepseek: {
    models: {
      "deepseek/deepseek-v4-pro": {
        id: "deepseek/deepseek-v4-pro",
        name: "DeepSeek V4 Pro",
        limit: { context: 1000000, output: 384000 },
        modalities: { input: ["text"] },
        reasoning: true,
        reasoning_options: [{ type: "effort", values: ["none", "minimal", "low", "medium", "high"] }]
      }
    }
  },
  reseller: {
    models: {
      "deepseek-v4-pro-0813": {
        id: "deepseek-v4-pro-0813",
        name: "DeepSeek V4 Pro 0813",
        limit: { context: 500000, output: 100000 },
        modalities: { input: ["text", "image"] },
        reasoning: true,
        reasoning_options: [{ type: "toggle" }]
      },
      "kimi-k2.6": {
        id: "kimi-k2.6",
        name: "Kimi K2.6",
        limit: { context: 262144, output: 262144 },
        modalities: { input: ["text", "image", "video"] },
        reasoning: true,
        reasoning_options: [{ type: "toggle" }]
      },
      "gpt-image-2.5": { id: "gpt-image-2.5", limit: { context: 0, output: 0 }, modalities: { input: ["text", "image"] }, reasoning: false }
    }
  }
};
await test("matches exact, canonical and case-insensitive ids", () => {
  assert.ok(matchModels(catalog, "deepseek-v4-pro").some((m) => m.key === "deepseek/deepseek-v4-pro"));
  assert.equal(matchModels(catalog, "Kimi-K2.6").length, 1);
});
await test("prefers canonical limits over an inflated family entry", () => {
  const limits = pickLimits(matchModels(catalog, "deepseek-v4-pro"), "deepseek-v4-pro");
  assert.equal(limits.contextWindow, 1000000);
  assert.equal(limits.maxTokens, 384000);
});
await test("ignores zero limits and unions capability signals", () => {
  assert.deepEqual(pickLimits(matchModels(catalog, "gpt-image-2.5"), "gpt-image-2.5"), {});
  const caps = summarizeCapabilities(matchModels(catalog, "deepseek-v4-pro"));
  assert.equal(caps.vision, true);
  assert.ok(caps.efforts.includes("none"));
});
await test("maps spellings and applies the output margin", () => {
  assert.equal(effortToLevel("none"), "off");
  assert.equal(applyMargin(384000, 0.85), 325632);
  assert.equal(applyMargin(100, 0.85), 4096);
});

/* ----------------------------------------------------------------- plan */

section("plan");
const baseConfig = {
  fill: { limits: true, input: true, reasoning: true, name: true },
  margin: 0.85,
  mapping: {},
  strict: false,
  force: false,
  forceReasoning: false,
  nameStyle: "plain",
  toggleLevels: ["off", "low", "high", "max"],
  reasoningProtocols: ["openai-completions", "openai-responses"],
  excludeProviders: [],
  providers: []
};
const relayDocument = (models, extra = {}) => ({
  ns: "llm-pi-ai",
  revision: 1,
  schema: piAiSchema,
  value: { providers: { relay: { api: "openai-completions", baseURL: "https://relay.test/v1", apiKeyEnv: "RELAY_API_KEY", models, ...extra } } }
});
const planFor = (document, config = {}) =>
  planDocument({
    namespace: document.ns,
    document,
    shape: describeSchema(document.schema),
    catalog,
    config: { ...baseConfig, ...config, fill: { ...baseConfig.fill, ...(config.fill ?? {}) } }
  });
const paths = (plan) => plan.ops.map((op) => op.path.join("."));

await test("fills limits, modalities, reasoning and name for a bare model", () => {
  const plan = planFor(relayDocument([{ id: "deepseek-v4-pro-0813" }]));
  assert.deepEqual(paths(plan), [
    "providers.relay.models.0.name",
    "providers.relay.models.0.contextWindow",
    "providers.relay.models.0.maxTokens",
    "providers.relay.models.0.input",
    "providers.relay.models.0.reasoningEfforts"
  ]);
  const byPath = Object.fromEntries(plan.ops.map((op) => [op.path.join("."), op.value]));
  assert.equal(byPath["providers.relay.models.0.contextWindow"], 500000);
  assert.deepEqual(byPath["providers.relay.models.0.input"], ["text", "image"]);
  assert.deepEqual(byPath["providers.relay.models.0.reasoningEfforts"], { off: null, high: "high" });
});
await test("never overwrites a configured field, unless forced", () => {
  const model = { id: "deepseek-v4-pro-0813", name: "My Name", contextWindow: 1000, maxTokens: 2000, input: ["text"], reasoningEfforts: { off: null } };
  const quiet = planFor(relayDocument([model]));
  assert.deepEqual(paths(quiet), [], "nothing to do");
  const forced = planFor(relayDocument([model]), { force: true });
  assert.ok(paths(forced).includes("providers.relay.models.0.contextWindow"));
});
await test("fills through modelOverrides when the route has no explicit list", () => {
  const document = relayDocument([], { modelOverrides: { "deepseek-v4-pro-0813": {} } });
  const plan = planFor(document);
  assert.ok(paths(plan).every((path) => path.startsWith("providers.relay.modelOverrides.deepseek-v4-pro-0813.")));
  assert.ok(paths(plan).includes("providers.relay.modelOverrides.deepseek-v4-pro-0813.contextWindow"));
});
await test("explains an empty catalog-backed route instead of failing", () => {
  const plan = planFor(relayDocument([]));
  assert.deepEqual(plan.ops, []);
  assert.ok(plan.notes.some((note) => note.includes("provider_sync_models")));
});
await test("strict mode fills only declared mappings (fail-closed)", () => {
  const unmapped = planFor(relayDocument([{ id: "deepseek-v4-pro-0813" }]), { strict: true });
  assert.deepEqual(unmapped.ops, []);
  assert.ok(unmapped.notes.some((note) => note.includes("not in the explicit mapping")));

  const mapped = planFor(relayDocument([{ id: "deepseek-v4-pro-0813" }]), {
    strict: true,
    mapping: { "deepseek-v4-pro-0813": "deepseek-v4-pro-0813" }
  });
  assert.ok(paths(mapped).includes("providers.relay.models.0.contextWindow"));
});
await test("strict mode honours an explicit opt-out", () => {
  const plan = planFor(relayDocument([{ id: "deepseek-v4-pro-0813" }]), { strict: true, mapping: { "deepseek-v4-pro-0813": false } });
  assert.deepEqual(plan.ops, []);
  assert.ok(plan.notes.some((note) => note.includes("disabled by the explicit mapping")));
});
await test("skips reasoning on a protocol it cannot spell, and says so", () => {
  const document = relayDocument([{ id: "deepseek-v4-pro-0813" }]);
  document.value.providers.relay.api = "anthropic-messages";
  const plan = planFor(document);
  assert.ok(!paths(plan).some((path) => path.endsWith("reasoningEfforts")));
  assert.ok(plan.notes.some((note) => note.includes("reasoning skipped for protocol")));
  const forced = planFor(document, { forceReasoning: true });
  assert.ok(paths(forced).includes("providers.relay.models.0.reasoningEfforts"));
});
await test("honours the vendor name style", () => {
  const plan = planFor(relayDocument([{ id: "deepseek-v4-pro" }]), { nameStyle: "vendor" });
  const name = plan.ops.find((op) => op.path.join(".").endsWith(".name"));
  assert.equal(name.value, "deepseek: DeepSeek V4 Pro");
});
await test("writes the DeepSeek adapter's field names and array-shaped levels", () => {
  const document = {
    ns: "llm-deepseek",
    revision: 1,
    schema: deepseekSchema,
    value: { providers: { official: { api: "openai-completions", models: [{ id: "deepseek-v4-pro-0813" }] } } }
  };
  const plan = planFor(document);
  assert.deepEqual(paths(plan), [
    "providers.official.models.0.name",
    "providers.official.models.0.contextWindow",
    "providers.official.models.0.maxTokens",
    "providers.official.models.0.inputModalities",
    "providers.official.models.0.reasoningLevels"
  ]);
  const byPath = Object.fromEntries(plan.ops.map((op) => [op.path.join("."), op.value]));
  assert.deepEqual(byPath["providers.official.models.0.inputModalities"], ["text", "image"]);
  assert.deepEqual(byPath["providers.official.models.0.reasoningLevels"], ["off", "high"]);
});
await test("excludes providers on request", () => {
  const plan = planFor(relayDocument([{ id: "deepseek-v4-pro-0813" }]), { excludeProviders: ["relay"] });
  assert.deepEqual(plan.ops, []);
  assert.ok(plan.notes.some((note) => note.includes("excluded by configuration")));
});
await test("resolveEntry reports why it refused", () => {
  assert.equal(resolveEntry(catalog, "nope", baseConfig).skipped, "no catalog match");
  assert.equal(resolveEntry(catalog, "nope", { ...baseConfig, strict: true }).skipped, "not in the explicit mapping");
});

/* ---------------------------------------------------------------- probe */

section("probe");
await test("adds /v1 when only the suffixed endpoint answers", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return url.endsWith("/v1/models") ? { ok: true, json: async () => ({ data: [{ id: "a" }, { id: "b" }] }) } : { ok: false, json: async () => ({}) };
  };
  const result = await probeBaseURL("https://relay.test", "k", 1000, fetchImpl);
  assert.equal(result.baseURL, "https://relay.test/v1");
  assert.deepEqual(result.models, ["a", "b"]);
  assert.deepEqual(calls, ["https://relay.test/models", "https://relay.test/v1/models"]);
});
await test("removes /v1 when only the bare endpoint answers", async () => {
  const fetchImpl = async (url) => (url === "https://relay.test/models" ? { ok: true, json: async () => ({ data: [{ id: "x" }] }) } : { ok: false });
  const result = await probeBaseURL("https://relay.test/v1", "k", 1000, fetchImpl);
  assert.equal(result.baseURL, "https://relay.test");
});
await test("tolerates other listing payload shapes", async () => {
  const shapes = [{ models: ["m1"] }, { results: [{ id: "m2" }] }, ["m3"]];
  for (const [index, payload] of shapes.entries()) {
    const result = await probeBaseURL(`https://s${index}.test`, "k", 500, async () => ({ ok: true, json: async () => payload }));
    assert.equal(result.probed, true);
  }
});
await test("keeps the user's spelling when nothing answers", async () => {
  const result = await probeBaseURL("https://dead.test/v1", "k", 300, async () => ({ ok: false, json: async () => ({}) }));
  assert.equal(result.baseURL, "https://dead.test/v1");
  assert.equal(result.probed, false);
});
await test("resolves a stored credential host-side, never from the caller", async () => {
  const seen = [];
  const ctx = { credentials: { resolve: async (ref) => (ref === "RELAY_API_KEY" ? { value: "sk-secret" } : undefined) } };
  assert.equal(await resolveApiKey(ctx, "RELAY_API_KEY"), "sk-secret");
  assert.equal(await resolveApiKey(ctx, "MISSING"), undefined);
  const discovery = await discoverWithCredential(
    { credentials: { resolve: async () => ({ value: "sk-secret" }) } },
    "https://relay.test",
    "RELAY_API_KEY",
    500
  );
  assert.equal(discovery.authenticated, true);
});
await test("reports authentication as unresolved rather than failing", async () => {
  const discovery = await discoverWithCredential(
    { credentials: { resolve: async () => undefined } },
    "https://relay.test",
    "RELAY_API_KEY",
    300
  );
  assert.equal(discovery.authenticated, false);
  assert.equal(discovery.probed, false);
});

await rm(dir, { recursive: true, force: true });
console.log(`\n${passed} checks passed${process.exitCode ? " (with failures)" : ""}`);
