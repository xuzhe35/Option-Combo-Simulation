# FOP COST_BASIS：P2 第一轮代码审查与证据

审查日期：2026-09-24。状态：**发现 7 项待修问题，P2 暂不建议验收；本文不是修复完成记录。**

## 1. 审查对象与边界

- 被审查分支：`feat/cost-basis-fop-p2`。
- 基线提交：`330cad52656938e69a2491af954978a7a4ad70ff`（P1）。对象为该基线之上的 P2 未提交改动，包括新增但未跟踪的 FOP 模块。
- 本文位于主工作区；代码位置、运行结果及结论均针对上述 P2 checkout，不能把主分支上的旧文件当成同一版本。末尾附关键文件 SHA-256，防止后续修订与本轮结果混淆。
- 依据：`CODE PLAN/COST_BASIS_FOP_STANDALONE_PLAN.md` §8.1、§8.2、§8.3、§13.3 的 P2 步骤；同时核对 P1 契约及 `CODE PLAN/COST_BASIS_FOP_VALIDATION.md` 的 P2 验收声明。
- 本轮仅审查，没有修改业务代码、提交或推送；补充复现全部使用临时 SQLite 数据库，没有打开真实账本或连接 TWS。
- P2 仅负责结构、权限、关系和事务，完整经济回放及 CSV 导入分别属于后续 P3/P4。以下问题均出在已经实现的 P2 路径，不以尚未完成的后续功能作为缺陷。
- 所有补充场景使用合成测试数据，不代表真实 IBKR CSV 格式已经验收。测试用 `fop_writes_enabled=True` 显式开启临时 store，生产默认关闭的状态保持不变。

## 2. 结论与问题清单

迁移前一致备份、v11 父表重建、独立 FOP 存储模块以及正式写入默认关闭的方向可以保留。但现有测试通过并未覆盖恢复、修订、重试之间的组合行为。

下表 P1/P2 是**审查优先级**，不是施工阶段；R1–R7 是本次审查编号。

| 编号 | 优先级 | 问题 | 实测证据 |
| --- | --- | --- | --- |
| R1 | P1 | 经济内容改变后账本版本可能不变 | 点值 1000 → 500 后恢复，版本未变，旧版本写入仍成功 |
| R2 | P1 | 恢复未验证完整关系图和来源分配 | 悬空绑定恢复成功；声明 1 张却分配 99 张也成功 |
| R3 | P1 | 合约补全可制造重复的真实合约 | 补全 tradingClass 后存在两条相同结构身份的当前记录 |
| R4 | P1 | 一条来源分配给多事件被旧唯一索引阻断 | 合法的 2 张来源拆为 1 + 1 张，第二条写入报重复 |
| R5 | P2 | 恢复重试未绑定原始载荷 | 同 token 换另一份备份，仍返回幂等成功但未应用新内容 |
| R6 | P2 | 引擎版本保护未覆盖全部写路径 | v1 实现成功冲销 engineVersion=2 账本的事件 |
| R7 | P2 | 合约修订破坏原追加请求的幂等重试 | 追加 → 合约 revision=2 → 原请求重试，被误报不同载荷 |

建议先修 R1–R4，再补齐 R5–R7 的统一写入/幂等保护；以下验证用例应纳入正式测试后，再关闭 P2 验收。

## 3. 逐项意见、证据与验收要求

### R1 — 经济内容改变后，账本版本可能不变（P1）

**位置：** `cost_basis_fop_store.py:1795–1821`，重点为 `1801–1809` 的 `_fop_digest_lines`；共同依赖 `cost_basis_store.py` 的 `_ledger_version`。

**原因：** FOP 摘要主要纳入事件引用 ID、合约/绑定修订号、周期和操作记录。合约实际条款、事件的完整经济和时间事实没有直接纳入。原账本恢复保留原图 ID，因此“不同内容、相同 ID/修订号”可以得到同一版本。

**复现：**

1. 临时 FOP 账本追加一笔 CLZ6，保存 `ledgerVersion` 并导出 v2 备份。
2. 将备份合约的 `futurePointValue` 从 1000 改为 500，按正式格式重算备份 SHA-256。
3. 通过 `restore_backup` 恢复到原账本。
4. 比较版本，再用步骤 1 的旧版本追加另一笔事件。

**实际输出：**

```text
DIGEST: point value 1000 -> 500, version unchanged = True
DIGEST: write with stale version accepted = True
```

这不是绕过文件校验和：重新计算校验和是为了单独检验载荷合法性、恢复后的版本变化和并发保护。文件校验和只能检查内容一致性，不能替代账本版本保护。

**影响及建议：** 旧预览依赖的经济含义已经变化，却仍被视为当前版本。FOP 摘要应覆盖决定经济含义和证据关系的完整内容，或通过不可复用的变更版本保证恢复会使旧预览过期；不要改变 STK 已冻结的摘要行为。

**修复验收：** 至少覆盖点值、事件经济字段、经济时间事实变化后的恢复；不能出现“变化被接受但版本相同”。被接受的变化后，持旧 `expectedLedgerVersion` 的后续写入必须拒绝。合法备份往返仍应满足明确的版本语义。

### R2 — 恢复没有验证完整关系图和来源分配（P1）

**位置：** `cost_basis_fop_store.py:1177–1371` 的 `_load_fop_graph`，重点为 `1221–1250` 的来源/事件检查及后续绑定写入。

**原因：** 恢复会校验事件实际用到的合约和交割绑定，但没有对图中每条绑定统一校验其目标。来源方面只核对账户等信息，没有复用写包的数量/费用分配上限。部分关系没有数据库外键，`PRAGMA foreign_key_check` 无法补足这些域约束。

