#!/usr/bin/env node
/**
 * Docchain批量文档上传工具
 * 支持单文件上传、文件夹批量上传。
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
方式3: 配置文件 docchain-upload/scripts/config.json， 如下格式：
\`\`\`json
{
  "docchain_url": "http://<host>:7100/llmdoc",
  "docchain_api_key": "your-api-key",
}
\`\`\`
方式4: 包内 skills/docchain_config.json，同上json格式（分发兜底，参考 docchain_config.example.json）
**注：配置取值顺序优先级为 环境变量 > scripts/config.json > ~/.dsh/storages/docchain-config.json > 包内 docchain_config.json**`;

const USAGE = `用法：
  node batch_upload.js upload-file <file_path> --topic_id <id>      上传单个文件
  node batch_upload.js upload-folder <folder_path> --topic_id <id>  批量上传文件夹

示例：
  node batch_upload.js upload-file document.pdf --topic_id 123
  node batch_upload.js upload-folder ./docs --topic_id 123`;

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
 * POST a single-file multipart/form-data body and parse the JSON response.
 * @param {string} url
 * @param {object} headers
 * @param {object} file - { filename, content }
 * @returns {Promise<{status: number, data: any, text: string}>}
 */
function uploadMultipart(url, headers, { filename, content }) {
    return new Promise((resolve, reject) => {
        const urlObj = new URL(url);
        const isHttps = urlObj.protocol === 'https:';
        const httpModule = isHttps ? https : http;
        const boundary = '----DocchainBoundary' + Math.random().toString(36).substring(2);

        const body = Buffer.concat([
            Buffer.from(
                `--${boundary}\r\n` +
                `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
                'Content-Type: application/octet-stream\r\n\r\n',
                'utf8'
            ),
            content,
            Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
        ]);

        const reqOptions = {
            hostname: urlObj.hostname,
            port: urlObj.port || (isHttps ? 443 : 80),
            path: urlObj.pathname + urlObj.search,
            method: 'POST',
            headers: {
                ...headers,
                'Content-Type': `multipart/form-data; boundary=${boundary}`,
                'Content-Length': body.length,
            },
            timeout: 120000,
        };

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
                resolve({ status: res.statusCode, data, text });
            });
        });

        req.on('error', (error) => reject(error));
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('请求超时'));
        });

        req.write(body);
        req.end();
    });
}

class DocchainUploader {
    constructor() {
        this.config = getConfig();
    }

    /**
     * 调用Docchain API
     * @param {string} endpoint
     * @param {string} filePath
     * @param {number} topicId
     * @returns {Promise<object>} 解析后的 API 响应
     */
    async _callApi(endpoint, filePath, topicId) {
        const url = `${this.config.docchain_url.replace(/\/+$/, '')}/v1/skills/${endpoint}`;
        const params = new URLSearchParams({ topic_id: String(topicId) });
        const fullUrl = `${url}?${params.toString()}`;

        const headers = { 'X-Api-Key': this.config.docchain_api_key };

        try {
            const filename = path.basename(filePath);
            const content = fs.readFileSync(filePath);
            const response = await uploadMultipart(fullUrl, headers, { filename, content });

            if (response.status >= 400) {
                if (response.status === 401 || response.status === 403) {
                    printError('NO_PERMISSION', `无权限上传到该主题（HTTP ${response.status}）`);
                }
                printError('SERVER_ERROR', `API请求失败: HTTP ${response.status} ${response.text}`);
            }
            const data = response.data;
            if (data && data.success === false) {
                printError('SERVER_ERROR', `API请求失败: ${data.err || '未知错误'}`);
            }
            return data;
        } catch (error) {
            printError('SERVER_ERROR', `API请求失败: ${error.message}`);
        }
    }

    /**
     * 上传单个文件
     * @param {string} filePath
     * @param {number} topicId
     * @returns {Promise<object>}
     */
    async uploadFile(filePath, topicId) {
        if (!fs.existsSync(filePath)) {
            return { success: false, error: `文件不存在: ${filePath}` };
        }

        if (!topicId) {
            return { success: false, error: '未提供 topic_id，必须通过 --topic_id 参数指定' };
        }

        try {
            const result = await this._callApi('upload_doc', filePath, topicId);

            if (result && typeof result === 'object' && !Array.isArray(result) && 'error' in result) {
                return { success: false, error: result.error, file: filePath };
            }

            return {
                success: true,
                file: filePath,
                doc_id: result.doc_id,
                doc_name: result.doc_name,
                topic_id: result.topic_id,
            };
        } catch (error) {
            return { success: false, error: error.message, file: filePath };
        }
    }

    /**
     * 扫描文件夹中的文件（仅顶层，不递归）
     * @param {string} folderPath
     * @returns {string[]}
     */
    scanFiles(folderPath) {
        const files = [];

        if (!fs.existsSync(folderPath)) {
            console.log(`错误: 路径不存在: ${folderPath}`);
            return files;
        }

        if (fs.statSync(folderPath).isFile()) {
            files.push(folderPath);
            return files;
        }

        if (fs.statSync(folderPath).isDirectory()) {
            for (const entry of fs.readdirSync(folderPath)) {
                const fullPath = path.join(folderPath, entry);
                if (fs.statSync(fullPath).isFile()) {
                    files.push(fullPath);
                }
            }
        }

        return files.sort();
    }

    /**
     * 批量上传文件
     * @param {string[]} files
     * @param {number} topicId
     * @returns {Promise<object>}
     */
    async batchUpload(files, topicId) {
        const total = files.length;
        let successCount = 0;
        let failedCount = 0;
        const results = [];

        console.log(`\n开始批量上传，共 ${total} 个文件\n`);

        for (let idx = 0; idx < files.length; idx += 1) {
            const filePath = files[idx];
            const filename = path.basename(filePath);
            console.log(`\n[${idx + 1}/${total}] 正在上传: ${filename}`);

            const result = await this.uploadFile(filePath, topicId);
            results.push(result);

            if (result.success) {
                successCount += 1;
                console.log(`✓ 上传成功 (doc_id: ${result.doc_id})`);
            } else {
                failedCount += 1;
                console.log(`✗ 上传失败: ${result.error}`);
            }

            // 显示进度
            const progress = ((idx + 1) / total) * 100;
            console.log(`进度: ${progress.toFixed(1)}% | 成功: ${successCount} | 失败: ${failedCount}`);
        }

        console.log('\n上传完成！');
        console.log(`总计: ${total} 个文件`);
        console.log(`成功: ${successCount} 个文件`);
        console.log(`失败: ${failedCount} 个文件`);

        return {
            total,
            success: successCount,
            failed: failedCount,
            results,
        };
    }
}

async function main() {
    const args = process.argv.slice(2);
    const command = args[0];
    const targetPath = args[1];

    if (!command || !targetPath) {
        console.log(USAGE);
        process.exit(1);
    }

    // 解析 --topic_id（支持 --topic_id <id> 与 --topic_id=<id>）
    let topicId = null;
    for (let i = 2; i < args.length; i += 1) {
        let value;
        if (args[i].startsWith('--topic_id=')) {
            value = args[i].slice('--topic_id='.length);
        } else if (args[i] === '--topic_id') {
            value = args[i + 1];
            i += 1;
        }
        if (value !== undefined) {
            if (!/^\d+$/.test(value)) {
                printError('CONFIG', '错误：topic_id 必须是数字');
            }
            topicId = parseInt(value, 10);
        }
    }
    if (topicId === null) {
        printError('CONFIG', '错误：缺少必填参数 --topic_id');
    }

    // 初始化上传器
    const uploader = new DocchainUploader();

    // 执行命令
    if (command === 'upload-file') {
        const result = await uploader.uploadFile(targetPath, topicId);
        console.log(JSON.stringify(Object.assign({ ok: result.success === true }, result)));
    } else if (command === 'upload-folder') {
        const files = uploader.scanFiles(targetPath);

        if (files.length === 0) {
            printError('NO_RESULTS', '未找到匹配的文件');
        }

        console.log(`\n找到 ${files.length} 个文件:`);
        for (const f of files.slice(0, 10)) {
            console.log(`  - ${path.basename(f)}`);
        }
        if (files.length > 10) {
            console.log(`  ... 还有 ${files.length - 10} 个文件`);
        }

        const summary = await uploader.batchUpload(files, topicId);
        console.log(JSON.stringify(Object.assign({ ok: summary.failed === 0, mode: 'batch' }, summary)));
    } else {
        console.log(USAGE);
        process.exit(1);
    }
}

if (require.main === module) {
    main();
}
