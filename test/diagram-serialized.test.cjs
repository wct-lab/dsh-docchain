'use strict';
// 回归测试：「平级兄弟被读成一条链」的检测。
//
// 真实样本（一张组织架构图）：一个事业群下面挂 6 个办公室 + 20 条产品线，全部平级、
// 全部不带箭头（部门名竖排在色条里）。模型按"名字从上往下念"的顺序连，得到
//   事业群 → 办公室1 → 办公室2 → … → 产品线1 → 产品线2 → …
// 即每条线只连一个下属。后果不是漏画，而是**归属关系整体读反**：
// 20 条产品线全挂到了最后一个办公室下面。
//
// 关键点：这种错节点数是对的、线也全都在，所以 boxCount 自检、
// under_read、missing_from_primary 这些基于"数量"的检查全都发现不了。
// 只能靠结构指纹：
//   ① 一个父节点扇出 ≥5；
//   ② 这些子节点绝大多数（≥80%）是叶子；
//   ③ 叶子之间还有 ≥3 条互连 —— 兄弟之间不该有上下级边。
//
// 本文件锁住：真错要报，正常树要放行，规模太小不许报。

const test = require('node:test');
const assert = require('node:assert');

const mod = require('../skills/docchain-image-describe/scripts/describe_images.js');

/** 把 [{id,label}]、[[from,to]] 组成合法的 graph 对象。 */
function graphOf(labels, edges) {
  const nodes = Object.keys(labels).map((id) => ({ id, label: labels[id] }));
  return {
    title: '',
    nodes,
    edges: edges.map(([from, to]) => ({ from, to, label: '' })),
  };
}

/** 事业群连到 6 个办公室 + 20 条产品线，但这些下属之间又被串成了一条链（真实错法）。 */
function serializedOrgChart() {
  const labels = { boss: '数字政府及综合行业事业群' };
  const edges = [];
  const order = [];
  for (let i = 1; i <= 6; i += 1) {
    labels[`o${i}`] = `办公室${i}`;
    edges.push(['boss', `o${i}`]);
    order.push(`o${i}`);
  }
  for (let i = 1; i <= 20; i += 1) {
    labels[`p${i}`] = `产品线${i}`;
    edges.push(['boss', `p${i}`]);
    order.push(`p${i}`);
  }
  // 真实错法：扇出本身是对的，但模型额外按"从上念到下"把兄弟串成一条链。
  for (let i = 0; i < order.length - 1; i += 1) edges.push([order[i], order[i + 1]]);
  return graphOf(labels, edges);
}

/** 同样 26 个下属，但正确地"各连一条"到上级。 */
function correctOrgChart() {
  const labels = { boss: '数字政府及综合行业事业群' };
  const edges = [];
  for (let i = 1; i <= 6; i += 1) {
    labels[`o${i}`] = `办公室${i}`;
    edges.push(['boss', `o${i}`]);
  }
  for (let i = 1; i <= 20; i += 1) {
    labels[`p${i}`] = `产品线${i}`;
    edges.push(['boss', `p${i}`]);
  }
  return graphOf(labels, edges);
}

// ---------------------------------------------------------------------------
// 报：真实的串链错
// ---------------------------------------------------------------------------

test('平级兄弟被串成一条链时，必须被检测出来', () => {
  const found = mod.detectSerializedSiblings(serializedOrgChart());
  assert.ok(found, '这种错必须报，否则会静默产出错误层级');
  assert.strictEqual(found.parentLabel, '数字政府及综合行业事业群');
  assert.strictEqual(found.childCount, 26);
  // 26 个兄弟串成一条链 = 25 条假边
  assert.strictEqual(found.chainEdges, 25);
});

test('相邻兄弟串联（最常见的形态）也必须报', () => {
  // 一张小规模的：1 个父 + 8 个兄弟，父连全部 8 个，8 个兄弟又被串成一条链。
  // 这是模型"既画了正确的扇出，又多画了链"的混合形态 —— 干净数据里最典型的错法。
  const labels = { root: '总中心' };
  const edges = [];
  for (let i = 1; i <= 8; i += 1) {
    labels[`c${i}`] = `部门${i}`;
    edges.push(['root', `c${i}`]);
  }
  for (let i = 1; i <= 7; i += 1) edges.push([`c${i}`, `c${i + 1}`]);
  const found = mod.detectSerializedSiblings(graphOf(labels, edges));
  assert.ok(found, '扇出 8、兄弟串成 7 条链，必须报');
  assert.strictEqual(found.childCount, 8);
  assert.strictEqual(found.chainEdges, 7);
});

test('只串了一小部分兄弟（不到 8 成）不报，那是局部的分支关系', () => {
  // 8 个兄弟里只有 c1→c2→c3 这 3 个连着：可能是真的"部门1 管 部门2 管 部门3"，
  // 也可能是读错，但证据不够，报了会让正常的局部层级全变成告警。
  const labels = { root: '总中心' };
  const edges = [];
  for (let i = 1; i <= 8; i += 1) {
    labels[`c${i}`] = `部门${i}`;
    edges.push(['root', `c${i}`]);
  }
  edges.push(['c1', 'c2'], ['c2', 'c3'], ['c3', 'c1']);
  assert.strictEqual(mod.detectSerializedSiblings(graphOf(labels, edges)), null);
});

// ---------------------------------------------------------------------------
// 不报：正常结构
// ---------------------------------------------------------------------------

test('正确的组织架构图（各连一条）不许误报', () => {
  assert.strictEqual(mod.detectSerializedSiblings(correctOrgChart()), null);
});