**两组独立复现：**

- 创建期权成交、FUT/FOP 合约及尚未用于交割的合法绑定；导出备份，将该绑定的 `futureContractId` 改为不存在的 ID，重算校验和后恢复。
- 创建一笔来源声明数量 1、分配数量 1 的成交；导出备份，将分配数量改为 99，保持来源声明为 1，重算校验和后恢复。

**实际输出：**

```text
RESTORE DANGLING: accepted missing-future-0001
RESTORE ALLOCATION: accepted quantity=99 with statedQuantity=1
```

**影响及建议：** 恢复入口能够写入普通追加入口应拒绝的坏图。应在同一事务内验证全部绑定、修订引用、合约身份、来源和分配；历史/未被活动事件引用的记录也不能逃过关系检查。不要仅以“当前事件可回放”和外键检查作为整图有效的证明。

**修复验收：** 上述两组均应拒绝，并断言所有表、账本版本和 token 状态不变；另覆盖费用超分配、错误合约类型、跨账本引用及未被事件引用的关系记录。有效关系图必须继续可以完整往返。

### R3 — 合约补全可制造重复的真实合约（P1）

**位置：** `cost_basis_fop_store.py:970–975`，`_op_correct_contract` 的冲突检查。

**原因：** 新增合约路径检查 `contract_identity_key`，修订路径只检查 `conId`，两条入口对“一个真实合约一条当前记录”的要求不一致。

**复现：**

1. 建立两条同根、同交易所、同币种、同交割月的 FUT 记录，二者 `conId` 都为空。
2. 第一条 `tradingClass=null`，第二条 `tradingClass=CL`，分别录入持仓。
3. 用合法的 `correct_contract` 把第一条补全为 `tradingClass=CL`，并提交准确的受影响事件清单。

**实际输出：**

```text
CORRECTION IDENTITY: accepted two current records for the same structure
```

**影响及建议：** 两条 ID 已经代表同一真实期货，但数量仍按各自 `contractId` 分开，后续回放和对账可能错误拆分持仓。合约修订应复用新增路径的结构唯一性检查，排除自身后检查所有当前记录；发生碰撞时拒绝并要求显式处理，不能默默合并或重复保存。

**修复验收：** 对 FUT/FOP 分别覆盖补全后结构碰撞，尤其是 `conId` 为空的情况；失败必须回滚新修订、引用变动和操作记录。正常补全继续成功。

### R4 — 一条来源分配到多事件仍被旧唯一索引阻断（P1）

**位置：** `cost_basis_fop_domain.py:387–393`；对应共享表唯一索引为 `cost_basis_store.py:439–441` 的 `idx_cost_basis_events_external`。

**原因：** 每个事件把主来源投影为同一 `namespace:sourceRef`，共享表仍对 `(book_id, account, external_ref)` 保持唯一。一条来源即使通过新的分配关系合法拆成多事件，公共事件表也不允许这些行同时存在。

**复现：** 通过已经实现的 `rebuild_fop_book`，提交一条 `tws_exec` 来源：声明 2 张、费用 4.04；分配给两条各 1 张、费用各 2.02 的 FUT 事件。两条事件时刻不同，数量和费用完全守恒。

**实际输出：**

```text
SOURCE SPLIT: InvalidRequestError externalRef has already been imported
```

这是合成来源测试，证明存储能力缺口，不宣称某种 IBKR 汇总行格式已实现；也不是把 P4 未完成的 CSV 解析当作 P2 缺陷。

**影响及建议：** 计划 §8.1 要求的一条来源分配到多个事件尚不能落库。FOP 的来源去重应由来源记录及分配关系负责，与事件自身唯一标识分开；兼容保留 STK 原规则，不应简单删除所有账本的旧唯一索引。

**修复验收：** 1→多事件合法分配在真实 store 成功；超额数量/费用拒绝；重复提交不新增事件；作废后仍保留来源消费证据；任一中途失败整批回滚。

### R5 — 恢复重试没有绑定原始载荷（P2）

**位置：** `cost_basis_fop_store.py:1471–1475`，另见 `_reset_replay`（1405 起）及清空路径对它的调用。

**原因：** 恢复找到同 `clientToken` 的存档后直接返回成功，没有比较操作种类、备份内容摘要或 `resetId`。清空与恢复共用该查询；清空路径也没有独立保存完整请求指纹。这一共同路径的范围来自代码检查，下面直接实测的是备份恢复。

**复现：** 第一次用某个 token 恢复 FUT 成交价为 70.12 的备份；第二次复用同 token，提交成交价改为 99 且校验和正确的另一份备份。

**实际输出：**

```text
RESTORE TOKEN: changed backup accepted as replay = True price still = 70.12
```

**影响及建议：** 客户端收到成功，却没有得到其提交的恢复内容。应持久化操作种类、原始载荷指纹和原结果；相同 token 只有在对应同一请求时才可幂等返回。

**修复验收：** 同 token 换备份、换 resetId、换操作种类或变更有效参数都拒绝；完全相同的重试返回原结果、不重复存档；拒绝时不消费新 token 或改变任一表。

### R6 — 引擎版本保护没有覆盖全部写路径（P2）

**位置：** `cost_basis_fop_store.py:223–237` 的 `_get_fop_writable_book`，及冲销、元数据提交、清空等调用路径；相关请求类型位于 `cost_basis_fop_protocol.json`。

