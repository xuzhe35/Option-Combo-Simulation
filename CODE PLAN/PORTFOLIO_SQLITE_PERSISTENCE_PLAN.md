# 仓位工作区 SQLite 持久化实施计划

> 状态：Proposed / 尚未实施
>
> 适用页面：index.html、chart_lab.html
>
> 适用后端：ib_server.py、historical_server.py
>
> 核心目标：取消日常保存对浏览器文件系统权限的依赖，同时保留 JSON 的可移植性与现有交易安全边界。

## 1. 最终决策

采用以下组合方案：

1. 正式仓位库使用由 Python 后端管理的本地 SQLite。
2. SQLite 保存经过清理和版本化的完整 JSON 快照；第一阶段不把 Group、Leg、Hedge 全部关系化。
3. 沿用现有 WebSocket，在 Live 和 Historical 两个后端中提供同一套仓位工作区存取协议；浏览器不直接访问 SQLite。
4. 保留 JSON 导入和显式 JSON 导出，但不再把浏览器文件句柄当作正式保存目标。
5. SQLite 主流程稳定后，再增加 IndexedDB 未保存草稿；IndexedDB 不作为正式仓位库，也不能冒充“已保存到数据库”。

正式存储链路：

    浏览器内存 state
        -> OptionComboSessionLogic.buildPersistenceState()
        -> WebSocket save_saved_workspace
        -> 共享 Python PortfolioStore
        -> 本机应用数据目录中的 portfolio.db

## 2. 为什么这是当前项目的最佳方案

### 2.1 复用现有架构

当前前端已经通过 WebSocket 与 Python 后端通信：

- Live Workspace 使用 ib_server.py，实际消息路由位于 ib_server_ws.py。
- Historical Workspace 使用 historical_server.py。
- chart_lab.html 复用主工作区状态和 js/app.js、js/ws_client.js。

让 Python 后端成为 SQLite 的唯一所有者，只需增加一组请求/响应，不需要浏览器数据库驱动、额外数据库进程或新端口。

### 2.2 SQLite 与本地单用户工作区匹配

- Python 标准库自带 sqlite3，不增加安装依赖。
- 单文件、事务提交、崩溃恢复和版本迁移能力优于直接覆盖 JSON。
- 可在一个事务中完成“新版本写入”和“当前版本指针更新”。
- 适合本机单用户、低并发、每次写入一个工作区快照的负载。
- Live 与 Historical 后端即使意外同时访问同一数据库，也可通过 WAL、busy_timeout 和短事务协调。

PostgreSQL、MongoDB、MySQL 会引入安装、账号、端口、升级和备份运维，对当前负载没有对应收益。

### 2.3 暂不把业务状态关系化

当前保存内容不只是持仓行，还包括：

- Group、Leg、Hedge 及显示和分析设置；
- 历史回放日期、模拟日期、定价模型和曲线选择；
- Futures Pool、Forward Rate Samples；
- Trigger、Close 配置及其他具有版本迁移语义的状态。

这些结构仍在演化。如果现在拆成多张业务表，每次前端状态演进都要同步修改数据库 schema、查询、组装器和迁移器，反而扩大出错面。

推荐：

- 数据库只关系化工作区索引元数据和版本信息；
- 完整业务状态继续作为 JSON 保存；
- 语义迁移继续由 js/session_logic.js 的单一规范化入口负责；
- 等出现跨工作区 SQL 统计、服务端风控或多用户协作的真实需求后，再有证据地拆表。

### 2.4 IndexedDB 只作为草稿层

IndexedDB 不需要文件权限，但它受浏览器 profile、origin、协议和端口隔离；清理站点数据、更换浏览器或访问地址，都可能让用户看不到原数据。

因此 IndexedDB 只承担未保存草稿和断线恢复。正式保存成功必须以 Python 后端返回 SQLite 提交成功的 ACK 为准。

### 2.5 JSON 改回导入导出的角色

JSON 继续适合：

- 从旧版本迁移；
- 跨机器搬运单个工作区；
- 人工审计；
- 数据库故障时导出当前内存状态。

JSON 不再承担日常 Save 回写，因此不会要求浏览器长期持有文件权限。

## 3. 第一版明确不做

- 不把 SQLite 暴露给浏览器，也不让浏览器拼 SQL。
- 不引入 SQLite WASM、OPFS、sql.js 或第三方 IndexedDB ORM。
- 不把 Leg、Group、Hedge 全部拆表。
- 不增加服务型数据库。
- 不实现云同步或多设备实时同步。
- 不允许冲突时静默“最后写入者覆盖”。
- 不因仓位库初始化失败而阻止行情、历史回放或 IB 后端启动。
- 不自动扫描用户目录中的旧 JSON。
- 不在打开工作区时恢复一次性订单授权、订单 token 或自动提交状态。

## 4. 当前实现基线与必须保护的行为

### 4.1 当前保存入口

js/app.js 当前通过：

- OptionComboSessionLogic.buildExportState(state) 构造快照；
- showSaveFilePicker() 获取文件句柄；
- FileSystemFileHandle.createWritable() 覆盖 JSON；
- showOpenFilePicker() 或隐藏的 file input 导入 JSON。

数据库方案应替换正式保存目标，但继续复用快照构造和导入迁移的核心语义。

### 4.2 Import 与 Open 不是同一语义

现有 normalizeImportedState() 会从当前 groups、hedges 开始，再加入导入内容。这意味着 JSON Import 具有合并倾向。

数据库中的 Open Workspace 必须替换当前工作区，否则连续打开两个数据库文档会把仓位叠加：

    JSON Import       -> merge，保留既有兼容行为
    Open DB Workspace -> replace

