// dsh-docchain — bundle skill provider for the docchain skills.
//
// Registers every `<skills>/<name>/SKILL.md` directory bundle shipped in this
// package on the host skill registry (`ctx.skills`), so the skills appear in
// the session catalog and load on demand without depending on manually placed
// user-skill roots (`~/.agents/skills` or `~/.dsh/skills`).
//
// Contract notes:
// - `list()` re-scans the shipped skills root on every catalog collect and
//   returns full candidates; `get()` re-reads the SKILL.md file fresh, so
//   body edits inside the installed package need no cache invalidation.
// - The shipped skills root is watched so added/removed skill directories
//   invalidate the catalog while the registration is live.
// - Ranks (lower wins within one layer): project-dsh 100, project-agents 200,
//   runtime 250, custom 300, user-dsh 400, user-agents 500, bundled 600.
//   SKILL_RANK sits between `custom` and the user roots, so project and
//   custom skill roots keep precedence over this bundle, while passively
//   placed copies under the user roots lose to it.
// - The docchain service endpoint/key are NOT shipped in the package. The key
//   follows the official credential pattern: the row Config names a credential
//   reference (default `DOCCHAIN_API_KEY`) whose value lives in the
//   credential store (`~/.dsh/.credentials.yaml`, editable from the
//   configuration UI) or the launch environment; the endpoint is a plain row
//   Config field. At activation — and again when `credentials/
//   reference-updated` or a `settings/document-updated` for this row fires —
//   resolved values are mirrored into `~/.dsh/storages/docchain-config.json`,
//   which the search scripts read on every run (they also accept env vars and
//   per-skill config.json). The file is a pure projection of what the row
//   config currently resolves to: a value cleared in the UI disappears from
//   it instead of lingering, so the scripts fall through to their defaults.
// - `docchain_environments` holds the user's saved environments as JSON
//   (`{ version, active, items: [{ id, name, url, keyRef }] }`). An active
//   environment outranks `docchain_url` / `docchain_api_key_ref`, so switching
//   is a single settings write while every script keeps reading one projection
//   file. The list is untrusted input: an unparseable or wrongly-shaped payload
//   degrades to "no environments" (the legacy fields win) rather than to an
//   empty list that would erase the user's selection.
import { mkdirSync, readFileSync, readdirSync, watch, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import z from "@deepseek-ai/schemastery";
import { registerDocchainTools } from "./lib/tools/docchain.js";

const PROVIDER_NAME = "dsh-docchain";
const SKILL_SOURCE = "bundled";
const SKILL_RANK = 450;

/** Same-origin route the configuration page calls to list an environment's topics. */
export const TOPIC_ROUTE = "/plugin/dsh-docchain/topics";
/** Topics per page on that route. */
const TOPIC_PAGE_SIZE = 20;
/** Hard cap on page size, so one request cannot ask for an entire 2 500-topic list. */
const TOPIC_PAGE_MAX = 50;
/** How long one topic-list answer is reused; typing in the search box must not hammer the service. */
const TOPIC_CACHE_MS = 10_000;
/** How many topics one environment may pre-select. */
export const MAX_SELECTED_TOPICS = 10;
/** Upper bound for the upstream request. */
const TOPIC_TIMEOUT_MS = 10_000;

const skillsRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "skills");

/** State file the search scripts read; resolved Config values materialize into it. */
export const CONFIG_FILE = path.join(os.homedir(), ".dsh", "storages", "docchain-config.json");

/** Default credential-reference name for the docchain API key. */
export const DEFAULT_KEY_REF = "DOCCHAIN_API_KEY";

/**
 * Row config schema — a schemastery schema, the host's native config library.
 *
 * `docchain_url` carries `.volatile()` so the host settings projection
 * (`@deepseek-ai/dsh-settings`) serves it as an editable form field to the
 * web client's Plugins page; the browser half of this bundle (the `./client`
 * export in package.json) renders that form for the `dsh-docchain` row.
 * The API key is not a form field: the page writes it to the credential
 * store under `DOCCHAIN_API_KEY` through the `credentials` Remote
 * namespace, and this plugin only ever reads the resolved value here.
 *
 * The bare `@deepseek-ai/schemastery` import resolves against the host
 * installation (the loader imports plugin modules through its own loader
 * chain), not the profile directory — the same pattern dshmarket's host
 * half uses. Every documented field is optional; unknown fields pass
 * through schemastery untouched, so a row round-trip never drops data.
 */