**原因：** 公共门禁只检查账本类型、FOP 元数据是否存在及发布开关。`check_write_guard` 的引擎检查在追加、重建等部分路径中调用，不能保证全部写入经过同一版本保护。

**复现：** 在临时库建立一笔事件后，直接把 FOP 元数据的 `engine_version` 设为 2，模拟较新版本创建的账本；继续使用当前 v1 store 的 `void_fop_event`。

**实际输出：**

```text
ENGINE: v1 code voided v2 ledger successfully
```

这里的直接 SQL 仅用于构造不受当前引擎支持的测试元数据，不是正常用户写入方式。生产发布开关仍关闭；本问题针对 P2 应建立的版本隔离边界。

**影响及建议：** 当前引擎能改变其不支持的账本。应在事务内统一检查账本引擎/规则支持情况，并让需要客户端版本声明的协议载荷显式携带该信息。不能只凭一个追加路径的测试就宣称“所有写路径均检查版本”。

**修复验收：** 按写动作逐项覆盖缺失/错误版本、账本版本不受支持、身份错误和旧预览；特别包含冲销、元数据提交、清空、恢复。拒绝后验证整库未变。

### R7 — 合约修订会破坏原追加请求的幂等重试（P2）

**位置：** `cost_basis_fop_store.py:673–687`，`_replay_fop_append`。

**原因：** 重试重新按照当前关系图验证原始请求，且与已经修订过的事件引用作比较，而不是核对首次提交的固定请求指纹。

**复现：**

1. 用固定 token 追加一笔引用 revision=1 的 FUT 事件；合约的 conId/localSymbol 尚为空。
2. 用合法 `correct_contract` 补全合约，升为 revision=2，并迁移该事件的引用。
3. 用步骤 1 完全相同的 token 和原载荷重试追加。

**实际输出：**

```text
APPEND RETRY AFTER CORRECTION: InvalidRequestError clientToken was already used for a different event: contract fut-clz6-0001 revision 1 was superseded by revision 2; reload and reference the current one
```

**影响及建议：** 已成功请求在后续正常元数据修改后失去可重试性，客户端可能被引导使用新 token 再次记账。应独立保存首次请求指纹及必要的原结果；识别幂等重试时不依赖后续可变的关系状态。

**修复验收：** “追加 → 合约补全 → 原请求重试”必须识别为幂等且不新增事件；另覆盖绑定修订及相关状态变化。同 token 真正改变载荷仍必须拒绝。

## 4. 本轮实际执行的回归

命令均在被审查的 P2 checkout 根目录执行。表中 `<venv>/python` 指项目已配置的 Python 解释器，不应照抄为实际文件名；Python 命令使用 `PYTHONDONTWRITEBYTECODE=1`。

| 检查 | 命令 | 实际结果 |
| --- | --- | --- |
| 全部前端测试 | `node tests/run.js` | 1238 通过，0 失败 |
| 成本账本 Python | `PYTHONPATH=. <venv>/python -m unittest discover -s tests -p 'cost_basis*_test.py'` | 409 项：407 通过、2 跳过，0 失败 |
| FOP Python 专项 | `PYTHONPATH=. <venv>/python -m unittest discover -s tests -p 'cost_basis_fop_*_test.py'` | 85 通过，无跳过 |
| P2 阶段运行器 | `node tests/run_cost_basis_fop.js --stage P2` | Node 29 通过，0 失败；另列出需分别执行的 Python 6 套件、85 项 |
| 资源版本 | `python3 scripts/stamp_asset_versions.py --check` | `asset versions are current` |
| 差异格式 | `git diff --check` | 通过 |

FOP 专项属于成本账本 Python 集合，不能把 85 再加到 409 上。P2 运行器列出的 Python 用例不是由 Node 执行，本轮已另外实际运行。

关键原始结果摘录：

```text
1238 passed, 0 failed

Ran 409 tests in 13.483s
OK (skipped=2)

Ran 85 tests in 1.117s
OK

29 passed, 0 failed (node, through P2)
```

本轮没有重新执行全仓 Python `*_test.py`、浏览器验收或真实 TWS 会话，因此不沿用验证文档中的全仓 1083 项结果作为本轮证据。R1–R7 的补充脚本尚未登记为正式回归；上述通过数不包含它们，也不意味着这些问题已经修复。

## 5. 可重复执行的补充证据

以下脚本将本轮两个临时复现脚本合并为一份，去掉第二份对第一份的导入，其余场景逻辑保持一致。它依赖被审查版本的 `tests/cost_basis_fop_test_support.py` 和 `tests/cost_basis_fop_store_test.py`，只创建并清理临时数据库，不启动后端。

在 P2 checkout 根目录，把代码块保存为临时 `fop_p2_review_probes.py`，用项目配置的解释器执行；POSIX 示例：

```sh
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=.:tests <venv>/python /path/to/fop_p2_review_probes.py
```

这是用于观察旧版错误行为的诊断脚本，并非“修复后全部输出相同就通过”的验收测试。修复后应把对应期望转成正式断言；部分目前会成功的错误操作届时应拒绝，脚本也可能因此提前退出。正式关闭条件见逐项的“修复验收”。

