#!/usr/bin/env node
/**
 * 视觉模型客户端：OpenAI 兼容的 `chat/completions`（内网网关实测可用）。
 *
 * 为什么需要单独一层：
 *   1. 网关对同一个 key 有并发/QPS 上限，压力高时返回 429。实测并发 12 起就出现 429，
 *      所以退避重试是常规路径，不是异常处理；
 *   2. qwen3-vl-plus 在部分图片上会进入内部思考，单张从 5 秒涨到 66 秒。实测显式带
 *      `enable_thinking: false` 后 12 张的总耗时从 68.6 秒降到 10.0 秒，所以默认关掉；
 *      但网关只是"忽略未知参数"，换个部署未必如此 —— 400 且响应里提到该参数时，去掉它重试；
 *   3. 401/403/404 是"这把 key 用不了这个模型"，重试没有意义，必须让调用方换模型，
 *      所以单独映射成 MODEL_UNAVAILABLE，而不是笼统的 SERVER_ERROR。
 *
 * 两个入口共用同一套重试/限流逻辑：
 *   - describeImage：图 + 提示词 → 描述（一次多模态调用）
 *   - completeText：纯文本续写 → 用于把超长描述"压缩"到上限内，而不是硬砍（不传图，便宜）
 *
 * 配置沿用包内共享链（与其它 skill 一致）：调用参数 > 环境变量 > scripts/config.json
 * > ~/.dsh/storages/docchain-config.json > 包内 skills/docchain_config.json > 默认值。
 */
'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');

/** 单次请求超时：实测偶发 66 秒的慢请求，150 秒能容下它而不会被误判超时。 */
const DEFAULT_TIMEOUT = 150000;
/** 429 最多重试几次（不含首次）。 */
const MAX_RETRIES_RATE_LIMIT = 2;
/** 5xx / 网络错误最多重试几次。 */
const MAX_RETRIES_TRANSIENT = 1;
/** 退避基准毫秒，实际间隔 = base * 2^n + 抖动。 */
const RETRY_BASE_MS = 900;

/** 默认模型与兜底模型由调用方注入，这里只留安全默认值。 */
const DEFAULT_MODEL = 'qwen3-vl-plus';
const DEFAULT_FALLBACK_MODEL = 'g-deepseek-v4-flash';

/** 视觉侧的业务失败，与脚本层的 DocchainError 共用同一套错误码词汇。 */
class VisionError extends Error {
    constructor(code, message, extra) {
        super(message);
        this.name = 'VisionError';
        this.code = code;
        if (extra) Object.assign(this, extra);
    }
}

/** 请求上下文：把 signal 变成真正的取消，同时保留状态码与响应头给上层判断。 */
function request(urlString, options) {
    const opts = options || {};
    return new Promise((resolve, reject) => {
        let target;
        try {
            target = new URL(urlString);
        } catch {
            reject(new VisionError('CONFIG', `视觉模型地址无效：${urlString}`));
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
                timeout: opts.timeout || DEFAULT_TIMEOUT,
            },
            (res) => {
                const chunks = [];
                res.on('data', (chunk) => chunks.push(chunk));
                res.on('end', () => {
                    resolve({
                        status: res.statusCode,
                        headers: res.headers,
                        text: Buffer.concat(chunks).toString('utf8'),
                    });
                });
            },
        );
        req.on('timeout', () => {
            req.destroy();
            reject(new VisionError('MODEL_ERROR', '视觉模型请求超时'));
        });
        req.on('error', (error) => reject(new VisionError('MODEL_ERROR', `视觉模型网络错误：${error.message}`)));
        if (opts.signal) {
            if (opts.signal.aborted) {
                req.destroy();
                reject(new VisionError('ABORTED', '调用已取消'));
                return;
            }
            opts.signal.addEventListener('abort', () => req.destroy(), { once: true });
        }
        if (payload !== null) req.write(payload);
        req.end();
    });
}

/** 退避等待；`ms` 已含抖动。 */
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 重试间隔：指数退避 + 抖动，避免同一批请求一起重试把网关再打满。 */
function backoffMs(attempt) {
    const base = RETRY_BASE_MS * Math.pow(2, attempt);
    return base + Math.floor(Math.random() * RETRY_BASE_MS);
}

/** 从 429 的 Retry-After 里读一个合理等待，读不到就用退避。 */
function retryAfterMs(res, attempt) {
    const raw = res && res.headers && res.headers['retry-after'];
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds > 0 && seconds <= 60) return seconds * 1000;
    return backoffMs(attempt);
}

/** 把一段上游错误文本压成一行、截断，便于塞进 message。 */
function oneLine(text, limit) {
    return String(text || '').replace(/\s+/g, ' ').trim().slice(0, limit || 200);
}

