# `471c093` 修复验证 Review

## 结论

**Request changes。**

`471c093` 已经修复上一轮 6 条意见中的 4 条，并补上了有价值的回归测试；但恢复集仍不是“每代不可变”，恢复安装和回滚路径也仍有可重复的数据安全缺口。因此目前不能认定 `0edf86e` Review 已全部修复。

本轮发现：

- P1：3 条
- P2：1 条

## Findings

### [P1] 恢复文件仍按 install 覆盖，保留的旧备份和最后一个完整代都可能失效

位置：

- `portfolio_archive.py:1195-1226`
- `portfolio_archive.py:1327-1346`
- `portfolio_store.py:1416-1447`

恢复 manifest 固定写为 `recovery-manifest-{install_id}.json`，分片快照也固定写为 `{archive_id}-{install_id}.db`，因此它们都不是按 generation 不可变发布：

1. 第二次成功备份会覆盖唯一 manifest。`backup_keep_daily` / `backup_keep_weekly` 留下的旧主库仍在磁盘上，但已经没有 manifest 引用，默认恢复会拒绝它们。
2. 后续多分片备份若先覆盖了一个有变化的分片快照，随后因另一个本地分片缺失而失败，旧 manifest 虽然还在，但它引用的旧分片内容已经被覆盖，最后一个完整恢复代也随之损坏。

确定性复现结果：

```text
RETAINED_GENERATION {
  first_backup_rc: 0,
  second_backup_rc: 0,
  first_main_retained: True,
  first_main_restore_rc: 1,
  manifest_count: 1
}

MUTABLE_SHARD {
  first_backup_rc: 0,
  second_backup_rc: 1,
  old_manifest_shard_hash_still_matches: False,
  old_complete_generation_restore_rc: 1
}
```

建议让 generation id 同时进入主库、每个分片和 manifest 的文件名；所有成员只创建、不覆盖，最后原子发布该代独有的 manifest。保留策略也应以完整 generation 为单位删除，不能只保留主库文件。

### [P1] 验证的是 staged main，实际安装的却仍是可变化的原始备份文件

位置：`scripts/restore_portfolio_store.py:80-124, 201-204`

`_verify_set()` 把主库复制到 `tmpdir/main.db` 并在该 staged copy 上执行 quick-check 和主库/分片交叉验证；但 `_install_set()` 随后又从 OneDrive/备份目录中的原始 `backup_path` 复制到活动路径，而不是安装已经验证的 `main.db`。如果同步软件或其他进程在验证完成后替换了源文件，只要替换后的 SQLite 本身仍能通过 quick-check，恢复就会成功安装一份从未经过 manifest hash 和分片交叉验证的主库。

故障注入在 `_verify_set()` 返回后修改原始备份，结果如下：

```text
SOURCE_DRIFT {
  restore_rc: 0,
  installed_title: "DRIFTED AFTER VERIFICATION",
  installed_matches_verified_manifest_hash: False
}
```

建议把 staged main 路径一并从 `_verify_set()` 返回，并且 `_install_set()` 只安装 staged main；安装后再校验一次其 hash/size 或直接使用验证阶段记录的不可变临时文件。

### [P1] 安装 journal 仍漏掉部分写入和 `sqlite3.Error`，不能保证全量回滚

位置：`scripts/restore_portfolio_store.py:188-249`

有两个独立缺口：

1. `shutil.copyfile(backup_path, db_path)` 成功返回后才把 `db_path` 放进 `installed`。全新目标上若 copy 已创建/写入部分文件后抛错，rollback 不会删除它，工具却报告“was rolled back”。
2. 安装主库后直接执行清 lease/job 的 SQLite 写入，但外层只捕获 `PortfolioStoreError` 和 `OSError`。真实的 `sqlite3.OperationalError` 会直接逃出 CLI，`_rollback()` 完全不执行；已有旧库会留在 `.pre-restore-*`，未验证完成的新库占据活动路径。

确定性复现结果：

```text
PARTIAL_COPY {
  restore_rc: 1,
  active_path_exists_after_claimed_rollback: True,
  active_bytes: b"partial-main"
}

SQLITE_ERROR {
  exception_escaped_cli: "OperationalError: simulated disk I/O error",
  active_titles_after_failure: ["SPY workspace"],
  pre_restore_files: ["portfolio.db.pre-restore-..."]
}
```

建议所有新文件先写入目标目录中的唯一临时名，校验后再原子 rename；在任何可能创建目标文件之前登记 cleanup，且让整个安装/主库修整/分片校验过程统一进入同一个 `except Exception` 回滚边界（明确处理 rollback 自身失败）。

### [P2] 手工备份在写完成 manifest 之前就释放 maintenance guard

位置：`scripts/backup_portfolio_store.py:79-126`

主库和分片发布位于 guard 内，但 guard 在 `finally` 的第 103 行释放，manifest 到第 118 行以后才写。两个手工备份进程因此可以在“成员文件完成”和“completion marker 完成”之间交错：较新的备份先写完 manifest 后，较早的进程仍可最后覆盖同一个 install manifest，使较新的成功备份失去可恢复入口。这也与 README 所述“FULL recovery set 在同一 cross-process maintenance guard 下发布”不一致。

建议把缺失检查、`write_recovery_manifest()` 和成功结果的确定全部移回 guard 的 `try` 内，只在 manifest 已经原子发布或本代明确失败后释放 guard。配合 P1 的每代唯一 manifest 后，不应再覆盖另一代的 completion marker。

## 上一轮 6 条意见的逐项状态

| `0edf86e` Review 项 | `471c093` 状态 | 验证结论 |
|---|---|---|
| P1：失败发布可能把新主库与旧分片拼成恢复集 | **部分修复** | manifest 能拒绝未完成的新主库，但文件不是每代不可变，旧完整代仍可能被后续发布破坏。 |
| P1：publisher install id 与 shard origin id 混用 | **已修复** | manifest 的 publisher 身份与 `archive_meta.source_install_id` 已分离；二次备份/恢复测试通过。 |
| P1：主库安装失败不在 rollback journal 内 | **部分修复** | 原意见中的“先移走旧主库、正常 copy 立即失败”已修复；部分写入和 `sqlite3.Error` 仍绕过完整回滚。 |
| P1：运行中的普通后端不能阻止 restore | **已修复** | backend shared runtime lock 与 restore exclusive lock 双向测试通过。 |
| P2：rollover 后旧分片的 `copied` batch 被搁置 | **已修复** | all-active-shard 预协调 + commit sweep 可使原复现收敛。 |
| P2：trim 后 registry stats 不刷新 | **已修复** | 当前分片和 swept 分片在 commit/trim 后立即刷新，新增 parity 测试通过。 |

## 验证记录

- `git diff --check 0edf86e..471c093`：通过。
- 前端全量：`node tests/run.js`，**737 passed, 0 failed**。
- 持久化/归档相关 Python：**209 tests，OK，skipped=1**。
- 额外执行了 4 组临时目录故障注入；复现脚本已删除，没有改动业务代码。

## 最终判定

`471c093` 明显推进了修复，但尚未达到可批准状态。至少应先完成：

1. 真正不可变的 per-generation main/shards/manifest；
2. 只安装已验证 staged main；
3. 覆盖部分 copy 和所有 SQLite 安装异常的强异常安全 rollback；
4. completion manifest 在 maintenance guard 内发布。