```python
import copy, hashlib, json, pathlib, tempfile
from cost_basis_fop_test_support import FopLedger, CLZ6, LOZ6, MANUAL_BINDING, IDENTITY, token, package
from cost_basis_fop_store_test import fut_trade, short_call, assignment, tws
from cost_basis_fop_domain import canonical_json


def restore(ledger, backup, tok=None):
    plan=ledger.store.reset_confirmation(ledger.book_id)
    return ledger.store.restore_backup(ledger.book_id, backup, confirmation=plan['phrase'],
        client_token=tok or token(), expected_ledger_version=plan['ledgerVersion'], book_identity=IDENTITY)

def seal(backup):
    backup['sha256']=hashlib.sha256(canonical_json(backup['payload']).encode()).hexdigest()
    return backup

def commit(ledger, operation):
    return ledger.store.commit_fop_metadata(ledger.book_id, operation, client_token=token(),
        expected_ledger_version=ledger.version(), book_identity=IDENTITY)

with tempfile.TemporaryDirectory(prefix='p2-review-') as d:
    count=0
    def fresh():
        global count
        count+=1
        return FopLedger(pathlib.Path(d)/f'{count}.db')

    l=fresh()
    e,s=tws(fut_trade(), 'exec-summary-0001', 1, 2.02)
    s['statedQuantity']=2; s['statedFees']=4.04
    e2=copy.deepcopy(e); e2['time']['executedAtUtc']='2026-10-01T14:30:06.000000Z'
    p=l.store.reset_confirmation(l.book_id)
    try:
        l.store.rebuild_fop_book(l.book_id,package(e,e2,contracts=[CLZ6],sources=[s]),
            confirmation=p['phrase'], client_token=token(), import_batch_id=token(),
            expected_ledger_version=p['ledgerVersion'],book_identity=IDENTITY)
        print('SOURCE SPLIT: accepted')
    except Exception as ex:
        print('SOURCE SPLIT:',type(ex).__name__,str(ex))

    l=fresh(); l.append(fut_trade(),contracts=[CLZ6])
    version=l.version(); b=l.store.export_backup(l.book_id)
    b['payload']['contracts'][0]['record']['futurePointValue']=500
    restore(l,seal(b))
    print('DIGEST: point value 1000 -> 500, version unchanged =', l.version()==version)
    stale=l.append(fut_trade('2026-10-02T14:30:05.000000Z'),expected=version)
    print('DIGEST: write with stale version accepted =',not stale['idempotentReplay'])

    l=fresh(); l.append(short_call(),contracts=[LOZ6,CLZ6],bindings=[MANUAL_BINDING])
    b=l.store.export_backup(l.book_id)
    b['payload']['bindings'][0]['futureContractId']='missing-future-0001'
    try:
        restore(l,seal(b))
        print('RESTORE DANGLING: accepted',l.store.export_backup(l.book_id)['payload']['bindings'][0]['futureContractId'])
    except Exception as ex:
        print('RESTORE DANGLING:',type(ex).__name__,str(ex))

    l=fresh(); l.append(fut_trade(),contracts=[CLZ6]); b=l.store.export_backup(l.book_id)
    tok=token(); first=restore(l,b,tok)
    changed=copy.deepcopy(b); changed['payload']['events'][0]['row']['price']=99
    again=restore(l,seal(changed),tok)
    print('RESTORE TOKEN: changed backup accepted as replay =',again['idempotentReplay'], 'price still =',l.events()[0]['price'])

    l=fresh(); ev=l.append(fut_trade(),contracts=[CLZ6])['event']
    conn=l.store._connect(); conn.execute('UPDATE cost_basis_fop_books SET engine_version=2 WHERE book_id=?',(l.book_id,));conn.close()
    try:
        l.void(ev['eventId'])
        print('ENGINE: v1 code voided v2 ledger successfully')
    except Exception as ex:
        print('ENGINE:',type(ex).__name__,str(ex))

    l=fresh(); old=dict(CLZ6,conId=None,localSymbol=None); tok=token()
    original=l.append(fut_trade(),contracts=[old],client_token=tok)['event']
    commit(l, {'kind':'correct_contract','contract':dict(CLZ6,revision=2),
        'affected':[{'eventId':original['eventId'],'reference':'contract',
        'before':{'id':CLZ6['contractId'],'revision':1},'after':{'id':CLZ6['contractId'],'revision':2}}]})
    try:
        again=l.append(fut_trade(),contracts=[old],client_token=tok)
        print('APPEND RETRY AFTER CORRECTION: replay =',again['idempotentReplay'])
    except Exception as ex:
        print('APPEND RETRY AFTER CORRECTION:',type(ex).__name__,str(ex))

with tempfile.TemporaryDirectory(prefix='p2-review-graph-') as d:
    l=FopLedger(pathlib.Path(d)/'a.db')
    e,s=tws(fut_trade(),'exec-review-001',1,2.02)
    l.append(e,contracts=[CLZ6],sources=[s])
    b=l.store.export_backup(l.book_id)
    b['payload']['allocations'][0]['quantity']=99
    try:
        restore(l,seal(b))
        print('RESTORE ALLOCATION: accepted quantity=99 with statedQuantity=1')
    except Exception as ex: print('RESTORE ALLOCATION:',type(ex).__name__,str(ex))

    l=FopLedger(pathlib.Path(d)/'b.db')
    ca=dict(CLZ6,conId=None,tradingClass=None,localSymbol=None)
    cb=dict(CLZ6,contractId='future-duplicate-001',conId=None,localSymbol=None)
    ea=l.append(fut_trade(),contracts=[ca])['event']
    eb=l.append(fut_trade('2026-10-02T14:30:05.000000Z',contractRef={'contractId':cb['contractId'],'revision':1}),contracts=[cb])['event']
    op={'kind':'correct_contract','contract':dict(ca,revision=2,tradingClass=cb['tradingClass']),
        'affected':[{'eventId':ea['eventId'],'reference':'contract',
        'before':{'id':ca['contractId'],'revision':1},'after':{'id':ca['contractId'],'revision':2}}]}
    try:
        commit(l,op)
        print('CORRECTION IDENTITY: accepted two current records for the same structure')
    except Exception as ex: print('CORRECTION IDENTITY:',type(ex).__name__,str(ex))
```

