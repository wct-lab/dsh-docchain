#!/usr/bin/env node
/**
 * Docchain 文档定位 / 正文读取脚本
 *
 * 按 doc_id 或文档名称关键字定位文档并列出详情；可选读取某个文档的正文
 * （本地分段，配合 offset/max_lines 续读）。
 *
 * 与 docchain-content-search 的区别：本脚本用于「按 id / 文档名找到是哪份文档」，
 * 而不是「在文档正文里 grep 关键词」。
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
方式3: 配置文件 docchain-doc-search/scripts/config.json， 如下格式：
\`\`\`json
{
  "docchain_url": "http://<host>:7100/llmdoc",
  "docchain_api_key": "your-api-key"
}
\`\`\`
方式4: 包内 skills/docchain_config.json，同上json格式（分发兜底，参考 docchain_config.example.json）
**注：配置取值顺序优先级为 环境变量 > scripts/config.json > ~/.dsh/storages/docchain-config.json > 包内 docchain_config.json**`;

const ARG_SPEC = {
    doc_ids: { type: 'string', default: null },
    keyword: { type: 'string', default: null },
    topic_ids: { type: 'string', default: null },
    content: { type: 'string', flag: true },
    offset: { type: 'int', default: 0 },
    max_lines: { type: 'int', default: 200 },
    size: { type: 'int', default: 20 },
};

const MAX_LINES_CAP = 2000;
const KEYWORD_SCAN_SIZE = 500;
const KEYWORD_RESULT_CAP = 100;

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
                    data = text;
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
 * @param {object} argSpec
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
            console.error(`❌ 错误：未知参数：${arg}`);
            process.exit(1);
        }
        if (spec.flag) {
            args[name] = true;
            continue;
        }
        if (value === undefined) {
            value = argv[i + 1];
            i += 1;
            if (value === undefined) {
                console.error(`❌ 错误：参数 ${arg} 缺少值`);
                process.exit(1);
            }
        }
        if (spec.type === 'int') {
            if (!/^\d+$/.test(value)) {
                console.error(`❌ 错误：参数 ${arg} 必须是数字`);
                process.exit(1);
            }
            value = parseInt(value, 10);
        }
        args[name] = value;
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
    for (const item of String(value).split(',')) {
        const trimmed = item.trim();
        if (!trimmed) continue;
        if (!/^\d+$/.test(trimmed)) {
            console.error(`❌ 错误：${label} 必须是数字`);
            process.exit(1);
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
 * and exit(1). Used both for config and API failures.
 * @param {string} error - CONFIG|NO_RESULTS|NOT_FOUND|NO_PERMISSION|SERVER_ERROR
 * @param {string} message
 */
function printError(error, message) {
    console.log(JSON.stringify({ ok: false, error, message }));
    process.exit(1);
}

/**
 * Base API URL with trailing slashes trimmed.
 * @param {object} config
 * @returns {string}
 */
function baseUrl(config) {
    return String(config.docchain_url).replace(/\/+$/, '');
}

/**
 * GET a docchain endpoint with the API key header.
 * @param {string} config
 * @param {string} endpoint - absolute URL
 * @returns {Promise<any>}
 */
async function getJson(config, endpoint) {
    const headers = { 'X-Api-Key': config.docchain_api_key };
    const { data } = await requestJson(endpoint, { method: 'GET', headers });
    return data;
}

/**
 * Fetch a single document's detail. Returns null when the doc does not exist
 * (server answers HTTP 200 with a JSON body of `null`).
 * @param {object} config
 * @param {number} docId
 * @returns {Promise<object|null>}
 */
async function fetchDetail(config, docId) {
    const data = await getJson(config, `${baseUrl(config)}/v1/doc/filedetail?doc_id=${docId}`);
    return data && typeof data === 'object' ? data : null;
}

/**
 * Resolve a topic id to its name; empty string when unknown.
 * @param {object} config
 * @param {number} topicId
 * @returns {Promise<string>}
 */
async function fetchTopicName(config, topicId) {
    if (!topicId) return '';
    try {
        const data = await getJson(config, `${baseUrl(config)}/v1/topic/info?topic_id=${topicId}`);
        const info = data && data.data ? data.data : data;
        return (info && info.name) || '';
    } catch (error) {
        return '';
    }
}

/**
 * Fetch the markdown text of a document. Throws HttpError on failure
 * (missing doc answers HTTP 500).
 * @param {object} config
 * @param {number} docId
 * @returns {Promise<string>}
 */
