#!/usr/bin/env node
/**
 * doc2markdown
 * Convert multiple file formats to Markdown
 * Default output directory is the same directory as the source file
 *
 * dsh-docchain integration: the service URL and the optional API key resolve
 * through the package's shared config chain (env vars > skill scripts/
 * config.json > plugin state file ~/.dsh/storages/docchain-config.json >
 * package skills/docchain_config.json), see resolveBaseUrl / resolveApiKey.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const { URL } = require('url');

const POLL_INTERVAL = 3;   // Polling interval (seconds)
const POLL_TIMEOUT = 60;   // Auto-polling timeout limit (seconds)

const DEFAULT_BASE_URL = 'https://lab.hjcloud.com/llmdoc';

const URL_ENV = 'DOCCHAIN_URL';
const URL_FIELD = 'docchain_url';

const API_KEY_ENV = 'DOCCHAIN_SKILLS_API_KEY';
const API_KEY_ENV_COMPAT = 'DOCCHAIN_API_KEY';
const API_KEY_FIELD = 'docchain_api_key';

/**
 * Check whether a value is a plain object usable as a config source.
 * Rejects null, arrays and every non-object primitive.
 * @param {any} value
 * @returns {boolean}
 */
function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Normalize a raw config value into a usable API key.
 * Non-strings and blank strings are treated as "not configured".
 * A leading `Bearer ` is stripped: the header built from this key adds that scheme itself,
 * and the server only strips one level before looking the key up.
 * @param {any} value
 * @returns {string|null}
 */
function normalizeApiKey(value) {
    if (typeof value !== 'string') {
        return null;
    }
    const trimmed = value.trim().replace(/^Bearer\s+/i, '');
    return trimmed === '' ? null : trimmed;
}

/**
 * Normalize a raw config value into a usable service URL.
 * Only http(s) URLs participate; everything else is treated as unset.
 * @param {any} value
 * @returns {string|null}
 */
function normalizeUrl(value) {
    if (typeof value !== 'string') {
        return null;
    }
    const trimmed = value.trim();
    return /^https?:\/\//i.test(trimmed) ? trimmed : null;
}

/**
 * Resolve the API key from already-parsed config sources.
 *
 * Precedence (higher wins):
 *   non-blank env var (DOCCHAIN_SKILLS_API_KEY, then DOCCHAIN_API_KEY)
 *   > skill scripts/config.json
 *   > plugin state file (~/.dsh/storages/docchain-config.json)
 *   > package skills/docchain_config.json
 *
 * The key is optional: null means anonymous upload.
 *
 * Pure function: no filesystem access, no logging, never throws.
 *
 * @param {{env?: object, skillConfig?: object, stateConfig?: object, packageConfig?: object}} sources
 * @returns {string|null} The API key, or null when unconfigured
 */
function resolveApiKey(sources = {}) {
    const { env, skillConfig, stateConfig, packageConfig } = isPlainObject(sources) ? sources : {};

    // Highest priority: environment variables (blank values do not participate)
    if (isPlainObject(env)) {
        const envKey = normalizeApiKey(env[API_KEY_ENV]) ?? normalizeApiKey(env[API_KEY_ENV_COMPAT]);
        if (envKey !== null) {
            return envKey;
        }
    }

    for (const cfg of [skillConfig, stateConfig, packageConfig]) {
        const key = normalizeApiKey(isPlainObject(cfg) ? cfg[API_KEY_FIELD] : null);
        if (key !== null) {
            return key;
        }
    }
    return null;
}

/**
 * Resolve the service base URL from already-parsed config sources.
 *
 * Precedence (higher wins):
 *   non-blank env var (DOCCHAIN_URL)
 *   > skill scripts/config.json
 *   > plugin state file (~/.dsh/storages/docchain-config.json)
 *   > package skills/docchain_config.json
 *   > built-in default (https://lab.hjcloud.com/llmdoc)
 *
 * Pure function: no filesystem access, no logging, never throws.
 *
 * @param {{env?: object, skillConfig?: object, stateConfig?: object, packageConfig?: object}} sources
 * @returns {string} The service base URL
 */
