/**
 * Native DSH tools for the three core docchain capabilities.
 *
 * Each tool runs the SAME code the CLI scripts run: the host half requires the
 * script modules and calls their exported compute functions in-process, so
 * there is exactly one implementation per capability and a tool result can
 * never drift from a `node scripts/...` run. Nothing here spawns a process.
 *
 * Service resolution is delegated to the caller (`resolveServiceConfig`) so
 * this module stays free of the plugin's Config and credential internals.
 */
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { defineTool, registerTools, withAbort } from './define.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, '..', '..');
const require = createRequire(import.meta.url);

/** The skill scripts are CommonJS (each ships `{"type":"commonjs"}`). */
const docSearch = require(path.join(packageRoot, 'skills', 'docchain-doc-search', 'scripts', 'doc_search.js'));
const contentSearch = require(path.join(packageRoot, 'skills', 'docchain-content-search', 'scripts', 'search_in_doc.js'));
const filenameSearch = require(path.join(packageRoot, 'skills', 'docchain-filename-search', 'scripts', 'search_filename.js'));
const topicInfo = require(path.join(packageRoot, 'skills', 'docchain-topic-info', 'scripts', 'docchain_topic_info.js'));
const metaSearch = require(path.join(packageRoot, 'skills', 'docchain-meta-search', 'scripts', 'query_meta_field.js'));
const uploadSkill = require(path.join(packageRoot, 'skills', 'docchain-upload', 'scripts', 'batch_upload.js'));
const imageSearch = require(path.join(packageRoot, 'skills', 'docchain-image-search', 'scripts', 'image_search.js'));
const imageDescribe = require(path.join(packageRoot, 'skills', 'docchain-image-describe', 'scripts', 'describe_images.js'));
const doc2markdown = require(path.join(packageRoot, 'skills', 'doc2markdown', 'scripts', 'doc2markdown.js'));

// Take the caps from the script module so a tool call and a CLI run clamp
// identically instead of drifting apart over time.
const MAX_LINES_CAP = docSearch.MAX_LINES_CAP ?? 2000;
const KEYWORD_RESULT_CAP = docSearch.KEYWORD_RESULT_CAP ?? 100;

/**
 * A business failure the tool layer reports as `{ok:false, error, message}`.
 * Mirrors `DocchainError` in the script modules so both paths speak one
 * vocabulary; this local class exists because the scripts' class instances are
 * only known to the scripts.
 */
class ToolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ToolError';
    this.code = code;
  }
}

/**
 * Clamp an integer argument into a range, using the default when absent.
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 */
function clampInt(value, fallback, min, max) {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.min(Math.max(n, min), max);
}

/** Normalize an id list argument to a positive integer array (or null). */
function idList(value) {
  if (!Array.isArray(value)) return null;
  const ids = value
    .map((item) => (typeof item === 'number' ? item : Number(item)))
    .filter((item) => Number.isInteger(item) && item > 0);
  return ids.length ? ids : null;
}

/** Normalize a keyword list argument to trimmed non-empty strings. */
function keywordList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item).trim()).filter(Boolean);
}

/**
 * Resolve service config for one call.
 * @param {() => Promise<{docchain_url: string, docchain_api_key: string}>} resolve
 * @returns {Promise<{docchain_url: string, docchain_api_key: string}>}
 */
async function serviceConfig(resolve) {
  const config = await resolve();
  if (!config || !config.docchain_url || !config.docchain_api_key) {
    throw new ToolError(
      'CONFIG',
      'docchain 服务地址或 API Key 未配置：请在 dsh-docchain 插件配置页选择环境并填入凭据，或设置 DOCCHAIN_URL / DOCCHAIN_API_KEY 环境变量。',
    );
  }
  return config;
}

// === 新增：运行时动态模型绑定与能力校验 ===
// 从一个事件对象里取出 { provider, model }。形状在不同版本间不一致，
// 按从具体到通用依次退让，取第一个真正带模型名的；都没有就返回 null。
// 注意不能用 ?? 串起来：空对象也是"非 null"，会把后面的候选整个短路掉。
function pickModelFromEvent(event) {
  const candidates = [
    event?.target?.data, // 某些版本把载荷放在 target 下
    event?.data,         // 实测结构：顶层直接是 data
    event?.target,
    event,
  ];
  for (const data of candidates) {
    const model = data?.model;
    if (typeof model === 'string' && model.trim()) {
      return { model: model.trim(), provider: data?.provider };
    }
  }
  return null;
}