/**
 * 取模型正文与结束原因。
 *
 * `finish_reason === 'length'` 表示撞上了 max_tokens —— 这时内容是被**硬截**的，
 * 可能停在半句话上，而且长度碰巧没超过字数上限，光看长度根本发现不了。
 * 调用方据此把这条算作"不完整"，而不是当成正常结果。
 */
function extractText(json) {
    const choice = json && Array.isArray(json.choices) ? json.choices[0] : null;
    const message = choice && choice.message ? choice.message : null;
    const finishReason = choice && typeof choice.finish_reason === 'string' ? choice.finish_reason : '';
    const text = message && typeof message.content === 'string' ? message.content : '';
    return { text, finishReason };
}

/** 深拷贝一份 body 但去掉 `enable_thinking`（只在 400 兜底路径用）。 */
function stripThinkingFlag(body) {
    const copy = Object.assign({}, body);
    delete copy.enable_thinking;
    return copy;
}

/**
 * 一次 chat/completions 调用（含 429 退避、5xx 重试、鉴权失败归类）。
 *
 * @param {object} options
 * @param {string} options.baseUrl  网关根地址，如 https://host/gpt-proxy/v1
 * @param {string} options.apiKey   Bearer key
 * @param {string} options.model    模型 id
 * @param {Array} options.messages  OpenAI 格式消息
 * @param {number} [options.maxTokens]
 * @param {number} [options.timeout]
 * @param {AbortSignal} [options.signal]
 * @param {object} [options.state]  跨请求共享的运行状态（记录是否还带 enable_thinking）
 * @returns {Promise<{text: string, ms: number, usage?: object, rateLimited?: number}>}
 */
async function callChat(options) {
    const state = options.state || {};
    const baseUrl = String(options.baseUrl || '').replace(/\/+$/, '');
    if (!baseUrl) throw new VisionError('CONFIG', '视觉模型地址未配置');
    if (!options.apiKey) {
        throw new VisionError(
            'CONFIG',
            '视觉模型 Key 未配置：请在凭据库中写入 IWHALE_API_KEY，或设置环境变量 VISION_API_KEY。',
        );
    }
    if (!options.model) throw new VisionError('CONFIG', '视觉模型未指定');

    const body = {
        model: options.model,
        messages: options.messages,
        max_tokens: options.maxTokens || 1200,
        temperature: 0,
    };
    // 默认关闭思考：实测能消掉 66 秒级别的单张长尾（详见文件头注释）。
    const withThinkingFlag = state.enableThinking !== true;
    if (withThinkingFlag) body.enable_thinking = false;

    const url = `${baseUrl}/chat/completions`;
    const startedAt = Date.now();
    let rateLimited = 0;
    let transient = 0;
    let attempt = 0;
    let sendFlag = withThinkingFlag;

    for (;;) {
        const payload = JSON.stringify(sendFlag ? body : stripThinkingFlag(body));
        const res = await request(url, {
            method: 'POST',
            headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json' },
            body: payload,
            timeout: options.timeout || DEFAULT_TIMEOUT,
            signal: options.signal,
        }).catch((error) => {
            if (error.code === 'ABORTED') throw error;
            return { status: 0, text: error.message, headers: {} };
        });

        if (res.status === 200) {
            let json;
            try {
                json = JSON.parse(res.text);
            } catch {
                throw new VisionError('MODEL_ERROR', `视觉模型返回的不是 JSON：${oneLine(res.text)}`);
            }
            const extracted = extractText(json);
            const usage = json && json.usage ? json.usage : null;
            const out = {
                text: extracted.text,
                finishReason: extracted.finishReason,
                ms: Date.now() - startedAt,
                usage,
            };
            if (rateLimited > 0) out.rateLimited = rateLimited;
            if (state.enableThinking === undefined) state.enableThinking = sendFlag;
            return out;
        }

        // 网关忽略未知参数是实测行为，但换个部署可能直接 400；这时去掉开关重试一次。
        if (res.status === 400 && sendFlag && /enable_thinking/i.test(res.text || '')) {
            sendFlag = false;
            state.enableThinking = false;
            continue;
        }

        if (res.status === 429) {
            if (rateLimited >= MAX_RETRIES_RATE_LIMIT) {
                throw new VisionError('RATE_LIMITED', `视觉模型限流（429），已重试 ${rateLimited} 次仍被拒`, {
                    status: 429,
                });
            }
            await sleep(retryAfterMs(res, rateLimited));
            rateLimited += 1;
            continue;
        }

        if (res.status === 401 || res.status === 403 || res.status === 404 || res.status === 400) {
            throw new VisionError(
                'MODEL_UNAVAILABLE',
                `视觉模型不可用（HTTP ${res.status}）：${oneLine(res.text)}。该模型可能未对你的账号开放，可用 list_models 查看可用视觉模型。`,
                { status: res.status },
            );
        }

        if (res.status >= 500 || res.status === 0) {
            if (transient >= MAX_RETRIES_TRANSIENT) {
                throw new VisionError('MODEL_ERROR', `视觉模型请求失败（${res.status || '网络错误'}）：${oneLine(res.text)}`, {
                    status: res.status,
                });
            }
            await sleep(backoffMs(transient));
            transient += 1;
            continue;
        }

        attempt += 1;
        if (attempt > 2) {
            throw new VisionError('MODEL_ERROR', `视觉模型返回 HTTP ${res.status}：${oneLine(res.text)}`, {
                status: res.status,
            });
        }
        await sleep(backoffMs(attempt));
    }
}

