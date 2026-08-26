# 未提交工作区代码(471c093 之上)审查 Findings

- **审查对象**:分支 `codex/portfolio-sqlite-persistence`、HEAD=`471c093` 之上的未提交工作区改动(~1026 行,15 个文件),即针对 `PORTFOLIO_SQLITE_IMPLEMENTATION_REVIEW_471c093.md`(3 P1 + 1 P2)的修复轮。
- **审查日期**:2026-08-17
- **测试基线**:Python 全套 `unittest discover` 通过(exit 0);`node tests/run.js` **737 passed, 0 failed**。
- **范围说明**:diff 中混有另一会话的交易所日历资产戳更新(`chart_lab.html`、`index.html`、`iv_term_structure.html`、`js/official_exchange_calendars.generated.js`、`exchange_calendars/official_exchange_calendars.json`),与本修复轮无关,提交时不应一起 stage。

## 结论

**Request changes。**

上一轮评审的 4 项意见(每代不可变恢复集、只安装已验证 staged 主库、强异常安全回滚、manifest 在 guard 内发布)**逐条核对均为真实修复**,且带回归测试。但这次重构自身引入了 2 个 P1 级回归和多个 P2 缺陷:最严重的是调度备份节流在"有分片缺失"这一系统显式建模的退化状态下完全失效(每次保存全量重发),以及未完成代的分片快照成为无任何清理路径的永久孤儿——两者叠加意味着同步目录无界增长。

本轮发现:**P1:2 条,P2:5 条,P3(架构/清理):3 条。**

---

## P1 Findings

### [P1-1] 调度备份节流失效:任一注册分片缺失时,每次保存都会全量重发整个备份集

位置:`portfolio_store_ws.py:461`(节流检查)、`portfolio_store_ws.py:426`(每次 `save_saved_workspace` 后触发)

节流时间戳从 `store.latest_own_backup_stamp()`(任何本机已发布主库)换成了 `portfolio_archive.latest_complete_recovery_stamp()`(最近一个**完整代**的 manifest)。当任一注册分片的本地文件缺失(registry 显式用 `missing_since_utc` 建模的状态)时,manifest 永远写不出来、时间戳永远不推进,于是:

- 每次 `save_saved_workspace` 都触发 `maybe_publish_scheduled_backup`;
- 间隔检查每次都通过(复现:上一完整代 2 天前 + 分片文件删除,连续 4 次调用全部执行发布);
- 每次都执行完整主库拷贝 + 所有现存分片的全量快照到 OneDrive 目录,且全程持有 maintenance guard(阻塞归档/vacuum 维护)。

旧代码每个 interval(默认 24h)最多重试一次。建议:节流依据"最近一次**发布尝试**"而非"最近一次完整代"(或对失败发布引入类似 `AUTO_ARCHIVE_FAILURE_BACKOFF_SECONDS` 的小时级退避),并把上次扫描结果缓存在 `store_env`,避免每次保存都 glob + JSON 解析同步目录里的全部 manifest。

### [P1-2] 未完成代的分片快照是永久孤儿,没有任何清理路径

位置:`portfolio_archive.py:1366`(`apply_recovery_generation_retention` 只认 manifest 点名的成员)、`portfolio_archive.py:1529`(发布侧)

发布在 `write_recovery_manifest` 之前失败(分片缺失、崩溃、CLI 的 "backup INCOMPLETE" 提前返回)时,已经写入 `archives/<archive_id>-<install>@<gen>.db` 的不可变快照不被任何 manifest 引用:

- 代保留(`apply_recovery_generation_retention`)只删除**已完成 manifest** 点名的成员;
- 主库保留(`_apply_backup_retention`)只匹配备份根目录的主文件名。

复现:3 次失败发布留下 3 个孤儿快照,随后一个完整代 + 保留过程删除 0 个。与 P1-1 叠加 = 每次保存泄漏一整套分片拷贝,同步目录无界增长;单独存在时,每次失败/崩溃的发布也永久泄漏一套。旧版 build 的 `<archive_id>-<install>.db`(无 `@gen`)同样无人清理。建议:保留过程额外扫描 `archives/` 中本 install 的、不被任何现存 manifest 引用且超过宽限期(比如 48h)的快照并删除。

---

## P2 Findings

### [P2-3] freshness 跳过被删除:每一代全量重拷所有分片,默认保留 ≈ 22 代 → 同步存储约 20 倍

位置:`portfolio_archive.py:1529`

