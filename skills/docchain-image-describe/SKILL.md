---
name: docchain-image-describe
description: 把 docchain 文档里的图片转成文字：读主 md → 逐张图片交给多模态模型生成中文描述 → 在每张图片上方插入 `<!-- image-desc: … -->` → 写成旁路描述 md（主 md 一字不动，用 read_format=image_description_md 读回）。通过工具 docchain_image_describe 直接执行。适用于"把文档里的图变成文字""给图片加描述""让 chat-agent 能读懂图片内容"。触发关键词：图片转文字、图片描述、给图片加描述、文档图片说明、图片转文本、image describe、image to text。
---

# /docchain-image-describe — 文档图片转文字

你是 docchain 的图片转文字助手。用户给一篇（或几篇）文档，你把里面每张图片交给多模态模型生成中文描述，插在图片上方，存成该文档的**旁路描述 md**。

主 md 不会被动。描述 md 是独立的文件，用 `read_format=image_description_md` 读取。

## 典型用法

```
把《大语言模型从理论到实践》里的图片都转成文字
给 125755 的图片加描述，先跑 2 张看看效果
帮我搜名字带"大语言模型"的文档，我自己选一篇
125755 的图片描述生成好了吗？读出来看看
这台机器上能用哪些视觉模型？
```

## 参数说明

调用工具 `docchain_image_describe` 时传这些参数：

| 参数 | 必填 | 默认值 | 说明 |
|------|:----:|:-----:|------|
| doc_ids | ❌ | - | 文档 ID 数组。为空时必须给 `keyword` 或 `list_models` |
| keyword | ❌ | - | 文档名关键字：**只返回候选清单**，不描述、不保存 |
| topic_ids | ❌ | 配置页选中主题 | 候选模式的搜索范围 |
| max_images | ❌ | 0（全部） | 每篇最多处理几张。**第一次建议先用 2 试跑** |
| concurrency | ❌ | 8 | 同时处理几张，上限 10（实测 12 起被网关限流） |
| dry_run | ❌ | false | 只生成不保存，返回统计与预览 |
| model | ❌ | `qwen3-vl-plus` | 覆盖默认视觉模型 |
| list_models | ❌ | false | 只列出当前 key 可用的视觉模型 |
| read | ❌ | false | 只读取已生成的描述 md |
| confirm | ❌ | false | 批量（>1 篇）时必须显式确认才执行 |

## 对应工具

**`docchain_image_describe`** —— 由宿主直接执行，**不要手工去跑脚本**。

- 先看候选：`{ keyword: "大语言模型", topic_ids: [10904] }`
- 试跑两张：`{ doc_ids: [125755], max_images: 2, dry_run: true }`
- 正式跑：`{ doc_ids: [125755] }`
- 批量：`{ doc_ids: [125755, 125676] }` → 先返回清单，再 `{ ..., confirm: true }`
- 读回：`{ doc_ids: [125755], read: true }`
- 看模型：`{ list_models: true }`

## 拿到结果后必须做的事

1. **候选模式**（`mode: "candidates"`）：把候选按表格列给用户，让他选；**不要自己替他选**，也不要直接开跑。
2. **试跑 / 正式跑**（`mode: "describe"`）：报告 `described / unique`、耗时、`failed` 列表、`partial` 是否为 true。
3. **`partial: true`**：说明只处理了前 N 张，其余没描述，必须明确告诉用户。
4. **`read` 模式**：把 `preview` 或摘要呈现给用户；`NOT_GENERATED` 说明还没生成过。

## 输出格式

候选：

```json
{ "ok": true, "mode": "candidates", "keyword": "大语言模型", "total": 1,
  "candidates": [ { "doc_id": 125755, "name": "…pdf", "topic_id": 10904, "topic_name": "test1011" } ],
  "note": "候选只是清单，尚未处理。请让用户选定后再带 doc_ids 调用一次。" }
```

模型清单：

```json
{ "ok": true, "mode": "models", "base_url": "https://…/gpt-proxy/v1",
  "default_model": "qwen3-vl-plus", "fallback_model": "g-deepseek-v4-flash",
  "total": 141, "models": [ { "id": "qwen3-vl-plus", "desc": "…", "free": false } ] }
```

