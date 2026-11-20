# 请求限制清单、默认上限移除与容量扩容

## 本次改动

公共 `readRawBody(req)` 不再默认以 10 MiB 拒绝请求；只有调用方显式传入 `limitBytes` 才检查累计字节数。未新增配置、依赖或留存机制，也不是把 10 MiB 换成更大的门槛。

- 普通 Responses、local/Remote V1/V2 压缩、Chat 均受益，和 host 无关：`src/server/openai-proxy.ts:244`、`:850`。
- 管理 JSON 复用该读取器，同样移除默认容量门控，但 JSON 与字段校验仍保留：`src/server/http-utils.ts:75`。
- Claude 原本显式指定 100 MiB，本次保持不变：`src/server/claude-proxy.ts:116`、`src/server/config-internals.ts:19`。
- 显式限额的 413、客户端中途断开、错误与排空语义不变：`src/server/http-utils.ts:90`。

后续按用户要求将请求解压及 Codex OAuth 单事件/累计输出项的 8 MiB 提高到 32 MiB，并将 `cg1_` 状态的 1 MiB 提高到 8 MiB。没有增加配置、缓存或会话留存；其他限制不变。下面是当前代码的静态分析，不是供应商容量保证。

## 仍会拒绝或中断真实代理请求的容量限制

| 限制 | 作用与失败行为 | 所有者 |
|---|---|---|
| Claude 原始正文 100 MiB | `/anthropic/*` 超出返回 413。固定值，不是 `long_context_bytes` 配置的当前值 | `src/server/claude-proxy.ts:116` |
| gzip/zstd 正文解压 32 MiB | `decodeBodyText` 超限捕获错误后返回空串。管理 JSON 变 400；需要 JSON 的协议转换也会失败；原生透传可能继续发送原字节，但分类、模型改写和元数据读取会失效。未压缩 JSON 不受该解压阈值影响 | `src/server/http-utils.ts:8`、`:256` |
| 成功完整 JSON、Remote V1 完整结果 32 MiB | 缓冲超限明确失败；响应头已发时中断连接，不能保证改写为 502；不缓存半截压缩结果 | `src/server/upstream-response-buffer.ts:2`、`src/server/upstream-client.ts:319`、`:435`、`src/server/openai-proxy.ts:975` |
| 跨协议 SSE/JSON 转换累计输入 32 MiB | 转换器累计读入超过预算后抛 `UpstreamResponseLimitError`，通常终止已开始的响应。这是转换输入总量，不是入站用户正文上限 | `src/server/protocol-stream.ts:1828`、`:1864`、`:1907` |
| 同协议 Anthropic 待解析单帧 32 MiB | 超大单帧中断；整个透明 SSE 流可以超过 32 MiB，不能与跨协议累计上限混为一谈 | `src/server/protocol-stream.ts:1680`、`:1752` |
| Codex OAuth SSE 单事件/聚合输出 32 MiB | `response.output_item.done` 聚合或单事件超限报错；包括流式客户端，不是只限制日志。事件预算包含 SSE 帧内文本、不含完整帧分隔空行；尚未完整到达的分隔前缀仍计入待解析预算。聚合预算按输出项 JSON 的累计 UTF-8 字节计算 | `src/server/oauth-response.ts:27`、`:74`、`:108` |
| 自产 `cg1_` 状态序列化 JSON 8 MiB | 编码超限保留 502；解码超限返回 null，使用该状态的跨协议转换可报 422。版本与包装字段计入 JSON 预算，不是编码后字符串上限，不限制所有 Responses 密文 | `src/server/protocol-conversion.ts:19`、`:22`、`:36` |
| 需暂存的上游错误正文默认 8 MiB | 等待重试/状态恢复的错误正文超限停止缓冲，相关路径返回本地 502，不能保留完整原始错误 | `src/server/upstream-client.ts:322`、`:443`、`:735` |
| CONNECT 代理响应头 64 KiB | 代理握手头超限失败，模型请求尚不能建立隧道，通常向客户端返回 502。不是模型正文或普通请求头的 64 KiB 限制 | `src/server/upstream-proxy-agent.ts:33`、`:236`、`:300` |

这些门槛仍可能挡住有效的大上下文或大输出。本轮只扩大解压、OAuth 与 `cg1_` 的预算；Claude 100 MiB、跨协议累计 32 MiB 和其他预算保留。解压超限仍沿用空串语义，不将其诊断为精确的容量错误。

## `cg1_` 的用途与扩容边界