async function getCurrentSessionModel(exec) {
  const agent = exec?.agent;
  if (!agent) return null;
  try {
    // exec.ctx 在工具执行上下文里并不存在（实测 exec 的键里没有 ctx，
    // 直接访问会抛 TypeError: Cannot read properties of undefined (reading 'get')）。
    // 会话查询服务可能挂在 exec、agent 或 agent.ctx 上，逐层找，都拿不到就
    // 返回 null —— 调用方据此跳过能力校验，不把用户误判成选错模型。
    const holders = [exec, agent, agent?.ctx, exec?.ctx];
    let sessionQuery = null;
    for (const holder of holders) {
      if (!holder) continue;
      const candidate =
        typeof holder.get === 'function' ? holder.get('sessionQuery') : undefined;
      if (candidate && typeof candidate.listEvents === 'function') {
        sessionQuery = candidate;
        break;
      }
      const direct = holder.sessionQuery;
      if (direct && typeof direct.listEvents === 'function') {
        sessionQuery = direct;
        break;
      }
    }
    if (!sessionQuery) return null;

    const events = await sessionQuery.listEvents(agent.id);
    const ctxEvent = [...events].reverse().find(e => e.type === 'request/context');
    if (!ctxEvent) return null;

    // listEvents 给的是摘要，readEvent 才是完整事件。实测 readEvent 直接返回
    // { type, seq, time, data: { provider, model } }，没有 target 包裹。
    // readEvent 出错时不影响结论：摘要里通常已经带 model，退回去用它。
    let full;
    try {
      full = await sessionQuery.readEvent({ sessionId: agent.id, seq: ctxEvent.seq });
    } catch {
      full = undefined;
    }

    return pickModelFromEvent(full) ?? pickModelFromEvent(ctxEvent);
  } catch {
    return null;
  }
}

// 视觉模型清单里，这些排在前面（按综合能力与实测读图质量）。
// 清单以外的视觉模型仍然会列出来，只是排在后面。
const PREFERRED_VISION_MODELS = [
  'qwen3-vl-plus',
  'doubao-seed-2.0-pro',
  'glm-5v-turbo',
];

/**
 * 拉取网关的视觉模型清单，按 PREFERRED_VISION_MODELS 优先排序。
 * 失败时返回空数组（调用方会退化成只推荐内置的三个）。
 */
async function listVisionModels(baseUrl, apiKey) {
  try {
    const res = await fetch(`${baseUrl}/models`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) return [];
    const payload = await res.json();
    const models = Array.isArray(payload) ? payload : (payload?.data ?? []);
    if (!Array.isArray(models)) return [];
    const vision = [];
    for (const m of models) {
      const id = m?.id;
      if (typeof id !== 'string' || !id.trim()) continue;
      // 只看明确的 is_vision=1；缺字段的不猜，免得列出读不了图的模型。
      if (m.is_vision !== 1 && m.is_vision !== '1' && m.is_vision !== true) continue;
      // 网关把 33 个 DocChain 知识库应用也标成了 is_vision=1（实测），
      // 它们不是能读图的大模型，选中只会报错，所以按 is_docchain 剔掉。
      if (m.is_docchain === 1 || m.is_docchain === '1' || m.is_docchain === true) continue;
      vision.push({ id, desc: String(m.model_desc ?? m.desc ?? '') });
    }
    const rank = (id) => {
      const i = PREFERRED_VISION_MODELS.indexOf(id);
      return i === -1 ? PREFERRED_VISION_MODELS.length : i;
    };
    vision.sort((a, b) => {
      const d = rank(a.id) - rank(b.id);
      return d !== 0 ? d : a.id.localeCompare(b.id);
    });
    return vision;
  } catch {
    return [];
  }
}

/**
 * 当前模型读不了图时，让用户从视觉模型清单里挑一个。
 *
 * 走 scheme A：只对这一次调用生效，不改对话模型的设置 —— 控制权留在人手上。
 * 返回用户选中的模型 id；用户没选或无法提问时返回 null（调用方据此报错退出）。
 */
