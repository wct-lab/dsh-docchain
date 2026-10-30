#!/usr/bin/env node
/**
 * Docchain 文档图片转文字：读主 md → 逐张图片交给视觉模型生成中文描述 →
 * 在每张图片上方插入 `<!-- image-desc: … -->` → 调 save_markdown 存成旁路描述 md。
 *
 * 流程（每一步都对应服务端已实测的行为）：
 *   1. 取文档详情                     → GET  {root}/v1/doc/filedetail?doc_id=<id>
 *   2. 读主 md                        → GET  {root}/v1/doc/read?doc_id=<id>&read_format=md
 *   3. 解析 ![](…) / <img src> 里的图  → 图片地址是 docchain 自己的 read 接口
 *   4. 逐张取字节                     → GET  {origin}<图片地址>  （带 X-Api-Key，仅同源）
 *   5. 视觉模型描述                   → POST {vision}/chat/completions
 *   6. 拼装（图片上方插注释，内存里）
 *   7. 保存到旁路描述 md              → POST {root}/v1/doc/save_markdown
 *                                       {doc_id, content, is_image_description: true}
 *   8. 校验                           → 主 md 哈希未变 + 读回
 *                                       GET {root}/v1/doc/read?doc_id=<id>&read_format=image_description_md
 *
 * 为什么保存后还要校验：save_markdown 是一个接口承载两种语义（默认 false = 覆盖主 md），
 * 服务端不校验也不回报落点。所以我们自己看主 md 有没有被动：变了就判定走错分支，
 * 立刻用"不带 flag"的调用把原主 md 写回去（自愈），再报 SAVE_WRONG_TARGET。
 *
 * 配置沿用包内共享链：环境变量 > scripts/config.json >
 * ~/.dsh/storages/docchain-config.json > 包内 skills/docchain_config.json。
 * 视觉模型的 key 只从凭据库（工具路径）或 VISION_API_KEY（CLI）取，不落到投影文件里。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { URL } = require('url');
const vision = require('./vision.js');

/** 并发：实测 8 是"快且不触发 429"的位置（12 起大量 429，3/4 反而更慢）。 */
const DEFAULT_CONCURRENCY = 8;
const MAX_CONCURRENCY = 10;
/** 每篇最多处理多少张图；0 表示全部。 */
const DEFAULT_MAX_IMAGES = 0;
const MAX_IMAGES_CAP = 2000;
/** 单张图片上限；超过就跳过并记失败（不引第三方图像库做压缩）。 */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/** 注释前缀：脚本里唯一一处，要换写法只改这里。 */
const DESC_PREFIX = '<!-- image-desc: ';
const DESC_SUFFIX = ' -->';
/**
 * 单条描述的字数上限（按字符，不是字节）。
 *
 * 800 而不是 300：实测 194 条里 5 条顶到 300 被截断，恰好全是架构图与密集表格 ——
 * 也就是信息量最大、最不该砍的图。上限只是保险丝，真正决定长度的是提示词。
 */
/**
 * 单条描述的字数上限（按字符，不是字节）。
 *
 * 2000 而不是 300：实测硬限 3 句后，架构图与密集表格会丢掉关键信息，
 * 而这正是描述最有价值的地方。上限只是保险丝 —— 真正决定长度的是提示词。
 * 可以用配置项 docchain_vision_max_desc_chars 覆盖（CLI 也认这个键）。
 */
const DESC_MAX_CHARS = 2000;
/** 视觉模型单次输出的 token 上限；中文约 1 字 1 token，1200 字留足余量。 */
const DESC_MAX_TOKENS = 2600;
/** 描述文件未生成时服务端返回的哨兵串；不是 404。 */
const SENTINEL = 'Image description markdown file not found...';
const SENTINEL_BYTES = Buffer.byteLength(SENTINEL);

const READ_TIMEOUT = 60000;
const DETAIL_TIMEOUT = 30000;
const DOWNLOAD_TIMEOUT = 60000;
const SAVE_TIMEOUT = 300000;
const LIST_TIMEOUT = 30000;

/** 关键字搜文档时扫描多少条（与 docchain-doc-search 同口径）。 */
const KEYWORD_SCAN_SIZE = 200;
const KEYWORD_RESULT_CAP = 100;

const CONFIG_MESSAGE = `请正确配置以下参数
docchain_url: 环境指向地址（必填）
docchain_api_key: 环境的账号验证方式（必填）
vision_api_key: 视觉模型网关的 Key（工具路径从凭据库 IWHALE_API_KEY 读取；CLI 需设 VISION_API_KEY）
方式1: 环境变量 DOCCHAIN_URL, DOCCHAIN_API_KEY, VISION_API_KEY, VISION_BASE_URL, VISION_MODEL
方式2: 插件配置：dsh-docchain 插件的 Config（激活时自动写入
       ~/.dsh/storages/docchain-config.json，也可直接手动编辑该文件）
方式3: 配置文件 docchain-image-describe/scripts/config.json
方式4: 包内 skills/docchain_config.json（分发兜底）`;

const DEFAULT_VISION_URL = 'https://lab.iwhalecloud.com/gpt-proxy/v1';
const DEFAULT_VISION_MODEL = 'qwen3-vl-plus';
const DEFAULT_VISION_FALLBACK = 'g-deepseek-v4-flash';

const ARG_SPEC = {
    doc_ids: { type: 'string', default: null },
    keyword: { type: 'string', default: null },
    topic_ids: { type: 'string', default: null },
    'max-images': { type: 'int', default: DEFAULT_MAX_IMAGES },
    concurrency: { type: 'int', default: DEFAULT_CONCURRENCY },
    model: { type: 'string', default: null },
    'dry-run': { type: 'flag', flag: true, default: false },
    'list-models': { type: 'flag', flag: true, default: false },
    read: { type: 'flag', flag: true, default: false },
    confirm: { type: 'flag', flag: true, default: false },
};

