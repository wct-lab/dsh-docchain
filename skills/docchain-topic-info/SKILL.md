---
name: docchain-topic-info
description: 查询 docchain 文档主题（topic_id，非 Kafka Topic）列表，支持分页与按名称或 ID 关键字过滤。通过工具 docchain_topic_info 直接执行。触发关键词：查看主题、主题列表、所有主题、有哪些主题、主题信息、文档主题、搜主题、按关键字查主题、按 ID 查主题。
---

# /docchain-topic-info — 主题信息查询

查询 docchain 系统中的主题列表，支持分页浏览与按名称或 ID 关键字过滤。常作为其它检索的前置步骤：先拿到 `topic_id`，再按主题检索或上传。

## 触发方式

用户调用 `/docchain-topic-info` 后跟查询参数，或使用自然语言激活：

```
/docchain-topic-info
看下主题列表第 2 页，每页 10 条
按关键字 test 过滤主题名称
主题 10904 叫什么
```

## 参数说明

调用工具 `docchain_topic_info` 时传这些参数：

| 参数 | 必填 | 默认值 | 说明 |
|--------|:----:|:------:|----------------------|
| page | ❌ | 1 | 页码 |
| size | ❌ | 20 | 每页数量（上限 500） |
| keyword | ❌ | 无 | 主题名称或 ID 关键字过滤（服务端同时匹配两者） |

## 对应工具

**`docchain_topic_info`** —— 由宿主直接执行，**不要手工去跑脚本**。

调用示例：
- 第一页默认：`{}`
- 按关键字：`{ keyword: "test" }`
- 按 topic_id 精确查：`{ keyword: "10904" }`（服务端同时匹配 ID，输入完整 ID 即唯一命中）
- 关键字 + 分页：`{ keyword: "test", page: 1, size: 10 }`

## 输出格式

工具返回结构化 JSON：

```json
{
  "ok": true,
  "mode": "topics",
  "total": 2726,
  "page": 1,
  "size": 20,
  "pages": 137,
  "topics": [
    { "id": 10904, "name": "test1011", "state": "A",
      "create_date": "2026-10-11 19:40:34", "create_by_name": "bote_..." }
  ]
}
```

### 失败

返回 `{ "ok": false, "error": "...", "message": "..." }`：

| error | 含义 |
|-------|------|
| CONFIG | 缺少服务地址/密钥 |
| NO_PERMISSION | 无权限访问主题列表（HTTP 401/403） |
| SERVER_ERROR | 其他服务端/网络错误 |
