'use strict';
// 回归测试：平级分组（groups）与「不看图重述」自检。
//
// 背景：组织架构图最常见、也最顽固的错法不是漏节点，而是**把并列读成上下级**。
// 真实样本：一个事业群下面挂 6 个办公室 + 20 条产品线，全平级、全不带箭头，
// 模型按"从上往下念"连成一条链，或者把产品线挂到第一个办公室下面。
// 节点数一个不少，所以 boxCount / under_read / missing_from_primary 全都看不见。
//
// 两个对策：
//   A 分组：逼模型在出 JSON 时先把平级的一批框圈出来，等于强制它回答
//     "这些是兄弟还是上下级"。圈成组后渲染进 package{}，组内互连直接算可疑。
//   B 自检：只把产物结构给模型看（不给图），让它复述"谁归谁管"。
//     模型读版面会错，但读文字几乎不会 —— 用强项校验弱项。
//
// 本文件锁住：分组校验口径、package 渲染、组内互连计数、自检结果解析。

const test = require('node:test');
const assert = require('node:assert');

const mod = require('../skills/docchain-image-describe/scripts/describe_images.js');

// ---------------------------------------------------------------------------
// A. 分组解析
// ---------------------------------------------------------------------------

test('正常分组被保留', () => {
  const nodes = [
    { id: 'a', label: 'A' },
    { id: 'b', label: 'B' },
    { id: 'c', label: 'C' },
  ];
  const groups = mod.parseGroups([{ label: '平级组', members: ['a', 'b'] }], nodes);
  assert.strictEqual(groups.length, 1);
  assert.deepStrictEqual(groups[0].members, ['a', 'b']);
  assert.strictEqual(groups[0].label, '平级组');
});

test('成员不足 2 个的组被丢弃（一个框不构成分组）', () => {
  const nodes = [
    { id: 'a', label: 'A' },
    { id: 'b', label: 'B' },
  ];
  assert.deepStrictEqual(mod.parseGroups([{ label: 'x', members: ['a'] }], nodes), []);
  assert.deepStrictEqual(mod.parseGroups([{ label: 'x', members: [] }], nodes), []);
});

test('不在节点表里的成员被剔除，剔完不足 2 个就丢整组', () => {
  const nodes = [
    { id: 'a', label: 'A' },
    { id: 'b', label: 'B' },
  ];
  const groups = mod.parseGroups([{ label: 'x', members: ['a', 'ghost'] }], nodes);
  assert.deepStrictEqual(groups, [], 'a + 不存在的 ghost 只剩 1 个，整组不要');
});

test('同一个节点属于两个组时，后一组整组丢弃（说明模型没想清楚）', () => {
  const nodes = [
    { id: 'a', label: 'A' },
    { id: 'b', label: 'B' },
    { id: 'c', label: 'C' },
  ];
  const groups = mod.parseGroups(
    [
      { label: '第一组', members: ['a', 'b'] },
      { label: '第二组', members: ['b', 'c'] }, // b 已被认领
    ],
    nodes,
  );
  assert.strictEqual(groups.length, 1);
  assert.strictEqual(groups[0].label, '第一组');
});

test('组内重复成员被去重', () => {
  const nodes = [
    { id: 'a', label: 'A' },
    { id: 'b', label: 'B' },
  ];
  const groups = mod.parseGroups([{ label: 'x', members: ['a', 'b', 'a', 'b'] }], nodes);
  assert.deepStrictEqual(groups[0].members, ['a', 'b']);
});

test('groups 不是数组 / 是 null 时返回空数组，不抛异常', () => {
  assert.deepStrictEqual(mod.parseGroups(undefined, []), []);
  assert.deepStrictEqual(mod.parseGroups(null, []), []);
  assert.deepStrictEqual(mod.parseGroups('oops', []), []);
  assert.deepStrictEqual(mod.parseGroups([null, 3, 'x'], [{ id: 'a', label: 'A' }]), []);
});

// ---------------------------------------------------------------------------
// A. 组内互连计数（组是兄弟，兄弟之间不该有隶属线）
// ---------------------------------------------------------------------------

test('组内连线被计数，跨组连线不算', () => {
  const groups = [
    { label: '组1', members: ['a', 'b'] },
    { label: '组2', members: ['c', 'd'] },
  ];
  const edges = [
    { from: 'a', to: 'b' }, // 组内
    { from: 'c', to: 'd' }, // 组内
    { from: 'a', to: 'c' }, // 跨组，不算
    { from: 'root', to: 'a' }, // 来自组外上级，不算
  ];
  const result = mod.countGroupInnerEdges(groups, edges);
  assert.strictEqual(result.groups, 2);
  assert.strictEqual(result.edges, 2);
});

test('没有组内连线时不报', () => {
  const groups = [{ label: '组1', members: ['a', 'b'] }];
  const edges = [{ from: 'root', to: 'a' }];
  const result = mod.countGroupInnerEdges(groups, edges);
  assert.strictEqual(result.groups, 0);
  assert.strictEqual(result.edges, 0);
});

// ---------------------------------------------------------------------------
// A. 渲染成 package{}
// ---------------------------------------------------------------------------

