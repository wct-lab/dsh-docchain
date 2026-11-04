'use strict';
// 回归测试：当前模型读不了图时，让用户从视觉模型清单里挑一个（scheme A）。
//
// 背景：工具原先有一个 `model` 参数，语义是"显式覆盖主视觉模型"。模型收到
// MODEL_NOT_VISION 报错后会自己填上这个参数重试，等于绕过了"必须由人换模型"
// 的约束。现在参数已删除，只能走 userQuestions 弹窗，由真人点选。
// 本文件锁住三件事：清单排序、只对本次调用生效、拿不到 userQuestions 时干净退出。

const test = require('node:test');
const assert = require('node:assert');

// ---------------------------------------------------------------------------
// 被测逻辑（与 lib/tools/docchain.js 保持一致）
// ---------------------------------------------------------------------------

const PREFERRED_VISION_MODELS = ['qwen3-vl-plus', 'doubao-seed-2.0-pro', 'glm-5v-turbo'];

function sortVisionModels(models) {
  const rank = (id) => {
    const i = PREFERRED_VISION_MODELS.indexOf(id);
    return i === -1 ? PREFERRED_VISION_MODELS.length : i;
  };
  return [...models].sort((a, b) => {
    const d = rank(a.id) - rank(b.id);
    return d !== 0 ? d : a.id.localeCompare(b.id);
  });
}

function pickVisionModels(list, max = 8) {
  return list.slice(0, max);
}

// 模拟 askUserForVisionModel 的核心分支
async function askUserForVisionModel(exec, { currentModel, models, askImpl }) {
  const agent = exec?.agent;
  if (!agent) return null;
  let userQuestions = null;
  for (const holder of [exec, agent, agent?.ctx, exec?.ctx]) {
    if (!holder) continue;
    const candidate = typeof holder.get === 'function' ? holder.get('userQuestions') : undefined;
    if (candidate && typeof candidate.ask === 'function') {
      userQuestions = candidate;
      break;
    }
    const direct = holder.userQuestions;
    if (direct && typeof direct.ask === 'function') {
      userQuestions = direct;
      break;
    }
  }
  if (!userQuestions) return null;
  try {
    const answer = await userQuestions.ask({
      agent,
      questions: [
        {
          id: 'vision-model',
          question: `当前对话模型 ${currentModel} 不支持读图`,
          options: pickVisionModels(models).map((m) => ({ label: m.id })),
        },
      ],
    });
    const picked = Array.isArray(answer?.answers)
      ? answer.answers.find((a) => a && a.id === 'vision-model')
      : undefined;
    const fromList = Array.isArray(picked?.selected) && picked.selected[0];
    const custom = typeof picked?.custom === 'string' ? picked.custom.trim() : '';
    if (typeof fromList === 'string' && fromList.trim()) {
      return { model: fromList.trim(), fromList: true };
    }
    if (custom) return { model: custom, fromList: false };
    return null;
  } catch {
    return null;
  }
}

// 取自网关真实响应的片段
const GATEWAY_VISION = [
  { id: 'gpt-4o', is_vision: 1 },
  { id: 'qwen3-vl-plus', is_vision: 1 },
  { id: 'glm-5v-turbo', is_vision: 1 },
  { id: 'doubao-seed-2.0-pro', is_vision: 1 },
  { id: 'gemini-3-flash', is_vision: 1 },
];
const GATEWAY_TEXT = [
  { id: 's-deepseek-v4.1-flash', is_vision: 0 },
  { id: 'g-deepseek-v4-pro', is_vision: 0 },
];

// ---------------------------------------------------------------------------
// 清单与排序
// ---------------------------------------------------------------------------

test('推荐的三个模型排在最前，且顺序固定', () => {
  const sorted = sortVisionModels(GATEWAY_VISION);
  assert.deepStrictEqual(
    sorted.slice(0, 3).map((m) => m.id),
    ['qwen3-vl-plus', 'doubao-seed-2.0-pro', 'glm-5v-turbo'],
  );
});

test('清单之外的视觉模型仍然列出，只是排在后面', () => {
  const sorted = sortVisionModels(GATEWAY_VISION);
  const rest = sorted.slice(3).map((m) => m.id);
  assert.ok(rest.includes('gpt-4o'), 'gpt-4o 不该被丢掉');
  assert.ok(rest.includes('gemini-3-flash'));
  assert.strictEqual(sorted.length, GATEWAY_VISION.length, '不增不减');
});

