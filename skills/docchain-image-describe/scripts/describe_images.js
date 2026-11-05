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

/**
 * 结构图（A 类图片）开关：`on` 时让模型二选一输出「节点/边」数据，由本文件的
 * 模板函数渲染成 PlantUML；`off` 时回到纯描述提示词。
 *
 * 为什么不是模型直接写 PlantUML：实测它会把别名用到声明之前（`T1 -[hidden]-> T2`
 * 之后才 `[T2] as T2`）、照写 skinparam，还夹带前言与结尾反问。语法只要写错一个
 * 字符整段就是废的。让模型只产出「谁连着谁」的数据、语法由代码拼，才能保证合法。
 */
const DIAGRAM_MODES = ['off', 'on'];
const DEFAULT_DIAGRAM_MODE = 'on';
/**
 * 节点/边/标签上限：只做"防爆"用，不做"提炼"用。
 *
 * 早期为了图小，把上限压到 12 节点 / 16 字 / 扇出 5，结果是把原图的结构砍掉一半
 * （实测 VGG19 的三层 4096 全丢、N 层堆叠被合并成一个模块），看起来就像"模型在总结"。
 *
 * 为什么又提到 80 / 140 / 6000（原来 28 / 48 / 860）：
 * 产出的 PlantUML **是给对话助手读的代码**，不是给人看的配图。删掉一个节点，
 * 助手就永远不知道那个部门存在 —— 一份 41 节点的组织架构图曾被裁到 24 个，
 * 13 个团队在产物里一个字都不剩，而助手会据此回答"只有 11 个部门"。
 * 860 字符这条尤其错得离谱：它比节点上限更早触发（约 24 个短名字节点就撞上），
 * 而它本来只是为了"渲染出来的图别溢出窄栏"。宁可图大、代码长，绝不丢结构。
 *
 * 取 80 是因为实测一份三层组织架构（1 根 + 8 中心 + 每中心 5 部门 + 部分挂团队）
 * 恰好落在 60~62 节点，60 的线会把真实图切掉一两个；80 留出余量。
 */
const DIAGRAM_MAX_NODES = 80;
const DIAGRAM_MAX_EDGES = 140;
const DIAGRAM_MAX_LABEL_CHARS = 28;
/**
 * 一个节点最多画几条出边：只挡"放射状糊成一团"的极端情况。
 *
 * 原来是 8 —— 而组织架构图最典型的样子就是"一个中心挂二三十个平级部门"，
 * 实测根节点挂 25 个单元时，第 9 条之后的边全被丢掉，对应节点随即变成孤立点
 * 被一并删除：26 个节点进去只剩 9 个，一个警告都没有。这不是模型漏读，
 * 是工具自己删的。放宽到 40，覆盖真实组织架构的扇出规模。
 */
const DIAGRAM_MAX_FANOUT = 40;
/** 纯符号（不含 +，加法节点是真实结构）。 */
const NOISE_LABEL = /^[\s.,;:*\-–—=/\\×()（）%#_]+$/;

/**
 * 是否"不是模块"的标签。
 *
 * 只挡确定是编号/标注的东西：1–2 位序号（0…9）、纯符号、以及 L×、Nv×、×N 这类
 * "重复多少次"的重复次数标注。**不再**一刀切掉所有纯数字 —— `4096`、`224` 是真实的
 * 层宽/尺寸，丢掉就少了一层结构。
 */
function isNoiseLabel(text) {
    const value = String(text == null ? '' : text).trim();
    if (!value) return true;
    if (/^\d{1,2}$/.test(value)) return true;
    if (/^[A-Za-z]{0,3}\s*[×xX]$/.test(value)) return true;
    if (/^[×xX]\s*[Nn]$/.test(value)) return true;
    return NOISE_LABEL.test(value);
}
/** 低于这个规模不认作结构图：单链条、散点、纯文字截图都会被这条筛回描述路径。 */
const DIAGRAM_MIN_NODES = 3;
const DIAGRAM_MIN_EDGES = 2;
/**
 * 结构图那次调用的 token 上限。
 *
 * 节点上限放宽到 60 之后，60 节点 + 100 条边、名字拉满 28 字时 JSON 约 3800 token，
 * 原来的 3200 会被截断。而截断的后果很重：半个 JSON 解析不了，整张图只能回退成散文，
 * 草图直接没了。所以按"允许的最大图 + 富余"给到 8000（网关侧该模型上限 256K，不紧张）。
 */
const DIAGRAM_MAX_TOKENS = 8000;
/**
 * 草图的落盘方式：```plantuml 代码围栏。
 *
 * 这是**实测唯一能让人看到草图**的写法：平台的渲染器会把围栏渲染成真的方框图。
 * 其它写法都试过、都失败：
 *   - `<details>` 折叠：标签被当原文再显示一遍、折叠不生效，而且它之后的行不再按
 *     markdown 解析，图片退化成 `![image](...)` 裸文本；
 *   - HTML 注释（多行或单行）：被当作灰底代码块直接显示出来，既不隐身也不成图。
 * 所以"隐藏/折叠"属于查看器的能力，内容侧只负责给出围栏。
 */
const DIAGRAM_FENCE = '```plantuml';
const DIAGRAM_FENCE_END = '```';
/**
 * 有草图时，原图不再嵌入正文，改成这一行链接：`[原图](地址)`。
 *
 * 为什么：原图和草图表达的是同一个结构，两张都铺在正文里太占版面；但直接删掉又没法
 * 回头核对（"得保证和原图一致"），所以保留可点开的地址。
 */
const DIAGRAM_IMAGE_LINK_PREFIX = '[原图](';

/** 这条结果是不是"有草图"。 */
function hasSketch(entry) {
    return Boolean(entry && typeof entry === 'object' && entry.puml);
}
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
/**
 * 视觉模型候选，按综合能力从高到低。第一个可用的当主模型兜底，
 * 复核模型取其中第一个「可用且与主模型不同」的。
 *
 * 前三个是针对视觉任务训练的 VL 模型，且在真实文档上量过效果：
 * qwen3-vl-plus 会把并列输入读成合并、doubao-seed-2.0-pro 会把连线方向读反，
 * 两者取交集能压掉编造的边。后两个是金牌渠道的通用模型，只为覆盖面补位。
 *
 * 与 index.js 的 DEFAULT_VISION_CANDIDATES 保持一致；实际以配置
 * docchain_vision_candidates 为准，这里只是没人配置时的兜底。
 */
const DEFAULT_VISION_CANDIDATES = [
    'qwen3-vl-plus',
    'doubao-seed-2.0-pro',
    'glm-5v-turbo',
    'g-doubao-seed-2.1-pro',
    'g-gpt-5.6-sol',
];

/** 去掉空串与重复项，保持原顺序；全空时回落到默认候选。 */
function normalizeCandidates(input) {
    const list = Array.isArray(input) ? input : String(input || '').split(',');
    const seen = new Set();
    const out = [];
    for (const raw of list) {
        const id = String(raw || '').trim();
        if (!id || seen.has(id)) continue;
        seen.add(id);
        out.push(id);
    }
    return out.length > 0 ? out : DEFAULT_VISION_CANDIDATES.slice();
}

const ARG_SPEC = {
    doc_ids: { type: 'string', default: null },
    keyword: { type: 'string', default: null },
    topic_ids: { type: 'string', default: null },
    'max-images': { type: 'int', default: DEFAULT_MAX_IMAGES },
    concurrency: { type: 'int', default: DEFAULT_CONCURRENCY },
    model: { type: 'string', default: null },
    diagram: { type: 'string', default: null },
    'dry-run': { type: 'flag', flag: true, default: false },
    'list-models': { type: 'flag', flag: true, default: false },
    read: { type: 'flag', flag: true, default: false },
    confirm: { type: 'flag', flag: true, default: false },
};

const USAGE = `用法：
  node scripts/describe_images.js --doc_ids 125755 [--max-images 2] [--dry-run] [--diagram off]
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
            // 环境变量必须排最前：早先这里直接用 config 值（缺省已填成默认模型），
            // 把 VISION_MODEL 遮住了 —— CLI 明明设了环境变量，跑的却是默认模型。
            url: String(process.env.VISION_BASE_URL || config.docchain_vision_url || DEFAULT_VISION_URL).replace(
                /\/+$/,
                '',
            ),
            model: String(process.env.VISION_MODEL || config.docchain_vision_model || DEFAULT_VISION_MODEL),
            fallbackModel: String(
                process.env.VISION_FALLBACK_MODEL || config.docchain_vision_fallback_model || DEFAULT_VISION_FALLBACK,
            ),
            judgeModel: String(
                process.env.VISION_JUDGE_MODEL || config.docchain_vision_judge_model || '',
            ),
            candidates: normalizeCandidates(
                config.docchain_vision_candidates || DEFAULT_VISION_CANDIDATES,
            ),
            maxDescChars:
                Number(process.env.VISION_MAX_DESC_CHARS || config.docchain_vision_max_desc_chars) || undefined,
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
    // 模型偶尔会把提示词里的分支编号一起抄出来（"B. 六个子图并列排布…"），
    // 那个 "B." 是给模型看的分支标签，不是描述内容，留着会让每张图都以字母开头。
    value = value.replace(/^[ABab][.．、:：)）]\s*(?=\S)/, '').trim();
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

/**
 * 从模型输出里抠出第一个完整的 JSON 对象。
 *
 * 实测这个模型不会老实"只输出 JSON"：它会在前面写一段"我理解你的要求"、把 JSON
 * 包进 ```json 围栏、末尾再问一句"需要吗"。所以不能直接 JSON.parse 整段。
 * 这里用括号配对扫描（字符串里的花括号与转义正确跳过），既能吃掉外围文字，
 * 也能识别"被 max_tokens 截断"——没闭合就返回 null，交给调用方回退散文。
 *
 * @param {string} text 模型原始输出
 * @returns {string|null} JSON 文本，或 null（没有 / 不完整）
 */
function extractJsonObject(text) {
    const source = String(text || '');
    const start = source.indexOf('{');
    if (start < 0) return null;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < source.length; i += 1) {
        const ch = source[i];
        if (inString) {
            if (escaped) escaped = false;
            else if (ch === '\\') escaped = true;
            else if (ch === '"') inString = false;
            continue;
        }
        if (ch === '"') {
            inString = true;
        } else if (ch === '{') {
            depth += 1;
        } else if (ch === '}') {
            depth -= 1;
            if (depth === 0) return source.slice(start, i + 1);
        }
    }
    return null;
}