每个 generation 对**每个**注册分片(包括已封存、内容不变的)都执行 SQLite backup API + quick_check + 全量拷贝 + manifest 哈希再读。默认 `keep_daily=14` / `keep_weekly=8` 下稳态保留约 22 个完整代。3 个 2GB 封存分片 = 每日上传 6GB 不变数据(持 guard 数分钟)、稳态 ~130GB(旧方案 6GB)。不可变性并不要求新字节:`apply_recovery_generation_retention` 的 protected-set 已支持多个 manifest 共享成员——未变化分片可以在新 manifest 中按名字+哈希引用上一代已验证的既有快照,只有变化的分片才发新文件。

### [P2-4] manifest 发布成功后、保留策略失败 → CLI 把成功备份误报为 rc 1

位置:`scripts/backup_portfolio_store.py:117`(retention 调用)、`:123`(异常边界)

`apply_recovery_generation_retention` 在 manifest 已原子发布**之后**运行,却在同一个 `except (PortfolioStoreError, OSError)` 内。Windows 上 OneDrive/杀软持有旧代成员文件时 `member.unlink()` 抛 `PermissionError`(OSError)→ 输出 `backup failed (store_unavailable)`、rc 1——但这份备份实际完整可恢复。违反文档契约"a failed publish writes no manifest and exits non-zero":运维脚本会对好备份告警并循环重试,每次重试再发一个完整代。建议:manifest 发布成功后的 housekeeping 失败降级为 WARNING + rc 0(或独立的 rc 语义),不与发布失败混用。

### [P2-5] 换入窗口内 Ctrl-C 绕过回滚,且 finally 把预备文件也删掉,活动路径可能悬空

位置:`scripts/restore_portfolio_store.py:341`

回滚边界是 `except Exception`,而 `KeyboardInterrupt` 派生自 `BaseException`:在第一个 `_displace` 之后、swap 循环完成之前 Ctrl-C(OneDrive 上 rename 可能卡数秒,用户中断很现实)→ `_rollback()` 完全不执行,`finally` 却把尚未换入的 `.partial` 预备文件删掉——旧集合滞留在 `.pre-restore-*` 名下、新集合被销毁、活动路径**没有数据库**,与 docstring "ANY later failure rolls the entire old set back" 矛盾。建议:改为 `except BaseException`(重新抛出 KeyboardInterrupt 前先回滚),或在换入窗口屏蔽 SIGINT。

### [P2-6] stamp 数字未验证为真实日期:一个结构合法但日期非法的 manifest 可永久瘫痪调度备份

位置:`portfolio_store_ws.py:465`(strptime)、`portfolio_archive.py:1403`(retention 内 strptime)、`scripts/backup_portfolio_store.py:123`(未捕获 ValueError)

`_BACKUP_FILE_RE` 接受任意 `\d{8}T\d{6}Z`;`_validated_recovery_manifest` 显式加固"同步目录中的畸形文件",却不验证日期数字。一个结构合法、main 名带 `99999999T999999Z`(或 13 月这类)stamp 的 manifest:

- 在 `latest_complete_recovery_stamp` 中按字典序恒为最新 → `datetime.strptime` 抛 `ValueError` → 外层 except 记日志返回 False——**每次保存都失败,直到手工删文件**(已复现);
- 同一 stamp 进入 `apply_recovery_generation_retention` 同样抛错,WS 路径的代退休静默停转;
- 手工 CLI 的边界只捕 `(PortfolioStoreError, OSError)`,`ValueError` 直接裸 traceback 逃出——且发生在 manifest 已写成之后。

建议:`parse_published_backup_name` 内把 stamp `strptime` 一次、失败返回 None;CLI 边界补 `ValueError` 或收敛为统一异常。

### [P2-7] manifest 对"已发布到同步目录的文件"事后取哈希:备份侧 TOCTOU

位置:`portfolio_archive.py:1297`(分片)、`:1307`(主库)

`write_recovery_manifest` 从 OneDrive 管理的备份目录**重新读取**刚发布的成员来计算 sha256/bytes,而不是用本地 staging 的已验证字节。同步客户端在 `os.replace` 与哈希之间就地改写文件(冲突合并/部分水合)时,manifest 会把外来字节钉为该代的"正宗内容",restore 全部校验通过后照常安装——这正是本轮在 restore 侧修掉的"验证对象与安装对象不是同一份字节"的备份侧同型问题。建议:在现有拷贝循环中对 staging 字节边拷边哈希,把 `{name: (sha256, bytes)}` 传入 `write_recovery_manifest`(顺带消除对慢速同步存储的整套全量重读,与 P2-3 的哈希成本合并解决)。

