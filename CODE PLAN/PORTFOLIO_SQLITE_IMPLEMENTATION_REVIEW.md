# Portfolio SQLite 持久化实现质量 Review

> Review 日期：2026-08-08  
> Review 范围：`codex/portfolio-sqlite-persistence` 分支相对 `main` 的 SQLite 工作区持久化实现  
> Review 性质：代码、调用链和现有自动化测试审查；本文件只记录结论、证据、修改建议与验收标准，不直接修改实现

## 1. 结论摘要

SQLite 持久化的后端核心实现质量较好：数据库事务、乐观并发控制、保存幂等、载荷限制、故障降级以及在线静态备份均有清晰边界和较完整的自动化测试。

当前不应把整体实施状态认定为完全完成。主要风险不在 SQLite CRUD，而在前端保存状态机和长期维护链路：

1. 未绑定数据库文档的新工作区不会被判断为 dirty，存在未保存修改直接丢失的路径。
2. 保存请求可以并行，可能产生重复文档、无意义冲突，并破坏未知保存结果的幂等 token 保留。
3. Revision 裁剪和增量空间回收已经实现为方法和配置，但没有接入任何生产执行路径。
4. 多标签单写者的 stale 通知和超时接管只存在于底层模块与单元测试，尚未接入实际 UI。
5. SQLite 连接在连接后 PRAGMA 失败时会泄漏，现有测试已经产生 `ResourceWarning`。
6. 删除对话框承诺历史可恢复，但当前没有普通用户可操作的 undelete 或已删除文档恢复路径。

建议先修复两项 P1，再处理四项 P2，随后补齐完整 Python 集成测试和人工浏览器验收。完成这些工作前，应把该功能视为“后端核心完成、产品接线待收口”。

## 2. Review 范围和方法

### 2.1 检查范围

重点审查了以下实现：

- `portfolio_store.py`
  - SQLite schema、初始化与 PRAGMA；
  - document/revision CRUD；
  - expected revision 乐观锁；
  - save token 幂等；
  - revision 裁剪与 incremental vacuum；
  - 在线备份、静态快照发布与恢复。
- `portfolio_store_ws.py`
  - 两个 Python 后端共用的 WebSocket 持久化协议；
  - loopback 限制；
  - 错误映射和故障隔离；
  - 保存后的定时备份触发。
- `js/workspace_persistence.js`
  - 请求关联与超时；
  - socket 断开后的未知保存结果；
  - document envelope 与 canonical fingerprint；
  - BroadcastChannel 单写者协调。
- `js/app.js`、`js/session_ui.js`、`index.html`、`chart_lab.html`
  - Save、Save a Copy、Open、Delete、Import、Export 的 UI 接线；
  - dirty 判断、冲突处理和多标签行为。
- `config.ini`、备份/恢复脚本、README 与架构文档。
- JavaScript 与 Python 相关测试。

### 2.2 证据分类

本文使用三类证据：

- **运行证据**：实际执行测试所得结果或警告。
- **调用链证据**：通过生产代码引用搜索确认某方法是否有调用方。
- **控制流证据**：根据明确的同步/异步状态变化，可以从代码直接推出的行为。

## 3. 已确认的优点

### 3.1 SQLite 是适合当前架构的正式存储

当前应用本来就有本地 Python 后端，使用本地 SQLite 保存完整 JSON snapshot，能够避免浏览器直接文件写入权限问题，同时保留 JSON 导入导出的可移植性。数据库仍是单机事实来源，不把 OneDrive 上的活动 WAL 数据库误当成多主同步数据库，架构边界正确。

### 3.2 保存事务和并发控制设计扎实

`portfolio_store.py` 的保存路径具有以下正确性保障：

- payload 在事务前完成 canonical JSON、UTF-8 大小检查和 SHA-256 计算；
- `BEGIN IMMEDIATE` 串行化写者；
- 更新必须携带 `expectedRevision`；
- revision 不一致时回滚并返回 `revision_conflict`；
- document 元数据和新 revision 在同一事务中提交；
- `save_token` 具有唯一约束，并在事务内重新查询，支持 ACK 丢失后的完全相同请求重放；
- 相同 token 配不同 document 或 payload 时明确拒绝。

现有测试覆盖了顺序重试、并发写入、相同 token 并发、revision conflict 和数据库重启后的数据一致性。

### 3.3 安全 snapshot 边界处理较完整