function resolveBaseUrl(sources = {}) {
    const { env, skillConfig, stateConfig, packageConfig } = isPlainObject(sources) ? sources : {};

    const candidates = [];
    if (isPlainObject(env)) {
        candidates.push(env[URL_ENV]);
    }
    for (const cfg of [skillConfig, stateConfig, packageConfig]) {
        candidates.push(isPlainObject(cfg) ? cfg[URL_FIELD] : undefined);
    }

    for (const raw of candidates) {
        const url = normalizeUrl(raw);
        if (url !== null) {
            return url;
        }
    }
    return DEFAULT_BASE_URL;
}

/**
 * Read and parse a JSON config file.
 * A missing file is silent; unreadable/invalid files warn on stderr and are skipped.
 * The API key is optional, so this never throws and never exits.
 * @param {string} configPath
 * @returns {object|null}
 */
function readConfigFile(configPath) {
    if (!fs.existsSync(configPath)) {
        return null;   // Absent config source: stay silent
    }

    let raw;
    try {
        raw = fs.readFileSync(configPath, 'utf8');
    } catch (error) {
        console.error(`警告：无法读取配置文件，已忽略：${configPath}`);
        return null;
    }

    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        console.error(`警告：配置文件不是合法 JSON，已忽略：${configPath}`);
        return null;
    }

    if (!isPlainObject(parsed)) {
        console.error(`警告：配置文件不是 JSON 对象，已忽略：${configPath}`);
        return null;
    }

    return parsed;
}

/**
 * Read the JSON config chain once: skill-level, plugin state file, package-level.
 * Missing/invalid files degrade to null entries silently.
 * @returns {{skillConfig: object|null, stateConfig: object|null, packageConfig: object|null}}
 */
function loadConfigSources() {
    return {
        skillConfig: readConfigFile(path.join(__dirname, 'config.json')),
        stateConfig: readConfigFile(path.join(os.homedir(), '.dsh', 'storages', 'docchain-config.json')),
        packageConfig: readConfigFile(path.join(__dirname, '..', '..', 'docchain_config.json')),
    };
}

/**
 * Load the API key from the environment and the config chain.
 * Returns null when no key is configured — doc2markdown then uploads anonymously.
 * @returns {string|null}
 */
function loadApiKey() {
    return resolveApiKey({ env: process.env, ...loadConfigSources() });
}

/**
 * Load the service base URL from the environment and the config chain.
 * @returns {string}
 */
function loadBaseUrl() {
    return resolveBaseUrl({ env: process.env, ...loadConfigSources() });
}

class Doc2Markdown {
    constructor() {
        this.BASE_URL = loadBaseUrl();
        // Optional API key; null means anonymous upload
        this.apiKey = loadApiKey();
    }

    /**
     * Build auth headers for API requests. The server may require an access
     * token on every endpoint (convert / check / download); without a
     * configured API key, requests stay anonymous.
     * @returns {object}
     */
    authHeaders() {
        if (!this.apiKey) {
            return {};
        }
        return {
            'X-Api-Key': this.apiKey,
            // The convert endpoint resolves priority only from Authorization: Bearer <api_key>
            'Authorization': `Bearer ${this.apiKey}`
        };
    }

