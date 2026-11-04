'use strict';
// 回归测试：结构图的两个 P0 缺陷。
//
// 缺陷 1（造边）：parseGraph 把"被丢弃的中间节点"短路掉，把前驱直接接到后继。
//   本意是保住主干（Patch Embedding → 0…9 → Encoder 不断开），但对组织架构图
//   这种"图上编号被当噪声丢掉"的情况，会凭空造出一条原图不存在的汇报线。
//   实测样本：营销管理办公室 → [1] → 用户体验设计部 被短路成
//   营销管理办公室 → 用户体验设计部。造边的危害远大于缺节点：缺节点看得出来，
//   多一条线看不出来。
//
// 缺陷 2（静默裁剪）：超过 28 节点 / 48 边或渲染超 860 字符时按叶子裁剪，
//   但被裁掉多少节点、名字被截断多少，结果里一个数都没有。人工核对时无从判断
//   这张图是全的还是一半的。
//
// 本文件锁住：造出来的边必须被标记成 speculated，裁剪与截断必须计数。

const test = require('node:test');
const assert = require('node:assert');

const mod = require('../skills/docchain-image-describe/scripts/describe_images.js');

// ---------------------------------------------------------------------------
// 缺陷 1：短路造边
// ---------------------------------------------------------------------------

test('短路产生的边必须标记为 speculated，不能冒充原图的确定关系', () => {
  const graph = mod.parseGraph(
    JSON.stringify({
      nodes: [
        { id: 'a', label: '营销管理办公室' },
        { id: 'n1', label: '1' }, // 纯数字编号，会被当成噪声丢掉
        { id: 'b', label: '用户体验设计部' },
        { id: 'c', label: '产品规划部' },
        { id: 'd', label: '市场运营部' },
        { id: 'e', label: '技术研发部' },
      ],
      edges: [
        { from: 'a', to: 'n1' },
        { from: 'n1', to: 'b' },
        { from: 'b', to: 'c' },
        { from: 'c', to: 'd' },
        { from: 'd', to: 'e' },
      ],
    }),
  );
  assert.ok(graph, '应该能解析出图');

  // 编号节点被丢掉了（这是既有行为，不改）
  assert.strictEqual(
    graph.nodes.some((n) => n.label === '1'),
    false,
    '编号节点仍应被丢弃',
  );

  // 关键：a→b 这条边是短路造出来的，必须带 speculated 标记
  const shorted = graph.edges.find((e) => e.from === 'a' && e.to === 'b');
  assert.ok(shorted, '短路仍然要保住主干（a→b 存在）');
  assert.strictEqual(shorted.speculated, true, '短路造出来的边必须标记 speculated');

  // 原图本来就有的边不能带 speculated
  const real = graph.edges.find((e) => e.from === 'b' && e.to === 'c');
  assert.ok(real, '原图的边要保留');
  assert.notStrictEqual(real.speculated, true, '原图已有的边不该被标记成推测');
});

test('猜测边会被统计出来，方便人工核对', () => {
  const graph = mod.parseGraph(
    JSON.stringify({
      nodes: [
        { id: 'a', label: '营销管理办公室' },
        { id: 'n1', label: '2' },
        { id: 'b', label: '用户体验设计部' },
        { id: 'c', label: '产品规划部' },
        { id: 'd', label: '市场运营部' },
        { id: 'e', label: '技术研发部' },
      ],
      edges: [
        { from: 'a', to: 'n1' },
        { from: 'n1', to: 'b' },
        { from: 'b', to: 'c' },
        { from: 'c', to: 'd' },
        { from: 'd', to: 'e' },
      ],
    }),
  );
  assert.ok(graph);
  assert.strictEqual(graph.speculatedEdges, 1, '应统计出 1 条推测边');
});

test('渲染时猜测边用虚线，和确定关系区分开', () => {
  const puml = mod.renderPuml({
    title: 't',
    nodes: [
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B' },
      { id: 'c', label: 'C' },
    ],
    edges: [
      { from: 'a', to: 'b', speculated: true },
      { from: 'b', to: 'c' },
    ],
  });
  const edgeLines = puml.split('\n').filter((l) => l.includes('-->') || l.includes('..>'));
  const speculatedLine = edgeLines.find((l) => l.includes('..>'));
  const solidLine = edgeLines.find((l) => / --> /.test(l));
  assert.ok(speculatedLine, '推测边应渲染成虚线（..>）');
  assert.ok(solidLine, '确定边应保持实线（-->）');
});

