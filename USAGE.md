# Bridge 1.0.4 调用约定

以下为 1.0.4 源码的调用约定，不代表当前连接已加载新版或真实模型任务已经验收通过。重连后用 `dsh_get_capabilities` 确认实际版本与生效参数。公开仓库不包含本机运行时基线或私有验证证据，安装配置见 README.md。

兼容 1.0.3 的旧默认：省略 `deliveryPreset` 和三项工作参数时，仍使用 medium、maxTokens=16384、每阶段 budgetMs=300000；自动回修默认关闭。返回的 `effectiveParameters` 是实际执行值；`maxTokens` 是上限，不是要求模型用满。

- 短诊断／宿主脚本载体：显式 reasoningEffort:"low"、maxTokens:2048，按脚本需要指定有界 budgetMs。
- 正式工作：一次给出完整目标、工作区、约束、验收命令。优先只返回短报告、产物路径、测试结论、风险和未决项，长代码／日志保存在工作区，不整段塞回调用方上下文。
- 复杂排错、设计与复审：显式 high、16384～32768，按工作量选 600000ms 或更长的有界预算；不默认所有任务使用 high。
- 显式 256／512 等输出上限以及 1000ms 以上的短阶段预算会被保留；不存在全局强抬 4096 的 floor。
- 预算按每个阶段重新计时，从 SDK 启动完成后、发送阶段提示前开始；SDK 启动另受 submitTimeoutMs 限制。显式阶段预算最大 86400000ms，非法值拒绝。宿主验收另用 `verificationTimeoutMs`，旧默认仍为 300000ms。
- 达到模型输出上限返回 incomplete。先读文件差异和证据，再显式 continue 同一仍存活会话；不自动续跑、不复制任务重做。
- previewTruncated 只代表展示缩略，不等于上游输出耗尽；完整的已记录文本可读 fullReportPath。upstreamTruncated／storageTruncated 表示内容不完整。
- modelReportMaxChars=8000、toolPreviewMaxChars=400、maxTokensMax=32768 均保持原值。

供应商、SDK 和凭据方式不变。GOAT DeepSeek Flash 的 off／none 仍按 1.0.1 规则显式映射 low，并保留 requested/effective 及警告。

部署采用新版本目录与启动入口备份。已有 MCP 连接不会因磁盘默认值改变而热更新；重连后用 dsh_get_capabilities 核对 bridge.version、executionDefaults 和生效路径。

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

宿主验收失败后，Bridge 将锁定的命令 argv、退出码、超时信息和必要的脱敏日志尾部交回同一个 DSH 会话，继续实现、再次验收。`maxAttempts` 只计额外回修阶段；`totalBudgetMs` 覆盖初始阶段、后续回修和宿主验收，阶段与验收均受剩余总预算限制。输出耗尽的 `incomplete`、取消、权限阻塞等不会强行自动续跑。

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
- 详细字段、兼容性与验证触发边界见 `docs/OPTIMIZATION.md`；本次公开版本说明与验证边界见 `docs/RELEASE-1.0.4.md` 和 `docs/VALIDATION.md`。
