/**
 * docchain-image-describe 的纯函数单测。
 *
 * 不联网、不依赖任何框架：`node --test test/` 直接跑。
 * 这里锁的是"会静默毁掉产物"的那些行为 —— 注释转义、注入位置、换行风格、
 * URL 解析与编码，以及哨兵串的字面量。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const mod = require('../skills/docchain-image-describe/scripts/describe_images.js');

const CONFIG = { url: 'http://10.10.185.13:7100/llmdoc', key: 'k' };

test('sanitizeDesc 会转义注释符号，避免提前闭合把后续图片行吞掉', () => {
  const out = mod.sanitizeDesc('图示 a --> ![image](x) <!-- b');
  assert.ok(!out.includes('-->'), `不应残留 -->：${out}`);
  assert.ok(!out.includes('<!--'), `不应残留 <!--：${out}`);
  assert.ok(out.includes('--&gt;'));
  assert.ok(out.includes('&lt;!--'));
});

test('sanitizeDesc 压成单行并去掉首尾空白', () => {
  assert.strictEqual(mod.sanitizeDesc('  第一行\n\n第二行\t '), '第一行 第二行');
});

test('sanitizeDesc 超长时在句末截断并补省略号', () => {
  const sentence = '这是一句完整的描述。'; // 10 字符
  const long = sentence.repeat(600); // 6000 字符，远超任何默认上限
  const out = mod.sanitizeDesc(long);
  assert.ok(out.length <= mod.DESC_MAX_CHARS + 1, `长度 ${out.length}`);
  assert.ok(out.endsWith('。…') || out.endsWith('…'));
});

test('sanitizeDesc 支持自定义上限（配置项 docchain_vision_max_desc_chars）', () => {
  const long = '这是一句描述。'.repeat(20); // 140 字符
  const out = mod.sanitizeDesc(long, 50);
  assert.ok(out.length <= 51, `长度 ${out.length}`);
  assert.ok(out.endsWith('…'));
  // 上限比内容还大时不截断
  assert.strictEqual(mod.sanitizeDesc('短描述。', 500), '短描述。');
});

test('sanitizeDesc 空输入返回空串（调用方据此记 EMPTY_DESC）', () => {
  assert.strictEqual(mod.sanitizeDesc('   \n\t '), '');
  assert.strictEqual(mod.sanitizeDesc(null), '');
});

test('isImageBytes 认四种图片魔数，并拒绝 HTML 错误页', () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const gif = Buffer.from('GIF89a............', 'ascii');
  const webp = Buffer.concat([Buffer.from('RIFF', 'ascii'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBPVP8 ', 'ascii')]);
  assert.strictEqual(mod.isImageBytes(jpeg), 'image/jpeg');
  assert.strictEqual(mod.isImageBytes(png), 'image/png');
  assert.strictEqual(mod.isImageBytes(gif), 'image/gif');
  assert.strictEqual(mod.isImageBytes(webp), 'image/webp');
  assert.strictEqual(mod.isImageBytes(Buffer.from('<!DOCTYPE html><html>', 'utf8')), false);
  assert.strictEqual(mod.isImageBytes(Buffer.alloc(4)), false);
});

test('encodePathValue 不重复编码、对中文与空格编码', () => {
  assert.strictEqual(mod.encodePathValue('media/a.jpg'), 'media/a.jpg');
  assert.strictEqual(mod.encodePathValue('media/%E5%9B%BE.png'), 'media/%E5%9B%BE.png');
  assert.strictEqual(mod.encodePathValue('media/图 1.png'), 'media/%E5%9B%BE%201.png');
});

test('decodeEntities 还原 md 里被转义的 &', () => {
  assert.strictEqual(
    mod.decodeEntities('a?x=1&amp;y=2&lt;3'),
    'a?x=1&y=2<3',
  );
});

test('refKey 用 path 参数作为同一张图的标识', () => {
  const url = '/llmdoc/v1/doc/read?doc_id=1&read_format=path&path=media/a.jpg';
  assert.strictEqual(mod.refKey(url), 'media/a.jpg');
  assert.strictEqual(mod.refKey('/plain/url.png'), '/plain/url.png');
});

test('resolveImageUrl 只拼 origin，避免 /llmdoc/llmdoc 双前缀', () => {
  assert.strictEqual(
    mod.resolveImageUrl('/llmdoc/v1/doc/read?doc_id=1', CONFIG),
    'http://10.10.185.13:7100/llmdoc/v1/doc/read?doc_id=1',
  );
  assert.strictEqual(
    mod.resolveImageUrl('https://cdn.example.com/a.png', CONFIG),
    'https://cdn.example.com/a.png',
  );
  assert.strictEqual(
    mod.resolveImageUrl('media/a.png', CONFIG),
    'http://10.10.185.13:7100/llmdoc/media/a.png',
  );
});

test('parseImageRefs 支持三种写法，并统计无法解析的引用', () => {
  const md = [
    '![image](/llmdoc/v1/doc/read?doc_id=1&read_format=path&path=media/a.jpg)',
    '![alt](<media/b c.png>)',
    '<img src="/llmdoc/v1/doc/read?doc_id=1&read_format=path&path=media/c.jpg">',
    '![bad](javascript:void(0))',
    '![empty]()',
  ].join('\n');
  const parsed = mod.parseImageRefs(md, CONFIG);
  assert.strictEqual(parsed.refs.length, 3);
  // 前两个带 path= 参数 → 用路径做标识；第三个是相对路径 → 解析成绝对地址后整串做标识。
  assert.strictEqual(parsed.refs[0].key, 'media/a.jpg');
  assert.strictEqual(parsed.refs[1].key, 'http://10.10.185.13:7100/llmdoc/media/b c.png');
  assert.strictEqual(parsed.refs[2].key, 'media/c.jpg');
  // javascript: 这种非 http(s) scheme 计入 unparsed；空括号不算引用，直接忽略。
  assert.deepStrictEqual(parsed.unparsed, ['javascript:void(0)']);
});

test('parseImageRefs 会把 &amp; 形式还原后再取 path', () => {
  const md = '![image](/llmdoc/v1/doc/read?doc_id=1&amp;read_format=path&amp;path=media/a.jpg)';
  const parsed = mod.parseImageRefs(md, CONFIG);
  assert.strictEqual(parsed.refs.length, 1);
  assert.strictEqual(parsed.refs[0].key, 'media/a.jpg');
});

test('injectDescriptions 把注释插在图片位置，原图换成「原图」链接，其它行一字不动', () => {
  const md = [
    '<!-- page_num=1 -->',
    '',
    '# 标题',
    '',
    '![image](/llmdoc/v1/doc/read?doc_id=1&read_format=path&path=media/a.jpg)',
    '',
    '<div style="text-align: center;">图 1</div>',
  ].join('\n');
  const desc = new Map([['media/a.jpg', '这是一张折线图']]);
  const out = mod.injectDescriptions(md, desc);
  assert.strictEqual(out.injected, 1);
  const lines = out.content.split('\n');
  const at = lines.findIndex((line) => line.startsWith('[原图]('));
  assert.ok(at > 0, '应生成原图链接行');
  assert.ok(lines[at - 1].startsWith('<!-- image-desc: '), lines[at - 1]);
  assert.ok(lines[at - 1].includes('这是一张折线图'));
  assert.strictEqual(lines[at], '[原图](/llmdoc/v1/doc/read?doc_id=1&read_format=path&path=media/a.jpg)');
  assert.ok(!out.content.includes('![image]'), '原图不该再嵌进正文');
  assert.ok(out.content.includes('<!-- page_num=1 -->'));
  assert.ok(out.content.includes('<div style="text-align: center;">图 1</div>'));
});

test('injectDescriptions 保留 CRLF 换行风格', () => {
  const md = ['第一行', '![image](/llmdoc/v1/doc/read?doc_id=1&read_format=path&path=media/a.jpg)', '第三行'].join(
    '\r\n',
  );
  const out = mod.injectDescriptions(md, new Map([['media/a.jpg', '描述']]));
  assert.strictEqual(out.injected, 1);
  assert.ok(out.content.includes('\r\n'), '应保留 CRLF');
  assert.ok(!/[^\r]\n/.test(out.content), '不应出现裸 LF');
});

test('injectDescriptions 同一张图出现多次时每处都插入，且不重复同一行', () => {
  const one = '![image](/llmdoc/v1/doc/read?doc_id=1&read_format=path&path=media/a.jpg)';
  const md = [one, '', one, '', one + one].join('\n');
  const out = mod.injectDescriptions(md, new Map([['media/a.jpg', '描述']]));
  // 前两处各 1 条；第三行同一行出现两次只插 1 条
  assert.strictEqual(out.injected, 3);
});

test('injectDescriptions 没有描述时原样返回', () => {
  const md = '# 标题\n\n正文\n';
  const out = mod.injectDescriptions(md, new Map());
  assert.strictEqual(out.injected, 0);
  assert.strictEqual(out.content, md);
});

test('countExistingDesc 数出已有的注释条数（用于提示别叠加）', () => {
  const md = '<!-- image-desc: a -->\n![image](x)\n<!-- image-desc: b -->\n![image](y)';
  assert.strictEqual(mod.countExistingDesc(md), 2);
  assert.strictEqual(mod.countExistingDesc('<!-- page_num=1 -->'), 0);
});

test('normalizeEol 把 CRLF/CR 统一为 LF', () => {
  assert.strictEqual(mod.normalizeEol('a\r\nb\rc\n'), 'a\nb\nc\n');
});

test('哨兵串口径固定：44 字节，改文案必须同时改这里', () => {
  assert.strictEqual(Buffer.byteLength(mod.SENTINEL), 44);
  assert.strictEqual(mod.SENTINEL, 'Image description markdown file not found...');
});

test('并发默认值与上限符合实测结论（8 / 10）', () => {
  assert.strictEqual(mod.DEFAULT_CONCURRENCY, 8);
  assert.strictEqual(mod.MAX_CONCURRENCY, 10);
});

/* ------------------------------------------------------------------ *
 * 结构图（A 类）：模型只给「节点/边」数据，PlantUML 语法由代码生成
 * ------------------------------------------------------------------ */

