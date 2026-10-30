---
name: docchain-upload
description: Docchain 批量文档上传工具。支持单文件上传、文件夹批量上传（仅顶层，不递归）。通过工具 docchain_upload 直接执行。适用于需要批量导入文档到 docchain 系统的场景。关键词：批量上传、文件夹上传、docchain上传、文档导入、bulk upload、batch upload、文档迁移、文件批量处理。
---
# /docchain-upload — Docchain 批量文档上传工具

你的任务是帮助用户将本地文件或文件夹批量上传到 docchain 系统。

> 这是**写操作**：会真正把文件写入知识库。调用前必须和用户确认目标主题与路径，不要自行猜测 `topic_id`。

## 触发方式

```
上传文件 document.pdf 到主题 123
批量上传文件夹 /path/to/docs 到 docchain 主题 456
把 ./report.pdf 传到主题 10904
```

## 参数说明

调用工具 `docchain_upload` 时传这些参数：

| 参数 | 必填 | 默认值 | 说明 |
|------|:----:|:-----:|------|
| path | ✅ | - | 要上传的文件路径，或文件夹路径（`mode: "folder"` 时） |
| topic_id | ✅ | - | 目标主题 ID（正整数） |
| mode | ❌ | file | `file` 上传单个文件；`folder` 上传该文件夹内**顶层**文件（不递归子目录） |

## 对应工具

**`docchain_upload`** —— 由宿主直接执行，**不要手工去跑脚本**。

- 单文件：`{ path: "C:/docs/report.pdf", topic_id: 123 }`
- 整个文件夹：`{ path: "C:/docs", topic_id: 456, mode: "folder" }`

执行前先确认：主题 ID 是否正确、路径是否存在、文件夹是否只包含想上传的文件。

## 输出格式

### 单文件

```json
{ "ok": true, "mode": "single", "doc_id": 125672, "doc_name": "report.pdf",
  "topic_id": 123, "file": "C:/docs/report.pdf" }
```

### 批量

```json
{
  "ok": true,
  "mode": "batch",
  "total": 3,
  "success": 2,
  "failed": 1,
  "results": [
    { "success": true, "file": "...", "doc_id": 125672, "doc_name": "a.pdf", "topic_id": 123 },
    { "success": false, "file": "...", "error": "API请求失败: ..." }
  ]
}
```

批量上传 `failed > 0` 时 `ok` 为 `false`，但 `results` 里逐个给出了成败，需要如实向用户报告哪些成功、哪些失败。

### 失败

返回 `{ "ok": false, "error": "...", "message": "..." }`：

| error | 含义 |
|-------|------|
| CONFIG | 缺少服务地址/密钥，或 `topic_id`/`path` 不合法 |
| NOT_FOUND | 路径不存在 |
| NO_RESULTS | 文件夹里没有可上传的文件 |
| NO_PERMISSION | 无权限上传到该主题（HTTP 401/403） |
| SERVER_ERROR | 其他服务端/网络错误 |