/**
 * 把「节点/边」JSON 校验成一张能画的图；不可用则返回 null。
 *
 * 校验口径比"能否解析"严：边指向不存在的节点直接丢弃（模型常把图里的箭头连到
 * 它没列出来的框），节点或边太少说明这根本不是结构图（曲线图、纯文字截图），
 * 一律判 null 让调用方回退成散文描述 —— 宁可少一张草图，不可用废图顶掉好描述。
 *
 * @param {string} text 含 JSON 的文本
 * @returns {{title: string, nodes: Array, edges: Array}|null}
 */
function parseGraph(text) {
    const raw = extractJsonObject(text);
    if (!raw) return null;
    let data;
    try {
        data = JSON.parse(raw);
    } catch {
        return null;
    }
    if (!data || typeof data !== 'object') return null;

    const nodes = [];
    const seen = new Set();
    // 被截断的节点名：{ original, shorter }。数量与原名都要能回溯，否则名字被改了没人知道。
    const truncatedLabels = [];
    // 不再按标签合并：原图里"Add & Norm"、"4096"这类同名框本来就重复出现（N 层堆叠），
    // 合并会把它压成一个模块 —— 那不是精简，是改意思。宁可多几个框。
    const idToCanonical = new Map();
    for (const item of Array.isArray(data.nodes) ? data.nodes : []) {
        if (!item || typeof item !== 'object') continue;
        const id = String(item.id == null ? '' : item.id).trim();
        const rawLabel = String(item.label == null ? '' : item.label)
            .replace(/\s+/g, ' ')
            // 模型会把 LaTeX 下标照抄成 X_{t-1}，PlantUML 不解释它，原样画出来很丑；
            // 去掉花括号变成 X_t-1，短且不丢信息。
            .replace(/_\{([^{}]*)\}/g, '_$1')
            .replace(/\^\{([^{}]*)\}/g, '^$1')
            .trim();
        if (!id || !rawLabel || seen.has(id)) continue;
        seen.add(id);
        // 1–2 位序号、×N、纯符号是图上的编号/标注，不是模块：画出来就是一堆没意义的框。
        if (isNoiseLabel(rawLabel)) continue;
        const wasTruncated = rawLabel.length > DIAGRAM_MAX_LABEL_CHARS;
        const label = wasTruncated ? truncateLabel(rawLabel, DIAGRAM_MAX_LABEL_CHARS) : rawLabel;
        // 截断会把部门名改掉（实测「郑州开发一团队」变成「郑州开发一团」，尾字被吞），
        // 而 truncated 计数此前只统计描述文字、从不含节点名，等于悄悄改了名字。
        // 这里把原名与截断后的名字都记下来，由调用方汇总告警。
        if (wasTruncated) truncatedLabels.push({ original: rawLabel, shorter: label });
        idToCanonical.set(id, id);
        nodes.push({ id, label });
        // 这里**不**按数量截断：早先"够 20 个就 break"会按输入顺序砍掉整列叶子
        // （实测某张 23 节点的组织图，最右侧的"经营三部 + 三个业务办"整段消失）。
        // 超限交给 shrinkGraph 按"删最边缘叶子"处理，保证主干完整。
    }

    const ids = new Set(nodes.map((node) => node.id));
    const rawEdges = [];
    for (const item of Array.isArray(data.edges) ? data.edges : []) {
        if (!item || typeof item !== 'object') continue;
        const from = String(item.from == null ? '' : item.from).trim();
        const to = String(item.to == null ? '' : item.to).trim();
        if (!from || !to) continue;
        const label = String(item.label == null ? '' : item.label).replace(/\s+/g, ' ').trim();
        rawEdges.push({ from, to, label });
    }
    // 被丢掉的节点（patch 编号那类）要"短路"掉：把它的前驱直接接到它的后继上，
    // 否则 "Patch Embedding → 0…9 → Encoder" 这种主干会被拆成两截、图就断开了。
    //
    // 但短路造出来的是一段**推断**，原图里并没有这条边：
    //   营销管理办公室 → [1] → 用户体验设计部   短路后变成
    //   营销管理办公室 → 用户体验设计部
    // 对组织架构图这种"图上编号被当噪声丢掉"的情形，等于凭空画出一条汇报线。
    // 缺节点看得出来，多一条线看不出来，所以短路边一律打 speculated 标记，
    // 渲染时画成虚线，并计入 speculatedEdges。
    const rawOut = new Map();
    for (const edge of rawEdges) {
        if (!rawOut.has(edge.from)) rawOut.set(edge.from, []);
        rawOut.get(edge.from).push(edge.to);
    }
    // 返回 { ids, hops }：hops > 0 说明经过了被丢弃的节点，这条边是推断出来的。
    const resolveEnds = (id, depth) => {
        const mapped = idToCanonical.get(id);
        if (mapped && ids.has(mapped)) return { ids: [mapped], hops: 0 };
        if (depth >= 2) return { ids: [], hops: 0 };
        const next = rawOut.get(id) || [];
        // 只有"恰好一个后继"时才短路：被丢掉的若是扇形枢纽（一个父节点连 8 个子公司），
        // 展开会把兄弟节点两两连成网状假边（实测 6 个节点被连成 30 条边）。
        if (next.length !== 1) return { ids: [], hops: 0 };
        const deeper = resolveEnds(next[0], depth + 1);
        return { ids: deeper.ids, hops: deeper.hops + 1 };
    };

    const edges = [];
    const seenEdge = new Set();
    const fanoutOf = new Map();
    let speculatedEdges = 0;
    for (const edge of rawEdges) {
        const fromSide = resolveEnds(edge.from, 0);
        const toSide = resolveEnds(edge.to, 0);
        // 任一端经过被丢弃的节点，这条边就是推断出来的
        const speculated = fromSide.hops > 0 || toSide.hops > 0;
        for (const from of fromSide.ids) {
            for (const to of toSide.ids) {
                if (from === to) continue; // 合并/短路后产生的自环直接丢
                // 注意：**不能**按"标签相同就不连"过滤 —— 连续的同类模块（VGG19 的三层 4096、
                // 堆叠的 Add & Norm）本来就走同一条链，按标签删边会把它们整段拆断。
                const key = `${from}>${to}`;
                if (seenEdge.has(key)) continue;
                seenEdge.add(key);
                // 同一节点扇出太多会画成一团交叉箭头，按上限截断（先到先得）。
                const fanout = fanoutOf.get(from) || 0;
                if (fanout >= DIAGRAM_MAX_FANOUT) continue;
                fanoutOf.set(from, fanout + 1);
                const record = { from, to, label: edge.label };
                if (speculated) {
                    record.speculated = true;
                    speculatedEdges += 1;
                }
                edges.push(record);
            }
        }
        // 同理不按数量 break：边也要全部收进来，超限由 shrinkGraph 统一裁。
    }

    if (nodes.length < DIAGRAM_MIN_NODES || edges.length < DIAGRAM_MIN_EDGES) return null;

    // 先把"同一个框被写成多个 id"的冗余节点合并掉，再生效孤立点过滤：
    // 否则同名重复节点之间的边会变成自环、重复边，看着就像逻辑错了。
    const collapsed = mergeRedundantNodes(nodes, edges);

    // 一条边都不沾的节点就是"漂浮的标签"（实测原图的行标题 输入层/正向LSTM 被当成节点），
    // 它们不承载结构，画出来只会让人以为图里有多余模块 —— 直接丢。
    const connected = new Set();
    for (const edge of collapsed.edges) {
        connected.add(edge.from);
        connected.add(edge.to);
    }
    const keptNodes = collapsed.nodes.filter((node) => connected.has(node.id));
    if (keptNodes.length < DIAGRAM_MIN_NODES) return null;

    let title = typeof data.title === 'string' ? data.title.replace(/\s+/g, ' ').trim() : '';
    // 模型会把模板里的占位说明原样抄进 title（实测出现过 "图的标题，没有就空串"），
    // 那不是标题，画到图上只会是噪音。
    if (/图的标题|没有就空串|图的标题，/.test(title)) title = '';
    const shrunk = shrinkGraph({ title, nodes: keptNodes, edges: collapsed.edges });
    // mergeRedundantNodes 会重算边，推测标记按 (from,to) 传下去
    const speculatedKeys = new Set(
        edges.filter((edge) => edge.speculated).map((edge) => `${edge.from}>${edge.to}`),
    );
    for (const edge of shrunk.edges) {
        if (!edge.speculated && speculatedKeys.has(`${edge.from}>${edge.to}`)) edge.speculated = true;
    }
    shrunk.speculatedEdges = shrunk.edges.filter((edge) => edge.speculated).length;
    // 只保留仍然留在图上的那些（被裁掉的节点不必再提它的名字被截过）
    const keptIds = new Set(shrunk.nodes.map((node) => node.label));
    shrunk.truncatedLabels = truncatedLabels.filter((item) => keptIds.has(item.shorter));
    // 模型自报的方框总数（提示词要求它先数一遍再输出）。
    // 与 nodes 数量对不上就是它自己承认漏了 —— 只当信号用，不做强校验：
    // 模型数错是常事，硬拦会把正常图挡回去。
    const declared = Number(data.boxCount);
    shrunk.declaredBoxCount = Number.isInteger(declared) && declared > 0 ? declared : null;
    return shrunk;
}

