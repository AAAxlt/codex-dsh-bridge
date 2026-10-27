# Bridge 1.0.8 调用约定

以下为 1.0.8 源码的调用约定，不代表当前连接已加载新版或真实模型任务已经验收通过。重连后用 `dsh_get_capabilities` 确认实际版本与生效参数。公开仓库不包含本机运行时基线或私有验证证据，安装配置见 README.md。

兼容 1.0.3 的旧默认：省略 `deliveryPreset` 和三项工作参数时，仍使用 medium、maxTokens=16384、每阶段 budgetMs=300000；自动回修默认关闭。返回的 `effectiveParameters` 是实际执行值；`maxTokens` 是上限，不是要求模型用满。

- 短诊断／宿主脚本载体：显式 reasoningEffort:"low"、maxTokens:2048，按脚本需要指定有界 budgetMs。
- 正式工作：一次给出完整目标、工作区、约束、验收命令。优先只返回短报告、产物路径、测试结论、风险和未决项，长代码／日志保存在工作区，不整段塞回调用方上下文。
- 复杂排错、设计与复审：显式 high、16384～32768，按工作量选 600000ms 或更长的有界预算；不默认所有任务使用 high。
- 显式 256／512 等输出上限以及 1000ms 以上的短阶段预算会被保留；不存在全局强抬 4096 的 floor。
- 预算按每个阶段重新计时，从 SDK 启动完成后、发送阶段提示前开始；SDK 启动另受 submitTimeoutMs 限制。显式阶段预算最大 86400000ms，非法值拒绝。宿主验收另用 `verificationTimeoutMs`，旧默认仍为 300000ms。
- 达到模型输出上限返回 incomplete。默认仍是显式 continue 同一仍存活会话、不复制任务重做；只有在 submit/recover 中启用 `autoContinue` 时才按 1.0.8 的有界规则自动续跑。
- previewTruncated 只代表展示缩略，不等于上游输出耗尽；完整的已记录文本可读 fullReportPath。upstreamTruncated／storageTruncated 表示内容不完整。
- modelReportMaxChars=8000、toolPreviewMaxChars=400、maxTokensMax=32768 均保持原值。

供应商、SDK 和凭据方式不变。GOAT DeepSeek Flash 的 off／none 仍按 1.0.1 规则显式映射 low，并保留 requested/effective 及警告。

## 1.0.8：输出耗尽续跑、结构化外部回执、诚实的自动化计数

### `autoContinue`（submit / recover）

可选 `autoContinue:{enabled,maxAttempts,noProgressLimit,totalBudgetMs}`。省略时默认关闭；`deliveryPreset:"complete"` 开启 `maxAttempts=2,noProgressLimit=2,totalBudgetMs=3600000`，显式字段优先，非法值在创建任务目录前拒绝。

只有真实 provider `max_tokens` / `length` 结束才可能触发。存储或展示截断、取消、权限/凭据阻塞、运行时已死、shutdown、受保护验证文件完整性失败都不触发；该阶段保持 `incomplete`，不运行宿主验收。续跑在**同一存活 SDK/session** 中发送下一阶段，阶段原因标为 `auto-continuation`，不新建 runtime，也不声称原生 resume。

计数包含 attempts、单调 elapsed budget 与源码进度。进度只看声明的 `deliverySource` 内容哈希（应用 exclude），未声明时看旧 workspace 快照并排除日志/Bridge 证据；相同字节、模型自述、工具数、staging 复制和日志增长都不算进度。`noProgressLimit=2` 允许一次无变化续跑，随后停止；`maxAttempts` 限制新增阶段。生成与验证都受最紧的启用自动化预算约束，自动跳转不重置时钟；手动 `dsh_continue_task` 会开启新的周期但保留累计计数（旧语义，已记录）。

### `dsh_submit_review`

结构化外部验收回执：

```json
{"taskId":"dsh-...","stage":2,"reviewId":"review-1","outcome":"fail","summary":"...",
 "findings":[{"id":"F1","title":"...","expected":"...","actual":"...","reproduction":["..."]}],
 "checks":[{"name":"acceptance","status":"fail","exitCode":1,"stdout":"...","stderr":"...","command":["node","accept.mjs"]}],
 "reviewedSource":[{"path":"src/tasks.ts","sha256":"..."}]}
```

