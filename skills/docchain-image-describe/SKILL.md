---
name: docchain-image-describe
description: 把 docchain 文档里的图片转成文字：读主 md → 逐张图片交给多模态模型 → 普通图片在图片上方插入 `<!-- image-desc: … -->` 中文描述，流程图/架构图这类结构图改出一段 `plantuml` 草图（代码块替代描述注释）→ 写成旁路描述 md（主 md 一字不动，用 read_format=image_description_md 读回）。通过工具 docchain_image_describe 直接执行。适用于"把文档里的图变成文字""给图片加描述""让 chat-agent 能读懂图片内容""把流程图变成可读的结构"。触发关键词：图片转文字、图片描述、给图片加描述、文档图片说明、图片转文本、流程图转 PlantUML、结构图草图、image describe、image to text。
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
| judge_model | ❌ | `qwen3-vl-plus` | 结构图的**复核模型**：同一张图读两遍，只删两家"方向相反"的边。传空串 = 只读一遍（省一半调用） |
| list_models | ❌ | false | 只列出当前 key 可用的视觉模型 |
| read | ❌ | false | 只读取已生成的描述 md |
| confirm | ❌ | false | 批量（>1 篇）时必须显式确认才执行 |
| diagram | ❌ | `on` | `on`：先判每张图，**结构图出 `plantuml` 草图、其它图出中文描述注释**；`off`：不判也不出草图，全部只写描述注释。两种模式下原图都只留 `[原图](地址)` 链接 |

## 视觉模型怎么选

工具**没有 `model` 参数**，视觉模型只有两个来源：

1. **跟随当前对话模型** —— 你在对话里选哪个模型，就用哪个读图。
2. **对话模型读不了图时由你点选** —— 工具会暂停并弹出一个选择框，按综合能力列出视觉模型（前几个是 `qwen3-vl-plus`、`doubao-seed-2.0-pro`、`glm-5v-turbo`，后面按字母序补足，共 8 个），你点一个后流程继续。

第 2 种选择**只对本次调用生效**，不会改动你的对话模型；你不选就中止，不会有人替你决定。

> 想长期用视觉模型，请直接在对话模型下拉里切换。

## 对应工具

**`docchain_image_describe`** —— 由宿主直接执行，**不要手工去跑脚本**。

