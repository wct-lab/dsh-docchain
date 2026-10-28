# dsh-docchain

[English](./README.md) | 中文

一个知识库和文档转换 DSH 插件，内置文件名/内容/元数据检索、主题查询、文档批量上传、文档转 Markdown 解析与多子智能体深度研究工作流：任意机器上用 `plugin_manager install_bundle` 安装即可生效，无需手动拷贝到 `~/.agents/skills`。

它的配置页不止一个服务地址：可以保存一组**常用环境**（每个环境有自己的地址与凭据）并一键切换，还能按环境预选**主题**，之后直接说"在这个主题里搜"而不必报 id。

| 技能 | 形态 | 说明 |
|---|---|---|
| `docchain-filename-search` | SKILL.md + Node.js 脚本 | 在指定主题内按文件名关键词查找文档 |
| `docchain-doc-search` | SKILL.md + Node.js 脚本 | 按 doc_id 或文档名称关键字定位文档、列出详情，并可读取指定文档正文（分段续读） |
| `docchain-content-search` | SKILL.md + Node.js 脚本 | 在文档内容中搜索关键词，返回行号和内容，支持"或/且" |
| `docchain-meta-search` | SKILL.md + Node.js 脚本 | 按自定义元数据字段查询文档（字符串/数值/时间，精确与范围） |
| `docchain-topic-info` | SKILL.md + Node.js 脚本 | 查询 docchain 主题列表，支持分页与名称/ID 关键字过滤 |
| `docchain-upload` | SKILL.md + Node.js 脚本 | 把本地文件或整个文件夹批量上传到指定 docchain 主题 |
| `doc2markdown` | SKILL.md + Node.js 脚本 | 把 docx/doc/pdf/pptx/xlsx/图片等常见格式解析为 Markdown，结果保存在源文件同目录 |
| `docchain-image-search` | SKILL.md + Node.js 脚本 | 图搜图：给一张图，找库里相似的图片，并返回所属主题、文档名与相似度 |
| `deep-research-advanced` | 仅 SKILL.md | 主控式多子智能体深度研究工作流（纯指令，无脚本） |

## 安装

同一个包装进哪个 profile，取决于你如何运行 DSH：

| 运行方式 | 命令 |
|---|---|
| 桌面版 | `dsh plugin --profile desktop add github:wct-lab/dsh-docchain` |
| `dsh web` | `dsh plugin --profile web add github:wct-lab/dsh-docchain` |

装完重启 DSH，让宿主半区与客户端半区重新加载。或从本地目录安装：

```text
plugin_manager install_bundle target=<本目录绝对路径>
```

## 配置说明（必读）

包内不携带任何凭据。除 `doc2markdown` 外的每个脚本（Node.js）运行前都需要 docchain 服务地址与 API Key；`doc2markdown`（Node.js）两者都不需要——使用内置默认地址并匿名上传，同样可用上述配置链指向其他地址/Key。

| 配置项 | 说明 | 必填 |
|---|---|---|
| `docchain_url` | docchain 服务地址，如 `http://<host>:7100/llmdoc` | 是 |
| `docchain_api_key` | API 认证密钥 | 是 |

四种配置方式，按**优先级**从高到低：

1. 环境变量 `DOCCHAIN_URL`、`DOCCHAIN_API_KEY`；
2. 技能目录下的配置文件 `<skill>/scripts/config.json`；
3. 插件状态文件 `~/.dsh/storages/docchain-config.json`（插件配置写入，见下）；
4. 包内 `skills/docchain_config.json`（文件分发兜底；包内只带模板 `docchain_config.example.json`）。

