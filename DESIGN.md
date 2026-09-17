# CompactGate 演进方案与 Rust 性能评估

日期：2026-09-16。适用于当前 Node、SQLite、React Studio 的内网部署。

## 范围与当前状态

本轮已实施审查中的八项非网络安全修复及四项交互优化。下述四项机制是后续设计；第一项中直接修复现有故障的结果传递、凭据失效和 Primary 占用所有权已实施，其余没有伪装成已上线功能。

不引入 Redis、PostgreSQL、多租户计费或新的通用网关框架；不修改现有网络安全策略；不把 Rust 重写当作优化前提。

## 1. 一份请求结果，一个占用所有者

所有者：`upstream-client.ts` 观察真实传输与流终止，`openai-proxy-transaction.ts` 保存结果，两个代理在结束路径交给对应密钥池。调度不得只根据 HTTP 200 判成功，也不能把客户端取消的内部 502 当成上游故障。

本轮落地：Claude 池接收已有 `streamOutcome/errorSummary`，取消只释放占用；同 ID 更换凭据或目标后仅失效该候选的健康及粘性，排序不重置健康。Primary 的预留绑定原健康实例，完成只释放一次，旧凭据请求不能扣减新请求的占用。默认 Claude 路由与档案路由执行相同结果规则。

后续统一边界：沿用现有结果字段，在共享结果分类处输出成功、客户端取消、鉴权、额度、限速、模型不兼容、请求形状、传输/流失败；两个池保留各自的冷却策略。Claude 如需硬并发控制，再把当前 `select/recordResult` 升级为显式、一次性请求预留，不能把当前签名比较当成完整的 reservation 协议。

重试沿用现有证据门槛。每次 attempt 明确记录是否已发送、发送状态是否不确定、是否已经向客户端交付；已交付内容后不能透明切换并重新生成。状态绑定优先于软粘性，不能用相同 relay host 或 key 推断 Azure resource 相同。

验收：HTTP 200 的错误/不完整流、客户端取消、头已发后的断流、旧请求晚完成、同 ID 换钥、无关候选变更、重复完成均有可观察回归；日志与健康判定一致，但不为调度改写客户端已经收到的 HTTP 状态。