`cg1_` 是本项目生成的带版本 base64url JSON 包装，不是密码学加密或签名。它携带 `compaction_summary`、`anthropic_thinking`、`anthropic_redacted_thinking` 或 `openai_reasoning`；原始供应商密文/签名在包装内保持原值，网关不解密它们。跨协议输出放进 `encrypted_content`、thinking 的 `signature` 或 redacted thinking 的 `data`，下一轮再由网关解码并还原目标协议。可读摘要也能由新建 bridge 直接恢复，不要求保存完整会话。

编解码共享同一 8 MiB 原始 JSON 预算，避免网关生成下一轮自己拒收的状态；旧 `cg1_` 版本和字段没有迁移。状态可包含大摘要/思考文本，因此移除原来“最多几 KB”的错误注释。base64 编码约膨胀三分之一，thinking 还可能同时出现在可读字段，8 MiB 给既有 32 MiB 整响应预算保留包装空间，但不保证多个状态、重复 SSE 事件或其他内容总和都能通过。删除 `cg1_` 会丢掉跨协议往返所需信息，不是提高容量的替代方案。

本轮不扩大普通 SSE 的 8 MiB 诊断/观察副本、响应诊断解压 8 MiB 或上游错误正文 8 MiB；这些预算的作用不同。Codex OAuth 到 Anthropic 的组合转换仍受后续累计 SSE 输入 32 MiB 约束，单事件扩大不能绕过它。

OAuth 扩容暴露了原 SSE 分帧器每块重新拼接、扫描和计算整个待解析帧的成本。仅在同一个转换器内改为分块暂存、增量 UTF-8 计数、保留至多三个 ASCII 分隔前缀字符，完整帧时合并一次；不更改 JSON、terminal、聚合、超限或 EOF 处理合同，也不放宽生产或测试超时。合成 32 MiB 超限帧按 64 KiB 分块的独占单次复现从约 4771ms 降到 41ms；这不是生产吞吐或并发压力结论。

## 时间、重试与恢复边界

- 总请求预算默认 Primary 120 秒、Compact/Claude 900 秒，可通过既有 `timeouts` 修改。上传读取、本地 OAuth 准备、自动档案提交等待、此前尝试和退避共用总预算，耗尽返回超时或中断，不能把每次重试重新算一份预算。已开始的共享授权刷新或原子配置提交不会因某个请求结束等待而被取消；完整后台提交及通知仍由服务生命周期排空。依据：`src/server/request-preparation.ts` 的 `waitForRequestPreparation`、`src/server/openai-proxy.ts` 的 `proxyOpenAiRequest`、`src/server/claude-proxy.ts` 和 `src/server/upstream-client.ts`。
- compact 的 502/503/504 最多重试 3 次（总计 4 次），普通 Responses 的特定空流错误只重试一次；重试等待单次最多 8 秒并受剩余预算限制。耗尽后保留失败，不是按正文大小拒绝。依据：`src/server/openai-proxy.ts:465`、`:979`、`src/server/upstream-client.ts:617`、`:691`。
- provider-state 恢复最多尝试 4 个不同正文，内部传输重试另计；无法恢复时交付实际上游错误。成功规则缺少材料不会预先拦截原生 Responses 首发。依据：`src/server/provider-state-migration.ts:61`、`:93`、`:105`。
- split bridge 或非原生目标缺少可读摘要/完整恢复材料仍可能返回 422，这是无法表达/恢复的语义拒绝，不是新的 10 MiB 门槛。依据：`src/server/openai-proxy-plan.ts`、`src/server/compaction-bridge.ts:72`。
- 历史检查点默认不留存；显式开启后单项最多 4 MiB、合计 64 MiB，超限不保存或淘汰旧项，不截断历史。这会降低后续恢复可用性，但本次成功请求不会因此被直接拒绝。成功策略最多 8192 项/24 小时；这是规则元数据 TTL，不是强制 24 小时保存对话，也没有重新引入失败负向缓存门控。依据：`src/server/provider-state-recovery-store.ts:23`、`:45`、`:58`、`:92`。

没有发现当前实现仍要求固定“33 级压缩依赖链”：检查点保存已恢复的历史窗口，不按该级数接纳请求。容量与恢复材料可用性依然有限，不能宣称删除入口限制就能无损恢复任何历史。

## 管理页面与授权相关限制

这些不会限制普通模型代理正文，但会拒绝、结束特定管理请求。

