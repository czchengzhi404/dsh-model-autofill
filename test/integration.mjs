/**
 * Integration tests: drive the real `apply()` against an in-memory settings
 * service, exercising tool registration, plan → mutate, the settings trigger,
 * the boot ladder, strict mode and both credential import paths.
 *
 * Requires the peer dependencies (`@deepseek-ai/dsh-tools`, `schemastery`,
 * `cordis`) to be resolvable, so run it from an installed copy:
 *
 *   node test/integration.mjs
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { apply, Config } from "../lib/index.js";

const deadEndpoint = "http://127.0.0.1:1/nope";

/**
 * Hermetic catalog fixture: the integration test must not depend on the network
 * or on whatever models.dev currently publishes.
 */
const fixtureCatalog = {
  deepseek: {
    models: {
      "deepseek/deepseek-v4-pro": {
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
        name: "DeepSeek V4 Pro 0813",
        limit: { context: 500000, output: 100000 },
        modalities: { input: ["text", "image"] },
        reasoning: true,
        reasoning_options: [{ type: "toggle" }]
      }
    }
  }
};
/** Assigned once the temp directory exists. */
let snapshotPath = "";

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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------ fixtures */

const piAiSchema = {
  uid: 1,
  refs: {
    "1": { type: "object", dict: { providers: 2 } },
    "2": { type: "dict", inner: 3 },
    "3": { type: "object", dict: { models: 4, modelOverrides: 9, apiKeyEnv: 10, api: 11 } },
    "10": { type: "string" },
    "11": { type: "string" },
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
    "113": { type: "union", list: [115, 116, 117, 118] },
    "115": { type: "const", value: "off" },
    "116": { type: "const", value: "low" },
    "117": { type: "const", value: "high" },
    "118": { type: "const", value: "max" },
    "112": { type: "union", list: [110, 111] },
    "9": { type: "dict", inner: 147 },
    "147": { type: "object", dict: { name: 129, contextWindow: 132, maxTokens: 135, input: 141, reasoningEfforts: 143 } }
  }
};

/** Minimal in-memory stand-in for the settings service. */
function makeSettings(providers) {
  const state = { providers: JSON.parse(JSON.stringify(providers)) };
  let revision = 1;
  const setPath = (root, path, value) => {
    let node = root;
    for (let i = 0; i < path.length - 1; i += 1) {
      const key = path[i];
      const nextKey = path[i + 1];
      if (node[key] === undefined) node[key] = typeof nextKey === "number" ? [] : {};
      node = node[key];
    }
    node[path.at(-1)] = value;
  };
  const writes = [];
  return {
    describe: () => [{ ns: "llm-pi-ai", revision, schema: piAiSchema, value: { providers: state.providers } }],
    async mutate(ns, ops, expected) {
      if (ops.length === 0) return;
      if (expected !== revision) throw new Error(`revision conflict: expected ${expected}, at ${revision}`);
      for (const op of ops) setPath(state, op.path, op.value);
      revision += 1;
      writes.push(ops);
    },
    get value() {
      return state.providers;
    },
    get writes() {
      return writes;
    }
  };
}

function makeCtx(settings, credentials = {}) {
  const tools = new Map();
  const handlers = new Map();
  const setCalls = [];
  return {
    settings,
    credentials: {
      resolve: credentials.resolve ?? (async () => undefined),
      set: async (ref, value) => setCalls.push([ref, value])
    },
    tools: { register: (tool) => tools.set(tool.name, tool) },
    on: (event, handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      return () => {};
    },
    effect: (fn) => fn(),
    logger: { info() {}, warn() {} },
    // test helpers
    registered: tools,
    emit: (event, ...args) => (handlers.get(event) ?? []).forEach((handler) => handler(...args)),
    setCalls
  };
}

const baseConfig = (cacheFile, extra = {}) => ({
  namespaces: ["llm-pi-ai"],
  snapshotPath,
  endpoint: deadEndpoint,
  timeoutMs: 200,
  cacheFile,
  autoFillOnStart: false,
  watchSettings: false,
  recheckMs: 0,
  ...extra
});

const dir = await mkdtemp(join(process.cwd(), ".autofill-it-"));
const cacheFile = join(dir, "catalog.json");
snapshotPath = join(dir, "snapshot.json");
await writeFile(snapshotPath, JSON.stringify(fixtureCatalog), "utf8");

/* --------------------------------------------------------------- tests */

console.log("registration");
await test("registers its three tools and exposes a loadable Config", () => {
  const settings = makeSettings({ relay: { api: "openai-completions", models: [{ id: "deepseek-v4-pro" }] } });
  const ctx = makeCtx(settings);
  apply(ctx, Config(baseConfig(cacheFile)));
  assert.deepEqual([...ctx.registered.keys()].sort(), ["model_capabilities_autofill", "provider_import", "provider_sync_models"]);
});

console.log("autofill");
await test("dry-run reports planned edits without writing", async () => {
  const settings = makeSettings({
    relay: { api: "openai-completions", baseURL: "https://relay.test/v1", apiKeyEnv: "RELAY_API_KEY", models: [{ id: "deepseek-v4-pro" }] }
  });
  const ctx = makeCtx(settings);
  apply(ctx, Config(baseConfig(cacheFile)));
  const result = await ctx.registered.get("model_capabilities_autofill").execute({ dryRun: true });
  assert.match(result.summary, /dry-run/);
  assert.match(result.summary, /contextWindow=1000000/);
  assert.equal(settings.writes.length, 0, "dry-run must not write");
});

