#!/usr/bin/env node
/**
 * Docchain 元数据字段查询脚本
 *
 * 根据自定义元数据字段条件查询文档。
 *
 * dsh-docchain integration: the service URL and API key resolve through the
 * package's shared config chain (env vars > skill scripts/config.json >
 * plugin state file ~/.dsh/storages/docchain-config.json > package
 * skills/docchain_config.json), see getConfig.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const { URL } = require('url');

const CONFIG_MESSAGE = `请正确配置以下参数
docchain_url: 环境指向地址（必填）
docchain_api_key: 环境的账号验证方式（必填）
方式1: 环境变量 DOCCHAIN_URL, DOCCHAIN_API_KEY
方式2: 插件配置：dsh-docchain 插件的 Config（激活时自动写入
       ~/.dsh/storages/docchain-config.json，也可直接手动编辑该文件）：
       {"docchain_url": "http://<host>:7100/llmdoc", "docchain_api_key": "your-api-key"}
方式3: 配置文件 docchain-meta-search/scripts/config.json， 如下格式：
\`\`\`json
{
  "docchain_url": "http://<host>:7100/llmdoc",
  "docchain_api_key": "your-api-key"
}
\`\`\`
方式4: 包内 skills/docchain_config.json，同上json格式（分发兜底，参考 docchain_config.example.json）
**注：配置取值顺序优先级为 环境变量 > scripts/config.json > ~/.dsh/storages/docchain-config.json > 包内 docchain_config.json**`;

const ARG_SPEC = {
    topic_ids: { type: 'string' },
    doc_ids: { type: 'string' },
    conditions: { type: 'string' },
    or_groups: { type: 'string' },
    size: { type: 'int', default: 100 },
    list_fields: { flag: true },
};

// 字符串 / 时间 / 数值三组共 15 个操作符
const VALID_OPERATIONS = new Set([
    'eq', 'ne', 'contains',
    'time_eq', 'time_ne', 'time_gt', 'time_gte', 'time_lt', 'time_lte',
    'num_eq', 'num_ne', 'num_gt', 'num_gte', 'num_lt', 'num_lte',
]);

/**
 * HTTP status error: the server answered with a non-2xx status.
 * Carries the status code so callers can map friendly messages.
 */
class HttpError extends Error {
    constructor(status, data) {
        super(`HTTP ${status}`);
        this.name = 'HttpError';
        this.status = status;
        this.data = data;
    }
}

/**
 * Send a JSON HTTP request and parse the JSON response body.
 * Non-2xx status codes reject with an HttpError.
 * @param {string} url
 * @param {object} [options]
 * @param {string} [options.method]
 * @param {object} [options.headers]
 * @param {object|null} [options.body]
 * @param {number} [options.timeout]
 * @returns {Promise<{status: number, data: any}>}
 */
function requestJson(url, { method = 'GET', headers = {}, body = null, timeout = 30000 } = {}) {
    return new Promise((resolve, reject) => {
        const urlObj = new URL(url);
        const isHttps = urlObj.protocol === 'https:';
        const httpModule = isHttps ? https : http;
        const payload = body === null ? null : JSON.stringify(body);

        const reqOptions = {
            hostname: urlObj.hostname,
            port: urlObj.port || (isHttps ? 443 : 80),
            path: urlObj.pathname + urlObj.search,
            method,
            headers: { ...headers },
            timeout,
        };
        if (payload !== null) {
            reqOptions.headers['Content-Length'] = Buffer.byteLength(payload);
        }

        const req = httpModule.request(reqOptions, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                let data;
                try {
                    data = JSON.parse(text);
                } catch (error) {
                    data = null;
                }
                if (res.statusCode >= 400) {
                    reject(new HttpError(res.statusCode, data));
                } else {
                    resolve({ status: res.statusCode, data });
                }
            });
        });

        req.on('error', (error) => reject(error));
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('请求超时'));
        });

        if (payload !== null) {
            req.write(payload);
        }
        req.end();
    });
}

