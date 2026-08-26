# Portfolio SQLite 持久化实现 Review 2

> Review 日期：2026-08-08  
> Review 对象：提交 `dfff5ca`（针对首轮 Review 的修订）  
> 结论：修订有效解决了大部分首轮问题，但仍有 2 项 P1 和 2 项 P2。两个 P1 修复前不建议把实施标记为完成。

## 1. 本轮总体评价

本轮修改是实质性改进：

- 同一标签页的保存已在 app 和 persistence client 两层串行化；
- Save/Save a Copy 等待 ACK 时会禁用，快速点击不再并行提交；
- 普通未绑定工作区已经有 dirty baseline；
- stale 通知和 takeover 已接入 UI；
- revision retention 已接到“验证备份成功后”的维护链路；
- SQLite 连接初始化失败时的泄漏已修复；
- Recently Deleted 和 undelete 已形成可操作恢复流程；
- 静态资源 hash 与 HTML cache-bust 参数一致。

当前剩余问题主要集中在未知保存结果、一次性 handoff 的 dirty 基线、takeover 状态回滚和后台维护互斥。

## 2. P1：首次 Save 或 Save a Copy 的未知结果重试仍可能创建重复文档

### 证据

`js/app.js:1885-1904` 在未绑定保存或 Save a Copy 时，每次调用都会重新生成 document ID：

```js
if (!copy && envelope) {
    documentId = envelope.documentId;
    expectedRevision = envelope.revision;
    title = envelope.title;
} else {
    title = OptionComboSessionUI.promptWorkspaceTitle(...);
    // ...
    documentId = _generateWorkspaceUuid();
    expectedRevision = undefined;
}
```

`js/workspace_persistence.js:353-364` 只有在 `documentId` 和 payload fingerprint 都与未知结果请求相同时才复用 save token。

因此以下时序仍会失败：

1. 首次 Save 使用 document A。
2. 服务端成功提交 document A revision 1，但 ACK 丢失。
3. 浏览器没有收到成功响应，因此仍无 document envelope。
4. 用户按提示重试，app 生成 document B。
5. persistence client 因 document ID 不同生成新 token。
6. 服务端创建 document B revision 1，形成重复文档。

Save a Copy 的未知结果重试也有同样问题。当前提示“identical retry is safe”只对已有绑定文档成立，对 create/copy 不成立。

### 修改建议

推荐让 persistence client 保存完整的未知保存身份，而不是只保存 token：

```text
operation: create | update | copy
documentId
title
expectedRevision
payloadFingerprint
saveToken
```

具体流程：

1. 首次 create/copy 在生成 document ID 后，把完整身份交给 client。
2. timeout/disconnected 时保留该身份。
3. 下一次保存前先查询是否存在相同 payload 的 unknown attempt。
4. 完全相同时复用 document ID、title 和 save token，不再重新命名或生成 UUID。
5. payload 已变化时仍应复用原 document ID，但使用新 token：
   - 如果原请求未提交，可以正常创建；
   - 如果原请求已经提交，服务器返回 create conflict，随后让用户 Open latest 或 Save a Copy；
   - 不应通过改用新 document ID 静默产生孤立副本。
6. 用户应有显式的“放弃未知请求并另存为新副本”入口，不能隐式改变 document identity。

### 验收标准

- 首次 Save 在服务端提交后模拟丢失 ACK，再点击 Save，只存在一个 document 和一个 revision。
- 首次 Save 在服务端未提交时断线，重连后重试仍使用同一 document ID。
- Save a Copy 丢失 ACK 后重试，不产生第二个副本。
- unknown attempt 内容未变化时复用原 save token。
- unknown attempt 后内容发生变化时，不会静默换 document ID；行为进入明确的成功或 conflict 流程。
- UI 提示与 create、update、copy 三类实际重试语义一致。

## 3. P1：Calendar handoff 被记录成干净基线

### 证据

`js/app.js:309-323` 的启动顺序为：

```js
bindControlPanelEvents();
consumePendingCalendarHandoff();
renderGroups();
renderHedges();
updateDerivedValues();
// ...
persistenceClient.setUnboundBaseline(_buildPersistencePayload());
```

`consumePendingCalendarHandoff()` 会消费一次性 handoff，并创建新的 Futures Pool 项目和组合。baseline 在 handoff 之后记录，所以这些新内容会被视为“初始干净状态”。