const IMG = '![image](/llmdoc/v1/doc/read?doc_id=1&read_format=path&path=media/a.jpg)';

test('extractJsonObject 吃掉前言、代码围栏与结尾废话', () => {
  const text = '我理解你要把图转成 JSON。\n```json\n{"nodes":[{"id":"n1"}],"edges":[]}\n```\n还需要我做什么吗？';
  assert.strictEqual(mod.extractJsonObject(text), '{"nodes":[{"id":"n1"}],"edges":[]}');
});

test('extractJsonObject 跳过字符串里的花括号与转义引号', () => {
  const text = '{"label":"a{b}c \\"x\\"","n":1}';
  assert.strictEqual(mod.extractJsonObject(text), text);
});

test('extractJsonObject 遇到被截断的 JSON 返回 null（据此回退散文）', () => {
  assert.strictEqual(mod.extractJsonObject('{"nodes":[{"id":"n1"},"edges":[{"from":'), null);
  assert.strictEqual(mod.extractJsonObject('这里没有 JSON'), null);
});

test('parseGraph 丢弃悬空边、空标签与重复 id', () => {
  const json = JSON.stringify({
    title: 'BPE 学习流程',
    nodes: [
      { id: 'n1', label: '词表' },
      { id: 'n1', label: '重复 id' },
      { id: 'n2', label: '统计二元组' },
      { id: 'n3', label: '   ' },
      { id: 'n4', label: '符号合并表' },
    ],
    edges: [
      { from: 'n1', to: 'ghost', label: '悬空，丢' },
      { from: 'n1', to: 'n2', label: '统计' },
      { from: 'n2', to: 'n4' },
    ],
  });
  const graph = mod.parseGraph(json);
  assert.deepStrictEqual(
    graph.nodes.map((node) => node.id),
    ['n1', 'n2', 'n4'],
  );
  assert.deepStrictEqual(
    graph.edges.map((edge) => `${edge.from}>${edge.to}`),
    ['n1>n2', 'n2>n4'],
  );
  assert.strictEqual(graph.title, 'BPE 学习流程');
});