| 限制 | 结果 | 所有者 |
|---|---|---|
| 统计/下钻范围最多 31 天 | 传 `calendar_tz` 按该时区实际覆盖的自然日计数，省略则最多 744 小时。超出返回 400 | `src/server/api-runtime-routes.ts:460` |
| 日志下钻 model 筛选最多 8192 字符 | 超出 400 | `src/server/api-runtime-routes.ts:448` |
| 执行中与排队的统计查询合计最多 8 项 | 第 9 项返回 503 和 `Retry-After: 1`。搜索、下钻和维护不占统计名额。超时重建 worker 期间仍按同一名额接收统计查询 | `src/server/log-stats-reader.ts:60`、`src/server/api-runtime-routes.ts:260` |
| 单个统计查询从开始执行起限时 60 秒 | 超时仅该查询返回 500。已排队的任务等待旧 worker 退出，先执行维护，再继续读取。关闭服务或 worker 意外失败会结束等待任务 | `src/server/log-stats-reader.ts:105`、`:126`、`:163`、`:190` |
| Studio `/api/events` 最多 64 连接 | 第 65 个 429 | `src/server/studio-events.ts:20`、`:36` |
| Studio 后续帧积压 8 MiB / 无 drain 30 秒 | 单个合法大帧按 64 KiB 分片，不因超过 8 MiB 拒绝；后续帧积压超限或写入持续停滞才销毁该推送连接，不截断模型 SSE | `src/server/studio-events.ts` |
| pending OAuth 会话最多 8 项 | 新授权返回 409；完成或取消旧会话后重试 | `src/server/oauth-store.ts:123` |
| OAuth 单次提供商 JSON 1 MiB / 30 秒 | 超限取消授权/刷新等调用，通常 502；主动取消或会话失效可为 409 | `src/server/oauth-providers.ts:110`、`:131`、`:146` |
| OAuth 会话初始 10 分钟；设备轮询间隔 | 过期或非 pending 状态不能继续授权；过早轮询按已有状态返回，不执行新上游调用；设备流按提供商到期时间更新 | `src/server/oauth-store.ts:128`、`:145`、`:178`、`:386` |
| Codex 浏览器回调头 5 秒 / 请求 30 秒 | 仅 OAuth 回调服务；固定端口 1455 被占用时启动授权返回 409 | `src/server/oauth-store.ts:352`、`:369` |
| 静态资源首次可读等待 5 秒 | 文件仍不可读时 503/no-store；不是所有静态下载 5 秒截止，且同步 stat 等等待不受此计时器覆盖 | `src/server/static-assets.ts:77` |

配置写入也会被以下自设约束拒绝，但已保存合法配置下的普通对话不会因这些字段计数再次变成 413：

- 每路由 `api_keys` 最多 16 项；直填 key 可另参与池，勿当作每个 host 的对话并发上限：`src/server/config-runtime.ts:299`。
- `extra_headers` 最多 64 项，名称和值累计 UTF-8 字节不超过 16 KiB；保留受保护头与合法 HTTP 头校验：同文件 `:329`。
- 已校验的模型覆盖/Claude 角色模型值最多 256 字符，`state_domain_id` 和 Claude 场景 profile ID 最多 256 字符；并非所有客户端 model 一律 256：同文件 `:280`、`:384`、`:398`。
- 手工 User-Agent 最多 512 字符；OAuth label 100、Google client ID 256、client secret 512、project/location 63；OAuth 通用字符串读取默认 32768：`src/server/client-identity-store.ts:41`、`:588`、`src/server/oauth-providers.ts:80`、`:424`。
- `logging.keep_recent` 为 1–2000、`claude.long_context_bytes` 为 0–100 MiB、恢复留存为 0–720 小时、timeout 为 1–2147483647 毫秒、密钥优先级为 0–100。日志字节预算要求正整数。依据：`src/server/config-runtime.ts:90`、`:120`、`:246`、`:252`、`:505`。

## 不应误报为模型入口拒绝