export const Config = z.object({
  docchain_url: z.string().volatile().description("docchain 服务地址，如 http://<host>:7100/llmdoc"),
  docchain_api_key_ref: z.string().volatile().description("API Key 的凭据引用名，默认 DOCCHAIN_API_KEY"),
  docchain_api_key: z.string().description("备用：直接写死 Key（不推荐，凭据存储优先）"),
  docchain_environments: z
    .string()
    .volatile()
    .description("常用环境列表（JSON）：{version,active,items:[{id,name,url,keyRef}]}；有生效环境时优先于 docchain_url"),
});

/**
 * Read one row-config field as a trimmed string.
 *
 * `volatile` fields arrive as a reference wrapper (`{ get() }`) that the host
 * updates in place on settings writes; plain fields arrive as strings. Reading
 * both through one helper keeps the unwrapping rule in a single place — a field
 * promoted to `volatile` must not silently fall back to a default just because
 * a wrapper is not a string.
 * @param config - the row config.
 * @param name - the field name.
 * @returns the trimmed string value, or "" when absent.
 */
function readField(config, name) {
  const raw = config?.[name];
  const value = typeof raw === "string" ? raw : typeof raw?.get === "function" ? raw.get() : undefined;
  return typeof value === "string" ? value.trim() : "";
}

/** The credential-reference name the row config resolves its API key from. */
function keyRefName(config) {
  return readField(config, "docchain_api_key_ref") || DEFAULT_KEY_REF;
}

/**
 * Normalize one environment's pre-selected topics.
 *
 * The field is user data that crossed a settings document, so it is treated as
 * untrusted: entries need an integer id and a non-empty name, and duplicates or
 * overflow are dropped rather than rejected — a stray entry must not take the
 * whole environment down with it.
 * @param raw - the stored `topics` value.
 * @returns a clean `[{ id, name }]` list.
 */
function normalizeTopics(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const topics = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const id = Number(item.id);
    if (!Number.isInteger(id) || id <= 0 || seen.has(id)) continue;
    const name = typeof item.name === "string" ? item.name.trim() : "";
    if (!name) continue;
    seen.add(id);
    topics.push({ id, name });
    if (topics.length >= MAX_SELECTED_TOPICS) break;
  }
  return topics;
}

/**
 * Parse the `docchain_environments` field.
 *
 * Returns `null` when the feature is unused or the payload cannot be trusted
 * (absent, malformed JSON, wrong shape). Callers must treat `null` as "no
 * environments" and fall back to the legacy single-URL fields: a corrupted list
 * must never degrade into an empty list that would erase the user's selection.
 * @param config - the row config.
 * @param logger - plugin logger, for the degradation warning.
 * @returns `{ active, items }` or `null`.
 */
function parseEnvironments(config, logger) {
  const text = readField(config, "docchain_environments");
  if (!text) return null;
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    logger?.warn?.(`dsh-docchain: cannot parse docchain_environments (${error?.message ?? error}); using docchain_url`);
    return null;
  }
  if (!data || typeof data !== "object" || Array.isArray(data) || !Array.isArray(data.items)) {
    logger?.warn?.("dsh-docchain: docchain_environments is not a { version, active, items[] } object; using docchain_url");
    return null;
  }
  const items = [];
  for (const item of data.items) {
    if (!item || typeof item !== "object") continue;
    const id = typeof item.id === "string" ? item.id.trim() : "";
    const url = typeof item.url === "string" ? item.url.trim() : "";
    if (!id || !/^https?:\/\//i.test(url)) continue;
    const keyRef = typeof item.keyRef === "string" ? item.keyRef.trim() : "";
    items.push({
      id,
      name: typeof item.name === "string" && item.name.trim() ? item.name.trim() : id,
      url,
      keyRef: keyRef || DEFAULT_KEY_REF,
      topics: normalizeTopics(item.topics),
    });
  }
  return { active: typeof data.active === "string" ? data.active.trim() : "", items };
}