/**
 * Parse `--flag value` / `--flag=value` style CLI arguments.
 * Unknown flags, missing values, invalid ints, missing required flags and
 * out-of-range choices print an error to stderr and exit(1).
 * @param {string[]} argv
 * @param {object} argSpec - flag name (without --) to spec:
 *   { type: 'string'|'int', flag?: boolean, required?: boolean, default?: any, choices?: string[] }
 * @returns {object} parsed flag values keyed by flag name
 */
function parseArgs(argv, argSpec) {
    const args = {};
    for (const [name, spec] of Object.entries(argSpec)) {
        args[name] = spec.default !== undefined ? spec.default : (spec.flag ? false : null);
    }
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (!arg.startsWith('--')) continue;
        let name = arg.slice(2);
        let value;
        const eq = name.indexOf('=');
        if (eq >= 0) {
            value = name.slice(eq + 1);
            name = name.slice(0, eq);
        }
        const spec = argSpec[name];
        if (!spec) {
            printError('CONFIG', `未知参数：${arg}`);
        }
        if (spec.flag) {
            args[name] = true;
            continue;
        }
        if (value === undefined) {
            value = argv[i + 1];
            i += 1;
            if (value === undefined) {
                printError('CONFIG', `参数 ${arg} 缺少值`);
            }
        }
        if (spec.type === 'int') {
            if (!/^\d+$/.test(value)) {
                printError('CONFIG', `参数 ${arg} 必须是数字`);
            }
            value = parseInt(value, 10);
        }
        args[name] = value;
    }
    for (const [name, spec] of Object.entries(argSpec)) {
        if (spec.required && (args[name] === null || args[name] === undefined)) {
            printError('CONFIG', `缺少必填参数 --${name}`);
        }
        if (spec.choices && args[name] !== null && !spec.choices.includes(args[name])) {
            printError('CONFIG', `参数 --${name} 取值必须是 ${spec.choices.join('/')}`);
        }
    }
    return args;
}

/**
 * Parse a comma-separated string into a list of numeric IDs.
 * Non-numeric entries abort with an error; empty results return null.
 * @param {string} value
 * @param {string} label - used in the error message
 * @returns {number[]|null}
 */
function parseIdList(value, label) {
    const ids = [];
    for (const item of value.split(',')) {
        const trimmed = item.trim();
        if (!trimmed) continue;
        if (!/^\d+$/.test(trimmed)) {
            printError('CONFIG', `${label} 必须是数字`);
        }
        ids.push(Number(trimmed));
    }
    return ids.length > 0 ? ids : null;
}

/**
 * Read and parse a JSON config file. A missing file stays silent; an
 * unreadable/invalid file warns on stderr and is skipped.
 * @param {string} configPath
 * @returns {object|null}
 */
