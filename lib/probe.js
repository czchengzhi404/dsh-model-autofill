/**
 * Endpoint normalization and credential-safe model discovery.
 *
 * Relay operators are inconsistent about the `/v1` suffix, so we probe both
 * spellings instead of asking. Credential resolution happens host-side through
 * `ctx.credentials.resolve(ref)` — the same call `llm-pi-ai` itself makes — so a
 * stored key is used for the request and never surfaces to a tool result, a
 * client page, or the session log.
 *
 * @module dsh-model-autofill/probe
 */

/**
 * Probe an endpoint for the `/models` spelling it serves.
 *
 * @param base - the URL the user supplied.
 * @param apiKey - bearer token, or an empty string when the route is unauthenticated.
 * @param timeoutMs - per-attempt timeout.
 * @param fetchImpl - injectable fetch (tests).
 * @returns `{ baseURL, models, probed }`; when nothing answers, the user's own
 *   spelling is kept and `probed` is false.
 */
export async function probeBaseURL(base, apiKey, timeoutMs, fetchImpl = globalThis.fetch) {
  const trimmed = String(base).replace(/\/+$/, "");
  const candidates = /\/v\d+$/.test(trimmed)
    ? [trimmed, trimmed.replace(/\/v\d+$/, "")]
    : [trimmed, `${trimmed}/v1`];

  for (const candidate of candidates) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers = { accept: "application/json" };
      if (typeof apiKey === "string" && apiKey.length > 0) headers.authorization = `Bearer ${apiKey}`;
      const response = await fetchImpl(`${candidate}/models`, { signal: controller.signal, headers });
      if (!response.ok) continue;
      const payload = await response.json();
      const ids = (payload?.data ?? payload?.models ?? payload?.results ?? (Array.isArray(payload) ? payload : []))
        .map((entry) => (typeof entry === "string" ? entry : entry?.id))
        .filter((id) => typeof id === "string" && id.length > 0);
      if (ids.length > 0) return { baseURL: candidate, models: ids, probed: true };
    } catch {
      /* try the next spelling */
    } finally {
      clearTimeout(timer);
    }
  }
  return { baseURL: candidates[0], models: [], probed: false };
}

/**
 * Resolve the credential service, if this profile mounts one.
 *
 * @param ctx - plugin context.
 * @returns the service, or `undefined` when the profile has none.
 */
export function credentialsOf(ctx) {
  if (ctx?.credentials !== undefined) return ctx.credentials;
  try {
    return typeof ctx?.get === "function" ? ctx.get("credentials") : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Read a stored credential's value, host-side.
 *
 * @param ctx - plugin context carrying the `credentials` service.
 * @param ref - credential reference as written in `apiKeyEnv`.
 * @returns the secret, or `undefined` when the service or the record is absent.
 */
export async function resolveApiKey(ctx, ref) {
  if (typeof ref !== "string" || ref.length === 0) return undefined;
  const service = credentialsOf(ctx);
  try {
    const hit = await service?.resolve?.(ref);
    return typeof hit?.value === "string" && hit.value.length > 0 ? hit.value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Discover a route's live models using its stored credential.
 *
 * @returns `{ baseURL, models, probed, authenticated }`; `authenticated` is
 *   false when no stored credential could be resolved (the probe still runs, in
 *   case the endpoint is open).
 */
export async function discoverWithCredential(ctx, baseURL, apiKeyEnv, timeoutMs) {
  const apiKey = await resolveApiKey(ctx, apiKeyEnv);
  const result = await probeBaseURL(baseURL, apiKey, timeoutMs);
  return { ...result, authenticated: apiKey !== undefined || apiKeyEnv === undefined };
}