- `source=caller-reported`；命令和输出只是数据，Bridge **从不执行**。所有诊断文本脱敏，数组/文本/总输入有界，运行时 API 与 zod 双重校验。
- 回执绑定精确的**最新已结算阶段**；stale、in-flight、cancelled、historical、dead-runtime 控制被拒绝，且不写文件、不发模型请求。
- `reviewedSource` 必须是工作区相对、普通、无链接文件，当前字节 SHA-256 必须匹配；绝对路径、`..`、通配符、链接、敏感名和 hash 不符都拒绝。hash pin 只绑定字节，不证明外部检查真的运行过。
- 回执在 prompt 前持久化到由 `SHA-256(reviewId)` 派生的可移植文件名（原始公开 ID 保留在回执内），并有 append-only `reviews/events.jsonl`。同一 `reviewId` 同一规范化原始 body 幂等，绝不发第二次 prompt（包括首次续跑期间重复）；不同原始 body（即使脱敏后相同）冲突复用拒绝。旧阶段 result/checkpoint 字节不被改写。
- `pass`/`blocked` 不启动模型；带可操作 findings 的 `fail` 在同一 live session 启动一个 repair 阶段，即使宿主验证此前已通过。结构化 expected/actual/reproduction/输出作为**不可信诊断数据**传递。
- 返回 `{ok,taskId,reviewId,stage,alreadyRecorded,continued,repairStage,source}`。只有真正获得 prompt ack 的那次调用 `continued=true`；幂等重复返回 `alreadyRecorded=true, continued=false`。
- 新记录的 pass、blocked 或无 actionable findings 的 fail 会同步既有 delivery index 的外部验收门/计数/最新回执证据/未解决文本和可变 `checkpoint.json`；不会重新抓取实时工作区，也不会改写已封存的 stage result、`checkpoints/stage-N.json` 或 source 描述符/产物。同一原始 body 的重复回执是真正 no-op，不重写 index 时间戳或 hash。
- task/result 增加 `externalReview.status: none|failed|blocked|awaiting-recheck|passed`。外部 fail → repair → 本地命令通过后仍为 `awaiting-recheck`，`productAcceptance=unverified`，直到针对新阶段的显式 pass 回执。调用方 pass 不能把失败的宿主命令改成 pass；pass 只属于其精确阶段，不被后续阶段静默继承。

### 自动化计数与交付证据

task/result 增加 `automationMetrics`：手动 Codex 续跑、自动宿主回修、输出耗尽续跑、review repair 分开计数；`codexDirectEditCount`、Codex token 与 review 成本保持未知，不推断节省。每阶段记录 `cause`、`causeDetail`、`elapsedMs` 与 `sourceProgress`。checkpoint、delivery index/export 和有界历史投影都包含对应计数、最新外部回执摘要与回执证据；不包含推理、凭据或可执行命令。


部署采用新版本目录与启动入口备份。已有 MCP 连接不会因磁盘默认值改变而热更新；重连后用 dsh_get_capabilities 核对 bridge.version、executionDefaults 和生效路径。

## 1.0.7：持久化健康、显式源码范围、增量事件

### 持久化健康

- 新建 SDK 前、发送 prompt 前，都必须成功原子写入有效的 `task.json` 与当前阶段 checkpoint（含 `checkpoints/stage-N.json`）。失败返回明确错误且**不发送模型 prompt**；若第二阶段失败前 runtime 已创建，只停止该任务自己的 runtime，并如实报告清理结果。
- 后续 task/checkpoint/event-log 写入失败不再静默：live `dsh_get_task` / `dsh_get_result` 增加 `persistence`，包含 `status: healthy|degraded`、最近成功时间、最近成功 checkpoint、最多 5 条脱敏失败事实。`degraded` 对 live 任务粘滞；失败的原子更新不会覆盖此前的好字节。`task.json` 自身不可写时只能通过 live API 暴露，这是已知边界，不声称已恢复。
- 原子写入使用同目录唯一临时文件、`wx`、文件 fsync、rename、尽力目录 fsync 与临时文件清理；这不是整机断电级保证。

### 显式 `deliverySource`

`dsh_submit_task` / `dsh_recover_task` 可选：

```json
{"deliverySource":{"mode":"complete","paths":["package.json","src"],"exclude":["src/generated"]}}
```