被审查版本的完整输出（R2 有两组独立证据）：

```text
SOURCE SPLIT: InvalidRequestError externalRef has already been imported
DIGEST: point value 1000 -> 500, version unchanged = True
DIGEST: write with stale version accepted = True
RESTORE DANGLING: accepted missing-future-0001
RESTORE TOKEN: changed backup accepted as replay = True price still = 70.12
ENGINE: v1 code voided v2 ledger successfully
APPEND RETRY AFTER CORRECTION: InvalidRequestError clientToken was already used for a different event: contract fut-clz6-0001 revision 1 was superseded by revision 2; reload and reference the current one
RESTORE ALLOCATION: accepted quantity=99 with statedQuantity=1
CORRECTION IDENTITY: accepted two current records for the same structure
```

## 6. 被审查文件指纹

以下摘要对应审查时的未提交内容，用于定位这一轮代码，不是文件应长期保持不变的要求。修复后行号和摘要会变化，应另追加复核结果，保留本轮历史证据。

| 文件 | SHA-256 |
| --- | --- |
| `cost_basis_fop_store.py` | `0329639bd8aa771a7ff4ff4bf2de11bccbdcd76b956e5416462ca9415ce2509a` |
| `cost_basis_fop_domain.py` | `90dd963271e852d6734c0a159d69fc2cc73e30c2bd218943f80ed67d7c90168e` |
| `cost_basis_fop_protocol.json` | `d1a48e0e5b6d62b77de1744b3b406d67c40d112a0b07bf55b856b97f702d32ca` |
| `cost_basis_store.py` | `146aebd923b23ab5fed3b6afb7778d9ce6e76aaffdfa09f62d15773ceaa03f05` |
| `cost_basis_ws.py` | `d2bf254b46493166a74378bf79dadba10073fa477ea76a1f01f10a3d957f32ad` |
| `tests/cost_basis_fop_store_test.py` | `50804f340ab3efdc80c88f1e3ee85b68c782c4df78d5b97bac819f61e1bdf829` |


## 7. 修复后复核（2026-09-24）

**本轮结论：R1–R7 的原始复现场景均已通过，修复有效；进一步检查发现 R8–R11 四项备份恢复问题，P2 暂不建议完全验收。** 第 1–6 节保留第一轮审查的历史状态与证据；本节及后续内容记录修复后的状态，不能将原报告输出当作当前代码的表现。

复核对象仍为 `feat/cost-basis-fop-p2` 分支、基线 `330cad52656938e69a2491af954978a7a4ad70ff` 之上的未提交代码。行号对应本轮文件，指纹见第 11 节。本轮只审查并追加文档，没有修改业务代码、提交或推送；补充验证全部使用临时 SQLite 数据库及合成数据，没有访问真实账本或连接 TWS。

### 7.1 原审查项修复情况

针对原 R1–R7 的独立断言脚本执行了 8 项测试（R2 两项），全部通过。以下“通过”仅指原问题的复现场景及本轮检查，不代表相关子系统已无其他缺陷。

| 原编号 | 本轮实测结果 | 修复判断 |
| --- | --- | --- |
| R1 | 恢复点值 1000 → 500 后版本改变，持旧版本的追加被拒绝 | 原场景通过；摘要已覆盖图中的内容字段 |
| R2 | 未被事件使用的悬空绑定、数量 1 却分配 99 的备份均被拒绝 | 原两场景通过；完整图约束仍有 R9 遗漏 |
| R3 | 合约补全后与另一当前合约的结构身份冲突，被拒绝 | 原场景通过；修订已加入结构身份检查 |
| R4 | 一条数量 2 的来源分配为两条数量 1 的事件，可成功写入 | 原场景通过；来源拆分不再被旧唯一索引直接阻断 |
| R5 | 同一恢复 token 换另一份内容的备份，被拒绝 | 原场景通过；请求摘要绑定恢复载荷 |
| R6 | v1 实现冲销 engineVersion=2 账本，被拒绝 | 原场景通过；写入门禁已集中校验引擎/产品规则 |
| R7 | 合约修订后，原追加请求同 token 重试返回首次结果，不新增事件 | 原场景通过；新请求日志保证原库内的重放，但跨库恢复仍有 R11 |

修复实现增加了整图检查、合约身份冲突检查、统一写入保护，以及保存 action、请求摘要和首次结果的 `cost_basis_fop_requests`。这些修改解决了原报告的主要问题，应保留。剩余问题集中在恢复入口的元数据、关系约束及证据往返完整性。

### 7.2 本轮剩余问题

下表 P1/P2 仍指审查优先级，不是施工阶段。R8–R11 延续原报告编号。

| 编号 | 优先级 | 问题 | 实测结果 |
| --- | --- | --- | --- |
| R8 | P1 | 恢复忽略备份的 `historyScope` | 原样导出的 `since_baseline` 备份恢复成功，目标仍标为 `full_history` |
| R9 | P2 | 恢复可绕过当前 closed 周期锚点唯一性 | 普通入口拒绝重复锚点，恢复入口却接受两个当前 closed 周期 |
| R10 | P2 | 原样备份往返改变主来源 namespace | `tws_exec:shared-reference-001` 变为 `ib_exec:shared-reference-001`，账本版本也改变 |
| R11 | P2 | 请求日志未随备份恢复，破坏原请求重试 | 全新数据库恢复后，完全相同的追加请求被误报 token 已被另一写入使用 |

