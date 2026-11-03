/**
 * 保存守卫的集成测试：用一个本地假服务模拟 docchain + 网关。
 *
 * 这里模拟的是最危险的那个失败模式 —— 服务端忽略 `is_image_description`，
 * 把"描述 md"写进了主 md。正确行为是：发现主 md 变了 → 用原内容写回 → 抛
 * SAVE_WRONG_TARGET，且最终主 md 与处理前逐字节相同。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const mod = require('../skills/docchain-image-describe/scripts/describe_images.js');

const MAIN_MD_TEMPLATE = ['# 标题', '', '正文一段。', '', '![image](http://HOST/img.jpg)', ''].join('\n');
// 一个最小但合法的 JPEG 头，足够通过魔数校验。
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1]);

/** 起一个假服务：`ignoreFlag` 为真时模拟"服务端把描述写进了主 md"。 */
function startStub(options) {
  const state = { mainMd: '', descMd: null, saves: [], chatCalls: 0, lastPrompt: '' };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const send = (status, body, type) => {
      res.writeHead(status, { 'content-type': type || 'application/json; charset=utf-8' });
      res.end(body);
    };
    if (url.pathname === '/img.jpg') {
      send(200, JPEG, 'image/jpeg');
      return;
    }
    if (url.pathname.endsWith('/chat/completions')) {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        // 带图片的调用 = 描述；不带图片的调用 = 压缩（completeText）
        const hasImage = raw.includes('"image_url"');
        state.chatCalls += 1;
        try {
          const body = JSON.parse(raw);
          const parts = body && body.messages && body.messages[0] ? body.messages[0].content : [];
          const textPart = Array.isArray(parts) ? parts.find((part) => part && part.type === 'text') : null;
          state.lastPrompt = textPart ? String(textPart.text || '') : '';
        } catch {
          state.lastPrompt = '';
        }
        // 分类调用：提示词里带 STRUCTURE / PROSE 字样，只回一个词
        if (hasImage && state.lastPrompt.includes('STRUCTURE')) {
          const kind = options.kindText || 'STRUCTURE';
          send(200, JSON.stringify({ choices: [{ message: { content: kind }, finish_reason: 'stop' }] }));
          return;
        }
        // 结构数据不可用时会用"纯描述"提示词补一次：靠"二选一"这个字样区分两种提示词
        if (options.proseOnRetry && hasImage && !state.lastPrompt.includes('二选一')) {
          send(
            200,
            JSON.stringify({ choices: [{ message: { content: options.proseOnRetry }, finish_reason: 'stop' }] }),
          );
          return;
        }
        const content = !hasImage && options.compressTo ? options.compressTo : options.descText || '一张展示损失下降的折线图。';
        send(
          200,
          JSON.stringify({
            choices: [{ message: { content }, finish_reason: options.finishReason || 'stop' }],
          }),
        );
      });
      return;
    }
    if (url.pathname.endsWith('/models')) {
      send(200, JSON.stringify({ data: [{ id: 'm', is_vision: 1 }] }));
      return;
    }
    if (url.pathname.endsWith('/v1/doc/filedetail')) {
      send(200, JSON.stringify({ id: 1, topic_id: 2, base_name: '测试文档', file_extension: '.pdf' }));
      return;
    }
    if (url.pathname.endsWith('/v1/topic/info')) {
      send(200, JSON.stringify({ data: { name: '主题A' } }));
      return;
    }
    if (url.pathname.endsWith('/v1/doc/read')) {
      const format = url.searchParams.get('read_format');
      if (format === 'image_description_md') {
        send(200, state.descMd === null ? 'Image description markdown file not found...' : state.descMd);
        return;
      }
      send(200, state.mainMd);
      return;
    }
    if (url.pathname.endsWith('/v1/doc/save_markdown')) {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        const body = JSON.parse(raw);
        state.saves.push(body);
        // 关键点：这里故意忽略 body.is_image_description，模拟服务端的那个失败模式。
        if (options.ignoreFlag) state.mainMd = body.content;
        else state.descMd = body.content;
        send(200, JSON.stringify({ success: true, date: '00:00:00' }));
      });
      return;
    }
    send(404, JSON.stringify({ detail: 'not found' }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      // md 里的图片地址必须是真实端口，否则下载会失败
      state.mainMd = MAIN_MD_TEMPLATE.replace('HOST', `127.0.0.1:${port}`);
      resolve({ server, state, port, url: `http://127.0.0.1:${port}/llmdoc`, visionUrl: `http://127.0.0.1:${port}/gpt` });
    });
  });
}