test('parseGraph 不再合并同名节点（N 层堆叠被压成一个模块就是改意思）', () => {
  const json = JSON.stringify({
    title: '',
    nodes: [
      { id: 'a', label: 'Add & Norm' },
      { id: 'b', label: 'Add & Norm' },
      { id: 'c', label: '输出' },
      { id: 'd', label: '输入' },
    ],
    edges: [
      { from: 'd', to: 'a' },
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
    ],
  });
  const graph = mod.parseGraph(json);
  assert.deepStrictEqual(
    graph.nodes.map((node) => node.id),
    ['a', 'b', 'c', 'd'],
  );
  assert.deepStrictEqual(
    graph.edges.map((edge) => `${edge.from}>${edge.to}`),
    ['d>a', 'a>b', 'b>c'],
  );
});

test('parseGraph 丢掉纯数字/纯符号节点（patch 编号、刻度、单位），并限制扇出', () => {
  const json = JSON.stringify({
    title: 'Transformer',
    nodes: [
      { id: 'p', label: 'Patch Embedding' },
      { id: 'e', label: 'Encoder' },
      { id: 'o', label: 'Output' },
      ...['0', '1', '2', '3', '*', '×N'].map((label) => ({ id: `n${label}`, label })),
    ],
    edges: [
      ...['0', '1', '2', '3', '*', '×N'].map((label) => ({ from: 'p', to: `n${label}` })),
      { from: 'p', to: 'e' },
      { from: 'e', to: 'o' },
    ],
  });
  const graph = mod.parseGraph(json);
  assert.deepStrictEqual(
    graph.nodes.map((node) => node.label),
    ['Patch Embedding', 'Encoder', 'Output'],
  );
  // 噪声节点被丢后，边也只剩主干，不会再有那团放射状交叉线
  assert.deepStrictEqual(
    graph.edges.map((edge) => `${edge.from}>${edge.to}`),
    ['p>e', 'e>o'],
  );
});

test('parseGraph 把超长标签截到上限，避免把图撑爆', () => {
  const long = '视觉细粒度特征提取模块与全局语义特征提取模块的级联融合单元';
  const json = JSON.stringify({
    title: '',
    nodes: [
      { id: 'n1', label: long },
      { id: 'n2', label: 'b' },
      { id: 'n3', label: 'c' },
    ],
    edges: [
      { from: 'n1', to: 'n2' },
      { from: 'n2', to: 'n3' },
    ],
  });
  const label = mod.parseGraph(json).nodes[0].label;
  assert.strictEqual(label.length, mod.DIAGRAM_MAX_LABEL_CHARS + 1);
  assert.ok(label.endsWith('…'));
});