/**
 * The environment the row currently points at, or `undefined` when none is
 * active or the active id no longer exists.
 * @param config - the row config.
 * @param logger - plugin logger, for the missing-active warning.
 */
function activeEnvironment(config, logger) {
  const environments = parseEnvironments(config, logger);
  if (!environments || !environments.active) return undefined;
  const hit = environments.items.find((item) => item.id === environments.active);
  if (!hit) {
    logger?.warn?.(`dsh-docchain: active environment "${environments.active}" is missing; using docchain_url`);
    return undefined;
  }
  return hit;
}

/** Every credential reference this row may consume: the row's own plus every environment's. */
function collectRefs(config, logger) {
  const refs = new Set([keyRefName(config)]);
  const environments = parseEnvironments(config, logger);
  if (environments) for (const item of environments.items) refs.add(item.keyRef);
  return refs;
}

/** Send one JSON answer; every outcome of the topic route goes through here. */
function sendJson(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

/**
 * Ask a docchain service for one page of topics.
 *
 * The skill scripts hit the same endpoint; this is the host-side twin, so the
 * browser never needs the API key (which is write-only by design).
 * @param baseUrl - the environment's service URL.
 * @param key - the resolved API key.
 * @param query - `{ keyword, page, size }`.
 * @returns `{ total, items: [{ id, name }] }`.
 */
function fetchTopics(baseUrl, key, { keyword, page, size }) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(`${String(baseUrl).replace(/\/+$/, "")}/v1/topic/list_by_pagination`);
    } catch {
      reject(new Error("服务地址无效"));
      return;
    }
    target.searchParams.set("page", String(page));
    target.searchParams.set("size", String(size));
    if (keyword) target.searchParams.set("keyword", keyword);
    const isHttps = target.protocol === "https:";
    const lib = isHttps ? https : http;
    const request = lib.request(
      {
        hostname: target.hostname,
        port: target.port || (isHttps ? 443 : 80),
        path: target.pathname + target.search,
        method: "GET",
        headers: { "X-Api-Key": key },
        timeout: TOPIC_TIMEOUT_MS,
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if (response.statusCode >= 400) {
            reject(new Error(`服务返回 HTTP ${response.statusCode}`));
            return;
          }
          let data;
          try {
            data = JSON.parse(text);
          } catch {
            reject(new Error("服务返回的不是 JSON（该环境地址可能不是接口地址）"));
            return;
          }
          if (!data || data.success === false) {
            reject(new Error(data?.err || "服务返回失败"));
            return;
          }
          const payload = data.data ?? {};
          const rows = Array.isArray(payload.data) ? payload.data : [];
          resolve({
            total: Number(payload.total) || 0,
            items: rows
              .map((row) => ({ id: Number(row?.id), name: String(row?.name ?? "") }))
              .filter((row) => Number.isInteger(row.id) && row.name),
          });
        });
      },
    );
    request.on("timeout", () => {
      request.destroy();
      reject(new Error("请求超时"));
    });
    request.on("error", (error) => reject(error));
    request.end();
  });
}

/**
 * The `GET /plugin/dsh-docchain/topics` handler.
 *
 * The page cannot hold the API key, so it asks this route and the host answers
 * for the active environment. Every answer is JSON — including failures, whose
 * `error` the page shows verbatim, so the messages are written for a user
 * rather than for a log.
 * @param ctx - the plugin context.
 * @param config - the resolved row config.
 */