function configFor(stub) {
  return {
    url: stub.url,
    key: 'docchain-key',
    topicIds: [],
    vision: { url: stub.visionUrl, model: 'm', fallbackModel: 'f', key: 'vision-key' },
  };
}

test('服务端忽略 flag 把内容写进主 md 时，会写回原文并抛 SAVE_WRONG_TARGET', async () => {
  const stub = await startStub({ ignoreFlag: true });
  try {
    const before = stub.state.mainMd;
    await assert.rejects(
      () => mod.runDescribeImages(configFor(stub), { docIds: [1], quiet: true }),
      (error) => {
        assert.strictEqual(error.code, 'SAVE_WRONG_TARGET', `实际错误：${error.code} ${error.message}`);
        return true;
      },
    );
    assert.strictEqual(stub.state.mainMd, before, '主 md 必须被写回原内容');
    // 第二次调用就是自愈写回（不带 flag）
    assert.strictEqual(stub.state.saves.length, 2);
    assert.strictEqual(stub.state.saves[1].is_image_description, false);
  } finally {
    stub.server.close();
  }
});

test('服务端正确写旁路文件时，保存成功且读回校验通过、主 md 不变', async () => {
  const stub = await startStub({ ignoreFlag: false });
  try {
    const before = stub.state.mainMd;
    const payload = await mod.runDescribeImages(configFor(stub), { docIds: [1], quiet: true });
    const doc = payload.documents[0];
    assert.strictEqual(stub.state.mainMd, before, '主 md 不应被改动');
    assert.strictEqual(doc.described, 1);
    assert.strictEqual(doc.injected, 1);
    assert.strictEqual(doc.saved.ok, true);
    assert.strictEqual(doc.saved.verified, true);
    assert.ok(doc.saved.bytes > 0);
    // 描述确实插在图片位置，且是合法注释；原图换成「原图」链接
    assert.ok(stub.state.descMd.includes('<!-- image-desc: 一张展示损失下降的折线图。 -->'));
    assert.ok(stub.state.descMd.includes('[原图](http://'));
    assert.ok(!stub.state.descMd.includes('![image]'), '原图不该再嵌进正文');
  } finally {
    stub.server.close();
  }
});

test('read 模式在未生成时返回 NOT_GENERATED', async () => {
  const stub = await startStub({ ignoreFlag: false });
  try {
    await assert.rejects(
      () => mod.runDescribeImages(configFor(stub), { docIds: [1], read: true, quiet: true }),
      (error) => {
        assert.strictEqual(error.code, 'NOT_GENERATED');
        return true;
      },
    );
  } finally {
    stub.server.close();
  }
});

test('doc_id 不存在时抛 NOT_FOUND，且不触发任何保存', async () => {
  const stub = await startStub({ ignoreFlag: false });
  const originalRead = stub.server.listeners('request')[0];
  stub.server.removeAllListeners('request');
  stub.server.on('request', (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname.endsWith('/v1/doc/filedetail')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('null');
      return;
    }
    originalRead(req, res);
  });
  try {
    await assert.rejects(
      () => mod.runDescribeImages(configFor(stub), { docIds: [999], quiet: true }),
      (error) => {
        assert.strictEqual(error.code, 'NOT_FOUND');
        return true;
      },
    );
    assert.strictEqual(stub.state.saves.length, 0, '不应发生任何保存');
  } finally {
    stub.server.close();
  }
});