用户如果没有执行首次 Save 就关闭页面：

- `_workspaceIsDirty()` 返回 false；
- `beforeunload` 不提示；
- handoff 已经被消费，重新打开页面也无法恢复；
- 新组合直接丢失。

### 修改建议

推荐保留当前启动流程，但使用 handoff 返回值明确标记 dirty：

```js
const handoffConsumed = consumePendingCalendarHandoff();
// 完成正常初始化和 baseline 建立
persistenceClient.setUnboundBaseline(pristinePayload);
if (handoffConsumed) {
    persistenceClient.markUnboundDirty();
}
```

更稳妥的实现是：

1. 在应用默认状态和 query-param 初始化完成后记录 pristine baseline。
2. 再消费 Calendar handoff。
3. handoff 成功时显式 `markUnboundDirty()`。
4. handoff 无效或未找到时保持 clean。
5. 不依赖 Group 数量推断 dirty，因为合法空组合和其他 handoff 类型可能改变多个字段。

### 验收标准

- 没有 handoff 的新页面保持 clean。
- 成功消费 handoff 后立即为 dirty。
- handoff 后关闭页面会出现未保存修改提示。
- handoff 后选择 Open 会出现 Save/Discard/Cancel。
- handoff 后首次数据库 Save 成功，dirty 变为 false。
- 增加 app 测试，断言 handoff 消费后 `isDirty()` 为 true，而不只断言 Group 已创建。

## 4. P2：取消 takeover 或 reload 失败后会残留 `takeover-pending`

### 证据

`js/workspace_persistence.js:569-582` 中，`requestTakeover()` 在用户确认之前就产生状态变化：

```js
writerState = 'takeover-pending';
return { allowed: true, mustReloadFirst: true };
```

`js/app.js:1858-1876` 随后才显示选择对话框。以下路径都没有恢复原状态：

- 用户选择 Cancel；
- 用户选择 Save a Copy，但命名取消或保存失败；
- 用户选择 Take Over，但 load latest 失败；
- load 成功后的 lease acquisition 未完成预期状态转换。

下一次 Save 只拦截 `readonly` 和 `stale`。残留的 `takeover-pending` 不会进入只读保护分支，因此会直接尝试保存原 document。

SQLite expected revision 仍能阻止覆盖已提交的新 revision，但 UI 的单写者语义和用户的 Cancel 选择会被绕过。

### 修改建议

首选方案是把 takeover eligibility 和状态改变分离：

1. `canTakeover()`：纯查询，无副作用，只返回 allowed/reason。
2. 用户确认 Take Over 后调用 `beginTakeover()`，进入 `takeover-pending`。
3. load latest 成功并完成绑定后调用 `completeTakeover()`。
4. 任一步失败或用户取消时调用 `cancelTakeover()`，恢复此前的 `readonly` 或 `stale` 状态。
5. Save 的保护条件应采用 allow-list：只有 `writer` 才能覆盖已绑定文档；`idle`、`readonly`、`stale`、`takeover-pending` 均不得直接更新原 document。

另外，当前 `_openWorkspaceDocument()` 内会调用 `acquireWriterLease()`，它先执行 `releaseWriterLease()`，会清除 `takeover-pending`。需要明确选择一条状态转换路径：

- takeover reload 不再走普通 acquire，而由 `completeTakeover()` 完成 claim；或
- 普通 acquire 完成接管，则删除无效的 `completeTakeover()` 调用和 pending 状态，改成可证明正确的单一路径。

### 验收标准

- 用户选择 Cancel 后状态仍为 readonly/stale，下一次 Save 不能覆盖原 document。
- load latest 失败后状态回滚，下一次 Save 仍受只读保护。
- Save a Copy 取消或失败后不会残留 takeover-pending。
- 成功 takeover 必须先 load 最新 revision，再进入 writer。
- app 测试使用真实 workspace persistence 状态机或等价集成 harness，不能只用不会改变状态的 fake `requestTakeover()`。
- 增加 `takeover-pending` 下直接 Save 必须被拒绝的测试。

## 5. P2：备份、裁剪和 vacuum 缺少线程安全互斥

### 证据

每次成功保存都会执行：

