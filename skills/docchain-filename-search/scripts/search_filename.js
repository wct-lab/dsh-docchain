#!/usr/bin/env node
/**
 * Docchain 文件名搜索脚本
 *
 * 根据关键字搜索 docchain 文档文件名。
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
方式3: 配置文件 docchain-filename-search/scripts/config.json， 如下格式：
\`\`\`json
{
  "docchain_url": "http://<host>:7100/llmdoc",
  "docchain_api_key": "your-api-key"
}
\`\`\`
方式4: 包内 skills/docchain_config.json，同上json格式（分发兜底，参考 docchain_config.example.json）
**注：配置取值顺序优先级为 环境变量 > scripts/config.json > ~/.dsh/storages/docchain-config.json > 包内 docchain_config.json**`;

const ARG_SPEC = {
    topic_ids: { type: 'string', required: true },
    keywords: { type: 'string', required: true },
};

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
 * Split a comma-separated string into trimmed, non-empty items.
 * @param {string} value
 * @returns {string[]}
 */
function splitList(value) {
    return value.split(',').map((item) => item.trim()).filter(Boolean);
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
 * 根据文件名关键字搜索文档（给定主题范围内）。
 * @param {object} config - { docchain_url, docchain_api_key }
 * @param {string[]} keywords - 要搜索的关键词列表
 * @param {number[]|null} topicIds - 要搜索的主题 ID 列表
 * @returns {Promise<object>} API 响应
 */
async function searchByFilename(config, keywords, topicIds) {
    const apiUrl = config.docchain_url.replace(/\/+$/, '');
    const endpoint = `${apiUrl}/v1/skills/search_docs_by_filename`;

    // 准备请求
    const headers = { 'Content-Type': 'application/json' };
    if (config.docchain_api_key) {
        headers['X-Api-Key'] = config.docchain_api_key;
    }

    const payload = { topic_ids: topicIds, keywords };

    // 调用 API
    const { data } = await requestJson(endpoint, { method: 'POST', headers, body: payload });
    if (data && data.success === false) {
        throw new DocchainError('SERVER_ERROR', `API请求失败: ${data.err || '未知错误'}`);
    }
    return data;
}

/**
 * 格式化搜索结果用于显示。
 * @param {object} data - API 响应数据
 * @returns {string} 格式化的显示字符串
 */
function formatResults(data) {
    const lines = [];

    // 标题
    lines.push(`🔍 搜索关键词：${JSON.stringify(data.keywords)}`);

    if (data.total === 0) {
        lines.push('❌ 未找到文档');
        return lines.join('\n');
    }

    lines.push(`✅ 找到 ${data.total} 个文档\n`);

    // 结果
    for (const result of data.results) {
        const docId = result.doc_id;
        const docName = result.doc_name;
        const topicId = result.topic_id;

        lines.push(`📄 文档 ID: ${docId} | ${docName}`);
        lines.push(`   主题 ID: ${topicId}\n`);
    }

    return lines.join('\n');
}

/**
 * 构造机器可读摘要（成功时附在可读输出之后）。
 * @param {object} data - API 响应数据
 * @returns {object}
 */
function buildPayload(data) {
    return {
        ok: true,
        mode: 'filename',
        keywords: data.keywords || [],
        total: data.total || 0,
        documents: (data.results || []).map((result) => ({
            doc_id: result.doc_id,
            doc_name: result.doc_name,
            topic_id: result.topic_id,
        })),
    };
}

/**
 * 完整文件名搜索：调用接口 → 归一化 → 空结果抛错。
 * CLI 与宿主工具共用这一条路径，保证两边行为一致。
 * @param {object} config - { docchain_url, docchain_api_key }
 * @param {object} params - { keywords, topicIds }
 * @returns {Promise<object>} 结构化 payload
 */
async function runFilenameSearch(config, { keywords, topicIds }) {
    const data = await searchByFilename(config, keywords, topicIds);
    const payload = buildPayload(data);
    if (!payload.total) {
        throw new DocchainError('NO_RESULTS', `未找到文档名称包含 ${JSON.stringify(payload.keywords)} 的文档`);
    }
    return payload;
}

async function main() {
    const args = parseArgs(process.argv.slice(2), ARG_SPEC);

    // 解析主题 ID
    const topicIds = args.topic_ids ? parseIdList(args.topic_ids, '主题 ID') : null;

    // 解析关键词
    const keywords = splitList(args.keywords);
    if (keywords.length === 0) {
        printError('CONFIG', '错误：未提供关键词');
    }

    if (!topicIds) {
        printError('CONFIG', '错误：必须提供 --topic_ids 参数');
    }

    try {
        const config = getConfig();
        const results = await searchByFilename(config, keywords, topicIds);
        const payload = buildPayload(results);

        // 显示结果
        console.log(formatResults(results));
        if (!payload.total) {
            // 空结果：与工具层一致地给出 NO_RESULTS，但不当作硬失败（exit 0）。
            console.log(JSON.stringify({
                ok: false,
                error: 'NO_RESULTS',
                message: `未找到文档名称包含 ${JSON.stringify(payload.keywords)} 的文档`,
            }));
            return;
        }
        console.log(JSON.stringify(payload));
    } catch (error) {
        failWith(error, { 403: '无权限访问主题', 404: '主题不存在' });
    }
}

if (require.main === module) {
    main();
}

// The host half calls these directly (in-process tool execution).
module.exports = {
    searchByFilename,
    buildPayload,
    formatResults,
    runFilenameSearch,
    getConfig,
    HttpError,
    DocchainError,
};
