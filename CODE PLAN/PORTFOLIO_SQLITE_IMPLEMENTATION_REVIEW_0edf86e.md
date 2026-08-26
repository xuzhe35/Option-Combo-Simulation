# Portfolio SQLite Persistence — 0edf86e 修复复查

## Review 范围

- 分支：`codex/portfolio-sqlite-persistence`
- 修复提交：`0edf86ede84ca7fdc03c2256c48e99bb62f3a7c5`
- 对照文件：`CODE PLAN/PORTFOLIO_SQLITE_IMPLEMENTATION_REVIEW_69d509e.md`
- Review 方式：代码审查、相关测试套件、针对 recovery generation、二次恢复、主库安装失败、运行中保存及 rollover crash 的最小复现
- 本次没有修改实现代码

## 结论

**尚未全部完成修复，建议仍为 Request changes。**

0edf86e 为上一轮 4 项意见都增加了主体实现和回归测试，但测试主要覆盖各修复的直接 happy path。进一步验证仍发现：

- P1：4 项
- P2：2 项

## 上一轮 4 项意见状态

| 上一轮意见 | 状态 | 本次结论 |
|---|---|---|
| 跨 install 选择错误 shard | 部分修复 | A/B 同目录的直接串线已阻止；但把 snapshot publisher ID 与 shard 原始 `source_install_id` 当作同一值，会让恢复后的机器发布的新恢复集无法再次恢复。 |
| 缺失 shard 仍被视为成功 recovery set | 部分修复 | 直接缺失默认会返回非零；但没有 recovery-set generation manifest，失败发布留下的主库仍能与旧 shard 拼成一个被接受但缺数据的集合。 |
| Restore 缺少 guard 和完整回滚 | 部分修复 | maintenance OS lock 和“主库成功、shard 安装失败”回滚已实现；普通 save 不受该锁约束，且主库安装函数内部失败时仍无法回滚。 |
| Undelete/rollover 留下永久 verified batch | 部分修复 | current row trimming 和跨 shard verified sweep 有效；rollover 后其他 shard 的 `copied` batch 不会被 resume/sweep，trim 后 registry 统计也不刷新。 |

## Findings

### [P1] 1. 失败发布的主库仍可与旧 shard 拼成“成功”恢复集

位置：

- `scripts/backup_portfolio_store.py:79-108`
- `portfolio_store_ws.py:455-480`
- `scripts/restore_portfolio_store.py:54-109`

当前仍没有 recovery-set generation manifest。主库先以正式文件名发布，shard 随后按固定的 `<archive-id>-<install-id>.db` 文件名覆盖。若 shard 文件在两步之间缺失或发布失败：

- backup CLI 虽然最终返回 1，但正式主库文件已经留在目标目录；
- scheduled backup 只记录错误，仍保留该主库并返回成功；
- 同一 install 的旧 shard snapshot 仍保留原正式文件名；
- restore 只检查 install ID、archive ID、source ID 和 SQLite quick check，不验证该 shard generation 是否覆盖主库中的全部 archive entries/tombstones。

确定性复现：先成功发布一套备份，再向同一 shard 归档 revision 7/8，删除活动 shard 后重新备份。第二次备份返回失败，但 restore 接受新主库与旧 snapshot：

```text
first_backup_rc 0
second_backup_rc 1
restore_rc 0
revision7_restore ArchiveNotFoundError: archived revision missing from its shard
```

这意味着错误日志/退出码不能阻止一个标准命名、可被 restore 接受的不完整集合进入同步目录。

建议：按 generation 发布不可变的 main + shard 文件，最后原子发布 completion manifest；manifest 至少包含 publisher install ID、main 文件名/hash/bytes、每个 shard 的精确文件名/hash/bytes。restore 只接受带完成 manifest 的 generation，并交叉验证主库每个 archive entry/tombstone 都能在对应 shard 中找到匹配行。发布失败时不得产生可被 restore 识别为完成的集合。

### [P1] 2. 恢复后的机器无法发布可再次恢复的备份

位置：`scripts/restore_portfolio_store.py:70-99`

主库备份文件名中的 install ID 是当前 snapshot **publisher** 的 ID；`archive_meta.source_install_id` 是 shard 最初创建时的来源 ID。恢复到新机器后，新机器会生成新的 install ID，但已恢复 shard 的 `source_install_id` 不会也不应被改写。

当前 backup 会用新机器 ID 发布这些旧 shard，restore 却要求：

```python
meta['source_install_id'] == install_id_from_main_backup_name
```

因此第一代恢复成功、在恢复后的机器上再次备份也返回成功，但第二代恢复必然失败：

```text
first_restore_rc 0
second_backup_rc 0
second_restore_rc 1
restore failed: snapshot ... was produced by install <original>, not <new publisher>
```

建议：不要用 `source_install_id` 代替 recovery-set publisher identity。由 generation manifest 绑定本次 publisher 与 snapshot 文件；保留并验证 shard 的 origin/source ID 作为独立元数据。如果产品决定 restore 后继承原 install ID，则必须显式、安全地恢复 `install_id` marker，并处理两个克隆向同一目录发布时的身份冲突，不能依靠当前隐式行为。

### [P1] 3. 主库安装内部失败时“rolled back”并未实际回滚

位置：`scripts/restore_portfolio_store.py:112-160`

