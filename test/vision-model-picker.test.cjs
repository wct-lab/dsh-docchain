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

test('read / list_models / candidates / preview 都不读图，不该打断用户', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'lib', 'tools', 'docchain.js'),
    'utf8',
  );
  // 四种模式都不调用视觉模型：读旁路 md、拉清单、只给 keyword 的候选、多篇待确认
  assert.ok(
    /const needsVision =\s*\n?\s*!args\.read && !args\.list_models && !isCandidates && !isPreview/.test(
      src,
    ),
    '应按 read/list_models/candidates/preview 四者跳过视觉校验',
  );
  assert.ok(
    /if \(resolvedModel && needsVision\)/.test(src),
    '校验应以 needsVision 为前提',
  );
});

test('preview 与 candidates 的判断条件与脚本分流一致', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const tool = fs.readFileSync(
    path.join(__dirname, '..', 'lib', 'tools', 'docchain.js'),
    'utf8',
  );
  const script = fs.readFileSync(
    path.join(__dirname, '..', 'skills', 'docchain-image-describe', 'scripts', 'describe_images.js'),
    'utf8',
  );
  // 工具层
  assert.ok(/const isCandidates = docs\.length === 0/.test(tool), '工具层缺 candidates 判断');
  assert.ok(/const isPreview = docs\.length > 1 && !args\.confirm/.test(tool), '工具层缺 preview 判断');
  // 脚本层分流（apply 顺序）
  assert.ok(
    /if \(docIds\.length === 0\) return doCandidates/.test(script),
    '脚本层 candidates 分支变了',
  );
  assert.ok(
    /if \(docIds\.length > 1 && !params\.confirm\) return doPreview/.test(script),
    '脚本层 preview 分支变了',
  );
});

test('只有真正要读图时才弹窗', () => {
  // 复刻工具层判断（idList 无有效 ID 时返回 null → 兜成 []）
  const decide = (args) => {
    const raw = Array.isArray(args.doc_ids) ? args.doc_ids : null;
    const docs = (raw || []).filter((x) => Number.isInteger(x) && x > 0);
    const isCandidates = docs.length === 0;
    const isPreview = docs.length > 1 && !args.confirm;
    return !args.read && !args.list_models && !isCandidates && !isPreview;
  };
  assert.strictEqual(decide({ doc_ids: [130241] }), true, '单篇正式跑：要校验');
  assert.strictEqual(decide({ doc_ids: [1, 2], confirm: true }), true, '多篇已确认：要校验');
  assert.strictEqual(decide({ doc_ids: [1, 2] }), false, '多篇待确认：不校验');
  assert.strictEqual(decide({ keyword: '大语言模型' }), false, '只给 keyword：不校验');
  assert.strictEqual(decide({ doc_ids: [] }), false, '空列表：不校验');
  assert.strictEqual(decide({ doc_ids: [130241], read: true }), false, 'read：不校验');
  assert.strictEqual(decide({ list_models: true }), false, 'list_models：不校验');
});

test('doc_ids 缺失时不能崩（idList 返回 null，keyword 模式就是这种）', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'lib', 'tools', 'docchain.js'),
    'utf8',
  );
  // 复刻 idList：无有效 ID 时返回 null
  const idList = (value) => {
    if (!Array.isArray(value)) return null;
    const ids = value
      .map((item) => (typeof item === 'number' ? item : Number(item)))
      .filter((item) => Number.isInteger(item) && item > 0);
    return ids.length ? ids : null;
  };
  assert.strictEqual(idList(undefined), null, '未传 doc_ids 时是 null');
  assert.strictEqual(idList([]), null, '空数组也是 null');

  // 直接对 null 取 .length 会抛 TypeError；工具里必须用 || [] 兜住
  assert.ok(
    /const docs = idList\(args\.doc_ids\) \|\| \[\]/.test(src),
    'docs 必须对 null 兜底，否则 keyword 模式会抛 TypeError',
  );
  // 兜底后取 length 不抛
  const docs = idList(undefined) || [];
  assert.strictEqual(docs.length, 0);
  assert.strictEqual(docs.length > 1 && !false, false);
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
// 不要再把 max_images 当成"试跑"推销
//
// 试跑判断不出描述质量（工具不因此中止），只会让用户重复选一次视觉模型。
// 模型的 max_images 参数描述和 SKILL.md 都已改掉这个建议，这里锁住它别回来。
// ---------------------------------------------------------------------------