不得通过临时清空全局 state 再调用旧函数来隐式实现 replace。应在纯函数 API 上增加可测试的 mode: merge 或 replace，默认值保持旧行为。

### 4.3 Live/Historical 路由锁继续生效

打开数据库工作区后：

- Historical 锁定入口不能被保存内容切换成 Live。
- Live 锁定入口不能被保存内容切换成 Historical。
- 非锁定入口才可按保存内容恢复模式。
- 打开完成后允许重建行情订阅，但不得发送预览、测试单、实盘单或恢复旧订单监督。

### 4.4 Chart Lab 使用同一文档身份

chart_lab.html 与主页面加载同一工作区 state。数据库功能不能只修改 index.html；两个页面的 Open、Save、Save a Copy、Import JSON、Export JSON 和当前文档标题必须一致。

index.html 与 chart_lab.html 是两个独立标签页，各自持有内存 state。为避免同一用户日常使用时频繁制造 revision conflict，采用“同浏览器、同文档单写者”策略：

- 两个页面都可以独立打开和编辑工作区，但同一时刻同一 document 只允许一个标签页处于可写状态。
- 使用 BroadcastChannel 广播 document ID、revision、tab ID、写者心跳和保存完成事件；不通过 BroadcastChannel 自动合并业务 state。
- 后打开的同文档标签页默认只读，可以重新加载最新版、Save a Copy，或在原写者释放/心跳超时后申请接管。
- 接管前必须从 SQLite 重新加载最新 revision，不能直接把旧标签页内存改为可写。
- BroadcastChannel 只提供友好的本地协调；SQLite expected revision 仍是最终并发保护。浏览器不支持 BroadcastChannel、跨浏览器或跨机器时，退回 revision conflict。

## 5. 持久化数据契约

### 5.1 独立的业务快照版本

在顶层快照新增：

    {
      "sessionSchemaVersion": 1
    }

这与 IVTS 等子结构中已有的 schemaVersion 不是同一个概念。旧 JSON 缺少该字段时按 legacy version 0 处理，不能拒绝。

数据库 schema 版本和 JSON payload schema 版本分开：

- SQLite 使用 PRAGMA user_version 管理表结构迁移；
- JSON 使用 sessionSchemaVersion 管理业务快照迁移。

### 5.2 单一持久化快照入口

将 buildExportState() 的现有职责提炼为：

    buildPersistenceState(state)

JSON Export 和 SQLite Save 都调用该函数，避免两条保存链路产生不同格式。buildExportState() 可暂时保留为兼容别名。

### 5.3 字段分类先冻结再实施

实施前为每类状态建立测试夹具。

必须保存：

- 标的、合约月份、基础日期、模拟日期；
- Group 顺序、名称、包含关系、视图模式；
- Leg 的经济头寸：类型、方向、数量、执行价、到期日、成本、已实现和平仓字段；
- Hedge 的经济头寸；
- 明确由用户输入的 IV、价格覆盖、定价模型和分析配置；
- Futures Pool 的用户配置和可归档字段；
- Trigger、Close 的策略配置，但不包括运行状态和一次性授权。

必须清除或安全复位：

- WebSocket 连接状态、行情健康状态、请求 pending 标志；
- IB 返回的临时资格确认、conId 和合约 timing 证据；
- managed accounts 列表、连接状态和当前选中的真实交易账户；
- execution plan token、close plan token、pending validation payload；
- 活跃订单跟踪、最后一次 broker preview、自动监督运行状态；
- allowLiveComboOrders、allowLiveHedgeOrders 和 auto-submit 许可；
- 导入或打开后可能立即触发下单或预览的 armed 状态。

按来源决定：

- 手工输入的当前价和 IV 可以保存；
- 来源为 live/TWS 的临时 mark、portfolio market price、实时 Greeks 不应触发未保存修改，也不得在重开后伪装成新鲜行情；
- 推荐清除实时证据、保留明确的手工覆盖。

### 5.4 加载后的交易安全不变量

无论数据来自旧 JSON 还是 SQLite，加载完成后必须满足：

    allowLiveComboOrders = false
    allowLiveHedgeOrders = false
    deltaHedge.autoSubmitEnabled = false
    不存在有效 execution/close plan token
    不存在 pending broker request
    不存在恢复中的 managed reprice

Live Trigger 的条件配置可以保留，但默认不得处于会自动提交或自动预览的 armed 状态。用户必须在当前页面明确重新启用。

## 6. SQLite 设计

### 6.1 文档身份与版本

数据库实体称为 workspace_document，避免与 IB/TWS 的 portfolio_positions 混淆。

- document_id：浏览器生成的 UUID，创建后稳定不变。
- revision：从 1 开始单调递增。
- save_token：每次用户保存生成的 UUID，用于请求幂等。
- expected_revision：更新时由浏览器携带，用于乐观并发控制。
- title 不唯一；允许同名方案，身份以 UUID 为准。

### 6.2 v1 schema

    CREATE TABLE workspace_documents (
        document_id      TEXT PRIMARY KEY,
        title            TEXT NOT NULL,
        symbol           TEXT NOT NULL DEFAULT '',
        market_data_mode TEXT NOT NULL DEFAULT 'live'
                         CHECK (market_data_mode IN ('live', 'historical')),
        current_revision INTEGER NOT NULL CHECK (current_revision >= 1),
        created_at_utc   TEXT NOT NULL,
        updated_at_utc   TEXT NOT NULL,
        deleted_at_utc   TEXT
    );

    CREATE TABLE workspace_revisions (
        document_id            TEXT NOT NULL,
        revision               INTEGER NOT NULL CHECK (revision >= 1),
        save_token             TEXT NOT NULL UNIQUE,
        payload_schema_version INTEGER NOT NULL,
        payload_sha256         TEXT NOT NULL,
        payload_json           TEXT NOT NULL,
        saved_at_utc           TEXT NOT NULL,
        PRIMARY KEY (document_id, revision),
        FOREIGN KEY (document_id)
            REFERENCES workspace_documents(document_id)
            ON DELETE CASCADE
    );

    CREATE INDEX idx_workspace_documents_updated
        ON workspace_documents(deleted_at_utc, updated_at_utc DESC);

