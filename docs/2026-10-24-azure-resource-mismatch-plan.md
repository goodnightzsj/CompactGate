# Azure 跨资源错误与 Go 解码包装：方案及既有修复复用评估

日期：2026-10-24。状态：定向识别修复及隔离验证已完成；用户反馈原失败场景重跑未再出现该报错。本轮不执行部署。下文保留修复前调查与方案，实施结果和用户反馈见末节。

调查基线：CompactGate `HEAD=dc7c4f5` 加当前工作区既有修改。前一轮调查仅新增本文；本轮实施只改目标识别、相关测试及对应说明，原有无关修改全部保留。项目定位依据是本仓库存在完全相同的 Azure 错误识别与回归测试。

## 结论

本项目确实修过同类错误，而且已有可以直接复用的安全恢复路径。本次优先补齐错误包装形态的识别，不新建通用恢复框架，不把之前的通用资源绑定建议直接套成项目改造。

用户提供的报文包含两层失败：

- 内层 Azure 错误：对象在不同 Azure OpenAI resource 下创建，当前资源不能访问；`error.code` 是数字 `0`，`error.type` 是 `invalid_request_error`。
- 外层 Go 中转错误：`failed to decode error response: json: cannot unmarshal number into Go struct field ***.***.code of type string, raw: ...`，把内层 JSON 嵌入外层 `error.message`；外层 `code=null`。

CompactGate 的服务端是 TypeScript。现有 JSON 解析能够接收数字；直接 Azure 报文的 `code=0` 不是本地恢复失败的原因。产生 Go 解码错误的具体服务尚未定位，不能把 Go 结构体修复安排到本仓库。

已用合成报文证实：在现有 agentrouter、HTTP 400 和可恢复请求的条件下，外层 Go 包装使 Azure 定向恢复漏匹配。用户原请求的实际 host、HTTP status、请求状态形态和运行中构建版本尚未核实，因此这是已证实的代码覆盖缺口，不是对线上完整根因的最终认定。

## 历史修复及可借鉴范围

| 提交 | 已核实的修复 | 本次复用与边界 |
| --- | --- | --- |
| `a3cbf01`，2026-09-14 | agentrouter Responses 首发清理历史 input item ID | 复用最终上游确定后应用 host quirk 的位置。不能恢复旧提交的宽泛删 ID 行为，应以随后收紧的现实现为准。 |
| `f4ceca9`，2026-09-15 | 收紧首发 ID 白名单；增加 Azure 错误驱动的 compaction ID 单次恢复 | 本次最直接的复用点：只删 `compaction.id`，保留密文、工具关联和其余上下文；失败不升级 CPA/strict。 |
| `9efe3e2`，2026-10-06 | 错误专用恢复不再无条件附带 CPA 清理 | 保留“修复指定问题，不顺便删别的状态”的原则，不借包装兼容扩大请求改写。 |
| `5c9ba53`，2026-08-23 | 泛化失败证据不再以整个响应体哈希区分，避免每次 trace/request ID 都生成新计数键 | 内外 trace 只用于诊断，不作为稳定错误类别，也不纳入新的失败身份。 |

历史提交说明中的抓包结论仅作为既有记录；本次没有重读历史生产抓包，也没有做真实删字段 A/B。

### 调查时的权威执行点（修复前行号）

- [host-quirks.ts](../src/server/host-quirks.ts)：`HOST_BODY_QUIRKS` 在第 89 行；`recoverAgentrouterCompactionIds` 在第 161 行；第 173 行使用 `error.message.startsWith(message)`。
- [openai-proxy-plan.ts](../src/server/openai-proxy-plan.ts)：第 247 行起，在最终 host/protocol 已确定后应用 body quirk。
- [provider-state-migration.ts](../src/server/provider-state-migration.ts)：第 103 行起，先处理 host repair，再考虑通用错误专用或泛化恢复；命中但无法安全删 ID 时直接结束。
- [openai-proxy.ts](../src/server/openai-proxy.ts)：第 370 行控制 `recover_on_error` 与原生 Responses；第 387 行起控制泛化恢复证据；第 584 行控制客户端响应提交、连接状态和总时间预算。
- [provider-state-portability.ts](../src/server/provider-state-portability.ts)：第 168 行的错误码解析器只认既有明确错误；Azure 资源冲突不应伪装成 `invalid_encrypted_content`。
- [provider-state-evidence.ts](../src/server/provider-state-evidence.ts)：第 32 行的稳定失败身份，以及第 47 行的泛化失败资格。
- [provider-state-domain.ts](../src/server/provider-state-domain.ts)、[provider-state-binding.ts](../src/server/provider-state-binding.ts)：已有 profile/key/origin 或显式 `state_domain_id` 域与哈希身份，不另建第二份绑定。
- [openai-proxy.ts](../src/server/openai-proxy.ts)：第 464 行起，仅完整成功后提交绑定；[logger.ts](../src/server/logger.ts) 第 204 行已有事务、代次和过期边界。

