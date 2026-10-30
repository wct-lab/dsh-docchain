#!/usr/bin/env node
/**
 * Docchain 图搜图：用一张本地图片，在当前环境里找相似图片。
 *
 * 流程（与服务端既有能力一致，前端页面用的是同一套）：
 *   1. 上传图片拿 file_path  → POST {root}/v2/chat/upload?topic_id=<id>
 *   2. 按主题做向量检索      → POST {root}/v1/img/search?topic_id=<id>&image=<file_path>
 *   3. 把命中的图下载到本地  → GET  {root}/v1/doc/read?doc_id=<id>&read_format=path&path=<path>
 * 为什么必须先上传：检索接口只接受服务端侧的 file_path，不接受本地字节或外链。
 *
 * 服务端返回的每条结果已自带 topic_id/topic_name/doc_id/doc_name/doc_ext/score，
 * 因此本脚本不需要再查主题名。
 *
 * 配置沿用包内共享链：环境变量 > scripts/config.json >
 * ~/.dsh/storages/docchain-config.json > 包内 skills/docchain_config.json。
 * 默认检索范围取自该状态文件的 docchain_topic_ids（配置页选中的主题）。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const { URL } = require('url');

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 20;
const DEFAULT_CONCURRENCY = 6;
const MAX_CONCURRENCY = 16;
const DEFAULT_MAX_SECONDS = 300;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const ALLOWED_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.bmp'];
const UPLOAD_TIMEOUT = 60000;
const SEARCH_TIMEOUT = 60000;
const DOWNLOAD_TIMEOUT = 60000;

const CONFIG_MESSAGE = `请正确配置以下参数
docchain_url: 环境指向地址（必填）
docchain_api_key: 环境的账号验证方式（必填）
方式1: 环境变量 DOCCHAIN_URL, DOCCHAIN_API_KEY
方式2: 插件配置：dsh-docchain 插件的 Config（激活时自动写入
       ~/.dsh/storages/docchain-config.json，也可直接手动编辑该文件）
方式3: 配置文件 docchain-image-search/scripts/config.json
方式4: 包内 skills/docchain_config.json（分发兜底）`;

const ARG_SPEC = {
    image: { type: 'string', default: null },
    topic_ids: { type: 'string', default: null },
    all: { type: 'flag', flag: true, default: false },
    limit: { type: 'int', default: DEFAULT_LIMIT },
    concurrency: { type: 'int', default: DEFAULT_CONCURRENCY },
    'max-seconds': { type: 'int', default: DEFAULT_MAX_SECONDS },
};

/** 输出一条失败结果并退出。 */
function fail(code, message, extra) {
    const payload = Object.assign({ ok: false, error: code, message }, extra || {});
    console.log(JSON.stringify(payload));
    process.exit(code === 'NO_RESULTS' ? 0 : 1);
}

/**
 * A business failure carrying the same error vocabulary as the tool layer.
 * The compute path throws this instead of printing and exiting, so the same
 * code serves both the CLI and the in-process tool registration.
 */
class DocchainError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'DocchainError';
        this.code = code;
    }
}

/** 解析 `--flag value` / `--flag=value` 参数。 */
function parseArgs(argv) {
    const args = {};
    for (const [name, spec] of Object.entries(ARG_SPEC)) {
        args[name] = spec.default !== undefined ? spec.default : null;
    }
    for (let i = 0; i < argv.length; i += 1) {
        const raw = argv[i];
        if (!raw.startsWith('--')) continue;
        let name = raw.slice(2);
        let value;
        const eq = name.indexOf('=');
        if (eq >= 0) {
            value = name.slice(eq + 1);
            name = name.slice(0, eq);
        }
        const spec = ARG_SPEC[name];
        if (!spec) {
            fail('CONFIG', `未知参数：${raw}；可用参数：--image --topic_ids --all --limit --concurrency --max-seconds`);
        }
        if (spec.flag) {
            args[name] = true;
            continue;
        }
        if (value === undefined) {
            value = argv[i + 1];
            i += 1;
            if (value === undefined) {
                fail('CONFIG', `参数 ${raw} 缺少值`);
            }
        }
        if (spec.type === 'int') {
            if (!/^\d+$/.test(value)) {
                fail('CONFIG', `参数 ${raw} 必须是数字`);
            }
            value = parseInt(value, 10);
        }
        args[name] = value;
    }
    return args;
}