test('分组渲染成 package{}，组内成员在包里声明', () => {
  const graph = {
    title: '',
    nodes: [
      { id: 'root', label: '事业群' },
      { id: 'a', label: '产品线1' },
      { id: 'b', label: '产品线2' },
    ],
    edges: [
      { from: 'root', to: 'a' },
      { from: 'root', to: 'b' },
    ],
    groups: [{ label: '平级产品线', members: ['a', 'b'] }],
  };
  const puml = mod.renderPuml(graph);
  assert.match(puml, /package "平级产品线" \{/);
  // 两个成员都要在 package 块内部
  const block = puml.slice(puml.indexOf('package "平级产品线" {'));
  const closed = block.indexOf('}');
  assert.ok(block.slice(0, closed).includes('产品线1'), '产品线1 应在 package 内');
  assert.ok(block.slice(0, closed).includes('产品线2'), '产品线2 应在 package 内');
  // root 不在任何组里，应在 package 块之外声明
  const afterPackage = puml.slice(puml.indexOf('}') + 1);
  assert.ok(afterPackage.includes('事业群'), '组外的节点应声明在 package 之外');
  assert.match(puml, /@enduml/);
});

test('没有 groups 时渲染结果与原来一致（不引入 package）', () => {
  const graph = {
    title: '',
    nodes: [
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B' },
    ],
    edges: [{ from: 'a', to: 'b' }],
  };
  const puml = mod.renderPuml(graph);
  assert.doesNotMatch(puml, /package/);
  assert.match(puml, /rectangle "A" as n1/);
  assert.match(puml, /n1 --> n2/);
});

test('组里包含已不存在的节点时不会渲染出空 package', () => {
  const graph = {
    title: '',
    nodes: [
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B' },
    ],
    edges: [{ from: 'a', to: 'b' }],
    // 只有一个成员真实存在 → 组无效 → 不渲染 package
    groups: [{ label: '残组', members: ['a', 'ghost'] }],
  };
  const puml = mod.renderPuml(graph);
  assert.doesNotMatch(puml, /package "残组"/);
});

// ---------------------------------------------------------------------------
// B. 自检
// ---------------------------------------------------------------------------

test('自检提示词包含层级信息且明确不给图', () => {
  const graph = {
    title: '',
    nodes: [
      { id: 'root', label: '事业群' },
      { id: 'a', label: '办公室A' },
      { id: 'b', label: '产品线X' },
    ],
    edges: [
      { from: 'root', to: 'a' },
      { from: 'a', to: 'b' },
    ],
    groups: [{ label: '平级组', members: ['a', 'b'] }],
  };
  const prompt = mod.buildCheckPrompt(graph);
  assert.match(prompt, /你看不到原图/);
  assert.match(prompt, /事业群 的直接下级（1 个）：办公室A/);
  assert.match(prompt, /平级分组「平级组」/);
  assert.match(prompt, /OK/);
  assert.match(prompt, /PROBLEM/);
});

test('自检结果：OK 判无问题', () => {
  assert.deepStrictEqual(mod.parseCheckResult('OK'), { problem: false, detail: '' });
  assert.deepStrictEqual(mod.parseCheckResult('`OK`'), { problem: false, detail: '' });
  assert.strictEqual(mod.parseCheckResult('  OK  ').problem, false);
});

test('自检结果：PROBLEM 判有问题并带回原文', () => {
  const result = mod.parseCheckResult('PROBLEM\n经营管理办公室挂了 20 个下级，明显是把平级连成了链。');
  assert.strictEqual(result.problem, true);
  assert.match(result.detail, /经营管理办公室/);
});

test('自检结果：中文否定式回答不算问题', () => {
  assert.strictEqual(mod.parseCheckResult('没有发现问题').problem, false);
  assert.strictEqual(mod.parseCheckResult('无异常').problem, false);
});

test('自检结果：空回答按无问题处理（不因自检失败就去告警）', () => {
  assert.strictEqual(mod.parseCheckResult('').problem, false);
  assert.strictEqual(mod.parseCheckResult(null).problem, false);
});

test('自检结果：首词不是 OK 的其它回答按有问题处理（保守）', () => {
  // 模型没按约定回答时，宁可当"可能有问题"提醒人看一眼，也不静默放过
  assert.strictEqual(mod.parseCheckResult('第 1 问：有，经营管理办公室').problem, true);
});

// ---------------------------------------------------------------------------
// 集成：parseGraph 要把 groups 和组内互连都挂上
// ---------------------------------------------------------------------------

test('parseGraph 解析 groups 并统计组内互连', () => {
  const nodes = [
    { id: 'root', label: '事业群' },
    { id: 'a', label: '产品线1' },
    { id: 'b', label: '产品线2' },
    { id: 'c', label: '产品线3' },
  ];
  const edges = [
    { from: 'root', to: 'a' },
    { from: 'root', to: 'b' },
    { from: 'root', to: 'c' },
    // 组内互连：模型自己圈了平级组，却还给了 a→b 的隶属线
    { from: 'a', to: 'b' },
  ];
  const graph = mod.parseGraph(
    JSON.stringify({
      title: '',
      boxCount: 4,
      nodes,
      edges,
      groups: [{ label: '产品线组', members: ['a', 'b', 'c'] }],
    }),
  );
  assert.ok(graph);
  assert.strictEqual(graph.groups.length, 1);
  assert.strictEqual(graph.groups[0].label, '产品线组');
  assert.strictEqual(graph.groupsWithInnerEdges.groups, 1);
  assert.strictEqual(graph.groupsWithInnerEdges.edges, 1);
});

test('没有 groups 时 parseGraph 给出空数组而不是 undefined', () => {
  const graph = mod.parseGraph(
    JSON.stringify({
      title: '',
      boxCount: 2,
      nodes: [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
        { id: 'c', label: 'C' },
      ],
      edges: [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'c' },
      ],
    }),
  );
  assert.ok(graph);
  assert.deepStrictEqual(graph.groups, []);
  assert.strictEqual(graph.groupsWithInnerEdges.groups, 0);
});

test('分组阈值常量存在且有默认值', () => {
  assert.strictEqual(mod.DIAGRAM_GROUP_MIN_MEMBERS, 2);
});