- 省略时完全保留旧的 observed-changes 导出与旧索引 schema。`paths`/`exclude` 是有界工作区相对文件或目录；绝对路径、`..`、通配符、敏感名、符号链接一律拒绝。
- `complete` 在交付结算时捕获范围内全部普通文件（含未变化/新增）。超限、非普通文件、链接或读取中变化都明确失败，绝不把截断结果标成 complete。
- `patch` 在第一个 prompt 之前捕获并持久化完整 baseline；后续 continue 沿用同一 baseline；recover 使用调用方新的 scope/baseline，不重放旧路径/旧 baseline。导出只含新增/修改字节，`changes.removed` 是真实删除列表。
- 索引新增 `source.mode`、`source.scope`、`source.final`，patch 另有 `source.baseline`；文件为排序后的 `{path,bytes,sha256}`，`manifestSha256` 绑定规范排序的 descriptor JSON。`source.files` 仍是实际导出的产物；原 `selectionSha256` 与全部 artifact hash 校验保留。

导入 CLI（默认 dry-run，不创建任何目录/文件）：

```bash
node scripts/import-delivery.mjs --bundle <exportDirectory> --destination <directory>
node scripts/import-delivery.mjs --bundle <exportDirectory> --destination <directory> --apply
```

修改任何目标前会校验完整索引、所有 artifact hash、scope、路径、上限与 mode。complete 需要新建或空目录；patch 要求目标声明范围与 baseline 完全一致（存在、缺失与字节），保留范围外无关文件，冲突时零改动拒绝。patch 应用前保留 sibling backup 与 `transaction.json`；写入失败时 `rollback` 只报告经过验证的 `complete|partial`。本轮不增加第二个写 MCP 工具。

### 有界事件与最近进度

- 审查加固：patch 导入在任何目标修改前完成全部备份与 hash 校验；备份失败只报告 `rollback: not-needed` 并保留原文件。回滚只处理本次实际写入/删除的路径。单个超页预算事件返回有界 `bridge/oversized-event` 占位并前进 cursor；源码捕获与 artifact 导入均先检查实际大小、再以有界读取处理增长；patch 最终捕获允许声明的文件或整个目录已被删除（complete 与 baseline 仍严格）。
- 新只读工具 `dsh_get_events({taskId, cursor?, limit?})`：默认 25、硬上限 100，返回 `events`、`nextCursor`、`hasMore`、`source: live|persisted-history`、`runtimeAttached`、`partialLine`、`pendingBytes` 与扫描/返回字节上限。按 cursor 定位并以 64 KiB 块读取，绝不整文件读取；末尾未完成的 JSONL 行不消费、不空转。
- cursor 是不透明 base64url，绑定 taskId、文件 device/inode 身份与字节位置；非法、跨任务、过期 cursor 明确报错。历史读取复用锚定且拒绝链接的 history guard；不探测/控制/重启记录中的 PID，不启动 runtime、不发模型请求。输出同样脱敏并剥离模型推理；坏行成为有界显式条目。
- live task/result 增加 `progress`：`lastActivityAt`、`currentTool`、最新优先的有界 `recentTools`（最多 20）、阶段、准确 tool 总数与 verification 状态。旧的 first-60 `toolCalls` 字段不变。150 次调用的阶段会在 `recentTools` 中保留第 149 次（索引 149，即第 150 次调用），完整事件分页也能看到它。没有虚构百分比、ETA、存活证明或成功判断；轮询只读。

## 1.0.6：checkpoint 恢复为新任务/新会话

重启后的 MCP 进程没有原 live 任务，但有持久化的 `task.json` 与 `checkpoint.json` 时，可显式恢复：