    /**
     * Send HTTP request
     * @param {string} url
     * @param {object} options
     * @returns {Promise<{status: number, data: any}>}
     */
    async request(url, options = {}) {
        return new Promise((resolve, reject) => {
            const urlObj = new URL(url);
            const isHttps = urlObj.protocol === 'https:';
            const httpModule = isHttps ? https : http;

            const reqOptions = {
                hostname: urlObj.hostname,
                port: urlObj.port || (isHttps ? 443 : 80),
                path: urlObj.pathname + urlObj.search,
                method: options.method || 'GET',
                headers: options.headers || {},
                timeout: options.timeout || 30000
            };

            const req = httpModule.request(reqOptions, (res) => {
                const chunks = [];

                res.on('data', (chunk) => {
                    chunks.push(chunk);
                });

                res.on('end', () => {
                    const buffer = Buffer.concat(chunks);
                    let data;

                    if (options.responseType === 'arraybuffer') {
                        data = buffer;
                    } else {
                        const text = buffer.toString('utf8');
                        try {
                            data = JSON.parse(text);
                        } catch (e) {
                            data = text;
                        }
                    }

                    resolve({
                        status: res.statusCode,
                        data: data
                    });
                });
            });

            req.on('error', (error) => {
                reject(error);
            });

            req.on('timeout', () => {
                req.destroy();
                reject(new Error('Request timeout'));
            });

            if (options.body) {
                req.write(options.body);
            }

            req.end();
        });
    }

