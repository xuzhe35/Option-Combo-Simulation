# Portfolio SQLite Persistence — 09c0370 修复复查

## Review 范围

- 分支：`codex/portfolio-sqlite-persistence`
- 修复提交：`09c03707739c89157f3d166a2d8b20d1f499b511`
- 对照文件：`CODE PLAN/PORTFOLIO_SQLITE_IMPLEMENTATION_REVIEW_3.md`
- Review 方式：代码审查、相关测试套件、针对边界场景的最小复现
- 本次没有修改实现代码

## 结论

建议仍为 **Request changes**。

09c0370 已完整修复原 Review 中的 4 项，并为另外 4 项提供了主体实现；但仍留下 3 个可复现缺口：

- P1：2 项
- P2：1 项

## 原 8 项意见的修复状态

| # | 原意见 | 状态 | 复查结论 |
|---|---|---|---|
| 1 | 直接 prune 绕过归档 | 部分修复 | `--prune-revisions` 已移除；但文档化的手工备份入口仍绕过 maintenance guard，见 Finding 2。 |
| 2 | Tombstone 未保留 document ID | 已修复 | create 路径在同一写事务内检查 tombstone，并返回稳定的 `document_id_archived`。 |
| 3 | 含 skipped 行的 batch 被标为 committed | 部分修复 | oversized 场景现在可以重试并收敛；undelete 导致 archive kind 改变时仍会永久卡住，见 Finding 1。 |
| 4 | Plan token 可并发双消费 | 已修复 | lookup、校验、job 创建、token 消费已由每个 store env 的锁原子保护；并发测试覆盖一次性消费。 |
| 5 | Archive shard 没有静态备份 | 部分修复 | 定时备份会发布 shard 快照；手工备份/恢复流程仍只处理主库，见 Finding 2。 |
| 6 | 服务端不校验确认文本 | 已修复 | 客户端发送 confirmation，服务端根据 plan totals 生成并精确校验。 |
| 7 | 完整归档错误返回 `copyOnly: true` | 已修复 | preview/execute ACK 已移除该误导字段。 |
| 8 | 缺少独立 archive verify 任务 | 部分修复 | action、后台 job、UI、missing/orphan/payload 校验均已加入；batch manifest 仍未校验，见 Finding 3。 |

## Findings

### [P1] 1. Undelete 后的 verified batch 仍无法收敛

位置：`portfolio_archive.py:1905-1975`

09c0370 在 batch 存在 skipped 行时不再标记 `main_committed`，这正确修复了 oversized document 在限制恢复后的重试问题。但是，batch 中记录的 `archiveKind` 是复制时的固定值；如果完整删除文档在 copy/verify 后、commit 前被 undelete，该 batch 仍会在以后每次重试中把它当作 `deleted_document`。

后续即使该活动文档产生了新的可归档历史修订：

- safe replay 会复用原 verified batch；
- commit 继续走 whole-document 分支；
- 活动文档导致 `skipped_undeleted`；
- batch 永远保持 verified，新候选也无法进入可提交的 partial-history batch。

确定性复现：

```text
undelete_first_skipped [{'documentId': 'doc-deleted-1111-4111-8111-111111111111',
                         'reason': 'skipped_undeleted'}]
undelete_second_removed 0
undelete_remaining_candidates 1
undelete_verified_batches 1
```

建议：在重试 commit 前重新判定文档类别，并对已从 deleted-document 转成 active-history 的行做可验证的 batch 拆分/重分类；或者允许新 batch 接管尚无 removal receipt 的行。不能仅靠把原 batch 保持为 verified 来覆盖类别转换。

### [P1] 2. 手工备份/恢复仍不是完整的 archive recovery set

位置：

- `scripts/backup_portfolio_store.py:45-58`
- `scripts/restore_portfolio_store.py:28-49`

定时维护路径现在会在 maintenance guard 下调用 `publish_archive_backups()`，这是有效修复。但 README 推荐的手工备份脚本仍直接构造 `PortfolioStore` 并只调用 `store.publish_backup()`：

- 没有取得 `portfolio_maintenance.acquire_maintenance`；
- 没有发布任何已注册 archive shard；
- 对应 restore 脚本也只安装主数据库，不恢复或验证 shard 快照。

在已经执行过完整归档的数据库上运行真实手工入口，目标目录只有主库：

```text
manual_backup_rc 0
manual_backup_files ['portfolio-20260817T095326Z-schema2-2833e87fe5554937.db']
```

此主库包含 archive entry/tombstone，但已从活动库删除的 payload 只存在 shard 中。因此用户按文档执行手工备份和恢复后，会得到指向缺失分片的数据库，而不是可完整恢复的数据集。这也仍违反开发文档声明的“每个 backup/archive/vacuum/exact stats/restore 路径都必须取得 maintenance guard”不变量。

建议：让手工 CLI 在统一 guard 下发布带 manifest 的主库 + 全部已注册 shard 快照集合；restore 必须先验证整套文件，再一起安装或 fail closed。至少应为该真实 CLI 路径增加灾难恢复测试，而不是在测试中手工调用 `publish_archive_backups()` 并自行复制分片。

### [P2] 3. Verify job 没有验证 `manifest_sha256`

位置：`portfolio_archive.py:1214-1246`

`run_verify_job()` 会检查 SQLite quick check、archive meta、batch 的 revision count/payload bytes，以及每个 payload 的 hash/bytes；但查询没有读取 `archive_batches.manifest_sha256` 和 `document_count`，也没有重算 batch manifest。

直接篡改已 sealed shard 的 batch manifest 后，任务仍报告成功：

```text
tampered_manifest_verify_status ok
```

这与该任务“Full integrity verification”的语义及原 Review 要求的 batch manifest 校验不一致，也会让 registry 写入错误的 `last_verify_status='ok'`。

建议：读取组成 manifest 的稳定字段，按 copy 阶段同一规范重算并精确比较 `manifest_sha256`；同时核对 `document_count` 与 `archived_documents`/实际行的对应关系，并为 manifest-only corruption 增加失败回归测试。

## 验证结果

### Node 测试

```text
737 passed, 0 failed
```

命令：

```text
node tests/run.js
```

### 本次变更相关 Python 测试

```text
Ran 192 tests in 5.193s
OK (skipped=1)
```

覆盖 portfolio store、migration、persistence WebSocket、maintenance lease、archive copy/commit/restore、fault injection/endurance 和 admin WebSocket。

### Diff 检查

```text
git diff --check 09c0370^..09c0370
```

结果：通过，无 whitespace error。

## 建议修复顺序

1. 先修复 undelete 后的 batch 重分类/接管，保证活动候选最终可收敛。
2. 把手工 backup/restore 升级为 guarded、可验证的主库 + shards 恢复集。
3. 补齐 manifest/document summary 验证及 corruption 回归测试。