1. `dsh_prepare_recovery({taskId, workspace})`：只读。安全加载 `DATA_ROOT/tasks/<taskId>/task.json` 与 `checkpoint.json`，校验 task/stage/checkpoint 身份、schema、字节上限与工作区是否等于记录路径；返回有界、脱敏的 `planToken`、source hash、recorded state、verifier 元数据和明确限制。**不启动 runtime、不发模型请求、不写文件、不探测旧 PID**。checkpoint 缺失/损坏、workspace 不匹配、旧任务仍在本进程 live map 中都会明确拒绝。
2. `dsh_recover_task({taskId, workspace, planToken, instructions, ...})`：启动**全新** taskId/sessionId/runtime。使用原 goal/constraints、bounded checkpoint summary 和本次 `instructions`；旧 prompt/context/模型推理不会恢复，旧阶段不会拼进新任务。`recoveredFrom` 在第一次 prompt 之前写入新任务记录，并出现在 task/result/history。
   - 若源任务配置过 verification，必须提供新的 `verificationCommand`；记录中的 argv 永不执行。
   - 若源任务固定过 `protectedVerificationFiles`，必须按原 real path 与 SHA-256 重新提供；可追加新 pin，但不能静默删除旧 pin 或接受已变更字节。
   - 源状态为 `accepted/starting/running` 时默认拒绝；只有显式 `allowUnsettledSource:true` 才允许新会话恢复。该标志是调用方确认，不是 Bridge 对旧 PID 死活的证明。
   - 同一 `planToken` 的重复调用（包括 Bridge 重启、且新任务已改变工作区之后）返回同一 taskId 和 `alreadyRecovered:true`，不会启动第二个 runtime 或重复模型请求。进行中/不确定启动保守拒绝，不盲目重试。
   - 计划后源记录/checkpoint 或工作区漂移、ledger/claim 链接或越界，都会在启动 runtime 前失败。工作区指纹会完整流式哈希每个纳入的普通文件（>2 MiB 也哈希）；超过 4000 文件或 64 MiB 上限、或遇到不可读/不支持/替换/读取中变化的条目时，`prepare`/`recover` 会在启动 runtime 前明确拒绝，不会返回 partial/null-digest 指纹。`node_modules`、`.git`/`.hg`/`.svn` 与 `DATA_ROOT/tasks`、`DATA_ROOT/recovery` 为有意排除项；符号链接只绑定 target 字符串，不跟随。
   - 每个阶段都会在 runtime 启动前、以及 prompt 发送前原子写入当前阶段 checkpoint。首轮生成期间 Bridge/系统崩溃时，仍可用该 pre-prompt checkpoint 恢复；但它只对仍记录为 live 的源、且显式 `allowUnsettledSource:true` 时接受，缺失/损坏的 checkpoint 永远不会被静默重建。

恢复的边界是“基于 checkpoint 的工作恢复”，不是 SDK 原生对话续接（`session/resume` 未由 Bridge 使用），也不是整机重启或外部副作用重放。详见 `docs/RELEASE-1.0.6.md` 与 `docs/SDK-RESUME-ASSESSMENT.md`。

## 1.0.5：只读历史与边界文案

重启或换用新的 Bridge 进程后，旧任务只作为磁盘记录存在，不进入活动任务表，也不会被自动恢复。用以下只读工具查看：

- `dsh_list_history`：参数 `limit` 默认 20、最大 100，返回有上限的摘要；单个损坏条目标记为 `valid:false`，不影响其他有效条目。
- `dsh_get_history`：参数 `taskId` 和可选的 `stage`；返回投影、脱敏后的任务/阶段/checkpoint/交付摘要。

两类响应最外层固定 `source:"persisted-history"`、`runtimeAttached:false`、`runtimeAlive:null`、`canContinue:false`、`canCancel:false`。`recordedState`/`lastRecordedState`、时间戳和 `recordedRuntimePid` 都只是当时记录，不代表当前进程仍存活。历史读取不会探测、恢复、启动或停止旧 PID，不会执行历史 argv，也不会重新采集当前工作区；记录中的绝对路径不用于读取，实际路径只由 `DATA_ROOT/tasks` 和严格 taskId 推导。

对历史 taskId 调用 `dsh_continue_task`、`dsh_cancel_task` 或 `dsh_wait_task` 会以 `historical_not_live` 明确拒绝，不会操作旧进程。历史不是 SDK 跨进程恢复；要开始新工作应提交新任务。

`dsh_export_delivery` 在没有活动任务时也接受通过校验的历史 taskId：要求最新阶段已 finalised、`deliveryStage` 对齐最新阶段、索引 taskId 与 `metrics.stageCount` 对齐，并继续复用已有产物路径/大小/SHA-256 校验；复制已记录源码字节，不重新验收、不重新采集工作区。后续阶段捕获失败后遗留的旧交付包会被拒绝。

第一/后续阶段提示只声明两个事实：工作区已通过允许根准入，SDK overlay 配置为 `workspace-write`。它不再声称工作区外全部不可写，也不声称已经证明 OS/文件系统隔离；`dsh_get_capabilities.workspaceBounds.isolation` 使用同样的真实边界。

## 1.0.4：完整交付与自动回修

日常完整任务可给 `dsh_submit_task` 加 `deliveryPreset:"complete"`。预设使用 high / 32768 / 每阶段 30 分钟，宿主验收 10 分钟，并开启最多 3 个额外回修阶段、连续失败无变化阈值 2、全程 60 分钟预算。显式参数优先，短预算也不会被抬高；不增加强制 token 或费用上限。

