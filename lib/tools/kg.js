/**
 * Native DSH tools for the DocChain knowledge graph (Neo4j / KGraph).
 *
 * Merged from the former standalone `@local/dsh-docchain-kg` plugin. The split
 * mirrors what the user settled on (2026-10-30):
 *
 *   - ordinary functions go through the DocChain HTTP API (no Neo4j password):
 *       schema            -> POST /v1/kg/query_orign_ontology
 *       cypher            -> POST /v1/kg/execute_cypher_query
 *       upsert_node       -> POST /v1/kg/graph_upsert_node
 *       upsert_relation   -> POST /v1/kg/graph_upsert_relation
 *       delete_node       -> POST /v1/kg/graph_delete_node
 *       delete_relation   -> POST /v1/kg/graph_delete_relation
 *   - advanced functions connect straight to Neo4j (Bolt, needs credentials):
 *       documents / search / graph
 *
 * Every tool returns the lossless JSON envelope the rest of dsh-docchain uses
 * (`ok` / `error` / `message`), so a KG tool and a document tool describe a
 * failure the same way and the model learns one vocabulary.
 */
import { defineTool, fail, ok, registerTools } from './define.js';
import { Neo4jClient, guardCypher } from '../neo4j.js';

/** Throwable business error that defineTool's execute wraps into `fail`. */
class KgError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'KgError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Small serialisation helpers (ported from dsh-docchain-kg)
// ---------------------------------------------------------------------------

