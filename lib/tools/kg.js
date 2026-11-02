/**
 * Native DSH tools for the DocChain knowledge graph (Neo4j / KGraph).
 *
 * Merged from the former standalone `@local/dsh-docchain-kg` plugin. The split
 * mirrors what the user settled on (2026-10-30):
 *
 *   All functions go through the DocChain HTTP API (no Neo4j password):
 *       schema            -> POST /v1/kg/query_orign_ontology
 *       cypher            -> POST /v1/kg/execute_cypher_query
 *       upsert_node       -> POST /v1/kg/graph_upsert_node
 *       upsert_relation   -> POST /v1/kg/graph_upsert_relation
 *       delete_node       -> POST /v1/kg/graph_delete_node
 *       delete_relation   -> POST /v1/kg/graph_delete_relation
 *
 * Every tool returns the lossless JSON envelope the rest of dsh-docchain uses
 * (`ok` / `error` / `message`), so a KG tool and a document tool describe a
 * failure the same way and the model learns one vocabulary.
 */
import { defineTool, fail, ok, registerTools } from './define.js';
import { guardCypher } from '../neo4j.js';

/** Throwable business error that defineTool's execute wraps into `fail`. */
class KgError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'KgError';
    this.code = code;
  }
}

/** Recursively convert Map/iterable/object into a plain JSON object/array. */
function plain(value) {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(plain);
  if (value instanceof Map) {
    const out = {};
    for (const [k, v] of value) out[k] = plain(v);
    return out;
  }
  if (typeof value === 'object') {
    if (typeof value.entries === 'function' && !(value instanceof Date)) {
      const out = {};
      for (const [k, v] of value.entries()) out[k] = plain(v);
      return out;
    }
    const out = {};
    for (const k of Object.keys(value)) out[k] = plain(value[k]);
    return out;
  }
  return value;
}

/**
 * Normalize an entity type's `attributes` field into a uniform list.
 *
 * The backend stores attributes as a JSON string ("属性名→类型" dict) on the
 * ontology node, but `query_orign_ontology` may hand it back as that string,
 * as an object, or as an array — accept all three and return
 * `[{ name, type }]`.
 */
function normalizeAttributes(value) {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) {
    return value.map((a) => {
      if (typeof a === 'string') return { name: a, type: 'str' };
      if (a && typeof a === 'object') {
        return { name: a.name ?? a.attribute_name ?? a.property ?? '', type: a.type ?? a.attribute_type ?? 'str' };
      }
      return { name: String(a), type: 'str' };
    });
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return [];
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return Object.entries(parsed).map(([name, type]) => ({ name, type: type ?? 'str' }));
      }
      if (Array.isArray(parsed)) return normalizeAttributes(parsed);
      return [];
    } catch {
      return [];
    }
  }
  if (typeof value === 'object') {
    if (Array.isArray(value.attributes)) return normalizeAttributes(value.attributes);
    if (Array.isArray(value.properties)) return normalizeAttributes(value.properties);
    return Object.entries(value).map(([name, type]) => ({ name, type: type ?? 'str' }));
  }
  return [];
}

// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------

/**
 * Build the DocChain API request helper bound to a config resolver.
 */
