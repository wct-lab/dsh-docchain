/**
 * Tool definition helpers for dsh-docchain.
 *
 * Converges on the conventions a working DSH tool plugin (dsh-weekly-researcher)
 * already follows, because each of these is a hard requirement of the Harness
 * rather than a style preference:
 *
 *  - `description` is model-facing: state what the tool does and the gate the
 *    caller must respect;
 *  - `execute` NEVER throws — a thrown error reaches the model as an
 *    unstructured failure. Every exit returns structured, lossless JSON;
 *  - the returned value must be lossless JSON. `undefined`, `NaN` and
 *    `Infinity` make DSH reject the whole call with
 *    `returned invalid output: value is not lossless JSON`, so a single
 *    conditional field can break an otherwise correct tool.
 */

/**
 * Structured business failure. The field names match the skill scripts' CLI
 * envelopes exactly (`ok` / `error` / `message`), so a tool call and a CLI run
 * describe a failure the same way and the model only learns one vocabulary.
 * @param {string} code - CONFIG|NO_RESULTS|NOT_FOUND|NO_PERMISSION|SERVER_ERROR
 * @param {string} message
 * @param {object} [extra]
 */
export function fail(code, message, extra = {}) {
  return { ok: false, error: code, message, ...extra };
}

/** Success envelope. */
export function ok(data = {}) {
  return { ok: true, ...data };
}

/**
 * `ContentBlock` helper: a tool result is presented as one text block whose
 * body is the JSON payload, so it both renders in the UI and stays readable to
 * the model.
 * @param {unknown} obj
 * @returns {{type: 'text', text: string}[]}
 */
export function textBlock(obj) {
  return [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }];
}

/** Shared `output` definition: renders the returned payload as a JSON text block. */
export function jsonOutput() {
  return {
    schema: { type: 'object', additionalProperties: true },
    render: (_args, value) => textBlock(value),
  };
}

/**
 * Make a value safe for DSH's lossless-JSON check.
 *
 * Rules:
 *  - `undefined` object properties are DROPPED (absent, not null: "this field
 *    does not exist" is the honest reading);
 *  - `NaN` / `Infinity` / `-Infinity` become `null` (JSON cannot represent
 *    them, but the field should survive);
 *  - `undefined` array elements become `null` so indices do not shift;
 *  - `Date` becomes an ISO string; cycles are cut instead of recursing forever.
 *
 * @param {unknown} value
 * @param {WeakSet} [seen]
 * @returns {unknown} `undefined` means "drop me" for the caller
 */
export function toLosslessJson(value, seen = new WeakSet()) {
  if (value === undefined) return undefined; // the caller decides drop-vs-null
  if (value === null) return null;
  const t = typeof value;
  if (t === 'number') return Number.isFinite(value) ? value : null;
  if (t === 'string' || t === 'boolean') return value;
  if (t === 'bigint') return String(value);
  if (t === 'function' || t === 'symbol') return undefined;
  if (t !== 'object') return value;

  if (seen.has(value)) return undefined; // cycle: cut rather than overflow
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => {
      const cleaned = toLosslessJson(item, seen);
      return cleaned === undefined ? null : cleaned;
    });
  }

  if (value instanceof Date) return value.toISOString();

  const out = {};
  for (const [key, item] of Object.entries(value)) {
    const cleaned = toLosslessJson(item, seen);
    if (cleaned !== undefined) out[key] = cleaned;
  }
  return out;
}

/**
 * Clean a tool result through {@link toLosslessJson}. An object that collapses
 * to empty gets `{ ok: true }` so the model never sees a bare `{}`.
 * @param {unknown} result
 */
export function sanitizeResult(result) {
  if (result === undefined || result === null) return { ok: true };
  if (typeof result === 'string') return result;
  if (typeof result !== 'object') return result;
  const cleaned = toLosslessJson(result);
  if (cleaned === undefined) return { ok: true };
  if (!Array.isArray(cleaned) && Object.keys(cleaned).length === 0) return { ok: true };
  return cleaned;
}

/**
 * Build a {@link ToolDefinition}.
 *
 * @param {object} spec
 * @param {string} spec.name - globally unique tool name (snake_case)
 * @param {string} spec.description - model-facing description
 * @param {object} spec.parameters - JSON Schema for the arguments
 * @param {(args: object, run: object) => Promise<unknown>} spec.run
 * @param {(args: object) => boolean} [spec.concurrencySafe]
 * @param {number} [spec.timeoutMs]
 */
export function defineTool(spec) {
  const { name, description, parameters, run, concurrencySafe, timeoutMs } = spec;
  const definition = {
    name,
    description,
    parameters,
    output: jsonOutput(),
    async execute(args, exec) {
      try {
        const result = await run(args ?? {}, exec ?? {});
        return sanitizeResult(result);
      } catch (error) {
        // Never rethrow: a throw surfaces to the model as an unstructured failure.
        const message = error && error.message ? error.message : String(error);
        return sanitizeResult(fail(error?.code ?? 'SERVER_ERROR', message));
      }
    },
  };
  if (concurrencySafe) {
    definition.isConcurrencySafe = (args) => Boolean(concurrencySafe(args));
  }
  if (typeof timeoutMs === 'number') definition.timeoutMs = timeoutMs;
  return definition;
}

/**
 * Race an operation against the call's abort signal.
 *
 * The skill scripts' HTTP layer owns its own request timeout but knows nothing
 * about DSH cancellation, so this stops the CALLER promptly when the turn is
 * cancelled; the in-flight request is left to finish and be discarded. That is
 * the honest bound without threading a signal through every request helper.
 *
 * @param {Promise<unknown>} promise
 * @param {AbortSignal} [signal]
 * @returns {Promise<unknown>}
 */
export function withAbort(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) {
    return Promise.reject(Object.assign(new Error('调用已取消'), { code: 'SERVER_ERROR' }));
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(Object.assign(new Error('调用已取消'), { code: 'SERVER_ERROR' }));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Register a group of tools, one at a time.
 *
 * Tool names are globally unique in DSH; a duplicate throws and would otherwise
 * take the whole plugin's registration chain down with it. Each tool therefore
 * registers inside its own try/catch: a collision costs that one tool, not the
 * rest of the plugin.
 *
 * @param {object} ctx - plugin (or injected) context exposing `ctx.tools`.
 * @param {object[]} tools - definitions from {@link defineTool}.
 * @returns {() => void} disposer that unregisters everything it registered
 */
export function registerTools(ctx, tools) {
  const disposers = [];
  const skipped = [];
  for (const tool of tools) {
    try {
      disposers.push(ctx.tools.register(tool));
    } catch (error) {
      skipped.push(tool.name);
      ctx.logger?.warn?.(
        `dsh-docchain: tool "${tool.name}" registration failed (likely a name collision with the host or another plugin), skipped: ${error?.message ?? error}`,
      );
    }
  }
  if (skipped.length) {
    ctx.logger?.warn?.(`dsh-docchain: skipped ${skipped.length} tool(s): ${skipped.join(', ')}`);
  }
  return () => {
    for (const dispose of disposers.reverse()) {
      try {
        dispose();
      } catch {
        /* idempotent teardown */
      }
    }
  };
}