- 先看候选：`{ keyword: "大语言模型", topic_ids: [10904] }`
- 试跑两张：`{ doc_ids: [125755], max_images: 2, dry_run: true }`
- 正式跑：`{ doc_ids: [125755] }`
- 批量：`{ doc_ids: [125755, 125676] }` → 先返回清单，再 `{ ..., confirm: true }`
- 读回：`{ doc_ids: [125755], read: true }`
- 看模型：`{ list_models: true }`
- 只要描述、不要结构草图：`{ doc_ids: [125755], diagram: "off" }`

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
    "diagram": { "mode": "on", "rendered": 47, "fallback": 0, "nodes": 512, "edges": 640 },
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
- **先分类再执行**：每张图先单独问一次「该出结构还是该写描述」，只让它回答一个词；判为结构才用结构提示词，判为描述直接用纯描述提示词。判据是"图里的**连接线**是否承载信息"：有连线、且去掉连线关系就没了 → 结构；靠色块/分栏/竖排标注表达的版式信息图、方框之间没有连线的并列表 → 描述（哪怕它看起来有很多方框）。结果里 `diagram.structured` / `diagram.as_prose` 是两个分类计数，`diagram.suspect` 是"判成描述但回答里又出现图数据"、补问过一次的张数，`diagram.annotation_guard` 是"判成结构但节点多是版面标注"、被兜底退回描述的张数。
- **产物形态（两种图统一）**：结构图 → 一段 `plantuml` 代码块；其它图 → 一段中文描述注释。**无论哪种，原图都不再嵌进正文**，统一改成一行 `[原图](地址)` 链接，需要对照时点开。
- **草图 ≠ 还原**：节点与边是模型看图判读出来的，语法一定合法（由脚本按固定模板生成），但**结构可能有误** —— 漏一条连线、多认一个框都发生过，关键流程请回看原图。`diagram: "off"` 可整体退回"只写描述"。
- **可疑复核**：判成"描述"、但那次回答里出现了图数据签名 `"nodes":`（说明它其实看得到结构）时，会补问一次结构提示词，能出图就改判为图；平时刻意不做，避免每张都多花一次调用。
- **版式图兜底**：即使被判成结构图，只要产出的"节点名"里有 ≥3 个且 ≥25% 是版面标注（含句读 `：，。；、` 或分层间隔号 `·`），就认定这是版式信息图，不画草图、退回描述（计 `diagram.annotation_guard`）。注意**省略号 `…` 不算证据** —— 那是截断长名字留下的痕迹，拿它判会把正常架构图误伤。
- **画法单一**：所有结构图统一按「方框 + 带标签箭头」**竖排**渲染（阅读区窄，横排必被裁）；时序图不会画成"参与者+消息"的标准时序图。
- **规模上限**：单张结构图最多 **28 节点 / 48 条边**；渲染后超过 **860 字符**时做裁剪。
- **裁剪顺序（重要）**：只删"有父节点、没有子节点"的叶子，且**优先删层级最深的** —— 顶层的并排部门一个都不能少。早先按"兄弟最多优先"删，曾把一张组织图根下面 8 个中心里的两个删掉。
- **叠层清理**：主 md 里如果已有旧 `image-desc` 注释（平台解析写的或人工加的），生成时**先剥掉再写本次结果**，不会出现"同一张图既像草图又像注释"。
- **两遍读图**：结构图会用 `model` 读一遍、`judge_model` 再读一遍，只删掉两家**方向相反**的边，其余保留；`judge_model` 传空串可关掉，省一半调用。
- **清噪规则**：1–2 位序号（`0`…`9`）、纯符号、`L×/N×/×N` 这类重复次数会被丢掉；`4096`、`224×224×3` 这类**真实层宽/尺寸会保留**；同名且**邻居完全一致**的重复节点会合并（`512→512→512` 这种同名长链不合并）。
- **回退**：模型给了图数据但不可用（被 max_tokens 截断、节点<3、边<2、边指向不存在的节点）会先**补一次"纯描述"调用**，补到就写注释（计 `prose_retry`），实在补不到才记 `DIAGRAM_INVALID` 失败 —— 绝不把半截 JSON 写进 md。
- **时间**：描述按"信息密度"生成（平均 350–400 字符），单张约 8–12 秒。结构图那张要**3 次调用**（分类 + 主读 + 复核），约 25–50 秒；描述图 **2 次**（分类 + 描述）。9 张图实测 1–4 分钟（网关波动大）。先 `max_images: 2` 试跑估时。
- **精度优先**：专有名词/字段名/单位/数值/公式照抄原文，纯装饰（圆角、线条、填充）与重复句一律删掉；实测比"完整还原"版短 57%，信息量反而更高。
- **长度**：单条上限默认 **2000** 字符。超长时**先让模型压缩**（保留名称/数值/公式，删掉修饰语），压缩不下来才按句末截断。结果里三个计数：`compressed`（走了压缩）、`truncated`（最终仍被砍）、`incomplete`（撞上 max_tokens、内容停在半句）—— **`truncated` 或 `incomplete` 不为 0 才说明真的丢信息**。
- **并发**：8 是实测最优点；12 起 429，3/4 反而更慢（网关批处理效应）。
- **置信度**：描述来自多模态模型，可能有误读（尤其是密集表格与公式），关键数据请回看原图。分类也只判一次、无自校验：判成"描述"就会静默丢掉结构，抽查时看 `diagram.as_prose` 与 `diagram.structured`。
- **配置位置**：`docchain_vision_*` 不在插件配置页的输入框里，改设置文档或环境变量（`VISION_BASE_URL` / `VISION_MODEL` / `VISION_FALLBACK_MODEL` / `VISION_JUDGE_MODEL` / `VISION_API_KEY` / `VISION_MAX_DESC_CHARS` / `VISION_DIAGRAM`）。
- **只处理 md 里引用的图**：平台解析阶段没抽出来的图（被水印覆盖、被判成装饰等）工具看不到；`redo_markdown` 只是用缓存重新生成 md，**不会重新抽图**，要重抽得让后台重新解析。
- **体积**：>400 张图的文档描述 md 可能超过 2 MB，保存时会带 `LARGE_PAYLOAD` 提示。