相关架构背景见本地 `llmdoc/architecture/provider-state-portability.md` 与 `llmdoc/architecture/primary-failover.md`。llmdoc 由仓库忽略规则排除，不纳入本次提交；前者已按后续授权局部同步，后者未改动。

## 为什么旧修复没有覆盖这次形态

### 定向恢复漏匹配

现有定向恢复要求：agentrouter 主域或子域、HTTP 400、外层 `error.type=invalid_request_error`，且外层 message 以完整 Azure 错误原文开头。允许尾部 trace，但不支持前部 Go 解码包装。

本次 message 以 `failed to decode error response` 开头，因此返回 `null`，无法进入原有仅删 compaction ID 的分支。现有函数不检查 `code`，直接报文中的 `0`、`"0"` 和 `null` 都能命中；无须在 CompactGate 全局将数字错误码改成字符串。

### 漏匹配还有清理范围风险

未命中 host repair 后，包装报文仍可能满足泛化失败的类型筛选：

- 没有目标无状态成功记录等证据时，不重试，原错返回。
- 来源域与目标域相同且已知时，泛化分支也不会启动。
- 若满足目标健康及跨域证据，或未知来源失败阈值，则可能进入 CPA/`cross_domain`。

合成状态机验证中，包装报文配合明确为正的泛化证据决策，会执行 `original -> cross_domain`，删除不透明 compaction 并记录 `degraded`。这不代表线上已经发生，但说明补齐识别也是保护原有“Azure 定向失败不扩大清理”边界。

## 收敛后的实施方案

### A. 本仓库：扩展现有定向错误识别，保留原始响应

在 `host-quirks.ts` 的同一恢复入口内处理两种已知格式，必要时使用该文件内的私有解析函数：

1. 直接 Azure error 保持现有识别。
2. 对本次已观察到的 Go decode 包装，先验证固定包装前缀和 `raw:` 分隔格式，再提取一层内嵌 JSON；只允许已知的尾部 trace 形式，不递归遍历任意字符串或未知错误链。
3. 复用 `parseJsonRecord` 的解码和对象检查；验证内层 `error.type` 与完整 Azure message 前缀。数字 `code` 只作为上游字段保留，不据此推断成功或其他错误类别。
4. 格式不完整、JSON 畸形、未知包装或响应已截断时，不猜测、不触发定向重放；保留真实失败和可诊断信息。
5. 识别结果只用于内部恢复决策，不重写客户端收到的原始错误，不丢外层 Go 故障或内外 trace，不创建新的公开错误码。

不能仅把 `startsWith` 改为任意 `includes`：这会把错误正文中引用、回显或无关嵌套的同一句话也当成可恢复故障。也不需要实现适用于所有供应商的通用错误展开框架。

### B. 直接复用既有单次 compaction ID 恢复

继续要求原生 Responses、`state_portability=recover_on_error`、已批准的 host 与 HTTP 400，不因内嵌文本擅自扩大到所有 host 或 5xx。

请求仍须满足 `store=false`、无 `previous_response_id`/camelCase alias、无 stored/untyped item reference、compaction 同时带字符串 ID 和非空密文。只删除这些 compaction 的 `id`。

不改变以下不变量：

- 首发仍使用既有计划与 host quirk 后的请求，不新增通用预清理。
- 同一次恢复固定原先选择的 URL 和凭据，沿用现有 header 重算、取消和超时边界。
- 最多增加一次请求；第二次失败直接返回最后一次真实失败，不因错误类型变化继续 CPA/strict。
- 已识别 Azure 故障但不能安全删 ID 时，继续返回“已识别、零改动”的结果，阻止落入更宽清理。
- 不删除密文、reasoning、`call_id`、MCP approval/local-shell 关联字段，不改写工具参数或业务 metadata。
- `exact` 只说明本次转换保留了上下文载荷，不保证另一个 Azure resource 能解密。