function readJsonFile(configPath) {
    if (!fs.existsSync(configPath)) {
        return null;
    }
    try {
        const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch (error) {
        console.error(`警告：配置文件不是合法 JSON，已忽略：${configPath}`);
        return null;
    }
}

/**
 * Load the docchain service config through the shared priority chain:
 * env vars > skill scripts/config.json > plugin state file > package
 * skills/docchain_config.json. URL and API key are both required here;
 * an incomplete config prints a JSON error on stdout and exits.
 * @returns {{docchain_url: string, docchain_api_key: string}}
 */
function getConfig() {
    const currentConfigPath = path.join(__dirname, 'config.json');
    const packageConfigPath = path.join(__dirname, '..', '..', 'docchain_config.json');
    const stateConfigPath = path.join(os.homedir(), '.dsh', 'storages', 'docchain-config.json');

    const config = {
        ...readJsonFile(packageConfigPath), // 包内兜底（可随包分发占位）
        ...readJsonFile(stateConfigPath),   // 插件状态文件（插件 Config 激活时写入，可手动编辑）
        ...readJsonFile(currentConfigPath), // 技能级覆盖
    };

    const envUrl = process.env.DOCCHAIN_URL;
    const envKey = process.env.DOCCHAIN_API_KEY;
    if (envUrl) {
        config.docchain_url = envUrl;
    }
    if (envKey) {
        config.docchain_api_key = envKey;
    }

    if (!config.docchain_url || !config.docchain_api_key) {
        printError('CONFIG', CONFIG_MESSAGE);
    }
    return config;
}

/**
 * Print a structured failure envelope `{ok:false, error, message}` on stdout
 * and exit. `NO_RESULTS` is treated as a normal empty result (exit 0); any
 * other code exits 1.
 * @param {string} error - CONFIG|NO_RESULTS|NOT_FOUND|NO_PERMISSION|SERVER_ERROR
 * @param {string} message
 */
function printError(error, message) {
    console.log(JSON.stringify({ ok: false, error, message }));
    process.exit(error === 'NO_RESULTS' ? 0 : 1);
}

/**
 * Print a failure as a structured envelope, then exit.
 * HTTP errors map per status code; anything else is a network failure.
 * @param {Error} error
 * @param {object} [statusMessages] - HTTP status code to friendly message
 */
function failWith(error, statusMessages = {}) {
    if (error instanceof DocchainError) {
        printError(error.code, error.message);
    }
    if (error instanceof HttpError) {
        if (error.status === 401 || error.status === 403) {
            printError('NO_PERMISSION', statusMessages[error.status] || '无权限访问文档或主题');
        }
        if (error.status >= 500) {
            printError('SERVER_ERROR', '服务端错误（HTTP ' + error.status + '）');
        }
        printError('SERVER_ERROR', statusMessages[error.status] || `API 请求失败：HTTP ${error.status}`);
    }
    printError('SERVER_ERROR', `网络错误：${error.message}`);
}

/**
 * A business failure carrying the same error vocabulary as the tool layer.
 * Pure functions throw this instead of printing and exiting, so the same code
 * serves both the CLI and the in-process tool registration.
 */
class DocchainError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'DocchainError';
        this.code = code;
    }
}

/**
 * 查询主题的元数据字段列表。
 * @param {object} config - { docchain_url, docchain_api_key }
 * @param {number} topicId
 * @returns {Promise<object>} API 响应
 */
async function listTopicMetadataFields(config, topicId) {
    const apiUrl = config.docchain_url.replace(/\/+$/, '');
    const endpoint = `${apiUrl}/v1/topic/metadata/list?topic_id=${encodeURIComponent(topicId)}`;

    const headers = { 'Content-Type': 'application/json' };
    if (config.docchain_api_key) {
        headers['X-Api-Key'] = config.docchain_api_key;
    }

    const { data } = await requestJson(endpoint, { method: 'GET', headers });
    return data;
}

/**
 * 格式化元数据字段列表用于显示。
 * @param {object[]} fields
 * @param {number} [topicId]
 * @returns {string} 格式化的显示字符串
 */
function formatMetadataFields(fields, topicId) {
    const lines = [];

    if (topicId !== null && topicId !== undefined) {
        lines.push(`📋 主题 ${topicId} 的元数据字段：\n`);
    }

    if (!fields || fields.length === 0) {
        lines.push('❌ 该主题暂无元数据字段定义');
        return lines.join('\n');
    }

    lines.push(`✅ 共 ${fields.length} 个字段\n`);
    lines.push('| 字段名 | 类型 |');
    lines.push('|--------|------|');

    for (const field of fields) {
        const fieldName = field.field_name || 'N/A';
        const fieldType = field.field_type || 'str';
        lines.push(`| ${fieldName} | ${fieldType} |`);
    }

    return lines.join('\n');
}

/**
 * 解析单个条件字符串。
 *
 * 格式: field_name,operation,value
 * 示例: author,eq,张三
 *
 * @param {string} conditionStr
 * @returns {object|null} 条件字典（符合 MetaFieldCondition 格式）或 null（如果解析失败）
 */
function parseCondition(conditionStr) {
    const parts = conditionStr.split(',');
    if (parts.length < 3) {
        return null;
    }

    const fieldName = parts[0].trim();
    const operation = parts[1].trim();
    const value = parts.slice(2).join(',').trim();

    if (!fieldName || !operation) {
        return null;
    }

    // 验证操作符
    if (!VALID_OPERATIONS.has(operation)) {
        return null;
    }

    return {
        field_name: fieldName,
        operation,
        value,
    };
}

