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

const docSearchTool = (resolveServiceConfig) =>
  defineTool({
    name: 'docchain_doc_search',
    description:
      '定位 docchain 文档并按需读取正文。按 doc_id（一个或多个）或文档名称关键字找到"是哪个文档"，返回名称、所属主题、页数、大小、状态；content=true 时读取指定文档的正文（分段返回，用 next_offset 续读）。注意：这是按 doc_id / 文档名定位文档，不是按文档正文内容关键字搜索（那用 docchain_content_search）；要限定主题范围按文件名找（那用 docchain_filename_search）。',
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
          description: '每次读取的最大行数，默认 200，上限 2000。',
        },
        size: {
          type: 'integer',
          description: 'keyword 模式返回条数上限，默认 20，上限 100。',
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

      const maxLines = clampInt(args.max_lines, 200, 1, MAX_LINES_CAP);
      const offset = clampInt(args.offset, 0, 0, Number.MAX_SAFE_INTEGER);

      if (args.content) {
        return withAbort(docSearch.readContent(config, docIds[0], offset, maxLines), exec?.signal);
      }
      if (hasKeyword) {
        const size = clampInt(args.size, 20, 1, KEYWORD_RESULT_CAP);
        return withAbort(docSearch.searchByKeyword(config, args.keyword.trim(), idList(args.topic_ids), size), exec?.signal);
      }
      return withAbort(docSearch.listDetails(config, docIds), exec?.signal);
    },
  });

const contentSearchTool = (resolveServiceConfig) =>
  defineTool({
    name: 'docchain_content_search',
    description:
      '在 docchain 文档正文中搜索关键词，返回命中行的行号与内容，按文档分组。必须至少提供 doc_ids 或 topic_ids 之一作为搜索范围。支持 or（任一关键词命中）/ and（同时命中）。适用于"这个文档里有没有提到 X""哪些文档写了 Y"。注意：本工具搜的是正文内容；按文档名或 doc_id 定位文档用 docchain_doc_search。',
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
        size: { type: 'integer', description: '每页条数，默认 20，上限 500。' },
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
          size: clampInt(args.size, 20, 1, 500),
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
          description: 'OR 条件组：组内任一条件满足即可，组与组之间是 AND。',
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
      '图搜图：用一张本地图片在当前 docchain 环境检索相似图片，返回命中图片本身（本地路径）、所属主题（topic_id 与名称）、文档名与相似度。注意：图片向量按主题建立，没做过图片向量化的主题对任何查询都返回空（这不是"库里没有"）。省略 topic_ids 时用配置页当前环境选中的主题。',
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