候选改动面应以 `host-quirks.ts` 为主，补充现有 [provider-state-migration.test.ts](../test/provider-state-migration.test.ts) 与 [agentrouter-recovery.test.ts](../test/agentrouter-recovery.test.ts)。只有调用合同确有需要才改协调器，不增加新的重试器或持久表。

### C. 资源归属：修正在能控制实际 Azure 后端的一层

前一轮通用建议中的“绑定实际 Azure resource”仍是根因治理方向，但不能误称 CompactGate 已能控制它：

- 当前 state domain 是 CompactGate 可见的 profile/key/origin，不能证明同一个第三方 URL/key 后面的 Azure resource 固定。
- `state_domain_id` 只声明状态兼容关系，不会改变第三方网关的负载均衡行为；填相同值不能修复真实资源冲突。
- 若上游中转内部轮换 Azure resource，需要上游提供稳定路由/会话亲和或按资源分离的入口。只有获得该可验证合同后，才复用现有绑定表达它。
- 项目支持用户显式切换 active profile；本次不能擅自改成永远回到旧 profile，也不改变既有 `recover_on_error` 的产品语义。
- 若原资源不可达、状态不透明且无完整历史，不能承诺无损跨资源迁移。不要为本次包装兼容新增 canonical history 存储、迁移锁或 capability registry。

### D. Go 解码缺陷：交由实际所有者修复

定位产生 `failed to decode error response` 的中转层后，在其共享上游错误解析边界处理字符串、数字、空值与缺失的 code。可用 `json.RawMessage` 保留类型，按已有对外合同转换；避免经过浮点转换丢失数字精度。

同时保留 HTTP 状态、原始错误类型、message/param 和 trace。不可因为解码失败把真实上游问题伪装成成功，也不应将所有数值 code 归类为同一个业务错误。此项不是 CompactGate 的 TypeScript 修复，未获得对应仓库与授权前不实施。

## 验收要求

实施时应新增以目标行为为断言的回归测试；本次观测测试故意验证当前缺口，不能作为“修复完成”的验收。

- 直接错误的数值、字符串、null/缺失 code，以及已知 Go 包装，都能在相同安全条件下进入同一 Azure 定向分支。
- 内外 trace 每次不同、已知尾部换行及 JSON 字符串转义不影响稳定分类。
- 无效内嵌 JSON、截断响应、未知包装、HTML、无关 message 引用不误匹配。
- 非目标 host、相似后缀、非批准状态码、`off`、非原生 Responses 不新增恢复行为。
- stored history、previous response、item reference、无 compaction ID/密文等不安全条件不重放；已确认的 Azure 错误也不退入 strict。
- 修复请求仅缺少 compaction ID，密文、其他 input、工具关联保持不变；canonical Buffer 不被修改。
- 最多两次发送且同 URL/凭据；第二次即使返回 `invalid_encrypted_content` 或 5xx，也不发第三次。
- HTTP JSON 和流式请求入口均覆盖；现有 gzip 覆盖保留，响应已提交、客户端取消、预算不足时不重放。
- 完整成功才提交绑定；原始失败仍保留；日志不新增原始密文、凭据或完整会话历史。
- 具备真实上游证据后再做授权的 A/B；合成上游第二次返回成功不证明 Azure 本身接受去 ID 请求。

## 修复前调查验证记录

隔离目录：`/tmp/compactgate-azure-review.xzaWwl`。复制当前源码、必要测试及已安装依赖，不复制生产配置、日志库或抓包；无依赖安装、无外部 API 请求。临时 HTTP fixtures 使用 `127.0.0.1` 的系统分配空闲端口。

执行命令：`node node_modules/vitest/vitest.mjs run test/host-quirks.test.ts test/provider-state-migration.test.ts test/agentrouter-recovery.test.ts test/azure-wrapped-error.review.test.ts --no-cache --reporter=dot`。

结果：4 个文件、66 项通过。其中 59 项为既有相关测试，7 项为临时观测测试；Node `v22.22.0`，实际安装的 Vitest `4.1.7`。仅出现 Node SQLite experimental warning，无失败重跑。

临时观测测试仅在隔离目录，随临时目录清理后可能消失。可复现的条件与结果如下：