test('描述被长度上限截断时，结果里的 truncated 会如实计数', async () => {
  // 假模型返回 100 字符，上限设 20 → 必然被截断
  const stub = await startStub({ ignoreFlag: false, descText: '这是一句很长的描述。'.repeat(10) });
  try {
    const payload = await mod.runDescribeImages(configFor(stub), {
      docIds: [1],
      maxDescChars: 20,
      quiet: true,
    });
    const doc = payload.documents[0];
    assert.strictEqual(doc.max_desc_chars, 20);
    assert.strictEqual(doc.truncated, 1, '应记 1 条被截断');
    assert.strictEqual(doc.saved.ok, true);
    assert.ok(stub.state.descMd.length < 120, `描述应被截短：${stub.state.descMd}`);
  } finally {
    stub.server.close();
  }
});

test('描述超长时先压缩（不硬砍）：compressed 计数、truncated 为 0', async () => {
  const stub = await startStub({
    ignoreFlag: false,
    descText: '这是一句很长的描述。'.repeat(10), // 100 字符
    compressTo: '压缩后的要点。', // 压缩调用返回短文本
  });
  try {
    const payload = await mod.runDescribeImages(configFor(stub), {
      docIds: [1],
      maxDescChars: 20,
      quiet: true,
    });
    const doc = payload.documents[0];
    assert.strictEqual(doc.compressed, 1, '应走压缩分支');
    assert.strictEqual(doc.truncated, 0, '压缩成功就不该算截断');
    assert.strictEqual(doc.saved.ok, true);
    assert.ok(stub.state.descMd.includes('压缩后的要点。'));
  } finally {
    stub.server.close();
  }
});

test('模型撞上 max_tokens（finish_reason=length）时记 incomplete，不谎报完整', async () => {
  const stub = await startStub({ ignoreFlag: false, finishReason: 'length' });
  try {
    const payload = await mod.runDescribeImages(configFor(stub), { docIds: [1], quiet: true });
    const doc = payload.documents[0];
    assert.strictEqual(doc.incomplete, 1, '应记 1 条不完整');
    // 内容照常保存（不丢已生成的部分），但计数必须如实
    assert.strictEqual(doc.saved.ok, true);
  } finally {
    stub.server.close();
  }
});

test('dry_run 不调用保存接口', async () => {
  const stub = await startStub({ ignoreFlag: false });
  try {
    const payload = await mod.runDescribeImages(configFor(stub), { docIds: [1], dryRun: true, quiet: true });
    const doc = payload.documents[0];
    assert.strictEqual(stub.state.saves.length, 0);
    assert.deepStrictEqual(doc.saved, { ok: false, error: 'DRY_RUN' });
    assert.ok(doc.preview_head.length > 0);
  } finally {
    stub.server.close();
  }
});

/* ------------------------------------------------------------------ *
 * 结构图（A 类）：模型给「节点/边」数据，代码生成 PlantUML
 * ------------------------------------------------------------------ */

const GRAPH_JSON = JSON.stringify({
  title: 'BPE 学习流程',
  nodes: [
    { id: 'n1', label: '词表' },
    { id: 'n2', label: '统计二元组' },
    { id: 'n3', label: '符号合并表' },
  ],
  edges: [
    { from: 'n1', to: 'n2', label: '统计二元组' },
    { from: 'n2', to: 'n3', label: '合并(e,s)' },
    { from: 'n3', to: 'n1', label: '更新词表' },
  ],
});