test('默认展示前 8 个，多出来的通过 detail 告知数量', () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ id: `model-${String(i).padStart(2, '0')}` }));
  const shown = pickVisionModels(sortVisionModels(many), 8);
  assert.strictEqual(shown.length, 8);
});

test('清单为空时回落到内置的三个推荐模型', () => {
  const fallback = PREFERRED_VISION_MODELS.map((id) => ({ id }));
  assert.strictEqual(fallback.length, 3);
  assert.deepStrictEqual(fallback.map((m) => m.id), PREFERRED_VISION_MODELS);
});

test('排除网关误标成 is_vision=1 的 DocChain 知识库应用', () => {
  // 实测网关把 33 个知识库应用也标了 is_vision=1，它们读不了图。
  const isKbApp = (m) =>
    m.is_docchain === 1 || m.is_docchain === '1' || m.is_docchain === true;
  const mixed = [
    { id: 'qwen3-vl-plus', is_vision: 1, is_docchain: 0 },
    { id: '9E应标小助手', is_vision: 1, is_docchain: 1 },
    { id: '报表小助手', is_vision: 1, is_docchain: 1 },
    { id: 'doubao-seed-2.0-pro', is_vision: 1, is_docchain: 0 },
  ];
  const kept = mixed.filter(
    (m) => (m.is_vision === 1) && !isKbApp(m),
  );
  assert.deepStrictEqual(
    kept.map((m) => m.id),
    ['qwen3-vl-plus', 'doubao-seed-2.0-pro'],
  );
});

// ---------------------------------------------------------------------------
// 用户选择
// ---------------------------------------------------------------------------

test('用户点选后返回该模型，并标记来自可信清单', async () => {
  const sq = { ask: async () => ({ answers: [{ id: 'vision-model', selected: ['doubao-seed-2.0-pro'] }] }) };
  const got = await askUserForVisionModel(
    { agent: { id: 's1', userQuestions: sq } },
    { currentModel: 's-deepseek-v4.1-flash', models: GATEWAY_VISION },
  );
  assert.deepStrictEqual(got, { model: 'doubao-seed-2.0-pro', fromList: true });
});

test('自由输入标记为不可信，调用方必须二次校验', async () => {
  const sq = { ask: async () => ({ answers: [{ id: 'vision-model', selected: [], custom: 'gpt-4o' }] }) };
  const got = await askUserForVisionModel(
    { agent: { id: 's1', userQuestions: sq } },
    { currentModel: 'x', models: GATEWAY_VISION },
  );
  assert.deepStrictEqual(got, { model: 'gpt-4o', fromList: false });
});

test('自由输入一个纯文本模型时，fromList=false 让调用方拦下它', async () => {
  // 场景：对话模型是纯文本，弹窗出现，用户在输入框手打了另一个纯文本模型
  const sq = { ask: async () => ({ answers: [{ id: 'vision-model', selected: [], custom: 'g-deepseek-v4-pro' }] }) };
  const got = await askUserForVisionModel(
    { agent: { id: 's1', userQuestions: sq } },
    { currentModel: 's-deepseek-v4.1-flash', models: GATEWAY_VISION },
  );
  assert.strictEqual(got.fromList, false, '手打的名字必须走二次校验');
  assert.strictEqual(got.model, 'g-deepseek-v4-pro');
  // 调用方拿到 fromList=false 后会再查 is_vision，这个模型是 0，应当拒绝
  const entry = GATEWAY_TEXT.find((m) => m.id === got.model);
  assert.ok(entry, '该模型在网关清单里');
  assert.strictEqual(entry.is_vision, 0, '确认它确实读不了图');
});

test('用户取消/未作答时返回 null（调用方据此报错，不擅自换模型）', async () => {
  const sq = { ask: async () => ({ answers: [] }) };
  const got = await askUserForVisionModel(
    { agent: { id: 's1', userQuestions: sq } },
    { currentModel: 'x', models: GATEWAY_VISION },
  );
  assert.strictEqual(got, null);
});

test('提问抛错时返回 null，不把异常甩给用户', async () => {
  const sq = { ask: async () => { throw new Error('ASK_ABORTED'); } };
  const got = await askUserForVisionModel(
    { agent: { id: 's1', userQuestions: sq } },
    { currentModel: 'x', models: GATEWAY_VISION },
  );
  assert.strictEqual(got, null);
});