/** 读一个 JSON 配置文件，不存在或非法时返回 null。 */
function readJsonFile(file) {
    if (!fs.existsSync(file)) return null;
    try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch (error) {
        console.error(`警告：配置文件不是合法 JSON，已忽略：${file}`);
        return null;
    }
}

/**
 * 组装配置：四个来源按优先级合并。
 * 除 url/key 外还带出 docchain_topic_ids —— 配置页选中的主题，作为默认检索范围。
 * @returns {{url: string, key: string, topicIds: number[], topicNames: string[]}}
 */
function getConfig() {
    const stateFile = path.join(os.homedir(), '.dsh', 'storages', 'docchain-config.json');
    const config = Object.assign(
        {},
        readJsonFile(path.join(__dirname, '..', '..', 'docchain_config.json')),
        readJsonFile(stateFile),
        readJsonFile(path.join(__dirname, 'config.json')),
    );
    if (process.env.DOCCHAIN_URL) config.docchain_url = process.env.DOCCHAIN_URL;
    if (process.env.DOCCHAIN_API_KEY) config.docchain_api_key = process.env.DOCCHAIN_API_KEY;

    if (!config.docchain_url || !config.docchain_api_key) {
        fail('CONFIG', CONFIG_MESSAGE);
    }
    const topicIds = Array.isArray(config.docchain_topic_ids)
        ? config.docchain_topic_ids.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0)
        : [];
    const topicNames = Array.isArray(config.docchain_topic_names) ? config.docchain_topic_names.map(String) : [];
    return {
        url: String(config.docchain_url).replace(/\/+$/, ''),
        key: String(config.docchain_api_key),
        topicIds,
        topicNames,
    };
}

/** 服务地址去掉尾部的 `/v1`，用于拼接不同前缀的接口。 */
function apiRoot(url) {
    return url.replace(/\/v1$/, '');
}

/** 极简 HTTP 请求；`binary` 为真时返回 Buffer，否则返回解析后的 JSON 或文本。 */
function request(urlString, options) {
    const opts = options || {};
    return new Promise((resolve, reject) => {
        let target;
        try {
            target = new URL(urlString);
        } catch {
            reject(new Error(`地址无效：${urlString}`));
            return;
        }
        const isHttps = target.protocol === 'https:';
        const lib = isHttps ? https : http;
        const headers = Object.assign({}, opts.headers || {});
        const payload = opts.body === undefined ? null : opts.body;
        if (payload !== null && !headers['Content-Length']) {
            headers['Content-Length'] = Buffer.byteLength(payload);
        }
        const req = lib.request(
            {
                hostname: target.hostname,
                port: target.port || (isHttps ? 443 : 80),
                path: target.pathname + target.search,
                method: opts.method || 'GET',
                headers,
                timeout: opts.timeout || SEARCH_TIMEOUT,
            },
            (res) => {
                const chunks = [];
                res.on('data', (chunk) => chunks.push(chunk));
                res.on('end', () => {
                    const buffer = Buffer.concat(chunks);
                    if (res.statusCode >= 400) {
                        const text = buffer.toString('utf8');
                        const error = new Error(`HTTP ${res.statusCode}${text ? `: ${text.slice(0, 200)}` : ''}`);
                        error.status = res.statusCode;
                        error.body = text;
                        reject(error);
                        return;
                    }
                    if (opts.binary) {
                        resolve({ status: res.statusCode, buffer, headers: res.headers });
                        return;
                    }
                    resolve({ status: res.statusCode, text: buffer.toString('utf8'), headers: res.headers });
                });
            },
        );
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('请求超时'));
        });
        req.on('error', reject);
        if (payload !== null) req.write(payload);
        req.end();
    });
}

