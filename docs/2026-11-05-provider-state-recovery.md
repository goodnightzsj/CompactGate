# Provider state 统一恢复

## 行为与边界

本次修复覆盖两类 `code: null` 原报文：`The encrypted content for item cmp_... could not be verified` 和 `The encrypted content gAAA...8A== could not be verified`。错误识别由 `provider-state-errors.ts` 统一所有，编译与重试仍由既有 portability/migration 模块执行。

当前所有原生 Responses 上游共用字段级恢复，不再有 agentrouter/anyrouter host 白名单。`compaction.id` 去除已从 `host-quirks.ts` 迁入 `provider-state-portability.ts`，与 reasoning/agent_message 的字段修复同归一个所有者；协调器不再接收 upstreamHost，也不重复解析同一错误。`state_portability: off` 仍关闭错误恢复，默认 `recover_on_error`。

稳定码优先；缺少稳定码时，只接受 HTTP 400、明确错误信封及肯定失败语句。尚未交付输出的 HTTP 200 SSE 可从完整的 response.failed/error 信封提取同类错误，复用该分类器而不改真实状态码。支持大小写/空白、受限诊断前缀、已知单层 Go raw JSON 包装和 gzip/br/deflate/zstd 解码。拒绝引用、否定、普通鉴权/配额/模型错误、递归包装和截断响应。不承诺识别任意未来自然语言变体，也不在本地解密密文。

| 状态 | 恢复动作 | 缺少材料时 |
| --- | --- | --- |
| reasoning / agent message | 有定位则仅修改匹配项；无定位沿用已确认的同类清理 | 无可保留的 agent 明文不清空该消息 |
| message / function / custom tool / web_search | 只去掉已拒绝且具有可重放载荷的顶层密文副本 | 不递归修改正文/参数，无可用载荷的未知状态保留 |
| compaction | 所有 host 的已识别定向失败先尝试只删安全可移除的 ID；优先用可读摘要或完整历史检查点恢复 | 本轮明确解密失败且符合下述独立输入约束时有损移除；其余情况保留密文并返回真实失败 |
| previous response | 用该响应对应的完整可见历史替代 continuation | 不直接删除 continuation |
| 远端 item reference | 仅在已恢复的完整窗口内消解 | strict 不删除引用 ID |
| 已知资源冲突 | 保留密文，仅移除安全可移除的 compaction ID | 不扩大为通用跨域清理 |

一次请求固定目标和凭据，最多发送四个不同正文；每次从 canonical body 重新编译，累积已确认的定向修复。资源 ID 修复后的明确解密失败继续分类，不在第二次错误处提前退出。重复正文、下游已提交、取消、超时或截断都会阻止不安全重放。HTTP 200 内已提交的 SSE 错误不能撤回或重试。

原生 Responses 的早期 SSE 只暂存最多 64 KiB 原始前缀、最长 1 秒；单个解码事件也限 64 KiB。完整接收的明确状态错误进入同一恢复链；输出/工具活动/未知事件、解码损坏或预算到期立即透传。未恢复时保留原始 SSE。日志沿用既有策略名 `error_400` / 触发名 `explicit_400`，实际尝试状态仍为 200，不伪造上游 HTTP 400。reasoning 去密文后只保留可读内容，空壳移除；完整密文定位可命中 agent 内部块。成功规则指纹包含所有加密载体。边界测试和公开参考见[全局兼容方案](2026-11-05-global-compatibility.md)。

无恢复材料且不符合有损条件时，原状态码、错误正文及 trace 保留，并附带 `x-compactgate-state-recovery: unavailable`。有损尝试仍失败也保留最后真实上游错误，不伪装成功。不再保存失败拦截规则，旧负向规则读出即忽略，不需要清库。正向规则的历史材料若已失效，放弃该次缓存策略，原样尝试上游，不在缓存预编译阶段返回 `422`；缓存本身不能授权删除 compaction。既有 split bridge 的不可恢复 422 合同保留。

### 经确认的有损续聊

用户确认允许在现有字段修复后丢弃无法恢复的 compaction，作为 `recover_on_error` 的有损尝试；不新增配置或正文留存。协调器仅在本轮收到上游错误后向编译器授予 `allowCompactionDrop`，编译器仍要求明确 `invalid_encrypted_content`，不扩展到 `invalid_responses_request`、通用 CPA/strict 或首发缓存策略。