参考的是请求持有并释放准入资源的边界，而不是照搬 Rust 类型层次：[AdmissionLease](https://github.com/zyycn/codex-proxy-rs/blob/3fbd447d94ea117ddae4b63a831c68554487f66a/backend/crates/gateway-core/src/engine/execution.rs#L1140)、[重试交付条件](https://github.com/zyycn/codex-proxy-rs/blob/3fbd447d94ea117ddae4b63a831c68554487f66a/backend/crates/gateway-core/src/engine/coordinator.rs#L1144)。

## 2. 在现有日志中解释“为什么选这把 key”

所有者：候选选择器和现有重试决策点产生事件；请求 transaction 汇总；`RequestLogger` 随请求保存；Studio 日志详情展示。禁止根据事后的配置或健康状态倒推当时决策，也不另建一套日志系统。

建议事件白名单：请求内递增序号、距请求开始的毫秒数、attempt 序号、候选 ID、原因码、HTTP 状态、结果类别、是否已交付。原因码覆盖 `priority`、`session_sticky`、`state_binding`、`cooldown`、`model_policy`、`retry_allowed`、`retry_denied`。可读 key 名称仅作为当时快照展示，不能代替身份。

存储：请求行新增可空 `decision_trace` JSON 列，启动时按现有迁移模式增列，旧行显示“未记录”。每请求最多 64 个事件，超限增加 `dropped_events`，保留起始选择和最终结果；不允许静默截断后仍声称完整。无需保存每个候选的完整配置。

界面：复用现有日志详情，在原始请求/响应旁增加折叠的“选择与重试”时间线。选中 key、跳过原因、冷却剩余时间和重试阻断原因优先展示；不为每个事件添加动画。

导出：从白名单重新构造诊断包，不直接复制日志对象。默认没有正文、认证头、直填密钥、令牌、上游自由文本错误、完整 URL；关联 ID 和固定原因码足以复核决策。保留现有原始 diff 作为用户显式访问的另一入口，不混入分享包。

验收：调序后旧会话命中粘性、新会话按优先级、健康隔离、同 host 内状态失败、已交付后不重试，都能从时间线解释；使用合成敏感标记验证导出不包含禁止字段。关闭采集后行为与调度完全不变。

参考：[诊断 UI](https://github.com/zyycn/codex-proxy-rs/blob/3fbd447d94ea117ddae4b63a831c68554487f66a/frontend/src/views/usage/components/RequestDiagnosticsPanel.vue#L77)、[白名单导出](https://github.com/zyycn/codex-proxy-rs/blob/3fbd447d94ea117ddae4b63a831c68554487f66a/frontend/src/views/usage/utils/diagnosticsBundle.ts#L58)。

## 3. 精确模型能力筛选

配置建议：上游路由和池内 key 均可选 `model_access: { mode: "all" | "allowlist" | "denylist", models: string[] }`。缺省为 all；all 必须为空列表，另外两种要求非空、去重的精确模型名，不支持 glob/正则。路由与 key 的政策取交集，不能互相覆盖放宽。

所有者：共享能力判断函数，接收该候选实际映射后的上游模型名。每个候选可能有不同模型映射，不能用一个客户端模型名预先过滤整个池。目录、预览与真实请求调用同一个判断；模型目录还需保留客户端别名，不能仅返回上游模型名。

顺序：解析路由/状态约束 → 对候选映射模型 → 能力筛选 → 健康/优先级/粘性选择。能力不允许时不发上游请求，也不增加健康失败；绑定所需候选被政策排除时明确报告冲突，不能自动转向另一资源。空候选返回明确的 `model_not_available`，不退回所有 key。

界面：在路由/密钥编辑器中增加默认折叠的模型能力设置，精确说明“这是本地筛选，不是上游授权”。沿用 config revision 保存与导入校验，未知/错误形状显式拒绝。

验收：不同 key 权限、候选特定模型覆盖、Claude 场景映射、禁用 key、粘性与 state domain 冲突、目录/预览一致性。回退前把政策显式改成 all；旧版本不认识该字段，不能静默降级后仍声称限制生效。

参考：[精确 allowlist/denylist](https://github.com/zyycn/codex-proxy-rs/blob/3fbd447d94ea117ddae4b63a831c68554487f66a/backend/crates/gateway-core/src/account/model_access.rs#L52)。

## 4. 有证据后增加有界等待

启动条件：合成负载或实际元数据证明并发/429 导致明显排队尾延迟；先测量，再确定并发上限及等待预算。现在不增加默认排队，以免降低当前轻负载响应速度。

所有者：进程内密钥池持有每个候选实例的活动数与 FIFO 等待者。一个请求仅在一个队列中；可切换候选时先退出旧队列。预留归属于实际凭据实例，不归属于可复用的 key ID。

配置建议：可选 `max_in_flight`、`max_pending`、`max_wait_ms`；默认无硬上限、无队列。启用后只等待容量，鉴权/额度/模型失败不排队。等待数满明确拒绝，不能无限累积 Promise。

请求进入时创建单一总 deadline，覆盖排队、连接、所有重试和读取；每阶段只消耗剩余预算，切 key 不能重新计时。取消立即移除等待者；预留在 finally 中且只释放一次。换钥/删 key 唤醒旧等待者重新检查，而不是让旧队列发往新凭据。关闭时停止准入，通知等待者，再有限时等待在途请求。

验收：FIFO、公平性、满队列、队中取消、刚获准即取消、deadline 耗尽、重试不延长预算、删 key、停机、重复结束；所有测试用可控时钟与合成上游。达到上限时不得超过实际并发额度。

参考：[有界等待与取消释放](https://github.com/zyycn/codex-proxy-rs/blob/3fbd447d94ea117ddae4b63a831c68554487f66a/backend/crates/gateway-core/src/concurrency.rs#L21)。不因此引入 Redis，也不宣称支持多进程全局限流。

## 实施顺序与回退

1. 当前正确性修复、完整门禁、交互复核。
2. 统一结果类别与请求级预留，保留现有策略差异。
3. 决策时间线和白名单导出，先让行为可解释。
4. 有实际模型权限差异后加能力政策；配置合同独立发布。
5. 根据压力测试决定是否启用队列，最后才评估语言替换。

每阶段独立变更与验证；持久化增列需迁移测试，配置变更需旧文件读入/新文件导出测试。回退不删除用户数据；旧版本保留不识别的新增 SQLite 列，受模型政策约束的配置禁止无确认降级。

## Rust 会更快吗，能快多少？

结论：Rust 有机会降低本地 CPU、内存和高并发尾延迟，但没有本项目同负载 A/B 基准，不能给出可靠倍数，更不能承诺模型回答快几倍。外部项目源码只能证明其功能设计，不能证明其速度。

本地可测热点：

- `upstream-client.ts` 已用 `response.pipe(res)` 转发原生响应；网络与模型生成等待不会因为换语言消失。
- `http-utils.ts:readRawBody` 完整收集请求并合并 Buffer；元数据、分类、路由等路径又分别解析 JSON，大上下文值得测量解析/复制成本。
- `logger.ts` 使用同步 SQLite；`setImmediate` 中执行同步 checkpoint/VACUUM 仍会占用事件循环。优先测日志写入、查询与清理并发时的延迟。
- 响应还会缓冲供解析/诊断使用；部分代理调用将缓冲上限设为 Infinity，不能把通用默认上限当成所有链路的内存保证。抓包开启后还有序列化及写文件成本。
- React 布局、动画排队、浏览器渲染不因后端 Rust 重写而直接变快。

同步 API 与阻塞执行的依据：[Node DatabaseSync](https://nodejs.org/docs/latest-v22.x/api/sqlite.html#class-databasesync)、[SQLite WAL 并发边界](https://sqlite.org/wal.html#concurrency)、[Tokio 的阻塞/CPU 任务说明](https://docs.rs/tokio/latest/tokio/index.html#cpu-bound-tasks-and-blocking-code)。换成异步 runtime 不会自动消除同步存储瓶颈。

条件估算：设可加速的本地处理占总耗时 p，这部分加速 k 倍，则新耗时比为 `(1-p)+p/k`。

| 本地可加速部分占比 | 该部分快 2 倍时，总耗时减少 | 该部分快 5 倍时，总耗时减少 |
|---|---:|---:|
| 1% | 0.5% | 0.8% |
| 5% | 2.5% | 4% |
| 20% | 10% | 16% |
| 50% | 25% | 40% |

这是数学条件示例，不是 Rust 实测；饱和后的排队延迟具有非线性，吞吐量与内存占用也要单独测。

基准方案：使用无真实凭据的本地合成上游，比较直连与代理；请求体 10 KiB/100 KiB/1 MiB/8 MiB，并发 1/10/50，分别覆盖立即响应和固定节奏 SSE、原生转发与协议转换、仅元数据与保存正文/抓包、日志查询与清理期间。记录 CPU、RSS、GC、事件循环延迟、代理新增耗时 p50/p95/p99、约束延迟下的吞吐量及取消后资源释放。

首字节、首个语义 token、完整响应分别计时：当前 `first_token_ms` 在第一个上游 data chunk 到达时记录，可能只是 `response.created`，不能直接当成首个语义 token 或纯上游耗时。事件循环测量可用 [monitorEventLoopDelay](https://nodejs.org/docs/latest-v22.x/api/perf_hooks.html#perf_hooksmonitoreventloopdelayoptions)。

推荐先减少重复解析和不必要缓冲。若证实 SQLite 阻塞，再评估单一数据库 worker 所有权，保留顺序与事务；若 CPU 热点依然明显，再做局部 Rust A/B，而不是先承担全量协议、压缩恢复、日志及 UI API 重写的回归成本。