test('parseGraph 丢掉噪声节点时会把它前驱接到后继（主干不能断）', () => {
  const json = JSON.stringify({
    title: '',
    nodes: [
      { id: 'p', label: 'Patch Embedding' },
      { id: 'x', label: '1' },
      { id: 'e', label: 'Encoder' },
      { id: 'o', label: 'Output' },
    ],
    edges: [
      { from: 'p', to: 'x' },
      { from: 'x', to: 'e' },
      { from: 'e', to: 'o' },
    ],
  });
  const graph = mod.parseGraph(json);
  assert.deepStrictEqual(
    graph.edges.map((edge) => `${edge.from}>${edge.to}`),
    ['p>e', 'e>o'],
  );
});

test('parseGraph 丢掉一条边都不沾的"漂浮标签"（原图的行标题被当成节点）', () => {
  const json = JSON.stringify({
    title: '',
    nodes: [
      { id: 'e', label: 'Embedding' },
      { id: 'x', label: 'X_t' },
      { id: 'h', label: 'h_t' },
      { id: 'l1', label: '输入层' },
      { id: 'l2', label: '输出层' },
    ],
    edges: [
      { from: 'e', to: 'x' },
      { from: 'x', to: 'h' },
    ],
  });
  const graph = mod.parseGraph(json);
  assert.deepStrictEqual(
    graph.nodes.map((node) => node.label),
    ['Embedding', 'X_t', 'h_t'],
  );
});

test('parseGraph 把 LaTeX 下标 X_{t-1} 洗成 X_t-1（花括号原样画出来很难看）', () => {
  const json = JSON.stringify({
    title: '',
    nodes: [
      { id: 'a', label: 'X_{t-1}' },
      { id: 'b', label: 'h_{t}' },
      { id: 'c', label: 'y_t' },
    ],
    edges: [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
    ],
  });
  assert.deepStrictEqual(
    mod.parseGraph(json).nodes.map((node) => node.label),
    ['X_t-1', 'h_t', 'y_t'],
  );
});

test('subtractContradictions 只删"方向相反"的边，其余保留（不把结构拆碎）', () => {
  const primary = {
    title: 't',
    nodes: [
      { id: 'a', label: '图像' },
      { id: 'b', label: '视觉模块' },
      { id: 'c', label: '融合' },
      { id: 'd', label: '输出' },
    ],
    edges: [
      { from: 'a', to: 'b', label: '' },
      { from: 'b', to: 'c', label: '' },
      { from: 'c', to: 'd', label: '' }, // 复核模型没提到，但没被否定 → 保留
    ],
  };
  const judge = {
    title: 't',
    nodes: [
      { id: 'n1', label: '图像' },
      { id: 'n2', label: '视觉模块' },
      { id: 'n3', label: '融合' },
    ],
    edges: [
      { from: 'n2', to: 'n1', label: '' }, // 与 a→b 相反 → 删掉 a→b
      { from: 'n2', to: 'n3', label: '' },
    ],
  };
  const merged = mod.subtractContradictions(primary, judge);
  assert.deepStrictEqual(
    merged.edges.map((e) => `${e.from}>${e.to}`),
    ['b>c', 'c>d'],
  );
  // 变孤立的节点要一并去掉（a 的边被删了）
  assert.deepStrictEqual(
    merged.nodes.map((n) => n.id),
    ['b', 'c', 'd'],
  );
});

test('subtractContradictions 删除后剩太少就返回 null（调用方退回主模型）', () => {
  const primary = {
    title: '',
    nodes: [
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B' },
      { id: 'c', label: 'C' },
    ],
    edges: [
      { from: 'a', to: 'b', label: '' },
      { from: 'b', to: 'c', label: '' },
    ],
  };
  const judge = {
    title: '',
    nodes: [
      { id: 'x', label: 'A' },
      { id: 'y', label: 'B' },
      { id: 'z', label: 'C' },
    ],
    edges: [
      { from: 'y', to: 'x', label: '' },
      { from: 'z', to: 'y', label: '' },
    ],
  };
  assert.strictEqual(mod.subtractContradictions(primary, judge), null);
});