/**
 * 超上限时按"删最边缘的叶子"裁剪，而不是按输入顺序砍。
 *
 * 为什么不能按顺序：模型是按行输出的，`if (nodes.length >= MAX) break` 会把最后几行
 * 的节点整段丢掉 —— 实测一张 23 节点的组织图，最右侧"经营三部 + 三个业务办"整列消失，
 * 看着就像模型漏读。改成"从叶子节点里挑度最小的删"，各分支会被均匀保留，主干不受影响。
 */
function shrinkGraph(graph) {
    if (!graph) return graph;
    const withinLimits = (g) => g.nodes.length <= DIAGRAM_MAX_NODES && g.edges.length <= DIAGRAM_MAX_EDGES;
    const originalNodeCount = graph.nodes.length;
    let current = graph;
    for (let guard = 0; guard < 400; guard += 1) {
        if (withinLimits(current)) break;
        if (current.nodes.length <= DIAGRAM_MIN_NODES) break;
        const victim = pickLeafVictim(current);
        if (!victim) break;
        current = {
            title: current.title,
            nodes: current.nodes.filter((node) => node.id !== victim.id),
            edges: current.edges.filter((edge) => edge.from !== victim.id && edge.to !== victim.id),
            // 推测边数由 parseGraph 挂在图上，裁剪过程中要一路带着
            speculatedEdges: current.speculatedEdges,
        };
    }
    // 裁掉多少必须写进结果：否则拿到图的人分不清"原图就这几个框"和"被砍到只剩这些"。
    // 推测边也要按裁剪后的实际边重算——被删掉的那条不该再计数。
    return {
        ...current,
        removedNodes: originalNodeCount - current.nodes.length,
        speculatedEdges: current.edges.filter((edge) => edge.speculated).length,
    };
}

/**
 * 洗一个标签：它在 PlantUML 里是双引号字符串。
 *
 * 引号必须去掉：模型会把图里的引号原样抄进 label，直接塞进去会把字符串提前闭合。
 * 代码围栏也要去掉（否则生成的块会被 md 提前截断）；换行压成空格避免撑破版面。
 */