正式保存和 JSON Export 共用持久化 snapshot 构建逻辑。订单授权、一次性 token、运行时连接和行情证据不会作为可恢复授权保存；加载后只允许重新建立行情/回放订阅，不会自动恢复实盘提交能力。这一点符合交易工具应当 fail closed 的要求。

### 3.4 载荷和 WebSocket 上限有双层保护

- 浏览器在发送前计算 canonical JSON 的 UTF-8 字节数；
- Python store 再次执行服务端大小验证；
- payload 默认上限为 5 MiB；
- WebSocket transport 默认上限为 8 MiB；
- 超限请求不会通过关闭承载行情的共享 socket 来表达普通业务错误。

### 3.5 持久化故障与行情服务隔离

Store 初始化失败、数据库损坏、请求错误或备份失败不会阻止 live/historical 后端继续提供行情和回放服务。协议返回结构化错误，不把测试中的原始 SQLite 路径信息返回浏览器。

### 3.6 备份主干设计正确

实现使用 SQLite backup API 创建一致性静态副本，执行 `quick_check` 后再发布，并通过 `.partial` 到最终文件名的原子替换，避免同步目录看到未完成的正式备份。活动数据库保留在本机应用数据目录，OneDrive 只承担静态快照同步，方向正确。

## 4. 必须修改的问题

## 4.1 P1：未绑定工作区绕过 dirty 和丢失保护

### 证据

文件：`js/app.js:1768-1773`

```js
function _workspaceIsDirty() {
    const client = _getPersistenceClient();
    if (!client || !client.getEnvelope()) {
        return false;
    }
    return client.isDirty(_buildPersistencePayload());
}
```

同时：

- `beforeunload` 只在 `_workspaceIsDirty()` 为 `true` 时阻止关闭；
- 打开另一个数据库工作区前也只根据该函数决定是否显示 Save/Discard/Cancel；
- 首次保存前的新工作区没有 document envelope；
- JSON Import 后会主动清除 document envelope，使其成为未绑定数据库的新工作区。

这是直接的控制流证据，不依赖时序猜测。

### 影响

以下操作不会触发未保存修改提示：

1. 打开应用，创建或编辑 Group/Leg，但尚未进行第一次数据库 Save，然后关闭页面。
2. 在上述状态下选择 Open 并载入其他数据库工作区。
3. Import JSON 后继续编辑，但尚未保存到数据库，然后关闭页面或打开其他工作区。
4. 删除当前数据库 document 后继续编辑；由于 envelope 被清除，后续修改也会被视为 clean。

这会造成用户可见的数据丢失，因此定为 P1。

### 修改建议

不要简单地把“无 envelope”一律改成 dirty，否则全新空白页面可能在没有任何用户修改时就提示。推荐引入明确的 workspace baseline：

1. 页面初始化完成后，对默认空白工作区保存 `initialWorkspaceFingerprint`。
2. 成功 Save 或 Load 后，继续由 document envelope 保存 `lastSavedPayloadFingerprint`。
3. JSON Import 完成后，根据产品选择明确语义：
   - 如果 JSON 只被视为导入来源而不是当前正式保存目标，则标记为 unbound dirty；
   - 如要把导入文件视为一个可丢弃的已有备份，也仍应在导入后的第一次人工修改时进入 dirty。
4. `_workspaceIsDirty()` 按以下顺序判断：
   - 有 envelope：与最后一次成功 Save/Load fingerprint 比较；
   - 无 envelope：与当前 unbound baseline 比较，或读取显式 `unboundDirty`；
   - 只排除实时行情、连接状态和其他不会进入 persistence payload 的变化。
5. 删除当前 document 时，不应把内存中的工作区悄悄转换成 clean；应要求用户选择清空、保留为未绑定草稿或 Save a Copy。

### 验收标准

- 新页面未做任何修改时关闭，不产生多余提示。
- 新建一个 Group 后关闭页面，出现浏览器未保存修改提示。
- 新建一个 Group 后执行 Open，出现 Save/Discard/Cancel。
- Import JSON 后执行 Open，出现符合已确定产品语义的丢失保护。
- 成功 Save 或 Load 后且未做修改，关闭和 Open 不提示。
- 仅接收 live tick、IB status 或历史行情更新不触发 dirty。
- 增加自动化测试覆盖 unbound、imported、saved、live-tick 四类状态。

## 4.2 P1：保存可以并行并覆盖单一 save-attempt 状态

### 证据