以下路径为示例，派发前换成实际存在的工作区、Node 和独立验收文件。预设及单独开启自动回修都必须提供验收命令和非空保护文件清单。

```json
{
  "workspace": "D:/AGENTS/workspaces/my-project",
  "goal": "完成指定功能，运行验收并修复失败；交付变更、验证结果、未解决项和证据路径。",
  "deliveryPreset": "complete",
  "verificationCommand": [
    "D:/AGENTS/runtimes/node/node.exe",
    "D:/AGENTS/acceptance/my-project/verify.mjs",
    "--workspace",
    "D:/AGENTS/workspaces/my-project"
  ],
  "protectedVerificationFiles": [
    "D:/AGENTS/acceptance/my-project/verify.mjs",
    "D:/AGENTS/acceptance/my-project/assertions.mjs",
    "D:/AGENTS/acceptance/my-project/fixtures/expected.json"
  ],
  "autoRepair": {
    "enabled": true,
    "maxAttempts": 3,
    "noProgressLimit": 2,
    "totalBudgetMs": 3600000
  }
}
```

宿主验收失败后，Bridge 将锁定的命令 argv、退出码、超时信息和必要的脱敏日志尾部交回同一个 DSH 会话，继续实现、再次验收。`maxAttempts` 只计额外回修阶段；`totalBudgetMs` 约束当前自动回修循环，明确包含本轮初始生成阶段和初次宿主验收，以及其后每一个自动回修阶段及其宿主验收。它不是所有手动阶段的硬上限，也不构成总成本或总时长保证。手动 `dsh_continue_task` 会重置自动回修的 attempts/unchangedFailures/lastFailure/startedAt/stopReason，并保留同一存活会话与既有阶段。输出耗尽的 `incomplete`、取消、权限阻塞等不会强行自动续跑。

通过后或停止回修时交回 Codex。查看 `autoRepair.stopReason`：常见值为 `passed`、`no-progress`、`attempt-limit`、`total-budget-exhausted`、`external-blocker`、`protected-verifier-changed`、`verification-unavailable`、`continuation-failed` 或 `handoff-<状态>`。失败是否“无进展”按连续相同的退出情况和规范化日志判断，是有限的诊断指标，不能证明源码没有变化。

独立验收由宿主控制：提交时锁定 argv、保护文件真实路径和 SHA-256，验收前后检查；保护文件被修改、替换、删除或不可读时停止交接，退出 0 也不算通过。`protectedVerificationFiles` 必须完整声明入口、导入的断言与辅助脚本、fixtures，以及影响判定的配置和依赖文件。Bridge 不会自动发现依赖；使用 npm 脚本时也要考虑 `package.json`、锁文件与测试依赖。

建议将验收脚本、断言和 fixtures 放在模型工作区外。该保护不提供系统沙箱或写入权限隔离，不能阻止同权限进程写入；哈希检查也不能覆盖未声明依赖或采样之间修改后还原的情况。需要更强隔离时，应由宿主安排只读权限或独立执行环境。

## 验收结果与交付导出

`scripts/verify-delivery.mjs` 区分三种结果：

- `pass`／退出 0：声明的检查完整执行且通过。
- `partial`／退出 2：已有部分验证，但存在运行时检查跳过或测试 skip/todo；不算完整通过。
- `fail`／退出 1：检查失败、统计缺失或矛盾、测试数量不符、文件或清单哈希不匹配。

结果 JSON 记录各路实际通过、失败、取消、跳过与 todo 数，兼容 Node TAP/spec 摘要；仅收集到测试数量不够。`delivery.json` 的 `sourceHashes.final.manifestSha256` 必须匹配实际 `SOURCE-HASHES.sha256` 文件字节摘要。Bridge 对任意外部验收器仍以真实退出码判断命令通过与否，因此自定义验收器也应将部分验证返回非零。

任务停止后，Bridge 自动生成最终交付索引，汇总所选源码快照与哈希、Git 标识、变更、各阶段验收、未解决项、模型报告和证据。默认源码选择是观察到的新增与修改文件，缺失、过滤或超限项需看索引；它不保证包含整个仓库，也不表示快照字节与验收瞬间完全相同。

用 `dsh_export_delivery` 取出已记录的交付包：

```json
{
  "taskId": "替换为返回的任务 ID",
  "destination": "D:/AGENTS/workspaces/review-export/my-project-run-001"
}
```

