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

test('injectDescriptions 把注释插在图片行正上方，其它行一字不动', () => {
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
  const at = lines.findIndex((line) => line.includes('media/a.jpg'));
  assert.ok(lines[at - 1].startsWith('<!-- image-desc: '), lines[at - 1]);
  assert.ok(lines[at - 1].includes('这是一张折线图'));
  assert.strictEqual(lines[at], '![image](/llmdoc/v1/doc/read?doc_id=1&read_format=path&path=media/a.jpg)');
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
