---
name: docchain-filename-search
description: 在指定主题内按文件名关键字搜索文档。必须给出 topic_ids，只在这些主题范围内查找文件名包含关键词的文档。支持多个关键词（或关系）。适用于"在某个/某些主题里按文件名找文档"。注意：若要跨全部主题按文件名查找，用 docchain-doc-search --keyword；若要读文档正文，也用 docchain-doc-search。触发关键词：主题内搜文件名、在主题中查找文档、按文件名查找、文件名搜索。
---
# /docchain-filename-search — 在指定主题内按文件名搜索文档

你是 docchain 系统的文档文件名搜索助手。你的任务是帮助用户在**指定主题范围内**，通过文件名关键词快速找到文档。

> 与 `docchain-doc-search` 的区别：本技能**必须限定主题**，只在这些主题里按文件名找；若想**跨全部主题**按文件名查找、或按 doc_id 找文档、或读取文档正文，请改用 `docchain-doc-search`。

## 触发方式

用户调用 `/docchain-filename-search` 后跟搜索请求，或使用自然语言激活：

```
/docchain-filename-search 在主题 1,10 中查找文件名包含"合同"的文件
在主题 1,2,3 中查找"2024"的文档名称
在主题 100 里查找文件名有"协议"的文档
```

## 与 docchain-doc-search 的分工（重要）

| 需求 | 用哪个 |
|------|--------|
| 在**指定主题内**按文件名找文档 | 本技能 `docchain-filename-search`（必须给 topic_ids） |
| **跨全部主题**按文件名找文档 | `docchain-doc-search --keyword`（不需主题） |
| 按 doc_id 查是哪份文档 | `docchain-doc-search --doc_ids` |
| 读某份文档的正文 | `docchain-doc-search --content` |
| 按**正文内容**里的关键词搜 | `docchain-content-search` |

简言之：本技能 = 「限定主题 + 只按文件名」；doc-search = 「全库按文件名/ id，且能读正文」。

## 参数说明

| 参数 | 必填 | 默认值 | 说明 |
|------|:----:|:-----:|------|
| keywords | ✅ |   -   | 关键词，多个用逗号分隔 |
| topic_ids | ✅ |   -   | 主题 ID，多个用逗号分隔（本技能只在该范围内查找） |

## 执行方式

当用户发起搜索请求时：
1. 从自然语言请求中提取 keywords 和 topic_ids
2. 运行搜索脚本：
   ```bash
   node scripts/search_filename.js --keywords <关键词1,关键词2> --topic_ids <id1,id2> 
   ```
3. 向用户显示格式化的结果（末尾附一行机器可读 JSON）

## 输出格式

结果以清晰易读的格式显示：

```
🔍 搜索关键词：["合同", "协议"]
✅ 找到 5 个文档

📄 文档 ID: 12345 | 采购合同.pdf
   主题 ID: 100

📄 文档 ID: 67890 | 销售协议.docx
   主题 ID: 101
...
```