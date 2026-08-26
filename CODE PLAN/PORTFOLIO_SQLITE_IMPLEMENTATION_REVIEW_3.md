# Portfolio SQLite Persistence Implementation Review

## Review 范围

- 分支：`codex/portfolio-sqlite-persistence`
- 提交范围：`cc49386^..d287b2a`（包含 `cc49386` 到 `d287b2a`）
- 对应阶段：Phase 0–7，共 8 个阶段
- Review 方式：只读审查，没有修改实现代码

## 结论

建议 **Request changes**。

共发现：

- P1：5 项
- P2：3 项

其中 tombstone ID 重用、skipped batch 无法收敛、plan token 并发双消费均已通过最小场景复现。

## Findings

### [P1] 1. 移除绕过归档的直接 prune 路径

位置：`scripts/backup_portfolio_store.py:64`

README 仍推荐 `--prune-revisions`，该分支会直接删除 `workspace_revisions` 并执行 vacuum，既不创建归档副本或 archive entry，也没有取得跨进程 maintenance guard。

这违反了“唯一删除路径是 archive-then-remove”的核心不变量，并可能与 Live/Historical 两个后端的归档或其他维护任务并发。

建议：

- 移除 `--prune-revisions` 选项和可绕过的直接调用路径；或
- 让 CLI 调用与管理页相同的 guarded archive job。

### [P1] 2. Tombstone 没有真正保留 document ID

位置：`portfolio_store.py:941`

`save_workspace()` 的创建路径只检查 `workspace_documents`，没有在同一事务中检查 `workspace_archive_tombstones`。

完整文档归档后，使用原 document ID 发起新 create 会成功。最小复现结果：

```text
tombstone_reuse_revision 1
```

这会造成归档身份碰撞；该文档以后再次归档时，写入同一 tombstone 主键也会失败。

建议：在 create 的写事务中检查 tombstone，命中时返回稳定的身份保留/冲突错误。

### [P1] 3. 不要把含 skipped 行的 batch 标为 committed

位置：`portfolio_archive.py:1762`

`commit_verified_batches()` 无条件把整个 verified batch 改为 `main_committed`，即使其中存在 oversized、undeleted、changed 或其他仍留在活动库的 skipped 行。

后续归档时，safe replay 会把原归档行视为已完成，因此不会创建新的 verified batch；活动库中的候选也就无法再进入 commit。

最小复现结果：

```text
first_skipped [{'documentId': 'doc-deleted-1111-4111-8111-111111111111',
                'reason': 'skipped_oversized_document'}]
second_removed 0
second_skipped []
remaining_candidates 2
```

建议：只有 batch 的全部行都有删除或既有提交证据时才能标记 `main_committed`；否则应保留 verified/resumable 状态，并允许下一次任务继续提交剩余行。

### [P1] 4. 原子化 plan token 消费

位置：`portfolio_admin_ws.py:550`

plan 的读取、未消费检查、job 创建和 `consumedByJobId` 写入没有锁，但 execute 请求通过 `asyncio.to_thread` 并发运行。

两个同时到达的请求都能通过未消费检查并分别创建 job；plan 最终只指向最后一次写入的 job，破坏 lost-ACK 重放语义。

确定性并发复现结果：

```text
jobs_created 2
returned_job_ids ['job-0affea9c1f5547d4899e', 'job-1f006add68c34807bf9b']
consumed_pointer job-1f006add68c34807bf9b
```

建议：

- 使用每个 store environment 的锁包住 lookup、校验、job 创建和 token 消费；或
- 在数据库中持久化 plan token，并通过唯一约束和单一事务原子消费。

### [P1] 5. 为 archive shards 发布静态备份

位置：`portfolio_store_ws.py:455`

当前定时备份只发布活动 `portfolio.db`，没有发布 archive shard。

归档完成且 recovery snapshot 过了保留期后，同步目录中的主库备份只包含 archive entry/tombstone；真正的历史 payload 仍只存在本机 archive shard。机器或磁盘损坏后，主库备份会指向不存在的分片，已归档 payload 无法恢复。

现有灾难恢复测试使用 `shutil.copytree()` 直接复制活动 archive 目录，并没有验证真实的静态分片备份发布流程。

建议：在同一 maintenance guard 下，通过 SQLite backup API 为归档分片生成、校验、原子发布和保留静态备份。

### [P2] 6. 在服务端校验归档确认文本

位置：`portfolio_admin_ws.py:224`

execute 请求只携带 `planToken`。页面虽然要求输入 `ARCHIVE <N> REVISIONS`，但没有发送该文本，后端也没有校验。

因此任意 loopback 客户端都可以 preview 后直接启动会删除活动行的归档任务。破坏性确认目前只是前端状态，不是服务端安全边界。

建议：页面发送 confirmation，后端根据服务端 plan totals 生成并精确比对预期文本。

### [P2] 7. 不要把完整归档协议标记为 copyOnly

位置：`portfolio_admin_ws.py:245`

实际 job 会在 copy/verify 后删除活动行，但 preview 和 execute ACK 都返回：

```json
{"copyOnly": true}
```

协议客户端可能据此错误判断任务没有删除阶段；当前服务端测试也固化了这个矛盾。

建议：完整归档返回 `copyOnly: false`，或移除这个已经过期的字段。

### [P2] 8. 补齐独立的 archive verify 任务

位置：`portfolio_admin_ws.py:36`

管理协议没有计划要求的 `verify_workspace_archive` action，页面也没有对应入口。

因此 sealed shard 被移动或删除后，不会主动更新 `missing_since_utc`；概览中的 Missing files 可能长期显示为 0。分片损坏通常只能在 restore 时被动发现。

建议：增加 guarded 后台 verify job，检查分片文件、schema、quick check、batch manifest 和 payload hash，并刷新 registry 的 missing/verify 状态。

## 验证结果

### Node 测试

```text
736 passed, 0 failed
```

命令：

```text
node tests/run.js
```

### 本次变更相关 Python 测试

```text
Ran 185 tests in 4.889s
OK (skipped=1)
```

覆盖：

- portfolio store / schema migration
- persistence WebSocket
- maintenance lease
- archive copy / commit / restore
- fault injection / endurance
- admin WebSocket

### 全量 Python discovery

```text
Ran 416 tests
FAILED (errors=2, skipped=1)
```

两个错误均为当前 Python 3.14 环境缺少可选运行依赖造成的模块导入失败：

- `ib_async`
- `websockets`

没有观察到测试断言失败。

### Diff 检查

`git diff --check cc49386^..d287b2a` 还报告：

```text
portfolio_archive.py:1839: new blank line at EOF.
```

## 建议修复顺序

1. 先关闭所有绕过 archive-then-remove 的删除入口。
2. 修复 skipped batch 收敛和 tombstone ID 保留。
3. 原子化 plan token 消费，并把确认校验下沉到服务端。
4. 实现 archive shard 静态备份和独立 verify job。
5. 修正协议中的 `copyOnly` 状态并补充对应回归测试。

