#!/usr/bin/env node
/**
 * Docchain 内容搜索 —— 命令行入口。
 *
 * 业务实现已经搬进 `lib/tools/docchain.js`（`runContentSearch` / `searchInDoc`），
 * 本文件只是薄壳：解析 `--flag`、解析配置、调业务函数、把结果打到 stdout。
 *
 * 原来 487 行里有 271 行（56%）纯粹是为了"能在命令行单独跑"而写的。
 *
 * 用法：
 *   node search_in_doc.js --keywords 组织架构 --topic_ids 11249
 *   node search_in_doc.js --keywords 组织架构 --doc_ids 130241
 *   node search_in_doc.js --keywords "项目,交付" --topic_ids 11249 --operator and --limit 10
 *
 * 配置取值顺序（沿用原有约定）：
 *   环境变量 DOCCHAIN_URL / DOCCHAIN_API_KEY
 *   > skills/docchain-content-search/scripts/config.json
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
方式3: 配置文件 skills/docchain-content-search/scripts/config.json
方式4: 包内 skills/docchain_config.json（分发兜底）
**注：配置取值顺序优先级为 环境变量 > scripts/config.json > ~/.dsh/storages/docchain-config.json > 包内 docchain_config.json**`;

const ARG_SPEC = {
    keywords: { type: 'string', required: true },
    doc_ids: { type: 'string', default: null },
    topic_ids: { type: 'string', default: null },
    operator: { type: 'string', default: 'or', choices: ['or', 'and'] },
    limit: { type: 'int', default: 30 },
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

function splitList(value) {
    if (!value) return [];
    return String(value)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
}

function parseIdList(value, label) {
    const ids = splitList(value).map((s) => {
        if (!/^\d+$/.test(s)) {
            console.error(`❌ 错误：${label} 必须是逗号分隔的数字：${s}`);
            process.exit(1);
        }
        return parseInt(s, 10);
    });
    return ids.length ? ids : null;
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
    const keywords = splitList(args.keywords);
    const docIds = parseIdList(args.doc_ids, '文档 ID');
    const topicIds = parseIdList(args.topic_ids, '主题 ID');
    if (keywords.length === 0) {
        console.log(JSON.stringify({ ok: false, error: 'CONFIG', message: '错误：未提供关键词' }));
        process.exit(1);
    }
    if (!docIds && !topicIds) {
        console.log(JSON.stringify({ ok: false, error: 'CONFIG', message: '错误：必须提供 --doc_ids 或 --topic_ids 之一' }));
        process.exit(1);
    }

    const config = getConfig();
    const lib = await import(pathToFileURL(LIB_PATH).href);
    try {
        const payload = await lib.runContentSearch(config, {
            docIds,
            topicIds,
            keywords,
            operator: args.operator,
            limit: args.limit,
        });
        console.log(JSON.stringify(payload));
    } catch (error) {
        const code = (error && error.code) || 'SERVER_ERROR';
        console.log(JSON.stringify({ ok: false, error: code, message: error.message }));
        process.exit(code === 'NO_RESULTS' ? 0 : 1);
    }
}

main();