async function askUserForVisionModel(exec, { currentModel, baseUrl, apiKey }) {
  const agent = exec?.agent;
  if (!agent) return null;
  // userQuestions 可能挂在 exec 或 agent 上，逐层找。
  let userQuestions = null;
  for (const holder of [exec, agent, agent?.ctx, exec?.ctx]) {
    if (!holder) continue;
    const candidate = typeof holder.get === 'function' ? holder.get('userQuestions') : undefined;
    if (candidate && typeof candidate.ask === 'function') {
      userQuestions = candidate;
      break;
    }
    const direct = holder.userQuestions;
    if (direct && typeof direct.ask === 'function') {
      userQuestions = direct;
      break;
    }
  }
  if (!userQuestions) return null;

  let models = await listVisionModels(baseUrl, apiKey);
  if (models.length === 0) models = PREFERRED_VISION_MODELS.map((id) => ({ id, desc: '' }));

  // 最多列 8 个：前 5 个是综合能力优先，其余作为补充，避免选项面板过长。
  const MAX_OPTIONS = 8;
  const shown = models.slice(0, MAX_OPTIONS);
  const more = models.length - shown.length;

  try {
    const answer = await userQuestions.ask({
      agent,
      questions: [
        {
          id: 'vision-model',
          header: '需要视觉模型',
          question: `当前对话模型 ${currentModel} 不支持读图，请选择一个视觉模型完成本次图片描述（只对这次调用生效，不会改动你的对话模型）`,
          detail:
            more > 0
              ? `列表按综合能力排序，另有 ${more} 个视觉模型未在此列出。`
              : '列表按综合能力排序。',
          options: shown.map((m) => ({
            label: m.id,
            description: m.desc ? m.desc.replace(/\s+/g, ' ').slice(0, 120) : undefined,
          })),
        },
      ],
    });
    const picked = Array.isArray(answer?.answers)
      ? answer.answers.find((a) => a && a.id === 'vision-model')
      : undefined;
    const selected =
      (Array.isArray(picked?.selected) && picked.selected[0]) || picked?.custom || '';
    return typeof selected === 'string' && selected.trim() ? selected.trim() : null;
  } catch {
    return null;
  }
}