目标必须是允许根目录下的新目录；返回 `indexJson`、`indexMarkdown` 等路径。导出核对已记录产物哈希，复制已有源码快照与证据，不重新运行验收或启动模型请求。审查时先看 `index.md` 的关键差异、验收与异常，再按需读 `index.json` 和原始证据。

索引的 `metrics` 自动记录手动继续次数 `codexContinuationCount`、自动回修次数、首次宿主验收是否通过、阶段数和总交付时间，并单列 SDK 上报的 DSH usage。手动继续次数只覆盖 Bridge 接口观察到的继续操作，不等于全部 Codex 介入。Codex tokens、审查与返工成本仍为未知，不能从 DSH usage 推算；要证明节省多少，仍需实际任务对照和独立计量。DSH token 更少不是优化目标。

## 1.0.3 观测与交付约定（兼容 1.0.2 字段）

- `bridgeObserved.toolCallsTotal` 现在是该阶段真实工具调用总数，不再被 60 条证据保留上限截断。要读保留/展示数量，用 `toolCallsRetained` / `toolCallsShown`；跨阶段总数用 `toolCallsTaskTotal`。
- `bridgeObserved.usage` 保留为“最后一条原始 usage 事件”。累计值读 `usageAccounting.stage`（本阶段）和 `usageAccounting.task`（全任务，每阶段只算一次）；缺失字段为 `null`，不是 0。`cost` 若 SDK 上报，仅是该事件口径，绝不是供应商账单。
- `totalTokens` 只采用 SDK 明确上报的 total；没有上报就是 `null`。`componentSumTokens` 只是组件算术和，通用别名可能重叠，明确不可当总量/计费。
- 同一条消息 id 的 usage 重发/更新会替换旧记录，不重复累计；`usageAccounting.records` 同时给出 distinct records、实际事件数和去重数。相同 callId 的工具 start/result 重发也不会把真实工具数或错误数吹大。
- `bridgeObserved.verification` 给出 Bridge 自己的命令是否运行、运行次数、退出码/错误、未运行原因。只有正常完成（`awaiting_review`）才运行；取消、超时、失败、blocked、incomplete 不运行，也不表示验收通过。`verificationCommand` 兼容字段仍是最后一次原始运行记录。
- 如果验证命令执行期间发生取消，阶段仍记为 `cancelled`，命令退出码保留，但状态为 `cancelled-during-run`、`acceptance=not-evaluated`，不会被晚到的 finalise 覆盖成通过。
- `deliverySummary` 是给 Codex 的紧凑交付摘要：改动、验证、未解决项、验收判定依据、证据路径。`check-passed` 只代表命令退出 0，不是产品验收；`completed`/`awaiting_review` 也不等于产品验收。
- 正常结束、取消、超时、错误、运行时退出、Bridge 关闭都会原子写出 `<taskDir>/checkpoint.json` 和 `<taskDir>/checkpoints/stage-N.json`。检查点只引用模型报告路径，不伪造结论，也不代表 SDK 支持跨进程恢复。
- 委派提示现在要求 DSH 完成“实现 -> 运行验收 -> 分析失败 -> 修复 -> 再验收 -> 自查 -> 一次交付”，不机械限制工具数/时长；Codex 集中做独立验收。
- 省略 `deliveryPreset` 时默认预算仍是 medium / 16384 / 300000ms；显式 low/high、小/大 maxTokens、短/长 budgetMs 继续生效。没有新增强制 token/成本上限。
- 可复验入口（从任意 cwd）：`node /path/to/optimization-20261022/scripts/verify-delivery.mjs`。它会真实 build + 全量测试，结果与退出码按上面的三态约定返回。
- 运行时基线按 `baseline/runtime-baselines.json` 的精确 root/version 选择；默认 `~/dsh-runtime` 0.2.0 与本次选定的 `/home/agent/dsh-runtimes/0.2.1-rc.2-20261017` 0.2.1 不互换，未知 runtime 拒绝。
- Windows 下验证脚本用 `node <npm-cli.js>` 而不是无 shell 的 `npm.cmd`；测试数/manifest 缺失或为空一律失败。
- 详细字段、兼容性与验证触发边界见 `docs/OPTIMIZATION.md`；本次公开版本说明与验证边界见 `docs/RELEASE-1.0.7.md`、`docs/RELEASE-1.0.6.md`、`docs/SDK-RESUME-ASSESSMENT.md` 和 `docs/VALIDATION.md`；1.0.5/1.0.4 的历史说明保留在对应 `docs/RELEASE-1.0.x.md`。