test('fitGraph 把过长的草图裁到上限内，且只删叶子节点（不断链）', () => {
  const nodes = [];
  const edges = [];
  // 字符上限放宽到 6000 后，100 个节点（约 5000 字符）也撞不到，改用 120 个（约 6100 字符）
  for (let i = 1; i <= 120; i += 1) {
    nodes.push({ id: `n${i}`, label: `模块${i}的名字写得很长很长很长的样子` });
    if (i > 1) edges.push({ from: `n${i - 1}`, to: `n${i}`, label: '' });
  }
  const graph = { title: '一个很长的标题用来占掉一些字符', nodes, edges };
  const cap = mod.DIAGRAM_MAX_PUML_CHARS;
  assert.ok(mod.renderPuml(graph).length > cap, '构造的图应该超限');
  const fitted = mod.fitGraph(graph);
  assert.ok(mod.renderPuml(fitted).length <= cap, `裁剪后仍超限：${mod.renderPuml(fitted).length} > ${cap}`);
  assert.ok(fitted.nodes.length >= 3, '不能裁到没节点');
  const froms = new Set(fitted.edges.map((e) => e.from));
  const tos = new Set(fitted.edges.map((e) => e.to));
  for (const node of fitted.nodes) {
    assert.ok(froms.has(node.id) || tos.has(node.id), `节点 ${node.id} 成了孤立点`);
  }
});

test('短路只走"唯一后继"：扇形枢纽被丢弃时不能把兄弟节点连成网状', () => {
  const json = JSON.stringify({
    title: '',
    nodes: [
      { id: 'hub', label: '3' }, // 1–2 位序号 → 被当噪声丢弃
      { id: 'a', label: 'A 公司' },
      { id: 'b', label: 'B 公司' },
      { id: 'c', label: 'C 公司' },
      { id: 'd', label: 'D 公司' },
    ],
    edges: [
      { from: 'a', to: 'hub' },
      { from: 'b', to: 'hub' },
      { from: 'c', to: 'hub' },
      { from: 'hub', to: 'a' },
      { from: 'hub', to: 'b' },
      { from: 'hub', to: 'c' },
      { from: 'hub', to: 'd' },
      { from: 'a', to: 'b' },
      { from: 'c', to: 'd' },
    ],
  });
  const graph = mod.parseGraph(json);
  // hub 被丢 → 它的边全部作废，只保留两条真实边，不能出现 a→c 这类兄弟互连
  assert.deepStrictEqual(
    graph.edges.map((edge) => `${edge.from}>${edge.to}`),
    ['a>b', 'c>d'],
  );
});

test('mergeRedundantNodes 合并"同名且邻居完全一致"的重复节点，但不压扁同名长链', () => {
  // 场景一：同名长链（VGG19 那种 512→512→512），邻居不同 → 一个都不能合
  const chain = mod.mergeRedundantNodes(
    [
      { id: 'a', label: '512' },
      { id: 'b', label: '512' },
      { id: 'c', label: '512' },
    ],
    [
      { from: 'a', to: 'b', label: '' },
      { from: 'b', to: 'c', label: '' },
    ],
  );
  assert.strictEqual(chain.merged, 0, '同名长链不能被合并');
  assert.strictEqual(chain.nodes.length, 3);

  // 场景二：同一个框被写成两个 id，邻居完全一致 → 合并，且丢掉自环
  const dup = mod.mergeRedundantNodes(
    [
      { id: 'x', label: 'h_t' },
      { id: 'y', label: 'h_t' },
      { id: 'in', label: 'x_t' },
      { id: 'out', label: 'y_t' },
    ],
    [
      { from: 'in', to: 'x', label: '' },
      { from: 'in', to: 'y', label: '' },
      { from: 'x', to: 'out', label: '' },
      { from: 'y', to: 'out', label: '' },
    ],
  );
  assert.strictEqual(dup.merged, 1);
  assert.deepStrictEqual(
    dup.edges.map((edge) => `${edge.from}>${edge.to}`),
    ['in>x', 'x>out'],
  );
});

test('buildKindPrompt 把"必须有连接线"作为结构图的硬门槛', () => {
  const p = mod.buildKindPrompt();
  assert.ok(p.includes('连接线'), '必须要求有连接线');
  assert.ok(p.includes('同时满足'), '必须是"两条同时满足"');
  assert.ok(p.includes('没有连线的组织架构图'), '没连线的组织图要归为 PROSE');
  assert.strictEqual(mod.parseKind('STRUCTURE'), 'structure');
  assert.strictEqual(mod.parseKind(' structure '), 'structure');
  assert.strictEqual(mod.parseKind('PROSE'), 'prose');
  assert.strictEqual(mod.parseKind(''), 'prose');
  // 关键回归：回答里提到 STRUCTURE 不等于它就是结构图
  assert.strictEqual(mod.parseKind('PROSE（图中没有连接线，不符合 STRUCTURE）'), 'prose');
  assert.strictEqual(mod.parseKind('结构图应为 STRUCTURE'), 'structure');
});