async function fetchMarkdown(config, docId) {
    const data = await getJson(config, `${baseUrl(config)}/v1/doc/read?doc_id=${docId}&read_format=md`);
    return typeof data === 'string' ? data : '';
}

/**
 * Extract a human-friendly basename from a detail record.
 * @param {object} detail
 * @returns {string}
 */
function docName(detail) {
    if (detail.base_name) {
        return detail.file_extension ? `${detail.base_name}${detail.file_extension}` : detail.base_name;
    }
    return detail.path || `文档 ${detail.id}`;
}

/**
 * Map an error to a structured failure and exit.
 * @param {Error} error
 */
function failWith(error) {
    if (error instanceof HttpError) {
        const status = error.status;
        if (status === 401 || status === 403) {
            printError('NO_PERMISSION', '无权限访问该文档或主题（HTTP ' + status + '）');
        }
        if (status >= 500) {
            printError('SERVER_ERROR', '服务端错误（HTTP ' + status + '）');
        }
        printError('SERVER_ERROR', 'API 请求失败：HTTP ' + status);
    }
    printError('SERVER_ERROR', '网络错误：' + error.message);
}

/**
 * Keyword mode: search documents by filename keyword.
 * @param {object} config
 * @param {string} keyword
 * @param {number[]|null} topicIds
 * @param {number} size
 */
async function searchByKeyword(config, keyword, topicIds, size) {
    const url = `${baseUrl(config)}/v1/doc/list?page=1&size=${KEYWORD_SCAN_SIZE}&keyword=${encodeURIComponent(keyword)}`;
    const data = await getJson(config, url);
    let rows = Array.isArray(data) ? data : [];
    if (topicIds && topicIds.length > 0) {
        const allow = new Set(topicIds);
        rows = rows.filter((row) => allow.has(Number(row.topic_id)));
    }
    const capped = rows.slice(0, Math.min(size, KEYWORD_RESULT_CAP));

    if (capped.length === 0) {
        printError('NO_RESULTS', `未找到文档名称包含「${keyword}」的文档`);
    }

    const topicNameCache = new Map();
    const lines = [`🔍 按文档名称搜索：${keyword}`, `✅ 找到 ${capped.length} 个文档`];
    if (rows.length > capped.length) {
        lines.push(`（匹配 ${rows.length} 个，仅显示前 ${capped.length} 个）`);
    }
    lines.push('');
    for (const row of capped) {
        const tid = Number(row.topic_id);
        if (!topicNameCache.has(tid)) {
            topicNameCache.set(tid, await fetchTopicName(config, tid));
        }
        const tname = topicNameCache.get(tid);
        const label = tname ? `${tname} (${tid})` : String(tid);
        lines.push(`📄 文档 ID: ${row.id} | ${row.path || ''}`);
        lines.push(`   主题: ${label}`);
        lines.push('');
    }
    console.log(lines.join('\n').trimEnd());
    console.log(JSON.stringify({
        ok: true,
        mode: 'keyword',
        keyword,
        total: capped.length,
        documents: capped.map((row) => ({
            doc_id: row.id,
            name: row.path || '',
            topic_id: Number(row.topic_id),
        })),
    }));
}

/**
 * Detail mode: resolve one or more doc_ids to their metadata.
 * @param {object} config
 * @param {number[]} docIds
 */
async function listDetails(config, docIds) {
    const found = [];
    const missing = [];
    const topicNameCache = new Map();

    for (const docId of docIds) {
        const detail = await fetchDetail(config, docId);
        if (!detail) {
            missing.push(docId);
            continue;
        }
        const tid = Number(detail.topic_id);
        if (!topicNameCache.has(tid)) {
            topicNameCache.set(tid, await fetchTopicName(config, tid));
        }
        found.push({ detail, topicName: topicNameCache.get(tid) });
    }

    if (found.length === 0 && missing.length > 0) {
        printError('NOT_FOUND', `未找到文档：${missing.join(', ')}（doc_id 不存在或无权访问）`);
    }

    const lines = [`📋 共查询 ${docIds.length} 个文档，成功 ${found.length} 个` +
        (missing.length ? `，未找到 ${missing.length} 个` : '')];
    lines.push('');
    for (const { detail, topicName } of found) {
        const label = topicName ? `${topicName} (${detail.topic_id})` : String(detail.topic_id);
        let pages = '';
        if (detail.meta_data) {
            try {
                const meta = JSON.parse(detail.meta_data);
                if (meta && typeof meta.pages === 'number' && meta.pages > 0) {
                    pages = String(meta.pages);
                }
            } catch (error) { /* ignore malformed meta */ }
        }
        lines.push(`📄 ${docName(detail)}`);
        lines.push(`   ID: ${detail.id} | 主题: ${label}`);
        const sizeInfo = typeof detail.file_size === 'number'
            ? detail.file_size.toLocaleString('en-US')
            : String(detail.file_size || '');
        const bits = [];
        if (pages) bits.push(`页数: ${pages}`);
        if (sizeInfo) bits.push(`大小: ${sizeInfo} B`);
        if (detail.state) bits.push(`状态: ${detail.state}`);
        if (bits.length) lines.push('   ' + bits.join(' | '));
        lines.push('');
    }
    for (const docId of missing) {
        lines.push(`⚠️ 文档 ${docId}：未找到（doc_id 不存在或无权访问）`);
    }
    console.log(lines.join('\n').trimEnd());
    console.log(JSON.stringify({
        ok: true,
        mode: 'detail',
        documents: found.map(({ detail, topicName }) => ({
            doc_id: detail.id,
            name: docName(detail),
            topic_id: Number(detail.topic_id),
            topic_name: topicName,
            file_size: detail.file_size,
            state: detail.state,
        })),
        missing,
    }));
}

