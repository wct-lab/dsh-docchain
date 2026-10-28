#!/usr/bin/env node
/**
 * Docchain 主题信息查询脚本
 *
 * 查询主题列表，支持分页与关键字过滤。
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
方式3: 配置文件 docchain-topic-info/scripts/config.json， 如下格式：
\`\`\`json
{
  "docchain_url": "http://<host>:7100/llmdoc",
  "docchain_api_key": "your-api-key",
}
\`\`\`
方式4: 包内 skills/docchain_config.json，同上json格式（分发兜底，参考 docchain_config.example.json）
**注：配置取值顺序优先级为 环境变量 > scripts/config.json > ~/.dsh/storages/docchain-config.json > 包内 docchain_config.json**`;

const ARG_SPEC = {
    page: { type: 'int', default: 1 },
    size: { type: 'int', default: 20 },
    keyword: { type: 'string', default: null },
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
    for (const [name, spec] of Object.entries(argSpec)) {
        if (spec.required && (args[name] === null || args[name] === undefined)) {
            console.error(`❌ 错误：缺少必填参数 --${name}`);
            process.exit(1);
        }
        if (spec.choices && args[name] !== null && !spec.choices.includes(args[name])) {
            console.error(`❌ 错误：参数 --${name} 取值必须是 ${spec.choices.join('/')}`);
            process.exit(1);
        }
    }
    return args;
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
 * 分页查询主题列表。
 * @param {number} page - 页码，默认1
 * @param {number} size - 每页数量，默认20
 * @param {string|null} [keyword=null] - 主题名称关键字过滤，为空时不传该参数
 * @returns {Promise<object>} 包含主题列表的 JSON 对象
 */
async function listTopics(page = 1, size = 20, keyword = null) {
    const config = getConfig();
    const url = `${config.docchain_url.replace(/\/+$/, '')}/v1/topic/list_by_pagination`;
    const params = new URLSearchParams({ page: String(page), size: String(size) });
    if (keyword && String(keyword).trim()) {
        params.set('keyword', String(keyword).trim());
    }
    const endpoint = `${url}?${params.toString()}`;

    const headers = { 'X-Api-Key': config.docchain_api_key };

    try {
        const { data } = await requestJson(endpoint, { method: 'GET', headers });

        if (data && data.success === false) {
            printError('SERVER_ERROR', `查询主题列表失败：${data.err || '未知错误'}`);
        }

        // API 返回结构是 {"success":true,"data":{"total":X,"data":[...]}}
        // 需要获取 data.data 才能得到主题列表
        const result = data && data.data;
        if (result && typeof result === 'object' && !Array.isArray(result)) {
            return {
                total: result.total || 0,
                page,
                size,
                data: result.data || [],
            };
        }
        return result;
    } catch (error) {
        if (error instanceof HttpError) {
            if (error.status === 401 || error.status === 403) {
                printError('NO_PERMISSION', '无权限访问主题列表（HTTP ' + error.status + '）');
            }
            if (error.status >= 500) {
                printError('SERVER_ERROR', '服务端错误（HTTP ' + error.status + '）');
            }
            printError('SERVER_ERROR', 'API 请求失败：HTTP ' + error.status);
        }
        printError('SERVER_ERROR', `查询主题列表失败：${error.message}`);
    }
}

/**
 * 返回主题列表的简化 JSON 格式（供 AI skill 使用）。
 * @param {object} data - API 响应数据
 * @returns {object} 主题列表 JSON 对象
 */
function formatResults(data) {
    const total = data.total || 0;
    const page = data.page || 1;
    const size = data.size || 20;
    const pages = size > 0 ? Math.ceil(total / size) : 0;

    const topics = data.data || [];
    if (topics.length === 0) {
        return { total, page, size, pages, topics: [] };
    }

    // 提取关键字段
    const topicList = [];
    for (const topic of topics) {
        topicList.push({
            id: topic.id,
            name: topic.name || '',
            state: topic.state || '',
            create_date: topic.create_date || '',
            create_by_name: topic.create_by_name || '',
        });
    }

    return { total, page, size, pages, topics: topicList };
}

async function main() {
    const args = parseArgs(process.argv.slice(2), ARG_SPEC);

    // 查询主题列表
    const result = await listTopics(args.page, args.size, args.keyword);

    // 直接输出 JSON 格式（统一带 ok:true）
    console.log(JSON.stringify(Object.assign({ ok: true, mode: 'topics' }, formatResults(result))));
}

if (require.main === module) {
    main();
}