不在 SQL 中依赖 json_valid()，避免不同平台编译的 SQLite 缺少 JSON1。JSON 合法性由 Python 在事务开始前验证。

### 6.3 原子保存算法

所有序列化、校验和哈希计算都在开启写事务前完成，缩短锁持有时间。

1. 将 payload 规范化为 UTF-8 canonical JSON：排序 key、紧凑分隔符、保留 Unicode、禁止 NaN/Infinity。
2. 校验顶层为 object、必要集合字段类型正确、schema version 可接受、大小不超过上限。
3. 计算 SHA-256。
4. 先按 save_token 查询；若同一请求已经成功，返回原结果，不重复建 revision。
5. 执行 BEGIN IMMEDIATE。
6. 查询当前 revision 和删除状态。
7. 当前 revision 与 expected_revision 不同则 rollback，返回 conflict，绝不自动覆盖。
8. 插入新 revision。
9. 更新文档元数据和 current_revision。
10. commit 后才返回 workspace_saved。

新建和 Save a Copy 也必须在一个事务中插入 document 与 revision 1。

同一 save_token 若携带不同 document 或 payload，必须返回 duplicate_save_token_mismatch，不能按成功重试处理。

事务外的 save_token 查询只是快速路径，不能作为唯一并发保护。两个相同 token 请求可能同时通过预检，因此插入 revision 时必须捕获 save_token UNIQUE 产生的 sqlite3.IntegrityError，在新事务中回读既有记录并核对 document ID、payload hash 和结果：完全一致时按幂等成功返回，不一致时返回 duplicate_save_token_mismatch。阶段 1 必须覆盖两个连接并发提交同一 token 的测试。

### 6.4 SQLite 连接规则

每次 store 操作在线程内创建和关闭自己的连接，不跨 asyncio task 或线程共享 sqlite3.Connection。连接统一设置：

    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA busy_timeout = 5000;

Python WebSocket handler 使用 asyncio.to_thread() 调用同步 store，避免数据库锁等待阻塞行情和订单消息事件循环。

### 6.5 数据库文件位置

当前仓库位于 OneDrive。活跃 SQLite、WAL 和 SHM 文件不应放在 OneDrive 内，否则同步软件可能造成锁争用、冲突副本或不一致快照。

默认位置：

- macOS：用户 Library/Application Support/Option Combo Simulator/portfolio.db
- Windows：LOCALAPPDATA 下的 OptionComboSimulator/portfolio.db
- Linux：XDG_DATA_HOME 或用户 .local/share/option-combo-simulator/portfolio.db
- 容器：通过持久卷显式设置，例如 /data/portfolio.db

覆盖优先级：

1. OPTION_COMBO_PORTFOLIO_DB_PATH 环境变量
2. config.ini 的 portfolio_store.db_path 非空显式值
3. 平台默认应用数据目录

不要把个人绝对路径提交到 Git，也不要改变当前 config.local.ini 主要用于 Python 路径和本机凭据的约定。

推荐配置：

    [portfolio_store]
    enabled = true
    max_payload_bytes = 5242880
    allow_remote = false
    revision_keep_recent = 50
    revision_keep_daily_days = 90
    backup_interval_hours = 24
    backup_keep_daily = 14
    backup_keep_weekly = 8

    [server]
    max_ws_message_bytes = 8388608

db_path 键省略表示自动解析，避免空值在其他配置 overlay 中产生歧义。

### 6.6 Revision 保留与空间回收

每次显式 Save 都产生完整快照，必须有可预测的长期保留策略：

- 永远保留 current revision。
- 每个未删除文档保留最近 50 个 revision。
- 更旧版本在最近 90 天内按 UTC 日期保留每天最后一个 revision。
- 软删除文档在恢复窗口内不裁剪；永久清理必须另有明确确认和已验证备份。
- 任何裁剪只在成功产生并验证数据库备份后执行，并在独立短事务中完成；保存事务本身不做批量裁剪。
- 新库创建时启用 incremental auto-vacuum。裁剪后仅在 freelist 达到阈值且没有保存任务时运行有上限的 incremental_vacuum；不在正常启动或每次 Save 后执行全量 VACUUM。
- list_workspace_revisions 必须分页，不能无上限返回全部历史。

保留数量作为配置项，但修改默认值不得追溯删除尚未备份的数据。

## 7. WebSocket 协议

### 7.1 协议原则

- 每个请求包含 requestId，响应原样返回。
- Save 另带稳定的 saveToken；超时重试复用同一个 token。
- 所有响应包含 success；错误包含稳定的 code 和可显示 message。
- 服务端日志记录 document ID、revision、耗时、payload 大小和错误码，不记录完整 payload。
- 不向浏览器返回数据库绝对路径或原始 SQL 异常。
- 业务 payload 上限为 5 MiB；WebSocket 完整消息上限显式设为 8 MiB，为 action envelope 和未来协议字段留出余量。两个后端的 websockets.serve() 必须使用同一 max_size 配置，不能依赖库默认的 1 MiB。
- 前端在调用 WebSocket send() 前，使用 TextEncoder 按最终 canonical payload 的 UTF-8 字节数预检；超过 5 MiB 时本地拒绝并提示，不允许发送一个会触发 1009 断连的消息。
- 后端仍需执行独立大小校验，不能信任前端预检。协议中的 payload 必须作为 JSON object 发送，避免把整份 JSON 再编码成字符串造成额外转义膨胀。

