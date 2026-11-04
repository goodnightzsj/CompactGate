# agent_message 加密内容 hydration 失败

## 已核实原因

用户报文为 HTTP 400 `invalid_encrypted_content`，message 指向 `amsg_…`，说明加密内容不能验证、解密或解析。

2026-11-04 的日志 #279784、#279785、#279788 显示请求从 agentrouter 切到 `api666.zzzcoding.org`。恢复链已执行 `original -> error_400`，删除 36 个 reasoning 密文和 ID，但两次尝试都失败；目标无状态健康证据为 false，因此没有进入 strict。

仅检查 #279788 对应抓包的协议结构，确认报错 ID 属于 `agent_message`，其 content 同时有 `input_text` 和 `encrypted_content` 块；该 item 没有顶层 encrypted_content。请求共有 7 个 agent message，其中 6 个携带此类加密块且都有明文。原始与重试请求均完整，store=false，没有 previous response 或 item_reference。另有 1 个 compaction，不能因为它存在就推断本次错误由它引起。

旧状态分析器仅识别 reasoning、compaction 和 continuation；旧 `invalid_encrypted_content` 修复只清 reasoning。结果是混合历史漏清 agent message 的加密块，而只有 agent message 的请求还会被误认为无状态，完全不进入恢复。

## 实施边界

- `provider-state-portability.ts` 按结构识别 agent_message.content 内的加密块，不根据 amsg_ 前缀或错误文案猜测。HTTP 400 的稳定错误码仍由原解析器识别，不新增文本错误分类器。
- 错误专用清理沿用现有 reasoning 行为，同时在 agent message 含非空 input_text 时移除其 encrypted_content 块。保留其他内容块、ID、author、recipient 和 metadata；不递归清理工具参数、工具结果或业务数据。
- 密文可能包含明文未体现的上下文，因此本次转换为 degraded，日志计数为 `encryptedAgentMessageBlocksRemoved`。只含密文或明文为空的 agent message 保持不变，不合成空消息或假摘要。
- strict 已承担跨域清理职责，复用相同的 agent message 处理；CPA 与成功首发不新增清理。错误专用路径不因本次修改删除 compaction，不改变已有严格策略的证据要求。
- 所有原生 Responses host 共用该规则，仍要求 recover_on_error；沿用同 URL/凭据、不可变原始正文派生、body 去重及最多 4 次总尝试。错误专用策略不会循环重试，后续 strict 仍需已有证据。
- 协调器统一在错误响应截断时停止恢复，避免部分错误正文成为新重放依据。取消、响应提交和总预算守卫保留。
- 日志新增可选 `stateful_item_counts.encrypted_agent_messages`，兼容旧行；不增加数据库列，不记录明文或密文。

## 合成示例

首次请求中的历史项：

```json
{
  "type": "agent_message",
  "id": "amsg_synthetic",
  "author": "agent_synthetic",
  "recipient": "all",
  "content": [
    { "type": "input_text", "text": "The delegated task is complete." },
    { "type": "encrypted_content", "encrypted_content": "opaque-agent-state" }
  ]
}
```

上游返回完整 HTTP 400 `{"error":{"code":"invalid_encrypted_content","type":"invalid_request_error"}}` 后，错误专用重试仅从该项 content 移除第二个块，其余字段保持原样。若上游再次拒绝且没有额外恢复证据，返回真实错误。

## 验证与限制

新增回归在旧实现上产生 13 项失败，500 项通过，1 项因私有抓包 fixture 缺失跳过。修复后五个相关测试文件 858 项通过、1 项既有跳过，覆盖 agent-only、混合历史/profile 切换、JSON/SSE/gzip、无目标健康证据、仅密文守卫、业务数据隔离、计数和保真度、截断/取消/关闭恢复，以及先前 agentrouter/anyrouter 的资源冲突规则。

完整 `npm run check` 在 `/tmp/compactgate-hydration.uwHVmR` 按原顺序通过：151 个测试文件、2460 项通过、1 项既有私有 fixture 缺失跳过；差异、样式、严格类型与前后端构建通过。测试与构建使用隔离源码副本和合成 fixture，不复制生产配置、凭据、数据库或抓包。

构建产物对 #279788 的最终失败请求进行只读离线转换核对：旧构建再次执行错误专用清理无变化；新构建移除 6 个 agent 加密块、标记 degraded，其余字段与原始 Buffer 保持不变。只在内存中处理这一条任务内抓包，未输出或复制正文，没有网络重放。完整证据见 `.codex-tasks/20261104-encrypted-hydration/`。

现有服务仍为 PID 4255、127.0.0.1:7865；根 dist 的 214 个文件整体 SHA-256 前后一致。

这是本地恢复覆盖缺口的修复。没有实际向目标上游执行删块 A/B，不能保证真实资源间的剩余密文兼容。没有部署或重启生产服务。

## 一手依据

OpenAI 文档明确说明 [stateless reasoning 仍保留加密状态](https://developers.openai.com/api/docs/guides/reasoning)，[compaction 包含下一轮需要的不透明上下文](https://developers.openai.com/api/docs/guides/compaction)。这支持“不能把 store=false 当作无状态载荷、不能盲删 compaction”的约束；本次 agent_message 的具体字段形态来自上述任务内抓包，不声称它由这两份公开文档定义。