function createTopicsHandler(ctx, config) {
  const cache = new Map();
  return async (req, res) => {
    try {
      // Read-only endpoint: refuse anything but GET so a stray POST cannot look
      // like a query and quietly return a page of results.
      if ((req.method ?? "GET").toUpperCase() !== "GET") {
        sendJson(res, 405, { ok: false, error: "只支持 GET 请求" });
        return;
      }
      const url = new URL(req.url ?? "/", "http://localhost");
      const keyword = (url.searchParams.get("keyword") ?? "").trim().slice(0, 100);
      const page = Math.max(1, Number.parseInt(url.searchParams.get("page") ?? "1", 10) || 1);
      const size = Math.min(
        TOPIC_PAGE_MAX,
        Math.max(1, Number.parseInt(url.searchParams.get("size") ?? String(TOPIC_PAGE_SIZE), 10) || TOPIC_PAGE_SIZE),
      );

      const environment = activeEnvironment(config, ctx.logger);
      if (!environment) {
        sendJson(res, 400, { ok: false, error: "未选择环境" });
        return;
      }
      const { key } = await resolveApiKey(ctx, environment.keyRef, "");
      if (!key) {
        sendJson(res, 400, { ok: false, error: `环境「${environment.name}」未配置 API Key` });
        return;
      }

      const cacheKey = `${environment.id}|${keyword}|${page}|${size}`;
      const cached = cache.get(cacheKey);
      if (cached && Date.now() - cached.at < TOPIC_CACHE_MS) {
        sendJson(res, 200, { ok: true, ...cached.value });
        return;
      }

      const result = await fetchTopics(environment.url, key, { keyword, page, size });
      const value = { total: result.total, page, size, items: result.items };
      cache.set(cacheKey, { at: Date.now(), value });
      sendJson(res, 200, { ok: true, ...value });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.logger?.warn?.(`dsh-docchain: topic list failed: ${message}`);
      sendJson(res, 502, { ok: false, error: message });
    }
  };
}

/**
 * Prompt text describing the active environment and its selected topics.
 *
 * Returns "" when nothing is selected: an empty section costs nothing, while
 * injecting a statement about "no topic" would add noise for everyone who never
 * uses this feature. Read live on every assembly, so switching an environment
 * reaches the next model step without a restart.
 * @param config - the resolved row config.
 */
function topicsPromptText(config) {
  const environment = activeEnvironment(config);
  if (!environment || !environment.topics.length) return "";
  const list = environment.topics.map((topic) => `${topic.name}（topic_id=${topic.id}）`).join("、");
  return [
    `docchain 当前环境：${environment.name}（${environment.url}）`,
    `已选主题：${list}`,
    "用户说「当前主题 / 这个主题」或未指定 topic_ids 时，使用上述 topic_id；需要该环境的全部主题时调用 docchain-topic-info。",
  ].join("\n");
}

/**
 * Resolve one API key: the credential store wins (managed, hot-reloadable), the
 * row literal is the fallback.
 *
 * Returns `{ key, from, resolved }`. `resolved` says whether an empty `key` is
 * authoritative: `true` when the credential service answered (so an absent ref
 * genuinely means "no key") or a row literal supplied the value; `false` when
 * the credential service was unavailable or its `resolve` threw — i.e. this
 * call raced the service's async init and cannot yet distinguish "no key" from
 * "not loaded". Callers must NOT erase a previously materialized key on a
 * `resolved: false` empty result.
 * @param ctx - the plugin context.
 * @param refName - the credential reference to resolve.
 * @param literal - the row-config fallback value.
 */
async function resolveApiKey(ctx, refName, literal) {
  let credentialReady = false;
  try {
    const credentials = ctx.get?.("credentials");
    if (credentials?.resolve) {
      credentialReady = true;
      const hit = await credentials.resolve(refName); // CredentialRef is a plain string at runtime
      if (hit?.value) return { key: hit.value, from: `credential store ${refName} (${hit.source})`, resolved: true };
    }
  } catch (error) {
    credentialReady = false;
    ctx.logger?.warn?.(`dsh-docchain: cannot resolve credential ${refName}: ${error?.message ?? error}`);
  }
  // A row literal is a definite value regardless of the credential service.
  if (literal) return { key: literal, from: "row config", resolved: true };
  // No literal: authoritative only when the credential service actually answered.
  return { key: "", from: "", resolved: credentialReady };
}

/**
 * Mirror the resolved Config values into the state file. The file is a pure
 * projection of what the row config resolves to right now — rebuilt from
 * scratch on every materialization, never merged over its previous content —
 * so a value cleared in the UI disappears from it instead of lingering, and
 * the scripts fall through to lower-priority config or their default. One
 * exception guards the boot race: when the credential service was not ready to
 * answer (`resolved: false`), an empty key is not authoritative, so the
 * previously materialized `docchain_api_key` is preserved rather than erased.
 * Writes only on content change so an unchanged re-materialization stays silent.
 * Manual overrides belong in the layers the scripts read before this file
 * (env vars, per-skill config.json), which this mirror never touches.
 * @param ctx - the plugin context.
 * @param config - the resolved row config.
 */