test('结构图：保存的 md 里是隐藏的结构注释，且这张图没有描述注释', async () => {
  const stub = await startStub({ ignoreFlag: false, descText: GRAPH_JSON });
  try {
    const before = stub.state.mainMd;
    const payload = await mod.runDescribeImages(configFor(stub), { docIds: [1], quiet: true });
    const doc = payload.documents[0];
    const md = stub.state.descMd;

    assert.strictEqual(doc.diagram.rendered, 1);
    assert.strictEqual(doc.diagram.fallback, 0);
    assert.strictEqual(doc.diagram.nodes, 3);
    assert.strictEqual(doc.diagram.edges, 3);
    assert.strictEqual(doc.saved.verified, true);
    assert.strictEqual(stub.state.mainMd, before, '主 md 不应被改动');

    assert.ok(md.includes('```plantuml'), md);
    assert.ok(md.includes('@startuml') && md.includes('@enduml'));
    assert.ok(md.includes('title BPE 学习流程'));
    assert.ok(md.includes('rectangle "词表" as n1'));
    assert.ok(md.includes('n1 --> n2 : 统计二元组'));
    assert.ok(!md.includes('image-desc'), '结构图不该再留描述注释');
    // 有草图 → 原图不再嵌入，只剩一行可点链接
    assert.ok(!md.includes('![image]'), '有草图的原图不该再嵌入');
    assert.ok(md.includes('[原图](http'), '应保留原图地址链接');
    assert.ok(md.indexOf('```plantuml') < md.indexOf('[原图]'), '草图在链接上方');
    // 配对：一块草图 = 一个 ```plantuml 开 + 一个 ``` 收
    assert.strictEqual((md.match(/```plantuml/g) || []).length, 1);
    assert.strictEqual((md.match(/^```$/gm) || []).length, 1);
  } finally {
    stub.server.close();
  }
});

test('结构图：分类 1 次 + 主读 1 次 + 复核 1 次，只保留两边一致的连线', async () => {
  const stub = await startStub({ ignoreFlag: false, descText: GRAPH_JSON });
  try {
    const payload = await mod.runDescribeImages(configFor(stub), { docIds: [1], judgeModel: 'judge-m', quiet: true });
    const doc = payload.documents[0];
    assert.strictEqual(stub.state.chatCalls, 3, `实际发了 ${stub.state.chatCalls} 次请求（分类+主读+复核）`);
    assert.strictEqual(doc.diagram.structured, 1, '应记 1 张判为结构图');
    assert.strictEqual(doc.diagram.dual, 1);
    assert.strictEqual(doc.diagram.agreed, 1, '两侧一致时交集应可用');
    assert.strictEqual(doc.diagram.rendered, 1);
  } finally {
    stub.server.close();
  }
});

test('结构图：judgeModel 置空时不跑复核（省一次调用）', async () => {
  const stub = await startStub({ ignoreFlag: false, descText: GRAPH_JSON });
  try {
    const payload = await mod.runDescribeImages(configFor(stub), { docIds: [1], judgeModel: '', quiet: true });
    const doc = payload.documents[0];
    assert.strictEqual(stub.state.chatCalls, 2, '分类 + 主读，共 2 次');
    assert.strictEqual(doc.diagram.dual, 0);
    assert.strictEqual(doc.diagram.rendered, 1);
  } finally {
    stub.server.close();
  }
});

test('判为"写描述"的图不发结构提示词，直接出注释', async () => {
  const stub = await startStub({ ignoreFlag: false, descText: '一张海报式的分层信息图，含多个色块分区。', kindText: 'PROSE' });
  try {
    const payload = await mod.runDescribeImages(configFor(stub), { docIds: [1], judgeModel: '', quiet: true });
    const doc = payload.documents[0];
    assert.strictEqual(doc.diagram.structured, 0);
    assert.strictEqual(doc.diagram.as_prose, 1);
    assert.strictEqual(doc.diagram.rendered, 0, '判为描述就不该出草图');
    assert.ok(stub.state.descMd.includes('<!-- image-desc: 一张海报式'), stub.state.descMd);
    assert.ok(!stub.state.descMd.includes('```plantuml'), '不该出现草图围栏');
  } finally {
    stub.server.close();
  }
});

test('图数据不可用但还有文字：回退成描述注释，并如实记 fallback', async () => {
  const tinyGraph =
    '这是一张流程图。{"nodes":[{"id":"n1","label":"a"},{"id":"n2","label":"b"}],"edges":[{"from":"n1","to":"n2"}]}';
  const stub = await startStub({ ignoreFlag: false, descText: tinyGraph });
  try {
    const payload = await mod.runDescribeImages(configFor(stub), { docIds: [1], quiet: true });
    const doc = payload.documents[0];
    const md = stub.state.descMd;

    assert.strictEqual(doc.diagram.rendered, 0);
    assert.strictEqual(doc.diagram.fallback, 1);
    assert.ok(!md.includes('```plantuml'), '不该画出半成品草图');
    assert.ok(md.includes('<!-- image-desc: 这是一张流程图。 -->'), md);
    assert.ok(!md.includes('"nodes"'), 'JSON 不能漏进注释');
    assert.ok(doc.warnings.some((w) => w.startsWith('DIAGRAM_FALLBACK')), JSON.stringify(doc.warnings));
    assert.strictEqual(doc.saved.verified, true);
  } finally {
    stub.server.close();
  }
});