处理结果：

```json
{ "ok": true, "mode": "describe", "total": 1, "saved": 1,
  "documents": [ {
    "doc_id": 125755, "name": "…pdf", "topic_id": 10904, "topic_name": "test1011",
    "model": "qwen3-vl-plus", "fallback_used": false,
    "refs": 185, "unique": 185, "picked": 185,
    "described": 185, "injected": 185, "partial": false,
    "unparsed": 0, "rate_limited": 0, "failed": [], "warnings": [],
    "bytes_before": 1217251, "bytes_after": 1299029,
    "saved": { "ok": true, "bytes": 1299029, "verified": true },
    "elapsed_ms": 168000
  } ] }
```

### 失败

返回 `{ "ok": false, "error": "...", "message": "..." }`（批量时每篇各带自己的 error）：

| error | 含义 | 怎么办 |
|-------|------|--------|
| CONFIG | 缺 docchain/vision 配置、没有可用参数 | 按 message 补配置 |
| NOT_FOUND | doc_id 不存在 | 核对 ID（先 `docchain_doc_search`） |
| NO_CONTENT | 主 md 为空 | 该文档还没解析出 md |
| NO_IMAGES | md 里没有图片引用 | 换一篇 |
| NO_RESULTS | 名字搜不到文档 | 换关键字或放宽 topic_ids |
| NOT_GENERATED | 还没生成过描述 md | 先跑一次生成 |
| SOURCE_CHANGED | 处理期间主 md 被改 | 重跑 |
| SAVE_FAILED | 保存接口返回非 success | 看 message 里的原始响应 |
| SAVE_UNVERIFIED | 保存成功但读回不一致 | 重跑；仍失败说明服务端有问题 |
| SAVE_WRONG_TARGET | 保存走了"覆盖主 md"分支，**已自动写回原内容** | 主 md 已恢复，把这条反馈给后端 |
| RESTORE_FAILED | 主 md 被覆盖且写回失败 | 用 `/v1/doc/redo_markdown` 重新解析 |
| ALL_FAILED | 所有图片都没生成描述 | 检查网关连通与模型权限 |
| MODEL_UNAVAILABLE | 主/降级模型都不可用 | 用 `list_models` 看可用清单 |
| RATE_LIMITED | 持续 429 | 降低 `concurrency` 后重试 |

## 已知边界

- **幂等口径**：每次从干净的主 md 重新生成，所以**结构**幂等（不会累积注释）；但模型输出可能有波动，重复跑产物不保证逐字相同。
- **时间**：描述按"信息密度"生成（平均 350–400 字符），单张约 8–12 秒；185 张图、并发 8 约 **4–6 分钟**。先 `max_images: 2` 试跑估时。
- **精度优先**：专有名词/字段名/单位/数值/公式照抄原文，纯装饰（圆角、线条、填充）与重复句一律删掉；实测比"完整还原"版短 57%，信息量反而更高。
- **长度**：单条上限默认 **2000** 字符。超长时**先让模型压缩**（保留名称/数值/公式，删掉修饰语），压缩不下来才按句末截断。结果里三个计数：`compressed`（走了压缩）、`truncated`（最终仍被砍）、`incomplete`（撞上 max_tokens、内容停在半句）—— **`truncated` 或 `incomplete` 不为 0 才说明真的丢信息**。
- **并发**：8 是实测最优点；12 起 429，3/4 反而更慢（网关批处理效应）。
- **置信度**：描述来自多模态模型，可能有误读（尤其是密集表格与公式），关键数据请回看原图。
- **配置位置**：`docchain_vision_*` 不在插件配置页的输入框里，改设置文档或环境变量（`VISION_BASE_URL` / `VISION_MODEL` / `VISION_API_KEY` / `VISION_MAX_DESC_CHARS`）。
- **体积**：>400 张图的文档描述 md 可能超过 2 MB，保存时会带 `LARGE_PAYLOAD` 提示。