async function materializeServiceConfig(ctx, config) {
  // An active environment outranks the legacy single-URL fields, so switching
  // environments is one settings write and nothing under skills/ has to know
  // environments exist: the skill scripts keep reading this projection file.
  const environment = activeEnvironment(config, ctx.logger);
  const url = environment ? environment.url : readField(config, "docchain_url");
  const refName = environment ? environment.keyRef : keyRefName(config);
  const literal = environment ? "" : readField(config, "docchain_api_key");
  const { key, from, resolved } = await resolveApiKey(ctx, refName, literal);

  // Read the current state file once: it feeds both the unchanged-content
  // short-circuit below and the key-preservation guard for a not-ready resolve.
  let current = "";
  try {
    current = readFileSync(CONFIG_FILE, "utf8");
  } catch {
    // first write; no prior content
  }

  const next = {};
  if (url) next.docchain_url = url;
  if (key) {
    next.docchain_api_key = key;
  } else if (!resolved) {
    // Credential service not ready → empty resolve is not authoritative; keep
    // whatever key the state file already holds instead of wiping it.
    let preserved = "";
    try {
      const parsed = JSON.parse(current);
      if (typeof parsed?.docchain_api_key === "string") preserved = parsed.docchain_api_key;
    } catch {
      // unparseable prior content; nothing to preserve
    }
    if (preserved) next.docchain_api_key = preserved;
  }
  // The selected topics travel with the projection so a script can default to
  // "the topic chosen on the page" without parsing the profile's YAML. Only an
  // active environment can carry them; a plain `docchain_url` row has none, and
  // the keys are then absent rather than empty — a reader distinguishes
  // "no environment" from "environment with nothing selected".
  if (environment && environment.topics.length) {
    next.docchain_topic_ids = environment.topics.map((topic) => topic.id);
    next.docchain_topic_names = environment.topics.map((topic) => topic.name);
  }
  const rendered = `${JSON.stringify(next, null, 2)}\n`;
  if (current === rendered) return; // unchanged; no rewrite, no log
  try {
    mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
    writeFileSync(CONFIG_FILE, rendered, { mode: 0o600 });
    const origin = environment ? `env ${environment.name}` : "docchain_url";
    ctx.logger?.info?.(
      `dsh-docchain: wrote docchain service config to ${CONFIG_FILE} (${origin}${next.docchain_api_key ? `, key from ${from || "preserved"}` : ""})`,
    );
  } catch (error) {
    ctx.logger?.warn?.(`dsh-docchain: cannot write ${CONFIG_FILE}: ${error?.message ?? error}`);
  }
}

/**
 * Resolve the service pair a tool call must use, read fresh on every call.
 *
 * Deliberately mirrors what `materializeServiceConfig` writes for the scripts
 * (active environment outranks the legacy single-URL fields) and honours the
 * same environment variables, because a tool and a `node scripts/...` run for
 * the same selection must not disagree. Nothing is cached: switching an
 * environment takes effect on the next call, exactly as it does for the
 * scripts reading the projection file.
 *
 * `topicIds` carries the active environment's selected topics — the same
 * default scope the image-search script falls back to when no explicit topic
 * is given.
 *
 * @param {object} ctx - the plugin context.
 * @param {object} config - the resolved row config.
 * @returns {Promise<{docchain_url: string, docchain_api_key: string, topicIds: number[]}>}
 */
async function resolveToolServiceConfig(ctx, config) {
  const environment = activeEnvironment(config, ctx.logger);
  const configuredUrl = environment ? environment.url : readField(config, "docchain_url");
  const refName = environment ? environment.keyRef : keyRefName(config);
  const literal = environment ? "" : readField(config, "docchain_api_key");
  const { key } = await resolveApiKey(ctx, refName, literal);
  return {
    docchain_url: process.env.DOCCHAIN_URL || configuredUrl || "",
    docchain_api_key: process.env.DOCCHAIN_API_KEY || key || "",
    topicIds: environment && Array.isArray(environment.topics) ? environment.topics.map((topic) => topic.id) : [],
  };
}

