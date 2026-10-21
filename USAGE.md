# Bridge 1.0.2 调用约定

正常开发任务省略三项工作参数即可使用 medium、maxTokens=16384、每阶段 budgetMs=300000。返回的 effectiveParameters 是实际执行值；maxTokens 是上限，不是要求模型用满。

- 短诊断／宿主脚本载体：显式 reasoningEffort:"low"、maxTokens:2048，按脚本需要指定有界 budgetMs。
- 正式工作：一次给出完整目标、工作区、约束、验收命令。优先只返回短报告、产物路径、测试结论、风险和未决项，长代码／日志保存在工作区，不整段塞回调用方上下文。
- 复杂排错、设计与复审：显式 high、16384～32768，按工作量选 600000ms 或更长的有界预算；不默认所有任务使用 high。
- 显式 256／512 等输出上限以及 1000ms 以上的短阶段预算会被保留；不存在全局强抬 4096 的 floor。
- 预算按每个阶段重新计时，从 SDK 启动完成后、发送阶段提示前开始；SDK 启动另受 submitTimeoutMs 限制。显式阶段预算最大 86400000ms，非法值拒绝。默认阶段预算不改变宿主 verificationCommand 自身的超时规则。
- 达到模型输出上限返回 incomplete。先读文件差异和证据，再显式 continue 同一仍存活会话；不自动续跑、不复制任务重做。
- previewTruncated 只代表展示缩略，不等于上游输出耗尽；完整的已记录文本可读 fullReportPath。upstreamTruncated／storageTruncated 表示内容不完整。
- modelReportMaxChars=8000、toolPreviewMaxChars=400、maxTokensMax=32768 均保持原值。

供应商、SDK 和凭据方式不变。GOAT DeepSeek Flash 的 off／none 仍按 1.0.1 规则显式映射 low，并保留 requested/effective 及警告。

部署采用新版本目录与启动入口备份。已有 MCP 连接不会因磁盘默认值改变而热更新；重连后用 dsh_get_capabilities 核对 bridge.version、executionDefaults 和生效路径。
