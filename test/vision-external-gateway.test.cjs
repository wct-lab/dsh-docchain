'use strict';
// 外部用户接入：他们的网关通常没有 is_vision 字段（豆包官方、阿里、OpenAI 都只有 id），
// 而且模型名跟我们那套完全对不上（g-doubao-seed-2.1-pro 是我们网关的别名，对方没有）。
//
// 早先的实现只认 is_vision=1，遇到这种网关就返回空清单 —— 弹窗一个模型都列不出来，
// 等于外部用户用不了这个功能。这里锁住新的自适应口径。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const TOOL_SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'tools', 'docchain.js'), 'utf8');
const VISION_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'skills', 'docchain-image-describe', 'scripts', 'vision.js'),
  'utf8',
);

/** 从 `(async )?function NAME(` 起按大括号配平截取完整函数体。 */
function extractFn(src, name) {
  const start = src.search(new RegExp(`(?:async )?function ${name}\\(`));
  if (start < 0) throw new Error('找不到函数 ' + name);
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error('函数体没闭合: ' + name);
}

const detect = new Function(
  `${TOOL_SRC.match(/const VISION_NAME_HINTS = \[[\s\S]*?\];/)[0]}
   ${extractFn(TOOL_SRC, 'looksLikeVisionModel')}
   return looksLikeVisionModel;`,
)();

// ---------------------------------------------------------------------------
// 名字识别
// ---------------------------------------------------------------------------

test('按名字认出各家的视觉模型', () => {
  const yes = [
    'doubao-seed-1-6-vision-250815',
    'doubao-1-5-vision-pro-32k',
    'qwen-vl-plus',
    'qwen3-vl-plus',
    'gpt-4o',
    'gpt-4o-mini',
    'gpt-4.1',
    'glm-4v-plus',
    'claude-3-5-sonnet',
    'gemini-1.5-pro',
    // 豆包 2.x 默认多模态，名字里不带 vision
    'doubao-seed-2.0-pro',
    'g-doubao-seed-2.1-pro',
  ];
  for (const id of yes) assert.strictEqual(detect(id), true, `${id} 应判为视觉模型`);
});

test('纯文本模型不会被误判成视觉模型', () => {
  const no = [
    'doubao-seed-1.6',
    'doubao-pro-32k',
    'qwen-max',
    'qwen-max-longcontext',
    'gpt-3.5-turbo',
    'glm-4-plus',
    'llama-3-70b',
    'deepseek-chat',
  ];
  for (const id of no) assert.strictEqual(detect(id), false, `${id} 不该被判为视觉模型`);
});

// ---------------------------------------------------------------------------
// 清单自适应
// ---------------------------------------------------------------------------

test('网关有 is_vision 字段时以字段为准，不靠名字猜', () => {
  // 关键：能力标记是权威的。名字里带 vision 但标了 is_vision=0 的，就是不能用。
  assert.match(TOOL_SRC, /hasFlag[\s\S]{0,200}m\.is_vision === 1/, '有字段时应以字段为准');
});

test('网关没有 is_vision 字段时按名字识别', () => {
  assert.match(TOOL_SRC, /looksLikeVisionModel\(id\)/, '缺字段时应回落到名字识别');
  assert.match(VISION_SRC, /looksLikeVisionModel\(row\.id\)/, '脚本侧也要同样回落');
});

test('内置候选一个都没命中时按对方网关的顺序，而不是报空', () => {
  // matchedPreferred 用来决定弹窗提示语：
  //   true  → 命中我们那套候选（内部用户）
  //   false → 用的是对方网关自己的模型（外部用户），要明说
  assert.match(TOOL_SRC, /matchedPreferred/, '需要区分"命中了内置候选"与"用的是对方网关"');
  assert.match(TOOL_SRC, /你自己的模型网关上/, '未命中时应提示"这是你自己网关上的模型"');
});

test('拿不到任何可用视觉模型时不弹窗，直接提示换 API key', () => {
  // 口径：账号 / API key 下根本没有能读图的模型时（典型：DeepSeek 账号只有纯文本模型），
  // 弹窗列什么都跑不通 —— 列我们网关那套名字会 404，列他的纯文本模型照样读不了图。
  // 与其让用户白点一次再撞墙，不如当场告诉他换 Key。
  //
  // "清单为空"（账号确实没有视觉模型）与"拉不到清单"（网络 / 地址 / Key 无效）
  // 合并成同一条提示：两种情况下用户要做的事完全一样。
  assert.match(TOOL_SRC, /models\.length === 0[\s\S]{0,400}NO_VISION_MODEL/, '清单为空应直接报错');
  assert.match(TOOL_SRC, /当前没有可使用的视觉模型/, '提示语应明确指出没有可用视觉模型');
  assert.match(TOOL_SRC, /请更换 API key/, '应告诉用户更换 API key');
  // 旧的"退回内置清单并弹窗"逻辑必须删干净，否则又会列出一堆用不了的模型
  assert.ok(!TOOL_SRC.includes('fallbackToList'), '旧的兜底弹窗逻辑应已删除');
});

test('网关标成 is_vision=1 的 DocChain 应用仍被剔除', () => {
  assert.match(TOOL_SRC, /is_docchain/, 'DocChain 知识库应用不是视觉大模型，必须剔掉');
});