test('裁剪优先削最底层：顶层并排的中心一个都不能少', () => {
  // 真实踩坑：浩鲸科技 → 8 个中心 → 某中心下 8 部门 → 每部门 6 团队。
  // 早先按"兄弟最多优先"删，把根下面 8 个浅层叶子中心删掉了两个。
  // 节点上限放宽到 80 后，6 部门 × 6 团队（共 51 节点）、8 × 6（65 节点）都撞不到，
  // 改用 8 部门 × 8 团队 = 81 节点。
  const DEPTS = 8;
  const TEAMS_PER_DEPT = 8;
  const nodes = [{ id: 'root', label: '浩鲸科技' }];
  const edges = [];
  for (let i = 1; i <= 8; i += 1) {
    nodes.push({ id: `c${i}`, label: `中心${i}` });
    edges.push({ from: 'root', to: `c${i}`, label: '' });
  }
  for (let d = 1; d <= DEPTS; d += 1) {
    nodes.push({ id: `d${d}`, label: `部门${d}` });
    edges.push({ from: 'c4', to: `d${d}`, label: '' });
    for (let t = 1; t <= TEAMS_PER_DEPT; t += 1) {
      nodes.push({ id: `d${d}t${t}`, label: `团队${d}-${t}` });
      edges.push({ from: `d${d}`, to: `d${d}t${t}`, label: '' });
    }
  }
  assert.ok(nodes.length > mod.DIAGRAM_MAX_NODES, '构造的图要超过节点上限才有意义');
  const shrunk = mod.shrinkGraph({ title: '', nodes, edges });
  assert.ok(shrunk.nodes.length <= mod.DIAGRAM_MAX_NODES);
  for (let i = 1; i <= 8; i += 1) {
    assert.ok(shrunk.nodes.some((n) => n.id === `c${i}`), `顶层中心${i}被删掉了`);
  }
  // 被削掉的应该是末端团队，而不是上层
  const teams = shrunk.nodes.filter((n) => /^d\d+t\d+$/.test(n.id)).length;
  assert.ok(teams < DEPTS * TEAMS_PER_DEPT, '应该削掉了一部分末端团队');
});

