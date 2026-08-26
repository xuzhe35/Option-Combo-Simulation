# Portfolio SQLite Persistence — 69d509e 修复复查

## Review 范围

- 分支：`codex/portfolio-sqlite-persistence`
- 修复提交：`69d509e2e6fabde4778ec983915b350f5da89ff5`
- 对照文件：`CODE PLAN/PORTFOLIO_SQLITE_IMPLEMENTATION_REVIEW_09c0370.md`
- Review 方式：代码审查、相关测试套件、针对恢复集和状态机边界的最小复现
- 本次没有修改实现代码

## 结论

**尚未全部完成修复，建议仍为 Request changes。**

上一轮剩余的 3 个问题中：

| 上一轮问题 | 状态 | 本次结论 |
|---|---|---|
| Undelete 后 verified batch 无法收敛 | 部分修复 | 活动候选可以归零，但包含 current revision 的 batch 仍可永久保持 verified，甚至被封存后失去收敛路径。 |
| 手工 backup/restore 不是完整 recovery set | 部分修复 | 单机正常路径现在包含 shards，但共享目录会混入其他 install 的同名 shard；缺失 shard 仍可被报告为备份/恢复成功；restore 也没有取得 guard 或提供安装回滚。 |
| Verify 未校验 batch manifest | 已修复 | 已按 copy 阶段公式重算 `manifest_sha256`，并校验 revision、bytes、distinct document 和 `archived_documents` 数量；manifest-only corruption 测试通过。 |

当前仍有：

- P1：3 项
- P2：1 项

## Findings

### [P1] 1. Restore 会从共享目录安装其他 install 的同名 shard

位置：`scripts/restore_portfolio_store.py:79-100`

归档 shard 名称已经带 `install_id`，就是为了允许多台机器安全地发布到同一同步目录。但 restore 对每个 `archive_id` 使用：

```python
shard_src_dir.glob(f'{archive_id}-*.db')
```

随后按 mtime 选择最新文件，只检查 `archive_meta.archive_id`，没有把主库备份文件中的 install ID 与 shard 文件名及 `archive_meta.source_install_id` 绑定。

不同 install 都会从 `portfolio-archive-<year>-001` 开始，因此同名 archive ID 很常见。确定性双机复现中，使用 machine A 的主库备份恢复时，工具选择了 machine B 的较新 shard，并成功把 B 的 payload 恢复到了 A：

```text
restore_rc 0
expected_install_id 2affc8fda15045f8
installed_source_install_id e52b98134378497f
other_install_id e52b98134378497f
expected_symbol SPY
restored_symbol IWM
```

这是静默的数据来源串线，不只是恢复失败。

建议：为每次发布生成 recovery-set manifest，明确记录 main snapshot、source install ID、每个 shard 的精确文件名/hash/bytes；restore 只能按该 manifest 选择文件，并同时验证 `archive_meta.source_install_id`。最低限度也必须从 main backup 文件名解析 install ID，精确匹配 `<archive-id>-<same-install-id>.db`，不能使用通配符和 mtime 猜测。

### [P1] 2. 已知缺失 shard 时 backup 和 restore 仍返回成功

位置：

- `portfolio_archive.py:1111-1117`
- `scripts/backup_portfolio_store.py:80-98`
- `scripts/restore_portfolio_store.py:85-107`

`publish_archive_backups()` 遇到已注册但本地文件不存在的 shard 时直接 `continue`。调用方只根据“本次发布列表为空 + registry 非空”输出“already up to date”，并返回 0。

restore 又把 `missing_since_utc` 非空的注册项放入 `unrecoverable`，跳过 fail-closed 检查，仍安装主库并返回 0。实际复现：

```text
verify_status missing
backup_rc 0
backup_files ['portfolio-20260817T100733Z-schema2-810f2850f1ed4710.db']
restore_rc 0
restored_main_exists True
restored_shards []
```

这与 CLI/README 声明的“FULL recovery set”和“registered shard 缺失时 fail closed”直接冲突。成功退出码会让自动化或用户把一个不可恢复的集合当成有效灾备。

