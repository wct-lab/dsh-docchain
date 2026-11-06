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
// 缺陷 1（已废弃）：短路造边
//
// 早先的做法：把被丢掉节点的前驱直接接到它的后继上，救主干，并标 speculated。
// 现在**彻底不造边**了 —— 见下方两段说明。
// ---------------------------------------------------------------------------

test('数字编号节点不再被丢弃，因此也不会触发任何拼接', () => {
  // 早先 `1` 会被当纯数字噪声丢掉，然后 a→1→b 被短路成 a→b（标 speculated）。
  // 现在 `1` 是节点：它可能真是编号，也可能是层宽/参数，无从分辨时保留更安全。
  const graph = mod.parseGraph(
    JSON.stringify({
      nodes: [
        { id: 'a', label: '营销管理办公室' },
        { id: 'n1', label: '1' },
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

  // 编号节点保留
  assert.strictEqual(
    graph.nodes.some((n) => n.label === '1'),
    true,
    '编号节点现在必须保留',
  );

  // 关键：a→b 这条"跳过了中间节点"的边**根本不该出现**
  assert.strictEqual(
    graph.edges.some((e) => e.from === 'a' && e.to === 'b'),
    false,
    '绝不能把 a→n1→b 拼成 a→b',
  );
  // 真实的 a→n1、n1→b 两段都在
  assert.ok(graph.edges.some((e) => e.from === 'a' && e.to === 'n1'));
  assert.ok(graph.edges.some((e) => e.from === 'n1' && e.to === 'b'));
});

test('悬空边直接丢弃，绝不拼接成推断边', () => {
  const graph = mod.parseGraph(
    JSON.stringify({
      nodes: [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
        { id: 'c', label: 'C' },
        { id: 'd', label: 'D' },
      ],
      edges: [
        { from: 'a', to: 'ghost' }, // ghost 不在节点表
        { from: 'ghost', to: 'b' },
        { from: 'b', to: 'c' },
        { from: 'c', to: 'd' },
        { from: 'a', to: 'd' },
      ],
    }),
  );
  assert.ok(graph);
  assert.strictEqual(graph.speculatedEdges, 0, '不再产生任何推断边');
  assert.strictEqual(
    graph.edges.some((e) => e.from === 'a' && e.to === 'b'),
    false,
    '不得把 a→ghost→b 拼成 a→b',
  );
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
  // 造 100 个节点的树，超过 DIAGRAM_MAX_NODES(60)
  const nodes = [{ id: 'root', label: '根' }];
  const edges = [];
  for (let i = 1; i <= 99; i += 1) {
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

test('两段裁剪的记账要累加，不能只报后一段', () => {
  // 上限放宽后（80 节点 / 140 边 / 6000 字符），很难再自然构造出"先撞节点上限、
  // 再撞字符上限"的图：裁节点会连带裁边，字符数反而降下去。
  // 所以这里直接验证 fitGraph 的累加契约：把"上游已裁 10 个"作为入口状态传进去，
  // 再让它撞一次字符上限，累计数必须是两者之和。
  const nodes = [{ id: 'root', label: '云智能经营中心' }];
  const edges = [];
  for (let i = 1; i <= 99; i += 1) {
    // 标签拉满 28 字符，把字符数顶上去
    nodes.push({ id: `n${i}`, label: (`部`.repeat(26) + i).slice(0, 28) });
    edges.push({ from: 'root', to: `n${i}` });
  }
  // 补交叉边到 140 条（边上限），制造 6000+ 字符
  for (let i = 1; i <= 99 && edges.length < 140; i += 1) {
    edges.push({ from: `n${i}`, to: `n${(i % 99) + 1}` });
  }
  const upstream = { title: 't', nodes, edges, removedNodes: 10 };
  assert.ok(
    mod.renderPuml(upstream).length > mod.DIAGRAM_MAX_PUML_CHARS,
    '构造的图要超过字符上限，否则第二段不会裁',
  );

  const fitted = mod.fitGraph(upstream) || upstream;
  assert.ok(fitted.nodes.length < nodes.length, '第二段应该真的又裁掉了节点');
  assert.strictEqual(
    fitted.removedNodes,
    10 + (nodes.length - fitted.nodes.length),
    '累计被裁数 = 上游已裁 10 个 + 本段新裁的数量',
  );
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
// ---------------------------------------------------------------------------
// P1-1：复核只比边方向，从不比节点集
//
// 两个模型都漏掉同一个部门时，没有任何一方会提出异议 —— 图上少画一个部门，
// 等于在组织文件里凭空撤销它。缺节点比多一条线更危险：多一条线看得见，
// 少一个部门是空白。
//
// 只告警、不改图：复核模型也可能幻觉出不存在的部门，贸然补进去等于制造新错误。
// ---------------------------------------------------------------------------

const NODES_8 = [
  { id: 'root', label: '云智能经营中心' },
  { id: 'a', label: '数据智能事业部' },
  { id: 'b', label: '大模型创新部' },
  { id: 'c', label: '云平台部' },
  { id: 'd', label: '交付一部' },
  { id: 'e', label: '交付二部' },
  { id: 'f', label: '运营部' },
  { id: 'g', label: '综合管理部' },
];

function graphOf(labels) {
  const nodes = labels.map((label, i) => ({ id: `n${i}`, label }));
  const edges = labels.slice(1).map((_, i) => ({ from: nodes[0].id, to: nodes[i + 1].id }));
  return { title: 't', nodes, edges };
}

test('复核模型多认出节点时报出主模型的遗漏数', () => {
  // 主模型漏了「电力事业部」「金融事业部」，复核模型看见了
  const primary = graphOf([...NODES_8.slice(0, 6).map((n) => n.label)]);
  const judge = graphOf([...NODES_8.slice(0, 6).map((n) => n.label), '电力事业部', '金融事业部']);
  const merged = mod.subtractContradictions(primary, judge);
  assert.ok(merged, '应该返回合并结果');
  assert.strictEqual(
    merged.missingFromPrimary,
    2,
    '复核多出的 2 个节点要记为主模型的遗漏',
  );
  // 只告警不改图：主模型的节点不该被凭空补进来
  assert.strictEqual(
    merged.nodes.length,
    primary.nodes.length,
    '方案 A：不改图，主模型节点数不变',
  );
});

test('两边节点一致时遗漏数为 0', () => {
  const g = graphOf(NODES_8.map((n) => n.label));
  const merged = mod.subtractContradictions(g, graphOf(NODES_8.map((n) => n.label)));
  assert.ok(merged);
  assert.strictEqual(merged.missingFromPrimary, 0);
});

test('主模型多认出的节点单独统计，不算遗漏', () => {
  const primary = graphOf([...NODES_8.slice(0, 6).map((n) => n.label), '电力事业部']);
  const judge = graphOf(NODES_8.slice(0, 6).map((n) => n.label));
  const merged = mod.subtractContradictions(primary, judge);
  assert.ok(merged);
  assert.strictEqual(merged.missingFromPrimary, 0, '主模型更全时不该报遗漏');
  assert.strictEqual(merged.extraInPrimary, 1, '主模型独有的应单独计数');
});

// ---------------------------------------------------------------------------
// P1-2：节点名被截断，但 truncated 从不增加
//
// 「郑州开发一团队」被截成「郑州开发一团」，尾字被吞，没有任何计数与警告。
// 一个部门名被改名，工具毫无察觉。
// ---------------------------------------------------------------------------

test('节点名超长被截断时，统计出来并记下原名', () => {
  const longName = '郑州开发一团队'; // 7 个字，不超 28 字符 → 不该截断
  const veryLong = '超长部门名称'.repeat(10); // 远超 28 字符 → 会截断
  const g = mod.parseGraph(
    JSON.stringify({
      nodes: [
        { id: 'a', label: '根部门' },
        { id: 'b', label: longName },
        { id: 'c', label: veryLong },
        { id: 'd', label: '另一个部门' },
      ],
      edges: [
        { from: 'a', to: 'b' },
        { from: 'a', to: 'c' },
        { from: 'a', to: 'd' },
      ],
    }),
  );
  assert.ok(g, '应该能解析出图');
  assert.ok(g.truncatedLabels && g.truncatedLabels.length >= 1, '应记录被截断的标签');
  const hit = g.truncatedLabels.find((t) => t.original.startsWith('超长部门名称'));
  assert.ok(hit, '应记下原名');
  assert.ok(hit.shorter.length < hit.original.length, '截断后的名字应更短');
});

test('没有超长名字时不产生虚假的截断记录', () => {
  const g = mod.parseGraph(
    JSON.stringify({
      nodes: [
        { id: 'a', label: '根' },
        { id: 'b', label: '短名字' },
        { id: 'c', label: '郑州开发一团队' },
        { id: 'd', label: '交付部' },
      ],
      edges: [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'c' },
        { from: 'c', to: 'd' },
      ],
    }),
  );
  assert.ok(g);
  assert.strictEqual(g.truncatedLabels.length, 0, '都不超长就不该有记录');
});
// ---------------------------------------------------------------------------
// 上限放宽的目的：正常的组织架构图不该被裁剪
//
// 产物是给对话助手读的代码。删一个节点，助手就永远不知道那个部门存在 ——
// 实测一份 41 节点的组织架构图曾被裁到 24 个，13 个团队在产物里一个字都不剩，
// 助手会据此回答"只有 11 个部门"。所以上限从 28/48/860 放宽到 60/100/4000。
// ---------------------------------------------------------------------------

test('上限已放宽到 80 节点 / 140 边 / 6000 字符', () => {
  assert.strictEqual(mod.DIAGRAM_MAX_NODES, 80);
  assert.strictEqual(mod.DIAGRAM_MAX_EDGES, 140);
  assert.strictEqual(mod.DIAGRAM_MAX_PUML_CHARS, 6000);
});

test('41 节点的组织架构图不再被裁剪（放宽前的边界案例）', () => {
  // 真实规模：根 + 25 个单元 + 15 个团队 = 41
  const nodes = [{ id: 'root', label: '云智能经营中心' }];
  const edges = [];
  for (let i = 1; i <= 25; i += 1) {
    nodes.push({ id: `u${i}`, label: `单元${i}` });
    edges.push({ from: 'root', to: `u${i}` });
  }
  let team = 1;
  for (let i = 1; i <= 5; i += 1) {
    for (let k = 0; k < 3; k += 1) {
      nodes.push({ id: `t${team}`, label: `团队${team}` });
      edges.push({ from: `u${i}`, to: `t${team}` });
      team += 1;
    }
  }
  assert.strictEqual(nodes.length, 41);

  const shrunk = mod.shrinkGraph({ title: 't', nodes, edges });
  const fitted = mod.fitGraph(shrunk) || shrunk;
  assert.strictEqual(fitted.removedNodes || 0, 0, '41 节点不该被裁掉任何部分');
  assert.strictEqual(fitted.nodes.length, 41, '41 个方框要一个不少地画出来');

  // 每个部门名都要出现在产物代码里，助手才读得到
  const puml = mod.renderPuml(fitted);
  for (const node of nodes) {
    assert.ok(puml.includes(node.label), `产物里缺了「${node.label}」`);
  }
});

test('80 节点以内、6000 字符以内的图完全不裁剪', () => {
  const nodes = [{ id: 'root', label: '根' }];
  const edges = [];
  for (let i = 1; i <= 79; i += 1) {
    nodes.push({ id: `n${i}`, label: `部门${i}` });
    edges.push({ from: 'root', to: `n${i}` });
  }
  const shrunk = mod.shrinkGraph({ title: 't', nodes, edges });
  assert.strictEqual(shrunk.removedNodes, 0);
  assert.strictEqual(shrunk.nodes.length, 80);
});
test('token 上限要够画满允许的最大图（否则 JSON 被截断，草图直接没了）', () => {
  // 60 节点 + 100 边、名字拉满 28 字，是最坏情况
  assert.strictEqual(mod.DIAGRAM_MAX_TOKENS, 8000);
  const nodes = [{ id: 'root', label: '云智能经营中心' }];
  const edges = [];
  for (let i = 1; i <= 59; i += 1) {
    nodes.push({ id: `n${i}`, label: (`部`.repeat(26) + i).slice(0, mod.DIAGRAM_MAX_LABEL_CHARS) });
    edges.push({ from: 'root', to: `n${i}` });
  }
  const json = JSON.stringify({ title: '组织架构', nodes, edges });
  // 中文按约 1 token/字、ASCII 按约 4 字符/token 粗估；只要远低于上限就安全
  const estimated = (json.match(/[\u4e00-\u9fa5]/g) || []).length + Math.ceil(json.length / 4);
  assert.ok(
    estimated < mod.DIAGRAM_MAX_TOKENS,
    `最坏情况下估算 ${estimated} token，仍应低于上限 ${mod.DIAGRAM_MAX_TOKENS}`,
  );
});
// ---------------------------------------------------------------------------
// 漏读的三个工具侧原因（不是模型能力问题）
//
// 1. 提示词原来写着"节点不超过 20 个"，而代码上限 80 —— 图上有 25 个部门时
//    模型会主动只写 20 个，等于工具自己让模型漏读。
// 2. 扇出上限 8：根节点挂 25 个平级部门时，第 9 条之后的边被丢弃，对应节点
//    变成孤立点被一并删除 —— 26 个节点进去只剩 9 个，一个警告都没有。
// 3. 模型自报的方框数和实际列出的对不上时，之前没有任何检测。
// ---------------------------------------------------------------------------

test('扇出不再把平级部门吃掉：根挂 25 个单元照样全留', () => {
  const nodes = [{ id: 'root', label: '云智能经营中心' }];
  const edges = [];
  for (let i = 1; i <= 25; i += 1) {
    nodes.push({ id: `u${i}`, label: `单元${i}` });
    edges.push({ from: 'root', to: `u${i}` });
  }
  const graph = mod.parseGraph(JSON.stringify({ nodes, edges }));
  assert.ok(graph, '应该解析出图');
  assert.strictEqual(graph.nodes.length, 26, '26 个方框一个都不能少');
  assert.strictEqual(graph.edges.length, 25, '25 条边一条都不能少');
  // 每个单元名都要出现在产物代码里，助手才读得到
  const puml = mod.renderPuml(graph);
  for (const node of nodes) {
    assert.ok(puml.includes(node.label), `产物里缺了「${node.label}」`);
  }
});

test('扇出上限已放宽到 40', () => {
  const mod2 = mod;
  // 直接验证行为：40 个平级子节点应全部保留
  const nodes = [{ id: 'root', label: '根' }];
  const edges = [];
  for (let i = 1; i <= 40; i += 1) {
    nodes.push({ id: `c${i}`, label: `子${i}` });
    edges.push({ from: 'root', to: `c${i}` });
  }
  const graph = mod2.parseGraph(JSON.stringify({ nodes, edges }));
  assert.ok(graph);
  assert.strictEqual(graph.nodes.length, 41, '40 个子节点应全部保留');
});

test('模型自报的 boxCount 会被读出来，供漏读检测使用', () => {
  const graph = mod.parseGraph(
    JSON.stringify({
      title: 't',
      boxCount: 12,
      nodes: [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
        { id: 'c', label: 'C' },
        { id: 'd', label: 'D' },
      ],
      edges: [
        { from: 'a', to: 'b' },
        { from: 'a', to: 'c' },
        { from: 'c', to: 'd' },
      ],
    }),
  );
  assert.ok(graph);
  assert.strictEqual(graph.declaredBoxCount, 12, '应记下模型自报的方框数');
  assert.ok(graph.declaredBoxCount > graph.nodes.length, '本例就是"自报多于实列"');
});

test('模型没给 boxCount 时该字段为 null，不会误判成漏读', () => {
  const graph = mod.parseGraph(
    JSON.stringify({
      title: 't',
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
  assert.strictEqual(graph.declaredBoxCount, null);
});

test('boxCount 是乱填的（非正整数）也不当成漏读信号', () => {
  for (const bad of [0, -3, 'abc', null, 1.5]) {
    const graph = mod.parseGraph(
      JSON.stringify({
        title: 't',
        boxCount: bad,
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
    assert.strictEqual(graph.declaredBoxCount, null, `boxCount=${JSON.stringify(bad)} 应被忽略`);
  }
});