await test("applies the planned edits and is idempotent on a second pass", async () => {
  const settings = makeSettings({
    relay: { api: "openai-completions", baseURL: "https://relay.test/v1", apiKeyEnv: "RELAY_API_KEY", models: [{ id: "deepseek-v4-pro" }] }
  });
  const ctx = makeCtx(settings);
  apply(ctx, Config(baseConfig(cacheFile)));
  await ctx.registered.get("model_capabilities_autofill").execute({});
  const model = settings.value.relay.models[0];
  assert.equal(model.contextWindow, 1000000);
  assert.equal(model.name, "DeepSeek V4 Pro");
  assert.deepEqual(model.input, ["text", "image"]);
  assert.ok(model.reasoningEfforts.low === "low");
  const writesAfterFirst = settings.writes.length;
  await ctx.registered.get("model_capabilities_autofill").execute({});
  assert.equal(settings.writes.length, writesAfterFirst, "a completed config needs no second write");
});

await test("fills catalog-backed routes through modelOverrides", async () => {
  const settings = makeSettings({
    relay: { api: "openai-completions", baseURL: "https://relay.test/v1", apiKeyEnv: "RELAY_API_KEY", models: [], modelOverrides: { "deepseek-v4-pro": {} } }
  });
  const ctx = makeCtx(settings);
  apply(ctx, Config(baseConfig(cacheFile)));
  await ctx.registered.get("model_capabilities_autofill").execute({});
  assert.equal(settings.value.relay.modelOverrides["deepseek-v4-pro"].contextWindow, 1000000);
});

await test("strict mode writes nothing without a declared mapping", async () => {
  const settings = makeSettings({ relay: { api: "openai-completions", models: [{ id: "deepseek-v4-pro" }] } });
  const ctx = makeCtx(settings);
  apply(ctx, Config(baseConfig(cacheFile, { strict: true })));
  const result = await ctx.registered.get("model_capabilities_autofill").execute({});
  assert.equal(settings.writes.length, 0);
  assert.match(result.summary, /not in the explicit mapping/);
});

console.log("import");
await test("apiKeyEnv mode references a stored key and stores nothing", async () => {
  const settings = makeSettings({});
  const ctx = makeCtx(settings, { resolve: async (ref) => (ref === "MYRELAY_API_KEY" ? { value: "sk-stored" } : undefined) });
  // the endpoint is unreachable, so the model list must come from the caller
  apply(ctx, Config(baseConfig(cacheFile)));
  const result = await ctx.registered.get("provider_import").execute({
    name: "myrelay",
    baseURL: "https://relay.test",
    apiKeyEnv: "MYRELAY_API_KEY",
    models: "deepseek-v4-pro"
  });
  assert.equal(settings.value.myrelay.apiKeyEnv, "MYRELAY_API_KEY");
  assert.equal(settings.value.myrelay.api, "openai-completions");
  assert.equal(ctx.setCalls.length, 0, "a referenced credential must not be rewritten");
  assert.match(result.summary, /referenced/);
  assert.equal(settings.value.myrelay.models[0].contextWindow, 1000000, "the import also fills metadata");
});

await test("inline key mode stores the key and warns about the session", async () => {
  const settings = makeSettings({});
  const ctx = makeCtx(settings);
  apply(ctx, Config(baseConfig(cacheFile)));
  const result = await ctx.registered.get("provider_import").execute({
    name: "my-relay",
    baseURL: "https://relay.test/v1",
    apiKey: "sk-inline",
    models: "deepseek-v4-pro, gpt-image-2.5"
  });
  assert.deepEqual(ctx.setCalls, [["MY_RELAY_API_KEY", "sk-inline"]]);
  assert.equal(settings.value["my-relay"].apiKeyEnv, "MY_RELAY_API_KEY");
  assert.match(result.summary, /travelled through this session/);
});

console.log("triggers");
await test("a settings change schedules a debounced fill", async () => {
  const settings = makeSettings({
    relay: { api: "openai-completions", models: [{ id: "deepseek-v4-pro" }] }
  });
  const ctx = makeCtx(settings);
  apply(ctx, Config(baseConfig(cacheFile, { watchSettings: true, debounceMs: 20 })));
  assert.equal(settings.writes.length, 0, "nothing before the event");
  ctx.emit("settings/document-updated", "llm-pi-ai", 2);
  await sleep(150);
  assert.ok(settings.writes.length > 0, "the settings event should have produced a fill");
});

await test("an unrelated namespace does not trigger a fill", async () => {
  const settings = makeSettings({ relay: { api: "openai-completions", models: [{ id: "deepseek-v4-pro" }] } });
  const ctx = makeCtx(settings);
  apply(ctx, Config(baseConfig(cacheFile, { watchSettings: true, debounceMs: 20 })));
  ctx.emit("settings/document-updated", "some-other-plugin", 2);
  await sleep(120);
  assert.equal(settings.writes.length, 0);
});

await test("the boot ladder fills shortly after start", async () => {
  const settings = makeSettings({ relay: { api: "openai-completions", models: [{ id: "deepseek-v4-pro" }] } });
  const ctx = makeCtx(settings);
  apply(ctx, Config(baseConfig(cacheFile, { watchSettings: true, autoFillOnStart: true, bootDelays: [20] })));
  await sleep(200);
  assert.ok(settings.writes.length > 0, "the boot rung should have filled");
});

await rm(dir, { recursive: true, force: true });
console.log(`\n${passed} checks passed${process.exitCode ? " (with failures)" : ""}`);