文件：`js/workspace_persistence.js:282-342`

`saveWorkspace()` 会读取和覆盖模块级的单一 `saveAttempt`。它只在上一次状态为 `unknown` 且内容完全相同时复用 token，没有在 `saveAttempt.status === 'in_flight'` 时拒绝、排队或复用 Promise。

文件：`index.html:40`、`chart_lab.html:41`

Save 按钮直接通过 `onclick="saveWorkspaceToStore()"` 触发异步操作。

文件：`js/app.js:1816-1827`

app 层在等待数据库 ACK 期间没有保存锁，也没有禁用 Save/Save a Copy。只有收到成功 ACK 后才短暂把按钮文字改成 `Saved!`。

### 可推出的失败时序

#### 首次 Save 双击

1. 两次调用都在开始时看到 `envelope === null`。
2. 两次调用各自生成不同 document UUID 和不同 save token。
3. 两个请求都可以在服务器成功创建 revision 1。
4. 用户最终看到两个几乎相同的数据库文档，最后返回的响应决定当前绑定对象。

#### 已绑定文档双击

1. 两个请求携带相同 `expectedRevision`。
2. 第一个提交 revision N+1。
3. 第二个收到 `revision_conflict`，即使两次保存来自同一个标签页和同一个用户动作。

#### 请求交错破坏未知结果 token

1. 请求 A 把 `saveAttempt` 设为 token A。
2. 请求 B 覆盖为 token B。
3. 请求 A 成功后无条件把 `saveAttempt = null`。
4. 请求 B 随后因断线进入 catch，但无法再把 token B 标记为 unknown。
5. 用户下一次重试可能无法复用服务器已经提交的 token B。

### 影响

- 重复 document；
- 无意义 revision conflict；
- 孤立但已提交的 document；
- ACK 丢失时幂等重试保障失效；
- UI 可能先显示 Saved，又弹出另一个并发请求的失败提示。

这会破坏正式保存链路的确定性，因此定为 P1。

### 修改建议

应同时在 client 层和 UI 层处理：

1. `workspace_persistence.js` 保存一个 `inFlightSavePromise`，只允许一个保存事务处于等待 ACK 状态。
2. 对完全相同的重复调用，可以返回同一个 Promise；对参数不同的调用，应返回结构化 `save_in_progress`，或在当前保存完成后显式排队。
3. 不允许第二次调用覆盖第一个 `saveAttempt`。
4. 每个 Promise 的 then/catch 只允许修改与自己 token 匹配的状态。
5. `saveWorkspaceToStore()` 进入保存后禁用 Save 和 Save a Copy；在 success、known failure、unknown failure 的 finally 中恢复按钮。
6. Open、Delete 和 writer takeover 在保存进行中时也应等待、拒绝或提示，不能与保存交错更换 document identity。

### 验收标准

- 连续快速点击 Save 10 次只发送一个 WebSocket 保存请求。
- 首次 Save 快速点击不会创建重复 document。
- 已绑定文档快速点击不会制造本标签页自己的 revision conflict。
- 保存中修改 state 后再次点击的行为有确定规范：排队最新 snapshot，或明确提示稍后再保存。
- A 请求完成不会清除 B 请求的 token 或状态。
- ACK 丢失后重试仍使用原 token，数据库只增加一个 revision。
- 增加 client 单元测试和 app 按钮交互测试。

## 4.3 P2：Revision 保留和空间回收没有生产调用方

### 证据

文件：`config.ini:83-87`

```ini
revision_keep_recent = 50
revision_keep_daily_days = 90
```

文件：`portfolio_store.py:730-824`

已经实现：

- `prune_revisions()`；
- `_prune_document()`；
- `freelist_count()`；
- `incremental_vacuum()`。

调用链检查结果：排除测试和实施计划文档后，生产代码中不存在对 `prune_revisions()`、`freelist_count()` 或 `incremental_vacuum()` 的调用。

文件：`portfolio_store_ws.py:104-139`

Store 环境只解析 backup interval、daily backup 数量和 weekly backup 数量，没有解析两个 revision retention 配置。

因此配置虽然写入 `config.ini`，运行时完全不生效。

### 影响

每次显式 Save 都保存完整 JSON snapshot。长期运行时：

- revision 表无限增长；
- 数据库文件和 OneDrive 静态备份持续变大；
- list、backup、restore、quick_check 和迁移时间随历史总量增长；
- 配置注释会让维护者误以为保留策略已经启用。

