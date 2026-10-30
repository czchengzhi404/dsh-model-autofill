/**
 * Live shape + vocabulary extraction from a schemastery schema.
 *
 * Nothing about DSH's config surface is hard-coded here. Both the field names
 * (`input` vs `inputModalities`, `reasoningEfforts` vs `reasoningLevels`) and
 * the accepted literals are read from the schema JSON that
 * `settings.describe()` already exposes, so an upgraded harness — or a second
 * adapter namespace with different field names — is handled automatically.
 *
 * `schema.toJSON()` serializes to `{ uid, refs }`, a flat table where children
 * are numeric references:
 *
 *   refs["141"] = { type: "array", inner: 136 }
 *   refs["136"] = { type: "union", list: [138, 140] }
 *   refs["138"] = { type: "const", value: "text" }
 *
 * Two wrinkles: a reasoning dict stores its key constraint as `sKey`, and it
 * usually sits inside `z.union([z.const(false), dict])`.
 *
 * @module dsh-model-autofill/schema
 */

/** Follow one numeric/string reference into the refs table. */
function resolveRef(refs, node) {
  if (typeof node === "number" || typeof node === "string") return refs[String(node)];
  return node;
}

/** Collect every `const` string literal reachable from a schema node. */
function literals(refs, node, acc = new Set(), depth = 0) {
  const resolved = resolveRef(refs, node);
  if (resolved === null || typeof resolved !== "object" || depth > 8) return acc;
  if (resolved.type === "const" || resolved.type === "literal") {
    const value = resolved.value ?? resolved.literal;
    if (typeof value === "string") acc.add(value);
  }
  const children = [];
  if (Array.isArray(resolved.list)) children.push(...resolved.list);
  if (resolved.inner !== undefined) children.push(resolved.inner);
  if (resolved.sKey !== undefined) children.push(resolved.sKey);
  for (const child of children) literals(refs, child, acc, depth + 1);
  return acc;
}

/** First `dict` node reachable from a schema node (handles unions of a dict). */
function firstDict(refs, node, depth = 0) {
  const resolved = resolveRef(refs, node);
  if (resolved === null || typeof resolved !== "object" || depth > 6) return undefined;
  if (resolved.type === "dict") return resolved;
  const children = [];
  if (Array.isArray(resolved.list)) children.push(...resolved.list);
  if (resolved.inner !== undefined) children.push(resolved.inner);
  for (const child of children) {
    const found = firstDict(refs, child, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Every `dict` node in the table, resolved. */
function dictNodes(refs) {
  const out = [];
  for (const node of Object.values(refs)) {
    if (node !== null && typeof node === "object" && node.dict !== undefined) out.push(node);
  }
  return out;
}

/**
 * Describe one configurable entry's model shape.
 *
 * @param schemaJson - a schema serialized by `toJSON()`, or its bare `refs` table.
 * @returns `{ modalities, reasoning, overridesKey, fields }`; every part is
 *   `undefined` when the schema is not a model-bearing config entry.
 */
export function describeSchema(schemaJson) {
  const refs = schemaJson?.refs ?? schemaJson;
  if (refs === null || typeof refs !== "object") return {};

  const dicts = dictNodes(refs);
  const modelNode = dicts.find((node) => node.dict.contextWindow !== undefined && node.dict.maxTokens !== undefined);
  if (modelNode === undefined) return {};
  const profileNode = dicts.find(
    (node) => node.dict.modelOverrides !== undefined || (node.dict.models !== undefined && node.dict.apiKeyEnv !== undefined)
  );

  const modalityField = ["input", "inputModalities"].find((field) => modelNode.dict[field] !== undefined);
  const reasoningField = ["reasoningEfforts", "reasoningLevels"].find((field) => modelNode.dict[field] !== undefined);

  let reasoning;
  if (reasoningField !== undefined) {
    const node = resolveRef(refs, modelNode.dict[reasoningField]);
    const dict = firstDict(refs, node);
    reasoning = {
      field: reasoningField,
      values: [...literals(refs, dict?.sKey ?? node)],
      shape: dict === undefined ? "array" : "dict"
    };
  }

  return {
    modalities:
      modalityField === undefined
        ? undefined
        : { field: modalityField, values: [...literals(refs, modelNode.dict[modalityField])] },
    reasoning,
    overridesKey: profileNode?.dict?.modelOverrides !== undefined ? "modelOverrides" : undefined,
    fields: {
      name: modelNode.dict.name !== undefined,
      contextWindow: modelNode.dict.contextWindow !== undefined,
      maxTokens: modelNode.dict.maxTokens !== undefined
    }
  };
}

/** Backwards-compatible helper used by earlier callers and tests. */
export function extractEnums(schemaJson) {
  const shape = describeSchema(schemaJson);
  return { modalities: shape.modalities?.values ?? [], levels: shape.reasoning?.values ?? [] };
}