test('图数据不可用又没有文字：不把半截 JSON 写进注释（整体 ALL_FAILED）', async () => {
  const noProse = '{"nodes":[{"id":"n1","label":"a"},{"id":"n2","label":"b"}],"edges":[{"from":"n1","to":"n2"}]}';
  const stub = await startStub({ ignoreFlag: false, descText: noProse });
  try {
    await assert.rejects(
      () => mod.runDescribeImages(configFor(stub), { docIds: [1], quiet: true }),
      (error) => {
        assert.strictEqual(error.code, 'ALL_FAILED');
        return true;
      },
    );
    assert.strictEqual(stub.state.saves.length, 0, '没东西可存就不该调保存');
  } finally {
    stub.server.close();
  }
});

test('结构数据不可用时会补一次"纯描述"，保证每张图都有产出', async () => {
  const tinyGraph = '{"nodes":[{"id":"n1","label":"a"},{"id":"n2","label":"b"}],"edges":[{"from":"n1","to":"n2"}]}';
  const stub = await startStub({
    ignoreFlag: false,
    descText: tinyGraph,
    proseOnRetry: '一张组织架构图，含战略运营部与品牌运营部两个部门。',
  });
  try {
    const payload = await mod.runDescribeImages(configFor(stub), { docIds: [1], judgeModel: '', quiet: true });
    const doc = payload.documents[0];
    assert.strictEqual(doc.diagram.rendered, 0);
    assert.strictEqual(doc.diagram.prose_retry, 1, '应该记一次"补描述"');
    assert.strictEqual(doc.described, 1, '补到的描述要算进 described');
    assert.ok(stub.state.descMd.includes('<!-- image-desc: 一张组织架构图'), stub.state.descMd);
    assert.strictEqual(doc.saved.verified, true);
  } finally {
    stub.server.close();
  }
});

test('diagram=off：只发一次纯描述请求，产物与旧行为一致', async () => {
  const stub = await startStub({ ignoreFlag: false, descText: '一张展示损失下降的折线图。' });
  try {
    const payload = await mod.runDescribeImages(configFor(stub), { docIds: [1], diagram: 'off', quiet: true });
    const doc = payload.documents[0];
    assert.strictEqual(doc.diagram.mode, 'off');
    assert.strictEqual(doc.diagram.rendered, 0);
    assert.strictEqual(stub.state.chatCalls, 1);
    assert.ok(!stub.state.lastPrompt.includes('A. 结构图'), '关闭后不该再给二选一提示词');
    assert.ok(stub.state.descMd.includes('<!-- image-desc: 一张展示损失下降的折线图。 -->'));
    assert.ok(!stub.state.descMd.includes('```plantuml'));
    assert.ok(!doc.warnings.some((w) => w.startsWith('DIAGRAM_NONE')), '关闭时不该报 DIAGRAM_NONE');
  } finally {
    stub.server.close();
  }
});

test('普通描述不会误入结构图分支（模型都按描述回答时记 DIAGRAM_NONE）', async () => {
  const stub = await startStub({ ignoreFlag: false });
  try {
    const payload = await mod.runDescribeImages(configFor(stub), { docIds: [1], quiet: true });
    const doc = payload.documents[0];
    assert.strictEqual(doc.diagram.rendered, 0);
    assert.strictEqual(doc.diagram.fallback, 0, '普通描述不该被算成回退');
    assert.ok(doc.warnings.some((w) => w.startsWith('DIAGRAM_NONE')), JSON.stringify(doc.warnings));
  } finally {
    stub.server.close();
  }
});
