#!/usr/bin/env node
/**
 * Docchain 批量上传 —— 命令行入口。
 *
 * 业务实现已经搬进 `lib/tools/docchain.js`（`runUpload`），本文件只是薄壳：
 * 解析 `--flag`、解析配置、调业务函数、把结果打到 stdout。
 *
 * 原来 459 行里有 159 行是 CLI 脚手架，业务本身很简单（扫目录 → 逐个上传 → 汇总）。
 *
 * ⚠️ 这是写操作，会真正写入知识库。
 *
 * 用法：
 *   node batch_upload.js --path ./docs/a.pdf --topic_id 11249
 *   node batch_upload.js --path ./docs --topic_id 11249 --mode folder
 *
 * 配置取值顺序（沿用原有约定）：
 *   环境变量 DOCCHAIN_URL / DOCCHAIN_API_KEY
 *   > skills/docchain-upload/scripts/config.json
 *   > ~/.dsh/storages/docchain-config.json
 *   > 包内 skills/docchain_config.json
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

/** lib/tools/docchain.js 是 ESM，必须用动态 import 加载。 */
const LIB_PATH = path.join(__dirname, '..', '..', '..', 'lib', 'tools', 'docchain.js');

const CONFIG_HINT = `请正确配置以下参数
docchain_url: 环境指向地址（必填）
docchain_api_key: 环境的账号验证方式（必填）
方式1: 环境变量 DOCCHAIN_URL, DOCCHAIN_API_KEY
方式2: 插件配置：dsh-docchain 插件的 Config（激活时自动写入
       ~/.dsh/storages/docchain-config.json，也可直接手动编辑该文件）
       {"docchain_url": "http://<host>:7100/llmdoc", "docchain_api_key": "your-api-key"}
方式3: 配置文件 skills/docchain-upload/scripts/config.json
方式4: 包内 skills/docchain_config.json（分发兜底）
**注：配置取值顺序优先级为 环境变量 > scripts/config.json > ~/.dsh/storages/docchain-config.json > 包内 docchain_config.json**`;

const ARG_SPEC = {
    path: { type: 'string', required: true },
    topic_id: { type: 'int', required: true },
    mode: { type: 'string', default: 'file', choices: ['file', 'folder'] },
};

/** 解析 `--flag value` / `--flag=value`。 */
function parseArgs(argv, argSpec) {
    const args = {};
    for (const [name, spec] of Object.entries(argSpec)) {
        args[name] = spec.default !== undefined ? spec.default : null;
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

function readJsonFile(configPath) {
    if (!fs.existsSync(configPath)) return null;
    try {
        const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
        console.error(`警告：配置文件不是合法 JSON，已忽略：${configPath}`);
        return null;
    }
}

/** 四级配置优先级。命令行专属 —— 走工具时配置由宿主传入。 */
function getConfig() {
    const config = {
        ...readJsonFile(path.join(__dirname, '..', '..', 'docchain_config.json')),
        ...readJsonFile(path.join(os.homedir(), '.dsh', 'storages', 'docchain-config.json')),
        ...readJsonFile(path.join(__dirname, 'config.json')),
    };
    if (process.env.DOCCHAIN_URL) config.docchain_url = process.env.DOCCHAIN_URL;
    if (process.env.DOCCHAIN_API_KEY) config.docchain_api_key = process.env.DOCCHAIN_API_KEY;
    if (!config.docchain_url || !config.docchain_api_key) {
        console.log(JSON.stringify({ ok: false, error: 'CONFIG', message: CONFIG_HINT }));
        process.exit(1);
    }
    return config;
}

async function main() {
    const args = parseArgs(process.argv.slice(2), ARG_SPEC);
    const config = getConfig();
    const lib = await import(pathToFileURL(LIB_PATH).href);
    try {
        // 命令行模式下把每个文件的进度打到 stderr，不污染 stdout 的 JSON。
        const payload = await lib.runUpload(config, {
            target: args.path,
            topicId: args.topic_id,
            mode: args.mode,
        });
        for (const r of payload.results) {
            const mark = r.success ? '✓' : '✗';
            console.error(`${mark} ${r.file}${r.success ? ` (doc_id: ${r.doc_id})` : ` — ${r.error}`}`);
        }
        console.error(`\n总计 ${payload.total}，成功 ${payload.success}，失败 ${payload.failed}`);
        console.log(JSON.stringify(payload));
    } catch (error) {
        const code = (error && error.code) || 'SERVER_ERROR';
        console.log(JSON.stringify({ ok: false, error: code, message: error.message }));
        process.exit(1);
    }
}

main();