有定位只移除匹配 compaction；无定位必须没有其他加密状态载体且只有一个 compaction。请求须为 `store=false`、无 previous response/远端 item reference，并保留其他非 compaction 输入。有效摘要和完整检查点优先；仅缺少恢复材料的非空密文可删除。先前已确认的 compaction、reasoning、agent 修复从 canonical body 累积应用，避免后续错误重新带回已删除状态。

删除仅作用于派生的出站正文，保留普通/重复消息、工具调用与结果及其顺序，不改客户端原历史或抓包。JSON/SSE 成功标记 `degraded`，尝试日志的 `compactionItemsRemoved` 记录数量。被删块独占的旧上下文不可用于本次生成；这不是重建历史或保证上游成功。最多四次发送，取消、截断、已提交及相同正文去重守卫不变。

## 持久关联与隐私

两张表复用现有 logger SQLite 连接，不增加依赖或后台服务：

- `provider_state_recovery_plans`：24 小时、8192 项；仅保存已完成成功响应的修复策略、有限分类、SHA256 指纹和时间。会话、目标状态域、URL、模型、资源/鉴权头、OAuth 账号及代理共同限定作用域。旧请求不能覆盖更新请求的决策；无法保存安全定位指纹的规则不泛化持久化。
- `provider_state_checkpoints`：默认关闭。显式开启后才保存对话可见历史和用于确认覆盖范围的 compaction 窗口；这包含正文及密文，未另行加密。单项 4 MiB、合计 64 MiB；超大的单项不保存，容量不足淘汰旧项，不截断正文。相同状态保留首次有效历史，避免并发请求改变其覆盖关系。

规则只匹配同一状态集合指纹，可容忍普通新用户消息，但新增/修改 provider-state 项会重新分类。规则不是黑名单。升级前留下的负向记录可以按原 TTL 自然清理，但不再参与请求决策；未知的上游资源轮换不会被旧失败记录阻断。

检查点按稳定会话标识及密文/response ID 指纹关联，允许同一会话恢复后迁移到不同目标。没有稳定会话标识、不完整响应、不可证明的历史覆盖范围或未解决的旧密文时，不建立可恢复关联。原有日志/抓包的留存设置独立，不因本开关改变。

写入失败进入现有 persistence health 的错误计数和 stderr，不能伪装成已持久化成功，也不会把已经交付的成功响应改成 502。读取损坏状态显式失败且不回显正文。过期数据读取立即失效，在启动/配置更新/后续写入时清理；SQLite 文件、WAL 和备份可能继续占空间，TTL 不等于安全擦除。

## 配置

默认值：

```json
{
  "primary_failover": {
    "state_portability": "recover_on_error",
    "state_recovery_retention_hours": 0
  }
}
```

要接受本地对话留存，可通过现有配置文件或 `PATCH /api/config` 将 `state_recovery_retention_hours` 显式设为 `1`–`720` 的整数（例如 `24`）。本次实现没有替用户开启。恢复功能关闭用 `state_portability: "off"`；它不等于关闭检查点留存，禁止留存须设置 `state_recovery_retention_hours: 0`。

设置留存为 `0` 会逻辑删除检查点并使在途请求不能写回；重新开启不会恢复已经删除的材料。此操作不删除原有日志、抓包或外部备份。旧会话没有预先保存的材料时，仍需要原上游或调用方提供缺失历史，不能凭密文构造“无损上下文”。

## 完整性与可观测性

Remote V1 恢复整个 canonical compact window，不能单独替换密文后重复拼接保留消息；Remote V2 校验未裁剪前缀，或接受从 compaction 开始的已裁剪窗口。JSON 要求成功完整输出；SSE 只采用完整 `response.completed.output` 或连续且完成的 `response.output_item.done` 集合，`added` 片段、缺项、矛盾输出、失败/取消/截断均拒绝。V1 去重缓存命中也为当前请求建立经过同样检查的关联。