/**
 * 一张图 → 一段描述。
 *
 * @param {object} options - callChat 的全部参数，外加：
 * @param {Buffer} options.image    图片字节
 * @param {string} options.mime     图片 MIME
 * @param {string} options.prompt   提示词
 * @returns {Promise<{text: string, ms: number, usage?: object}>}
 */
async function describeImage(options) {
    if (!options.image || !options.image.length) throw new VisionError('MODEL_ERROR', '图片字节为空');
    const mime = options.mime || 'image/jpeg';
    return callChat(
        Object.assign({}, options, {
            messages: [
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: options.prompt || '请用中文客观描述这张图片的内容。' },
                        {
                            type: 'image_url',
                            image_url: { url: `data:${mime};base64,${options.image.toString('base64')}` },
                        },
                    ],
                },
            ],
        }),
    );
}

/**
 * 纯文本续写（不传图）。
 *
 * 用途：描述超过长度上限时，让模型把内容压缩到上限内，而不是按句末硬砍 ——
 * 硬砍会丢掉列表后半段、编号最后几项这类信息。压缩只在超长的少数几张上发生，
 * 且不带图片，成本约等于一次短问答。
 *
 * @param {object} options - callChat 的全部参数，外加 `prompt`
 * @returns {Promise<{text: string, ms: number, usage?: object}>}
 */
async function completeText(options) {
    if (!options.prompt) throw new VisionError('CONFIG', '缺少 prompt');
    return callChat(
        Object.assign({}, options, {
            messages: [{ role: 'user', content: [{ type: 'text', text: options.prompt }] }],
        }),
    );
}

/**
 * 列出当前 key 可用的视觉模型。
 *
 * 网关的 `/v1/models` 会给出 178 个模型（含 33 个 qwen 系），但只有
 * `is_vision === 1` 的能读图。用户换模型前先看这个清单，比猜名字靠谱。
 *
 * @param {{baseUrl: string, apiKey: string, timeout?: number, signal?: AbortSignal}} options
 * @returns {Promise<Array<{id: string, desc: string, owned_by: string}>>}
 */
async function listVisionModels(options) {
    const baseUrl = String(options.baseUrl || '').replace(/\/+$/, '');
    if (!baseUrl) throw new VisionError('CONFIG', '视觉模型地址未配置');
    if (!options.apiKey) {
        throw new VisionError(
            'CONFIG',
            '视觉模型 Key 未配置：请在凭据库中写入 IWHALE_API_KEY，或设置环境变量 VISION_API_KEY。',
        );
    }
    const res = await request(`${baseUrl}/models`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${options.apiKey}` },
        timeout: options.timeout || 30000,
        signal: options.signal,
    }).catch((error) => {
        if (error.code === 'ABORTED') throw error;
        throw new VisionError('MODEL_ERROR', `拉取模型清单失败：${error.message}`);
    });
    if (res.status !== 200) {
        throw new VisionError('MODEL_UNAVAILABLE', `拉取模型清单失败（HTTP ${res.status}）：${oneLine(res.text)}`, {
            status: res.status,
        });
    }
    let json;
    try {
        json = JSON.parse(res.text);
    } catch {
        throw new VisionError('MODEL_ERROR', '模型清单返回的不是 JSON');
    }
    const rows = json && Array.isArray(json.data) ? json.data : [];
    return rows
        .filter((row) => row && row.is_vision === 1)
        .map((row) => ({
            id: String(row.id || ''),
            desc: oneLine(row.model_desc || row.display_name || '', 120),
            owned_by: String(row.owned_by || ''),
            free: row.is_free === 1,
        }))
        .filter((row) => row.id);
}

module.exports = {
    describeImage,
    completeText,
    listVisionModels,
    VisionError,
    DEFAULT_MODEL,
    DEFAULT_FALLBACK_MODEL,
    DEFAULT_TIMEOUT,
};