### 修改建议

1. 在 `create_store_env()` 中解析并验证：
   - `revision_keep_recent >= 1`；
   - `revision_keep_daily_days >= 0`；
   - vacuum freelist 阈值和单次最大页数。
2. 维护任务必须满足“先有已验证备份”再裁剪：
   - 成功发布新的静态备份；
   - 记录备份路径和验证结果；
   - 再执行 revision pruning；
   - 最后根据 freelist threshold 执行小批量 incremental vacuum。
3. 维护任务放在线程池或独立脚本，不进入 Save transaction，不阻塞 WebSocket event loop。
4. 用独立互斥锁保护 backup/prune/vacuum，避免多个保存同时启动重复维护。
5. 对软删除文档继续遵守恢复窗口策略，不能被 live-document 裁剪逻辑误删。
6. 在 README 中提供手工 maintenance 命令和失败恢复说明。

### 验收标准

- 生成超过 50 个 revisions 后运行维护，current 和最近 50 版仍存在。
- 更旧 revision 在 90 天窗口内每个 UTC 日期只保留最后一版。
- 没有可验证备份时，prune 明确拒绝执行。
- soft-deleted 文档不被普通 live-document retention 清理。
- incremental vacuum 只在 freelist 达到阈值时运行，并限制单次页数。
- 保存和行情事件循环在维护期间保持响应。
- 配置修改后能够通过日志和查询观察到实际生效。

## 4.4 P2：stale 通知和 writer takeover 未接入产品流程

### 证据

文件：`js/workspace_persistence.js:501-544`

底层模块实现并导出了：

- `requestTakeover()`；
- `completeTakeover()`；
- `setStaleRevisionHandler()`。

文件：`tests/workspace_persistence.test.js:332-397`

单元测试验证了：

- 第二个标签页进入 readonly；
- writer 保存后 reader 进入 stale；
- writer 心跳超时后 takeover 必须先 reload。

调用链检查结果：排除测试后，生产代码没有调用上述三个 API。

文件：`js/app.js:1964-1967`

实际 app 只在打开文档并得到 `readonly` 时显示一次 alert。之后没有 stale handler、Reload 操作、Take Over 操作或超时后的状态迁移。

### 影响

- 原 writer 正常关闭并广播 release 后，reader 的 `writerState` 仍保持 readonly/stale；
- 原 writer 崩溃并超过心跳期限后，reader 不会出现接管入口；
- writer 保存新 revision 后，reader 虽然在底层变成 stale，但用户不会得到即时提示；
- 用户只能手工重新 Open 同一文档，底层已实现的接管状态机没有形成产品能力。

SQLite expected revision 仍能防止静默覆盖，因此这是产品完整性和可用性问题，而不是并发数据保护完全失效，定为 P2。

### 修改建议

1. app 初始化 persistence client 后注册 `setStaleRevisionHandler()`。
2. stale 提示至少提供：
   - Reload latest；
   - Save a Copy；
   - Cancel 并继续保留本地只读分支。
3. UI 显示明确的 writer 状态，而不是只显示一次 alert：Writer、Read-only、Stale、Takeover available。
4. writer release 或 heartbeat timeout 后显示 Take Over，但不自动接管。
5. Take Over 流程必须：
   - 调用 `requestTakeover()`；
   - 从服务器重新 load 最新 revision；
   - 原子替换当前 state；
   - 重新 bind fingerprint；
   - 最后调用 `completeTakeover()`。
6. 如果本地存在修改，接管前必须要求 Save a Copy 或 Discard，不能静默丢弃。

### 验收标准

- A、B 打开同一文档时，B 明确显示 read-only。
- A 保存后，B 立即显示 stale，并可 Reload 或 Save a Copy。
- A 正常关闭后，B 能在明确操作后重新加载并成为 writer。
- A 异常消失后，B 在心跳超时前不能接管，超时后可接管。
- 接管必定先 load 最新 revision；旧内存 state 不能直接变为 writer。
- 不支持 BroadcastChannel 时仍依靠 revision conflict，且 UI 不声称拥有单写者租约。

## 4.5 P2：连接后 PRAGMA 失败会泄漏 SQLite connection

### 运行证据

执行：

```text
python3 -m unittest tests.portfolio_store_test tests.portfolio_store_ws_test
```

测试虽然最终通过，但运行中出现：

```text
ResourceWarning: unclosed database in <sqlite3.Connection object ...>
```