## 8. 剩余问题的证据与修复验收

### R8 — 备份恢复丢失历史覆盖范围语义（P1）

**位置：** `cost_basis_fop_store.py:1203–1209`，`_load_fop_graph` 读取备份元数据后，仅对比 `engineVersion`、`productRules`，没有恢复或拒绝不匹配的 `historyScope`。

**复现：**

1. 在临时源库正常创建 `historyScope='since_baseline'` 的 FOP 账本，追加一条 FUT 事件。
2. 正常导出 v2 备份，保持备份原样，不改任何字段或校验和。
3. 在另一临时库创建相同账户、根品种和起始日期、但 `historyScope='full_history'` 的目标账本。
4. 通过正式恢复入口恢复，允许跨 bookId 的 ID 重映射；读取目标账本元数据。

**实际输出：**

```text
Unmodified backup historyScope: since_baseline
Restore success: 1 events; remapped: True
Restored book historyScope: full_history
```

**影响及建议：** 恢复后的事件来自仅覆盖基线之后历史的账本，却被标记为完整历史。这会使后续成本展示和历史完整性判断建立在错误前提上。恢复应在同一事务中采用备份的历史范围，或者明确拒绝范围不一致的目标；不得成功返回但保留错误标识。本项不依赖人为修改备份。

**修复验收：**

1. 将以上“正常创建 → 原样导出 → 跨库、跨 bookId 恢复”纳入测试，覆盖 `since_baseline` 与 `full_history` 两个方向。
2. 若选择恢复元数据，断言恢复后的 `historyScope` 与备份一致，导出往返仍一致；若选择拒绝，断言目标全部记录、元数据、账本版本及请求 token 状态均不变。
3. 同范围恢复继续成功，不能因修复而禁用合法的跨账本恢复。

### R9 — 整图恢复未检查当前 closed 周期的重复锚点（P2）

**位置：** `cost_basis_fop_domain.py:798–805`，`check_graph` 对周期修订链和锚点存在性进行校验，但没有跨 boundary 检查当前 closed 周期的锚点唯一性。

**复现：**

1. 通过正常追加建立并平掉一笔 FUT，再用 `close_cycle` 关闭周期。
2. 使用另一 `boundaryId` 对同一锚点再次 `close_cycle`，普通写入入口拒绝。
3. 导出只有一个 closed 周期的备份，复制该周期记录，仅改成新的 `boundaryId`，保留相同锚点；重算文件校验和。
4. 恢复该备份，再导出检查周期数量。

**实际输出：**

```text
NORMAL DUPLICATE CYCLE: FopCycleBoundaryViolatedError
RESTORED DUPLICATE CYCLE: accepted 2
```

**影响及建议：** 恢复入口能写入普通入口明确拒绝的周期状态，R2 所要求的整图有效性仍未闭合。应让普通写入与恢复复用同一约束；文件校验和不能替代关系校验。

**修复验收：**

1. 两个不同 boundary 的当前 closed 记录使用同一锚点时，恢复必须拒绝，且目标图、版本、token 状态全部回滚。
2. 不同锚点的合法周期继续通过。
3. 明确只对“当前且 closed”的记录实施这一唯一性检查；合法的历史修订、已被取代的记录共享旧锚点，不能被误拒。

### R10 — 原样往返重新选择主来源，改变 namespace（P2）

**位置：** `cost_basis_fop_store.py:1163–1166`，`_request_from_stored_event` 根据不含 namespace 的 `row['externalRef']`，再按 namespace 等字段排序 allocations 来重建 sources。

**复现：**

1. 使用正常 `rebuild_fop_book`，写入一条同时关联 `tws_exec:shared-reference-001` 与 `ib_exec:shared-reference-001` 的合成事件；原主来源为前者，附合法 statement 登记。
2. 记录数据库中的完整 `external_ref` 与 `ledgerVersion`。
3. 正常导出备份，保持原样，再恢复到同一账本。
4. 比较完整来源身份及版本。

**实际输出：**

```text
NAMESPACE ROUND TRIP: tws_exec:shared-reference-001 -> ib_exec:shared-reference-001 same version: False
```

**影响及建议：** 来源键本来由 namespace 与 sourceRef 共同决定；两个 namespace 下相同文本的 sourceRef 不等于同一来源。恢复排序会重新选主来源，导致未修改的备份不能保持证据身份，且改变账本版本。备份与恢复应保留完整的主来源身份，或通过可靠的显式关系保存该选择，不能靠排序推断。

这是已允许的存储关系组合的合成测试，不代表已经验证真实 IBKR CSV 对该组合的映射。

**修复验收：**

1. 上述多 namespace 场景原样往返后，主来源的 namespace、sourceRef 和全部 allocation 均保持一致；按现有内容摘要语义，同账本原样往返版本应一致。
2. 覆盖不同来源输入顺序，并确认结果不受字母排序影响。
3. 同时覆盖一条来源拆成多事件的备份往返，不能重新引入 R4 的唯一索引冲突。

### R11 — 请求日志缺席备份，新库恢复后无法幂等重试（P2）

**位置：** `cost_basis_fop_store.py:1147–1150`，备份图字段没有新加的请求日志；`cost_basis_fop_store.py:296–304` 在查不到请求日志、却发现业务行已有 token 时，按“另一写入已使用 token”拒绝。

**复现：**