function str(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function short(value, n = 80) {
  const s = str(value);
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function pick(obj, keys) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const key of keys) {
    const value = obj[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function isNodeValue(v) {
  return v && typeof v === 'object' && Array.isArray(v._labels) && '_id' in v;
}

function isRelValue(v) {
  return v && typeof v === 'object' && typeof v._type === 'string' && '_from' in v;
}

function renderNode(node) {
  const labels = `:${(node._labels || []).join(':')}`;
  const name = pick(node, ['name', '项目名称', 'title', 'label', 'row_id']);
  const props = Object.entries(node)
    .filter(([k]) => !k.startsWith('_') && node[k] !== name)
    .slice(0, 6)
    .map(([k, v]) => `${k}=${short(v, 40)}`);
  const parts = [labels];
  if (name !== undefined) parts.push(short(name, 60));
  if (props.length) parts.push(`{${props.join(', ')}}`);
  return parts.join(' ');
}

function renderValue(value) {
  if (isNodeValue(value)) return renderNode(value);
  if (isRelValue(value)) return `-[:${value._type}]->`;
  if (value && typeof value === 'object') return short(JSON.stringify(value), 200);
  return short(value, 200);
}

/** Sanitise a Cypher identifier so it cannot inject query structure. */
function ident(value) {
  const s = String(value).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(s)) {
    throw new KgError('BAD_INPUT', `非法的标识符：${short(s, 40)}（仅允许字母/数字/下划线，且不能以数字开头）。`);
  }
  return s;
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

/** Convert a topic id string to a number when numeric, else keep string. */
function neo4jInt(value) {
  if (/^\d+$/.test(String(value))) return Number(value);
  return String(value);
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
 * Resolve everything the KG tools need for one call.
 *
 * @param {() => Promise<{ neo4j: { uri: string, user: string, password: string, database: string }, docchain: { url: string, apiKey: string } }>} resolveKgConfig
 */

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

/**
 * Build the Neo4j connection object from the resolved config, validating
 * that a password is present (only needed by the direct tools).
 */
function buildNeo4jReady(resolveKgConfig) {
  return async function ready(args) {
    const cfg = await resolveKgConfig();
    const neo = cfg?.neo4j;
    if (!neo?.password) {
      throw new KgError('CONFIG', '缺少 Neo4j 密码：请在配置页配置 neo4j_password（或 NEO4J_PASSWORD 环境变量）。');
    }
    const db = String(args?.database ?? '').trim() || neo.database || 'neo4j';
    return {
      uri: neo.uri,
      user: neo.user || 'neo4j',
      password: neo.password,
      database: db,
      timeoutMs: 30000,
    };
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

function documentsTool(resolveKgConfig, client) {
  const ready = buildNeo4jReady(resolveKgConfig);
  return defineTool({
    name: 'docchain_kg_documents',
    description:
      '列出知识图谱中的文档（Document 节点），含 name / topic_id / doc_id（直连 Neo4j）。可按主题或名称关键字过滤，用于定位某个主题下的文档。',
    parameters: {
      type: 'object',
      properties: {
        database: { type: 'string', description: '可选：数据库名（默认 neo4j）。' },
        topic_id: { type: 'string', description: '可选：按主题 id 过滤。' },
        keyword: { type: 'string', description: '可选：按文档名关键字过滤。' },
        limit: { type: 'number', description: '返回行数上限（默认 50）。' },
      },
    },
    async run(args) {
      const conn = await ready(args);
      const limit = Number(args?.limit) > 0 ? Math.trunc(Number(args.limit)) : 50;
      const topic = String(args?.topic_id ?? '').trim();
      const keyword = String(args?.keyword ?? '').trim();
      const wheres = ['n:Document'];
      const params = { limit };
      if (topic) {
        wheres.push('n.topic_id = $topic');
        params.topic = neo4jInt(topic);
      }
      if (keyword) {
        wheres.push('n.name CONTAINS $kw');
        params.kw = keyword;
      }
      const { records } = await client.run(
        conn,
        `MATCH (n) WHERE ${wheres.join(' AND ')} RETURN n ORDER BY n.topic_id, n.doc_id LIMIT $limit`,
        params,
        conn.database,
      );
      if (!records.length) return ok({ documents: [], count: 0 });
      return ok({ documents: records.map((r) => plain(r.n)), count: records.length });
    },
  });
}

function searchTool(resolveKgConfig, client) {
  const ready = buildNeo4jReady(resolveKgConfig);
  return defineTool({
    name: 'docchain_kg_search',
    description:
      '在知识图谱中按关键字检索节点（匹配节点各属性，跳过 embedding/origin_json；直连 Neo4j）。可选按标签限定范围。适合先定位实体再进一步查询其关系。',
    parameters: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '检索关键字。' },
        database: { type: 'string', description: '可选：数据库名（默认 neo4j）。' },
        label: { type: 'string', description: '可选：限定节点标签（如 Document / Entity）。' },
        limit: { type: 'number', description: '返回行数上限（默认 30）。' },
      },
      required: ['keyword'],
    },
    async run(args) {
      const conn = await ready(args);
      const keyword = String(args?.keyword ?? '').trim();
      if (!keyword) return fail('BAD_INPUT', '缺少 keyword。');
      const limit = Number(args?.limit) > 0 ? Math.trunc(Number(args.limit)) : 30;
      const label = String(args?.label ?? '').trim();
      const labelClause = label ? `:${ident(label)}` : '';
      const { records } = await client.run(
        conn,
        `MATCH (n${labelClause})
         WHERE ANY(k IN keys(n) WHERE k <> 'embedding' AND k <> 'origin_json' AND toString(n[k]) CONTAINS $kw)
         RETURN n LIMIT $limit`,
        { kw: keyword, limit },
        conn.database,
      );
      if (!records.length) return ok({ nodes: [], count: 0, keyword });
      return ok({ nodes: records.map((r) => plain(r.n)), count: records.length, keyword });
    },
  });
}

function graphTool(resolveKgConfig, client) {
  const ready = buildNeo4jReady(resolveKgConfig);
  return defineTool({
    name: 'docchain_kg_graph',
    description:
      '查询知识图谱的子图（直连 Neo4j）：给定文档名，返回该文档及其 CONTAINS 关联的实体节点；或给定标签，返回该标签节点的抽样及其关系。',
    parameters: {
      type: 'object',
      properties: {
        document: { type: 'string', description: '文档名（或文档名关键字），返回该文档的子图。' },
        label: { type: 'string', description: '可选：按节点标签抽样（document 为空时生效）。' },
        database: { type: 'string', description: '可选：数据库名（默认 neo4j）。' },
        limit: { type: 'number', description: '返回行数上限（默认 50）。' },
      },
    },
    async run(args) {
      const conn = await ready(args);
      const limit = Number(args?.limit) > 0 ? Math.trunc(Number(args.limit)) : 50;
      const document = String(args?.document ?? '').trim();
      const label = String(args?.label ?? '').trim();
      if (document) {
        const { records } = await client.run(
          conn,
          'MATCH (d:Document)-[r:CONTAINS]->(e) WHERE d.name CONTAINS $doc RETURN d, r, e LIMIT $limit',
          { doc: document, limit },
          conn.database,
        );
        if (!records.length) return ok({ document, relationships: [], count: 0 });
        return ok({
          document,
          relationships: records.map((rec) => ({
            document: plain(rec.d),
            type: rec.r?._type ?? 'CONTAINS',
            entity: plain(rec.e),
          })),
          count: records.length,
        });
      }
      if (label) {
        const safe = ident(label);
        const { records } = await client.run(
          conn,
          `MATCH (n:${safe})-[r]->(m) RETURN n, r, m LIMIT $limit`,
          { limit },
          conn.database,
        );
        if (!records.length) return ok({ label: safe, relationships: [], count: 0 });
        return ok({
          label: safe,
          relationships: records.map((rec) => ({
            source: plain(rec.n),
            type: rec.r?._type ?? null,
            target: plain(rec.m),
          })),
          count: records.length,
        });
      }
      return fail('BAD_INPUT', '请提供 document（文档名）或 label（节点标签）之一。');
    },
  });
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/**
 * Build all 9 KG tools.
 * @param {() => Promise<{ neo4j: object, docchain: object }>} resolveKgConfig
 * @returns {object[]} tool definitions
 */
export function buildKgTools(resolveKgConfig) {
  const client = new Neo4jClient({});
  return [
    schemaTool(resolveKgConfig),
    cypherTool(resolveKgConfig),
    upsertNodeTool(resolveKgConfig),
    upsertRelationTool(resolveKgConfig),
    deleteNodeTool(resolveKgConfig),
    deleteRelationTool(resolveKgConfig),
    documentsTool(resolveKgConfig, client),
    searchTool(resolveKgConfig, client),
    graphTool(resolveKgConfig, client),
  ];
}

/**
 * Register the KG tools on a context that exposes `ctx.tools`.
 * @param {object} ctx - the tools-injected scope
 * @param {() => Promise<{ neo4j: object, docchain: object }>} resolveKgConfig
 * @returns {() => void} disposer
 */
export function registerKgTools(ctx, resolveKgConfig) {
  return registerTools(ctx, buildKgTools(resolveKgConfig));
}
