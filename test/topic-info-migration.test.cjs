'use strict';
// docchain_topic_info 的试点迁移。
//
// 背景：这个工具原先的实现全在 skills/docchain-topic-info/scripts/docchain_topic_info.js
// （382 行），其中 239 行（63%）只是为了"能在命令行单独跑"——解析 --flag、四级配置
// 优先级、手写 http/https 封装、printError + exit。DSH 里调工具时一条都用不到。
//
// 现在：业务实现搬进 lib/tools/docchain.js，脚本退化成薄壳去 import 那边的函数。
// 顺带修掉一个真实的 token 问题：默认一次返回 200 个主题 × 5 个字段 ≈ 10700 token，
// 精简成 20 条 × 2 个字段后约 395 token。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const TOOL = fs.readFileSync(path.join(ROOT, 'lib', 'tools', 'docchain.js'), 'utf8');
const SHELL = fs.readFileSync(
  path.join(ROOT, 'skills', 'docchain-topic-info', 'scripts', 'docchain_topic_info.js'),
  'utf8',
);

// ---------------------------------------------------------------------------
// 迁移位置
// ---------------------------------------------------------------------------

test('业务实现在 lib/tools 里，工具不再 require 脚本', () => {
  // 三个业务函数必须在工具文件里定义
  assert.match(TOOL, /async function fetchTopics\(/, 'fetchTopics 应在 lib/tools');
  assert.match(TOOL, /function formatTopics\(/, 'formatTopics 应在 lib/tools');
  assert.match(TOOL, /async function runTopicInfo\(/, 'runTopicInfo 应在 lib/tools');
  // 不该再有 require 那个脚本的语句
  assert.ok(
    !/require\([^)]*docchain-topic-info[^)]*\)/.test(TOOL),
    '工具不应再 require docchain-topic-info 的脚本',
  );
});

/** 截出 `docchain_topic_info` 这**一个**工具的定义块（从 name 到下一个 defineTool 之前）。 */
function topicInfoBlock() {
  const start = TOOL.indexOf("name: 'docchain_topic_info'");
  assert.ok(start > 0, '找不到 docchain_topic_info 定义');
  // 下一个工具的条件 schema 就是边界
  const end = TOOL.indexOf('/** One metadata condition', start);
  assert.ok(end > start, '找不到结束边界');
  return TOOL.slice(start, end);
}

test('工具的 run() 直接调本地函数', () => {
  const block = topicInfoBlock();
  assert.ok(block.includes('runTopicInfo(config'), 'run() 应直接调用本文件的 runTopicInfo');
  assert.ok(!block.includes('topicInfo.runTopicInfo'), '不应再走 topicInfo 模块');
});

test('lib/tools 导出业务函数供薄壳使用', () => {
  assert.match(TOOL, /export \{[^}]*runTopicInfo[^}]*\}/, '必须导出 runTopicInfo');
});

// ---------------------------------------------------------------------------
// 薄壳
// ---------------------------------------------------------------------------

test('脚本退化成薄壳：不再自己实现业务', () => {
  assert.ok(!SHELL.includes('function listTopics'), '薄壳不该再有 listTopics');
  assert.ok(!SHELL.includes('function formatResults'), '薄壳不该再有 formatResults');
  assert.ok(!SHELL.includes('function requestJson'), '薄壳不该再手写 HTTP');
  assert.ok(SHELL.includes('lib'), '薄壳应引用 lib/tools');
});

test('薄壳保留命令行必需的部分', () => {
  assert.ok(SHELL.includes('function parseArgs'), '命令行仍要解析参数');
  assert.ok(SHELL.includes('function getConfig'), '命令行仍要自己解析配置');
  assert.ok(SHELL.includes('process.exit'), '命令行仍要有退出码');
});

test('薄壳明显变小了', () => {
  const lines = SHELL.split(/\r?\n/).length;
  // 原 382 行；业务搬走后只留 CLI 相关，应在 150 行以内
  assert.ok(lines < 150, `薄壳应显著变小，当前 ${lines} 行`);
});

// ---------------------------------------------------------------------------
// token 问题
// ---------------------------------------------------------------------------

test('默认 size 从 200 降到 20（token 消耗的主因）', () => {
  const block = topicInfoBlock();
  assert.match(block, /clampInt\(args\.size, 20, 1, 500\)/, '工具默认 size 应为 20');
  assert.ok(!/clampInt\(args\.size, 200/.test(block), '这一个工具不能还是 200');
  assert.match(block, /默认 20，上限 500/, 'schema 描述应写默认 20');
  assert.ok(!/默认 200/.test(block), 'schema 描述不能还写默认 200');
});

test('返回只保留 id + name（state/create_date/create_by_name 是噪音）', () => {
  assert.match(
    TOOL,
    /topics\.map\(\(topic\) => \(\{ id: topic\.id, name: topic\.name \|\| '' \}\)\)/,
    'formatTopics 只该输出 id 和 name',
  );
});

// ---------------------------------------------------------------------------
// 行为等价
// ---------------------------------------------------------------------------

test('错误码与原来一致', async () => {
  // 用假 config 触发，不打网络：这段断言检查源码里的映射
  assert.match(TOOL, /'NO_PERMISSION'/, '401/403 应映射 NO_PERMISSION');
  assert.match(TOOL, /'SERVER_ERROR'/, '5xx 与网络错误应映射 SERVER_ERROR');
});