- 普通原生 SSE 的 8 MiB 诊断副本，以及 8 MiB 单事件观察预算：只截断副本或放弃超限事件的元数据，不主动限制成功透明交付。工具层未指定的单事件默认值仍为 64 KiB。`src/server/upstream-response-buffer.ts:1`、`:4`、`src/server/upstream-client.ts:428`。
- 响应诊断解压 8 MiB 超限返回 null，影响用量、错误解析和检查点保存；不是所有响应传输的硬上限。`src/server/usage-utils.ts:11`、`:81`。
- provider-state 早期 SSE 前缀最多 64 KiB/1 秒：超限或超时释放原流、停止提前恢复，不是 413/422。`src/server/provider-state-stream.ts:7`、`:31`。
- GPT/Fernet 密文格式识别最多 32 Mi 个 JS 字符：超限判为无效包络，影响恢复策略；不直接返回 HTTP 容量错误。`src/server/provider-state-portability.ts:66`、`:120`。
- 管理模型目录默认响应 1 MiB，超限通常返回 HTTP 200 `{models: [], error: ...}`；普通上游目录使用对应路由 timeout，OAuth 专用目录会收紧至 30 秒。不是普通 `/v1/models` 代理的 1 MiB 门槛。`src/server/upstream-json-client.ts:60`、`src/server/upstream-models.ts:37`、`src/server/oauth-transport.ts:146`。
- compact 能力探测最多 512 KiB/30 秒，超限显示 `supported: false`，不限制真实压缩请求。CLI 版本目录刷新最多 512 KiB，只影响身份刷新。`src/server/compact-capability-probe.ts:19`、`src/server/client-identity-store.ts:36`、`:541`。
- 日志正文最多 8 Mi 个 JS 字符、抓包单段默认 8 MiB、抓包解压展示 8 MiB、受管抓包默认 20 GiB、日志库默认 1 GiB：截断/回收留存，不直接拒绝代理正文。合成压缩摘要最多 200000 字符，超出带标记截断。`src/server/proxy-support.ts:32`、`src/server/debug-capture.ts:18`、`src/server/capture-body-decode.ts:9`、`src/server/config-defaults.ts:139`、`src/server/compact-response-normalizer.ts:31`。
- 桥接缓存 512 项/2 小时、压缩去重 128 项/2 分钟，预设每种最多 24 项、配置备份最多 10 份：淘汰旧项而非拒绝新对话；桥接材料失效仍可能影响后续语义恢复。`src/server/compaction-bridge.ts:82`、`src/server/config-route-presets.ts:27`、`src/server/config-file-repository.ts`。
- CONNECT agent 缓存最多 8 个、每目标空闲连接 2 条、每代理空闲 8 条/4 秒，业务已结算后的尾部排空最多 500ms/64 KiB/8 条并发：限制复用与收尾，不拒绝新的模型请求。`src/server/upstream-proxy-agent.ts:11`、`:126`。
- Primary/Claude 的健康隔离、限速冷却与 sticky-only 区域改变选择；全部受阻时仍选择回流候选，不是本地统一 429/503 接纳门控。没有发现生产代理入口按固定并发数拒绝对话。`src/server/primary-failover.ts:449`、`src/server/claude-key-pool.ts:125`。

## 应继续保留的合同与验证边界

管理 Host/Origin 保护、loopback profile 选择、OAuth state/可信域/账号授权、配置 revision 冲突、删除确认、协议错配 400、无法表达的转换 422、无终态/HTML 成功响应的显式失败，都不是可随大小限制一起删除的任意数字门槛。WebSocket upgrade 的 426 用于客户端回退 HTTP。依据：`src/server/http.ts:218`、`:286`、`src/server/request-profile.ts`、`src/server/protocol-conversion.ts`、`src/server/oauth-store.ts`。

本次回归先在旧实现证实 7 项大正文均返回 413，之后 6 种代理路径（包含 chunked）和管理 JSON 可接受超过 11 MiB 的正文；上游收到完整 JSON 与 Unicode 尾部。显式限额的恰好边界、累积超限和零限额继续有效，非法管理 JSON 仍为 400，客户端取消及配置代次等相关回归保持通过。

隔离完整 `npm run check` 通过：162 个文件、2527 项测试通过，1 项既有私有抓包 fixture 缺失跳过，类型检查与构建通过。未读取生产凭据或真实会话、未测真实供应商边界、未进行内存压力测试，也未提交/push/切换现有服务。

后续扩容先在旧容量实现下证实 15 项相关测试失败；最终完整 `npm run check` 通过：163 个文件、2558 项通过、1 项相同既有 fixture 缺失跳过。覆盖解压 32 MiB 恰好边界及 +1 字节、OAuth 32 MiB 单帧/累计输出边界、LF/CRLF/混合分隔与 Unicode 分块、EOF/multiline/comments、cg1 8 MiB 编解码边界、旧版状态和大摘要/思考/原始供应商状态往返。原网络超限测试超时保持不变，得到容量错误而非超时。

隔离构建产物的 Codex JSON/SSE 与 Claude JSON/SSE 四种 HTTP 冒烟均保留超过 9 MiB 的完整输出、Unicode 尾部和正确终态；每种仅一次合成上游请求。源码与隔离副本一致，现有 PID 18987 / 127.0.0.1:7865 和根 `dist` 指纹未变。验证证据在 `.codex-tasks/20261118-payload-budgets/raw/`；未新增依赖、留存、生产配置修改或部署，未做真实上游联调/并发内存压测。

请求读取仍使用 `Buffer[]` 和最终 `Buffer.concat`，分类与转换还会解析完整 JSON。移除 10 MiB 接纳门控并不使内存无上限；大正文/高并发可能使进程停顿或耗尽内存，供应商与 Node HTTP 自身的限制也仍存在。后续若要进一步取消其他容量限制，应先选择需要透明转发还是必须解析/重放的路径，再评估其资源代价；不能用吞错、截断对话或假成功替代真实错误。