### 代码证据

文件：`portfolio_store.py:361-372`

```python
def _connect(self, for_init=False):
    try:
        conn = sqlite3.connect(self._db_path, isolation_level=None)
        conn.row_factory = sqlite3.Row
        conn.execute('PRAGMA foreign_keys = ON')
        if not for_init:
            conn.execute('PRAGMA journal_mode = WAL')
        conn.execute('PRAGMA synchronous = FULL')
        conn.execute('PRAGMA busy_timeout = 5000')
        return conn
    except sqlite3.Error as exc:
        raise self._map_sqlite_error(exc) from exc
```

如果 `sqlite3.connect()` 成功，但数据库损坏导致后续 PRAGMA 抛错，`conn` 已经存在，却没有在 except 中关闭。损坏数据库测试触发该路径，与运行警告一致。

### 影响

- 数据库损坏、权限变化或 I/O 错误期间泄漏文件描述符；
- 重复请求可能持续积累未关闭连接；
- Windows 下可能额外影响数据库文件替换、备份或恢复；
- 测试套件已经不能做到 warnings-clean。

### 修改建议

使用显式的部分初始化清理：

```python
def _connect(self, for_init=False):
    conn = None
    try:
        conn = sqlite3.connect(self._db_path, isolation_level=None)
        # configure connection...
        return conn
    except sqlite3.Error as exc:
        if conn is not None:
            conn.close()
        raise self._map_sqlite_error(exc) from exc
```

如果 `conn.close()` 也失败，不应覆盖原始数据库异常；可以用嵌套 try/except 忽略 close 的次生异常并保留原 cause。

### 验收标准

- 损坏数据库初始化测试不再产生 `ResourceWarning`。
- 使用 `-W error::ResourceWarning` 运行 store 测试通过。
- PRAGMA 任一步骤失败后，数据库文件可以立即被移动或替换。
- 原始结构化错误码仍保持 `database_corrupt`、`database_busy` 或 `store_unavailable`。

## 4.6 P2：软删除没有用户可操作的恢复路径

### 证据

文件：`js/session_ui.js:481-486`

删除确认提示为：

```text
It disappears from the list; its revision history stays recoverable in the database.
```

数据库确实执行软删除：`portfolio_store.py:656-689` 只设置 `deleted_at_utc`，没有删除 revisions。

但当前恢复链路存在以下限制：

- `list_documents()` 默认排除 `deleted_at_utc IS NOT NULL` 的文档；
- WebSocket 的 `list_saved_workspaces` 没有提供 `includeDeleted`；
- 协议没有 `undelete_saved_workspace`；
- `restore_revision()` 在 `portfolio_store.py:717` 调用 `load_workspace()`；
- `load_workspace()` 在 `portfolio_store.py:447-448` 对已删除文档抛出 `DocumentDeletedError`；
- 前端没有 revision history 或 deleted documents UI。

因此“数据仍在数据库”是事实，但“用户能够恢复”不是当前产品事实。

### 影响

- 用户依据提示删除后，无法通过正常 UI 恢复；
- revision restore API 也不能恢复软删除文档；
- 只能依靠人工 SQL、完整数据库备份恢复或修改代码；
- 提示会造成错误的安全预期。

### 修改建议

推荐实现真正的软删除恢复：

1. 增加 `list_deleted_workspaces`，或让列表协议在显式参数下返回最近删除文档。
2. 增加 `undelete_saved_workspace`：
   - 要求 document ID；
   - 要求 expected current revision；
   - 清除 `deleted_at_utc`；
   - 不改写历史 revision；
   - 记录恢复时间与结构化日志。
3. UI 增加 Recently Deleted，对恢复和永久删除使用不同确认文案。
4. 永久删除必须要求已有验证备份、二次确认，并设置明确恢复窗口。
5. 如果暂不实现恢复，应立即把删除提示改为：数据只保留在数据库中，恢复需要管理员使用备份或维护工具，普通界面无法撤销。

### 验收标准

- 删除后默认 Open 列表不可见。
- Recently Deleted 可以看见处于恢复窗口内的文档。
- Undelete 后文档重新出现在默认列表，document ID、current revision 和 payload hash 不变。
- 恢复旧 revision 仍以新增 revision 的方式进行，不重写历史。
- stale expected revision 的 undelete 返回 conflict。
- 永久删除与普通软删除有完全不同的确认和备份门槛。

## 5. 测试和验证结果

### 5.1 已执行测试

