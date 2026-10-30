---
name: docchain-meta-search
description: 根据自定义元数据字段查询文档。通过元数据字段条件过滤文档，支持字符串、数值、时间类型的精确匹配和范围查询。通过工具 docchain_meta_search 直接执行。适用于按元数据筛选文档、查找符合特定属性条件的文档。触发关键词：元数据查询、按元数据搜索、按字段查询、元数据过滤、条件查询。
---
# /docchain-meta-search

你是元数据字段查询助手。你的任务是帮助用户通过自定义元数据字段条件，快速找到符合筛选条件的文档。

## 触发方式

使用自然语言激活：

```
在主题 1,10 中查询 author='张三' 的文档
在主题 100 中查询 create_time > '2024-01-01' 的文档
在主题 12 中查询部门='销售部' 且 金额>1000 的文档
查询主题123有哪些字段
列出主题1,10,20的字段结构
```

## 工作模式

- 应根据用户问题自动判断调用模式
- 不清楚主题有哪些字段时，先用 `list_fields: true` 列出字段
- 明确字段名后，再用条件查询

## 参数说明

调用工具 `docchain_meta_search` 时传这些参数：

| 参数 | 必填 | 默认值 | 说明 |
|------|:----:|:-----:|------|
| topic_ids | ❌ | - | 主题 ID 数组（与 `doc_ids` 至少给一个） |
| doc_ids | ❌ | - | 文档 ID 数组 |
| conditions | ❌ | - | AND 条件列表，每项 `{ field, op, value }` |
| or_groups | ❌ | - | OR 条件组：组内 OR、组间 AND，形如 `[[{field,op,value}, ...], ...]` |
| size | ❌ | 100 | 返回结果数量上限 |
| list_fields | ❌ | false | 仅列出主题的元数据字段结构（需要 `topic_ids`） |

**注**：必须提供 `topic_ids` 或 `doc_ids` 之一；`list_fields` 模式必须提供 `topic_ids`。

## 对应工具

**`docchain_meta_search`** —— 由宿主直接执行，**不要手工去跑脚本**。

- 模式一（列字段）：`{ topic_ids: [100], list_fields: true }`
- 模式二（条件查询）：`{ topic_ids: [100], conditions: [{ field: "author", op: "eq", value: "张三" }] }`

## op 操作符（按字段类型）

| 类型 | 操作符 | 说明 |
|------|--------|------|
| 字符串 | `eq` / `ne` / `contains` | 等于 / 不等于 / 包含 |
| 时间 | `time_eq` `time_ne` `time_gt` `time_gte` `time_lt` `time_lte` | 等于 / 不等于 / 大于 / 大于等于 / 小于 / 小于等于 |
| 数值 | `num_eq` `num_ne` `num_gt` `num_gte` `num_lt` `num_lte` | 同上 |

**自动识别规则**：

| 字段特征 | 用哪个前缀 | 示例 |
|---------|-----------|------|
| 字段名含 `count`、`num`、`amount`、`quantity`、`price`、`age` 等 | `num_` | count=1 → `{field:"count", op:"num_eq", value:"1"}` |
| 字段名含 `date`、`time`、`created`、`updated` 等 | `time_` | date>2026-04-01 → `{field:"date", op:"time_gt", value:"2026-04-01"}` |
| 字段值是纯数字 | `num_` | amount > 1000 → `{field:"amount", op:"num_gt", value:"1000"}` |
| 字段值是日期格式 | `time_` | create_time > '2024-01-01' → `{field:"create_time", op:"time_gt", value:"2024-01-01"}` |
| 字段值是普通文本 | `eq` 或 `contains` | author='张三' → `{field:"author", op:"eq", value:"张三"}` |

`or_groups` 示例：author 是张三或李四，且 age 是 18 或 20

```json
{
  "topic_ids": [100],
  "or_groups": [
    [{ "field": "author", "op": "eq", "value": "张三" }, { "field": "author", "op": "eq", "value": "李四" }],
    [{ "field": "age", "op": "num_eq", "value": "18" }, { "field": "age", "op": "num_eq", "value": "20" }]
  ]
}
```

## 输出格式

### 字段列表（`list_fields: true`）

```json
{ "ok": true, "mode": "fields",
  "topics": [{ "topic_id": 100, "fields": [{ "field_name": "author", "field_type": "str" }] }] }
```

### 查询结果

```json
{
  "ok": true,
  "mode": "query",
  "conditions": "author eq 张三 AND amount num_gt 1000",
  "total": 2,
  "returned": 2,
  "documents": [
    { "doc_id": 12345, "path": "采购合同.pdf", "topic_id": 100,
      "meta": [{ "field_name": "author", "field_type": "str", "value": "张三" }] }
  ]
}
```

### 失败

返回 `{ "ok": false, "error": "...", "message": "..." }`：

| error | 含义 |
|-------|------|
| CONFIG | 缺少服务地址/密钥、没给检索范围、或条件格式不合法（op 不在上表内） |
| NO_PERMISSION | 无权限访问该主题/文档（HTTP 401/403） |
| SERVER_ERROR | 其他服务端/网络错误 |