/** 用 multipart/form-data 上传一张图片，返回服务端的 file_path。 */
async function uploadImage(root, key, imagePath, topicId) {
    const bytes = fs.readFileSync(imagePath);
    // The multipart header is read as latin-1 by many parsers, so a non-ASCII
    // filename would arrive as mojibake and can be rejected. The name is not
    // used server-side anyway — the stored path is generated — so keep it ASCII.
    const filename = path
        .basename(imagePath)
        .replace(/[^\x20-\x7E]/g, '_')
        .replace(/["\\]/g, '_') || 'image';
    const boundary = `----dshdocchain${Date.now().toString(16)}`;
    const head = Buffer.from(
        `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
            `Content-Type: application/octet-stream\r\n\r\n`,
        'utf8',
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
    const body = Buffer.concat([head, bytes, tail]);
    const response = await request(`${root}/v2/chat/upload?topic_id=${encodeURIComponent(topicId)}`, {
        method: 'POST',
        headers: {
            'X-Api-Key': key,
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
        },
        body,
        timeout: UPLOAD_TIMEOUT,
    });
    let data;
    try {
        data = JSON.parse(response.text);
    } catch {
        throw new Error('上传接口返回的不是 JSON');
    }
    const filePath = data && data.data && data.data.file_path;
    if (!filePath) {
        throw new Error((data && (data.err || data.message)) || '上传接口未返回 file_path');
    }
    return filePath;
}

/** 在一个主题里做一次图搜。返回规范化后的条目数组。 */
async function searchTopic(root, key, topicId, filePath) {
    const query = `topic_id=${encodeURIComponent(topicId)}&image=${encodeURIComponent(filePath)}`;
    const body = JSON.stringify({ type: 'img', topic_id: topicId, image: filePath });
    const response = await request(`${root}/v1/img/search?${query}`, {
        method: 'POST',
        headers: { 'X-Api-Key': key, 'Content-Type': 'application/json' },
        body,
        timeout: SEARCH_TIMEOUT,
    });
    // 服务端返回的是"文本形式的 JSON 数组"，不是 JSON 对象。
    let parsed;
    try {
        parsed = JSON.parse(response.text);
    } catch {
        throw new Error('检索接口返回的不是 JSON 数组');
    }
    if (!Array.isArray(parsed)) {
        // 空结果也可能被包成 {"success":true,...} 之外的形状，统一按失败处理。
        if (parsed && parsed.success === false) {
            throw new Error(parsed.err || '检索失败');
        }
        return [];
    }
    return parsed.map((item) => ({
        doc_id: Number(item.doc_id) || 0,
        doc_name: String(item.doc_name || ''),
        doc_ext: String(item.doc_ext || ''),
        topic_id: Number(item.topic_id) || Number(topicId) || 0,
        topic_name: String(item.topic_name || ''),
        score: Number(item.score) || 0,
        path: String(item.path || ''),
        page_num: Number(item.page_num) || 0,
        heading: String(item.heading_chain || ''),
        context: String(item.content || '').slice(0, 160),
    }));
}

/** 拉取当前环境的全部主题 id。 */
async function listAllTopicIds(root, key) {
    const ids = [];
    const size = 200;
    let page = 1;
    let total = Infinity;
    while (ids.length < total && page <= 200) {
        const url = `${root}/v1/topic/list_by_pagination?page=${page}&size=${size}`;
        const response = await request(url, { headers: { 'X-Api-Key': key }, timeout: SEARCH_TIMEOUT });
        let data;
        try {
            data = JSON.parse(response.text);
        } catch {
            throw new Error('主题列表返回的不是 JSON');
        }
        const payload = (data && data.data) || {};
        total = Number(payload.total) || 0;
        const rows = Array.isArray(payload.data) ? payload.data : [];
        if (rows.length === 0) break;
        for (const row of rows) {
            const id = Number(row.id);
            if (Number.isInteger(id) && id > 0) ids.push(id);
        }
        page += 1;
    }
    return ids;
}

/** 下载一张命中图片，返回本地路径（失败返回空串）。 */
async function downloadHit(root, key, item, dir, index) {
    if (!item.path) return '';
    const ext = path.extname(item.path) || (item.doc_ext ? `.${item.doc_ext}` : '.png');
    const safeExt = /^\.[A-Za-z0-9]{1,5}$/.test(ext) ? ext : '.png';
    const file = path.join(dir, `${item.doc_id || 'doc'}_${index}${safeExt}`);
    const url =
        `${root}/v1/doc/read?doc_id=${encodeURIComponent(item.doc_id)}` +
        `&read_format=path&path=${encodeURIComponent(item.path)}`;
    try {
        const response = await request(url, { headers: { 'X-Api-Key': key }, binary: true, timeout: DOWNLOAD_TIMEOUT });
        if (!response.buffer || response.buffer.length === 0) return '';
        fs.writeFileSync(file, response.buffer);
        return file;
    } catch (error) {
        return '';
    }
}

/** 并发受限地跑一组异步任务，结果按原顺序返回。 */
async function mapLimit(items, limit, worker) {
    const results = new Array(items.length);
    let cursor = 0;
    const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
        for (;;) {
            const index = cursor;
            cursor += 1;
            if (index >= items.length) return;
            results[index] = await worker(items[index], index);
        }
    });
    await Promise.all(runners);
    return results;
}

/**
 * 图搜图主流程：校验 → 上传一次 → 按主题并发检索 → 合并排序 → 下载命中图。
 * CLI 与宿主工具共用这一条路径；内部只抛 DocchainError，不打印、不退出。
 *
 * @param {object} config - { url, key, topicIds }
 * @param {object} params - { image, topicIds, all, limit, concurrency, maxSeconds }
 * @returns {Promise<object>} 结构化 payload
 */
async function runImageSearch(config, params = {}) {
    const root = apiRoot(config.url);
    const quiet = params.quiet !== false;
    const say = (line) => {
        if (!quiet) console.error(line);
    };

    const imagePath = params.image;
    if (!imagePath) {
        throw new DocchainError('CONFIG', '缺少 image 参数：请提供一张本地图片的路径。');
    }
    if (!fs.existsSync(imagePath) || !fs.statSync(imagePath).isFile()) {
        throw new DocchainError('CONFIG', `图片不存在或不是文件：${imagePath}`);
    }
    const size = fs.statSync(imagePath).size;
    if (size > MAX_IMAGE_BYTES) {
        throw new DocchainError('CONFIG', `图片过大（${Math.round(size / 1024 / 1024)}MB），上限 20MB。`);
    }
    const ext = path.extname(imagePath).toLowerCase();
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
        throw new DocchainError('CONFIG', `不支持的图片格式：${ext || '(无扩展名)'}；支持 ${ALLOWED_EXTENSIONS.join(' ')}`);
    }

    const limit = Math.min(MAX_LIMIT, Math.max(1, params.limit || DEFAULT_LIMIT));
    const concurrency = Math.min(MAX_CONCURRENCY, Math.max(1, params.concurrency || DEFAULT_CONCURRENCY));
    const startedAt = Date.now();

    // 检索范围优先级：显式主题 > 全库 > 配置页选中主题（与 SKILL.md 一致）
    let topicIds = [];
    let scannedAll = false;
    if (Array.isArray(params.topicIds) && params.topicIds.length > 0) {
        topicIds = params.topicIds.filter((id) => Number.isInteger(id) && id > 0);
        if (topicIds.length === 0) throw new DocchainError('CONFIG', 'topic_ids 里没有有效的主题 ID。');
        if (params.all) say('提示：同时给了 topic_ids 和 all，按 topic_ids 指定的范围检索。');
    } else if (params.all) {
        scannedAll = true;
        try {
            topicIds = await listAllTopicIds(root, config.key);
        } catch (error) {
            throw new DocchainError('SERVER_ERROR', `拉取主题列表失败：${error.message}`);
        }
        if (topicIds.length === 0) throw new DocchainError('NO_RESULTS', '当前环境没有任何主题。');
    }
    if (topicIds.length === 0) {
        topicIds = config.topicIds || [];
    }
    // 同一主题写两次不值得发两次请求，也不该让结果被重复合并。
    topicIds = [...new Set(topicIds)];
    if (topicIds.length === 0) {
        throw new DocchainError(
            'CONFIG',
            '未选择主题：请在插件配置页为当前环境选择主题，或指定 topic_ids，或用 all 扫描全部主题。',
        );
    }

    // 上传一次即可，后续所有主题复用同一个 file_path。
    let filePath;
    try {
        filePath = await uploadImage(root, config.key, imagePath, topicIds[0]);
    } catch (error) {
        throw new DocchainError('SERVER_ERROR', `图片上传失败：${error.message}`);
    }

    const warnings = [];
    let timedOut = false;
    const deadline = startedAt + (params.maxSeconds || DEFAULT_MAX_SECONDS) * 1000;
    let scanned = 0;
    const perTopic = await mapLimit(topicIds, concurrency, async (topicId) => {
        if (Date.now() > deadline) {
            timedOut = true;
            return [];
        }
        scanned += 1;
        if (topicIds.length > 20 && scanned % 50 === 0) {
            say(`… 已扫描 ${scanned}/${topicIds.length} 个主题`);
        }
        try {
            return await searchTopic(root, config.key, topicId, filePath);
        } catch (error) {
            const status = error.status || 0;
            if (status === 400 || /does not have permission/i.test(error.message)) {
                warnings.push({ topic_id: topicId, code: 'NO_PERMISSION', message: '无该主题权限' });
            } else if (status === 500) {
                warnings.push({ topic_id: topicId, code: 'SERVER_ERROR', message: '服务端处理该图失败（HTTP 500）' });
            } else {
                warnings.push({ topic_id: topicId, code: 'SEARCH_FAILED', message: error.message });
            }
            return [];
        }
    });

    const merged = [];
    const seen = new Set();
    for (const rows of perTopic) {
        for (const item of rows) {
            const id = `${item.doc_id}::${item.path}`;
            if (seen.has(id)) continue;
            seen.add(id);
            merged.push(item);
        }
    }
    merged.sort((a, b) => b.score - a.score);
    const top = merged.slice(0, limit);

    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const dir = path.join(os.tmpdir(), 'dsh-docchain-image-search', stamp);
    if (top.length > 0) fs.mkdirSync(dir, { recursive: true });

    const items = [];
    for (let i = 0; i < top.length; i += 1) {
        const item = top[i];
        const localPath = await downloadHit(root, config.key, item, dir, i + 1);
        if (!localPath && item.path) {
            warnings.push({ doc_id: item.doc_id, code: 'DOWNLOAD_FAILED', message: '命中图片下载失败' });
        }
        items.push(Object.assign({}, item, { local_path: localPath }));
    }

    if (items.length === 0) {
        const msgParts = ['没有找到相似图片。'];
        if (scannedAll) msgParts.push(`已扫描 ${scanned}/${topicIds.length} 个主题${timedOut ? '（超时提前结束）' : ''}。`);
        if (warnings.some((w) => w.code === 'SERVER_ERROR')) {
            msgParts.push('部分主题检索时服务端返回 500（该图无法被处理），可换一张图或稍后重试。');
        }
        msgParts.push(
            '若你确认库里有这张图：图片向量是按主题建立的，说明这些主题还没有做图片向量化（实测同一实例上有向量的主题能命中、没有的恒为空），需要服务端对相应主题补跑图片向量。',
        );
        throw new DocchainError('NO_RESULTS', msgParts.join(' '));
    }

    return {
        ok: true,
        mode: 'image',
        query: { image: imagePath, topics: topicIds },
        scanned,
        total: topicIds.length,
        elapsed_ms: Date.now() - startedAt,
        dir,
        items,
        warnings,
    };
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const config = getConfig();
    const rawTopics = args.topic_ids
        ? String(args.topic_ids)
            .split(',')
            .map((value) => Number(String(value).trim()))
            .filter((id) => Number.isInteger(id) && id > 0)
        : null;
    try {
        const payload = await runImageSearch(
            { url: config.url, key: config.key, topicIds: config.topicIds },
            {
                image: args.image,
                topicIds: rawTopics,
                all: args.all,
                limit: args.limit,
                concurrency: args.concurrency,
                maxSeconds: args['max-seconds'],
                quiet: false,
            },
        );
        console.log(JSON.stringify(payload));
    } catch (error) {
        fail(error.code || 'SERVER_ERROR', error.message);
    }
}

if (require.main === module) {
    main().catch((error) => {
        fail('SERVER_ERROR', error && error.message ? error.message : String(error));
    });
}

// The host half calls these directly (in-process tool execution).
module.exports = {
    runImageSearch,
    getConfig,
    DocchainError,
    ALLOWED_EXTENSIONS,
};