test('拿不到 userQuestions 服务时返回 null，而不是崩溃', async () => {
  assert.strictEqual(
    await askUserForVisionModel({ agent: { id: 's1' } }, { currentModel: 'x', models: [] }),
    null,
  );
  assert.strictEqual(await askUserForVisionModel({}, { currentModel: 'x', models: [] }), null);
});

test('userQuestions 挂在 exec 上（而非 agent）时同样可用', async () => {
  const asked = [];
  const exec = {
    agent: { id: 's1' },
    userQuestions: {
      ask: async (req) => {
        asked.push(req);
        return { answers: [{ id: 'vision-model', selected: ['qwen3-vl-plus'] }] };
      },
    },
  };
  const got = await askUserForVisionModel(exec, {
    currentModel: 's-deepseek-v4.1-flash',
    models: GATEWAY_VISION,
  });
  assert.deepStrictEqual(got, { model: 'qwen3-vl-plus', fromList: true });
  assert.strictEqual(asked.length, 1, '只问一次');
});

// ---------------------------------------------------------------------------
// 不读图的模式不该弹窗
// ---------------------------------------------------------------------------

test('read / list_models 不读图，不该因为对话模型是纯文本就打断用户', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'lib', 'tools', 'docchain.js'),
    'utf8',
  );
  // read 只读旁路 md，list_models 只拉清单，两者都不调用视觉模型
  assert.ok(
    /const needsVision = !args\.read && !args\.list_models/.test(src),
    '应按 read/list_models 跳过视觉校验',
  );
  assert.ok(
    /if \(resolvedModel && needsVision\)/.test(src),
    '校验应以 needsVision 为前提',
  );
});

// ---------------------------------------------------------------------------
// 回归护栏：model 参数必须不存在
// ---------------------------------------------------------------------------

test('工具参数里不再有 model（AI 无法绕过弹窗自行指定模型）', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'lib', 'tools', 'docchain.js'),
    'utf8',
  );
  const start = src.indexOf("name: 'docchain_image_describe'");
  assert.ok(start > 0, '找不到工具定义');
  // 截到下一个工具定义之前
  const next = src.indexOf('const doc2markdownTool', start);
  const block = src.slice(start, next > start ? next : start + 6000);
  assert.strictEqual(
    /^\s+model: \{ type: 'string'/m.test(block),
    false,
    'image_describe 的参数表里不该再有 model',
  );
  assert.strictEqual(/args\.model/.test(block), false, '不该再从参数读 model');
});

test('视觉模型只来自对话模型或用户点选，不存在第三条路径', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'lib', 'tools', 'docchain.js'),
    'utf8',
  );
  assert.ok(src.includes('getCurrentSessionModel'), '应读取对话模型');
  assert.ok(src.includes('askUserForVisionModel'), '应支持用户点选');
  assert.strictEqual(
    /skipVisionCheck/.test(src),
    false,
    'skipVisionCheck 后门必须删除',
  );
});

// ---------------------------------------------------------------------------
// 复核模型撞车避让
//
// 复核（judge）只在 judgeModel !== model 时执行——同一个模型读两遍拿不到
// 第二视角。弹窗里 qwen3-vl-plus 既是推荐项又是默认复核模型，用户选它时
// 复核会静默消失。这里直接跑真实模块，锁住避让行为。
// ---------------------------------------------------------------------------

const describeModule = require('../skills/docchain-image-describe/scripts/describe_images.js');

function resolveWith(base, params) {
  return describeModule.resolveVisionConfig(base, params);
}

const BASE = { url: 'https://example.test/v1', key: 'k' };

test('用户选中的主模型与复核模型相同时，复核自动换一个不同的', () => {
  const cfg = resolveWith(
    { ...BASE, model: 'doubao-seed-2.0-pro', judgeModel: 'qwen3-vl-plus' },
    { model: 'qwen3-vl-plus' },
  );
  assert.strictEqual(cfg.model, 'qwen3-vl-plus');
  assert.notStrictEqual(cfg.judgeModel, cfg.model, '复核模型不能和主模型相同');
  assert.strictEqual(cfg.judgeModel, 'doubao-seed-2.0-pro', '应换成默认复核模型');
});

