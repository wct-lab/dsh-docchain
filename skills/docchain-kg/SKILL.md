---
name: docchain-kg
description: DocChain 知识图谱。全部走 DocChain API（无需 Neo4j 密码）：查本体结构（schema）、执行 Cypher（cypher）、写操作（本体/实体/关系增删）。
whenToUse: 用户问及 DocChain 知识图谱、实体/关系、图谱节点、本体、Neo4j，或需要新增/编辑/删除图谱节点与关系时使用。
---

# DocChain 知识图谱

用插件 `dsh-docchain` 提供的工具。全部走 DocChain HTTP API（X-Api-Key 认证，配置页 docchain_url 与 API Key，无需 Neo4j 密码）：查本体结构（schema）、执行 Cypher（cypher）、写操作（本体/实体/关系增删）。

## 图谱结构

- 事实知识图谱在数据库 `neo4j`：核心标签 `Document`（含 name/topic_id/doc_id）、`Entity`、`ontology`，关系 `CONTAINS`（Document → 实体/表格行节点）。
- 每个主题另有一个文档地图库 `docchaintopic{topic_id}`。

## 典型流程

1. `docchain_kg_schema`（topic_id=…）—— 查该主题的本体结构（实体类型 + 关系类型，含属性定义）。
2. `docchain_kg_cypher`（topic_id=… + cypher）—— 定位实体、查关系、看子图，或做任意组合查询（如 `MATCH (n) WHERE n.entity_name CONTAINS '关键字' RETURN n`）。
3. 列文档用文档工具（`docchain_doc_search` / `docchain_filename_search`），不用图谱工具。

## 图谱编辑（写操作，走 DocChain API，无需 Neo4j 密码）

- `docchain_kg_upsert_node` —— 新增/编辑本体节点或实体节点：
  - 新增本体：`node_type="ontology"` + `entity_name` + `description`（可选 `attributes`/`alias`/`align_strategy`）。本体走 API：`ontology_id_list` 固定 `["ontology"]`，`align_strategy` 默认 semantics，`attributes` 传属性名数组（内部转成「属性名→类型」字典，默认 str）。缺省由后端生成 `entity_id`。
  - 新增/编辑实体：`node_type="entity"` + `entity_name` + `ontology_id_list`；属性值用 `properties` 字典；传 `entity_id` 则按 id 融合。实体标签/entity_type 由后端自动填充。
  - 实体可用 `doc_ids` 传「关联文档」ID 列表（证据回指）。
- `docchain_kg_upsert_relation` —— 新增本体关系 / 实体关系：必填 `topic_id`/`relation_type`/`source`/`target`；实体关系额外传 `ontology_id`（本体关系不传）。缺省由后端生成 `relation_id`。
- `docchain_kg_delete_node` —— 按 `topic_id` + `entity_id` 删除节点（连带其所有关系）。
- `docchain_kg_delete_relation` —— 按 `topic_id` + `relation_id` 删除关系。

## 要点

- **禁止使用后端自动抽取接口 `generate_kg_by_content`（及 extract/query-status）**：该能力抽取质量差、不可控，本项目已弃用。知识图谱抽取一律由 AI 读文档后，用 `docchain_kg_upsert_node` + `docchain_kg_upsert_relation` 手动逐实体/关系写入（schema 先查本体，cypher 用于验证）。
- `docchain_kg_cypher` 只读（MATCH/CALL/SHOW…RETURN，走 DocChain API）；写操作用上面的专用工具（走 DocChain API），不要用 cypher 工具执行写语句。
- 写操作不可撤销，执行前先向用户确认；各写工具会返回生成的 entity_id/relation_id。
- 本体节点用标签 `:ontology`，实体节点用标签 `:Entity`；关系（本体/实体）都用业务名作 Neo4j 关系类型。这些落库形态由后端/DocChain 负责，插件侧只需传业务名与 id。
- 编辑/删除需先有 entity_id / relation_id，不确定时先用 `docchain_kg_cypher` 检索确认。
- 节点属性里的 `embedding`（向量）和 `origin_json`（原始 JSON）会被读工具自动跳过，避免刷屏。
- 单次返回行数受 `maxRecords`（默认 50）限制。
- schema / cypher / 写操作按 `topic_id` 路由到主题库。