环境变量优先级最高，高于其下所有来源，也包括插件配置页上选中的环境——见 [多环境切换](#多环境切换)。

配置文件格式（均为 JSON）：

```json
{
  "docchain_url": "http://<host>:7100/llmdoc",
  "docchain_api_key": "your-api-key-here"
}
```

所有脚本均仅需 Node.js，在技能根目录下以 `node scripts/<脚本>.js …` 方式运行（参数见各 SKILL.md）。

## 插件配置（推荐）

插件自带 Web 客户端的**配置页**：在 `dsh web` 中打开侧栏的「插件」，找到 `dsh-docchain` 插件，点击其行上的配置控件即可打开。页面管理的是一组环境；地址与 Key 都是环境的属性，在该环境行内录入与编辑，没有独立的顶层输入框。Key 本身写入凭据存储，只写不读：页面不会回显已保存的值，只提示是否已配置。

插件遵循官方凭据模式，Config schema 包含：

| 字段 | 含义 |
|---|---|
| `docchain_url` | 没有生效环境时使用的服务地址；volatile 字段，由页面与生效环境保持同步 |
| `docchain_api_key_ref` | API Key 的凭据引用名，默认 `DOCCHAIN_API_KEY` |
| `docchain_api_key` | 备用：直接写死 Key（不推荐；凭据存储优先） |
| `docchain_environments` | 常用环境列表（JSON）：每个环境的名称、地址、凭据引用名以及预选主题；生效环境优先于 `docchain_url` |

Key 的实际值保存在**凭据存储** `~/.dsh/.credentials.yaml`（`refs:` 段，仅本用户可读）——可通过配置页写入或直接编辑文件，改动热生效；也可以用同名启动环境变量提供。激活时、存储凭据变化时、以及本行设置保存时，解析出的值会被镜像写入 `~/.dsh/storages/docchain-config.json`（权限 `0600`）：该文件是当前解析结果的纯投影，配置清空后对应条目随之消失；脚本每次运行读取该文件。

Key 解析顺序：凭据存储（启动环境 > 存储文件）> `docchain_api_key` 行内字面值。

引用名本身就是配置：**让 `docchain_api_key_ref` 保持未配置是受支持的状态，不是故障。** 页面会显示「未配置」，脚本以「配置不完整」退出，而不会回落到别的引用——一把「存在但不对」的 key 会静默查到错误的账号，比直接报错难发现得多。

修改配置的方式：

- 使用插件页上的**配置页**——新增或编辑一个环境（含地址与 Key）；或
- 在凭据存储中保存/更新 `DOCCHAIN_API_KEY`——无需触碰本插件即生效；或
- 直接编辑 `~/.dsh/storages/docchain-config.json`（下一次脚本运行即生效；插件在激活或配置变化时会按解析结果重写该文件，需要长期覆盖请用环境变量或技能级 config.json）；或
- 在插件 config 行（patch `config` / preset override）设置 `docchain_url` / `docchain_api_key_ref` / `docchain_api_key` 后重新激活插件。

## 多环境切换

配置页可以保存一组**常用环境**，换 docchain 服务时不必再重输地址与 Key。

- 页面顶部只显示当前生效的环境；点开展开列表，可切换、新增、编辑、删除。
- 点选即生效——不用按保存、不用重启。
- 每个环境各自保存地址与独立的凭据引用，所以切回去不需要重新输入 Key。Key 始终存在凭据存储里，只写不读。
- 页面只管理环境：地址与 Key 都是环境的属性，在该行内编辑，没有独立的输入框要同步。一个环境都没保存时行内显示「未选择环境」，此时仍以旧的 `docchain_url` / `docchain_api_key_ref` 配置兜底（可在 profile 的 `cordis.patch.yml` 里改）。
- 删除环境会连带删除它的凭据——除非还有别的环境共用同一引用，或它就是本行自己的兜底引用。正在生效的环境不能删除，需先切走。

数据存放位置：

| 内容 | 位置 |
|---|---|
| 环境列表（名称、地址、凭据引用名、预选主题） | profile 的 `cordis.patch.yml` 中 `config.docchain_environments` |
| 各环境的 Key | `~/.dsh/.credentials.yaml` 的 `refs:` 段，键名形如 `DOCCHAIN_API_KEY__<ID>` |
| 当前生效值——地址、Key，以及生效环境选中的主题 `docchain_topic_ids` / `docchain_topic_names` | `~/.dsh/storages/docchain-config.json`，每次切换重写 |

两个需要知道的限制：

- **环境变量优先。** 每个技能脚本都先读 `DOCCHAIN_URL` / `DOCCHAIN_API_KEY`，再读投影文件，所以启动时导出的变量会静默压过页面上的选择。想让页面说了算，就不要设置它们。
- 两个标签页同时改同一行：后保存者覆盖。

### 主题

每个环境还可以预先选择最多 **10 个主题**，之后直接说"在这个主题里搜"即可，不必再报 ID。

- 主题列表来自当前环境：一个关键词框，服务端**同时按 topic_id 与主题名称**匹配（子串、大小写不敏感，输入完整 id 或完整名称即可收窄到一条）+ 分页；每行显示 `topic_id` 与名称。
- 浏览器拿不到 API Key，所以页面请求宿主的同源路由 `GET /plugin/dsh-docchain/topics`，由宿主代查服务。
- 选择按环境保存（存在该环境的 `topics` 里），切换环境时主题随之切换。
- 只要选了至少一个主题，宿主会把「当前环境 + 这些 topic_id」注入 agent 上下文；用户说"当前主题"或未指定 `topic_ids` 时使用它。一个都没选则不注入。
- 服务地址必须是接口地址，不能是浏览器登录页：`/login?redirect=…` 这类地址会让主题列表加载失败（列表里会标 ⚠）。

两个限制：服务端删掉的主题不会从选择里自动移除（存的是名称快照，之后用它必然失败）；该路由对本机任何能访问该端口的进程可见——它只返回当前环境的主题名称，不含任何凭据。

## 工作机制

Bundle 插入一个 Host 插件（`dsh-docchain`），激活时在 `ctx.skills` 上注册技能提供者，服务本包 `<skills>/<name>/SKILL.md` 下的每个技能目录：

- 目录条目来自各 SKILL.md 的 frontmatter（`name`、`description`）；每次加载都重新读文件。
- 提供者 rank 为 **450**：项目根（`.dsh/skills` = 100、项目 `.agents/skills` = 200）、runtime 注册（250）与 `customSkillDirs`（300）优先级更高，`~/.dsh/skills`（400）同样优先；本 Bundle 高于 `~/.agents/skills`（500）与 bundled 根（600）。也就是说：`~/.agents/skills` 里的同名旧副本会被本 Bundle 覆盖；确认无误后可删除旧副本，只保留单一来源。
- 配置页依赖两个可选服务：宿主在 Web 服务器上注册 `GET /plugin/dsh-docchain/topics`（浏览器拿不到 API Key，由宿主代当前环境查询），以及一段描述「当前环境 + 已选主题」的 prompt section。缺少这两个服务的部署仍然拥有技能提供者与投影文件。
- 这两者都不缓存业务状态：每次调用都读实时行配置，所以切换环境或主题后，脚本与下一步模型都能立刻看到，无需重启。

## 技能详解

### docchain-filename-search（在指定主题内按文件名搜索）

在**指定主题范围内**按文件名关键词定位文档。

**交互方式**：描述要查找的文件名关键词，**必须指定主题 ID**（本技能只在这些主题里找）。

> 与 `docchain-doc-search` 的分工：若要**跨全部主题**按文件名查找，或用 doc_id 定位、读文档正文，请用 `docchain-doc-search`；本技能是"限定主题 + 只按文件名"。

**示例**：

- "帮我在主题112中找文档名包含'合同'的文件"
- "在主题1,10里搜索'采购'或'协议'的文档"

### docchain-doc-search（按文档 ID / 文档名称定位并读正文）

按 doc_id 或文档名称关键字找到"是哪个文档"，列出详情（名称、所属主题、页数、大小、状态）；需要时可读取指定文档的正文（分段返回，用 `next_offset` 续读）。用于"这个 id 是哪份文档""名字带 XX 的文档有哪些""把某份文档的正文读出来"。

**交互方式**：给出一个或多个文档 ID，或一个文档名称关键字（`--keyword` 为全库跨主题搜索）；要读正文时指定单个文档 ID 加 `--content`。

> 与 `docchain-filename-search` 的区别：本技能按文件名全库搜、且能按 doc_id 查详情与读正文；只想在某个主题内按文件名找，用 `docchain-filename-search`。与 `docchain-content-search` 的区别：本技能按 doc_id / 文档名找文档本身，不是在正文里搜关键词。

**示例**：

- "查一下文档 125672 是什么"
- "125672 和 125755 分别是哪两份文档"
- "找一下名字带'评价标准'的文档"
- "把文档 125755 的开头读出来"

### docchain-content-search（文档内容搜索）

在文档内容中搜索关键词，返回匹配行的行号和内容，支持"或/且"两种操作符。

**交互方式**：指定搜索范围和关键词。必须提供 `doc_ids` 和 `topic_ids` 至少其一。

**示例**：

- "在文档123里搜索'合同'"
- "在主题1,2里搜索同时包含'API'和'接口'的内容"

### docchain-meta-search（元数据查询）

通过自定义元数据字段条件筛选文档，支持字符串、数值、时间类型的精确匹配与范围查询。

**交互方式**：描述筛选条件。必须指定主题 ID 或文档 ID。

**示例**：

- "在主题112中查找元数据中作者是张三的文档"
- "在主题113中查找金额字段大于1000的合同"

### docchain-topic-info（主题查询）

查询 docchain 系统中的主题列表，支持分页浏览与按名称关键字过滤。常作为其他技能的前置步骤：先拿到主题 ID，再按主题检索或上传。

**交互方式**：直接询问有哪些主题，可带页码、每页数量或名称关键字。

**示例**：

- "有哪些主题"
- "看下主题列表第 2 页，每页 10 条"
- "按关键字 test 过滤主题名称"

### docchain-upload（文档上传）

把本地单个文件或整个文件夹批量上传到指定 docchain 主题，逐个上传并显示进度与成功/失败统计。文件夹仅扫描顶层文件（不递归）。

**交互方式**：给出文件/文件夹路径与目标主题 ID（`--topic_id` 必填）。

**示例**：

- "把 ./report.pdf 上传到主题 123"
- "把 ./docs 文件夹里的文档批量上传到主题 456"

### doc2markdown（文档转 Markdown）

把文档（docx、doc、pdf、ppt、xlsx、图片、epub、mobi 等常见格式）上传到 docchain 解析服务，转换结果下载到源文件同目录——可以是单个 `.md` 文件（`--md`）或含图片、表格的完整 MD 包。

**交互方式**：给出文件路径，如"读一下 ./report.pdf 的内容"或"把 合同.docx 转成 Markdown"。

**示例**：

- "总结 /path/to/report.pdf 的内容"
- "把 合同.docx 转成单个 Markdown 文件"

服务地址与 API Key 沿用检索脚本同一配置链，但均为可选：不配置时使用内置默认服务地址（`https://lab.hjcloud.com/llmdoc`）匿名上传。

### docchain-image-search（图搜图）

把一张本地图片上传到当前环境，返回库里相似的图片——**图片本身**，以及它所属的主题（id 与名称）、文档名和相似度。命中的图片会下载到临时目录，便于在对话里展示。

**用法** — 发一张照片或截图然后提问。docchain 接口没有全局图片搜索，所以检索按主题进行：默认用配置页选中的主题，也可 `--topic_ids` 指定，或用 `--all` 扫描全部主题。

- "这张截图是哪个文档里的？"
- "帮我找类似的图片"

需要注意：

- `score` 是服务端的**视觉相似度**（0–1，原图检索原图 = 1），**不是助手的判断**；请把它当作排序依据，而不是绝对值——低分不等于无关；
- 能否搜到**按主题**区分：图片向量是一个主题一个主题建立的，没做过向量化的主题对任何查询都返回空（实测：同一实例上有向量的主题能命中、没有的恒为空）。脚本会把这种情况说明白，而不是让你以为库里没有；
- 个别图片会让服务端返回 HTTP 500（那张图处理不了），脚本会按主题记录并如实提示，不会静默失败；
- `--all` 会遍历全部主题，慢且请求量大（数千次查询）。知道主题时优先用选中的主题。

### deep-research-advanced（高级深度研究）

面向 ReAct 单智能体的主控式多子智能体深度研究工作流（纯指令，无脚本）：主智能体试探摸底、拆分独立任务并行下发；子智能体自主迭代检索、精读、推导，输出带推导链路的子报告；主智能体汇总交叉推演、复盘深化，**强制保底 2 轮全局循环**后自主判定终止。最终生成逻辑闭环、推导清晰、低幻觉、可溯源的研究报告。

**适用场景**：复杂、开放性、需外部资料佐证、需逻辑推演的研究问题——行业分析、市场调研、竞品剖析、政策解读、技术调研、趋势预测。简单问答、闲聊、基础计算禁止使用。

## 卸载

移除 Bundle 后，提供者与技能一并注销：

```text
dsh plugin remove dsh-docchain
```

（或 `plugin_manager remove_bundle`）。

卸载不会清理本插件写下的内容：`~/.dsh/storages/docchain-config.json` 与 `~/.dsh/.credentials.yaml` 中的 `DOCCHAIN_API_KEY__*` 条目会保留，需要手动删除。