function buildApiClient(resolveKgConfig) {
  return async function docchainRequest(endpoint, payload) {
    const cfg = await resolveKgConfig();
    const dc = cfg?.docchain;
    if (!dc?.url || !dc?.apiKey) {
      throw new KgError('CONFIG', '缺少 DocChain 配置：请在配置页设置 docchain_url 与 API Key（或 DOCCHAIN_API_KEY 环境变量）。');
    }
    const url = `${dc.url.replace(/\/+$/, '')}${endpoint}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Api-Key': dc.apiKey },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const raw = await response.text();
      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        data = { raw, httpStatus: response.status };
      }
      if (!response.ok && data?.result !== true) {
        throw new KgError('SERVER_ERROR', `DocChain API 返回 ${response.status}: ${data?.msg || raw}`);
      }
      return data;
    } finally {
      clearTimeout(timer);
    }
  };
}

// ---------------------------------------------------------------------------
// Tool builders
// ---------------------------------------------------------------------------

function schemaTool(resolveKgConfig) {
  const request = buildApiClient(resolveKgConfig);
  return defineTool({
    name: 'docchain_kg_schema',
    description:
      '查询指定主题的知识图谱本体结构（走 DocChain API，无需 Neo4j 密码）：返回实体类型（含属性定义）与关系类型（含源/目标实体类型）。用于在查询/构建图谱前了解该主题有哪些本体类型和关系可用。',
    parameters: {
      type: 'object',
      properties: {
        topic_id: { type: 'string', description: '主题 ID（后端据此路由到主题库 docchaintopic{topic_id}）。' },
        ontology_type: { type: 'string', enum: ['ontology', 'dg_ontology'], description: '本体类型：ontology（知识图谱本体，默认）/ dg_ontology（文档地图本体）。' },
      },
      required: ['topic_id'],
    },
    async run(args) {
      const topicId = String(args?.topic_id ?? '').trim();
      if (!topicId) return fail('BAD_INPUT', '缺少 topic_id。');
      const ontologyType = String(args?.ontology_type ?? '').trim() || 'ontology';
      const res = await request('/v1/kg/query_orign_ontology', { topic_id: topicId, ontology_type: ontologyType });
      const body = res?.data && typeof res.data === 'object' && ('entity_types' in res.data || 'relationship_types' in res.data) ? res.data : res;
      const entityTypes = Array.isArray(body?.entity_types) ? body.entity_types : [];
      const relTypes = Array.isArray(body?.relationship_types) ? body.relationship_types : [];
      return ok({
        topic_id: topicId,
        ontology_type: ontologyType,
        entity_types: entityTypes.map((t) => ({
          type: t && typeof t === 'object' ? (t.type ?? t.name ?? t.entity_name ?? '') : t,
          attributes: normalizeAttributes(t && typeof t === 'object' ? t.attributes : undefined),
        })),
        relationship_types: relTypes.map((t) => ({
          relationship_type: t && typeof t === 'object' ? (t.relationship_type ?? t.name ?? t.relation_type ?? '') : t,
          source_type: t && typeof t === 'object' ? (t.source_type ?? '') : '',
          target_type: t && typeof t === 'object' ? (t.target_type ?? '') : '',
        })),
      });
    },
  });
}

function cypherTool(resolveKgConfig) {
  const request = buildApiClient(resolveKgConfig);
  return defineTool({
    name: 'docchain_kg_cypher',
    description:
      '在指定主题的知识图谱上执行一条只读 Cypher 查询并返回结果（走 DocChain API，无需 Neo4j 密码）。只应执行只读查询（MATCH/CALL/SHOW…RETURN），不要用 CREATE/MERGE/DELETE 等写语句；若无 LIMIT 会自动补一个。',
    parameters: {
      type: 'object',
      properties: {
        cypher: { type: 'string', description: 'Cypher 查询语句。' },
        topic_id: { type: 'string', description: '主题 ID（后端据此路由到主题库 docchaintopic{topic_id}）。' },
        limit: { type: 'number', description: '自动补 LIMIT 时的行数上限（默认 50）。' },
      },
      required: ['cypher', 'topic_id'],
    },
    async run(args) {
      const topicId = String(args?.topic_id ?? '').trim();
      if (!topicId) return fail('BAD_INPUT', '缺少 topic_id。');
      const cypher = String(args?.cypher ?? '').trim();
      if (!cypher) return fail('BAD_INPUT', '缺少 cypher。');
      const limit = Number(args?.limit) > 0 ? Math.trunc(Number(args.limit)) : 50;
      const guarded = guardCypher(cypher, limit);
      const res = await request('/v1/kg/execute_cypher_query', { topic_id: topicId, cypher_command: guarded });
      const body = res?.data && typeof res.data === 'object' && ('data_list' in res.data || 'result' in res.data) ? res.data : res;
      const dataList = Array.isArray(body?.data_list) ? body.data_list : Array.isArray(body?.data) ? body.data : [];
      return ok({ cypher: guarded, rows: dataList.slice(0, limit), count: dataList.length });
    },
  });
}

function upsertNodeTool(resolveKgConfig) {
  const request = buildApiClient(resolveKgConfig);
  return defineTool({
    name: 'docchain_kg_upsert_node',
    description:
      '新增本体/实体节点，或编辑已有节点（均走 DocChain API，不依赖 Neo4j 密码）。\n- 新增本体：node_type="ontology"，必填 entity_name/description，可选 attributes（属性名数组，内部自动按默认类型 str 转成「属性名→类型」字典）、alias、align_strategy（默认 semantics）。不传 entity_id 由后端生成。\n- 新增/编辑实体：node_type="entity" + entity_name + ontology_id_list；properties 传属性值字典（key=属性名，value=属性值）。传 entity_id 则按 id 融合，不传则后端自动生成。\n- 文档关联：实体可用 doc_ids 传「关联文档」的文档 ID 列表。\n写操作不可撤销，执行前请向用户确认。',
    parameters: {
      type: 'object',
      properties: {
        topic_id: { type: 'string', description: '主题 ID。' },
        node_type: { type: 'string', enum: ['ontology', 'entity'], description: '节点类型（必填）：ontology=本体节点，entity=实体节点。' },
        entity_id: { type: 'string', description: '可选：实体/本体 id；新增时缺省由后端生成，编辑时必须传入。' },
        entity_name: { type: 'string', description: '名称（新增本体必填；编辑可选）。' },
        description: { type: 'string', description: '描述（新增本体必填；编辑可选）。' },
        ontology_id_list: { type: 'array', items: { type: 'string' }, description: '实体所属本体 id 列表（实体节点时使用）。' },
        alias: { type: 'array', items: { type: 'string' }, description: '别名列表。' },
        doc_ids: { type: 'array', items: { type: 'string' }, description: '关联文档的文档 ID 列表（实体 doc_ids 属性）。' },
        entity_weight: { type: 'number', description: '实体权重（数字）。' },
        align_strategy: { type: 'string', description: '融合策略（本体默认 semantics，可选 semantics/match/match_with_type）。' },
        attributes: { type: 'array', items: { type: 'string' }, description: '属性名字符串数组（本体节点用），如 ["姓名","年龄"]。' },
        properties: { type: 'object', additionalProperties: true, description: '实体属性值字典（实体节点用），如 {"文号":"国办发55号"}。' },
      },
      required: ['topic_id', 'node_type'],
    },
    async run(args) {
      const topicId = String(args?.topic_id ?? '').trim();
      if (!topicId) return fail('BAD_INPUT', '缺少 topic_id。');
      const nodeType = String(args?.node_type ?? '').trim();
      if (nodeType !== 'ontology' && nodeType !== 'entity') {
        return fail('BAD_INPUT', 'node_type 只能是 ontology（本体）或 entity（实体）。');
      }

      if (nodeType === 'ontology') {
        const entityName = String(args?.entity_name ?? '').trim();
        const description = String(args?.description ?? '').trim();
        if (!entityName) return fail('BAD_INPUT', '新增本体需要 entity_name。');
        const eid = String(args?.entity_id ?? '').trim();
        const alignStrategy = String(args?.align_strategy ?? '').trim() || 'semantics';
        const attrs = args?.attributes ? plain(args.attributes) : null;
        const alias = args?.alias ? plain(args.alias) : null;
        const payload = {
          topic_id: topicId,
          entity_name: entityName,
          description: description || entityName,
          ontology_id_list: ['ontology'],
          align_strategy: alignStrategy,
        };
        if (eid) payload.entity_id = eid;
        if (alias) payload.alias = alias;
        if (attrs) {
          if (Array.isArray(attrs)) {
            const dict = {};
            for (const a of attrs) dict[String(a)] = 'str';
            payload.attributes = dict;
          } else if (typeof attrs === 'object') {
            payload.attributes = attrs;
          }
        }
        const res = await request('/v1/kg/graph_upsert_node', payload);
        if (res && (res.result === false || res.success === false)) {
          return fail('SERVER_ERROR', res?.msg || res?.err || JSON.stringify(res));
        }
        const returnedId = res?.data?.entity_id ?? eid ?? null;
        return ok({ entity_id: returnedId, node_type: 'ontology', msg: res?.msg ?? 'ok' });
      }

      // entity create / edit
      const eid = String(args?.entity_id ?? '').trim();
      const entityName = String(args?.entity_name ?? '').trim();
      const description = String(args?.description ?? '').trim();
      if (!entityName) return fail('BAD_INPUT', '新增/编辑实体需要 entity_name。');
      const olist = args?.ontology_id_list ? plain(args.ontology_id_list) : null;
      if (!olist || !olist.length) return fail('BAD_INPUT', '实体需要 ontology_id_list（所属本体 id 列表）。');
      const payload = {
        topic_id: topicId,
        entity_name: entityName,
        description: description || entityName,
        ontology_id_list: olist,
      };
      if (eid) payload.entity_id = eid;
      if (args?.alias) payload.alias = plain(args.alias);
      if (args?.doc_ids) payload.doc_ids = plain(args.doc_ids).map(String);
      if (args?.entity_weight !== undefined && args?.entity_weight !== null) payload.entity_weight = args.entity_weight;
      if (String(args?.align_strategy ?? '').trim()) payload.align_strategy = String(args.align_strategy).trim();
      const propMap = args?.properties ? plain(args.properties) : null;
      if (propMap && typeof propMap === 'object' && Object.keys(propMap).length) payload.attributes = propMap;
      const res = await request('/v1/kg/graph_upsert_node', payload);
      if (res && (res.result === false || res.success === false)) {
        return fail('SERVER_ERROR', res?.msg || res?.err || JSON.stringify(res));
      }
      const returnedId = res?.data?.entity_id ?? eid ?? null;
      return ok({ entity_id: returnedId, node_type: 'entity', msg: res?.msg ?? 'ok' });
    },
  });
}

function upsertRelationTool(resolveKgConfig) {
  const request = buildApiClient(resolveKgConfig);
  return defineTool({
    name: 'docchain_kg_upsert_relation',
    description:
      '新增本体关系或实体关系（走 DocChain API）。必填 topic_id/relation_type/source/target；本体关系不传 ontology_id，实体关系必传 ontology_id。description 可选。缺省自动生成 relation_id 并返回。写操作不可撤销。',
    parameters: {
      type: 'object',
      properties: {
        topic_id: { type: 'string', description: '主题 ID。' },
        relation_type: { type: 'string', description: '关系类型名称（业务名，如「发布」「包含」「关联」）。' },
        source: { type: 'string', description: '起始节点 entity_id。' },
        target: { type: 'string', description: '终止节点 entity_id。' },
        relation_id: { type: 'string', description: '可选：关系 id；缺省自动生成。' },
        ontology_id: { type: 'string', description: '实体关系必填：关系类型对应的本体 id；本体关系不传。' },
        description: { type: 'string', description: '关系描述。' },
      },
      required: ['topic_id', 'relation_type', 'source', 'target'],
    },
    async run(args) {
      const topicId = String(args?.topic_id ?? '').trim();
      const relType = String(args?.relation_type ?? '').trim();
      const source = String(args?.source ?? '').trim();
      const target = String(args?.target ?? '').trim();
      if (!topicId || !relType || !source || !target) {
        return fail('BAD_INPUT', 'topic_id/relation_type/source/target 均为必填。');
      }
      const ontId = String(args?.ontology_id ?? '').trim();
      const description = String(args?.description ?? '').trim();
      const payload = {
        topic_id: topicId,
        relation_type: relType,
        source: source,
        target: target,
        description: description || relType,
      };
      if (String(args?.relation_id ?? '').trim()) payload.relation_id = String(args.relation_id).trim();
      if (ontId) payload.ontology_id = ontId;
      const res = await request('/v1/kg/graph_upsert_relation', payload);
      if (res && (res.result === false || res.success === false)) {
        return fail('SERVER_ERROR', res?.msg || res?.err || JSON.stringify(res));
      }
      const returnedId = res?.data?.relation_id ?? res?.relation_id ?? null;
      return ok({ relation_id: returnedId, msg: res?.msg ?? 'ok' });
    },
  });
}

function deleteNodeTool(resolveKgConfig) {
  const request = buildApiClient(resolveKgConfig);
  return defineTool({
    name: 'docchain_kg_delete_node',
    description:
      '删除知识图谱中指定 entity_id 的节点（本体或实体），并连带删除其所有关系（走 DocChain API）。删除不可撤销，执行前请向用户确认。',
    parameters: {
      type: 'object',
      properties: {
        topic_id: { type: 'string', description: '主题 ID。' },
        entity_id: { type: 'string', description: '要删除节点的 entity_id。' },
      },
      required: ['topic_id', 'entity_id'],
    },
    async run(args) {
      const topicId = String(args?.topic_id ?? '').trim();
      const eid = String(args?.entity_id ?? '').trim();
      if (!topicId || !eid) return fail('BAD_INPUT', 'topic_id/entity_id 均为必填。');
      const res = await request('/v1/kg/graph_delete_node', { topic_id: topicId, entity_id: eid });
      if (res && (res.result === false || res.success === false)) {
        return fail('SERVER_ERROR', res?.msg || res?.err || JSON.stringify(res));
      }
      return ok({ entity_id: eid, msg: res?.msg ?? 'ok' });
    },
  });
}

function deleteRelationTool(resolveKgConfig) {
  const request = buildApiClient(resolveKgConfig);
  return defineTool({
    name: 'docchain_kg_delete_relation',
    description:
      '删除知识图谱中指定 relation_id 的关系（走 DocChain API）。删除不可撤销，执行前请向用户确认。',
    parameters: {
      type: 'object',
      properties: {
        topic_id: { type: 'string', description: '主题 ID。' },
        relation_id: { type: 'string', description: '要删除关系的 relation_id。' },
      },
      required: ['topic_id', 'relation_id'],
    },
    async run(args) {
      const topicId = String(args?.topic_id ?? '').trim();
      const relId = String(args?.relation_id ?? '').trim();
      if (!topicId || !relId) return fail('BAD_INPUT', 'topic_id/relation_id 均为必填。');
      const res = await request('/v1/kg/graph_delete_relation', { topic_id: topicId, relation_id: relId });
      if (res && (res.result === false || res.success === false)) {
        return fail('SERVER_ERROR', res?.msg || res?.err || JSON.stringify(res));
      }
      return ok({ relation_id: relId, msg: res?.msg ?? 'ok' });
    },
  });
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/**
 * Build all 6 KG tools.
 * @param {() => Promise<{ docchain: object }>} resolveKgConfig
 * @returns {object[]} tool definitions
 */
export function buildKgTools(resolveKgConfig) {
  return [
    schemaTool(resolveKgConfig),
    cypherTool(resolveKgConfig),
    upsertNodeTool(resolveKgConfig),
    upsertRelationTool(resolveKgConfig),
    deleteNodeTool(resolveKgConfig),
    deleteRelationTool(resolveKgConfig),
  ];
}

/**
 * Register the KG tools on a context that exposes `ctx.tools`.
 * @param {object} ctx - the tools-injected scope
 * @param {() => Promise<{ docchain: object }>} resolveKgConfig
 * @returns {() => void} disposer
 */
export function registerKgTools(ctx, resolveKgConfig) {
  return registerTools(ctx, buildKgTools(resolveKgConfig));
}