const USAGE = `用法：
  node scripts/describe_images.js --doc_ids 125755 [--max-images 2] [--dry-run]
  node scripts/describe_images.js --keyword 大语言模型 [--topic_ids 10904]
  node scripts/describe_images.js --doc_ids 125755,125676 --confirm
  node scripts/describe_images.js --list-models
  node scripts/describe_images.js --doc_ids 125755 --read`;

/** 输出一条失败结果并退出。只在 CLI 路径上调用；compute 路径必须抛错。 */
function fail(code, message, extra) {
    const payload = Object.assign({ ok: false, error: code, message }, extra || {});
    console.log(JSON.stringify(payload));
    process.exit(code === 'NOT_GENERATED' || code === 'NO_RESULTS' ? 0 : 1);
}

/**
 * A business failure carrying the same error vocabulary as the tool layer.
 * The compute path throws this instead of printing and exiting, so the same
 * code serves both the CLI and the in-process tool registration.
 */
class DocchainError extends Error {
    constructor(code, message, extra) {
        super(message);
        this.name = 'DocchainError';
        this.code = code;
        if (extra) Object.assign(this, extra);
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
            fail('CONFIG', `未知参数：${raw}\n${USAGE}`);
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

/** 把 `1,2,3` 或 `[1,2]` 规范成正整数数组。 */
function toIdList(value) {
    if (value === null || value === undefined) return [];
    const raw = Array.isArray(value) ? value : String(value).split(',');
    return raw
        .map((item) => Number(String(item).trim()))
        .filter((id) => Number.isInteger(id) && id > 0);
}

/**
 * 组装配置：四个来源按优先级合并。
 * 除 url/key 外还带出 docchain_topic_ids（配置页选中主题）与视觉模型配置。
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
        vision: {
            url: String(config.docchain_vision_url || DEFAULT_VISION_URL).replace(/\/+$/, ''),
            model: String(config.docchain_vision_model || DEFAULT_VISION_MODEL),
            fallbackModel: String(config.docchain_vision_fallback_model || DEFAULT_VISION_FALLBACK),
            maxDescChars: Number(config.docchain_vision_max_desc_chars) || undefined,
            // 凭据库不从这里读：CLI 走环境变量，工具路径由宿主解析后传入。
            key: process.env.VISION_API_KEY || String(config.vision_api_key || ''),
        },
    };
}

/** 服务地址去掉尾部的 `/v1`，用于拼接不同前缀的接口。 */
function apiRoot(url) {
    return String(url || '').replace(/\/v1$/, '');
}

/** 极简 HTTP 请求；与其它 skill 脚本同一套行为（4xx/5xx 抛错并带 status）。 */
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
                timeout: opts.timeout || READ_TIMEOUT,
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

/** sha256 前 16 位：够短、够用来判断"内容变没变"。 */
function sha16(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 16);
}

/** 换行归一化：CRLF 文档写回后可能被服务端规范化，比较前统一，避免误报不一致。 */
function normalizeEol(text) {
    return String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/** 把错误文本压成一行。 */
function oneLine(text, limit) {
    return String(text || '').replace(/\s+/g, ' ').trim().slice(0, limit || 200);
}

/** 反转义 HTML 实体：md 里的图片地址可能被写成 `&amp;`，不解码会拼出坏 URL。 */
function decodeEntities(text) {
    return String(text || '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");
}

/**
 * 给 URL 里的 path 取值做编码：已经是 `%XX` 的段不二次编码，
 * 含空格/中文的段用 encodeURIComponent。
 */
function encodePathValue(value) {
    const raw = String(value || '');
    if (!raw) return '';
    // 纯 ASCII 且不含空格/引号/尖括号 → 现状就是合法的，原样返回（避免二次编码）。
    if (/^[\x21-\x7E]+$/.test(raw) && !/["'<>\s]/.test(raw)) return raw;
    return raw
        .split('/')
        .map((segment) => (/%[0-9A-Fa-f]{2}/.test(segment) ? segment : encodeURIComponent(segment)))
        .join('/');
}

/** 判断字节是不是图片，顺便给出 MIME；返回 false 表示"不是图片"。 */
function isImageBytes(buffer) {
    if (!buffer || buffer.length < 12) return false;
    if (buffer[0] === 0xff && buffer[1] === 0xd8) return 'image/jpeg';
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png';
    if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) return 'image/gif';
    if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
    return false;
}

/**
 * 找最后一个"真正的句末"，从 `floor` 到 `to` 之间倒数查找。
 *
 * 不能简单找最后一个 `.`：中文串里常夹英文，`Ernie 3.5`、`e.g.`、
 * `1.2 节` 里的点都不是句末。实测就出现过把 `Ernie 3.` 当成句末、
 * 在 1047 字符处提前砍断的情况。所以 ASCII 标点只在"后面是空格或结尾、
 * 且不是夹在数字之间"时才算句末。
 */
function lastSentenceEnd(text, floor, to) {
    for (let i = to - 1; i >= floor; i -= 1) {
        const ch = text[i];
        if ('。！？；'.includes(ch)) return i;
        if ('.!?;'.includes(ch)) {
            const prev = text[i - 1] || '';
            const next = text[i + 1];
            if (/\d/.test(prev) && next !== undefined && /\d/.test(next)) continue; // 3.5
            if (next === undefined || next === ' ') return i;
        }
    }
    return -1;
}

/**
 * 清洗模型输出：压单行 → 句末截断 → 转义注释符号。
 *
 * 最后一步不能省：描述里只要出现 `-->`，这一行注释就被提前闭合，
 * 后面的图片行会被吞进注释里，md 结构直接损坏。
 */
function sanitizeDesc(text, maxChars) {
    const limit = Number.isInteger(maxChars) && maxChars > 0 ? maxChars : DESC_MAX_CHARS;
    let value = String(text || '').replace(/\s+/g, ' ').trim();
    if (!value) return '';
    if (value.length > limit) {
        const head = value.slice(0, limit);
        const cut = lastSentenceEnd(head, Math.floor(limit * 0.5), head.length);
        value = (cut >= 0 ? head.slice(0, cut + 1) : head) + '…';
    }
    return value.replace(/-->/g, '--&gt;').replace(/<!--/g, '&lt;!--');
}

/**
 * 压缩提示词：把超长描述压到上限内。
 *
 * 为什么不直接截断：截断会丢掉列表后半段、编号最后几项（实测有被砍在
 * "7.…"、"Ernie 3.…"、"只剩半个 Q:" 的），而这些恰恰是密集图表里最不该丢的。
 * 让模型自己挑重点，成本约等于一次短问答，且只发生在超长的少数图片上。
 */
function buildCompressPrompt(text, limit, ratio) {
    // 目标低于上限：模型对"精确字数"控制不准，实测让它压到 1200 会输出 1250+。
    // 第一轮留 15% 余量；仍超的话第二轮压到 60%（更狠，只保关键事实）。
    const factor = typeof ratio === 'number' && ratio > 0 && ratio < 1 ? ratio : 0.85;
    const target = Math.max(60, Math.floor(limit * factor));
    const tone = factor >= 0.8 ? '保留全部关键信息' : '只保留最关键的结构、名称与数值，其余全部舍弃';
    return (
        `下面是一段图片描述，共 ${text.length} 字符，超过 ${limit} 字符的上限。` +
        `请把它压缩到 ${target} 字符以内（务必少于 ${limit} 字符），要求：\n` +
        `1. ${tone}：专有名词、字段名、单位、数值、公式要原样保留；\n` +
        '2. 删掉修饰语、重复表述、连接句与举例性细节；\n' +
        '3. 不要新增原文没有的信息，也不要加"综上所述/总之"这类收尾；\n' +
        '4. 直接输出压缩后的描述正文，不要解释你做了什么。\n\n' +
        `原文：\n${text}`
    );
}

/** 一张图的稳定标识：优先用 `path=` 参数（同一路径=同一张图），否则退回原地址。 */
function refKey(rawUrl) {
    const match = /[?&]path=([^&]+)/.exec(String(rawUrl || ''));
    if (!match) return String(rawUrl || '');
    try {
        return decodeURIComponent(match[1]);
    } catch {
        return match[1];
    }
}

/**
 * 把图片引用解析成绝对地址。
 *
 * md 里的写法是 `/llmdoc/v1/doc/read?doc_id=…&read_format=path&path=media/x.jpg`，
 * 路径里已经带了 base route（生产环境是 `/docchain`），所以只拼 origin，
 * 不能拼整个配置地址 —— 否则会变成 `/llmdoc/llmdoc/...` 直接 404。
 */
function resolveImageUrl(raw, config) {
    const value = String(raw || '').trim();
    if (!value) return '';
    if (/^https?:\/\//i.test(value)) return value;
    // 有 scheme 但不是 http(s)（data: / javascript: / ftp: …）→ 不处理，交给上层计入 unparsed。
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) return '';
    if (value.startsWith('/')) return new URL(config.url).origin + value;
    // 相对路径：挂在服务根下（无法更精确，标记为相对来源便于排查）。
    return `${apiRoot(config.url).replace(/\/+$/, '')}/${value.replace(/^\.?\//, '')}`;
}

/** 从一段 md 里取图片地址（兼容 `![](...)`、`![](<...>)`、`<img src>`）。 */
function collectRawRefs(text) {
    const source = String(text || '');
    const out = [];
    // `![](...)` 用括号配平扫描，而不是正则：地址里可能带括号（例如 data: 里的 (…)），
    // 正则会在第一个 `)` 处截断，拼出坏 URL。
    let cursor = 0;
    for (;;) {
        const open = source.indexOf('![', cursor);
        if (open < 0) break;
        const closeBracket = source.indexOf(']', open + 2);
        if (closeBracket < 0) break;
        if (source[closeBracket + 1] !== '(') {
            cursor = closeBracket + 1;
            continue;
        }
        let depth = 1;
        let index = closeBracket + 2;
        let buffer = '';
        while (index < source.length && depth > 0) {
            const ch = source[index];
            if (ch === '(') {
                depth += 1;
                buffer += ch;
            } else if (ch === ')') {
                depth -= 1;
                if (depth > 0) buffer += ch;
            } else {
                buffer += ch;
            }
            index += 1;
        }
        if (depth === 0) out.push(buffer);
        cursor = index;
    }
    const imgRe = /<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)')/gi;
    let match;
    while ((match = imgRe.exec(source))) out.push(match[1] || match[2] || '');
    return out;
}

/** 去掉 markdown 图片地址两端的尖括号与可选标题，再反转义实体。 */
function normalizeRawRef(raw) {
    let value = String(raw || '').trim();
    if (value.startsWith('<') && value.endsWith('>')) value = value.slice(1, -1).trim();
    const quote = value.search(/\s+["']/);
    if (quote > 0) value = value.slice(0, quote);
    return decodeEntities(value);
}

/**
 * 解析整篇 md 的图片引用。
 * @returns {{refs: Array<{raw: string, url: string, key: string}>, unparsed: string[]}}
 */
function parseImageRefs(md, config) {
    const refs = [];
    const unparsed = [];
    for (const rawRef of collectRawRefs(md)) {
        const raw = normalizeRawRef(rawRef);
        // 空地址（`![]()`）不是图片引用，直接忽略，不计入 unparsed。
        if (!raw) continue;
        const url = resolveImageUrl(raw, config);
        if (!url) {
            unparsed.push(raw);
            continue;
        }
        refs.push({ raw, url, key: refKey(url) });
    }
    return { refs, unparsed };
}

/** 统计主 md 里已经有多少条 image-desc 注释（用于提示"别叠加"）。 */
function countExistingDesc(md) {
    const matches = String(md || '').match(new RegExp(DESC_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'));
    return matches ? matches.length : 0;
}

/**
 * 在每张图片那一行的正上方插入描述注释。
 *
 * 逐行处理而不是按字符偏移插入：这样原文件的换行风格（CRLF/LF）、
 * 空行、已有的 `<!-- page_num=N -->` 标记全部原样保留，写回的字节只多了注释行。
 *
 * @param {string} md 原始 md
 * @param {Map<string, string>} descByKey refKey → 描述
 * @returns {{content: string, injected: number}}
 */
function injectDescriptions(md, descByKey) {
    const lines = String(md).split('\n');
    const out = [];
    let injected = 0;
    for (const line of lines) {
        const eol = line.endsWith('\r') ? '\r' : '';
        const keys = [];
        for (const rawRef of collectRawRefs(line)) {
            const raw = normalizeRawRef(rawRef);
            if (!raw) continue;
            const key = refKey(raw);
            if (descByKey.has(key) && !keys.includes(key)) keys.push(key);
        }
        for (const key of keys) {
            out.push(`${DESC_PREFIX}${descByKey.get(key)}${DESC_SUFFIX}${eol}`);
            injected += 1;
        }
        out.push(line);
    }
    return { content: out.join('\n'), injected };
}

/** 并发受限地跑一批任务；结果按输入顺序返回。 */
async function mapLimit(items, limit, worker) {
    const results = new Array(items.length);
    let cursor = 0;
    const runners = new Array(Math.min(Math.max(1, limit), items.length || 1)).fill(0).map(async () => {
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

/** 当前文档名（base_name + 扩展名）。 */
function docName(detail) {
    if (detail.base_name) {
        return detail.file_extension ? `${detail.base_name}${detail.file_extension}` : detail.base_name;
    }
    return detail.path || `文档 ${detail.id}`;
}

/* ------------------------------------------------------------------ *
 * 服务端调用
 * ------------------------------------------------------------------ */

async function fetchDetail(root, config, docId) {
    const res = await request(`${root}/v1/doc/filedetail?doc_id=${docId}`, {
        headers: { 'X-Api-Key': config.key },
        timeout: DETAIL_TIMEOUT,
    });
    try {
        const data = JSON.parse(res.text);
        return data && typeof data === 'object' ? data : null;
    } catch {
        return null;
    }
}

async function fetchMainMd(root, config, docId) {
    const res = await request(`${root}/v1/doc/read?doc_id=${docId}&read_format=md`, {
        headers: { 'X-Api-Key': config.key },
        timeout: READ_TIMEOUT,
    });
    return res.text;
}

/** 解析主题名；失败返回空串（不影响主流程）。 */
async function fetchTopicName(root, config, topicId) {
    if (!topicId) return '';
    try {
        const res = await request(`${root}/v1/topic/info?topic_id=${topicId}`, {
            headers: { 'X-Api-Key': config.key },
            timeout: DETAIL_TIMEOUT,
        });
        const data = JSON.parse(res.text);
        const info = data && data.data ? data.data : data;
        return (info && info.name) || '';
    } catch {
        return '';
    }
}

/** 按文件名关键字搜文档（与 docchain-doc-search 同一条接口与口径）。 */
async function searchDocsByKeyword(root, config, keyword, topicIds, size) {
    const url = `${root}/v1/doc/list?page=1&size=${KEYWORD_SCAN_SIZE}&keyword=${encodeURIComponent(keyword)}`;
    const res = await request(url, { headers: { 'X-Api-Key': config.key }, timeout: LIST_TIMEOUT });
    let rows;
    try {
        rows = JSON.parse(res.text);
    } catch {
        throw new DocchainError('SERVER_ERROR', '文档列表接口返回的不是 JSON');
    }
    if (!Array.isArray(rows)) rows = [];
    if (topicIds && topicIds.length) {
        const allow = new Set(topicIds);
        rows = rows.filter((row) => allow.has(Number(row.topic_id)));
    }
    const capped = rows.slice(0, Math.min(size, KEYWORD_RESULT_CAP));
    const documents = [];
    const nameCache = new Map();
    for (const row of capped) {
        const tid = Number(row.topic_id) || 0;
        if (!nameCache.has(tid)) nameCache.set(tid, await fetchTopicName(root, config, tid));
        documents.push({
            doc_id: row.id,
            name: row.path || '',
            topic_id: tid,
            topic_name: nameCache.get(tid),
        });
    }
    return { matched: rows.length, documents };
}

/**
 * 取一张图的字节。
 *
 * 只有目标地址与配置的服务地址同源时才带 X-Api-Key —— 文档里可能引用外部图片，
 * 把内部 key 发到外部主机是不可接受的。
 */
async function fetchImageBytes(url, config) {
    const target = new URL(url);
    const service = new URL(config.url);
    const sameOrigin = target.hostname === service.hostname && (target.port || '') === (service.port || '');
    const headers = sameOrigin ? { 'X-Api-Key': config.key } : {};
    const res = await request(url, { headers, binary: true, timeout: DOWNLOAD_TIMEOUT });
    return res.buffer;
}

/** 保存旁路描述 md。 */
async function saveDescMarkdown(root, config, docId, content) {
    const body = JSON.stringify({ doc_id: docId, content, is_image_description: true });
    const res = await request(`${root}/v1/doc/save_markdown`, {
        method: 'POST',
        headers: { 'X-Api-Key': config.key, 'Content-Type': 'application/json' },
        body,
        timeout: SAVE_TIMEOUT,
    });
    let data;
    try {
        data = JSON.parse(res.text);
    } catch {
        throw new DocchainError('SAVE_FAILED', `保存接口返回的不是 JSON：${oneLine(res.text)}`);
    }
    if (!data || data.success !== true) {
        throw new DocchainError('SAVE_FAILED', `保存接口未返回 success:true：${oneLine(res.text)}`);
    }
    return data;
}

/** 把原主 md 写回去（自愈路径：不带 flag 正好走"覆盖主 md"那条分支）。 */
async function restoreMainMd(root, config, docId, mainMd) {
    const body = JSON.stringify({ doc_id: docId, content: mainMd, is_image_description: false });
    await request(`${root}/v1/doc/save_markdown`, {
        method: 'POST',
        headers: { 'X-Api-Key': config.key, 'Content-Type': 'application/json' },
        body,
        timeout: SAVE_TIMEOUT,
    });
}

/**
 * 读描述 md。
 * 未生成时服务端返回 **200 + 一句英文**（不是 404），所以两重判据都要认：
 * 状态码 404，或者"长度正好 44 且内容逐字相等"。
 */
async function readDescMarkdown(root, config, docId) {
    let res;
    try {
        res = await request(`${root}/v1/doc/read?doc_id=${docId}&read_format=image_description_md`, {
            headers: { 'X-Api-Key': config.key },
            timeout: READ_TIMEOUT,
        });
    } catch (error) {
        if (error.status === 404) return { generated: false, text: '', bytes: 0 };
        throw new DocchainError('SERVER_ERROR', `读取描述 md 失败：${oneLine(error.message)}`);
    }
    const bytes = Buffer.byteLength(res.text);
    if (bytes === SENTINEL_BYTES && res.text.trim() === SENTINEL) {
        return { generated: false, text: '', bytes };
    }
    return { generated: true, text: res.text, bytes };
}

/* ------------------------------------------------------------------ *
 * 视觉模型配置
 * ------------------------------------------------------------------ */

/** 合并视觉模型配置：调用参数 > 配置对象 > 环境变量 > 默认值。 */
function resolveVisionConfig(base, params) {
    const source = base || {};
    const url = String(params.visionUrl || source.url || process.env.VISION_BASE_URL || DEFAULT_VISION_URL).replace(
        /\/+$/,
        '',
    );
    const key = params.visionKey || source.key || process.env.VISION_API_KEY || '';
    const model = params.model || source.model || process.env.VISION_MODEL || DEFAULT_VISION_MODEL;
    const fallbackModel =
        source.fallbackModel || process.env.VISION_FALLBACK_MODEL || DEFAULT_VISION_FALLBACK;
    // 描述长度上限：参数 > 配置 > 环境变量 > 常量默认值。改它只是换"保险丝"，
    // 想真正写得更长要同时放宽提示词（buildPrompt 已经不放句数限制）。
    const configuredLimit = Number(params.maxDescChars || source.maxDescChars || process.env.VISION_MAX_DESC_CHARS);
    const maxDescChars = Number.isInteger(configuredLimit) && configuredLimit > 0 ? configuredLimit : DESC_MAX_CHARS;
    return { url, key, model, fallbackModel, maxDescChars };
}

/**
 * 组装提示词。
 *
 * 三轮实测下来的取舍：
 *   1. 写"1-3 句"→ 架构图/密集表格丢关键信息（描述的价值就在这些图上）；
 *   2. 改成"完整还原"→ 模型开始转录装饰性样式，平均 863 字符，样式词每千字 14.7 次；
 *   3. 于是改成"信息密度"导向：不设句数，但每条分句都必须携带图上独有信息，
 *      样式只在承载语义时以最短形式出现（"红框标出"而不是"被一个红色矩形框标注"）。
 *
 * 关键点：精确 ≠ 简短。专有名词、数值、单位、公式要原样照抄；要删的是重复与装饰。
 */
function buildPrompt(docNameText, index, total) {
    return (
        `这是文档《${docNameText}》中的一张图片（第 ${index}/${total} 张）。` +
        '请用中文精确描述这张图，直接给描述，不要以"这张图片/该图"开头，不要客套。\n' +
        '按图种覆盖要点：\n' +
        '- 图表：标题、横纵轴含义与单位、图例、趋势与拐点、关键数值或公式；\n' +
        '- 表格：列名与分类，逐行概括要点与关键数值；\n' +
        '- 流程图/架构图：模块名称、层级关系、数据流向与关键参数；\n' +
        '- 界面截图/照片：主体、场景、界面上的关键文字。\n' +
        '\n' +
        '写作规则（按重要性排序）：\n' +
        '1. 精确优先：模块名、字段名、坐标轴名、单位、数值、公式一律照抄原文，不概括、不改写、不换算。\n' +
        '2. 每句话都要携带图上独有、且读者需要的信息。写完自检一遍：删掉后不损失理解的句子，全部删掉。\n' +
        '3. 同一个事实只说一次；不要用"可以看到/从左到右依次是/如图所示"这类连接句凑字数。\n' +
        '4. 样式（颜色、字体、线条、圆角、填充、阴影）只在承载语义时写，且用最短形式：\n' +
        '   写"红框标出雪坡上的滑雪者"；不要写"滑雪者被一个红色矩形框标注，框线为红色实线"。\n' +
        '5. 长度服务于信息量：简单图 1–2 句即可；复杂图表/架构图按需展开，但每一句都要有新信息。\n' +
        '6. 看不清的文字或数字不要编造，直接省略。'
    );
}

/* ------------------------------------------------------------------ *
 * 各模式
 * ------------------------------------------------------------------ */

async function doListModels(visionConfig) {
    const models = await vision.listVisionModels({
        baseUrl: visionConfig.url,
        apiKey: visionConfig.key,
    });
    return {
        ok: true,
        mode: 'models',
        base_url: visionConfig.url,
        default_model: visionConfig.model,
        fallback_model: visionConfig.fallbackModel,
        total: models.length,
        models,
    };
}

async function doCandidates(root, config, keyword, params) {
    const topicIds = Array.isArray(params.topicIds) && params.topicIds.length ? params.topicIds : config.topicIds || [];
    const size = params.size || KEYWORD_RESULT_CAP;
    const found = await searchDocsByKeyword(root, config, keyword, topicIds, size);
    if (found.documents.length === 0) {
        throw new DocchainError(
            'NO_RESULTS',
            `未找到名称包含「${keyword}」的文档${topicIds.length ? `（范围：主题 ${topicIds.join(', ')}）` : ''}。`,
        );
    }
    return {
        ok: true,
        mode: 'candidates',
        keyword,
        topic_ids: topicIds,
        total: found.documents.length,
        matched: found.matched,
        candidates: found.documents,
        note: '候选只是清单，尚未处理。请让用户选定后再带 doc_ids 调用一次。',
    };
}

async function doPreview(root, config, docIds, params) {
    const documents = [];
    for (const docId of docIds) {
        const detail = await fetchDetail(root, config, docId);
        if (!detail) {
            documents.push({ doc_id: docId, found: false });
            continue;
        }
        let images = null;
        if (docIds.length <= 10) {
            try {
                const md = await fetchMainMd(root, config, docId);
                const parsed = parseImageRefs(md, config);
                images = new Set(parsed.refs.map((ref) => ref.key)).size;
            } catch {
                images = null;
            }
        }
        documents.push({
            doc_id: docId,
            found: true,
            name: docName(detail),
            topic_id: Number(detail.topic_id) || 0,
            images,
        });
    }
    void params;
    return {
        ok: true,
        mode: 'preview',
        total: documents.length,
        documents,
        note: '这是将处理的文档清单，尚未执行。确认无误后带 confirm:true（CLI 用 --confirm）重跑。',
    };
}

async function doRead(root, config, docIds) {
    const documents = [];
    for (const docId of docIds) {
        const detail = await fetchDetail(root, config, docId);
        if (!detail) {
            documents.push({ doc_id: docId, found: false, generated: false });
            continue;
        }
        const desc = await readDescMarkdown(root, config, docId);
        documents.push({
            doc_id: docId,
            found: true,
            name: docName(detail),
            topic_id: Number(detail.topic_id) || 0,
            generated: desc.generated,
            bytes: desc.bytes,
            lines: desc.generated ? desc.text.split('\n').length : 0,
            preview: desc.generated ? desc.text.slice(0, 400) : '',
        });
    }
    const generated = documents.filter((doc) => doc.generated);
    if (generated.length === 0) {
        throw new DocchainError(
            'NOT_GENERATED',
            `这些文档还没有生成过图片描述 md（read_format=image_description_md）：${docIds.join(', ')}`,
            { documents },
        );
    }
    return {
        ok: true,
        mode: 'read',
        total: documents.length,
        generated: generated.length,
        documents,
        note: '描述 md 的内容由上一次生成，无法追溯是用哪个模型产生的。',
    };
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

/** 描述一张图（含失败归类）。`position` 是这篇文档里的第几张（1 起）。 */
async function describeOneImage(ref, visionConfig, ctx, position) {
    let bytes;
    try {
        bytes = await fetchImageBytes(ref.url, ctx.config);
    } catch (error) {
        const status = error.status || 0;
        return { ok: false, error: status === 401 || status === 403 ? 'NO_PERMISSION' : 'DOWNLOAD_FAILED', message: oneLine(error.message) };
    }
    if (bytes.length === 0) return { ok: false, error: 'DOWNLOAD_FAILED', message: '图片字节为空' };
    if (bytes.length > MAX_IMAGE_BYTES) {
        return {
            ok: false,
            error: 'IMAGE_TOO_LARGE',
            message: `${Math.round(bytes.length / 1024 / 1024)}MB，上限 ${MAX_IMAGE_BYTES / 1024 / 1024}MB`,
        };
    }
    const mime = isImageBytes(bytes);
    if (!mime) return { ok: false, error: 'NOT_IMAGE', message: '返回的内容不是图片（可能是错误页）' };

    try {
        const out = await vision.describeImage({
            baseUrl: visionConfig.url,
            apiKey: visionConfig.key,
            model: visionConfig.model,
            image: bytes,
            mime,
            prompt: buildPrompt(ctx.docName, position, ctx.total),
            maxTokens: DESC_MAX_TOKENS,
            state: ctx.state,
        });
        const limit = ctx.maxDescChars || DESC_MAX_CHARS;
        const raw = String(out.text || '').replace(/\s+/g, ' ').trim();
        if (!raw) return { ok: false, error: 'EMPTY_DESC', message: '模型返回空描述' };
        if (out.rateLimited) ctx.rateLimited += out.rateLimited;
        // 撞上 max_tokens 是"看不见的截断"：长度可能没超上限，内容却停在半句。
        // 只靠长度判断发现不了，必须看 finish_reason。
        if (out.finishReason === 'length') ctx.incomplete += 1;

        // 超长时先让模型压缩，而不是直接砍 —— 砍掉的多半是列表后半段/编号末尾。
        // 模型对字数控制不准（实测让它压到 1200 会吐 1250+），所以最多两轮：
        // 第一轮留 15% 余量，仍超就第二轮压到 60%。
        if (raw.length > limit && ctx.compress !== false) {
            let candidate = raw;
            let rounds = 0;
            while (candidate.length > limit && rounds < 2) {
                try {
                    const squeezed = await vision.completeText({
                        baseUrl: visionConfig.url,
                        apiKey: visionConfig.key,
                        model: visionConfig.model,
                        prompt: buildCompressPrompt(candidate, limit, rounds === 0 ? 0.85 : 0.6),
                        maxTokens: DESC_MAX_TOKENS,
                        state: ctx.state,
                    });
                    const next = String(squeezed.text || '').replace(/\s+/g, ' ').trim();
                    // 没变短就说明模型没照做，别再浪费调用。
                    if (!next || next.length >= candidate.length) break;
                    candidate = next;
                    rounds += 1;
                } catch {
                    // 压缩失败（限流/超时/模型抽风）就退回截断，不能让单张拖垮整篇。
                    break;
                }
            }
            if (rounds > 0) {
                ctx.compressed += 1;
                const truncated = candidate.length > limit;
                if (truncated) ctx.truncated += 1;
                const text = sanitizeDesc(candidate, limit);
                if (text) return { ok: true, text, ms: out.ms, compressed: true, truncated };
            }
        }

        const text = sanitizeDesc(raw, limit);
        if (!text) return { ok: false, error: 'EMPTY_DESC', message: '模型返回空描述' };
        const truncated = raw.length > limit;
        if (truncated) ctx.truncated += 1;
        return { ok: true, text, ms: out.ms, truncated };
    } catch (error) {
        if (error.code === 'RATE_LIMITED') ctx.rateLimited += 1;
        return { ok: false, error: error.code || 'MODEL_ERROR', message: oneLine(error.message) };
    }
}

/** 处理单篇文档：校验 → 描述 → 拼装 → 保存 → 校验（含自愈）。 */
async function describeDocument(root, config, visionConfig, docId, params, say) {
    const startedAt = Date.now();
    const detail = await fetchDetail(root, config, docId);
    if (!detail) throw new DocchainError('NOT_FOUND', `文档 ${docId} 不存在或无权访问（先 filedetail 校验）`);

    const name = docName(detail);
    const topicId = Number(detail.topic_id) || 0;
    const topicNameText = await fetchTopicName(root, config, topicId);

    const original = await fetchMainMd(root, config, docId);
    if (!String(original).trim()) throw new DocchainError('NO_CONTENT', `文档《${name}》的主 md 为空`);
    const beforeHash = sha16(original);

    const parsed = parseImageRefs(original, config);
    if (parsed.refs.length === 0) {
        throw new DocchainError('NO_IMAGES', `文档《${name}》的 md 里没有可识别的图片引用`);
    }

    const warnings = [];
    const existing = countExistingDesc(original);
    if (existing > 0) {
        warnings.push(`SOURCE_HAS_DESC：主 md 里已有 ${existing} 条 image-desc 注释，本次会在其上再插入一层`);
    }
    if (parsed.unparsed.length > 0) {
        warnings.push(`有 ${parsed.unparsed.length} 处图片地址无法解析，已跳过`);
    }

    // 同一张图只描述一次，但每一处出现都插入。
    const uniqueRefs = [];
    const seenKeys = new Set();
    for (const ref of parsed.refs) {
        if (seenKeys.has(ref.key)) continue;
        seenKeys.add(ref.key);
        uniqueRefs.push(ref);
    }
    const maxImages = Math.min(Math.max(0, params.maxImages || 0), MAX_IMAGES_CAP);
    const picked = maxImages > 0 ? uniqueRefs.slice(0, maxImages) : uniqueRefs;
    const partial = picked.length < uniqueRefs.length;
    if (uniqueRefs.length > 400) {
        warnings.push(
            `LARGE_PAYLOAD：${uniqueRefs.length} 张图，描述 md 预计超过 2 MB；若保存失败请确认接口的请求体上限`,
        );
    }

    const concurrency = Math.min(MAX_CONCURRENCY, Math.max(1, params.concurrency || DEFAULT_CONCURRENCY));
    // 共享状态：同一个对象贯穿所有并发调用，计数（rate_limited / truncated）才能累加。
    // 早先每个调用点都 spread 一份，导致计数只加在副本上，永远报 0。
    const ctx = {
        config,
        docName: name,
        total: picked.length,
        rateLimited: 0,
        truncated: 0,
        compressed: 0,
        incomplete: 0,
        maxDescChars: visionConfig.maxDescChars,
        state: {},
    };
    const descByKey = new Map();
    const failed = [];
    let model = visionConfig.model;
    let fallbackUsed = false;

    // 预检：先跑第一张。模型没权限/图片取不到时立刻失败，不必等 185 张跑完。
    const first = picked[0];
    let firstResult = await describeOneImage(first, visionConfig, ctx, 1);
    if (!firstResult.ok && firstResult.error === 'MODEL_UNAVAILABLE' && visionConfig.fallbackModel && params.allowFallback !== false) {
        const fallbackConfig = Object.assign({}, visionConfig, { model: visionConfig.fallbackModel });
        const retry = await describeOneImage(first, fallbackConfig, ctx, 1);
        if (retry.ok) {
            model = visionConfig.fallbackModel;
            fallbackUsed = true;
            firstResult = retry;
        } else {
            throw new DocchainError(
                'MODEL_UNAVAILABLE',
                `主模型 ${visionConfig.model} 与降级模型 ${visionConfig.fallbackModel} 都不可用：${retry.message}。可用 list_models 查看可用视觉模型。`,
            );
        }
    }
    if (firstResult.ok) {
        descByKey.set(first.key, firstResult.text);
    } else if (firstResult.error === 'MODEL_UNAVAILABLE') {
        throw new DocchainError(
            'MODEL_UNAVAILABLE',
            `主模型 ${visionConfig.model} 不可用：${firstResult.message}。可用 list_models 查看可用视觉模型。`,
        );
    } else {
        failed.push({ path: first.key, error: firstResult.error, message: firstResult.message });
    }

    const rest = picked.slice(1);
    if (rest.length > 0) {
        const activeConfig = Object.assign({}, visionConfig, { model });
        let cursor = 0;
        await mapLimit(rest, concurrency, async () => {
            const index = cursor;
            cursor += 1;
            const ref = rest[index];
            say(`… ${index + 2}/${picked.length}`);
            const result = await describeOneImage(ref, activeConfig, ctx, index + 2);
            if (result.ok) descByKey.set(ref.key, result.text);
            else failed.push({ path: ref.key, error: result.error, message: result.message });
            return result;
        });
    }

    if (descByKey.size === 0) {
        throw new DocchainError('ALL_FAILED', `所有图片都没有生成描述（共 ${picked.length} 张），未保存。`);
    }

    const injected = injectDescriptions(original, descByKey);
    const nextMd = injected.content;
    const result = {
        doc_id: docId,
        name,
        topic_id: topicId,
        topic_name: topicNameText,
        model,
        fallback_used: fallbackUsed,
        refs: parsed.refs.length,
        unique: uniqueRefs.length,
        picked: picked.length,
        described: descByKey.size,
        injected: injected.injected,
        partial,
        unparsed: parsed.unparsed.length,
        rate_limited: ctx.rateLimited,
        // 超长时先让模型压缩（compressed），压不下来才硬截断（truncated）；两个数都不静默。
        compressed: ctx.compressed,
        truncated: ctx.truncated,
        incomplete: ctx.incomplete,
        max_desc_chars: ctx.maxDescChars || DESC_MAX_CHARS,
        failed,
        warnings,
        bytes_before: Buffer.byteLength(original),
        bytes_after: Buffer.byteLength(nextMd),
        elapsed_ms: 0,
    };

    if (params.dryRun) {
        result.saved = { ok: false, error: 'DRY_RUN' };
        result.preview_head = nextMd.slice(0, 600);
        result.elapsed_ms = Date.now() - startedAt;
        return result;
    }

    // 写前复核：几分钟的模型调用期间，别人可能编辑过主 md。
    const current = await fetchMainMd(root, config, docId);
    if (sha16(current) !== beforeHash) {
        throw new DocchainError('SOURCE_CHANGED', `处理期间主 md 被修改（${docId}），已中止，未保存。请重跑。`);
    }

    const saved = await saveDescMarkdown(root, config, docId, nextMd);

    // 写后校验：主 md 必须没变。变了说明接口走了"覆盖主 md"那条分支。
    const after = await fetchMainMd(root, config, docId);
    if (sha16(after) !== beforeHash) {
        let restored = false;
        try {
            await restoreMainMd(root, config, docId, original);
            restored = sha16(await fetchMainMd(root, config, docId)) === beforeHash;
        } catch {
            restored = false;
        }
        if (restored) {
            throw new DocchainError(
                'SAVE_WRONG_TARGET',
                'save_markdown 没有走描述分支，主 md 被覆盖；已用原内容写回并校验通过。请检查服务端 is_image_description 的处理。',
            );
        }
        throw new DocchainError(
            'RESTORE_FAILED',
            `主 md 被覆盖且写回失败（原 sha=${beforeHash}, ${Buffer.byteLength(original)} 字节）。` +
                '请用 /v1/doc/redo_markdown 重新解析，或从版本历史恢复。',
        );
    }

    const back = await readDescMarkdown(root, config, docId);
    if (!back.generated) {
        throw new DocchainError('SAVE_UNVERIFIED', '保存返回成功，但读不到描述 md（可能被服务端丢弃）。');
    }
    if (normalizeEol(back.text) !== normalizeEol(nextMd)) {
        throw new DocchainError(
            'SAVE_UNVERIFIED',
            `写 ${Buffer.byteLength(nextMd)} 字节，读回 ${back.bytes} 字节，内容不一致。`,
        );
    }

    result.saved = { ok: true, response: saved, bytes: back.bytes, verified: true };
    result.elapsed_ms = Date.now() - startedAt;
    return result;
}

/**
 * 主入口：CLI 与宿主工具共用这一条路径。
 *
 * @param {object} config - { url, key, topicIds, vision }
 * @param {object} params - { docIds, keyword, topicIds, maxImages, concurrency, dryRun,
 *                            model, listModels, read, confirm, visionKey, visionUrl, quiet }
 * @returns {Promise<object>} 结构化 payload
 */
async function runDescribeImages(config, params = {}) {
    const root = apiRoot(config.url);
    const quiet = params.quiet !== false;
    const say = (line) => {
        if (!quiet) console.error(line);
    };
    const visionConfig = resolveVisionConfig(config.vision, params);

    if (params.listModels) return doListModels(visionConfig);

    const docIds = toIdList(params.docIds);
    const keyword = String(params.keyword || '').trim();

    if (docIds.length === 0 && !keyword) {
        throw new DocchainError(
            'CONFIG',
            '需要 doc_ids（一个或多个文档 ID）、keyword（按文档名搜索后由用户选择），或 listModels=true 查看可用视觉模型。',
        );
    }
    if (docIds.length === 0) return doCandidates(root, config, keyword, params);
    if (params.read) return doRead(root, config, docIds);
    if (docIds.length > 1 && !params.confirm) return doPreview(root, config, docIds, params);

    const documents = [];
    for (const docId of docIds) {
        say(`处理文档 ${docId}…`);
        try {
            documents.push(await describeDocument(root, config, visionConfig, docId, params, say));
        } catch (error) {
            if (docIds.length === 1) throw error;
            documents.push({
                doc_id: docId,
                ok: false,
                error: error.code || 'SERVER_ERROR',
                message: oneLine(error.message),
            });
        }
    }
    const okCount = documents.filter((doc) => doc.saved && doc.saved.ok === true).length;
    const payload = {
        ok: docIds.length === 1 ? true : okCount > 0,
        mode: 'describe',
        total: documents.length,
        saved: okCount,
        documents,
    };
    if (params.dryRun) payload.note = 'dry_run：只生成，未调用保存接口。';
    return payload;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const config = getConfig();
    try {
        const payload = await runDescribeImages(config, {
            docIds: args.doc_ids,
            keyword: args.keyword,
            topicIds: toIdList(args.topic_ids),
            maxImages: args['max-images'],
            concurrency: args.concurrency,
            model: args.model,
            dryRun: args['dry-run'],
            listModels: args['list-models'],
            read: args.read,
            confirm: args.confirm,
            quiet: false,
        });
        console.log(JSON.stringify(payload));
    } catch (error) {
        fail(error.code || 'SERVER_ERROR', error.message, error.documents ? { documents: error.documents } : undefined);
    }
}

if (require.main === module) {
    main().catch((error) => {
        fail('SERVER_ERROR', error && error.message ? error.message : String(error));
    });
}

// The host half calls these directly (in-process tool execution).
module.exports = {
    runDescribeImages,
    getConfig,
    DocchainError,
    // 纯函数导出，便于单测与复用
    parseImageRefs,
    injectDescriptions,
    sanitizeDesc,
    isImageBytes,
    encodePathValue,
    decodeEntities,
    refKey,
    countExistingDesc,
    normalizeEol,
    resolveImageUrl,
    DESC_MAX_CHARS,
    SENTINEL,
    DEFAULT_CONCURRENCY,
    MAX_CONCURRENCY,
};