### 7.2 动作集合

| Client action | Server action | 用途 |
|---|---|---|
| request_workspace_store_status | workspace_store_status | 能力探测、schema 版本和可用状态 |
| list_saved_workspaces | saved_workspaces_list | 返回未删除文档元数据 |
| load_saved_workspace | saved_workspace_loaded | 返回当前 revision 与 payload |
| save_saved_workspace | workspace_saved | 新建或带 revision 更新 |
| delete_saved_workspace | workspace_deleted | 软删除，要求 expected revision |
| list_workspace_revisions | workspace_revisions_list | 查询历史版本 |
| restore_workspace_revision | workspace_revision_restored | 将旧 payload 复制为新 revision |

保存请求示例：

    {
      "action": "save_saved_workspace",
      "requestId": "request-uuid",
      "saveToken": "save-attempt-uuid",
      "documentId": "document-uuid",
      "expectedRevision": 3,
      "title": "SPY Jul Put Spread",
      "payload": { "sessionSchemaVersion": 1 }
    }

成功响应示例：

    {
      "action": "workspace_saved",
      "requestId": "request-uuid",
      "success": true,
      "document": {
        "documentId": "document-uuid",
        "title": "SPY Jul Put Spread",
        "symbol": "SPY",
        "marketDataMode": "live",
        "revision": 4,
        "updatedAtUtc": "2026-08-08T09:00:00.000Z"
      }
    }

冲突响应使用 revision_conflict，附带服务器当前 revision 和更新时间，但默认不回传完整最新 payload。UI 提供“打开最新版”“另存为副本”“取消”；v1 不提供无条件强制覆盖。

### 7.3 稳定错误码

- store_unavailable
- remote_access_disabled
- invalid_request
- invalid_payload
- payload_too_large
- document_not_found
- document_deleted
- revision_conflict
- duplicate_save_token_mismatch
- database_busy
- database_corrupt
- internal_store_error

前端只能在收到 success: true 后显示 Saved。WebSocket send() 成功不算保存成功。

## 8. 前端模块与交互

### 8.1 模块边界

建议新增：

- js/workspace_persistence.js：DOM-free 的请求关联、超时、当前文档身份、revision 和 conflict 状态机。
- portfolio_store.py：路径、schema migration、校验、CRUD、备份和 store 异常。
- portfolio_store_ws.py：共享协议校验、loopback 检查和响应构造。

现有文件职责：

- js/session_logic.js：纯快照构造、schema 迁移、merge/replace 规范化。
- js/session_ui.js：工作区列表、命名、冲突和错误 UI。
- js/app.js：把当前 state 交给 persistence 模块，并应用 load 结果；不承载请求状态机。
- js/ws_client.js：提供 sender、转交 persistence 消息、断线时拒绝悬挂请求。
- ib_server_ws.py：调用共享 dispatcher，不直接编写 SQL。
- historical_server.py：调用同一 dispatcher。

前端是 ordered global scripts。新脚本加入两个 HTML 后必须更新静态资源版本测试并验证加载顺序。

静态资源的查询版本禁止手写。修改或新增 JS/CSS 引用后，使用项目解析出的 Python 运行 scripts/stamp_asset_versions.py，再运行同一脚本的 --check 模式和 tests/asset_versions.test.js 验证哈希一致。

### 8.2 用户操作

主操作：

- Open：打开数据库工作区列表。
- Save：已有文档则带 expected revision 更新；未绑定则命名后创建。
- Save a Copy：生成新 document UUID 和 revision 1。

次级操作：

- Import JSON：兼容旧文件；导入后为未绑定数据库的新工作区，下一次 Save 创建数据库文档。
- Export JSON：备份或迁移，不改变当前数据库 document ID 和 revision。

后端不支持仓位库或初始化失败时：

- 页面仍可运行行情、定价和回放；
- Open 和 DB Save 明确显示 unavailable；
- Import/Export JSON 始终保留；
- 不把失败的 DB Save 静默降级成文件写入并显示普通 Saved。

### 8.3 当前文档 envelope

只在浏览器运行时维护，不写入业务 JSON：

    {
      documentId,
      title,
      revision,
      updatedAtUtc,
      lastSavedPayloadFingerprint
    }

新建默认工作区、JSON Import 和 Save a Copy 前没有 document ID。数据库 Load 后才绑定服务端返回的身份。

### 8.4 同浏览器单写者协调

workspace_persistence.js 同时负责 advisory writer lease：

- 每个标签页生成不持久化的 tab ID。
- 打开已保存文档时广播 writer query；现有写者响应 document ID、revision 和租约状态。
- 写者定期发送心跳，并在 Save 成功后广播新 revision；其他同文档标签页立即标记 stale，保持只读并提示 Reload。
- beforeunload 尽力广播 release，但正确性不能依赖该事件；心跳超时后才允许接管。
- 接管必须先 load 服务端最新 revision。不得同步、拼接或自动合并两个标签页的 Group/Leg state。
- 本地租约竞争或消息丢失时，expected revision 继续阻止真正的数据覆盖。

### 8.5 未保存修改判断

不建议在所有 UI handler 中散布 dirty = true，因为大量全局脚本和行情更新容易遗漏或误触发。

对 buildPersistenceState(state) 的 canonical 结果做去抖 fingerprint，并与最后一次成功 Save/Load 的 fingerprint 比较：

- 实时行情、连接状态和 broker runtime 不改变 fingerprint；
- 用户修改数量、成本、到期日或 Group 配置必须改变 fingerprint；
- 切换、打开或关闭页面前，如 dirty，应提示 Save、Discard、Cancel；
- 保存进行中时不并行写入。