/**
 * 根据元数据字段查询文档。
 * @param {object} params
 * @param {object[]} params.conditions - 查询条件列表（AND关系）
 * @param {number[]|null} params.topicIds - 要查询的主题 ID 列表
 * @param {number[]|null} params.docIds - 要查询的文档 ID 列表
 * @param {object[][]|null} params.orGroups - OR条件组列表
 * @param {number} params.size - 返回结果数量上限
 * @returns {Promise<object>} API 响应
 */
async function queryByMetaFields(config, { conditions, topicIds, docIds, orGroups, size }) {
    const apiUrl = config.docchain_url.replace(/\/+$/, '');
    const endpoint = `${apiUrl}/v1/doc_info/meta_field_query`;

    const headers = { 'Content-Type': 'application/json' };
    if (config.docchain_api_key) {
        headers['X-Api-Key'] = config.docchain_api_key;
    }

    const payload = { size };
    if (conditions && conditions.length > 0) {
        payload.conditions = conditions;
    }
    if (orGroups && orGroups.length > 0) {
        payload.or_groups = orGroups;
    }
    if (topicIds) {
        payload.topic_ids = topicIds;
    }
    if (docIds) {
        payload.doc_ids = docIds;
    }

    const { data } = await requestJson(endpoint, { method: 'POST', headers, body: payload });
    return data;
}

/**
 * 格式化查询结果用于显示。
 * @param {object} data - API 响应数据
 * @param {string} [conditionsStr] - 查询条件描述
 * @returns {string} 格式化的显示字符串
 */
function formatResults(data, conditionsStr = '') {
    const lines = [];

    if (conditionsStr) {
        lines.push(`🔍 查询条件：${conditionsStr}\n`);
    }

    const total = data.total || 0;
    const records = data.records || [];

    if (total === 0) {
        lines.push('❌ 未找到文档');
        return lines.join('\n');
    }

    lines.push(`✅ 共找到 ${total} 个文档，此次返回 ${records.length} 个文档\n`);

    for (const record of records) {
        const docId = record.doc_id ?? 'N/A';
        const docName = record.path ?? 'N/A';
        const topicId = record.topic_id ?? 'N/A';
        const metaFields = record.custom_meta_data || [];

        lines.push(`📄 ${docName} (doc_id: ${docId}, topic_id: ${topicId})`);

        if (metaFields.length > 0) {
            for (const field of metaFields) {
                const fieldName = field.field_name || 'N/A';
                const fieldType = field.field_type || 'str';
                let value;
                if (fieldType === 'str') {
                    value = field.field_value_str ?? 'N/A';
                } else if (fieldType === 'int') {
                    value = field.field_value_int ?? 'N/A';
                } else if (fieldType === 'date') {
                    value = field.field_value_date ?? 'N/A';
                } else {
                    value = field.field_value_str ?? 'N/A';
                }
                lines.push(`   • ${fieldName}: ${value}`);
            }
        } else {
            lines.push('   • 无元数据');
        }

        lines.push('');
    }

    return lines.join('\n');
}

/**
 * 构造机器可读摘要（成功时附在可读输出之后）。
 * @param {object} data - API 响应数据
 * @param {string} conditionsStr
 * @returns {object}
 */
function buildQueryPayload(data, conditionsStr) {
    const records = data.records || [];
    return {
        ok: true,
        mode: 'query',
        conditions: conditionsStr || '',
        total: data.total || 0,
        returned: records.length,
        documents: records.map((record) => ({
            doc_id: record.doc_id ?? null,
            path: record.path ?? '',
            topic_id: record.topic_id ?? null,
            meta: (record.custom_meta_data || []).map((field) => ({
                field_name: field.field_name,
                field_type: field.field_type,
                value: field.field_type === 'int'
                    ? field.field_value_int
                    : field.field_type === 'date'
                        ? field.field_value_date
                        : field.field_value_str,
            })),
        })),
    };
}