建议：backup 发布前后验证每个 registry row 都有与当前 install、当前恢复集匹配且校验通过的 snapshot；任一 shard 缺失时不发布成功 manifest，并返回非零。restore 对所有注册 shard 一律要求 recovery-set manifest 中存在对应快照；如果要支持“只恢复活动数据”的降级模式，必须使用单独的显式危险选项，不能作为默认成功路径。

### [P1] 3. Restore 仍绕过 maintenance guard，且安装阶段没有回滚

位置：`scripts/restore_portfolio_store.py:53-132`

backup CLI 已取得 `portfolio_maintenance.acquire_maintenance()`，但 restore CLI 没有。它只依赖 `--yes` 表示后端已停止，然后直接替换活动主库和 shards。这仍违反仓库中明确记录的硬不变量：“every maintenance path (backup, archive, vacuum, exact stats, restore) runs under `portfolio_maintenance.acquire_maintenance`”。

同时，安装顺序是：

1. `restore_database()` 先替换活动主库；
2. 逐个移走旧 shard；
3. 用 `shutil.copyfile()` 安装新 shard。

如果步骤 2/3 中发生磁盘、权限或 I/O 错误，代码没有 catch/rollback；主库已经替换，部分 shard 也可能已经移走。预先验证全部 staging 文件并不能保证安装阶段原子。

建议：restore 至少取得与目标数据库相同的 OS maintenance lock，并对运行中后端 fail closed；安装前建立可回滚的主库和 shard 旧集合，所有 rename/copy 成功后再提交完成标记，失败时恢复整个旧集合。异常处理也应覆盖 `OSError`，不能只捕获 `PortfolioStoreError`。

### [P2] 4. Undelete 重分类仍会留下永久的 sealed verified batch

位置：

- `portfolio_archive.py:1935-1953`
- `portfolio_archive.py:2008-2017`
- `portfolio_archive.py:1561-1577`

提交阶段现在会把已 undelete 的文档改走 partial-history 分支，因此非当前旧 revision 可以删除，活动候选能够归零。但原 whole-document batch 也包含该文档的 current revision；partial commit 必然返回 `skipped_current`，所以 batch 继续保持 verified，直到用户未来再次保存。

如果用户一直不再保存，batch 永远不是终态。更严重的是，rollover 会在不检查 non-terminal batch 的情况下封存该 shard；后续任务只处理新的 writable shard，旧 verified batch 再也不会被 mark committed。

复现结果：

```text
candidates_after_reclassify 0
verified_before_rollover 1
registry [('portfolio-archive-2026-001', 'sealed'),
          ('portfolio-archive-2026-002', 'sealed'),
          ('portfolio-archive-2026-003', 'active')]
batch_states [('portfolio-archive-2026-001', 1, 0),
              ('portfolio-archive-2026-002', 0, 0),
              ('portfolio-archive-2026-003', 0, 1)]
final_candidates 0
```

建议：undelete 重分类必须拆分或清理原 batch 中当前/不再符合归档条件的副本，并重新生成计数和 manifest，使已实际提交的行能够进入终态；同时 rollover 在封存前必须拒绝或处理 `copied`/`verified`/`cleanup_pending` 等非终态 batch。终态收敛不能依赖用户以后再次保存。

## 验证结果

### Node 测试

```text
737 passed, 0 failed
```

### 本次变更相关 Python 测试

```text
Ran 197 tests in 5.488s
OK (skipped=1)
```

新增的单机 happy-path、missing-snapshot fail-closed、busy guard、undelete candidate convergence 和 manifest corruption 测试均通过；上述 findings 来自这些测试未覆盖的多 install、已知 missing、安装失败边界和 rollover 状态机。

### Diff 检查

```text
git diff --check 69d509e^..69d509e
```

结果：通过，无 whitespace error。

## 建议修复顺序

1. 先用 recovery-set manifest 绑定 main DB、install ID 和每个 shard，禁止跨 install 混用。
2. 让 backup/restore 对任何注册 shard 缺失默认 fail closed，并补齐 guard 和安装回滚。
3. 处理 undelete batch 中不再可删除的 current row，并禁止带非终态 batch 的 shard 被封存。
