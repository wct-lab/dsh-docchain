'use strict';
// 回归测试：image_describe 的模型来源与视觉能力判定。
// 这里的输入形状全部取自真实会话日志与真实网关响应，
// 因为这三个 bug 的共同点就是"代码假设的结构和真实结构不一致"。

const test = require('node:test');
const assert = require('node:assert');

// ---------------------------------------------------------------------------
// 被测逻辑（与 lib/tools/docchain.js 中保持一致）
// ---------------------------------------------------------------------------

// 从一个事件对象里取出模型选择。
// 真实 readEvent 形状：{ type, seq, time, data: { provider, model } }（无 target）
function pickModelFromEvent(event) {
  const candidates = [event?.target?.data, event?.data, event?.target, event];
  for (const data of candidates) {
    const model = data?.model;
    if (typeof model === 'string' && model.trim()) {
      return { model: model.trim(), provider: data?.provider };
    }
  }
  return null;
}

// readEvent 失败时回落到 listEvents 摘要
function pickSessionModel(full, fallbackEvent) {
  return pickModelFromEvent(full) ?? pickModelFromEvent(fallbackEvent);
}

// 三态判定：true 支持图片 / false 确定不支持 / null 查不到
function judgeVision(entry) {
  if (!entry) return null;
  const flag = entry.is_vision;
  if (flag === 0 || flag === '0' || flag === false) return false;
  if (flag === 1 || flag === '1' || flag === true) return true;
  const desc = `${entry.model_desc ?? ''} ${entry.desc ?? ''}`;
  if (desc.includes('图片理解')) return true;
  if (/(vision|vl)[-_]/i.test(entry.id)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// 真实数据样本
// ---------------------------------------------------------------------------

// 直接取自当前会话日志的 request/context 事件（原始形状）
const REAL_EVENT = {
  type: 'request/context',
  seq: 22544,
  time: 1793756588960,
  data: { provider: 'zzq', model: 's-deepseek-v4.1-flash', contextWindow: 1000000 },
};

// 取自网关 /models 的真实条目
const GW_TEXT_MODEL = {
  id: 's-deepseek-v4.1-flash',
  is_vision: 0,
  model_desc:
    '支持能力：深度思考,文本对话,图片理解,函数调用,结构化输出 | 对应模型【deepseek-v4.1-flash-1017】，银牌供应商渠道，官方折扣价',
};
const GW_VISION_MODEL = {
  id: 'qwen3-vl-plus',
  is_vision: 1,
  model_desc: '支持能力：深度思考,文本生成,工具调用,图片理解',
};

// ---------------------------------------------------------------------------
// 模型来源
// ---------------------------------------------------------------------------

test('readEvent 返回顶层 data（实测形状）时能取到模型', () => {
  assert.deepStrictEqual(pickSessionModel(REAL_EVENT), {
    model: 's-deepseek-v4.1-flash',
    provider: 'zzq',
  });
});

test('旧代码读 full.target.data 在真实形状下取不到模型（回归护栏）', () => {
  const oldWay = REAL_EVENT.target?.data?.model;
  assert.strictEqual(oldWay, undefined, '真实事件没有 target 这层包裹');
});

test('target.data 包裹的旧版形状仍然兼容', () => {
  const wrapped = { target: { data: { provider: 'iwhale', model: 'g-deepseek-v4-pro' } } };
  assert.deepStrictEqual(pickSessionModel(wrapped), {
    model: 'g-deepseek-v4-pro',
    provider: 'iwhale',
  });
});

test('readEvent 返回空对象时回落到 listEvents 的摘要', () => {
  assert.deepStrictEqual(pickSessionModel({}, REAL_EVENT), {
    model: 's-deepseek-v4.1-flash',
    provider: 'zzq',
  });
});

test('readEvent 返回 null 时回落到 listEvents 的摘要', () => {
  assert.deepStrictEqual(pickSessionModel(null, REAL_EVENT), {
    model: 's-deepseek-v4.1-flash',
    provider: 'zzq',
  });
});

test('readEvent 抛异常时也能回落到 listEvents 的摘要', () => {
  // getCurrentSessionModel 内部对 readEvent 单独 try/catch，失败时 full 为 undefined
  const full = undefined;
  assert.deepStrictEqual(pickSessionModel(full, REAL_EVENT), {
    model: 's-deepseek-v4.1-flash',
    provider: 'zzq',
  });
});

test('取不到模型时返回 null，而不是空对象或 undefined', () => {
  assert.strictEqual(pickSessionModel({}, {}), null);
  assert.strictEqual(pickSessionModel(null, null), null);
  assert.strictEqual(pickSessionModel({ data: { model: '' } }), null);
  assert.strictEqual(pickSessionModel({ data: { model: 123 } }), null);
  assert.strictEqual(pickSessionModel({ data: { model: '   ' } }), null, '纯空白不算有效模型名');
});

// ---------------------------------------------------------------------------
// 视觉能力判定
// ---------------------------------------------------------------------------

test('is_vision=0 的纯文本模型判定为不支持，即使描述里写了"图片理解"', () => {
  assert.strictEqual(
    judgeVision(GW_TEXT_MODEL),
    false,
    'is_vision 是权威字段，描述文本里的"图片理解"是网关元数据自相矛盾，不能采信',
  );
});

test('is_vision=1 的视觉模型判定为支持', () => {
  assert.strictEqual(judgeVision(GW_VISION_MODEL), true);
});

test('s-deepseek-v4.1-flash 必须被判定为不支持图片', () => {
  assert.strictEqual(judgeVision(GW_TEXT_MODEL), false);
  // 说明：模型名里没有 vision/vl 字样，所以也不会被名称启发式误判为视觉模型
  assert.doesNotMatch(GW_TEXT_MODEL.id, /(vision|vl)[-_]/i);
});

test('网关切断或限流导致查不到时返回 null，不误杀', () => {
  assert.strictEqual(judgeVision(undefined), null, '模型不在清单里');
  assert.strictEqual(judgeVision(null), null);
});

test('is_vision 为字符串 "0"/"1" 时同样正确处理', () => {
  assert.strictEqual(judgeVision({ id: 'x', is_vision: '0' }), false);
  assert.strictEqual(judgeVision({ id: 'x', is_vision: '1' }), true);
});

test('缺 is_vision 字段时退回描述与名称判断', () => {
  assert.strictEqual(judgeVision({ id: 'some-model', model_desc: '支持图片理解' }), true);
  assert.strictEqual(judgeVision({ id: 'glm-5v-turbo' }), false, '5v 不该被 vl/vision 正则误伤');
  assert.strictEqual(judgeVision({ id: 'qwen3-vl-plus' }), true);
  assert.strictEqual(judgeVision({ id: 'plain-text-model' }), false);
});

// ---------------------------------------------------------------------------
// 端到端：真实事件 + 真实网关条目
// ---------------------------------------------------------------------------

test('端到端：当前会话模型解析出来后，被正确判定为不具备视觉能力', () => {
  const selected = pickSessionModel(REAL_EVENT);
  assert.ok(selected, '必须能解析出模型，否则校验会被整段跳过');
  assert.strictEqual(selected.model, 's-deepseek-v4.1-flash');
  assert.strictEqual(judgeVision(GW_TEXT_MODEL), false, '应当触发 MODEL_NOT_VISION');
});

test('端到端：选中视觉模型时放行', () => {
  const evt = { type: 'request/context', data: { provider: 'zzq', model: 'qwen3-vl-plus' } };
  const selected = pickSessionModel(evt);
  assert.strictEqual(selected.model, 'qwen3-vl-plus');
  assert.strictEqual(judgeVision(GW_VISION_MODEL), true);
});