### 8.6 Load 的原子 UI 流程

1. 当前 dirty 时先选择 Save、Discard 或 Cancel。
2. 请求并校验数据库 payload。
3. 在纯函数中以 replace 完成迁移和规范化；失败时不得改动当前 state。
4. 一次性应用完整 normalized state。
5. 清空行情证据、broker runtime 和执行授权。
6. 同步 UI、重新计算派生值。
7. 只重建行情或历史数据订阅。
8. 最后绑定 document ID、revision 和保存 fingerprint。

任何步骤失败都保留原工作区，不能出现部分新、部分旧的混合 state。

## 9. 安全、隐私与故障边界

### 9.1 网络边界

ib_server.py 支持非 loopback 监听。仓位数据包含交易意图，不能因为复用 WebSocket 就默认向 LAN 或 Tailscale 开放。

v1：

- allow_remote = false 为强制默认值；
- dispatcher 根据 websocket.remote_address 拒绝非 loopback persistence 请求；loopback 规范化必须覆盖 127.0.0.1、::1 和 IPv4-mapped IPv6 的 ::ffff:127.0.0.1；remote_address 为 None 或无法解析时 fail closed，按远程处理；
- status 对远程客户端只返回 unavailable，不暴露路径和库状态；
- 未来确需远程使用时，先设计鉴权和 TLS，再开放；端口不可见不算鉴权。

### 9.2 输入限制

- 默认 payload 上限 5 MiB，按 canonical UTF-8 字节计算。
- title 去除首尾空格，限制 1–120 个 Unicode 字符。
- document ID、request ID、save token 必须符合 UUID 或项目规定的受限 token 格式。
- 只接受 JSON object；拒绝 array、scalar、NaN、Infinity 和异常深度。
- symbol、market mode 从 payload 派生，不信任重复的客户端元数据。

### 9.3 故障隔离

- 路径不可写、schema migration 失败或 quick_check 失败时，后端继续启动其他功能。
- store 标记 unavailable，日志记录错误码和建议动作。
- 绝不能删除、覆盖或自动新建同名空库来掩盖损坏。
- 单个 persistence handler 异常不能关闭 WebSocket。

### 9.4 日志

允许：action、request ID、document ID、revision、耗时、payload 字节数、错误码。

禁止：完整 JSON、Leg 明细、真实账户、订单 token、全部标题列表。

## 10. 备份、恢复与迁移

### 10.1 数据库备份

不能在后端运行时直接复制 portfolio.db、WAL、SHM。使用 Python sqlite3.Connection.backup() 生成一致性备份。

至少提供：

- schema migration 前自动备份；
- scripts/backup_portfolio_store.py 手动备份；
- 备份后运行 PRAGMA quick_check；
- 只在明确的 backup 目录中执行保留策略；
- 恢复必须停止后端，先验证备份，再把现库移动为可恢复旧副本，禁止无提示覆盖。

数据库移出 OneDrive 会失去现有 Portfolio JSON 自带的跨机器备份便利，因此正式方案必须提供“本地活跃库 + OneDrive 静态一致性备份”的双层布局：

- 活跃 portfolio.db 始终位于本机应用数据目录。
- 自动备份至少每日一次，并在后端干净退出时尽力补做；正常退出不是唯一触发条件。
- 使用 sqlite3.backup() 先在本机临时目录生成完整快照，执行 quick_check，成功后再发布到配置的同步备份目录。
- 发布到 OneDrive 时先复制为明确的 partial 临时名，完成 flush/fsync 后在目标目录原子改名为最终时间戳文件；OneDrive 永远不接触活跃 WAL/SHM。
- 文件名包含 UTC 时间、schema 版本和本机 install ID，避免 macOS、Windows 同时备份时同名覆盖。
- 备份目录通过 OPTION_COMBO_PORTFOLIO_BACKUP_DIR 或配置项指定；当前 OneDrive 使用场景应在首次启用时引导选择/确认同步目录，并将仓库内备份目录加入 gitignore。
- 自动保留最近 14 个每日备份和最近 8 个每周备份；删除只发生在已解析并验证为 backup 根目录的明确文件名集合内。
- 静态备份解决灾难恢复和人工跨机迁移，不是多主同步。两台机器同时编辑各自本地数据库会产生分叉，不能自动合并。

### 10.2 新机器恢复流程

1. 停止目标机器的 Live/Historical 后端。
2. 从 OneDrive 备份目录选择最新候选，同时允许选择较早版本。
3. 将候选复制到本机临时目录，运行 quick_check 并核对 schema version。
4. 如果本机已有数据库，先移动为带时间戳的可恢复旧副本。
5. 将验证后的备份原子安装到本机应用数据目录。
6. 启动后端，只读执行 list/load smoke test，再允许首次 Save。
7. 记录恢复来源、hash 和时间，但不记录 payload。

### 10.3 旧 JSON 迁移

1. 用户通过 Import JSON 选择旧文件。
2. 旧 schema 进入统一 normalize/migration 管线。
3. 页面显示迁移后的工作区，但不修改原文件。
4. 用户点击 Save，命名并创建数据库 revision 1。
5. 用户可立即 Export JSON 留作外部备份。

第一版不做目录批量扫描，避免目录权限、重复检测和误导入其他 JSON 的风险。

### 10.4 IndexedDB 草稿

SQLite 主流程和冲突处理完成后再实施：

- 每个 document 至多一个未提交草稿；未绑定文档使用临时 draft ID。
- 草稿记录 baseRevision、fingerprint、更新时间和 canonical payload。
- 重开页面只提示恢复，不自动覆盖。
- 恢复后仍为 dirty；只有 SQLite ACK 后才清除。
- 服务器 revision 已前进时进入 conflict。
- 清理浏览器数据只丢草稿，不影响 SQLite 正式数据。