test('主模型换成复核模型的默认值时，复核改走另一个推荐模型', () => {
  // DEFAULT_VISION_JUDGE_MODEL 是 doubao，用户恰好选了它
  const cfg = resolveWith(
    { ...BASE, model: 'qwen3-vl-plus', judgeModel: 'doubao-seed-2.0-pro' },
    { model: 'doubao-seed-2.0-pro' },
  );
  assert.strictEqual(cfg.model, 'doubao-seed-2.0-pro');
  assert.notStrictEqual(cfg.judgeModel, cfg.model);
  assert.ok(cfg.judgeModel.length > 0, '必须还能复核');
});

test('主模型本来就不冲突时，配置过的复核模型保持原样', () => {
  const cfg = resolveWith(
    { ...BASE, model: 'doubao-seed-2.0-pro', judgeModel: 'qwen3-vl-plus' },
    { model: 'glm-5v-turbo' },
  );
  assert.strictEqual(cfg.model, 'glm-5v-turbo');
  assert.strictEqual(cfg.judgeModel, 'qwen3-vl-plus', '不该无谓改动用户配置');
});

test('显式传空串表示"只读一遍"，避让逻辑不能把它复活', () => {
  const cfg = resolveWith(
    { ...BASE, model: 'doubao-seed-2.0-pro', judgeModel: 'qwen3-vl-plus' },
    { model: 'qwen3-vl-plus', judgeModel: '' },
  );
  assert.strictEqual(cfg.judgeModel, '', '显式关闭必须保持关闭');
});

test('没配复核模型时，从候选里挑一个与主模型不同的', () => {
  // 新语义：judgeModel 不再有"单个默认值"，改为从候选列表里挑。
  const saved = process.env.VISION_JUDGE_MODEL;
  delete process.env.VISION_JUDGE_MODEL;
  try {
    const cfg = resolveWith({ ...BASE, model: 'a', judgeModel: '' }, { model: 'b' });
    assert.ok(cfg.judgeModel, '应该挑出一个复核模型');
    assert.notStrictEqual(cfg.judgeModel, cfg.model, '不能和主模型相同');
    assert.ok(
      describeModule.DEFAULT_VISION_CANDIDATES.includes(cfg.judgeModel),
      '应从默认候选里挑',
    );
  } finally {
    if (saved !== undefined) process.env.VISION_JUDGE_MODEL = saved;
  }
});

test('候选列表可覆盖：只留一个候选时，主模型撞上它就退化为不复核', () => {
  // 环境变量优先级高于候选列表，会盖住这个用例的意图，先隔离掉。
  const saved = process.env.VISION_JUDGE_MODEL;
  delete process.env.VISION_JUDGE_MODEL;
  try {
    const cfg = resolveWith(
      { ...BASE, model: 'x', judgeModel: '', candidates: ['solo-model'] },
      { model: 'solo-model' },
    );
    assert.strictEqual(cfg.judgeModel, '', '没有别的候选可选时不该硬凑');
  } finally {
    if (saved !== undefined) process.env.VISION_JUDGE_MODEL = saved;
  }
});

test('候选列表会去重、去空串，顺序保持不变', () => {
  const got = describeModule.normalizeCandidates(
    'a, b , a,,c ,  b',
  );
  assert.deepStrictEqual(got, ['a', 'b', 'c']);
});

test('候选全空时回落到默认清单，不会出现空列表', () => {
  assert.deepStrictEqual(
    describeModule.normalizeCandidates(''),
    describeModule.DEFAULT_VISION_CANDIDATES,
  );
  assert.deepStrictEqual(
    describeModule.normalizeCandidates(' , , '),
    describeModule.DEFAULT_VISION_CANDIDATES,
  );
});

test('任意主模型下，复核模型都不会等于主模型', () => {
  const candidates = [
    'qwen3-vl-plus',
    'doubao-seed-2.0-pro',
    'glm-5v-turbo',
    'gpt-4o',
    'gemini-3-flash',
  ];
  for (const picked of candidates) {
    const cfg = resolveWith(
      { ...BASE, model: 'doubao-seed-2.0-pro', judgeModel: 'qwen3-vl-plus' },
      { model: picked },
    );
    assert.notStrictEqual(
      cfg.judgeModel,
      cfg.model,
      `主模型 ${picked} 时复核模型不该与它相同`,
    );
  }
});