---

## P3 Findings(架构/清理)

### [P3-8] manifest 主库保护的不变量放在调用方而不是删除方

位置:`portfolio_store.py:1453`

`_apply_backup_retention` 是否吞掉完整代的主库,取决于每个调用者是否记得把 `manifest_preserved_mains()` 穿进 `publish_backup(preserve_names=…)`(endurance 测试已经在裸调)。任何未来的裸 `publish_backup()` 调用(admin 页"立即备份"、新脚本)都会在 keep 窗口过后删掉 manifest 点名的主库——正是本轮修复的"最后完整代死亡"P1 的复活路径。保护集应在删除方内部计算。

### [P3-9] 发布流水线在两个发布者中手工复制,失败语义已经分叉

位置:`portfolio_store_ws.py:471` vs `scripts/backup_portfolio_store.py:80-121`

mint id → preserved mains → publish_backup → publish_archive_backups → 完整性检查 → write_recovery_manifest → generation retention 的整条编排在两处各写一份:WS 路径用 `except Exception` 吞掉 manifest/retention 失败、只看 `missing`;CLI 额外做一遍冗余的 "unconfirmed" registry 重扫(手工拼接分片文件名语法——该语法已在 `portfolio_archive.py:1246/1288/1528` 存在三份)并 fail closed。guard 作用域目前只是"行序恰好正确"。建议:抽一个 `portfolio_archive.publish_recovery_generation()`,两个发布者只包裹各自的报告/退出码;分片快照命名收敛为一个导出 helper。

### [P3-10] 两个死 API 保留着恰好是本轮修掉的错误语义

位置:`portfolio_archive.py:1344`(`manifest_preserved_main` 单数,零调用者)、`portfolio_store.py:1373`(`latest_own_backup_stamp`,仅测试引用)

单数版本只保护"字典序最后一个 manifest"的主库(N 代中只保 1 个);`latest_own_backup_stamp` 把未完成代的主库当作新鲜度。未来调用者伸手拿这两个自然名字,就把本轮修复的 bug 重新引入。建议:删除两者,`tests/portfolio_store_test.py:690` 改指向新 API。

---

## 上一轮(REVIEW_471c093)4 项意见的逐项核对

| Review 项 | 本次未提交代码状态 | 验证结论 |
|---|---|---|
| P1:恢复文件按 install 覆盖,非按代不可变 | **已修复(引入新回归)** | `@<generation-id>` 进入主库/分片/manifest 文件名,只创建不覆盖,按完整代整体退休;format-1 兼容与同秒 tie-break 有测试。但见本轮 P1-1/P1-2/P2-3。 |
| P1:验证 staged main、安装原始可变文件 | **已修复** | 先拷贝后哈希(TOCTOU 顺序修正),`_install_set` 只安装 staged 副本经目的地本地临时文件换入;源漂移注入测试通过。备份侧同型问题仍在(P2-7)。 |
| P1:journal 漏部分写入与 `sqlite3.Error` | **已修复(边界仍留 BaseException 缺口)** | 预备-验证-换入三段式,`except Exception` 统一回滚,部分拷贝/中途 rename/SQLite 错误注入测试通过。见 P2-5。 |
| P2:manifest 在 guard 释放后写入 | **已修复** | manifest + retention 全部移入 guard 的 try 内,带探针测试。 |

## 验证记录

- 8 角度并行审查(3 正确性 + 复用/简化/效率/altitude;无 CLAUDE.md,conventions 空过),候选去重后 1-vote 验证。
- P1-1、P1-2、P2-6 由 finder 以临时脚本确定性复现;P2-4、P2-5、P2-7 由代码构造性验证(标 PLAUSIBLE 的为现实可达但依赖环境时序)。
- 全量测试:Python `unittest discover` OK(throwaway venv),`node tests/run.js` 737 passed / 0 failed。

## 最终判定

不宜按现状提交。至少应先完成 P1-1(节流/退避)与 P1-2(孤儿快照回收);P2-3 的存储放大建议在提交前一并决策(共享未变分片成员 vs 接受成本并缩小 keep 窗口),其余 P2 可与之同轮修复。

---

## 复核记录(2026-08-18)