test('没有短路时不会凭空多出 speculated 边', () => {
  const graph = mod.parseGraph(
    JSON.stringify({
      nodes: [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
        { id: 'c', label: 'C' },
        { id: 'd', label: 'D' },
      ],
      edges: [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'c' },
        { from: 'c', to: 'd' },
      ],
    }),
  );
  assert.ok(graph);
  assert.strictEqual(graph.speculatedEdges, 0, '没有短路就不该有推测边');
  assert.strictEqual(
    graph.edges.every((e) => !e.speculated),
    true,
    '所有边都是确定关系',
  );
});

// ---------------------------------------------------------------------------
// 缺陷 2：静默裁剪 / 静默截断
// ---------------------------------------------------------------------------

test('超过节点上限时裁剪要记账，不能静默', () => {
  // 造 40 个节点的树，超过 DIAGRAM_MAX_NODES(28)
  const nodes = [{ id: 'root', label: '根' }];
  const edges = [];
  for (let i = 1; i <= 39; i += 1) {
    nodes.push({ id: `n${i}`, label: `部门${i}` });
    edges.push({ from: i <= 8 ? 'root' : `n${Math.ceil((i - 8) / 4)}`, to: `n${i}` });
  }
  const shrunk = mod.shrinkGraph({ title: 't', nodes, edges });
  assert.ok(shrunk.nodes.length <= mod.DIAGRAM_MAX_NODES, '节点数应被裁到上限内');
  assert.ok(
    shrunk.removedNodes > 0,
    '被裁掉的节点数必须记下来，否则人工核对无从判断完整性',
  );
  assert.strictEqual(
    shrunk.removedNodes,
    nodes.length - shrunk.nodes.length,
    '记账数要等于实际裁掉的数量',
  );
});

test('未触发裁剪时不产生虚假的 removedNodes', () => {
  const shrunk = mod.shrinkGraph({
    title: 't',
    nodes: [
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B' },
      { id: 'c', label: 'C' },
    ],
    edges: [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
    ],
  });
  assert.strictEqual(shrunk.removedNodes, 0, '没裁剪就不该报被裁');
});

test('两段裁剪（节点上限 + 字符上限）的记账要累加，不能只报后一段', () => {
  // 50 节点的宽而浅组织架构图：先被节点上限裁到 28，再被 860 字符上限继续裁。
  const nodes = [{ id: 'root', label: '云智能经营中心' }];
  const edges = [];
  for (let i = 1; i <= 25; i += 1) {
    nodes.push({ id: `u${i}`, label: `单元${i}` });
    edges.push({ from: 'root', to: `u${i}` });
  }
  let team = 1;
  for (let i = 1; i <= 6; i += 1) {
    for (let k = 0; k < 4; k += 1) {
      nodes.push({ id: `t${team}`, label: `团队${team}` });
      edges.push({ from: `u${i}`, to: `t${team}` });
      team += 1;
    }
  }
  const stage1 = mod.shrinkGraph({ title: 't', nodes, edges });
  const stage2 = mod.fitGraph(stage1) || stage1;
  const actuallyRemoved = nodes.length - stage2.nodes.length;
  assert.strictEqual(
    stage2.removedNodes,
    actuallyRemoved,
    '累计被裁数必须等于原图节点数减去最终节点数',
  );
  assert.ok(stage2.removedNodes > stage1.removedNodes, '第二段还应继续增加记账');
});

test('推测边数在裁剪后按实际剩下的边重算', () => {
  const nodes = [{ id: 'root', label: '根' }];
  const edges = [];
  // 造一条会被裁掉的推测边（挂在深叶子下）
  for (let i = 1; i <= 40; i += 1) {
    nodes.push({ id: `n${i}`, label: `部门${i}` });
    edges.push({ from: i <= 8 ? 'root' : `n${Math.ceil((i - 8) / 4)}`, to: `n${i}` });
  }
  edges[edges.length - 1].speculated = true;
  const shrunk = mod.shrinkGraph({ title: 't', nodes, edges, speculatedEdges: 1 });
  const remainingSpeculated = shrunk.edges.filter((e) => e.speculated).length;
  assert.strictEqual(
    shrunk.speculatedEdges,
    remainingSpeculated,
    '推测边数应等于裁剪后实际带标记的边数',
  );
});