/**
 * 把工具层传来的 `{field, op, value}`（或 API 原生 `{field_name, operation, value}`）
 * 归一化成接口要求的条件对象。
 * @param {object} raw
 * @returns {object|null} null 表示不合法
 */
function normalizeCondition(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const field = raw.field_name ?? raw.field;
    const operation = raw.operation ?? raw.op;
    const value = raw.value;
    if (field === undefined || field === null || String(field) === '') return null;
    if (!operation || !VALID_OPERATIONS.has(String(operation))) return null;
    if (value === undefined || value === null) return null;
    return { field_name: String(field), operation: String(operation), value: String(value) };
}

/**
 * 字段结构模式：列出若干主题的元数据字段。
 * @param {object} config
 * @param {number[]} topicIds
 * @returns {Promise<object>} 结构化 payload
 */
async function runMetaFields(config, topicIds) {
    if (!Array.isArray(topicIds) || topicIds.length === 0) {
        throw new DocchainError('CONFIG', 'list_fields 模式需要提供 topic_ids');
    }
    const topics = [];
    for (const topicId of topicIds) {
        const result = await listTopicMetadataFields(config, topicId);
        if (result && result.success) {
            topics.push({ topic_id: topicId, fields: result.data || [] });
        } else {
            topics.push({ topic_id: topicId, error: (result && result.err) || '未知错误' });
        }
    }
    return { ok: true, mode: 'fields', topics };
}

/**
 * 条件查询模式：按元数据字段筛选文档。
 * CLI 与宿主工具共用这一条路径。
 * @param {object} config
 * @param {object} params - { conditions, orGroups, topicIds, docIds, size, conditionsStr }
 * @returns {Promise<object>} 结构化 payload
 */
async function runMetaQuery(config, params = {}) {
    const conditions = [];
    for (const raw of params.conditions || []) {
        const parsed = normalizeCondition(raw);
        if (!parsed) {
            throw new DocchainError(
                'CONFIG',
                `条件不合法：${JSON.stringify(raw)}；需要 {field, op, value}，op 取值如 eq/ne/contains/num_gt/time_lt`,
            );
        }
        conditions.push(parsed);
    }

    const orGroups = [];
    for (const group of params.orGroups || []) {
        const parsedGroup = [];
        for (const raw of group || []) {
            const parsed = normalizeCondition(raw);
            if (!parsed) {
                throw new DocchainError('CONFIG', `OR 组内条件不合法：${JSON.stringify(raw)}`);
            }
            parsedGroup.push(parsed);
        }
        if (parsedGroup.length > 0) orGroups.push(parsedGroup);
    }

    const topicIds = Array.isArray(params.topicIds) && params.topicIds.length ? params.topicIds : null;
    const docIds = Array.isArray(params.docIds) && params.docIds.length ? params.docIds : null;
    if (!topicIds && !docIds) {
        throw new DocchainError('CONFIG', '必须提供 topic_ids 或 doc_ids 之一');
    }

    const results = await queryByMetaFields(config, {
        conditions,
        topicIds,
        docIds,
        orGroups: orGroups.length > 0 ? orGroups : null,
        size: params.size ?? 100,
    });
    if (!results || !results.success) {
        throw new DocchainError('SERVER_ERROR', `查询失败：${(results && results.err) || '未知错误'}`);
    }
    // 没有现成的条件描述时，从条件对象反推，保证 payload 里的 conditions 不为空。
    const describe = (list) => list.map((c) => `${c.field_name} ${c.operation} ${c.value}`).join(' AND ');
    const derived = params.conditionsStr || [
        conditions.length ? describe(conditions) : '',
        ...orGroups.map((group) => `(${group.map((c) => `${c.field_name} ${c.operation} ${c.value}`).join(' OR ')})`),
    ].filter(Boolean).join(' AND ');
    return buildQueryPayload(results.data || {}, derived);
}

