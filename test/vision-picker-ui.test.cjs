'use strict';
// 弹窗选项的呈现规则：列 5 个、描述压成一句话、不再显示"另有 N 个未列出"。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SOURCE = fs.readFileSync(
  path.join(__dirname, '..', 'lib', 'tools', 'docchain.js'),
  'utf8',
);

/** 从源码里抠出 summarizeModelDesc，独立求值（不需要把整个工具模块初始化起来）。 */
function loadSummarizer() {
  const m = SOURCE.match(/function summarizeModelDesc[\s\S]*?\n}\n/);
  assert.ok(m, '找不到 summarizeModelDesc，函数被改名了？');
  // eslint-disable-next-line no-new-func
  return new Function(`${m[0]}; return summarizeModelDesc;`)();
}

const summarize = loadSummarizer();

// 网关真实返回（实测样本）
const GATEWAY_RAW = {
  'qwen3-vl-plus':
    '支持能力：深度思考,文本生成,工具调用,图片理解 对应模型【qwen3-vl-plus-2025-09-23】 ，' +
    'Qwen3系列视觉理解模型，实现思考模式和非思考模式的有效融合，在视觉感知与识别能力大幅提升，' +
    '视觉理解能力最强，思考模式默认关闭',
  'doubao-seed-2.0-pro':
    '支持能力：深度思考,文本生成,工具调用,图片理解 对应模型【doubao-seed-2-0-pro-260215】，' +
    '侧重长链路推理能力与复杂任务稳定性，适配真实业务中的复杂场景',
  'glm-5v-turbo': '支持能力：文本对话,函数调用,图像理解,深度思考 对应模型【glm-5v-turbo】，智谱首个多模态',
  'g-gpt-5.6-sol': '支持能力：深度思考,文本生成,工具调用,图片理解 对应模型【g-gpt-5.6-sol】',
};

test('弹窗描述去掉"支持能力：…"模板，只留真正描述模型的那句', () => {
  for (const [id, raw] of Object.entries(GATEWAY_RAW)) {
    const out = summarize(raw);
    assert.ok(!out.includes('支持能力'), `${id} 的描述仍带模板前缀`);
    assert.ok(!out.includes('对应模型'), `${id} 的描述仍带"对应模型"`);
    assert.ok(!/【[^】]*】/.test(out), `${id} 的描述仍带【版本号】`);
  }
});

test('弹窗描述保留模型真正的区别信息', () => {
  assert.match(summarize(GATEWAY_RAW['qwen3-vl-plus']), /Qwen3系列视觉理解模型/);
  assert.match(summarize(GATEWAY_RAW['doubao-seed-2.0-pro']), /长链路推理能力/);
  assert.match(summarize(GATEWAY_RAW['glm-5v-turbo']), /智谱首个多模态/);
});

test('弹窗描述压到一行（≤42 字），五个选项才看得全', () => {
  for (const [id, raw] of Object.entries(GATEWAY_RAW)) {
    const out = summarize(raw);
    assert.ok(out.length <= 42, `${id} 描述太长：${out.length} 字`);
  }
});

test('描述里只有模板、没有实际内容时返回空串（交给界面显示默认）', () => {
  assert.strictEqual(summarize(GATEWAY_RAW['g-gpt-5.6-sol']), '');
  assert.strictEqual(summarize(''), '');
  assert.strictEqual(summarize(null), '');
  assert.strictEqual(summarize(undefined), '');
});

test('弹窗只列 5 个模型', () => {
  assert.match(SOURCE, /const MAX_OPTIONS = 5;/, '选项数应为 5');
});

test('弹窗不再显示"另有 N 个视觉模型未列出"这类说明', () => {
  // 只检查**会显示给用户的字符串**，不检查代码注释
  // （注释里出现"按综合能力排序"是正常的说明性文字）。
  assert.ok(
    !SOURCE.includes('未在此列出'),
    '"另有 N 个未列出"占一行又不提供可操作信息，应删除',
  );
  // detail 字段是弹窗里那行说明，整个不该再出现
  assert.ok(
    !/detail:\s*\n?\s*['"`]/.test(SOURCE.split('vision-model')[1]?.slice(0, 600) ?? ''),
    '弹窗问题里不应再有 detail 说明行',
  );
});
