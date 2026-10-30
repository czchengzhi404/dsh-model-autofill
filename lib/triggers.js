/**
 * Trigger wiring: fill on settings change, on config reload, at boot (bounded
 * retry ladder), and on a long recheck interval.
 *
 * This is what makes the plugin "save and forget": adding a provider or a model
 * in the Settings UI emits `settings/document-updated`, and the debounced pass
 * fills whatever is still missing. Nothing here writes back to the settings
 * service in response to its own write, because a pass whose plans are empty
 * performs no mutation at all.
 *
 * @module dsh-model-autofill/triggers
 */

/**
 * Wire every trigger and return a disposer.
 *
 * @param ctx - cordis context.
 * @param options.namespaces - namespaces whose document updates should trigger a pass.
 * @param options.debounceMs - quiet period before a settings-driven pass runs.
 * @param options.bootDelays - boot retry ladder; `run` throwing schedules the next rung.
 * @param options.recheckMs - interval for a periodic refresh pass (0 disables).
 * @param options.run - the pass; may throw to request a boot retry.
 * @param options.logger - optional cordis logger.
 * @returns a disposer that clears timers and event handlers.
 */
export function wireTriggers(ctx, options) {
  const { namespaces, debounceMs, bootDelays, recheckMs, run, logger } = options;
  const state = { disposed: false, debounce: undefined, boot: undefined, recheck: undefined, rung: 0 };
  const disposers = [];

  const warn = (message) => logger?.warn?.(message);

  const execute = async (reason) => {
    if (state.disposed) return;
    try {
      await run(reason);
    } catch (error) {
      warn(`model-autofill: ${reason} pass failed: ${error?.message ?? String(error)}`);
    }
  };

  const schedule = (reason) => {
    if (state.disposed) return;
    clearTimeout(state.debounce);
    state.debounce = setTimeout(() => void execute(reason), debounceMs);
  };

  const on = (event, handler) => {
    try {
      const dispose = ctx.on(event, handler);
      if (typeof dispose === "function") disposers.push(dispose);
    } catch {
      /* an event this build does not emit is simply never fired */
    }
  };

  on("settings/document-updated", (ns) => {
    if (namespaces.includes(ns)) schedule(`settings:${ns}`);
  });
  on("loader/volatile-update", () => schedule("config-reload"));
  on("app-boot/config-reload", () => schedule("config-reload"));

  const bootStep = () => {
    if (state.disposed) return;
    const delay = bootDelays[Math.min(state.rung, bootDelays.length - 1)];
    state.rung += 1;
    state.boot = setTimeout(async () => {
      if (state.disposed) return;
      try {
        await run("boot");
      } catch (error) {
        warn(`model-autofill: boot pass not ready: ${error?.message ?? String(error)}`);
        if (state.rung <= bootDelays.length) bootStep();
      }
    }, delay);
  };
  // An empty ladder means "no boot pass" — it must not degrade into "run now".
  if (bootDelays.length > 0) bootStep();

  if (typeof recheckMs === "number" && recheckMs > 0) {
    state.recheck = setInterval(() => void execute("recheck"), recheckMs);
    // A background recheck must never be the only thing keeping a process alive.
    if (typeof state.recheck?.unref === "function") state.recheck.unref();
  }

  return () => {
    state.disposed = true;
    clearTimeout(state.debounce);
    clearTimeout(state.boot);
    clearInterval(state.recheck);
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        /* ignore */
      }
    }
  };
}