## 11. 分阶段实施与验收门槛

每个阶段满足成功标准后才进入下一阶段。

### 实施前检查

1. 运行 git status，识别并保护用户已有改动；多阶段工作建议使用 codex/ 前缀分支。
2. 因仓库位于 OneDrive，实施前运行 git fsck，确认对象库完整。
3. 按项目既有解析链确定 Python，不假设裸 python；若缺少隔离环境，使用 requirements-ib-bridge.txt 建立项目虚拟环境后再跑全套 Python 测试。
4. 记录基线 Node/Python 测试结果，后续每阶段与同一基线比较。
5. 检查目标文件行尾；对混合 CRLF 文件使用增量 patch，不做无关的整文件重写。

以上检查是每次开始实施时重新执行的动态前置条件，不在计划中固化某次提交号、测试数量或本机 Python 版本。

### 阶段 0：冻结快照契约和安全不变量

实施：

1. 建立最小、复杂、legacy 三组 fixture。
2. 新增 buildPersistenceState() 和 sessionSchemaVersion 1。
3. normalize API 增加 merge、replace；旧调用默认行为不变。
4. 测试运行时字段清除、手工字段保留和执行授权复位。
5. 修正会在加载后恢复实盘授权或立即触发 broker 请求的字段。

验证：

- 同一 state 连续构造两次快照，canonical 内容一致。
- 只更新 live quote、WebSocket 健康状态或账户 snapshot，fingerprint 不变。
- 修改 Leg 数量、成本、到期日或 Group 配置，fingerprint 改变。
- replace 不保留旧 Group/Hedge；merge 保持旧 Import 行为。
- 所有 fixture 加载后实盘和自动提交授权为 false，一次性 token 缺失。
- 打开 fixture 不产生 combo/hedge preview、test-submit 或 submit 消息。

成功标准：

Node 全套测试通过，并新增字段分类与 merge/replace 测试；没有“以后再决定哪些字段应该保存”的未决项。

### 阶段 1：实现纯 Python SQLite Store

实施：

1. 新增 portfolio_store.py。
2. 实现路径解析、v0 到 v1 migration、PRAGMA、CRUD、soft delete、revisions、restore。
3. 实现 payload 校验、canonical JSON、SHA-256、revision conflict、save token 幂等。
4. 实现 quick_check 和 backup API。
5. 所有测试使用临时目录，不能触碰用户数据库。
6. 新库在建表前启用 incremental auto-vacuum；保留策略和 vacuum 操作暴露为独立、可测试的方法，不在 Save 事务中运行。

验证：

- 新库表、索引和 user_version 正确。
- 新库的 auto_vacuum 模式正确；旧库迁移不会未经备份执行隐式全量 VACUUM。
- create 后 revision 1；重启后 list/load 一致。
- 正确 expected revision 保存为下一版。
- 旧 expected revision 返回 conflict，内容不变。
- 同一 save token 重试只产生一个 revision。
- 同一 token 携带不同内容被拒绝。
- soft-delete 后默认不可见，revision 仍存在。
- restore 产生新 revision，不改写历史。
- 非 object、非法数字、超限 payload、空标题在事务前被拒绝。
- 两连接从同一 revision 并发保存，恰好一个成功、一个 conflict。
- 两连接并发提交完全相同的 save token，最终只有一个 revision；另一请求捕获 UNIQUE 冲突后回读并返回同一成功结果。
- 两连接并发提交相同 save token 但不同 payload hash，恰好一个成功，另一请求返回 duplicate_save_token_mismatch。
- 不可写路径或损坏文件返回受控异常，不覆盖原文件。

成功标准：

tests/portfolio_store_test.py 全部通过；store 脱离 WebSocket 和 IB 也能重启 round-trip，无数据损失。

### 阶段 2：接入两个 Python 后端

实施：

1. 新增 portfolio_store_ws.py。
2. 两后端用同一路径解析器初始化 store。
3. Live 通过 ib_server_ws.py 接入；Historical 调用同一 dispatcher。
4. store 操作使用 asyncio.to_thread()。
5. 初始化失败只禁用 persistence。
6. 默认拒绝非 loopback。
7. ib_server.py 和 historical_server.py 的 websockets.serve() 都显式使用相同的 8 MiB max_size；不得只修改其中一个入口。
8. Historical 先尝试共享 persistence dispatcher，只有未处理的 action 才进入原有 historical-only 拒绝分支。

验证：

- 同一协议分别在 Live 和 Historical handler 测试。
- 两后端响应字段、错误码和 revision 行为一致。
- fake store 延迟不阻塞事件循环轻量任务。
- malformed message 不关闭 socket。
- 接近 5 MiB 的合法保存消息能到达 store 并正常 ACK；超过后端业务上限时返回 payload_too_large，而不是 WebSocket 1009 断连。
- 超过 8 MiB 的任意非业务消息即使被传输层关闭，也有明确日志；正常前端永远不会发送此类消息。
- persistence 大小拒绝不会触发 Live socket 断连，因此不会释放 managed reprice 或清除订单跟踪。
- store unavailable 时，历史快照、曲线、IB status 等仍工作。
- 非 loopback 收到 remote_access_disabled，且无路径泄漏。
- 后端重启后仍能 load。

成功标准：

Python 全套测试通过；两个入口分别完成 create、save、restart、load，payload hash 一致。

### 阶段 3：前端 DOM-free 持久化客户端

实施：