| 合成输入/条件 | 实际观测 |
| --- | --- |
| agentrouter、HTTP 400、直接 Azure message，code 分别为 `0`、`"0"`、`null` | 识别成功，允许删除 1 个 compaction ID，密文保持原样 |
| 同一内层 error 嵌入本次 Go 包装格式 | 定向识别返回 null；泛化类型筛选为 true |
| 包装错误，`store=false`、Remote V2 compaction、无泛化证据，真实本地 HTTP 链路 | `stream=false/true` 均只发 1 次，返回原始包装 HTTP 400，compaction 不变 |
| 包装错误，协调器收到明确为正的跨域泛化证据决策 | `original -> cross_domain`，移除 1 个不透明 compaction，fidelity 为 `degraded`；这条是状态机条件测试，不是线上证据 |

测试前后生产监听均为 `127.0.0.1:7865`，PID 均为 `99210`；根 `dist/server/main.js` SHA-256 均为 `20a0b910c71927862475d5cadfe03e1083d97a2aa1e9f6c235131f0618b785c4`。未执行构建、重启、部署或配置写入。本文差异空白检查及 14 个本地链接存在性检查通过。

## 未决项与线上验证边界

需要最小运行时证据：失败请求实际 host 与 HTTP status、是否原生 `/v1/responses`、`store`/续接引用/compaction 的字段形态、使用的 `state_portability` 模式，以及当前服务构建是否包含上述提交。只需脱敏元数据，不索取凭据或完整对话。

本轮已按“包装回归先失败、原有 host repair 最小修复”的顺序完成实现。后续若取得实际 host/status，才据此决定是否需要另外扩展支持范围；不擅自改全局调度、重放次数或严格清理策略。

## 前一轮公开参考

以下为前一轮已阅读的资料，本次未重新联网核查，也未把外部项目配置当作本项目合同：