1. 在临时源库追加一笔 FUT，保留原请求包、`clientToken`、首次返回结果及版本，然后正常导出备份。
2. 在全新临时数据库创建同一 bookId、相同元数据的账本，恢复原样备份，不发生 ID 重映射。
3. 使用完全相同的追加请求和原 token 重试。

**实际输出：**

```text
NEW-DB RETRY: InvalidRequestError clientToken has already been used by another write; nothing was written
```

**影响及建议：** 请求日志在原库的 reset/restore/rebuild 中保留，确实解决了 R7；但 JSON 备份不包含日志，灾后新库恢复只带回事件 token，丢失了识别同一请求所需的证据。应明确并实现请求记录的备份语义，或提供可验证的恢复后重试机制。不能为了让重试通过而放行“同 token、不同载荷”。

**修复验收：**

1. 新库、同 bookId 恢复后，原追加请求同 token 返回幂等成功，不新增事件；同 token 改载荷仍拒绝。
2. 对依赖请求日志的 metadata、reset、rebuild、restore 请求分别明确恢复后的重试语义并加断言；不能只测试原库内恢复，因为原库可能残留请求日志。
3. 跨 bookId 的恢复必须明确 token、请求摘要、返回结果中 ID 的重映射或隔离策略，不能把旧账本的结果直接返回给新账本；备份校验和及格式校验应覆盖新增证据。

## 9. 修复后本轮实际执行的验证

命令在被审查的 P2 checkout 根目录执行；`<venv>/python` 仍指项目配置的解释器，Python 测试使用 `PYTHONDONTWRITEBYTECODE=1`。本次文档追加时再次执行了第 10 节完整脚本，四项剩余问题的输出与下文一致。

| 检查 | 命令或方式 | 实际结果 |
| --- | --- | --- |
| 全部前端测试 | `node tests/run.js` | 1238 通过，0 失败 |
| 成本账本 Python | `PYTHONPATH=. <venv>/python -m unittest discover -s tests -p 'cost_basis*_test.py'` | 419 项：417 通过、2 跳过，0 失败 |
| FOP Python 专项 | `PYTHONPATH=. <venv>/python -m unittest discover -s tests -p 'cost_basis_fop_*_test.py'` | 95 通过，无跳过 |
| P2 阶段运行器 | `node tests/run_cost_basis_fop.js --stage P2` | Node 29 通过；列出另外执行的 6 个 Python 套件，共 95 项 |
| 原 R1–R7 独立复核 | 按第 7.1 节的修复后期望转换为断言 | 8 项全部通过，其中 R2 占 2 项 |
| 追加问题诊断 | 第 10 节完整脚本 | 复现 R8–R11，不是验收通过 |
| 资源版本 | `python3 scripts/stamp_asset_versions.py --check` | `asset versions are current` |
| 差异格式 | `git diff --check` | 通过 |

95 项 FOP 测试属于 419 项成本账本测试；29 项阶段 Node 测试属于 1238 项前端测试，不能重复加总。原问题的 8 项独立复核也不计入正式套件通过数。

```text
1238 passed, 0 failed

Ran 419 tests in 12.350s
OK (skipped=2)

Ran 95 tests in 1.665s
OK

29 passed, 0 failed (node, through P2)
```

本轮没有执行全仓 Python `*_test.py`、浏览器验收或真实 TWS 会话，也没有验证尚属后续阶段的真实 CSV 自动导入及完整经济回放。上述套件通过不能替代 R8–R11 的专门验收。

## 10. 剩余四项问题的可执行复现

以下脚本依赖当前 P2 checkout 的测试辅助模块，只创建并清理临时数据库，不启动后端。保存为临时 `fop_p2_rereview_probes.py`，在 P2 checkout 根目录用项目解释器运行；POSIX 示例：

```sh
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=.:tests <venv>/python /path/to/fop_p2_rereview_probes.py
```

脚本为诊断证据，输出顺序为 R11、R8、R9、R10。R8、R10、R11 使用原样导出的备份；仅 R9 修改图并重算校验和，以验证域约束。修复后应按第 8 节改成正式断言，不以复现旧错误为通过条件。