/** Split a SKILL.md into frontmatter scalars (name/description/whenToUse) and the markdown body. */
export function splitFrontmatter(text) {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return null;
  let close = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === "---") {
      close = i;
      break;
    }
  }
  if (close < 0) return null;
  const data = {};
  for (const line of lines.slice(1, close)) {
    const match = /^([A-Za-z][A-Za-z0-9_-]*):[ \t]*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    if (value.length > 0) data[match[1]] = value;
  }
  const body = lines.slice(close + 1).join("\n").replace(/^\n+/, "");
  return { data, body };
}

/** Scan the shipped skills root; directory bundles without a valid SKILL.md are skipped with a warning. */
function scanSkillBundles(logger) {
  const skills = [];
  let entries;
  try {
    entries = readdirSync(skillsRoot, { withFileTypes: true });
  } catch (error) {
    logger.warn?.(`dsh-docchain: cannot read skills root ${skillsRoot}: ${error?.message ?? error}`);
    throw error;
  }
  for (const entry of entries.filter((item) => item.isDirectory()).map((item) => item.name).sort()) {
    const dir = path.join(skillsRoot, entry);
    const file = path.join(dir, "SKILL.md");
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue; // plain resource directory, not a skill bundle
    }
    const parsed = splitFrontmatter(text);
    if (!parsed || typeof parsed.data.name !== "string" || !parsed.data.description) {
      logger.warn?.(`dsh-docchain: skipped ${file}: missing or invalid frontmatter (name/description required)`);
      continue;
    }
    skills.push({
      name: parsed.data.name,
      description: parsed.data.description,
      whenToUse: parsed.data.whenToUse,
      dir,
      file,
    });
  }
  return skills;
}

// `credentials` is a declared dependency so cordis activates this plugin only
// after the credential service finishes its async init (loading
// `.credentials.yaml`); without it the activation-time materialization races
// the service and resolves an empty key. `resolveApiKey` still guards against
// an unready service defensively.
export const inject = ["skills", "credentials"];