// 返回三态：true=支持图片 / false=确定不支持 / null=查不到（网络、限流、模型不在清单里）。
// null 必须单独处理：不能当成 false，否则网关一限流就把用户误报成"模型不支持图片"。
async function isModelVision(modelId, baseUrl, apiKey) {
  if (!modelId) return null;
  try {
    const res = await fetch(`${baseUrl}/models`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${apiKey}` }
    });
    // 429/5xx 时网关返回 { error: ... } 而不是模型清单，此时结论未知。
    if (!res.ok) return null;
    const payload = await res.json();
    // OpenAI 兼容 /models 返回 { data: [...] }；也兼容直接返回数组的网关。
    const models = Array.isArray(payload) ? payload : (payload?.data ?? []);
    if (!Array.isArray(models) || models.length === 0) return null;
    const m = models.find((x) => x?.id === modelId);
    // 清单里没有这个模型（可能是限流导致的截断清单）→ 结论未知，不判死。
    if (!m) return null;
    // DocChain 知识库应用被网关一并标成 is_vision=1，但它们不是能读图的大模型。
    if (m.is_docchain === 1 || m.is_docchain === '1' || m.is_docchain === true) return false;
    // is_vision 是权威字段，只要它明确给出（0 或 1）就直接采信，不再猜模型名。
    const flag = m.is_vision;
    if (flag === 0 || flag === '0' || flag === false) return false;
    if (flag === 1 || flag === '1' || flag === true) return true;
    // 只有网关没给该字段时才退回文本判断，避免误放行纯文本模型。
    const desc = `${m.model_desc ?? ''} ${m.desc ?? ''}`;
    if (desc.includes('图片理解')) return true;
    if (/(vision|vl)[-_]/i.test(m.id)) return true;
    return false;
  } catch {
    return null;
  }
}
// === 结束新增 ===

const docSearchTool = (resolveServiceConfig) =>
  defineTool({
    name: 'docchain_doc_search',
    description:
      '定位 docchain 文档并按需读取正文。按 doc_id（一个或多个）或文档名称关键字找到"是哪个文档"，返回名称、所属主题、页数、大小、状态; content=true 时读取指定文档的正文（分段返回，用 next_offset 续读）。注意：这是按 doc_id / 文档名定位文档，不是按文档正文内容关键字搜索（那用 docchain_content_search）；要限定主题范围按文件名找（那用 docchain_filename_search）。',
    parameters: {
      type: 'object',
      properties: {
        doc_ids: {
          type: 'array',
          items: { type: 'integer' },
          description: '文档 ID 列表，可多个。与 keyword 二选一。',
        },
        keyword: {
          type: 'string',
          description: '文档名称关键字，全库跨主题匹配。与 doc_ids 二选一。',
        },
        topic_ids: {
          type: 'array',
          items: { type: 'integer' },
          description: '可选：按主题 ID 过滤结果（keyword 模式生效）。',
        },
        content: {
          type: 'boolean',
          description: '读取正文；只允许搭配 1 个 doc_id。默认 false。',
        },
        offset: {
          type: 'integer',
          description: '读取正文的起始行号，默认 0；续读时填上一次返回的 next_offset。',
        },
        max_lines: {
          type: 'integer',
          description: '每次读取的最大行数，默认 2000，上限 2000。',
        },
        size: {
          type: 'integer',
          description: 'keyword 模式返回条数上限，默认 200，上限 100。',
        },
      },
      additionalProperties: false,
    },
    concurrencySafe: () => true,
    async run(args, exec) {
      const config = await serviceConfig(resolveServiceConfig);
      const docIds = idList(args.doc_ids);
      const hasKeyword = typeof args.keyword === 'string' && args.keyword.trim() !== '';

      if (docIds && hasKeyword) {
        throw new ToolError('CONFIG', 'doc_ids 与 keyword 只能二选一');
      }
      if (!docIds && !hasKeyword) {
        throw new ToolError('CONFIG', '必须提供 doc_ids 或 keyword 之一');
      }
      if (args.content && (!docIds || docIds.length !== 1)) {
        throw new ToolError('CONFIG', 'content 读取正文时只允许指定 1 个 doc_id');
      }

      const maxLines = clampInt(args.max_lines, 2000, 1, MAX_LINES_CAP);
      const offset = clampInt(args.offset, 0, 0, Number.MAX_SAFE_INTEGER);

      if (args.content) {
        return withAbort(docSearch.readContent(config, docIds[0], offset, maxLines), exec?.signal);
      }
      if (hasKeyword) {
        const size = clampInt(args.size, 200, 1, KEYWORD_RESULT_CAP);
        return withAbort(docSearch.searchByKeyword(config, args.keyword.trim(), idList(args.topic_ids), size), exec?.signal);
      }
      return withAbort(docSearch.listDetails(config, docIds), exec?.signal);
    },
  });

const contentSearchTool = (resolveServiceConfig) =>
  defineTool({
    name: 'docchain_content_search',
    description:
      '在 docchain 文档正文中搜索关键词,返回命中行的行号与内容,按文档分组。必须至少提供 doc_ids 或 topic_ids 之一作为搜索范围。支持 or（任一关键词命中）/ and（同时命中）。适用于"这个文档里有没有提到 X""哪些文档写了 Y"。注意：本工具搜的是正文内容；按文档名或 doc_id 定位文档用 docchain_doc_search。',
    parameters: {
      type: 'object',
      properties: {
        keywords: {
          type: 'array',
          items: { type: 'string' },
          description: '要搜索的关键词列表（必填）。',
        },
        doc_ids: {
          type: 'array',
          items: { type: 'integer' },
          description: '限定搜索的文档 ID 列表。与 topic_ids 至少给一个。',
        },
        topic_ids: {
          type: 'array',
          items: { type: 'integer' },
          description: '限定搜索的主题 ID 列表。与 doc_ids 至少给一个。',
        },
        operator: {
          type: 'string',
          enum: ['or', 'and'],
          description: '关键词之间的逻辑关系，默认 or。',
        },
        limit: {
          type: 'integer',
          description: '返回命中条数上限，默认 30。',
        },
      },
      required: ['keywords'],
      additionalProperties: false,
    },
    concurrencySafe: () => true,
    async run(args, exec) {
      const config = await serviceConfig(resolveServiceConfig);
      const keywords = keywordList(args.keywords);
      const docIds = idList(args.doc_ids);
      const topicIds = idList(args.topic_ids);

      if (keywords.length === 0) throw new ToolError('CONFIG', 'keywords 不能为空');
      if (!docIds && !topicIds) throw new ToolError('CONFIG', '必须提供 doc_ids 或 topic_ids 之一');
      if (args.operator !== undefined && args.operator !== 'or' && args.operator !== 'and') {
        throw new ToolError('CONFIG', "operator 只能是 'or' 或 'and'");
      }

      const limit = clampInt(args.limit, 30, 1, 1000);
      return withAbort(
        contentSearch.runContentSearch(config, {
          docIds,
          topicIds,
          keywords,
          operator: args.operator ?? 'or',
          limit,
        }),
        exec?.signal,
      );
    },
  });

const filenameSearchTool = (resolveServiceConfig) =>
  defineTool({
    name: 'docchain_filename_search',
    description:
      '在指定主题范围内按文件名关键词搜索 docchain 文档（支持多个关键词，或关系）。topic_ids 必填：本工具只在这些主题里找。适用于"在某个主题里按文件名找文档"。若要跨全部主题按文件名查找，用 docchain_doc_search 的 keyword 参数。',
    parameters: {
      type: 'object',
      properties: {
        keywords: {
          type: 'array',
          items: { type: 'string' },
          description: '文件名关键词列表（必填）。',
        },
        topic_ids: {
          type: 'array',
          items: { type: 'integer' },
          description: '要搜索的主题 ID 列表（必填）。本工具只在该范围内查找。',
        },
      },
      required: ['keywords', 'topic_ids'],
      additionalProperties: false,
    },
    concurrencySafe: () => true,
    async run(args, exec) {
      const config = await serviceConfig(resolveServiceConfig);
      const keywords = keywordList(args.keywords);
      const topicIds = idList(args.topic_ids);

      if (keywords.length === 0) throw new ToolError('CONFIG', 'keywords 不能为空');
      if (!topicIds) throw new ToolError('CONFIG', 'topic_ids 必填：本工具只在指定主题内按文件名搜索');

      return withAbort(filenameSearch.runFilenameSearch(config, { keywords, topicIds }), exec?.signal);
    },
  });

const topicInfoTool = (resolveServiceConfig) =>
  defineTool({
    name: 'docchain_topic_info',
    description:
      '查询 docchain 文档主题（topic_id，注意不是 Kafka Topic）列表，支持分页与按名称/ID 关键字过滤。适用于"有哪些主题""查某个主题的 id"。常作为其它检索的前置步骤：先拿到 topic_id，再按主题检索或上传。',
    parameters: {
      type: 'object',
      properties: {
        page: { type: 'integer', description: '页码，默认 1。' },
        size: { type: 'integer', description: '每页条数，默认 200，上限 500。' },
        keyword: { type: 'string', description: '按主题名称或主题 ID 的关键字过滤。' },
      },
      additionalProperties: false,
    },
    concurrencySafe: () => true,
    async run(args, exec) {
      const config = await serviceConfig(resolveServiceConfig);
      const keyword = typeof args.keyword === 'string' && args.keyword.trim() ? args.keyword.trim() : null;
      return withAbort(
        topicInfo.runTopicInfo(config, {
          page: clampInt(args.page, 1, 1, Number.MAX_SAFE_INTEGER),
          size: clampInt(args.size, 200, 1, 500),
          keyword,
        }),
        exec?.signal,
      );
    },
  });

/** One metadata condition, as the model should express it. */
const conditionSchema = {
  type: 'object',
  properties: {
    field: { type: 'string', description: '元数据字段名，例如 author。' },
    op: {
      type: 'string',
      description:
        '操作符：字符串 eq / ne / contains；数值 num_eq / num_ne / num_gt / num_gte / num_lt / num_lte；时间 time_eq / time_ne / time_gt / time_gte / time_lt / time_lte。',
    },
    value: { type: 'string', description: '比较值（统一按字符串传）。' },
  },
  required: ['field', 'op', 'value'],
  additionalProperties: false,
};

const metaSearchTool = (resolveServiceConfig) =>
  defineTool({
    name: 'docchain_meta_search',
    description:
      '按自定义元数据字段查询 docchain 文档：conditions 之间是 AND，or_groups 组内 OR、组间 AND。必须提供 topic_ids 或 doc_ids 之一。list_fields=true 时改为列出指定主题的元数据字段结构（不确定字段名时先用它）。适用于"作者是张三的文档""金额大于 1000 的合同"。',
    parameters: {
      type: 'object',
      properties: {
        topic_ids: { type: 'array', items: { type: 'integer' }, description: '检索的主题 ID 列表。' },
        doc_ids: { type: 'array', items: { type: 'integer' }, description: '检索的文档 ID 列表。' },
        conditions: { type: 'array', items: conditionSchema, description: 'AND 条件列表。' },
        or_groups: {
          type: 'array',
          items: { type: 'array', items: conditionSchema },
          description: 'OR 条件组：组内任一条件满足即可,组与组之间是 AND。',
        },
        size: { type: 'integer', description: '返回条数上限，默认 100。' },
        list_fields: {
          type: 'boolean',
          description: 'true 时只列出这些主题的元数据字段结构（需要 topic_ids），不执行查询。',
        },
      },
      additionalProperties: false,
    },
    concurrencySafe: () => true,
    async run(args, exec) {
      const config = await serviceConfig(resolveServiceConfig);
      const topicIds = idList(args.topic_ids);
      const docIds = idList(args.doc_ids);

      if (args.list_fields) {
        if (!topicIds) throw new ToolError('CONFIG', 'list_fields 需要提供 topic_ids');
        return withAbort(metaSearch.runMetaFields(config, topicIds), exec?.signal);
      }
      if (!topicIds && !docIds) {
        throw new ToolError('CONFIG', '必须提供 topic_ids 或 doc_ids 之一');
      }
      return withAbort(
        metaSearch.runMetaQuery(config, {
          conditions: Array.isArray(args.conditions) ? args.conditions : [],
          orGroups: Array.isArray(args.or_groups) ? args.or_groups : [],
          topicIds,
          docIds,
          size: clampInt(args.size, 100, 1, 1000),
        }),
        exec?.signal,
      );
    },
  });

const uploadTool = (resolveServiceConfig) =>
  defineTool({
    name: 'docchain_upload',
    description:
      '把本地文件或整个文件夹（仅顶层文件，不递归）批量上传到指定 docchain 主题。这是写操作，会真正写入知识库：调用前务必和用户确认目标主题与路径。返回每个文件的上传结果（doc_id）。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '要上传的文件路径，或文件夹路径（mode=folder 时）。' },
        topic_id: { type: 'integer', description: '目标主题 ID（必填）。' },
        mode: {
          type: 'string',
          enum: ['file', 'folder'],
          description: "file（默认）上传单个文件；folder 上传该文件夹内顶层文件。",
        },
      },
      required: ['path', 'topic_id'],
      additionalProperties: false,
    },
    // Writes to the knowledge base: never schedule these in parallel.
    concurrencySafe: () => false,
    async run(args, exec) {
      const config = await serviceConfig(resolveServiceConfig);
      if (!Number.isInteger(args.topic_id) || args.topic_id <= 0) {
        throw new ToolError('CONFIG', 'topic_id 必填，且必须是正整数');
      }
      if (typeof args.path !== 'string' || !args.path.trim()) {
        throw new ToolError('CONFIG', 'path 必填：要上传的文件或文件夹路径');
      }
      return withAbort(
        uploadSkill.runUpload(config, {
          target: args.path,
          topicId: args.topic_id,
          mode: args.mode === 'folder' ? 'folder' : 'file',
          quiet: true,
        }),
        exec?.signal,
      );
    },
  });

const imageSearchTool = (resolveServiceConfig) =>
  defineTool({
    name: 'docchain_image_search',
    description:
      '图搜图：用一张本地图片在当前 docchain 环境检索相似图片,返回命中图片本身（本地路径）、所属主题（topic_id 与名称）、文档名与相似度。注意：图片向量按主题建立，没做过图片向量化的主题对任何查询都返回空（这不是"库里没有"）。省略 topic_ids 时用配置页当前环境选中的主题。',
    parameters: {
      type: 'object',
      properties: {
        image: { type: 'string', description: '本地图片路径（jpg/jpeg/png/webp/bmp，≤20MB）。' },
        topic_ids: {
          type: 'array',
          items: { type: 'integer' },
          description: '检索的主题 ID 列表；省略则用配置页选中的主题。',
        },
        all: { type: 'boolean', description: '扫描全部主题：慢且请求量大，知道主题时不要用。' },
        limit: { type: 'integer', description: '返回条数上限。' },
        concurrency: { type: 'integer', description: '并发检索的主题数。' },
        max_seconds: { type: 'integer', description: '整体超时秒数，超时提前结束并如实说明。' },
      },
      required: ['image'],
      additionalProperties: false,
    },
    concurrencySafe: () => true,
    async run(args, exec) {
      const config = await serviceConfig(resolveServiceConfig);
      return withAbort(
        imageSearch.runImageSearch(
          {
            url: config.docchain_url,
            key: config.docchain_api_key,
            topicIds: Array.isArray(config.topicIds) ? config.topicIds : [],
          },
          {
            image: args.image,
            topicIds: idList(args.topic_ids),
            all: Boolean(args.all),
            limit: args.limit,
            concurrency: args.concurrency,
            maxSeconds: args.max_seconds,
            quiet: true,
          },
        ),
        exec?.signal,
      );
    },
  });

const imageDescribeTool = (resolveServiceConfig) =>
  defineTool({
    name: 'docchain_image_describe',
    description:
      '把文档里的图片转成文字：读文档主 md → 逐张图片交给视觉模型生成中文描述 → 在每张图片上方插入 `<!-- image-desc: … -->` → 调保存接口写成**旁路描述 md**（主 md 一字不动，可用 read_format=image_description_md 读回）。' +
      '三种用法：① 给 doc_ids 直接处理；② 只给 keyword 时**仅返回候选清单**、不处理，由用户选定后再带 doc_ids 调；③ list_models=true 查看当前 key 可用的视觉模型。' +
      'read=true 只读取已生成的描述 md。批量（>1 篇）默认先返回清单，需 confirm=true 才执行；dry_run=true 只生成不保存。' +
      '**视觉模型跟随对话模型**：用的是你当前在对话里选的那个模型。若它不支持读图，工具会暂停并弹窗让你从视觉模型清单里挑一个，选完继续执行；该选择只对本次调用生效，不会改动对话模型。' +
      '流程图/架构图这类结构图会改成输出一段 PlantUML 草图（代码块替代描述注释,语法由脚本生成、保证合法）；其余图片照旧输出中文描述注释。diagram="off" 可整体退回纯描述。',
    parameters: {
      type: 'object',
      properties: {
        doc_ids: {
          type: 'array',
          items: { type: 'integer' },
          description: '文档 ID 列表。为空时必须给 keyword 或 list_models。',
        },
        keyword: {
          type: 'string',
          description: '文档名关键字：只返回候选清单，不描述、不保存，等用户选定后再带 doc_ids 调用。',
        },
        topic_ids: {
          type: 'array',
          items: { type: 'integer' },
          description: '候选模式的搜索范围；省略则用配置页选中的主题。',
        },
        max_images: {
          type: 'integer',
          description: '每篇最多处理几张图，0（默认）=全部。建议先用 2 试跑看效果与耗时。',
        },
        concurrency: {
          type: 'integer',
          description: '同时处理几张图，默认 8、上限 10。实测 12 起会被网关限流（429）。',
        },
        dry_run: { type: 'boolean', description: 'true 只生成描述 md 并返回统计，不调用保存接口。' },
        list_models: { type: 'boolean', description: 'true 时只列出当前 key 可用的视觉模型。' },
        read: { type: 'boolean', description: 'true 时只读取已生成的描述 md（未生成返回 NOT_GENERATED）。' },
        confirm: { type: 'boolean', description: '批量处理（>1 篇）时的确认开关；不传则只返回待处理清单。' },
        diagram: {
          type: 'string',
          enum: ['off', 'on'],
          description:
            '结构图（流程图/架构图）是否改出 PlantUML 草图：on（默认）出草图、不留描述注释；off 全部图片都只写描述注释。',
        },
      },
      additionalProperties: false,
    },
    // 长任务：一篇 185 张图的文档实测约 3 分钟，绝不与别的调用并发。
    concurrencySafe: () => false,
    // 40 分钟：结构图那次要输出 JSON，比纯描述慢（实测单张 21s vs 16s）；
    // 185 张图约 7.5 分钟，给 400 张级文档留余量，同时保留宿主的取消能力。
    timeoutMs: 40 * 60 * 1000,
    async run(args, exec) {
      const config = await serviceConfig(resolveServiceConfig);
      const visionConfig = config.vision || {};
      // list_models 也需要 key（要拉模型清单），所以在所有模式前先校验一次。
      if (!visionConfig.key) {
        throw new ToolError(
          'CONFIG',
          `视觉模型 Key 未配置：请把网关 Key 写入凭据库的 ${visionConfig.keyRef || 'IWHALE_API_KEY'}，` +
            '或设置环境变量 VISION_API_KEY。',
        );
      }

      // ✅ 步骤1: 读当前会话模型（通用，不依赖 provider 名）
      // 工具不再接受 model 参数：模型只能来自对话选择，或用户在弹窗里点选。
      const current = await getCurrentSessionModel(exec);
      let resolvedModel = current?.model || '';

      // ✅ 步骤2: 能力校验（关键！）
      // 只拦截"确定不支持"的模型；查不到（限流/网络/清单未收录）时放行，
      // 由真正发请求时暴露问题，避免网关抖动把用户误判成选错模型。
      let overriddenByUser = false;
      if (resolvedModel) {
        const isVis = await isModelVision(resolvedModel, visionConfig.url, visionConfig.key);
        if (isVis === false) {
          // 暂停并让用户挑一个视觉模型；选择只对本次调用生效（scheme A）。
          const chosen = await askUserForVisionModel(exec, {
            currentModel: resolvedModel,
            baseUrl: visionConfig.url,
            apiKey: visionConfig.key,
          });
          if (!chosen) {
            throw new ToolError(
              'MODEL_NOT_VISION',
              `当前对话模型 "${resolvedModel}" 不支持图片理解。\n` +
                `请在对话模型下拉中换成视觉模型后重试，例如：` +
                PREFERRED_VISION_MODELS.join(' / ') +
                '。',
            );
          }
          resolvedModel = chosen;
          overriddenByUser = true;
        }
      }

      // ✅ 步骤3: 透传给 describe_images
      const payload = await withAbort(
        imageDescribe.runDescribeImages(
          {
            url: config.docchain_url,
            key: config.docchain_api_key,
            topicIds: Array.isArray(config.topicIds) ? config.topicIds : [],
            // resolvedModel 为空时不要写进 vision.model，否则会遮住配置里的默认值。
            vision: resolvedModel ? { ...visionConfig, model: resolvedModel } : { ...visionConfig },
          },
          {
            docIds: idList(args.doc_ids),
            keyword: typeof args.keyword === 'string' ? args.keyword : '',
            topicIds: idList(args.topic_ids) || [],
            maxImages: clampInt(args.max_images, 0, 0, 2000),
            concurrency: clampInt(args.concurrency, 8, 1, 10),
            dryRun: Boolean(args.dry_run),
            model: resolvedModel,
            listModels: Boolean(args.list_models),
            read: Boolean(args.read),
            confirm: Boolean(args.confirm),
            diagram: typeof args.diagram === 'string' ? args.diagram : '',
            quiet: true,
          },
        ),
        exec?.signal,
      );
      if (overriddenByUser && payload && typeof payload === 'object' && !Array.isArray(payload)) {
        payload.vision_model_source = 'user-selected-for-this-call';
      }
      return payload;
    },
  });

const doc2markdownTool = () =>
  defineTool({
    name: 'doc2markdown',
    description:
      '把 docx/doc/pdf/ppt/pptx/xls/xlsx/图片等文档解析转换为 Markdown，结果保存到源文件同目录：md_only=true 只导出单个 .md，false（默认）导出含图片与表格的完整 MD 包。action="check" 时用之前转换返回的 doc_id 继续查询状态并下载。大文档转换会排队，返回 error="PENDING" 时不算失败，用同一个 doc_id 再查一次即可。本工具使用 doc2markdown 自己的服务地址与密钥配置，与其他工具的配置链独立。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['convert', 'check'],
          description: 'convert（默认）上传并转换；check 按 doc_id 查询状态并下载。',
        },
        file_path: {
          type: 'string',
          description: 'convert：要转换的源文件路径；check：决定保存位置与命名的路径（通常与转换时相同）。',
        },
        doc_id: { type: 'string', description: 'check 模式必填：上一次 convert 返回的文档 ID。' },
        md_only: { type: 'boolean', description: 'true 只导出单个 .md 文件；false（默认）导出完整 MD 包。' },
      },
      required: ['file_path'],
      additionalProperties: false,
    },
    // A convert already runs a long upload + poll loop; never batch these.
    concurrencySafe: () => false,
    async run(args, exec) {
      const action = args.action === 'check' ? 'check' : 'convert';
      if (action === 'check' && !args.doc_id) {
        throw new ToolError('CONFIG', 'check 模式需要 doc_id');
      }
      return withAbort(
        doc2markdown.runDoc2Markdown({
          action,
          file_path: args.file_path,
          doc_id: args.doc_id,
          md_only: Boolean(args.md_only),
        }),
        exec?.signal,
      );
    },
  });

/**
 * Build the tool definitions.
 * @param {() => Promise<{docchain_url: string, docchain_api_key: string, topicIds?: number[]}>} resolveServiceConfig
 */
export function buildDocchainTools(resolveServiceConfig) {
  return [
    docSearchTool(resolveServiceConfig),
    contentSearchTool(resolveServiceConfig),
    filenameSearchTool(resolveServiceConfig),
    topicInfoTool(resolveServiceConfig),
    metaSearchTool(resolveServiceConfig),
    uploadTool(resolveServiceConfig),
    imageSearchTool(resolveServiceConfig),
    imageDescribeTool(resolveServiceConfig),
    doc2markdownTool(),
  ];
}

/**
 * Register the tools on a context that exposes `ctx.tools`.
 * @param {object} ctx - the tools-injected scope (or the plugin context)
 * @param {() => Promise<{docchain_url: string, docchain_api_key: string, topicIds?: number[]}>} resolveServiceConfig
 * @returns {() => void} disposer
 */
export function registerDocchainTools(ctx, resolveServiceConfig) {
  return registerTools(ctx, buildDocchainTools(resolveServiceConfig));
}