```python
asyncio.get_running_loop().create_task(
    asyncio.to_thread(maybe_publish_scheduled_backup, store_env)
)
```

因此多个保存可以同时在线程池中调用维护函数。

`portfolio_store_ws.py:370-372` 使用普通字典作为门闩：

```python
if store_env.get('_backup_inflight'):
    return False
store_env['_backup_inflight'] = True
```

这是 check-then-set，不是线程互斥。两个线程可能同时读到 false，然后都进入完整维护流程。

`portfolio_store.py:967-982` 的备份名称和本机 staging 文件都只有秒级时间戳：

```text
portfolio-YYYYMMDDTHHMMSSZ-schemaN-installId.db
.backup-staging-YYYYMMDDTHHMMSSZ.db
```

并发进入时会共享相同 staging、partial 和最终目标，随后还可能同时执行 prune 和 incremental vacuum。

### 修改建议

1. 在 `create_store_env()` 中创建真正的 `threading.Lock`：

```python
'_maintenance_lock': threading.Lock()
```

2. `maybe_publish_scheduled_backup()` 使用非阻塞 acquire：

```python
lock = store_env['_maintenance_lock']
if not lock.acquire(blocking=False):
    return False
try:
    # latest check, backup, prune, vacuum
finally:
    lock.release()
```

3. latest-backup interval 判断必须放在锁内，避免两个线程都认为备份过期。
4. 保留唯一 staging 文件名作为第二层防御，可加入 UUID 或纳秒值；不能依赖它替代锁。
5. shutdown top-up、显式 force backup 和 save-triggered maintenance 必须共用同一把进程内锁。
6. 如果未来允许多个后端进程共享同一个 DB，还需要跨进程 maintenance lock；当前单进程 v1 至少先保证线程安全。

### 验收标准

- 20 个线程同时调用 scheduled backup，只有一个进入 publish/prune/vacuum。
- 其他线程快速返回，不阻塞行情事件循环。
- 同一秒内 force 与 scheduled 调用不会共享 staging/partial 文件。
- prune 和 vacuum 不会并行执行两次。
- maintenance 抛错后锁必定释放，下一次维护仍可运行。
- 备份失败时不执行 prune；备份成功后才允许 retention。

## 6. 首轮问题回归状态

| 首轮问题 | 本轮评估 |
|---|---|
| 未绑定工作区 dirty | 普通流程已修复；Calendar handoff 仍有 P1 |
| 并行保存 | 已修复；但首次 create/copy 的 unknown retry 仍有 P1 |
| Revision retention 未接线 | 已接线；后台维护互斥仍需修复 |
| stale/takeover 未接 UI | 已接入；取消和失败状态回滚仍需修复 |
| SQLite 连接泄漏 | 已修复 |
| 软删除不可恢复 | 已修复，Recently Deleted/Undelete 可用 |

## 7. 测试结果

### JavaScript

```text
node tests/run.js
708 passed, 0 failed
```

### Persistence Python 定向测试

```text
python3 -W error::ResourceWarning -m unittest \
  tests.portfolio_store_test tests.portfolio_store_ws_test

Ran 72 tests
OK (skipped=1)
```

这证明本轮修复的 SQLite 连接泄漏在 persistence 定向测试中已经消除。

### 完整 Python discovery

```text
python3 -m unittest discover -s tests -p '*_test.py'
```

运行 303 项，因当前系统解释器缺少 `ib_async` 和 `websockets`，有 2 个测试模块无法导入，另有 1 项跳过。因此当前环境不能证明完整 Python 集成通过；这不是上述四项问题的依据，也不能被现有定向测试结果替代。

## 8. 推荐修改顺序

1. 修复首次 create/copy 未知结果的 document identity 重用。
2. 修复 Calendar handoff dirty 基线。
3. 修复 takeover 的 begin/complete/cancel 状态转换。
4. 为 backup/prune/vacuum 增加真正的线程锁和并发测试。
5. 在项目正式 Python 环境补跑完整测试。
6. 使用两个真实浏览器标签页验证 stale、Save a Copy、Cancel、writer 消失和 takeover。

完成前两项后，已知的直接重复文档和未保存 handoff 丢失路径才算关闭；完成后两项后，单写者协调与长期维护链路才适合认定为稳定。