test('注入前先剥掉主 md 里的旧 image-desc 注释，避免叠层', () => {
  const md = [
    '# 标题',
    '',
    '<!-- image-desc: 旧注释A -->',
    '![image](/llmdoc/v1/doc/read?doc_id=1&read_format=path&path=media/a.jpg)',
    '',
    '<!-- image-desc: 旧注释B -->',
    '![image](/llmdoc/v1/doc/read?doc_id=1&read_format=path&path=media/b.jpg)',
  ].join('\n');
  const out = mod.injectDescriptions(
    md,
    new Map([
      ['media/a.jpg', { puml: '@startuml\nrectangle "A" as n1\nn1 --> n2\n@enduml' }],
      ['media/b.jpg', '新注释B'],
    ]),
  );
  assert.strictEqual(out.removed, 2, '应剥掉 2 条旧注释');
  assert.strictEqual(out.injected, 2);
  assert.ok(!out.content.includes('旧注释'), '旧注释必须清掉，否则同一张图既像草图又像注释');
  assert.ok(out.content.includes('<!-- image-desc: 新注释B -->'));
  assert.strictEqual((out.content.match(/```plantuml/g) || []).length, 1);
});

test('版面标注兜底：节点多是"分层标签/说明长句"时判为版式图，不画草图', () => {
  // 版式信息图里的"节点"长这样（分层间隔号 + 句读）
  const posterLabels = [
    '公司级统筹层·规',
    '统筹指导与赋能：统一市场行销体系与方案方法论，对齐与复用…',
    '统分结合·规战一体',
    '中心级行动层·战',
    '落地执行与反馈：自主开展售前作战与经营支撑…',
    '战略运营部',
    '品牌运营部',
    'AI商业化团队',
    '国内产品商业化团队',
    '国际产品商业化团队',
    '云智能产品商业化团队',
    '国内业务运营中心',
    '国际业务运营中心',
    '云智能业务经营中心',
    '国内解决方案部',
    '国际解决方案部',
    '云业务营销部',
    '业务中心内的区域作战与经营支撑单元',
  ];
  const poster = {
    title: '',
    nodes: posterLabels.map((label, i) => ({ id: `n${i}`, label })),
    edges: [{ from: 'n0', to: 'n5', label: '' }],
  };
  assert.strictEqual(mod.annotationHeavy(poster), true, '版式图应被识别');

  // 真架构图的模块名不能被误判；尤其"被截断带 …" 与 "带 &" 都不是标注证据
  const realLabels = [
    '视觉细粒度特征提取模块',
    '3×3 conv 64 pool/2',
    'Resize 224×224×3',
    'Embedding(Glove)',
    '烟草经营三部',
    'International Customer Operation Center',
    'Multi-Head Attention',
    'Eastern Hemisphere Solution…',
    'L2 O&M Team Berjaya',
    'L1 Centralized Monitoring…',
  ];
  for (const label of realLabels) {
    assert.strictEqual(mod.isAnnotationLabel(label), false, `真模块名不该被当成标注：${label}`);
  }
  const chart = { title: '', nodes: realLabels.map((label, i) => ({ id: `n${i}`, label })), edges: [] };
  assert.strictEqual(mod.annotationHeavy(chart), false, '真架构图不该被兜底退回');
});

test('shrinkGraph 超限时删最外围的叶子，而不是按顺序砍掉最后一列', () => {
  // 构造：1 个根 + 6 个部门 + 每个部门 5 个业务办 = 37 节点，超过上限 28
  const nodes = [{ id: 'root', label: '事业部' }];
  const edges = [];
  for (let d = 1; d <= 6; d += 1) {
    nodes.push({ id: `d${d}`, label: `部门${d}` });
    edges.push({ from: 'root', to: `d${d}`, label: '' });
    for (let o = 1; o <= 5; o += 1) {
      nodes.push({ id: `d${d}o${o}`, label: `部门${d}业务办${o}` });
      edges.push({ from: `d${d}`, to: `d${d}o${o}`, label: '' });
    }
  }
  const shrunk = mod.shrinkGraph({ title: '', nodes, edges });
  assert.ok(shrunk.nodes.length <= mod.DIAGRAM_MAX_NODES, `仍超限：${shrunk.nodes.length}`);
  // 关键：每个部门都必须还在（不能因为超限把最后一列整段砍掉）
  for (let d = 1; d <= 6; d += 1) {
    assert.ok(
      shrunk.nodes.some((n) => n.id === `d${d}`),
      `部门${d} 被整段砍掉了`,
    );
  }
  // 根节点不能被删
  assert.ok(shrunk.nodes.some((n) => n.id === 'root'));
});

test('parseGraph 对非结构图（节点/边太少）返回 null，用它挡住误判', () => {
  const twoNodes = '{"nodes":[{"id":"n1","label":"a"},{"id":"n2","label":"b"}],"edges":[{"from":"n1","to":"n2"}]}';
  assert.strictEqual(mod.parseGraph(twoNodes), null);
  assert.strictEqual(mod.parseGraph('一张关于损失下降的折线图。'), null);
});

test('parseGraph 把模板占位符当标题丢掉（实测模型会照抄 "图的标题，没有就空串"）', () => {
  const json = JSON.stringify({
    title: '图的标题，没有就空串',
    nodes: [
      { id: 'n1', label: 'a' },
      { id: 'n2', label: 'b' },
      { id: 'n3', label: 'c' },
    ],
    edges: [
      { from: 'n1', to: 'n2' },
      { from: 'n2', to: 'n3' },
    ],
  });
  assert.strictEqual(mod.parseGraph(json).title, '');
});

test('sanitizeDesc 剥掉模型抄出来的分支标签（"B. 六个子图…" → "六个子图…"）', () => {
  assert.strictEqual(mod.sanitizeDesc('B. 六个子图并列排布，每幅图含图像。'), '六个子图并列排布，每幅图含图像。');
  assert.strictEqual(mod.sanitizeDesc('B：纵轴为损失。'), '纵轴为损失。');
  // 正常描述不受影响
  assert.strictEqual(mod.sanitizeDesc('折线图展示损失下降。'), '折线图展示损失下降。');
});

test('renderPuml 先声明全部别名再画边（实测模型最容易写错的就是这个顺序）', () => {
  const puml = mod.renderPuml({
    title: '',
    nodes: [
      { id: '词表', label: '词表' },
      { id: '2', label: '统计二元组' },
      { id: 'n3', label: '符号合并表' },
    ],
    edges: [
      { from: '词表', to: '2', label: '统计' },
      { from: '2', to: 'n3', label: '' },
    ],
  });
  const lines = puml.split('\n');
  assert.strictEqual(lines[0], '@startuml');
  assert.strictEqual(lines[lines.length - 1], '@enduml');
  const declared = new Set();
  for (const line of lines) {
    const decl = / as (\w+)$/.exec(line);
    if (decl) {
      declared.add(decl[1]);
      continue;
    }
    const arrow = /^(\w+) -> (\w+)/.exec(line);
    if (arrow) {
      assert.ok(declared.has(arrow[1]), `箭头里的 ${arrow[1]} 必须先声明：${line}`);
      assert.ok(declared.has(arrow[2]), `箭头里的 ${arrow[2]} 必须先声明：${line}`);
    }
  }
  // 别名一律重排成 n1..nK，模型给的怪 id（中文 / 数字开头）不会被写进代码
  assert.ok(!puml.includes('as 词表'));
  assert.ok(puml.includes('as n1'));
});

test('renderPuml 转义标签里的引号，且不输出 skinparam / 颜色', () => {
  const puml = mod.renderPuml({
    title: 'BPE "学习"',
    nodes: [
      { id: 'a', label: '词"表"' },
      { id: 'b', label: '统计' },
      { id: 'c', label: '合并' },
    ],
    edges: [
      { from: 'a', to: 'b', label: '含"引号"' },
      { from: 'b', to: 'c' },
    ],
  });
  assert.ok(puml.includes("title BPE '学习'"), puml);
  assert.ok(puml.includes(`rectangle "词'表'" as n1`), puml);
  assert.ok(!/skinparam/.test(puml));
  assert.ok(!/#[0-9A-Fa-f]{6}/.test(puml));
  for (const line of puml.split('\n')) {
    assert.ok((line.match(/"/g) || []).length <= 2, `引号没配对：${line}`);
  }
});

test('renderPuml 数据为空时返回空串（调用方据此回退散文）', () => {
  assert.strictEqual(mod.renderPuml(null), '');
  assert.strictEqual(mod.renderPuml({ title: '', nodes: [], edges: [] }), '');
});

test('injectDescriptions 有草图时：草图在上、原图只留一行链接（不再嵌入）', () => {
  const md = ['# 标题', '', IMG, ''].join('\n');
  const puml = '@startuml\nleft to right direction\nrectangle "词表" as n1\nn1 --> n2 : 统计\n@enduml';
  const out = mod.injectDescriptions(md, new Map([['media/a.jpg', { puml }]]));
  const lines = out.content.split('\n');
  assert.deepStrictEqual(lines.slice(2, 10), [
    '```plantuml',
    '@startuml',
    'left to right direction',
    'rectangle "词表" as n1',
    'n1 --> n2 : 统计',
    '@enduml',
    '```',
    '[原图](/llmdoc/v1/doc/read?doc_id=1&read_format=path&path=media/a.jpg)',
  ]);
  assert.ok(!out.content.includes('![image]'), '有草图的原图不该再嵌入');
  assert.ok(!out.content.includes('<details'), '折叠壳不支持，别再加回去');
  assert.strictEqual(out.injected, 1);
});

test('围栏里的箭头保持 -->（不会被 HTML 注释吃掉，所以不需要改写）', () => {
  const puml = mod.renderPuml({
    title: 't',
    nodes: [
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B' },
      { id: 'c', label: 'C' },
    ],
    edges: [
      { from: 'a', to: 'b', label: '统计' },
      { from: 'b', to: 'c' },
    ],
  });
  assert.ok(puml.includes('n1 --> n2 : 统计'), puml);
  const out = mod.injectDescriptions(IMG, new Map([['media/a.jpg', { puml }]]));
  assert.ok(out.content.includes('n1 --> n2 : 统计'));
  assert.ok(out.content.includes('```plantuml'));
});

test('injectDescriptions 结构图围栏在 CRLF 文档里也用 CRLF', () => {
  const md = ['第一行', IMG].join('\r\n');
  const out = mod.injectDescriptions(md, new Map([['media/a.jpg', { puml: '@startuml\nA --> B\n@enduml' }]]));
  assert.ok(!/[^\r]\n/.test(out.content), '不应出现裸 LF');
  assert.ok(out.content.includes('```plantuml\r\n@startuml\r\n'), out.content);
});

test('buildPrompt 在 diagram=off 时与纯描述提示词逐字一致（回归护栏）', () => {
  const on = mod.buildPrompt('d.pdf', 1, 9, 'on');
  const off = mod.buildPrompt('d.pdf', 1, 9, 'off');
  assert.ok(on.includes('A. 结构图'));
  assert.ok(!off.includes('A. 结构图'));
  assert.ok(off.includes('写作规则（按重要性排序）'));
  // 结构图分支里的描述规则必须与关闭时返回的那段完全相同（同一份文本，不改写）
  const rules = off.slice(off.indexOf('请用中文精确描述这张图'));
  assert.ok(rules.startsWith('请用中文精确描述这张图'));
  assert.ok(on.endsWith(rules), '结构图提示词结尾必须是原样的描述规则段');
});

test('buildPrompt 结构图分支带通用约束（并列支路/方向/跨层/残差/重复次数/两排同名）', () => {
  const on = mod.buildPrompt('d.pdf', 1, 9, 'on');
  for (const rule of [
    '并列的多条支路不要互连',
    '箭头方向必须照抄',
    '不要跨层直连',
    '残差',
    'N×、L×、×N',
    '并排的两排',
  ]) {
    assert.ok(on.includes(rule), `缺少通用约束：${rule}`);
  }
});

test('buildPrompt 结构图分支给出 JSON 模板，且不再限制节点数量', () => {
  const on = mod.buildPrompt('d.pdf', 3, 185, 'on');
  assert.ok(on.includes('第 3/185 张'));
  assert.ok(on.includes('{"title"'));
  assert.ok(on.includes('boxCount'), '要求模型先数方框总数，供漏读检测用');
  assert.ok(on.includes('不要代码围栏'));
  // 原来这里写着"节点不超过 20 个"，与代码侧 80 上限矛盾，会让模型主动漏读
  assert.strictEqual(
    on.includes('节点不超过 20 个'),
    false,
    '不能再限制模型写多少个节点',
  );
  assert.ok(on.includes('一个都不能省略'), '要明确要求不漏方框');
});

test('buildPrompt 补问时带上模型自报的方框数', () => {
  const retry = mod.buildPrompt('d.pdf', 3, 185, 'on', 12);
  assert.ok(retry.includes('12 个方框'), '补问要给出明确目标数量');
});