```python
import hashlib, pathlib, tempfile
from cost_basis_fop_test_support import FopLedger, CLZ6, IDENTITY, FOP_META, token, package
from cost_basis_fop_store_test import fut_trade, tws
from cost_basis_fop_domain import canonical_json
from cost_basis_store import CostBasisStore

def seal(b):
    b['sha256']=hashlib.sha256(canonical_json(b['payload']).encode()).hexdigest()
    return b

def restore(store, book_id, backup):
    p=store.reset_confirmation(book_id)
    return store.restore_backup(book_id, backup, confirmation=p['phrase'],client_token=token(),
        expected_ledger_version=p['ledgerVersion'],book_identity=IDENTITY,engine_version=1)

def commit(l,op):
    return l.store.commit_fop_metadata(l.book_id,op,client_token=token(),
        expected_ledger_version=l.version(),book_identity=IDENTITY,engine_version=1)

with tempfile.TemporaryDirectory(prefix='p2-rereview-') as td:
    d=pathlib.Path(td)
    l=FopLedger(d/'token_source.db'); tok=token()
    original=l.append(fut_trade(),contracts=[CLZ6],client_token=tok)
    backup=l.store.export_backup(l.book_id)
    dst=CostBasisStore(d/'token_restored.db',fop_writes_enabled=True).initialize()
    dst.create_fop_book(account=IDENTITY['account'],symbol='CL',start_date='2026-01-01',fop=FOP_META,book_id=l.book_id)
    restore(dst,l.book_id,backup)
    try:
        dst.append_fop_event(l.book_id,package(fut_trade(),contracts=[CLZ6]),client_token=tok,
            expected_ledger_version=original['ledgerVersion'],book_identity=IDENTITY)
        print('NEW-DB RETRY: replay accepted')
    except Exception as ex: print('NEW-DB RETRY:',type(ex).__name__,str(ex))

    source=CostBasisStore(d/'scope_source.db',fop_writes_enabled=True).initialize()
    original=source.create_fop_book(account=IDENTITY['account'],symbol='CL',start_date='2026-10-01',
        fop=dict(FOP_META,historyScope='since_baseline'))
    source.append_fop_event(original['bookId'],package(fut_trade(),contracts=[CLZ6]),client_token=token(),
        expected_ledger_version=source.ledger_version(original['bookId']),book_identity=IDENTITY)
    backup=source.export_backup(original['bookId'])
    target=CostBasisStore(d/'scope_target.db',fop_writes_enabled=True).initialize()
    new=target.create_fop_book(account=IDENTITY['account'],symbol='CL',start_date='2026-10-01',fop=dict(FOP_META))
    result=restore(target,new['bookId'],backup)
    print('Unmodified backup historyScope:',backup['payload']['fopBook']['historyScope'])
    print('Restore success:',result['restoredEvents'],'events; remapped:',result['remapped'])
    print('Restored book historyScope:',target.get_book(new['bookId'])['fop']['historyScope'])

    l=FopLedger(d/'cycle.db'); l.append(fut_trade(),contracts=[CLZ6])
    closing=l.append(fut_trade('2026-10-02T14:00:00.000000Z',futureContracts=-1,openClose='C'))['event']
    op={'kind':'close_cycle','boundaryId':'cycle-review-001','anchorEventId':closing['eventId'],'label':''}
    commit(l,op)
    try: commit(l,dict(op,boundaryId='cycle-review-002'))
    except Exception as ex: print('NORMAL DUPLICATE CYCLE:',type(ex).__name__)
    b=l.store.export_backup(l.book_id)
    b['payload']['cycles'].append(dict(b['payload']['cycles'][0],boundaryId='cycle-review-002'))
    try:
        restore(l.store,l.book_id,seal(b))
        print('RESTORED DUPLICATE CYCLE: accepted',len(l.store.export_backup(l.book_id)['payload']['cycles']))
    except Exception as ex: print('RESTORED DUPLICATE CYCLE:',type(ex).__name__,str(ex))

    l=FopLedger(d/'namespaces.db')
    e,s=tws(fut_trade(),'shared-reference-001',1,2.02)
    e['sources'].append(dict(e['sources'][0],namespace='ib_exec'))
    s2=dict(s,namespace='ib_exec',format='flex_csv',section='Trades')
    statement={'format':'flex_csv','fileName':'synthetic.csv','fileSha256':'1'*64,'account':IDENTITY['account'],
        'periodFrom':'2026-10-01','periodThrough':'2026-10-01','checks':{},'confirmedDuplicates':0}
    p=l.store.reset_confirmation(l.book_id)
    l.store.rebuild_fop_book(l.book_id,package(e,contracts=[CLZ6],sources=[s,s2]),confirmation=p['phrase'],
        client_token=token(),import_batch_id=token(),statement=statement,expected_ledger_version=p['ledgerVersion'],book_identity=IDENTITY)
    def ref():
        c=l.store._connect()
        try: return c.execute('SELECT external_ref FROM cost_basis_events WHERE book_id=?',(l.book_id,)).fetchone()[0]
        finally: c.close()
    before=ref(); v=l.version(); b=l.store.export_backup(l.book_id)
    restore(l.store,l.book_id,b)
    print('NAMESPACE ROUND TRIP:',before,'->',ref(),'same version:',v==l.version())
```

本轮实际输出：

```text
NEW-DB RETRY: InvalidRequestError clientToken has already been used by another write; nothing was written
Unmodified backup historyScope: since_baseline
Restore success: 1 events; remapped: True
Restored book historyScope: full_history
NORMAL DUPLICATE CYCLE: FopCycleBoundaryViolatedError
RESTORED DUPLICATE CYCLE: accepted 2
NAMESPACE ROUND TRIP: tws_exec:shared-reference-001 -> ib_exec:shared-reference-001 same version: False
```

## 11. 修复后复核文件指纹

以下摘要对应第 7–10 节所复核的未提交内容。后续修复改变文件后，本轮证据与行号应按此区分，不覆盖第 6 节的旧版指纹。

| 文件 | SHA-256 |
| --- | --- |
| `cost_basis_fop_store.py` | `8c81df267224f684a04f9b70239bfcbf5262589761e1dff7e0ebb52802472df8` |
| `cost_basis_fop_domain.py` | `785b64bb934cf492873321606608a110eb5df71b7b9c8feea88c5927275c30b2` |
| `cost_basis_fop_protocol.json` | `320b277a7bd3ff8e1af3335a94141dd6c7c5234422b63908caa32f49ef0a5893` |
| `cost_basis_store.py` | `e2ba5a0fc08d5f3892555976adaede68ce9e48274c58880a3d7661086c1bd8b2` |
| `cost_basis_ws.py` | `d5a561f72cef1b904a7a3349bb85038620171fbe624350668659513b8a873642` |
| `tests/cost_basis_fop_store_test.py` | `86e6ac50ccf8a409a34578e9e6a5cf78af8e1580801cc0b2d27d99dfffcb67e0` |