async function main() {
    const args = parseArgs(process.argv.slice(2), ARG_SPEC);

    // 解析主题 ID
    const topicIds = args.topic_ids ? parseIdList(args.topic_ids, '主题 ID') : null;

    // 解析文档 ID
    const docIds = args.doc_ids ? parseIdList(args.doc_ids, '文档 ID') : null;

    const config = getConfig();

    // --list_fields 模式：仅列出字段结构
    if (args.list_fields) {
        try {
            const payload = await runMetaFields(config, topicIds);
            for (const topic of payload.topics) {
                if (topic.error) {
                    console.log(`❌ 主题 ${topic.topic_id} 查询失败：${topic.error}`);
                } else {
                    console.log(formatMetadataFields(topic.fields, topic.topic_id));
                }
                console.log();
            }
            console.log(JSON.stringify(payload));
        } catch (error) {
            failWith(error);
        }
        return;
    }

    // 解析 AND 条件
    const conditions = [];
    let conditionsStr = '';
    if (args.conditions) {
        const conditionStrs = args.conditions.split(';').map((c) => c.trim()).filter(Boolean);
        conditionsStr = conditionStrs.join(' AND ');

        for (const condStr of conditionStrs) {
            const parsed = parseCondition(condStr);
            if (parsed) {
                conditions.push(parsed);
            } else {
                printError('CONFIG', `条件解析失败：${condStr}；格式应为 field_name,operation,value，例如 author,eq,张三`);
            }
        }
    }

    // 解析 OR 条件组
    const orGroups = [];
    const orGroupsDisplay = [];
    if (args.or_groups) {
        const groupStrs = args.or_groups.split(';').map((g) => g.trim()).filter(Boolean);

        for (const groupStr of groupStrs) {
            const conditionStrs = groupStr.split('|').map((c) => c.trim()).filter(Boolean);
            const groupConditions = [];
            const groupDisplayParts = [];
            for (const condStr of conditionStrs) {
                const parsed = parseCondition(condStr);
                if (parsed) {
                    groupConditions.push(parsed);
                    // 格式化条件显示：field_name operation value
                    groupDisplayParts.push(`${parsed.field_name} ${parsed.operation} ${parsed.value}`);
                } else {
                    printError('CONFIG', `OR组内条件解析失败：${condStr}`);
                }
            }
            if (groupConditions.length > 0) {
                orGroups.push(groupConditions);
                orGroupsDisplay.push(`(${groupDisplayParts.join(' OR ')})`);
            }
        }
    }

    // 检查 topic_ids 和 doc_ids
    if (!topicIds && !docIds) {
        printError('CONFIG', '错误：必须提供 --topic_ids 或 --doc_ids 之一');
    }

    // 构建条件描述
    let fullConditionsStr = conditionsStr;
    if (orGroupsDisplay.length > 0) {
        const orGroupsStr = orGroupsDisplay.join(' AND ');
        fullConditionsStr = conditionsStr ? `${conditionsStr} AND ${orGroupsStr}` : orGroupsStr;
    }

    try {
        // 直接用原始响应渲染可读表格，再用归一化 payload 输出机器可读 JSON。
        const results = await queryByMetaFields(config, {
            conditions,
            topicIds,
            docIds,
            orGroups: orGroups.length > 0 ? orGroups : null,
            size: args.size,
        });
        if (!results || !results.success) {
            printError('SERVER_ERROR', `查询失败：${(results && results.err) || '未知错误'}`);
        }
        const data = results.data || {};
        console.log(formatResults(data, fullConditionsStr));
        console.log(JSON.stringify(buildQueryPayload(data, fullConditionsStr)));
    } catch (error) {
        failWith(error);
    }
}

if (require.main === module) {
    main();
}

// The host half calls these directly (in-process tool execution).
module.exports = {
    listTopicMetadataFields,
    queryByMetaFields,
    parseCondition,
    normalizeCondition,
    runMetaFields,
    runMetaQuery,
    buildQueryPayload,
    formatResults,
    formatMetadataFields,
    VALID_OPERATIONS,
    getConfig,
    HttpError,
    DocchainError,
};