function sanitizePumlLabel(text) {
    const value = String(text == null ? '' : text)
        .replace(/"/g, "'")
        .replace(/`/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return value || '(未命名)';
}

/**
 * 判断一个"节点标签"其实是版面标注，而不是模块名。
 *
 * 依据（都是版式信息图特有的痕迹，真正的流程图/架构图模块名不会这样）：
 * - 含句读（`：` `，` `。` `；` `、`）：模块名不会写成一句话；
 * - 含间隔号 `·`：常见于"公司级统筹层·规"这类分层标注。
 *
 * **不能用省略号 `…` 当证据**：那是我们自己 `truncateLabel` 截断长名字留下的痕迹，
 * 长名字的模块（`Eastern Hemisphere Solution…`）本来就会带 —— 拿它判会把正常架构图
 * 误伤成版式图（实测一张 12 节点的组织图因此被退回描述）。
 */
function isAnnotationLabel(label) {
    const text = String(label || '');
    if (!text) return false;
    if (text.includes('·')) return true;
    return /[：:，,。；;、]/.test(text);
}

/**
 * 图上"节点"里有多少其实是版面标注。
 *
 * 为什么需要这条兜底：分类只看图，遇到"色块分区 + 装饰箭头"的版式信息图会判成
 * 结构图（同一张图在不同提示词下还翻过面）。但版式图的"节点"必然是分层标注、
 * 说明长句 —— 一旦这类标签占比过高，说明这根本不是结构图，应当退回描述。
 *
 * 阈值取"至少 3 个且占比 1/4"：实测版式图里这类标签约 5/18（27.8%）能被抓住，
 * 而正常架构图里带标点的名字通常 0~1 个，够不上这个比例。
 */
function annotationHeavy(graph) {
    if (!graph || !Array.isArray(graph.nodes) || graph.nodes.length === 0) return false;
    const bad = graph.nodes.filter((node) => isAnnotationLabel(node.label)).length;
    return bad >= 3 && bad / graph.nodes.length >= 0.25;
}

/**
 * 把图结构渲染成 PlantUML 文本。
 *
 * 别名统一重排成 n1..nK **并按节点顺序先全部声明**，再输出边 —— 模型给的数据里
 * 别名什么样都可能（中文、数字开头、重复），直接用它极易写出非法代码，而"先声明
 * 后引用"正是实测里模型自己最容易写错的点。
 *
 * @param {{title: string, nodes: Array, edges: Array}} graph
 * @returns {string} `@startuml … @enduml`，graph 不可用时返回空串
 */
function renderPuml(graph) {
    if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) return '';
    if (graph.nodes.length === 0) return '';
    const alias = new Map();
    // 竖排：阅读区宽度只有 600 多像素，横排的图一定被裁（实测左边 Embedding 整块被切掉）；
    // 高度可以正常滚动，宽度不能溢出。
    const lines = ['@startuml', 'top to bottom direction'];
    if (graph.title) lines.push(`title ${sanitizePumlLabel(graph.title)}`);
    graph.nodes.forEach((node, index) => {
        const name = `n${index + 1}`;
        alias.set(node.id, name);
        lines.push(`rectangle "${sanitizePumlLabel(node.label)}" as ${name}`);
    });
    for (const edge of graph.edges) {
        const from = alias.get(edge.from);
        const to = alias.get(edge.to);
        if (!from || !to) continue;
        const label = String(edge.label == null ? '' : edge.label).trim();
        // 推测出来的边画虚线：它来自"被丢弃节点的前驱接后继"，原图并没有这条连线。
        // 用实线画出来就等于告诉读者这是原图里的确定关系。
        const arrow = edge.speculated ? '..>' : '-->';
        lines.push(label ? `${from} ${arrow} ${to} : ${sanitizePumlLabel(label)}` : `${from} ${arrow} ${to}`);
    }
    lines.push('@enduml');
    return lines.join('\n');
}


/**
 * 只去掉"两家说法相反"的边：主模型给 A→B、复核模型给 B→A，说明这条边的方向读不准，
 * 删掉；其余边全部保留。
 *
 * 为什么不用"取交集"：两个模型在"自下而上"这类图上常整套读反，交集会把整条链拆成碎片
 * （实测 Transformer 只剩 3 条边）。只删方向矛盾的边，既保住了结构，又不会画出反的箭头。
 *
 * 节点按**标签**对齐（id 是模型自己编的，两次不可能一样）。
 *
 * @returns {{title: string, nodes: Array, edges: Array}|null} 剩下的太少则返回 null
 */
function subtractContradictions(primary, judge) {
    if (!primary) return null;
    if (!judge) return primary;
    const keyOf = (labelOf) => (edge) => {
        const from = labelOf.get(edge.from);
        const to = labelOf.get(edge.to);
        return from && to ? `${from}→${to}` : '';
    };
    const primaryKey = keyOf(new Map(primary.nodes.map((node) => [node.id, node.label])));
    const judgeKey = keyOf(new Map(judge.nodes.map((node) => [node.id, node.label])));

    const judgeEdges = new Set();
    for (const edge of judge.edges) {
        const key = judgeKey(edge);
        if (key) judgeEdges.add(key);
    }
    const edges = [];
    for (const edge of primary.edges) {
        const key = primaryKey(edge);
        if (!key) continue;
        const cut = key.indexOf('→');
        const reversed = `${key.slice(cut + 1)}→${key.slice(0, cut)}`;
        if (judgeEdges.has(reversed)) continue; // 方向被另一个模型否定
        edges.push(edge);
    }
    if (edges.length < DIAGRAM_MIN_EDGES) return null;
    // 边被删掉后变孤立的节点一并去掉，不画漂浮框。
    const used = new Set();
    for (const edge of edges) {
        used.add(edge.from);
        used.add(edge.to);
    }
    const nodes = primary.nodes.filter((node) => used.has(node.id));
    if (nodes.length < DIAGRAM_MIN_NODES) return null;

    // 节点集比对（只告警，不改图）。
    //
    // 上面的逻辑只仲裁"边方向"，从不比较两个模型各认出多少个节点。两个模型都
    // 漏掉同一个部门时，没有任何一方会提出异议 —— 图上少画一个部门，等于在组织
    // 文件里凭空撤销它。缺节点比多一条线更危险：多一条线看得见，少一个部门是空白。
    //
    // 为什么不把复核多出的节点补进去：复核模型也可能幻觉出不存在的部门，贸然补
    // 进去等于用一个未经验证的猜测制造新错误。这里只如实报告数量，由人判断。
    const labelSet = (graph) =>
        new Set(
            (graph.nodes || [])
                .map((node) => String(node.label == null ? '' : node.label).trim())
                .filter(Boolean),
        );
    const primaryLabels = labelSet(primary);
    const judgeLabels = labelSet(judge);
    let missingFromPrimary = 0;
    let extraInPrimary = 0;
    for (const label of judgeLabels) if (!primaryLabels.has(label)) missingFromPrimary += 1;
    for (const label of primaryLabels) if (!judgeLabels.has(label)) extraInPrimary += 1;

    return {
        title: primary.title,
        nodes,
        edges,
        speculatedEdges: (primary.speculatedEdges || 0),
        missingFromPrimary,
        extraInPrimary,
    };
}

/**
 * 截断标签，尽量按词边界切。
 *
 * 直接 slice 会把英文切成 "Asia-Pacific Sales Departmen…" 这种半个词，图上很难读；
 * 这里优先切在最后一个空格处（中文没有空格时退回硬切）。
 */
function truncateLabel(text, limit) {
    const value = String(text == null ? '' : text);
    if (value.length <= limit) return value;
    const head = value.slice(0, limit);
    const space = head.lastIndexOf(' ');
    const base = space > limit * 0.5 ? head.slice(0, space) : head;
    return `${base.trimEnd()}…`;
}

/**
 * 一段草图渲染后的字符上限。
 *
 * 原来取 860，依据是"846 字节能渲染、886 字符渲染不出来"。实测下来那个边界
 * 站不住：把不同规模的草图丢给 PlantUML 官方服务器，2110 字符（60 节点）和
 * 5412 字符（150 节点）都能正常出 SVG。当时看到的失败更可能是特定渲染容器的
 * 显示限制，或者网络超时，而不是 PlantUML 画不出来。
 *
 * 而这个上限的代价是实打实的：产出是给对话助手读的代码，删一个节点，助手就
 * 永远不知道那个部门存在。所以放宽到 6000，只当"防爆"兜底，防止极端输入生成
 * 几十 KB 的代码。实测 80 节点、名字拉满 28 字时约 4900 字符，仍在 6000 以内。
 */
const DIAGRAM_MAX_PUML_CHARS = 6000;

/**
 * 挑一个"最该删"的叶子节点。
 *
 * 两条硬约束：
 * 1. 只挑"有父节点、没有子节点"的 —— 永远删不到根和主干；
 * 2. **优先删最深的**叶子 —— 层级越深越外围。
 *
 * 第 2 条是踩坑改出来的：早先按"兄弟最多的分支优先"删，结果一张组织图
 * （浩鲸科技 → 8 个中心 → 各部门）里，根下面那 8 个中心恰好都是"浅层叶子"，
 * 于是"国内业务运营中心""国际业务运营中心"被当成外围节点删掉了 —— 顶层主干
 * 反而先掉。正确顺序应当是：先削最底层的团队，顶层的中心一个都不能少。
 */
function pickLeafVictim(graph) {
    const outCount = new Map();
    const inCount = new Map();
    const parentOf = new Map();
    const childrenOf = new Map();
    for (const edge of graph.edges) {
        outCount.set(edge.from, (outCount.get(edge.from) || 0) + 1);
        inCount.set(edge.to, (inCount.get(edge.to) || 0) + 1);
        if (!parentOf.has(edge.to)) parentOf.set(edge.to, edge.from);
        if (!childrenOf.has(edge.from)) childrenOf.set(edge.from, []);
        childrenOf.get(edge.from).push(edge.to);
    }
    // 从根（没有入边的节点）开始算深度，防环用 visited 限制。
    const depth = new Map();
    const roots = graph.nodes.filter((node) => !inCount.has(node.id));
    const queue = (roots.length ? roots : graph.nodes.slice(0, 1)).map((node) => [node.id, 0]);
    const seen = new Set();
    while (queue.length) {
        const [id, d] = queue.shift();
        if (seen.has(id)) continue;
        seen.add(id);
        depth.set(id, d);
        for (const child of childrenOf.get(id) || []) queue.push([child, d + 1]);
    }
    const leaves = graph.nodes.filter((node) => (outCount.get(node.id) || 0) === 0 && parentOf.has(node.id));
    if (leaves.length === 0) return null;
    const leafSiblings = new Map();
    for (const leaf of leaves) {
        const parent = parentOf.get(leaf.id);
        leafSiblings.set(parent, (leafSiblings.get(parent) || 0) + 1);
    }
    return leaves.slice().sort((a, b) => {
        // 先比深度：深的先删（最外围）
        const da = depth.get(a.id) || 0;
        const db = depth.get(b.id) || 0;
        if (da !== db) return db - da;
        // 同深度时，优先削"兄弟多"的分支，让各分支均匀保留
        const ca = leafSiblings.get(parentOf.get(a.id)) || 0;
        const cb = leafSiblings.get(parentOf.get(b.id)) || 0;
        return cb - ca;
    })[0];
}

/**
 * 把图裁到"渲染得出来"的体量：超出字符上限就从叶子节点开始删。
 *
 * 只删叶子：删中间节点会把链断成两截，看起来就像逻辑错了。
 */
function fitGraph(graph) {
    if (!graph) return graph;
    const inheritedRemoved = graph.removedNodes || 0;
    const originalNodeCount = graph.nodes.length;
    let current = graph;
    for (let guard = 0; guard < 300 && current; guard += 1) {
        if (renderPuml(current).length <= DIAGRAM_MAX_PUML_CHARS) break;
        if (current.nodes.length <= DIAGRAM_MIN_NODES) break;
        const victim = pickLeafVictim(current);
        if (!victim) break;
        current = {
            title: current.title,
            nodes: current.nodes.filter((node) => node.id !== victim.id),
            edges: current.edges.filter((edge) => edge.from !== victim.id && edge.to !== victim.id),
            speculatedEdges: current.speculatedEdges,
        };
    }
    // 同 shrinkGraph：被字符上限砍掉的量也要记账，别让人以为图本来就这么小。
    // 上游（shrinkGraph）已经裁掉的数量要一起带上，否则两次裁剪只报后一次。
    return {
        ...current,
        removedNodes: inheritedRemoved + (originalNodeCount - current.nodes.length),
    };
}

/**
 * 合并"完全冗余"的节点：标签相同、且**邻居 id 完全一致**的多个节点其实是同一个框。
 *
 * 为什么必须用邻居 id 而不是标签：VGG19 那种 `512→512→512` 的长链里，每个中间节点的
 * 邻居"标签"都一样（前一个 512、后一个 512），按标签判就会把整条链压成一个节点。
 * 按 id 判则只有真正的重复（同一个框被模型写成三个 id）才会命中 —— 实测 BiLSTM 的
 * `h_t-1` 被拆成三个，导致 `h_t-1 → h_t-1` 自环与重复边。
 *
 * @returns {{nodes: Array, edges: Array, merged: number}}
 */
function mergeRedundantNodes(nodes, edges) {
    const signature = (node) => {
        const parts = [];
        for (const edge of edges) {
            if (edge.from === node.id) parts.push(`>${edge.to}`);
            if (edge.to === node.id) parts.push(`<${edge.from}`);
        }
        return parts.sort().join('|');
    };
    const firstOf = new Map();
    const remap = new Map();
    const kept = [];
    for (const node of nodes) {
        const key = `${node.label}#${signature(node)}`;
        const existing = firstOf.get(key);
        if (existing) {
            remap.set(node.id, existing);
            continue;
        }
        firstOf.set(key, node.id);
        remap.set(node.id, node.id);
        kept.push(node);
    }
    if (kept.length === nodes.length) return { nodes, edges, merged: 0 };
    const seen = new Set();
    const nextEdges = [];
    for (const edge of edges) {
        const from = remap.get(edge.from);
        const to = remap.get(edge.to);
        if (!from || !to || from === to) continue; // 合并后产生的自环直接丢
        const key = `${from}>${to}`;
        if (seen.has(key)) continue;
        seen.add(key);
        nextEdges.push({ from, to, label: edge.label });
    }
    return { nodes: kept, edges: nextEdges, merged: nodes.length - kept.length };
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
/**
 * 生成一张图要插入的行：描述注释（可能没有）+ PlantUML 代码块（可能没有）。
 *
 * 代码块必须放在注释**外面**：① 注释渲染后是隐形的，塞进去人就看不到草图；
 * ② PlantUML 的箭头 `-->` 是合法语法，放进 `<!-- -->` 会提前闭合注释、把后面的
 * 图片行整段吞掉。所以围栏里的内容一律原样写入，不做任何转义。
 *
 * @param {string|{text?: string, puml?: string}} entry 描述文本，或 {text, puml}
 * @param {string} eol 锚点行的行尾（CRLF 文档要保持 CRLF）
 * @returns {string[]} 要插在图片行前面的行
 */
function describeInsertLines(entry, eol) {
    const value = typeof entry === 'string' ? { text: entry } : entry || {};
    const lines = [];
    if (value.text) lines.push(`${DESC_PREFIX}${value.text}${DESC_SUFFIX}${eol}`);
    if (value.puml) {
        // 代码围栏：这个平台的渲染器会把 ```plantuml 渲染成真的方框图 —— 这是实测
        // 唯一"能让人看到草图"的写法。其它写法都试过、都失败：
        //   - `<details>` 折叠：不支持（标签被当原文显示、折叠不生效，还会吃掉后续 markdown）；
        //   - HTML 注释：被当灰底代码块直接显示出来，既不隐身也不成图。
        // 所以"默认收起、点击展开"属于查看器的能力，内容侧只提供围栏。
        lines.push(`${DIAGRAM_FENCE}${eol}`);
        for (const line of String(value.puml).split('\n')) lines.push(`${line}${eol}`);
        lines.push(`${DIAGRAM_FENCE_END}${eol}`);
    }
    return lines;
}

function injectDescriptions(md, descByKey) {
    const source = String(md);
    const lines = source.split('\n');
    // 插入行统一用整个文件的主导换行：CRLF 文件最后一行的 line 不带 \r，
    // 按行取行尾会让插在末行前的注释变成裸 LF，写回后与文件其余部分不一致。
    const insertEol = /\r\n/.test(source) ? '\r' : '';
    const out = [];
    let injected = 0;
    let removed = 0;
    for (const line of lines) {
        // 主 md 里如果本来就带着 image-desc 注释（平台解析时写的，或人工加过的），
        // 先剥掉再插新的 —— 否则同一张图会出现「旧注释 + 新草图 + 新注释」叠在一起，
        // 看着就像同一张图既给了草图又给了注释。
        if (/^<!--\s*image-desc:/.test(line.trim())) {
            removed += 1;
            continue;
        }
        const refs = [];
        for (const rawRef of collectRawRefs(line)) {
            const raw = normalizeRawRef(rawRef);
            if (!raw) continue;
            const key = refKey(raw);
            if (!refs.some((item) => item.key === key)) refs.push({ key, raw });
        }
        const keys = refs.filter((item) => descByKey.has(item.key)).map((item) => item.key);
        for (const key of keys) {
            for (const inserted of describeInsertLines(descByKey.get(key), insertEol)) out.push(inserted);
            injected += 1;
        }
        // 无论这张图出的是草图还是注释，原图都不再嵌进正文（图大、且与产出重复），
        // 只留一行可点链接，需要对照时点开原图。
        const replaceWithLink = refs.length === 1 && keys.length === 1;
        if (replaceWithLink) out.push(`${DIAGRAM_IMAGE_LINK_PREFIX}${refs[0].raw})${insertEol}`);
        else out.push(line);
    }
    return { content: out.join('\n'), injected, removed };
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
    // 结构图开关：参数 > 配置 > 环境变量 > 默认值；认不出的值静默回落（配置写错不该让整篇失败）。
    const diagramRaw = String(params.diagram || source.diagram || process.env.VISION_DIAGRAM || DEFAULT_DIAGRAM_MODE)
        .trim()
        .toLowerCase();
    const diagram = DIAGRAM_MODES.includes(diagramRaw) ? diagramRaw : DEFAULT_DIAGRAM_MODE;
    // 候选清单：参数 > 配置 > 默认值。顺序即优先级，第一个可用的当主模型兜底。
    const candidates = normalizeCandidates(
        params.candidates || source.candidates || DEFAULT_VISION_CANDIDATES,
    );
    // 复核模型：参数 > 配置 > 环境变量，都没有就从候选里挑。
    // 显式传空串（params.judgeModel === ''）表示"只读一遍"，不再从候选里补。
    const judgeExplicitlyOff =
        params.judgeModel !== undefined && params.judgeModel !== null && !String(params.judgeModel).trim();
    let judgeModel = '';
    if (!judgeExplicitlyOff) {
        const judgeRaw =
            params.judgeModel === undefined || params.judgeModel === null
                ? source.judgeModel || process.env.VISION_JUDGE_MODEL || ''
                : params.judgeModel;
        judgeModel = String(judgeRaw || '').trim();
    }
    // 复核的意义在于"换一个模型再读一遍"，和主模型相同时拿不到第二视角，
    // 调用方会直接跳过（见 describeOneImage）。没配复核模型、或配的那个恰好
    // 等于主模型时，从候选里换一个不同的。
    if (!judgeExplicitlyOff && (!judgeModel || judgeModel === model)) {
        judgeModel = candidates.find((id) => id !== model) || '';
    }
    return { url, key, model, fallbackModel, maxDescChars, diagram, judgeModel, candidates };
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
function buildProsePrompt(docNameText, index, total) {
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

/**
 * 分类提示词：只让它回答一个词。
 *
 * 为什么单独拆一次调用：实测把"先判断再执行"写进同一个提示词里，模型会直接忽略判断、
 * 看到方框就吐 JSON（海报式的分层色块图也被硬凑成结构图）。拆成单任务后它很听话。
 *
 * 判据是用户给的：这张图的**信息是不是由结构承载**，而不是"看起来像不像流程图"。
 */
function buildKindPrompt() {
    return (
        '只回答一个词，不要解释、不要标点。\n' +
        '先逐条核对下面两条（是结构图必须**同时满足**）：\n' +
        '  (1) 图中有**连接线**（箭头、实线或虚线）把不同的方框连起来；\n' +
        '  (2) 去掉这些连线之后，方框之间的先后/包含/流转关系就无从得知。\n' +
        '两条都满足 → 只回答 STRUCTURE（流程图、架构图、系统结构图、时序图都算，节点再多也算）。\n' +
        '任何一条不满足 → 只回答 PROSE。特别注意这几种**一律 PROSE**：\n' +
        '  · 靠色块分区、左右分栏、竖排标注来表达关系的版式图/信息图/海报；\n' +
        '  · 方框之间没有连线的组织架构图、部门并列表；\n' +
        '  · 框里是成段说明文字、宣传文案、职责描述，而不是模块名；\n' +
        '  · 照片、界面截图、纯文字、曲线图、柱状图、表格。'
    );
}

/**
 * 解析分类结果：按**首词**判断，不能全文搜关键字符。
 *
 * 早先用 `/STRUCTURE/i.test(text)`，模型只要回一句 `PROSE（不符合 STRUCTURE 条件）`
 * 就会被误判成结构图 —— 而这一句恰恰是最常见的回答形式。
 */
function parseKind(text) {
    const raw = String(text || '').trim();
    if (!raw) return 'prose';
    // 模型可能不按约定的英文回答，先认中文首词（只认开头，避免"非结构图"这类反话被误读）。
    if (/^(结构|流程图|架构图)/.test(raw)) return 'structure';
    if (/^(描述|注释|非结构)/.test(raw)) return 'prose';
    const value = raw.toUpperCase();
    if (/^STRUCT/.test(value)) return 'structure';
    if (/^PROSE/.test(value)) return 'prose';
    // 首词认不出时再看：两个关键词只出现一个才采用，同时出现按 prose（保守，不出错图）。
    const hasStructure = value.includes('STRUCTURE');
    const hasProse = value.includes('PROSE');
    if (hasStructure && !hasProse) return 'structure';
    return 'prose';
}

/**
 * 一张图的提示词：结构图给「节点/边」数据，其它图给中文描述。
 *
 * 二选一写在同一段里、由模型自己判类型 —— 因为判错代价不对称：把一张曲线图
 * 误判成结构图，会用它换掉一段本来好好的描述。让真正看过图的那一次调用去判，
 * 比在描述文本里匹配"流程图/箭头"这类关键词准得多，也不多花一次请求。
 *
 * `diagramMode === 'off'` 时原样回到纯描述提示词（行为与加这个功能之前一致）。
 *
 * @param {string} docNameText 文档名
 * @param {number} index 第几张（1 起）
 * @param {number} total 共几张
 * @param {string} [diagramMode] 'on' / 'off'
 * @returns {string}
 */
function buildPrompt(docNameText, index, total, diagramMode, declaredBoxCount) {
    const prose = buildProsePrompt(docNameText, index, total);
    if (diagramMode === 'off') return prose;
    let head = `这是文档《${docNameText}》中的一张图片（第 ${index}/${total} 张）。`;
    // 补问时把上一轮模型自报的方框数带回来，给它一个明确的目标数量。
    if (Number.isInteger(declaredBoxCount) && declaredBoxCount > 0) {
        head += `这张图上有 ${declaredBoxCount} 个方框，请逐个列出，不要遗漏。`;
    }
    return (
        head +
        '按下面二选一作答，只输出其中一种，不要解释、不要代码围栏、不要收尾提问。\n' +
        'A. 结构图（流程图、架构图、结构示意图、框图、时序图、状态图 —— 信息只能通过"谁连着谁、谁包含谁、' +
        '怎么分支、怎么汇合"表达，去掉方框和箭头信息就没了）：只输出一个 JSON 对象，别的什么都不要写：\n' +
        '{"title":"图的标题，没有就空串","boxCount":图上方框总数,"nodes":[{"id":"n1","label":"图中原文"}],' +
        '"edges":[{"from":"n1","to":"n2","label":"箭头上或线上的文字"}]}\n' +
        '   规则（按重要性，每条都对应实测踩过的坑）：\n' +
        // 这里原来写着"节点不超过 20 个"，而代码侧上限是 80 —— 图上 25 个部门时模型会主动
        // 只写 20 个，等于工具自己让模型漏读。产物是给对话助手读的代码，少一个方框就等于
        // 那个部门不存在，所以改成"有多少写多少"，并要求先数方框再输出。
        '   1. label 照抄图中原文，不改写、不翻译、不概括；看不清的节点直接不写，禁止编造。\n' +
        '   1b. 方框**一个都不能省略**：图上有多少个方框就写多少个节点，不要为了简洁而合并或跳过。' +
        '输出 JSON 前先数一遍图里的方框总数，把它写进 boxCount 字段，并确认 nodes 的数量与它一致。' +
        '例：{"title":"...","boxCount":12,"nodes":[...],"edges":[...]}\n' +
        // 实测：一张图里两条并列支路（图像支路/文本支路）会被它连成同一个输入，凭空多出跨支路的边。
        '   2. 并列的多条支路不要互连：图里 A 只连到 B，就不要写 A→C —— 即使 B、C 是同类模块、看起来"应该"都接 A。\n' +
        // 实测：图像 + 文字两个输入时，它只留文字那个节点，图像整路消失，于是文字"看起来"连了一圈。
        '   2b. 图上有几个并列的输入就写几个输入节点：例如左边一幅图像、下面一段文字，要分别列成两个节点、' +
        '各自只连到自己那一路，不要把两个输入合成一个，也不要只写其中一个。\n' +
        // 实测：模型会按版面顺序猜方向，自下而上 / 自右向左的图会被整体读反。
        '   3. 箭头方向必须照抄：from 是箭头起点、to 是终点，与版面上下左右无关；' +
        '箭头朝上就写 下面的节点→上面的节点，朝左就写 右边的节点→左边的节点，不要按阅读顺序猜。\n' +
        // 实测：分层的堆叠会被跨层直连（输入直接连到第三层、第一层直接连到最末层）。
        '   4. 竖向排列的模块是一层一层往下（或往上）串联，不要跨层直连；只有图上确实有一条跨层的线才写。\n' +
        // 实测：残差连接（绕过模块再汇合）常被整体丢掉，图就少了最难画的那部分。
        '   5. 绕过某个模块又汇合回来的弧线（残差/跳连）必须画出来；⊕、+ 这类相加节点要保留。\n' +
        // 实测：N× 被当成节点，甚至被画成一条回到块首的回边。
        '   6. N×、L×、×N 只表示"这个块重复几次"：既不是节点，也不是一条连线，不要画成回边。\n' +
        // 实测：虚线框/大括号旁的分组标题（Transformer Encoder、BiLSTM、VGG19）被当成流程节点，
        // 于是"标题→内容"被画成一条边，整张图的方向就反了。
        '   7. 虚线框或大括号旁边的文字（如 Transformer Encoder、BiLSTM、VGG19）是这一组的**标题**，' +
        '不是流程节点：不要把它列成节点，也不要用它连边；组内的模块按它们之间箭头的实际方向连。\n' +
        // 实测：BiLSTM 那种"正向/反向两排同名模块"会被并成一排，反向那一层整层消失。
        '   8. 图上并排的两排（或两列）模块即使名字相同（例如正向 LSTM 与反向 LSTM 都叫 h），' +
        '也要**分别列成两组节点**，用图上的行标题或下标区分（如 h_t 与 h′_t）；' +
        '行标题本身不算节点，但要用它把两排区分开，绝不能合并成一层。\n' +
        '   9. 每个出边单独一条，不要合并。\n' +
        'B. 其它图（海报/宣传图/分层色块的版式图、照片、界面截图、纯文字、曲线图、柱状图、表格等）：' +
        '按下面的规则写中文描述。\n' +
        // 复用同一段描述规则文本，保证"结构图关掉"与"其它图"两条路径逐字一致。
        prose.slice(head.length)
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
        // 先单独判一次"这张图该出结构还是该写描述"。判断和执行拆成两次调用，
        // 是因为实测同一个提示词里写"先判断再执行"时，模型会跳过判断直接吐 JSON。
        let kind = 'prose';
        if (ctx.diagramMode !== 'off') {
            try {
                const judge = await vision.describeImage({
                    baseUrl: visionConfig.url,
                    apiKey: visionConfig.key,
                    model: visionConfig.model,
                    image: bytes,
                    mime,
                    prompt: buildKindPrompt(),
                    maxTokens: 16,
                    state: ctx.state,
                });
                if (judge.rateLimited) ctx.rateLimited += judge.rateLimited;
                kind = parseKind(judge.text);
                if (kind === 'structure') ctx.diagramStructured += 1;
                else ctx.diagramAsProse += 1;
            } catch {
                // 判断失败不阻断：按"描述"走，至少保证有产出。
                ctx.diagramAsProse += 1;
                kind = 'prose';
            }
        }

        const out = await vision.describeImage({
            baseUrl: visionConfig.url,
            apiKey: visionConfig.key,
            model: visionConfig.model,
            image: bytes,
            mime,
            // 判定是"描述"时直接用纯描述提示词，从源头上避免模型硬凑成结构。
            prompt: buildPrompt(ctx.docName, position, ctx.total, kind === 'structure' ? ctx.diagramMode : 'off'),
            maxTokens:
                ctx.diagramMode === 'off' || kind !== 'structure'
                    ? DESC_MAX_TOKENS
                    : Math.max(DESC_MAX_TOKENS, DIAGRAM_MAX_TOKENS),
            state: ctx.state,
        });
        const limit = ctx.maxDescChars || DESC_MAX_CHARS;
        let raw = String(out.text || '').replace(/\s+/g, ' ').trim();
        if (!raw) return { ok: false, error: 'EMPTY_DESC', message: '模型返回空描述' };
        if (out.rateLimited) ctx.rateLimited += out.rateLimited;

        // 可疑复核（只对自相矛盾的样本补问一次，不每张都花这个成本）：
        // 判成"描述"，可这次回答里却出现了图数据签名 `"nodes":` —— 说明它其实看得到结构，
        // 分类那次很可能判错。这时改用结构提示词重问一次，能出图就用图。
        if (kind === 'prose' && ctx.diagramMode !== 'off' && /"nodes"\s*:/.test(raw)) {
            ctx.diagramSuspect += 1;
            try {
                const retry = await vision.describeImage({
                    baseUrl: visionConfig.url,
                    apiKey: visionConfig.key,
                    model: visionConfig.model,
                    image: bytes,
                    mime,
                    prompt: buildPrompt(ctx.docName, position, ctx.total, ctx.diagramMode),
                    maxTokens: Math.max(DESC_MAX_TOKENS, DIAGRAM_MAX_TOKENS),
                    state: ctx.state,
                });
                if (retry.rateLimited) ctx.rateLimited += retry.rateLimited;
                const retryText = String(retry.text || '').replace(/\s+/g, ' ').trim();
                if (/"nodes"\s*:/.test(retryText)) {
                    const graph = parseGraph(retryText);
                    const puml = graph ? renderPuml(fitGraph(graph) || graph) : '';
                    if (puml) {
                        ctx.diagramStructured += 1;
                        ctx.diagramAsProse -= 1; // 分类改判：从"描述"挪到"结构"
                        ctx.diagramRendered += 1;
                        ctx.diagramNodes += (fitGraph(graph) || graph).nodes.length;
                        ctx.diagramEdges += (fitGraph(graph) || graph).edges.length;
                        return { ok: true, kind: 'diagram', puml, ms: out.ms };
                    }
                }
                raw = retryText || raw;
            } catch {
                // 复核失败就按原来的描述走
            }
        }

        // A 类（结构图）：模型给的是「节点/边」数据 → 由 renderPuml 生成语法合法的草图，
        // 不再写散文注释。模型只负责看懂结构，拼语法这件事交给代码。
        // 入口条件看 `"nodes":` 这个图数据签名：普通描述里即使夹着公式花括号（\frac{a}{b}）
        // 也不会被误当成 JSON 处理。
        if (ctx.diagramMode !== 'off' && /"nodes"\s*:/.test(raw)) {
            const jsonText = extractJsonObject(raw);
            const graph = jsonText ? parseGraph(jsonText) : null;
            // 兜底校验：判成结构图、但"节点"里大半是版面标注（分层标签、说明长句），
            // 说明这其实是版式信息图 —— 不画草图，走下面的描述回退。
            if (graph && annotationHeavy(graph)) {
                ctx.diagramAnnotationGuard += 1;
                ctx.diagramAsProse += 1;
                if (ctx.diagramStructured > 0) ctx.diagramStructured -= 1;
            } else if (graph) {
                let finalGraph = graph;
                // 漏读补问：模型自己报了 boxCount，却比 nodes 少，说明它承认漏了方框。
                // 只补问一次（成本可控），能补上就换成补问结果，补不上就用原来的。
                if (
                    Number.isInteger(graph.declaredBoxCount) &&
                    graph.declaredBoxCount > graph.nodes.length
                ) {
                    const declared = graph.declaredBoxCount;
                    ctx.diagramUnderRead += 1;
                    try {
                        const again = await vision.describeImage({
                            baseUrl: visionConfig.url,
                            apiKey: visionConfig.key,
                            model: visionConfig.model,
                            image: bytes,
                            mime,
                            prompt:
                                buildPrompt(ctx.docName, position, ctx.total, ctx.diagramMode, declared) +
                                `\n\n上一次只列出了 ${graph.nodes.length} 个方框，但图上有 ${declared} 个。` +
                                '这次请把**每一个**方框都列出来，一个都不要漏，尤其注意成组出现的小字方框。',
                            maxTokens: Math.max(DESC_MAX_TOKENS, DIAGRAM_MAX_TOKENS),
                            state: ctx.state,
                        });
                        if (again.rateLimited) ctx.rateLimited += again.rateLimited;
                        const redo = parseGraph(String(again.text || ''));
                        // 只有确实变得更多才采用，避免补问反而更差
                        if (redo && redo.nodes.length > graph.nodes.length) {
                            finalGraph = redo;
                            ctx.diagramUnderReadFixed += 1;
                        }
                    } catch {
                        // 补问失败不拖垮这张图
                    }
                }
                // 复核：同一个提示词换一个模型再读一遍，只保留两边都认可的连线。
                // 复核失败（限流/超时/没给出可用数据）不拖垮这张图，退回主模型结果。
                if (ctx.judgeModel && ctx.judgeModel !== visionConfig.model) {
                    ctx.diagramDual += 1;
                    try {
                        const second = await vision.describeImage({
                            baseUrl: visionConfig.url,
                            apiKey: visionConfig.key,
                            model: ctx.judgeModel,
                            image: bytes,
                            mime,
                            prompt: buildPrompt(ctx.docName, position, ctx.total, ctx.diagramMode),
                            maxTokens: Math.max(DESC_MAX_TOKENS, DIAGRAM_MAX_TOKENS),
                            state: ctx.state,
                        });
                        if (second.rateLimited) ctx.rateLimited += second.rateLimited;
                        const merged = subtractContradictions(graph, parseGraph(second.text || ''));
                        if (merged) {
                            finalGraph = merged;
                            ctx.diagramAgreed += 1;
                        } else {
                            ctx.diagramDualFallback += 1;
                        }
                    } catch {
                        ctx.diagramDualFallback += 1;
                    }
                }
                const fitted = fitGraph(finalGraph) || finalGraph;
                const puml = renderPuml(fitted);
                if (puml) {
                    ctx.diagramRendered += 1;
                    ctx.diagramNodes += fitted.nodes.length;
                    ctx.diagramEdges += fitted.edges.length;
                    // 裁剪和推断都记账：拿到图的人要能分清"原图就这些框"和"被砍过/接过"。
                    if (fitted.removedNodes) ctx.diagramTrimmed += fitted.removedNodes;
                    if (fitted.speculatedEdges) ctx.diagramSpeculated += fitted.speculatedEdges;
                    // 复核发现主模型漏认的节点：只告警不改图，由人判断。
                    if (finalGraph.missingFromPrimary) {
                        ctx.diagramMissingFromPrimary += finalGraph.missingFromPrimary;
                    }
                    // 节点名被截断（可能是部门名被改名），记原名供回溯。
                    if (Array.isArray(fitted.truncatedLabels) && fitted.truncatedLabels.length) {
                        ctx.diagramLabelsTruncated += fitted.truncatedLabels.length;
                        for (const item of fitted.truncatedLabels) {
                            if (ctx.diagramLabelSamples.length < 5) ctx.diagramLabelSamples.push(item);
                        }
                    }
                    return { ok: true, kind: 'diagram', puml, ms: out.ms };
                }
            }
            // 给了图数据却用不了（被 max_tokens 截断、节点太少、边悬空）→ 回退成散文：
            // 把 JSON 那段剔掉，剩下的文字才算描述；什么都不剩就诚实记失败，
            // 绝不把半截 JSON 当成描述写进注释。
            ctx.diagramFallback += 1;
            const cut = raw.indexOf('{');
            const stripped = (cut > 0 ? raw.slice(0, cut) : '')
                .replace(/```[a-zA-Z]*/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();
            if (stripped.length < 8) {
                // 结构数据不可用、又没剩下文字 → 再用"纯描述"提示词补一次。
                // 自主判断（草图 or 注释）必须闭环：每张图最终要么有草图、要么有注释。
                try {
                    const proseOut = await vision.describeImage({
                        baseUrl: visionConfig.url,
                        apiKey: visionConfig.key,
                        model: visionConfig.model,
                        image: bytes,
                        mime,
                        prompt: buildPrompt(ctx.docName, position, ctx.total, 'off'),
                        maxTokens: DESC_MAX_TOKENS,
                        state: ctx.state,
                    });
                    if (proseOut.rateLimited) ctx.rateLimited += proseOut.rateLimited;
                    ctx.diagramProseRetry += 1;
                    const proseText = String(proseOut.text || '').replace(/\s+/g, ' ').trim();
                    // 补的那次如果又给了图数据，说明它在两者间摇摆：不当描述用。
                    if (proseText && !/"nodes"\s*:/.test(proseText)) {
                        const text = sanitizeDesc(proseText, limit);
                        if (text) return { ok: true, kind: 'text', text, ms: out.ms };
                    }
                } catch {
                    // 补描述也失败 → 按失败处理
                }
                return { ok: false, error: 'DIAGRAM_INVALID', message: '结构数据不可用，且没有可用的文字描述' };
            }
            raw = stripped;
        }
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

/**
 * 把一张图的调用结果转成"要插入的内容"：结构图给 `{puml}`，散文给字符串。
 *
 * 两个分支走同一条注入路径，是为了让"注释在上、代码块随后、图片行不动"
 * 这个顺序只有一处实现。
 */
function toDescEntry(result) {
    return result && result.kind === 'diagram' ? { puml: result.puml } : result.text;
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
        // 现在会先剥掉旧注释再插新的，所以这不是"叠加"而是"替换"，只在结果里交代一句。
        warnings.push(`SOURCE_HAS_DESC：主 md 里已有 ${existing} 条 image-desc 注释，生成时会先剥掉这些旧注释再写入本次结果`);
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
        // 结构图：开关 + 三个计数（出了几张草图、几张回退成描述、画了多少节点/边）。
        diagramMode: visionConfig.diagram === 'off' ? 'off' : 'on',
        judgeModel: visionConfig.judgeModel || '',
        diagramDual: 0,
        diagramAgreed: 0,
        diagramDualFallback: 0,
        diagramProseRetry: 0,
        // 分类：判为"出结构"与"写描述"的张数，便于抽查判据是否合理
        diagramStructured: 0,
        diagramAsProse: 0,
        // 可疑复核：判成描述但回答里出现图数据的张数（只对这些补问一次）
        diagramSuspect: 0,
        // 兜底校验：判成结构图、但节点大半是版面标注，被退回描述的张数
        diagramAnnotationGuard: 0,
        diagramRendered: 0,
        diagramFallback: 0,
        diagramNodes: 0,
        diagramEdges: 0,
        // 被裁剪掉的节点总数：>0 说明草图和原图不一样，人工要回看原图
        diagramTrimmed: 0,
        // 推断出来的连线总数：>0 说明草图里有原图不存在的虚线关系
        diagramSpeculated: 0,
        // 复核发现主模型漏认的节点总数：>0 说明主模型少画了东西
        diagramMissingFromPrimary: 0,
        // 节点名被截断的总数，以及前几条样本（原文 → 截断后）
        diagramLabelsTruncated: 0,
        diagramLabelSamples: [],
        // 模型自报方框数 > 实际列出数 的张数，以及补问后确实补回来的张数
        diagramUnderRead: 0,
        diagramUnderReadFixed: 0,
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
        descByKey.set(first.key, toDescEntry(firstResult));
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
            if (result.ok) descByKey.set(ref.key, toDescEntry(result));
            else failed.push({ path: ref.key, error: result.error, message: result.message });
            return result;
        });
    }

    if (ctx.diagramFallback > 0) {
        warnings.push(`DIAGRAM_FALLBACK：${ctx.diagramFallback} 张图给了结构数据但用不了（截断/节点太少），已回退成描述注释`);
    }
    // 裁剪与推断必须显式告知：两者都让草图与原图不再等价，但图上不容易看出来。
    if (ctx.diagramTrimmed > 0) {
        warnings.push(
            `DIAGRAM_TRIMMED：草图为适配版面裁掉了 ${ctx.diagramTrimmed} 个节点（默认上限 ${DIAGRAM_MAX_NODES} 节点 / ${DIAGRAM_MAX_EDGES} 边、渲染 ${DIAGRAM_MAX_PUML_CHARS} 字符），原图比草图更全，请对照原图核对`,
        );
    }
    if (ctx.diagramSpeculated > 0) {
        warnings.push(
            `DIAGRAM_SPECULATED：草图里有 ${ctx.diagramSpeculated} 条虚线连线是推断出来的（图上编号等节点被丢弃后由前驱直接接后继），原图并无该关系`,
        );
    }
    // 主模型漏画节点：复核看见了、主模型没看见。缺节点是空白，比多一条线更难发现。
    if (ctx.diagramMissingFromPrimary > 0) {
        warnings.push(
            `DIAGRAM_MISSING：复核模型比主模型多认出 ${ctx.diagramMissingFromPrimary} 个节点，主模型的草图可能漏画，请对照原图确认`,
        );
    }
    // 模型自报方框数多于实际列出数：它自己承认漏了方框。
    if (ctx.diagramUnderRead > 0) {
        const fixed = ctx.diagramUnderReadFixed;
        warnings.push(
            `DIAGRAM_UNDER_READ：${ctx.diagramUnderRead} 张图里模型自报的方框数多于它列出的节点数` +
                (fixed > 0 ? `，补问后补回了 ${fixed} 张` : '，补问也没能补全') +
                '；请对照原图确认是否漏了部门',
        );
    }
    // 节点名被截断：可能是部门名被改名，必须把原名还回去。
    if (ctx.diagramLabelsTruncated > 0) {
        const samples = ctx.diagramLabelSamples
            .map((item) => `「${item.original}」→「${item.shorter}」`)
            .join('；');
        warnings.push(
            `DIAGRAM_LABEL_TRUNCATED：${ctx.diagramLabelsTruncated} 个节点名超过 ${DIAGRAM_MAX_LABEL_CHARS} 字符被截断，名字可能被改意，示例：${samples}`,
        );
    }
    if (ctx.diagramMode !== 'off' && ctx.diagramRendered === 0 && descByKey.size > 0) {
        warnings.push('DIAGRAM_NONE：本次没有一张图产出结构草图（模型都按描述回答了）');
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
        // 结构图：rendered 是出了草图的张数；fallback 是想出图但数据不可用、已回退成注释的张数。
        diagram: {
            mode: ctx.diagramMode,
            rendered: ctx.diagramRendered,
            fallback: ctx.diagramFallback,
            nodes: ctx.diagramNodes,
            edges: ctx.diagramEdges,
            // 裁剪掉的节点总数与推断出的连线总数：非 0 说明草图 ≠ 原图，需对照原图
            trimmed: ctx.diagramTrimmed,
            speculated: ctx.diagramSpeculated,
            // 复核看见、主模型漏认的节点数：非 0 说明草图可能少画
            missing_from_primary: ctx.diagramMissingFromPrimary,
            // 被截断的节点名数量（原名见 warnings 里的 DIAGRAM_LABEL_TRUNCATED）
            labels_truncated: ctx.diagramLabelsTruncated,
            // 模型自报方框数比实际列出的多（它承认漏了）的张数，以及补问补回来的张数
            under_read: ctx.diagramUnderRead,
            under_read_fixed: ctx.diagramUnderReadFixed,
            // 复核：dual 是做了二次读图的张数，agreed 是交集可用的张数（其余退回主模型）。
            judge_model: ctx.judgeModel || null,
            dual: ctx.diagramDual,
            agreed: ctx.diagramAgreed,
            dual_fallback: ctx.diagramDualFallback,
            // 结构数据不可用、补了一次纯描述才拿到注释的张数
            prose_retry: ctx.diagramProseRetry,
            // 分类计数：structured 判为"出结构"，as_prose 判为"写描述"，suspect 补问过一次的张数
            structured: ctx.diagramStructured,
            as_prose: ctx.diagramAsProse,
            suspect: ctx.diagramSuspect,
            // 判成结构图、但节点大半是版面标注，被兜底退回描述的张数
            annotation_guard: ctx.diagramAnnotationGuard,
        },
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
            diagram: args.diagram,
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
    isAnnotationLabel,
    annotationHeavy,
    normalizeEol,
    resolveImageUrl,
    extractJsonObject,
    parseGraph,
    subtractContradictions,
    renderPuml,
    fitGraph,
    shrinkGraph,
    mergeRedundantNodes,
    truncateLabel,
    buildPrompt,
    buildKindPrompt,
    parseKind,
    DESC_MAX_CHARS,
    DIAGRAM_MAX_NODES,
    DIAGRAM_MAX_EDGES,
    DIAGRAM_MAX_LABEL_CHARS,
    DIAGRAM_MAX_PUML_CHARS,
    DIAGRAM_MAX_TOKENS,
    DEFAULT_DIAGRAM_MODE,
    SENTINEL,
    DEFAULT_CONCURRENCY,
    MAX_CONCURRENCY,
    PREFERRED_VISION_MODELS: DEFAULT_VISION_CANDIDATES,
    DEFAULT_VISION_CANDIDATES,
    normalizeCandidates,
    resolveVisionConfig,
};