- [GCMP #345](https://github.com/VicBilibily/GCMP/issues/345)：同类多资源与推理状态回放问题；关闭密文后的明文摘要回传又引出后续修复，说明不能机械删除字段或照搬 `include:null`。
- [Svar changelog v0.7.87](https://cljdoc.org/d/com.blockether/svar/0.7.126/doc/changelog)：外部项目有同类恢复先例，但不是本项目已部署或无损迁移的证据。
- [Azure Responses encrypted reasoning](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/responses#encrypted-reasoning-items)：`store=false` 不等于请求不再携带 provider-owned 推理状态。

优先级：本项目当前实现、测试和明确合同高于外部方案；线上故障结论仍需真实链路证据。

## 实施结果（2026-10-24）

### 最小改动及复用

- [host-quirks.ts](../src/server/host-quirks.ts) 第 193 行新增一个私有识别谓词，第 169 行由原恢复入口调用。接受直接 Azure 错误和已观察到的一层 Go 数值 code 解码包装；沿用 `parseJsonRecord`，严格校验内层类型及完整消息前缀。只允许已知末尾 32 位十六进制 trace，不递归展开或任意匹配正文。
- 直接复用 `f4ceca9` 的 compaction ID 单次尝试及零安全改动时停止宽泛清理的行为；没有修改协调器、首发改写、绑定、公开错误、配置或依赖声明。保持 `9efe3e2` 的定向修复不附带 CPA 清理原则，trace 不进入新的失败身份。
- [host-quirks.test.ts](../test/host-quirks.test.ts) 第 188 行增加直接 code 类型、已知包装、格式变化及无效格式反例；[provider-state-migration.test.ts](../test/provider-state-migration.test.ts) 第 268 行和 [agentrouter-recovery.test.ts](../test/agentrouter-recovery.test.ts) 第 41 行对直接/包装格式共用原有守卫与 HTTP/SSE 回归。
- [README.md](../README.md) 的 agentrouter 定向恢复段落同步支持范围。用户随后授权更新文档，本地 `llmdoc/architecture/provider-state-portability.md` 第 157 行已补充包装识别范围及用户重跑反馈；保持既有忽略规则，不强行纳入 Git。

### 验证证据

隔离目录为 `/tmp/compactgate-azure-fix.y6MiK8`，仅使用源码和合成 fixture，没有复制生产配置、凭据、日志库或抓包。HTTP 测试使用本地系统分配的端口；未启动持久预览服务。

| 检查 | 结果 |
| --- | --- |
| 新增回归在旧实现上运行 | 20 项预期失败、92 项通过，证实包装漏判和不应进入宽泛清理的停止边界 |
| 修复后同一组相关测试 | 3 个文件、112 项全部通过 |
| 首次全量测试 | 144 个文件、1539 项通过，1 项跳过；另有 1 个 UI worker 因缺少 jsdom 启动失败，保留为失败记录 |
| 核实并修复隔离验证环境 | 根仓库 `npm ls jsdom --depth=0` 为空，但已有清单声明 `jsdom@27.4.0`；仅在隔离副本执行 `npm ci --ignore-scripts --no-audit --no-fund --userconfig=/dev/null`，原仓库依赖未动，清单/锁文件哈希与副本一致 |
| 按锁文件补齐后全量测试 | `npm test -- --no-cache --reporter=dot`：exit 0，145 个文件、1547 项通过，1 项按既有生产抓包存在性条件跳过 |
| 严格类型与样式 | `npm run typecheck:strict`、`npm run lint:style` 均 exit 0；补齐依赖后再次通过 |
| 隔离构建 | `npm run build`：exit 0，前后端 TypeScript 和 Vite 构建通过 |

测试包含 gzip 包装、直接/包装错误保留、JSON/SSE、同 URL/凭据最多两次发送、第二次错误改变也不继续重试，以及取消/预算/截断/存储引用/缺失 ID 或密文时的边界。SQLite experimental 和既有本地 TLS fixture 的警告保留，没有屏蔽。1 项跳过测试依赖生产抓包，不为消除 skip 读取任务外数据。

修复阶段差异空白检查及当时 19 个本地文档链接存在性检查通过；4 个目标源码/测试文件、README、清单与锁文件共 7 个文件，与实际测试副本逐字节一致。提交阶段将未纳入版本控制的 llmdoc 引用改为普通路径，避免远端链接失效。

生产监听仍为 `127.0.0.1:7865`、PID `99210`；根 `dist/server/main.js` SHA-256 仍为 `20a0b910c71927862475d5cadfe03e1083d97a2aa1e9f6c235131f0618b785c4`。未构建根 dist、未重启或部署；原有无关修改保留。执行记录见 `.codex-tasks/20261024-azure-wrapped-error-fix/`。

### 用户实际验证反馈

2026-10-24，用户反馈：此前会出现该错误的请求重新运行后，已不再出现此报错。该反馈记录了原失败场景的实际重跑结果，但不等同于对特定恢复分支的去 ID A/B 证明。本轮没有独立读取生产日志、请求内容或核实实际 Azure resource，也没有执行服务切换。

本次完成的是 CompactGate 在既定 agentrouter/HTTP 400 范围内的安全识别补齐。用户反馈支持原失败场景已不再复现；不据此保证任意跨资源密文兼容，Go 解码缺陷与实际 Azure resource 路由归属仍由对应上游负责。

### 提交范围与提交快照验证

本次提交仅含 `host-quirks.ts`、三个相关测试文件、README 的 agentrouter 段落及本文，共 6 个文件；其他已有工作区修改不混入。llmdoc 仅按授权本地同步，继续遵循既有忽略规则。

另在 `/tmp/compactgate-azure-commit.L3gSeG` 从 `dc7c4f5` 导出构建所需源码与测试，只应用这 6 个文件的暂存差异，并按该提交的锁文件安装隔离依赖。完整 `npm run check` 按原顺序执行差异检查、样式检查、严格类型检查、全测试和前后端构建，exit 0：140 个测试文件、1492 项通过、1 项既有生产抓包条件跳过。测试数少于工作区验证，是因为未混入其他尚未提交的测试和功能修改。未复制生产配置、凭据或抓包，未部署。

## 后续兼容：Responses bad-request 前缀（2026-10-27）

用户补充的 `invalid_request_error` 在完整 Azure 原文前多出固定的 `OpenAI Responses bad request: `，其 `code=null` 和尾部 trace 已在既有支持范围内。原谓词因首部不匹配而漏判；新增回归在原实现上出现19项预期失败，其余129项通过。

本次只在 [host-quirks.ts](../src/server/host-quirks.ts) 的原私有识别谓词接受这一紧邻完整 Azure 原文的前缀，不改恢复协调器。只在此前批准的 agentrouter、HTTP 400、原生 Responses、recover_on_error 及可安全去 ID 的条件下重试一次；不能安全修复或第二次仍失败时继续保留原错误，不升级 CPA/strict，不删除密文。未知前缀、引用、不完整消息、错误类型不符和递归包装不新增恢复行为。

三个既有测试文件增加相同报文形态的识别、守卫和真实本地 HTTP JSON/SSE 回归，覆盖同上游与凭据、只删 compaction.id、第二次失败直接返回及 gzip。实际 Azure 后端能否接受仍需真实请求验证；本次不读取生产凭据/历史正文，不部署，不扩大 host 支持范围。执行与隔离验证记录见 `.codex-tasks/20261027-azure-responses-prefix/`。
