'use strict';
// 视觉 Key 的检查时机。
//
// 曾经有个冤枉人的行为：Key 检查写在 run() 最前面，于是**对话模型本身就能读图**时，
// 用户照样被"视觉模型 Key 未配置"挡住 —— 而他根本不需要那个 Key。
//
// 正确口径：
//   · 对话模型能读图          → 不查 Key，直接用
//   · 不读图的操作            → 不查 Key（list_models 除外，它必须拉清单）
//   · 要读图且要借视觉模型    → 查 Key，没有就明确告诉他配哪儿

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'tools', 'docchain.js'), 'utf8');

/**
 * 取出**图片描述工具**的 run() 函数体。
 *
 * 这个文件里有 9 个工具，每个都有自己的 `async run(args, exec)`；
 * 不能取第一个 —— 按"函数体里出现 getCurrentSessionModel"这个特征定位。
 */
function runBody() {
  const marker = 'async run(args, exec) {';
  let from = 0;
  for (;;) {
    const start = SRC.indexOf(marker, from);
    assert.ok(start > 0, '找不到图片描述工具的 run()');
    let i = start + marker.length - 1;
    let depth = 0;
    let body = '';
    for (; i < SRC.length; i += 1) {
      if (SRC[i] === '{') depth += 1;
      else if (SRC[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          body = SRC.slice(start, i + 1);
          break;
        }
      }
    }
    if (body.includes('getCurrentSessionModel(exec)')) return body;
    from = start + marker.length;
  }
}

const BODY = runBody();

test('先读对话模型，Key 检查在它之后', () => {
  const modelAt = BODY.indexOf('getCurrentSessionModel(exec)');
  const keyAt = BODY.indexOf('if (needsVisionGateway && !visionConfig.key)');
  assert.ok(modelAt > 0, '应读取会话模型');
  assert.ok(keyAt > 0, '应有 Key 检查');
  assert.ok(modelAt < keyAt, '读模型必须早于 Key 检查');
});

test('对话模型能读图时不要求视觉 Key', () => {
  // isVis === true → needsVisionGateway = false
  assert.match(
    BODY,
    /isVis === true\)\s*needsVisionGateway = false/,
    '确认对话模型能读图后必须跳过 Key 检查',
  );
});

test('不读图的操作不查 Key', () => {
  assert.match(BODY, /!args\.read/, 'read 不该要求视觉 Key');
  assert.match(BODY, /!isCandidates/, 'candidates 不该要求视觉 Key');
  assert.match(BODY, /!isPreview/, 'preview 不该要求视觉 Key');
});

test('list_models 在需要网关时要求 Key，但对话模型能读图时不拦', () => {
  // 早先写成 `if (args.list_models) needsVisionGateway = true` —— 无条件置真，
  // 于是"对话模型本身能读图"的人想看一次清单也被"Key 未配置"挡住，
  // 正是本文件最上面记的那个老毛病在 list_models 上又犯了一遍。
  //
  // 现在的口径：list_models 要拉清单确实得有 Key，但**只有**在对话模型
  // 不能读图（isVis !== true）时才需要。
  assert.match(
    BODY,
    /if \(wantsModelList && isVis !== true\) needsVisionGateway = true/,
    'list_models 应仅在对话模型不能读图时要求 Key',
  );
  assert.ok(
    !/if \(args\.list_models\) needsVisionGateway = true/.test(BODY),
    '旧的无条件写法必须删除',
  );
  // 能力校验必须覆盖 list_models，否则 isVis 恒为 null，"能读图"永远判不出来
  assert.match(
    BODY,
    /if \(\(needsVision \|\| wantsModelList\) && resolvedModel\)/,
    'list_models 也要做能力校验',
  );
});

test('能力校验只做一次（不重复拉 /models）', () => {
  // 早先 needsVision 分支和 Key 分支各调一次 isModelVision，一次调用拉两遍清单。
  const calls = BODY.match(/await isModelVision\(/g) || [];
  // 自由输入的模型还要单独校验一次，所以允许 2 处，但主判定不能重复
  assert.ok(calls.length <= 2, `isModelVision 调用过多：${calls.length}`);
  assert.ok(
    !/let isVis = null;[\s\S]*?let isVis = null;/.test(BODY),
    'isVis 不应重复声明',
  );
});

test('确实要借视觉模型但没 Key 时，报错要指明配哪儿', () => {
  // 走过确定"要借模型"的那条分支后，若还没 Key，错误信息必须包含配置指引
  const seg = BODY.slice(BODY.indexOf('if (isVis !== true)'));
  assert.match(seg, /不能确认支持读图/, '应说明为什么需要 Key');
  assert.match(seg, /IWHALE_API_KEY|keyRef/, '应指明配哪个凭据');
  assert.match(seg, /能读图的模型|对话模型下拉/, '应给出"换模型"这条替代路径');
});

test('只有"确定能读图"才放行，查不到也弹窗（白名单口径）', () => {
  // 口径变化：早先是 isVis === false 才弹窗，null（查不到）直接放行。
  // 实测出过事：对话模型 deepseek-flash 不在网关清单 → 判 null → 不弹窗 →
  // 拿它发请求 404 → 静默降级到 g-deepseek-v4-flash 读图，用户全程没参与选型。
  //
  // 现在改成白名单：isVis !== true 一律弹窗。
  assert.match(BODY, /if \(isVis !== true\) \{/, '必须用 isVis !== true 判定');
  assert.ok(!/if \(isVis === false\)/.test(BODY), '旧的 isVis === false 判定必须删除');
});

test('能读图时仍然直接放行，不打扰用户', () => {
  assert.match(BODY, /isVis === true\) needsVisionGateway = false/, '确认能读图应跳过 Key 检查');
});

test('入口不再无条件抛 Key 未配置', () => {
  // 旧写法：run() 一进来就 if (!visionConfig.key) throw
  const head = BODY.slice(0, BODY.indexOf('getCurrentSessionModel(exec)'));
  assert.ok(
    !/if \(!visionConfig\.key\)/.test(head),
    'run() 入口不应再无条件检查 Key',
  );
});