    /**
     * Generate multipart/form-data format request body
     * @param {string} filePath
     * @param {string} filename
     * @returns {{body: Buffer, boundary: string}}
     */
    createMultipartFormData(filePath, filename) {
        const boundary = '----WebKitFormBoundary' + Math.random().toString(36).substring(2);
        const fileContent = fs.readFileSync(filePath);

        const parts = [];

        // Add file field
        parts.push(
            `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
            `Content-Type: application/octet-stream\r\n\r\n`
        );

        parts.push(fileContent);
        parts.push(`\r\n--${boundary}--\r\n`);

        // Merge all parts
        const buffers = parts.map(part =>
            Buffer.isBuffer(part) ? part : Buffer.from(part, 'utf8')
        );

        const body = Buffer.concat(buffers);

        return { body, boundary };
    }

    /**
     * Upload file to docchain service, return document reference ID
     * @param {string} filePath
     * @returns {Promise<string|null>}
     */
    async uploadFile(filePath) {
        if (!fs.existsSync(filePath)) {
            console.log(`错误：文件不存在 - ${filePath}`);
            return null;
        }

        try {
            let asciiFilename = path.basename(filePath);
            if (!asciiFilename) {
                asciiFilename = 'document.docx';
            }

            const { body, boundary } = this.createMultipartFormData(filePath, asciiFilename);

            // Everything the convert request sends is built here: url, headers, body.
            // The server reads priority from the query string, not from the multipart body.
            // priority rides along with a configured API Key, never otherwise
            const url = `${this.BASE_URL}/v1/skills/doc2markdown/convert${this.apiKey ? '?priority=1' : ''}`;

            const headers = {
                'Content-Type': `multipart/form-data; boundary=${boundary}`,
                'Content-Length': body.length,
                ...this.authHeaders()
            };

            const response = await this.request(url, {
                method: 'POST',
                headers: headers,
                body: body,
                timeout: 30000
            });

            if (response.status === 200) {
                const responseJson = response.data;
                if (!responseJson.success && responseJson.success !== undefined) {
                    console.log(`API 请求失败：${responseJson.err}`);
                    return null;
                }
                const docId = responseJson.doc_id;
                if (docId) {
                    return docId;
                } else {
                    console.log(`上传成功但未获取到文档引用 ID`);
                    return null;
                }
            } else {
                console.log(`上传失败，状态码：${response.status}`);
                console.log(`错误信息：${JSON.stringify(response.data)}`);
                return null;
            }

        } catch (error) {
            console.log(`上传文件时发生错误：${error.message}`);
            return null;
        }
    }

    /**
     * Check document processing status
     * @param {string} docId
     * @returns {Promise<{status: 'done'|'failed'|'converting', error: string}|null>}
     */
    async checkStatus(docId) {
        try {
            const url = `${this.BASE_URL}/v1/skills/doc2markdown/check?doc_id=${encodeURIComponent(docId)}`;

            const response = await this.request(url, {
                method: 'GET',
                headers: this.authHeaders(),
                timeout: 30000
            });

            if (response.status === 200) {
                const data = response.data;
                if (!data.success && data.success !== undefined) {
                    console.log(`状态查询失败：${data.err}`);
                    return null;
                }
                const statusDetail = data.status_detail || {};
                const convertStatus = (statusDetail.convert_md || {}).state;
                if (convertStatus === '1') {
                    return { status: 'done', error: '' };
                } else if (convertStatus === '3') {
                    return { status: 'failed', error: statusDetail.error || '' };
                }
                return { status: 'converting', error: '' };
            } else {
                console.log(`状态查询失败，状态码：${response.status}，错误信息：${JSON.stringify(response.data)}`);
                return null;
            }

        } catch (error) {
            console.log(`查询状态时发生错误：${error.message}`);
            return null;
        }
    }

    /**
     * Get converted markdown content (zip package bytes)
     * @param {string} docId
     * @returns {Promise<Buffer|null>}
     */
    async getMarkdown(docId) {
        try {
            const url = `${this.BASE_URL}/v1/skills/doc2markdown/download?doc_id=${encodeURIComponent(docId)}`;

            const response = await this.request(url, {
                method: 'GET',
                headers: this.authHeaders(),
                timeout: 30000,
                responseType: 'arraybuffer'
            });

            if (response.status === 200) {
                return response.data;
            } else {
                console.log(`获取内容失败，状态码：${response.status}`);
                return null;
            }

        } catch (error) {
            console.log(`获取内容时发生错误：${error.message}`);
            return null;
        }
    }

    /**
     * Get converted markdown content as single MD file (not zip)
     * @param {string} docId
     * @returns {Promise<Buffer|null>}
     */
    async getMarkdownFile(docId) {
        try {
            const url = `${this.BASE_URL}/v1/skills/doc2markdown/light/download?doc_id=${encodeURIComponent(docId)}`;

            const response = await this.request(url, {
                method: 'GET',
                headers: this.authHeaders(),
                timeout: 30000,
                responseType: 'arraybuffer'
            });

            if (response.status === 200) {
                return response.data;
            } else {
                console.log(`获取内容失败，状态码：${response.status}`);
                return null;
            }

        } catch (error) {
            console.log(`获取内容时发生错误：${error.message}`);
            return null;
        }
    }

    /**
     * Save markdown as single file to source file directory (same level as source)
     * @param {Buffer} markdownBytes  Markdown file content
     * @param {string} filePath       Original source file path
     * @returns {Promise<string|null>} Saved markdown file path
     */
    async saveMarkdownFile(markdownBytes, filePath) {
        try {
            const parentDir = path.dirname(path.resolve(filePath));
            const baseName = path.parse(filePath).name;
            const outputFileName = `${baseName}.md`;
            const outPath = path.join(parentDir, outputFileName);

            fs.writeFileSync(outPath, markdownBytes);
            return outPath;

        } catch (error) {
            console.log(`保存文件时发生错误：${error.message}`);
            return null;
        }
    }

    /**
     * Poll until conversion is complete (up to POLL_TIMEOUT seconds)
     * @param {string} docId
     * @param {string|null} filePath
     * @param {boolean} mdOnly - if true, download as single MD file instead of ZIP
     * @returns {Promise<[boolean, string]|[null, null]>}
     */
    async pollUntilDone(docId, filePath = null, mdOnly = false) {
        let elapsed = 0;
        while (elapsed < POLL_TIMEOUT) {
            const result = await this.checkStatus(docId);
            if (result === null) {
                console.log("错误：无法获取文档状态，请稍后重试");
                failJson('SERVER_ERROR', '无法获取文档状态，请稍后重试');
            }
            if (result.status === 'done') {
                console.log(`  转换完成，正在下载...`);
                if (mdOnly) {
                    const markdownBytes = await this.getMarkdownFile(docId);
                    if (!markdownBytes) {
                        return [false, "获取 Markdown 内容失败"];
                    }
                    const hint = filePath || `${docId}.md`;
                    const outFilePath = await this.saveMarkdownFile(markdownBytes, hint);
                    if (!outFilePath) {
                        return [false, "保存文件失败"];
                    }
                    return [true, outFilePath];
                } else {
                    const zipBytes = await this.getMarkdown(docId);
                    if (!zipBytes) {
                        return [false, "获取 Markdown 内容失败"];
                    }
                    const hint = filePath || `doc_${docId}.md`;
                    const outDir = await this.saveMarkdown(zipBytes, docId, hint);
                    if (!outDir) {
                        return [false, "保存文件失败"];
                    }
                    return [true, outDir];
                }
            } else if (result.status === 'failed') {
                const reason = result.error ? `：${result.error}` : '';
                return [false, `文档转换失败${reason}`];
            } else {
                console.log(`  转换中... 已等待 ${elapsed}s。`);
                await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL * 1000));
                elapsed += POLL_INTERVAL;
            }
        }

        return [null, null];
    }

    /**
     * Upload file and auto-poll for conversion, return doc_id if timeout
     * @param {string} filePath
     * @param {boolean} mdOnly - if true, download as single MD file instead of ZIP
     */
    async convertFile(filePath, mdOnly = false) {
        // 1. Upload file
        console.log(`[1/3] 正在上传文件：${filePath}`);
        const docId = await this.uploadFile(filePath);
        if (!docId) {
            console.log(`文件上传失败！`);
            failJson('SERVER_ERROR', `文件上传失败：${filePath}`);
        }
        console.log(`  上传成功，文档 ID：${docId}`);

        // 2. Poll and wait (up to 60 seconds)
        console.log(`[2/3] 等待转换完成（自动轮询）...`);
        const [result, detail] = await this.pollUntilDone(docId, filePath, mdOnly);

        if (result === true) {
            console.log(`[3/3] 下载完成，文件已保存：${detail}`);
        } else if (result === false) {
            console.log(`错误：${detail}`);
            failJson('SERVER_ERROR', `转换失败：${detail}`);
        } else {
            console.log(`  文档 ID：${docId}`);
            console.log(`[!] 文档仍在转换中（已超过 ${POLL_TIMEOUT}s）`);
            if (mdOnly) {
                console.log(`[!] 转换完成后，可执行：node scripts/doc2markdown.js check ${docId} "${filePath}" --md`);
            } else {
                console.log(`[!] 大文档通常需要更长时间；高峰时段转换可能排队，请耐心等待`);
                console.log(`[!] 是否继续查询转换状态并下载`);
            }
            process.exit(2);
        }
    }

    /**
     * Extract zip to source file directory, returns output directory path
     * @param {Buffer} zipBytes
     * @param {string} docId
     * @param {string} filePath
     * @returns {Promise<string|null>}
     */
    async saveMarkdown(zipBytes, docId, filePath) {
        try {
            const parentDir = path.dirname(path.resolve(filePath));
            const [fileId] = docId.split('-');
            const markdownDirName = `${fileId}_` + path.parse(filePath).name;
            const outDir = path.join(parentDir, markdownDirName);

            if (!fs.existsSync(outDir)) {
                fs.mkdirSync(outDir, { recursive: true });
            }

            const zlib = require('zlib');
            const { pipeline } = require('stream/promises');

            // Save zip temporarily
            const tempZip = path.join(outDir, `temp_${Date.now()}.zip`);
            fs.writeFileSync(tempZip, zipBytes);

            // Parse ZIP central directory natively
            const buffer = fs.readFileSync(tempZip);
            let pos = buffer.length - 22;
            while (pos > 0) {
                if (
                    buffer.readUInt32LE(pos) === 0x06054b50 &&
                    pos + 22 <= buffer.length
                )
                    break;
                pos--;
            }

            const entries = [];
            const diskEntries = buffer.readUInt16LE(pos + 8);
            const dirStart = buffer.readUInt32LE(pos + 16);
            pos = dirStart;

            for (let i = 0; i < diskEntries; i++) {
                if (buffer.readUInt32LE(pos) !== 0x02014b50) break;
                const flags = buffer.readUInt16LE(pos + 8);
                const method = buffer.readUInt16LE(pos + 10);
                const nameLen = buffer.readUInt16LE(pos + 28);
                const extraLen = buffer.readUInt16LE(pos + 30);
                const commentLen = buffer.readUInt16LE(pos + 32);
                const offset = buffer.readUInt32LE(pos + 42);
                const name = buffer.toString('utf8', pos + 46, pos + 46 + nameLen);
                entries.push({ offset, method, name, encrypted: !!(flags & 1) });
                pos += 46 + nameLen + extraLen + commentLen;
            }

            // Extract each file
            for (const ent of entries) {
                if (ent.encrypted || ent.name.endsWith('/')) continue;
                const o = ent.offset;
                const sig = buffer.readUInt32LE(o);
                if (sig !== 0x04034b50) continue;
                const nameLen = buffer.readUInt16LE(o + 26);
                const extraLen = buffer.readUInt16LE(o + 28);
                const csize = buffer.readUInt32LE(o + 18);
                const usize = buffer.readUInt32LE(o + 14);
                const dataStart = o + 30 + nameLen + extraLen;
                const data = buffer.slice(dataStart, dataStart + csize);

                const outPath = path.join(outDir, ent.name.replace(/\\/g, '/'));
                const safeOutDir = path.resolve(outDir) + path.sep;
                if (!path.resolve(outPath).startsWith(safeOutDir)) {
                    throw new Error(`ZIP 条目路径不安全（路径穿越）：${ent.name}`);
                }
                const outDirPath = path.dirname(outPath);
                if (!fs.existsSync(outDirPath)) fs.mkdirSync(outDirPath, { recursive: true });

                if (ent.method === 0) {
                    fs.writeFileSync(outPath, data);
                } else if (ent.method === 8) {
                    const decompressed = zlib.inflateSync(data, { chunkSize: usize });
                    fs.writeFileSync(outPath, decompressed);
                }
            }

            fs.unlinkSync(tempZip);
            return outDir;

        } catch (error) {
            console.log(`保存文件时发生错误：${error.message}`);
            return null;
        }
    }

    /**
     * Check status and download via doc_id
     * @param {string} docId
     * @param {string} filePath
     * @param {boolean} mdOnly - if true, download as single MD file instead of ZIP
     */
    async checkAndDownload(docId, filePath, mdOnly = false) {
        console.log(`[1/2] 正在查询文档 ${docId} 的转换状态...`);
        const result = await this.checkStatus(docId);
        if (result === null) {
            console.log("Error: Unable to get document status, please retry later");
            failJson('SERVER_ERROR', '无法获取文档状态，请稍后重试');
        }

        if (result.status === 'failed') {
            const reason = result.error ? `：${result.error}` : '';
            console.log(`错误：文档转换失败${reason}`);
            failJson('SERVER_ERROR', `文档转换失败${reason}`);
        } else if (result.status === 'done') {
            console.log(`  转换已完成，正在下载...`);
            if (mdOnly) {
                const markdownBytes = await this.getMarkdownFile(docId);
                if (!markdownBytes) {
                    console.log("获取 Markdown 内容失败");
                    failJson('SERVER_ERROR', '获取 Markdown 内容失败');
                }
                const outFilePath = await this.saveMarkdownFile(markdownBytes, filePath);
                if (!outFilePath) {
                    failJson('SERVER_ERROR', '保存 Markdown 文件失败');
                }
                console.log(`[2/2] 下载完成，文件已保存：${outFilePath}`);
            } else {
                const zipBytes = await this.getMarkdown(docId);
                if (!zipBytes) {
                    console.log("获取 Markdown 内容失败");
                    failJson('SERVER_ERROR', '获取 Markdown 内容失败');
                }
                const outDir = await this.saveMarkdown(zipBytes, docId, filePath);
                if (!outDir) {
                    failJson('SERVER_ERROR', '保存 Markdown 包失败');
                }
                console.log(`[2/2] 下载完成，文件已保存：${outDir}`);
            }
        } else {
            console.log("  文档仍在转换中，继续等待...");
            const [result, detail] = await this.pollUntilDone(docId, filePath, mdOnly);
            if (result === true) {
                console.log(`[2/2] 下载完成，文件已保存：${detail}`);
            } else if (result === false) {
                console.log(`错误：${detail}`);
                failJson('SERVER_ERROR', `转换失败：${detail}`);
            } else {
                console.log(`[!] 文档仍在转换中，请稍后重试`);
                console.log(`  文档 ID：${docId}`);
                process.exit(2);
            }
        }
    }

}

const USAGE = `用法：
  node doc2markdown.js convert <file_path> [--md]        上传并转换文档（默认：下载 ZIP 包）
  node doc2markdown.js check  <doc_id> <file_path> [--md] 查询状态并下载
                                                          --md: 下载单个 MD 文件（非 ZIP 包）

示例：
  node doc2markdown.js convert report.pdf
  node doc2markdown.js convert report.pdf --md
  node doc2markdown.js check 123-f3ce07 report.pdf
  node doc2markdown.js check 123-f3ce07 report.pdf --md`;

/**
 * Print a structured failure envelope `{ok:false, error, message}` on stdout
 * and exit. doc2markdown is an interactive pipeline, so any human-readable
 * progress/error line is printed beforehand by the caller; this only appends
 * the machine-readable envelope. `NO_RESULTS` exits 0, everything else 1.
 * @param {string} error - CONFIG|NO_RESULTS|NOT_FOUND|NO_PERMISSION|SERVER_ERROR
 * @param {string} message
 */
function failJson(error, message) {
    console.log(JSON.stringify({ ok: false, error, message }));
    process.exit(error === 'NO_RESULTS' ? 0 : 1);
}


async function main() {
    if (process.argv.length < 3) {
        console.log(USAGE);
        failJson('CONFIG', '缺少命令参数');
    }

    const converter = new Doc2Markdown();
    const cmd = process.argv[2];

    // Parse --md flag
    const mdOnly = process.argv.includes('--md');

    if (cmd === "convert") {
        if (process.argv.length < 4 || process.argv.length > 5) {
            console.log("用法：node doc2markdown.js convert <file_path> [--md]");
            failJson('CONFIG', 'convert 需要 <file_path> 参数');
        }
        await converter.convertFile(process.argv[3], mdOnly);

    } else if (cmd === "check") {
        if (process.argv.length < 5 || process.argv.length > 6) {
            console.log("用法：node doc2markdown.js check <doc_id> <file_path> [--md]");
            failJson('CONFIG', 'check 需要 <doc_id> 与 <file_path> 参数');
        }
        const docId = process.argv[3];
        const filePath = process.argv[4];
        await converter.checkAndDownload(docId, filePath, mdOnly);

    } else {
        // Backward compatibility: treat direct file path as convert
        if (fs.existsSync(cmd) && fs.statSync(cmd).isFile()) {
            await converter.convertFile(cmd, mdOnly);
        } else {
            console.log(`未知命令：${cmd}`);
            console.log(USAGE);
            failJson('CONFIG', `未知命令：${cmd}`);
        }
    }
}

if (require.main === module) {
    main().catch(error => {
        console.error(`程序执行错误：${error.message}`);
        failJson('SERVER_ERROR', `程序执行错误：${error.message}`);
    });
}

module.exports = Doc2Markdown;
// Expose the pure resolvers for tests without changing the existing export shape
module.exports.resolveApiKey = resolveApiKey;
module.exports.resolveBaseUrl = resolveBaseUrl;