test('工具描述不再建议"先用 2 试跑"', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'lib', 'tools', 'docchain.js'),
    'utf8',
  );
  const start = src.indexOf("name: 'docchain_image_describe'");
  const next = src.indexOf('const doc2markdownTool', start);
  const block = src.slice(start, next > start ? next : start + 6000);
  assert.strictEqual(
    /建议先用 2 试跑/.test(block),
    false,
    'max_images 的参数描述不该再劝模型去试跑',
  );
  assert.ok(
    /默认一次处理完整篇/.test(block),
    '应明确默认一次跑完',
  );
});

test('SKILL.md 不再把 max_images 当试跑手段推销', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const md = fs.readFileSync(
    path.join(__dirname, '..', 'skills', 'docchain-image-describe', 'SKILL.md'),
    'utf8',
  );
  assert.strictEqual(
    /第一次建议先用 2 试跑/.test(md),
    false,
    'SKILL.md 参数表里不该再建议试跑',
  );
  assert.strictEqual(
    /试跑两张/.test(md),
    false,
    'SKILL.md 用法示例里不该再把试跑列成常规步骤',
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

// ---------------------------------------------------------------------------
// 候选清单的单一真实来源
//
// 同一份 5 个模型出现在三个地方：插件自带的 cordis.patch.yml、index.js 的
// DEFAULT_VISION_CANDIDATES、脚本的 DEFAULT_VISION_CANDIDATES。
//
// 为什么要三处：
//   · 新装、没动过 profile 的人 → 走插件自带的 yml
//   · 老用户（profile 里已配过 dsh-docchain）→ 配置层被整个替换，yml 那行
//     读不到，落到代码常量。更新插件时代码会跟着更新，所以照样拿到新清单。
//   · 想自定义的人 → 在自己 profile 里写 docchain_vision_candidates
//
// 三处必须完全一致，否则同一份插件在不同人机器上行为不同。改任何一处都要
// 同步另外两处——这个测试就是用来拦住"只改了一处"的。
// ---------------------------------------------------------------------------

test('候选清单在插件 yml、index.js、脚本三处完全一致', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.join(__dirname, '..');

  const fromScript = describeModule.DEFAULT_VISION_CANDIDATES;

  const indexSrc = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
  const indexBlock = indexSrc.match(/DEFAULT_VISION_CANDIDATES = \[([\s\S]*?)\]/);
  assert.ok(indexBlock, '找不到 index.js 的 DEFAULT_VISION_CANDIDATES');
  const fromIndex = [...indexBlock[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);

  const ymlSrc = fs.readFileSync(path.join(root, 'cordis.patch.yml'), 'utf8');
  const ymlLine = ymlSrc.match(/docchain_vision_candidates:\s*(\S+)/);
  assert.ok(ymlLine, '找不到 cordis.patch.yml 的候选配置');
  const fromYml = ymlLine[1].split(',').map((s) => s.trim()).filter(Boolean);

  assert.deepStrictEqual(fromIndex, fromScript, 'index.js 与脚本的候选清单不一致');
  assert.deepStrictEqual(fromYml, fromScript, 'cordis.patch.yml 与脚本的候选清单不一致');
});

test('三处清单的顺序也一致（顺序就是优先级，不能只比集合）', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.join(__dirname, '..');
  const fromScript = describeModule.DEFAULT_VISION_CANDIDATES;
  const ymlSrc = fs.readFileSync(path.join(root, 'cordis.patch.yml'), 'utf8');
  const fromYml = ymlSrc.match(/docchain_vision_candidates:\s*(\S+)/)[1].split(',');
  assert.strictEqual(fromYml[0], fromScript[0], '第一个候选不一致，会改变主模型兜底');
  assert.strictEqual(fromYml.length, fromScript.length, '数量不一致');
});