`_install_set()` 只有在 `restore_database()` 成功返回后，才把旧主库的 displaced path 加入回滚列表。但 `restore_database()` 内部先移动旧主库，再安装新主库并做最终 quick check；移动旧库之后的任一步骤都可能抛出异常且不返回 result。

在安装新主库的 `os.replace()` 注入失败后：

```text
restore failed: install failed and was rolled back: simulated failure installing main db
restore_rc 1
target_exists False
displaced_files ['portfolio.db.pre-restore-20260817T102716Z']
```

工具声称已回滚，但活动路径为空，旧数据库只留在 displaced 文件名下。

建议：把主库 staging、displace、install 和 post-check 纳入同一个由 `_install_set()` 管理的 journal；在移动旧库后立即记录回滚信息，并保证任何后续异常都会恢复目标路径。或者让 `restore_database()` 自身提供强异常保证并返回/抛出包含 displaced path 的可恢复状态。补充“main replace 失败”和“main post-install quick_check 失败”两项测试。

### [P1] 4. Restore 的 OS lock 不会阻止运行中后端的普通保存

位置：

- `portfolio_maintenance.py:71-101`
- `scripts/restore_portfolio_store.py:188-227`

`OsMaintenanceLock` 只能与另一个 maintenance 操作互斥。普通 save/load 按设计不取得 maintenance lock，因此一个运行中但当前没有执行 maintenance 的后端不会阻止 restore，且可以在 restore 持锁期间继续写数据库。

最小复现：

```text
restore_lock_acquired True
ordinary_save_while_restore_lock 1
```

所以安全性仍依赖用户正确理解并执行 `--yes` 的“已停止后端”声明，不能实现上一轮要求的“运行中后端 fail closed”。数据库替换与普通保存并发时可能产生丢写、WAL/主文件代际分裂或后端继续访问已移走 inode。

建议：增加由 backend 在整个进程生命周期持有的 runtime/liveness lock，restore 必须独占取得后才可开始；或通过受控的后端 shutdown/maintenance mode 明确停止普通 persistence 请求并等待在途请求清空。短时 maintenance lock 不能充当 backend liveness 检测。

### [P2] 5. Rollover 后的 `copied` batch 仍会永久滞留

位置：

- `portfolio_archive.py:1643-1656`
- `portfolio_archive.py:1771-1788`
- `portfolio_archive.py:2192-2213`

rollover 现在会拒绝封存含 non-terminal batch 的 shard，这对 verified batch 是正确的。但：

- `run_copy_job()` 只 resume 当前选中 shard 的 `copied` batch；
- rollover 会跳过 over-cap、含 copied batch 的旧 shard并创建新 shard；
- commit-stage sweep 只扫描其他 shard 的 `verified` batch。

在 copy 成功、verify 前崩溃后触发 rollover，后续任务会在新 shard 重复制并提交候选，但旧 shard 的 copied batch 永远不会升级：

```text
copied_before_rollover 1
second_archive_id portfolio-archive-2026-002
old_copied_after_rerun 1
old_verified_after_rerun 0
registry [('portfolio-archive-2026-001', 'active'),
          ('portfolio-archive-2026-002', 'active')]
remaining_candidates 0
```

建议：选择新写 shard 前，先对所有 active/unsealed shard 执行统一 reconciler：清理 dead batch、验证 copied batch、提交 verified batch；或者让 sweep 同时处理 copied → verified → commit。只有所有 non-terminal 状态收敛后才能决定 rollover/seal。

### [P2] 6. Trim 后 archive registry 统计保持旧值

位置：

- `portfolio_archive.py:889-947`
- `portfolio_archive.py:2122-2136`

`trim_batch_rows()` 会真实删除 archived revision、更新 batch count/bytes/manifest，但没有同步主库 `workspace_archives` 的 `revision_count`、`logical_payload_bytes` 和 `file_bytes`。`run_copy_job()` 在 commit/trim 之前刷新 registry，之后没有再刷新。

实际结果：

```text
registry_revision_count 9
actual_revision_count 8
registry_payload_bytes 59201
actual_payload_bytes 59005
```

管理页 overview 和后续依赖 registry 的检查会持续显示错误数据，直到用户另行运行 verify job。

建议：trim/commit 完成后在仍持有 guard 时重新计算 shard stats 并更新 registry；跨 shard sweep 中被修改的每个 shard也必须刷新。增加不依赖手工 `run_verify_job()` 的 registry parity 测试。

## 验证结果

### Node 测试

```text
737 passed, 0 failed
```

### 本次变更相关 Python 测试

```text
Ran 203 tests in 5.657s
OK (skipped=1)
```

新增 recovery-set、cross-install、known-missing、maintenance busy、shard-install rollback、undelete trim 和 verified sweep 测试均通过。上述 findings 来自未覆盖的 generation consistency、恢复后再次备份、主库安装内部失败、普通 save 并发、copied crash rollover 和 registry parity 场景。

### Diff 检查

```text
git diff --check 0edf86e^..0edf86e
```

结果：通过，无 whitespace error。

## 建议修复顺序

1. 先实现不可变 recovery generation + completion manifest，并修正 publisher/origin install ID 语义。
2. 让主库安装也具备真实回滚保证，并用 backend lifetime lock 阻止在线 restore。
3. 将所有 active shard 的 copied/verified/dead batch 统一纳入 rollover 前 reconciler。
4. 在 trim/sweep 后刷新 registry 并增加 parity 测试。