export function apply(ctx, config) {
  const fail = (error) => ctx.logger?.warn?.(`dsh-docchain: materialize failed: ${error?.message ?? error}`);
  // Every skill script checks its own environment variables before this
  // projection file, so a variable set at launch silently outranks whatever the
  // settings page selects. Say so once, loudly: otherwise a working switch looks
  // broken, and the cause is a file this plugin does not own.
  for (const name of ["DOCCHAIN_URL", "DOCCHAIN_API_KEY"]) {
    if (process.env[name]) {
      ctx.logger?.warn?.(
        `dsh-docchain: ${name} is set in the launch environment and outranks the plugin config; switching environments will not change what the skill scripts use`,
      );
    }
  }
  materializeServiceConfig(ctx, config).catch(fail);
  const disposeProvider = ctx.skills.registerProvider((control) => {
    // Best-effort watch on the shipped skills root; coalesce invalidations.
    let dirty = false;
    let watcher = null;
    try {
      watcher = watch(skillsRoot, { persistent: false }, () => {
        dirty = true;
        queueMicrotask(() => {
          if (!dirty) return;
          dirty = false;
          control.invalidate();
        });
      });
    } catch (error) {
      ctx.logger.warn?.(`dsh-docchain: cannot watch ${skillsRoot}: ${error?.message ?? error}`);
    }
    if (watcher) {
      const close = () => {
        try {
          watcher.close();
        } catch {
          // already closed
        }
      };
      if (control.signal.aborted) close();
      else control.signal.addEventListener("abort", close, { once: true });
    }

    const candidates = () => {
      const skills = scanSkillBundles(ctx.logger);
      return skills.map((skill) => ({
        name: skill.name,
        description: skill.description,
        ...(skill.whenToUse !== undefined ? { whenToUse: skill.whenToUse } : {}),
        invocation: { modelInvocable: true, userInvocable: true },
        source: SKILL_SOURCE,
        provider: PROVIDER_NAME,
        rank: SKILL_RANK,
        locator: skill,
        path: skill.file,
        resourceBase: { kind: "directory", path: skill.dir },
      }));
    };

    return {
      name: PROVIDER_NAME,
      async list() {
        return candidates();
      },
      async get(candidate, options) {
        options?.signal?.throwIfAborted?.();
        const skill = candidate.locator;
        let text;
        try {
          text = readFileSync(skill.file, "utf8");
        } catch {
          return undefined; // no longer loadable
        }
        const parsed = splitFrontmatter(text);
        if (!parsed) return undefined;
        return {
          name: candidate.name,
          description: candidate.description,
          ...(candidate.whenToUse !== undefined ? { whenToUse: candidate.whenToUse } : {}),
          invocation: candidate.invocation,
          source: SKILL_SOURCE,
          provider: PROVIDER_NAME,
          content: parsed.body,
          path: candidate.path,
          resourceBase: { kind: "directory", path: skill.dir },
        };
      },
    };
  });
  // Re-materialize when a stored credential changes (saved, replaced, or
  // removed in the credential store / its file), so the state file follows
  // without a restart. The event carries the changed ref; re-resolving on any
  // update is cheap and a no-op write when nothing changed.
  const offCredentialUpdate = ctx.on("credentials/reference-updated", (ref) => {
    // The row's own reference, or any environment's: storing a key for the
    // environment the user just switched to must reach the scripts without a
    // restart, and a silently-wrong filter here would look like a broken switch.
    if (!collectRefs(config, ctx.logger).has(ref)) return;
    materializeServiceConfig(ctx, config).catch(fail);
  });
  // Re-materialize when this row's settings document changes (the Plugins
  // page saved an edit, including clearing the URL back to its default), so
  // the state file follows the accepted value in both directions.
  const offSettingsUpdate = ctx.on("settings/document-updated", (ns) => {
    if (ns !== PROVIDER_NAME) return; // some other entry's settings changed
    materializeServiceConfig(ctx, config).catch(fail);
  });
  // Both services are optional: a profile without a web server or a prompt
  // registry still gets the skill provider and the projection file, just no
  // topic list and no injection. `ctx.inject` activates this block when the
  // services arrive, so load order cannot silently drop the registration.
  ctx.inject(["webServer", "systemPrompt"], (scope) => {
    scope.effect(() => {
      try {
        return scope.webServer.register({
          kind: "exact",
          path: TOPIC_ROUTE,
          handler: createTopicsHandler(ctx, config),
        });
      } catch (error) {
        scope.logger?.warn?.(`dsh-docchain: cannot register ${TOPIC_ROUTE}: ${error?.message ?? error}`);
        return () => {};
      }
    }, "dsh-docchain: topic list route");
    scope.effect(() => {
      try {
        return scope.systemPrompt.section({
          name: "dsh-docchain-topics",
          order: 500,
          text: () => topicsPromptText(config),
        });
      } catch (error) {
        scope.logger?.warn?.(`dsh-docchain: cannot register the topics prompt section: ${error?.message ?? error}`);
        return () => {};
      }
    }, "dsh-docchain: selected topics prompt");
  });
  // Native tools are an upgrade, not a precondition: `tools` goes through
  // `ctx.inject` so a host without the tool registry still keeps the skill
  // provider, the projection file and the configuration page instead of
  // deactivating this plugin entirely.
  let disposeTools;
  ctx.inject(["tools"], (scope) => {
    scope.effect(() => {
      try {
        const dispose = registerDocchainTools(scope, () => resolveToolServiceConfig(ctx, config));
        if (typeof dispose === "function") disposeTools = dispose;
        return dispose;
      } catch (error) {
        scope.logger?.warn?.(`dsh-docchain: cannot register tools: ${error?.message ?? error}`);
        return () => {};
      }
    }, "dsh-docchain: native tools");
  });
  return () => {
    try {
      offCredentialUpdate?.();
      offSettingsUpdate?.();
    } catch {
      // already disposed
    }
    try {
      disposeTools?.();
    } catch {
      // already disposed
    }
    disposeProvider();
  };
}