test('小规模的链式流水线（A→B→C）不许误报', () => {
  // 处理流水线串成链是完全正常的写法，扇出小于 5 不能报。
  const graph = graphOf(
    { a: '输入', b: '编码', c: '解码', d: '输出' },
    [['a', 'b'], ['b', 'c'], ['c', 'd']],
  );
  assert.strictEqual(mod.detectSerializedSiblings(graph), null);
});

test('普通扇形分发的流程图不许误报', () => {
  // 一份输入分十几路，各自到叶子 —— 叶子之间不互连就是正常扇出。
  const labels = { in: '用户请求' };
  const edges = [];
  for (let i = 1; i <= 12; i += 1) {
    labels[`h${i}`] = `处理器${i}`;
    edges.push(['in', `h${i}`]);
  }
  assert.strictEqual(mod.detectSerializedSiblings(graphOf(labels, edges)), null);
});

test('兄弟之间只有一两条真业务协同线不许误报', () => {
  // 组织图里"研发一部"和"研发二部"之间确有一条协同线，是真实的，不能因此报串链。
  const labels = { root: '研发中心' };
  const edges = [];
  for (let i = 1; i <= 6; i += 1) {
    labels[`d${i}`] = `研发${i}部`;
    edges.push(['root', `d${i}`]);
  }
  edges.push(['d1', 'd2'], ['d3', 'd4']);
  assert.strictEqual(mod.detectSerializedSiblings(graphOf(labels, edges)), null);
});

test('深层树（子节点不是叶子）不许误报', () => {
  // 扇出大但每个子节点自己还有下属：那是正常的分层，兄弟互连也不构成"串链"指纹。
  const labels = { root: '总公司' };
  const edges = [];
  for (let i = 1; i <= 6; i += 1) {
    labels[`m${i}`] = `分公司${i}`;
    labels[`g${i}`] = `部门${i}`;
    edges.push(['root', `m${i}`], [`m${i}`, `g${i}`]);
  }
  edges.push(['m1', 'm2'], ['m2', 'm3'], ['m3', 'm4']);
  assert.strictEqual(mod.detectSerializedSiblings(graphOf(labels, edges)), null);
});

test('空图 / 非法输入返回 null，不抛异常', () => {
  assert.strictEqual(mod.detectSerializedSiblings(null), null);
  assert.strictEqual(mod.detectSerializedSiblings({}), null);
  assert.strictEqual(mod.detectSerializedSiblings({ nodes: [], edges: [] }), null);
});

test('纯长链（每个节点只有一个子节点）不在本规则管辖内', () => {
  // 一条 27 节的链，每节扇出都是 1：结构上跟"流水线"无法区分，
  // 硬报会把所有串行流程误伤成错图。这条规则只抓"扇出 + 兄弟串联"的混合形态。
  const labels = { n0: '起点' };
  const edges = [];
  for (let i = 1; i <= 26; i += 1) {
    labels[`n${i}`] = `第${i}节`;
    edges.push([`n${i - 1}`, `n${i}`]);
  }
  assert.strictEqual(mod.detectSerializedSiblings(graphOf(labels, edges)), null);
});

// ---------------------------------------------------------------------------
// 集成：parseGraph 必须把结论挂在图上；提示词必须带上两条新规则
// ---------------------------------------------------------------------------

test('parseGraph 会把串链结论挂在 serializedSiblings 上', () => {
  const nodes = [{ id: 'boss', label: '事业群' }];
  const edges = [];
  // boss 正确扇出到 7 个单元，但这些单元之间又被串成一条链
  const order = [];
  for (let i = 1; i <= 7; i += 1) {
    nodes.push({ id: `x${i}`, label: `单元${i}` });
    edges.push({ from: 'boss', to: `x${i}` });
    order.push(`x${i}`);
  }
  for (let i = 0; i < order.length - 1; i += 1) edges.push({ from: order[i], to: order[i + 1] });
  const graph = mod.parseGraph(JSON.stringify({ title: '', boxCount: 8, nodes, edges }));
  assert.ok(graph, 'parseGraph 不应返回 null');
  assert.ok(graph.serializedSiblings, '结论必须挂在图上，调用方才能汇总告警');
  assert.strictEqual(graph.serializedSiblings.parentLabel, '事业群');
});

test('parseGraph 对正确结构给出 serializedSiblings = null', () => {
  const nodes = [{ id: 'boss', label: '事业群' }];
  const edges = [];
  for (let i = 1; i <= 7; i += 1) {
    nodes.push({ id: `x${i}`, label: `单元${i}` });
    edges.push({ from: 'boss', to: `x${i}` });
  }
  const graph = mod.parseGraph(JSON.stringify({ title: '', boxCount: 8, nodes, edges }));
  assert.ok(graph);
  assert.strictEqual(graph.serializedSiblings, null);
});

test('结构图提示词必须包含"平级兄弟不许串成链"的两条规则', () => {
  const prompt = mod.buildPrompt('某组织架构', 1, 3, 'on');
  // 规则 10：一排小方框是同时属于上级，不是第一个管第二个
  assert.match(prompt, /不是"第一个管第二个、第二个管第三个"/);
  assert.match(prompt, /各连一条线过去/);
  // 规则 11：只有分隔线没有箭头时，方向是"上管下 / 左管右"
  assert.match(prompt, /没有箭头\*\*时/);
  assert.match(prompt, /上面管下面/);
});

test('关闭结构图时提示词不含这两条规则（走纯描述路径）', () => {
  const prompt = mod.buildPrompt('某文档', 1, 2, 'off');
  assert.doesNotMatch(prompt, /上面管下面/);
});

test('阈值常量有明确的默认值', () => {
  assert.strictEqual(mod.SERIAL_MIN_FANOUT, 5);
  assert.strictEqual(mod.SERIAL_MIN_CHAIN_EDGES, 3);
});