1. 新增 js/workspace_persistence.js。
2. 实现 request 关联、超时、断线拒绝、幂等重试和当前文档 envelope。
3. ws_client.js 提供 sender 并转发 store 响应。
4. reconnect 后只重新探测 capability，不自动重放普通 Save。
5. 保存结果未知时，用户重试复用原 save token。
6. 使用 TextEncoder 在发送前执行 5 MiB canonical payload 预检；超限时不调用 WebSocket send()。
7. 实现 BroadcastChannel advisory writer lease、心跳、保存 revision 广播和 stale/read-only 状态；不实现业务 state 自动合并。

验证：

- 并发请求按 request ID 匹配。
- socket close 拒绝 pending，并保留未知结果 save attempt。
- 同 token 重试不创建第二 revision。
- error 不显示 Saved。
- 本地超限 payload 不发送消息，也不影响现有 Live WebSocket。
- 同文档第二标签页检测到写者后进入只读；写者保存后第二标签页得到 stale revision 提示。
- 写者异常消失并超时后，第二标签页接管前会从服务端重新 load；不支持 BroadcastChannel 时仍由 revision conflict 保护。
- 未识别 store 消息不影响其他 handler。
- 两个 HTML 加载顺序正确；运行 scripts/stamp_asset_versions.py 后，其 --check 模式和 asset version 测试通过。

成功标准：

新增 JS 测试、tests/ws_client.test.js 和 Node 全套测试全部通过。

### 阶段 4：接入 Save/Open UI 和 replace load

实施：

1. session_ui.js 实现列表、命名、删除确认和冲突对话框。
2. app.js 接入 snapshot/apply，不放网络状态机。
3. 更新两个 HTML 的 Open、Save、Save a Copy、Import、Export。
4. 引入 canonical snapshot dirty 判断。
5. Open 使用 replace；Import 保持兼容语义。
6. Load 先构造临时 normalized state，成功后一次性应用。

验证：

- 首次 Save 命名并创建 revision 1。
- 已绑定 Save 更新 revision，document ID 不变。
- Save a Copy 创建新 UUID，不改旧文档。
- 打开 A 再打开 B，只有 B 的 Group/Hedge。
- legacy JSON Import 后 Save 入库，原文件不修改。
- Live tick 不触发 dirty；人工编辑触发。
- dirty 状态下 Save、Discard、Cancel 正确。
- 路由锁不能被保存内容绕过。
- Open 后仅重建行情，没有订单类消息。
- DB Save 失败时 revision 不前进。
- index 和 Chart Lab 行为一致。
- 主页面与 Chart Lab 同时打开同一文档时只有一个可写者；只读页可以 Reload 或 Save a Copy，不能直接覆盖。

成功标准：

自动化覆盖上述路径；Chrome/Edge 和至少一个不支持 File System Access API 的浏览器，都能无文件权限完成 Open、Save、Save a Copy。

### 阶段 5：JSON 兼容、备份和恢复

实施：

1. 旧 Save-to-file 改为明确的 Export JSON，不改变数据库文档身份。
2. 保留 file input fallback，保证各浏览器 Import JSON。
3. 增加 SQLite 在线备份和 migration 前备份。
4. 增加每日自动备份、干净退出补充备份、OneDrive 静态快照原子发布和备份保留策略。
5. 文档化本机恢复及新机器从 OneDrive 备份恢复的步骤，并明确它不是多主同步。
6. 更新 README、ARCHITECTURE、DEV_HANDOVER 和启动说明。

验证：

- DB workspace 导出 JSON 后在空页面导入，语义快照等价。
- legacy JSON 到 DB 再导出，全链路保留经济头寸和用户配置。
- 在线 backup quick_check 成功，可在临时目录恢复全部文档。
- migration 失败时原库和备份都存在。
- OneDrive 目标只出现完成的时间戳备份或可识别的 partial 文件，不出现活跃 DB 的 WAL/SHM；恢复工具忽略 partial。
- 在另一临时“新机器”数据目录中，可从同步备份恢复并完成 list/load/hash 验证。
- 日志清理脚本不接触正式 DB、backup、Portfolio 数据目录。

成功标准：

完成一次临时目录灾难恢复演练，document、revision、payload hash 与源库一致。

### 阶段 6：并发、容量和长期运行

实施与验证：

- 两标签打开同一 revision：A 保存后，B 必须 conflict。
- B 选择 Save a Copy 不改变 A。
- ACK 丢失后同 token 重试，revision 只增加一次。
- 连续保存、重启、加载 100 次，quick_check 为 ok，revision 连续。
- 合法上限内可保存，超限明确拒绝且旧 revision 不变。
- 验证数据库不可写、磁盘空间不足、锁超时和损坏。
- 数据库错误不使行情或历史服务退出。
- 生成超过保留阈值的 revisions，确认 current 与最近 50 版保留、较旧内容按日保留、裁剪前已有有效备份。
- list_workspace_revisions 分页稳定；incremental_vacuum 只在空闲及 freelist 阈值满足时运行，不阻塞保存或行情事件循环。

成功标准：

不存在假 Saved、重复 revision、丢失已提交内容或静默覆盖并发修改的已知路径。

### 阶段 7：IndexedDB 未保存草稿

实施与验证：

- dirty 后去抖保存 canonical draft。
- 后端断线编辑后关闭页面，重开可选择恢复。
- 不恢复不会覆盖当前工作区。
- 恢复后始终 dirty，不能显示 Saved。
- base revision 落后时进入 conflict。
- SQLite ACK 后删除 draft。
- 清理 IndexedDB 不影响 SQLite。

完成标准：

浏览器崩溃和短时断线不易丢失编辑，同时 SQLite 仍是唯一正式事实来源。

## 12. 自动化与人工测试清单

### 12.1 Python

新增或扩展：

- tests/portfolio_store_test.py
- tests/portfolio_store_ws_test.py
- tests/ib_server_ws_test.py
- Historical handler 的独立测试

