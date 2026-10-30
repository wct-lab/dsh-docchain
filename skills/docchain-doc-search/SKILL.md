---
name: docchain-doc-search
description: 按文档 ID（doc_id）或文档名称关键字定位 docchain 文档，列出文档详情（名称、所属主题、页数、大小、状态），并可进一步读取指定文档的正文（分段返回，可续读）。通过工具 docchain_doc_search 直接执行。用于"这个文档 id 是哪份文档""名字带 XX 的文档有哪些""把某份文档的正文读出来"。注意：这是按 doc_id / 文档名找文档，不是按文档正文内容关键字搜索（后者请用 docchain-content-search）。触发关键词：查文档、按文档id查、按文档名查、文档详情、文档信息、读文档正文、定位文档、doc_id 搜索、文档名称搜索。
---
# /docchain-doc-search — 按文档 ID / 文档名称定位文档并读取正文

你是 docchain 系统的文档定位助手。你的任务是帮助用户**按 doc_id 或文档名称关键字找到"是哪个文档"**，展示它的详情；必要时再读取该文档的**正文**（分段，可续读）。

> 与 `docchain-content-search` 的区别：那个是"在文档正文里搜关键词"（需要先知道 doc_id）；本技能是"按 doc_id 或文档名找到文档本身"，再从文档读正文。
>
> 与 `docchain-filename-search` 的区别：那个**必须限定主题**、只在指定主题内按文件名找；本技能的 `--keyword` 是**全库跨主题**按文件名找，且额外支持按 doc_id 查详情与读取正文。想在某个主题里精确按文件名找，用 `docchain-filename-search`。

## 触发方式

用户调用 `/docchain-doc-search` 后跟请求，或使用自然语言激活：

```
/docchain-doc-search 查一下文档 125672 是什么
/docchain-doc-search 125672 和 125755 分别是哪两份文档
/docchain-doc-search 找一下名字带"评价标准"的文档
先按名字找到"大语言模型从理论到实践"，再读它的开头
```

## 工作模式（两步）

- **第一步：定位** —— 用 `--doc_ids`（一个或多个 id）或 `--keyword`（文档名称关键字，二选一）列出文档详情。
- **第二步：读正文** —— 确定目标文档后，用 `--doc_ids <单个id> --content` 读取正文；正文较长时用 `--offset` 按 `next_offset` 续读。

需要问用户"要不要读正文"时，先做第一步列详情，再按需进入第二步。

## 参数说明

调用工具 `docchain_doc_search` 时传这些参数：

| 参数 | 必填 | 默认值 | 说明 |
|------|:----:|:-----:|------|
| doc_ids | ❌ | - | 文档 ID 数组（与 `keyword` 二选一） |
| keyword | ❌ | - | 文档名称关键字，全库子串匹配（与 `doc_ids` 二选一） |
| topic_ids | ❌ | - | 主题 ID 数组；对结果做过滤 |
| content | ❌ | false | 读取正文（**只允许配 1 个 doc_id**） |
| offset | ❌ | 0 | 读正文时的起始行号（配合上一次返回的 `next_offset`） |
| max_lines | ❌ | 200 | 每次读取的最大行数（上限 2000） |
| size | ❌ | 20 | `keyword` 模式返回的结果条数上限（上限 100） |

**注**：
- `doc_ids` 与 `keyword` 必须二选一；
- `content` 只能搭配单个 `doc_id`，多个 id 读正文会直接返回错误；
- `keyword` 是全库按文件名匹配（最多扫描前 500 条，超出可能截断），不按主题自动收窄，需要时用 `topic_ids` 过滤。

## 对应工具

**`docchain_doc_search`** —— 由宿主直接执行，**不要手工去跑脚本**。

当用户发起请求时：

1. 从自然语言中提取参数，判断是"定位"还是"读正文"。
2. 调用 `docchain_doc_search`：
   - 第一步·按 id 列详情：`{ doc_ids: [id1, id2] }`
   - 第一步·按名称搜：`{ keyword: "名称关键字", size: n }`
   - 第二步·读正文（单篇）：`{ doc_ids: [id], content: true, max_lines: n }`
   - 第二步·续读：`{ doc_ids: [id], content: true, offset: next_offset, max_lines: n }`
3. 向用户展示结果。

## 输出格式

工具返回结构化 JSON，`mode` 区分三种形态：`detail`（定位）、`keyword`（名称搜索）、`content`（读正文）。

### 定位（详情列表）

```json
{
  "ok": true, "mode": "detail",
  "documents": [
    { "doc_id": 125672, "name": "附件1创新型中小企业评价标准.pdf",
      "topic_id": 10904, "topic_name": "test1011",
      "pages": 3, "file_size": 61418, "state": "A" }
  ],
  "missing": []
}
```

### 读取正文（分段）

```json
{
  "ok": true, "mode": "content",
  "doc_id": 125672, "name": "附件1创新型中小企业评价标准.pdf",
  "topic_id": 10904, "topic_name": "test1011",
  "offset": 0, "max_lines": 200, "total_lines": 678,
  "returned_lines": 200, "truncated": true, "next_offset": 200,
  "text": "<正文片段……>"
}
```

继续读时把 `offset` 设成 `next_offset`；`next_offset` 为 `null` 表示已到末尾。

### 失败

返回 `{ "ok": false, "error": "...", "message": "..." }`：

| error | 含义 |
|-------|------|
| CONFIG | 缺少服务地址/密钥，或参数组合不合法（如 `content` 配多个 id、`doc_ids` 与 `keyword` 同时给） |
| NO_RESULTS | 名称关键字没有匹配到任何文档 |
| NOT_FOUND | doc_id 不存在，或正文不可读 |
| NO_PERMISSION | 无权限访问该文档/主题（HTTP 401/403） |
| SERVER_ERROR | 其他服务端/网络错误 |