对修复后的工作区(仍未提交,471c093 之上,总 diff 增至 ~1896 行)逐项验证。**10 项全部修复**,两套测试全绿(Python `unittest discover` exit 0;`node tests/run.js` 737 passed / 0 failed)。

| 项 | 状态 | 修复方式与回归测试 |
|---|---|---|
| P1-1 节流失效 | ✅ 已修复 | 节流改为"最近一次**尝试**"(成败均计):进程内 `_last_backup_attempt_epoch` 缓存(冷启动由 `latest_recovery_attempt_epoch` 从主库文件名种子化),尝试时间在任何 I/O 之前记录,失败/不完整代享受同样的 interval 退避。`test_incomplete_generation_is_throttled_and_leaves_no_shard_orphans` |
| P1-2 孤儿快照 | ✅ 已修复 | 三重防护:发布前全 registry 预检(已知缺失 → 一个分片字节都不发布);`_discard_uncompleted_generation` 在不完整/中断时立即删除本次尝试的成员(`except BaseException` 内先查磁盘上的完成标记,已完成的代绝不误删);`cleanup_orphan_archive_snapshots`(48h 宽限)在每次发布前后清扫无 manifest 引用的本机快照,含旧版 `<id>-<install>.db` 命名。`test_orphan_cleanup_handles_generation_and_legacy_names`、`test_failed_publish_cannot_pair_new_main_with_old_shards` |
| P2-3 全量重拷/存储放大 | ✅ 已修复 | manifest format 3:`ArchiveShard.recovery_fingerprint()` 哈希有序逻辑元数据(payload 由行内 `payload_sha256` 绑定,不重读 payload 字节),未变化分片按 `sourceFingerprint` 复用最新完整代的不可变成员;代保留的 protected-set 保护被保留 manifest 引用的共享成员,且先撤销退休 manifest 再删成员。`test_unchanged_shard_is_shared_until_its_logical_state_changes` |
| P2-4 rc 1 误报 | ✅ 已修复 | `publish_recovery_generation` 把发布失败与发布后 housekeeping 分离:retention/清扫失败进 `housekeepingWarnings`,CLI 打 WARNING 且完整代仍 rc 0。`test_housekeeping_failure_is_warning_after_complete_manifest` |
| P2-5 Ctrl-C 绕过回滚 | ✅ 已修复 | `_install_set` 边界改为 `except BaseException`:先 `_rollback()`,非 Exception(KeyboardInterrupt 等)回滚后重新抛出。`test_keyboard_interrupt_mid_swap_rolls_back_before_reraising` |
| P2-6 非法 stamp ValueError | ✅ 已修复 | `parse_published_backup_name` 内 `strptime` 校验、非法返回 None;所有消费方按解析出的 `publishedAtUtc` datetime 排序,不再对原始字符串二次 strptime;`latest_recovery_attempt_epoch` 额外忽略未来时间戳(时钟偏移防护)。`test_invalid_calendar_stamp_is_not_an_attempt_or_manifest` |
| P2-7 备份侧 TOCTOU | ✅ 已修复 | `_publish_backup_artifact` / `_copy_verified_artifact` 在拷贝 staging 字节时边拷边哈希并返回 `{name, sha256, bytes}`;`_write_recovery_manifest` 只接受这些已验证 artifact(并校验身份),不再重读已发布文件(顺带消除全量重读)。`test_manifest_keeps_digest_of_verified_staging_bytes` |
| P3-8 preserve_names 在调用方 | ✅ 已修复 | `preserve_names` 参数删除;`apply_backup_retention` 内部调用 `_manifest_protected_backup_names()`,任何调用方(含裸 `publish_backup()`)自动保护 manifest 点名的主库。`test_standalone_retention_cannot_delete_manifest_main` |
| P3-9 双发布者流水线复制 | ✅ 已修复 | `portfolio_archive.publish_recovery_generation()` 成为唯一编排入口,两个发布者只包裹报告/退出码;分片命名语法收敛到 `recovery_archive_snapshot_name()` / `_parse_archive_snapshot_name()`。结构性测试 `test_publishers_only_call_the_unified_orchestrator` |
| P3-10 死 API | ✅ 已修复 | `manifest_preserved_main`、`manifest_preserved_mains`、`PortfolioStore.latest_own_backup_stamp` 全部删除(全仓 grep 零引用),测试改指新 API。 |

复核结论:**Findings 全部关闭,可以提交。**(提交时仍注意不要 stage 无关的交易所日历资产戳文件。)