覆盖 schema、CRUD、revision、幂等、并发、soft delete、restore、路径、限制、corruption、remote 拒绝和错误脱敏。

### 12.2 JavaScript

新增或扩展：

- tests/workspace_persistence.test.js
- tests/session_logic.test.js
- tests/session_ui.test.js
- tests/app.test.js
- tests/ws_client.test.js
- tests/asset_versions.test.js

新 suite 必须加入 tests/run.js。

### 12.3 验证命令

Node：

    node tests/run.js

Python 必须使用项目解析出的解释器，不假设裸 python 可用：

    <resolved-python> -m unittest discover -s tests -p "*_test.py"

Windows 使用 powershell_scripts/resolve_python.ps1；POSIX 使用现有 launcher 的解析顺序或明确的 .venv/bin/python。

### 12.4 人工端到端矩阵

| 场景 | macOS | Windows | Live | Historical | Chart Lab |
|---|---:|---:|---:|---:|---:|
| Create/Save/Restart/Load | ✓ | ✓ | ✓ | ✓ | ✓ |
| Save a Copy | ✓ | ✓ | ✓ | ✓ | ✓ |
| JSON Import/Export | ✓ | ✓ | ✓ | ✓ | ✓ |
| 双标签 revision conflict | ✓ | ✓ | ✓ | ✓ | — |
| index/Chart Lab 同文档单写者 | ✓ | ✓ | ✓ | ✓ | ✓ |
| 后端断线与重连 | ✓ | ✓ | ✓ | ✓ | ✓ |
| 5 MiB 业务上限不触发断线 | ✓ | ✓ | ✓ | ✓ | ✓ |
| DB 不可写时业务继续运行 | ✓ | ✓ | ✓ | ✓ | ✓ |
| 非 loopback persistence 拒绝 | ✓ | ✓ | ✓ | ✓ | ✓ |
| OneDrive 备份及新机器恢复 | ✓ | ✓ | ✓ | ✓ | ✓ |
| revision 裁剪和增量回收 | ✓ | ✓ | ✓ | ✓ | ✓ |

## 13. 上线、回滚和兼容

### 13.1 渐进上线

1. 先合入 snapshot contract 和 store 单测，不改默认 UI。
2. 后端上线 capability probe；旧前端忽略新 action。
3. 前端仅在 workspace_store_status.available 为 true 时启用 DB 操作。
4. 保留 JSON Import/Export 至少一个稳定版本周期。
5. SQLite 通过恢复演练后再启用 IndexedDB 草稿。

### 13.2 回滚

前端回滚：

- SQLite 数据保留，不删除或降级；
- 用户可用支持数据库的版本 Export JSON；
- 旧版继续使用 JSON，不误读 SQLite。

后端回滚：

- 新前端 capability probe 得到 unavailable 后禁用 DB 操作；
- JSON Import/Export 仍可用；
- 不自动把 SQLite 内容写回项目目录。

数据库 migration 回滚：

- 不用 down migration 破坏新数据；
- 停止后端，验证 migration 前 backup，再显式恢复；
- 保留失败库用于诊断。

## 14. 预期改动文件

新增：

- portfolio_store.py
- portfolio_store_ws.py
- js/workspace_persistence.js
- tests/portfolio_store_test.py
- tests/portfolio_store_ws_test.py
- tests/workspace_persistence.test.js
- scripts/backup_portfolio_store.py
- scripts/restore_portfolio_store.py

修改：

- config.ini
- option_combo_starter/config.ini 及容器持久卷配置
- ib_server.py
- ib_server_ws.py
- historical_server.py
- js/session_logic.js
- js/session_ui.js
- js/app.js
- js/ws_client.js
- index.html
- chart_lab.html
- tests/run.js
- 相关现有测试
- README.md
- ARCHITECTURE.md
- DEV_HANDOVER.md

实施时保持“纯 store、共享协议、DOM-free 前端状态机、UI、应用编排”分离，避免继续把所有逻辑堆入 app.js 或 ib_server.py。

## 15. Definition of Done

只有同时满足以下条件才算完成：

- 正常 Save/Open 不需要浏览器文件系统权限。
- Live、Historical、Chart Lab 使用同一正式仓位库和协议。
- 收到 SQLite commit ACK 后才显示 Saved。
- 数据库 Open 使用 replace，不重复合并仓位。
- 所有加载路径复位实盘授权、自动提交和一次性订单状态。
- 两标签并发编辑不会静默覆盖。
- 同浏览器的主页面与 Chart Lab 对同一文档采用单写者协调，不自动合并交易 state；SQLite revision 仍提供最终保护。
- WebSocket 断线重试不会重复创建 revision。
- 5 MiB 业务 payload 在 8 MiB WebSocket 显式上限内正常返回 ACK；前端超限预检不会断开 Live socket 或影响订单监督。
- JSON Import/Export round-trip 可用，旧 JSON 可迁移。
- 活跃 SQLite 不位于 OneDrive 仓库；容器使用持久卷。
- 每日一致性静态备份可安全发布到配置的 OneDrive 目录，新机器恢复流程经过验证；文档明确该机制不是多主同步。
- revision 按“最近版本加每日版本”策略保留，分页查询和 incremental_vacuum 不阻塞正常保存。
- 非 loopback 默认不能读写仓位库。
- 仓位库故障不阻止行情、回放或 IB 后端启动。
- 备份通过 quick_check，并完成一次恢复演练。
- Node 与 Python 全套测试通过，macOS/Windows smoke test 通过。
- README、ARCHITECTURE、DEV_HANDOVER 与最终实现一致。

达到以上标准后，JSON 文件从主存储降为导入导出格式，SQLite 成为可版本化、可验证、可恢复的正式仓位事实来源。