/**
 * Content mode: read a single document's markdown text in one page.
 * @param {object} config
 * @param {number} docId
 * @param {number} offset
 * @param {number} maxLines
 */
async function readContent(config, docId, offset, maxLines) {
    const detail = await fetchDetail(config, docId);
    if (!detail) {
        printError('NOT_FOUND', `未找到文档 ${docId}（doc_id 不存在或无权访问）`);
    }

    let text;
    try {
        text = await fetchMarkdown(config, docId);
    } catch (error) {
        if (error instanceof HttpError && error.status >= 500) {
            printError('NOT_FOUND', `文档 ${docId} 无法读取正文（可能是空文档或未转换）`);
        }
        throw error;
    }

    const allLines = text.split('\n');
    const totalLines = allLines.length;
    const start = Math.min(offset, totalLines);
    const end = Math.min(start + maxLines, totalLines);
    const chunk = allLines.slice(start, end);
    const nextOffset = end < totalLines ? end : null;
    const topicName = await fetchTopicName(config, detail.topic_id);
    const label = topicName ? `${topicName} (${detail.topic_id})` : String(detail.topic_id);

    const header = `📖 ${docName(detail)}（ID: ${docId}，主题: ${label}）`;
    const range = `第 ${start + 1}–${end} 行 / 共 ${totalLines} 行` + (nextOffset !== null ? `（还有内容，next_offset=${nextOffset}）` : '（已到末尾）');
    console.log([header, range, '', chunk.join('\n')].join('\n'));
    console.log(JSON.stringify({
        ok: true,
        mode: 'content',
        doc_id: detail.id,
        name: docName(detail),
        topic_id: Number(detail.topic_id),
        topic_name: topicName,
        offset: start,
        max_lines: maxLines,
        total_lines: totalLines,
        returned_lines: chunk.length,
        truncated: nextOffset !== null,
        next_offset: nextOffset,
    }));
}

async function main() {
    const args = parseArgs(process.argv.slice(2), ARG_SPEC);

    const hasIds = args.doc_ids !== null && String(args.doc_ids).trim() !== '';
    const hasKeyword = args.keyword !== null && String(args.keyword).trim() !== '';

    if (hasIds && hasKeyword) {
        printError('CONFIG', '错误：--doc_ids 与 --keyword 只能二选一');
    }
    if (!hasIds && !hasKeyword) {
        printError('CONFIG', '错误：必须提供 --doc_ids 或 --keyword 之一');
    }

    const docIds = hasIds ? parseIdList(args.doc_ids, '文档 ID') : null;
    const topicIds = args.topic_ids !== null && String(args.topic_ids).trim() !== ''
        ? parseIdList(args.topic_ids, '主题 ID')
        : null;

    if (args.content && (!docIds || docIds.length !== 1)) {
        printError('CONFIG', '错误：--content 读取正文时只允许指定 1 个 doc_id');
    }

    const maxLines = Math.min(Math.max(args.max_lines, 1), MAX_LINES_CAP);
    const offset = Math.max(args.offset, 0);

    const config = getConfig();

    try {
        if (args.content) {
            await readContent(config, docIds[0], offset, maxLines);
            return;
        }
        if (hasKeyword) {
            await searchByKeyword(config, String(args.keyword).trim(), topicIds, args.size);
            return;
        }
        await listDetails(config, docIds);
    } catch (error) {
        failWith(error);
    }
}

if (require.main === module) {
    main();
}
