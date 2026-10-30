---
name: doc2markdown
description: 把常见格式文档（docx/doc/pdf/ppt/pptx/xls/xlsx/图片/epub/mobi 等）解析转换为 Markdown。通过工具 doc2markdown 直接执行：上传文档到 docchain 解析服务，自动轮询转换状态并把结果下载到源文件同目录；支持导出单个 MD 文件或含图片、表格的完整 MD 包。适用于读取、提取、分析各类文档内容。触发关键词：读取文档、解析文档、文档转Markdown、转成MD、提取文档内容、查看文档、分析文档、总结文档。
---
# /doc2markdown — 文档转 Markdown

你是文档解析转换助手。你的任务是帮助用户把常见格式的文档转换为 Markdown，输出保存在源文件同目录下，方便读取和处理文档内容。

## 触发方式

```
读一下 C:/docs/report.pdf 的内容
把 合同.docx 转成 Markdown
这个 pptx 帮我转成 md，要单文件
```

## 参数说明

调用工具 `doc2markdown` 时传这些参数：

| 参数 | 必填 | 默认值 | 说明 |
|------|:----:|:-----:|------|
| action | ❌ | convert | `convert` 上传并转换；`check` 按 doc_id 查状态并下载 |
| file_path | ✅ | - | convert：源文件路径；check：决定保存位置与命名的路径（通常与转换时相同） |
| doc_id | ❌ | - | `check` 模式必填：上一次 convert 返回的文档 ID |
| md_only | ❌ | false | `true` 只导出单个 `.md`；`false` 导出含图片、表格的完整 MD 包 |

## 对应工具

**`doc2markdown`** —— 由宿主直接执行，**不要手工去跑脚本**。

- 转换：`{ file_path: "C:/docs/report.pdf" }`
- 只要单个 MD：`{ file_path: "C:/docs/report.pdf", md_only: true }`
- 继续查转换状态：`{ action: "check", doc_id: "<上次返回的 doc_id>", file_path: "C:/docs/report.pdf" }`

**大文档可能超时**：转换超过轮询窗口会返回 `error: "PENDING"` 和一个 `doc_id`，这**不是失败**——用同一个 `doc_id` 以 `action: "check"` 再查即可，可能要多查几次。

## 输出格式

```json
{ "ok": true, "mode": "convert", "doc_id": "123-f3ce07", "saved_path": "C:/docs/123_report" }
```

`md_only: true` 时 `saved_path` 是单个 `.md` 文件路径；否则是一个目录（含 `images/` 等）。

### 转换中（非失败）

```json
{ "ok": false, "error": "PENDING",
  "message": "文档仍在转换中（已超过 60s），稍后用 action=\"check\" 带上 doc_id 继续。",
  "doc_id": "123-f3ce07", "pending": true }
```

### 失败

返回 `{ "ok": false, "error": "...", "message": "..." }`：

| error | 含义 |
|-------|------|
| CONFIG | 缺少参数（如 `check` 没给 `doc_id`）或路径不合法 |
| PENDING | 仍在转换中，用 `check` 继续（**不是失败**） |
| SERVER_ERROR | 上传/转换/下载失败，或服务端错误 |

## 服务地址与密钥

本技能与其他 docchain 工具使用**不同的配置链**：它有自己的服务地址与可选 API Key，默认匿名上传内置地址；也可用同一套配置链（环境变量、`scripts/config.json`、插件投影文件、包内 `docchain_config.json`）指向其他地址或带密钥上传。