上述边界依据 OpenAI 的 [Compaction 指南](https://developers.openai.com/api/docs/guides/compaction) 和 [Compact API](https://developers.openai.com/api/reference/resources/responses/methods/compact)：不透明压缩项承载历史状态，完整 compact 输出窗口应作为后续输入，不应任意裁剪。

恢复响应使用 `x-compactgate-state-recovery: recovered | cached`，附带 `x-compactgate-context-fidelity`：

- `exact`：恢复所记录的应用可见历史，不承诺隐藏推理或生成结果等价。
- `summary`：使用可读摘要。
- `degraded`：去掉 reasoning 状态、agent 密文或被拒 compaction；后者会丢失仅存在于压缩块中的旧历史。

结构化 portability 日志记录触发来源（含 `cached_recovery`）、每次策略/正文 hash/状态/计数，以及 `recovery_unavailable`。恢复正文仍受上游上下文窗口约束，可能增加输入 token；不自动截断或再摘要。正常流式响应交付与检查点提交不是跨系统事务，进程在两者之间退出时可能缺少检查点，后续安全失败。

## 验证与回退

### 2026-11-05 负向拦截与漏修修正

生产只读核对发现：#280213 已分类 compaction 解密失败，却跳过了此前资源冲突修复中的安全 ID 尝试，直接因缺少检查点结束；#280216–280221 随后被本地负向规则拦为 422。此时正文留存为 0，没有检查点。

第一阶段复用了 agentrouter/anyrouter 的 host quirk，当前已按后续要求迁入全局共享模块。遇到指向 compaction 的明确解密失败时，先保留密文仅移除 ID；不把这个错误直接当成“密文必然无法恢复”。定位仍按 item ID、input 下标或完整密文哈希匹配，缩略文本仅在没有其他加密状态载体时指向 compaction。ID 尝试可接在已确认的 reasoning/agent 修复之后，后续明确错误继续修复且不会重新带回已删字段。资源冲突的既有停止条件不变。

#280094 的无 ID compaction 为另一份状态，不是 #280213 密文的去 ID A/B，因此不能据它证明当前密文已不可用。离线以原请求/首次错误验证新路径：#280213 的 187 项输入和 90 项工具调用/结果完整保留；#280094 的 173 项输入和 96 项工具调用/结果完整保留。两者 compaction 密文及普通消息未改变，reasoning/agent 清理记为 degraded。后续响应在本地合成，不能据此声明真实上游已接纳。

本次没有启用正文留存、读取生产凭据、展开 33 级历史链或修改生产数据库/服务。既有 V2 检查点仅接受完整前缀或从 compaction 开始的窗口；部分保留/重排前缀仍不猜测合并。本次当前请求的字段修复不依赖该检查点路径。

### 后续全局化

既有资源冲突、密文错误的分类与全部已识别变体统一适用于任意域名/IP，不新增 host 配置或第二套解析器。compaction ID 的 `store=false`、无 continuation/reference、非空密文条件完整保留；reasoning/agent_message 的全局规则无需复制。agentrouter 原有的首发普通 item ID quirk、各 host 的模型/header 兼容逻辑不在此次扩大范围。

HTTP/SSE 回归覆盖 agentrouter、anyrouter、anyrouter 子域、普通 relay 域名与 loopback IP，包含原两类 code:null 连续报错、12 种资源冲突表现/包装变体、gzip、成功修复复用及留存为 0。普通域名/IP 在变更前有 100 项失败，确认它们确实被旧白名单挡住。原先重复按 host 参数运行的纯状态机单测合并为一次，域名差异由实际 HTTP 路由矩阵验证；存储引用、关闭恢复、成功首发、截断、取消和超时守卫继续测试。

专项测试覆盖用户原报文及反例、定位混合状态、资源冲突后的二次解密失败、四次上限、JSON/SSE、V1/V2、continuation、去重缓存、重启、作用域隔离、过期/容量、关闭留存和落盘失败。完整门禁在隔离副本运行 `npm run check`；不访问真实上游，不读取生产凭据，不改运行中服务或根 `dist/`。

### 有损续聊的实际故障依据

日志 #280462（11:23:55，agentrouter）已经识别新尾部 `gAAA...1pU=`：原始尝试、删除1个compaction ID、再删除42个reasoning密文和6个agent加密块，三次均400。完整抓包中的最终请求只剩 `input[31].encrypted_content`，55160字节，其SHA256与入站相同、尾部匹配报错；190项输入和90项工具调用/结果仍保留。这证明字段修复已执行，不是变体漏识别。旧实现随后因没有恢复材料停止；获准的有损路径允许在第四次移除该块，保留其余可见输入继续。

新增回归验证精准删除、歧义和引用守卫、缓存不能首发删历史、摘要/检查点优先、连续错误不重新引入压缩块、JSON/SSE降级标识与最后真实错误。关掉检查点后不恢复原先历史，只能在条件满足时有损续聊；有损尝试失败后的重启仍允许原状态再次被上游接受。所有验证不等同于真实上游接纳。

需要停用自动错误恢复（含有损续聊）时使用现有 `state_portability: "off"`；需要停用并删除恢复内容时另设留存为 `0`。新增 SQLite 表为附加表，不重写原日志 schema。恢复旧二进制前须注意不同版本对不透明上下文的保留/丢弃边界不同。
