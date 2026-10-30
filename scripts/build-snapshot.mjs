/**
 * Build the bundled offline snapshot of the models.dev catalog.
 *
 *   node scripts/build-snapshot.mjs [endpoint]
 *
 * Keeps only the fields the plugin reads, so the shipped file stays small while
 * the runtime merge logic sees exactly the same shape as the live API.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outFile = join(here, "..", "data", "models.dev.json");
const endpoint = process.argv[2] ?? "https://models.dev/api.json";

const response = await fetch(endpoint, { headers: { accept: "application/json" } });
if (!response.ok) throw new Error(`fetch failed: HTTP ${response.status}`);
const catalog = await response.json();

/** Keep one model record, or `undefined` when it carries nothing we use. */
function slimModel(model) {
  const input = model?.modalities?.input;
  const options = Array.isArray(model?.reasoning_options) ? model.reasoning_options : undefined;
  const limit = model?.limit;
  const kept = {
    ...(typeof model?.name === "string" ? { name: model.name } : {}),
    ...(limit && (limit.context || limit.output) ? { limit: { context: limit.context ?? 0, output: limit.output ?? 0 } } : {}),
    ...(Array.isArray(input) && input.length > 0 ? { modalities: { input } } : {}),
    ...(model?.reasoning === true ? { reasoning: true } : {}),
    ...(options === undefined
      ? {}
      : {
          reasoning_options: options.map((option) =>
            option?.type === "effort" && Array.isArray(option.values)
              ? { type: "effort", values: option.values.map(String) }
              : { type: String(option?.type ?? "toggle") }
          )
        })
  };
  return Object.keys(kept).length === 0 ? undefined : kept;
}

const slim = {};
let models = 0;
for (const [provider, entry] of Object.entries(catalog ?? {})) {
  const source = entry?.models;
  if (source === null || typeof source !== "object") continue;
  const kept = {};
  for (const [key, model] of Object.entries(source)) {
    const row = slimModel(model);
    if (row === undefined) continue;
    kept[key] = row;
    models += 1;
  }
  if (Object.keys(kept).length > 0) slim[provider] = { models: kept };
}

await mkdir(dirname(outFile), { recursive: true });
await writeFile(outFile, JSON.stringify(slim), "utf8");
console.log(`wrote ${outFile}`);
console.log(`providers=${Object.keys(slim).length} models=${models}`);