#### JavaScript 全量测试

```text
node tests/run.js
```

结果：

```text
697 passed, 0 failed
```

这说明现有功能和新增的 persistence 单元测试没有破坏主前端测试基线。

#### SQLite 与 WebSocket 定向 Python 测试

```text
python3 -m unittest tests.portfolio_store_test tests.portfolio_store_ws_test
```

结果：

```text
Ran 65 tests
OK (skipped=1)
```

同时产生未关闭 SQLite connection 的 `ResourceWarning`，对应 4.5 的确定问题。

### 5.2 当前未完整执行的验证

完整 Python test discovery 未在当前系统解释器上完成，因为该解释器缺少项目运行所需的 `websockets` 依赖，且当前 workspace 没有可直接使用的 `.venv`。因此以下内容仍需在项目正式 Python 环境中补跑：

- `ib_server.py` 的完整导入和集成测试；
- `historical_server.py` 的完整导入和集成测试；
- 两个真实 WebSocket server 的端到端 persistence request/response；
- 后端 shutdown 时的 backup top-up；
- Windows launcher 与实际 Python resolution 链路。

该限制不影响本文通过静态调用链确认的六项问题，但意味着不能仅凭当前测试结果声明完整集成通过。

## 6. 测试覆盖缺口

现有测试数量和后端覆盖总体较好，但以下关键产品行为缺少测试：

1. 未绑定新工作区的 dirty 判断。
2. JSON Import 后的 dirty 和关闭保护。
3. Save 按钮双击及两个并行 `saveWorkspace()`。
4. 并行保存交错完成后 unknown token 是否保留。
5. app 层实际展示 stale revision 并执行 reload。
6. app 层 heartbeat timeout 后的完整 takeover。
7. revision retention 配置到生产维护任务的集成。
8. 有备份前提与无备份拒绝 prune 的集成。
9. deleted document 的用户恢复流程。
10. warnings-as-errors 下的损坏数据库路径。

## 7. 推荐修改顺序

### 第一步：修复未绑定 dirty

目标：先关闭最直接的数据丢失路径。

成功标准：4.1 的全部自动化和人工验收通过，且 live tick 不产生误 dirty。

### 第二步：串行化保存

目标：保证一个标签页内任何时刻最多只有一个正式保存请求。

成功标准：双击、交错响应、ACK 丢失测试全部通过；不产生重复 document 或本地自冲突。

### 第三步：修复 SQLite 连接泄漏

目标：让故障路径和测试套件 warnings-clean。

成功标准：以 ResourceWarning 作为 error 运行定向测试通过。

### 第四步：接入 stale 和 takeover UI

目标：使底层已测试的单写者机制成为完整产品流程。

成功标准：双真实标签页完成 readonly、stale、reload、timeout、takeover 全流程。

### 第五步：接入 retention maintenance

目标：使 revision 配置真正生效，限制长期数据库增长。

成功标准：先备份、后裁剪、再按阈值 vacuum 的端到端测试通过，保存与行情不受阻塞。

### 第六步：补齐删除恢复语义

目标：让软删除名副其实，或把提示改成与当前能力一致。

成功标准：Recently Deleted/Undelete 可操作，或 UI 不再承诺普通用户可恢复。

### 第七步：完整环境回归

目标：在正式 Python 运行环境验证两个后端、启动器、备份和恢复。

成功标准：

- JavaScript 全量测试通过；
- Python 全量测试通过且无 ResourceWarning；
- live 与 historical 后端端到端 persistence 测试通过；
- 临时目录灾难恢复演练通过；
- 浏览器双标签人工验收通过。

## 8. 完成判定

满足以下条件后，才建议把原实施 PLAN 标记为完成：

- 两项 P1 已修复并有回归测试；
- 四项 P2 已修复，或有明确、诚实且经过确认的产品范围调整；
- 完整 Python 环境测试通过；
- 没有 ResourceWarning；
- 双标签真实浏览器验证通过；
- retention 确实在生产维护链路运行，而不仅是存在可调用方法；
- 删除与恢复提示和实际能力一致；
- 不存在已知的假 Saved、重复 document、重复 revision、丢失已提交内容或静默覆盖并发修改路径。

综合评价：后端持久化核心约为 **8/10**，前端与运维接线约为 **6/10**。实现方向正确，基础设施也具备较好的可测试性；当前需要的是收紧状态机并补齐产品闭环，而不是重写数据库方案。
