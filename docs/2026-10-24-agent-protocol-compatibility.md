# 通用 agent 模型发现与协议兼容

## 现场与根因

2026-10-24（北京时间）只读日志显示：

- 04:33–04:34，5 次 `/anthropic/models?client_version=pi` 被转发到上游 `/models`，收到 HTTP 200 的控制台 HTML，并非模型目录。相同配置下 `/anthropic/v1/models` 的一次诊断返回 JSON、14 个模型。
- 04:48:57，pi 的日志 234917 向 `/anthropic/v1/chat/completions` 发送 Chat 请求，上游返回 404。
- 04:49:20–04:49:39，日志 234919/234921/234923/234925 向 `/anthropic/chat/completions` 发送相同正文，上游返回控制台 HTML 200，网关误记成功。
- 五次生成请求的入站 request_id 不同，正文摘要相同；不能仅凭服务端日志区分客户端自动重试和人工重发，但不是 Claude 代理内部循环。未在文档/测试中复制对话或凭据。

根因不是客户端名称。入口原先隐含“OpenAI 就是 Responses、Claude 就是 Messages”，模型 GET 也可能进入生成转换；真正的 Chat 输入及回包可能被错误转换。模型 URL 缺少 `/v1` 则命中了上游静态站点。

## 方案与边界

1. 模型目录与生成分开：`GET /models`、`GET /v1/models` 走 OpenAI primary；`GET /anthropic/models`、`GET /anthropic/v1/models` 走 Claude profile。目录不经过 Messages/Responses/Chat 生成转换，保留上游目录、分页、查询与错误，不伪造模型或增加路径重试。
2. 保留 URL 所有权：OpenAI 配置是完整 API 根；Anthropic 配置是主机或供应商前缀。复用现有 URL 合并器，只在入口规范化已知别名；日志仍记录原始路径。
3. 按端点识别生成协议：`/v1/chat/completions`（兼容 `/chat/completions`）在 `openai_chat` 上游直接转发，保留工具回合、JSON 和 SSE `[DONE]`。Responses/Messages 继续使用现有转换。
4. 错误入口/不支持的 Chat 跨协议组合在出站前返回 HTTP 400、结构化 `unsupported_protocol` 错误，给出正确端点和上游类型。不得假装支持尚未实现的 Chat 双向转换，也不删除无法转换的工具字段。
5. 已知模型/生成 API 若收到成功状态的 HTML，在发出客户端响应头前拒绝，以 502 暴露上游路径/协议错误；日志保留真实上游状态，不再记成功。不改变非 2xx 上游错误或通用文件响应。

通用客户端仍须选择正确协议：Chat → OpenAI 入口 + `openai_chat` 上游；Responses → `/v1/responses`；Anthropic → `/anthropic/v1/messages`（兼容 `/anthropic/messages`）。网关不按 User-Agent 授权或猜测协议。400 可避免常见 SDK 的瞬时故障重试，但无法禁止第三方客户端自行重发所有错误；真正的 429/5xx 与网络错误仍可能触发客户端策略。

## 验证与回退

合成上游覆盖双入口 × 三种上游协议模型发现、供应商前缀/query/鉴权、gzip、上游错误不重试、Chat 工具回合及流式终止、错误协议无出站、HTML 不伪装成功；现有 Responses/Messages 转换和传输生命周期纳入扩大回归。全部在隔离副本执行，不复制生产配置，不覆盖根 `dist/`，不重启服务。

无配置或数据库迁移。回退仅撤销本次入口、代理计划、响应边界及对应测试变更；不得回退工作区内其他修改。未部署前在线行为不会改变。

### 实测结果

- 初始别名回归在旧实现中 6 项失败、36 项通过；扩展 agent 回归修正 fixture 后在旧实现中 31 项失败、3 项通过。
- 修复后针对性 91 项通过；补齐路由试算、原生 SSE、Chat 失败回归及更新 HTML 旧断言后，相关 94 项通过。
- 首次完整检查为 1597 通过、2 失败、1 跳过；两项失败均为已明确改变的 HTML 200 透传断言，调整为 502 且保留上游 200 后重新执行整个检查链。
- 最终隔离 `npm run check`：1605 项通过、1 项跳过；diff/style/严格类型检查与构建全部通过。日志 `/tmp/compactgate-models-compat-check-final.log`。
- 该轮检查时观测到服务 PID 48299、127.0.0.1:7865；23 个未涉及的既有修改文件与任务前快照逐字节一致。此处是历史快照，不代表后续服务状态；入口 `main.js` 的哈希不能用于判断其他代理模块是否更新。
- 提交版单独排除工作区内未提交的存储/传输优化，在 `/tmp/compactgate-agent-commit.CquRnB` 再跑完整 `npm run check`：141 个文件、1550 项通过、1 项跳过，类型检查与构建通过；日志 `/tmp/compactgate-agent-commit-check.log`。
- 上述实现与提交验证阶段未执行部署，也未用真实 agent/生产上游重放对话；后续安装版及原连接排查见下节。供应商专有目录结构保持原样，不承诺任意目录格式自动转换为 OpenAI schema；提交/推送状态以 Git 为准。

## Lexora 安装版与原连接验收

### 隔离实测

2026-10-24 使用本机已安装的 Lexora Buddy 0.15.0（Electron 44.9.3，pi-ai / pi-coding-agent 1.3.0），通过内置 `test` profile 隔离配置、对话和凭据。经渲染进程的 preload API 创建供应商、认证、同步模型及发送任务，执行安装包真实 SDK 和 SSE 解析链路；不是仅查看最新源码，也不是完整鼠标点击回归。

上游使用合成模型和固定响应，不消耗真实模型额度。三种协议分别直连合成上游、经过与 `abf4366` 对应的隔离网关构建，共 6 次任务均收到固定文本并以 `run.completed` 结束。下表是本次验证的同协议配置，不排除已有 Responses/Messages 转换能力。

| Lexora 协议 | 网关 Base URL | 对应同协议上游 | 模型同步 |
|---|---|---|---|
| `openai-completions` | `http://127.0.0.1:7865/v1` | `openai_chat` | 成功，请求 `/v1/models?client_version=pi` |
| `openai-responses` | `http://127.0.0.1:7865/v1` | `openai_responses` | 成功，请求 `/v1/models?client_version=pi` |
| `anthropic-messages` | `http://127.0.0.1:7865/anthropic` | `anthropic_messages` | 自定义供应商返回 `MODEL_SYNC_UNSUPPORTED`，未发送目录请求；手动添加并启用模型后对话成功 |

表中 7865 是常规接入示例；实际隔离测试使用独立随机端口，没有切换在线服务。新同步的未知模型初始 `enabled=false`，须显式启用。模型目录可获取不代表生成协议匹配：Chat 供应商使用 `/anthropic` 时，目录同步仍可成功，但生成会被拒绝。

### 重试实测

默认 `runtime.modelRetryLimit=3` 表示首次请求加最多 3 次重试，实测退避约 2、4、8 秒，之后失败停止，并非默认无限重试。

| 场景 | 客户端请求次数 | 结果 |
|---|---:|---|
| Chat 错投 `/anthropic` | 1 | 400 `unsupported_protocol`，没有上游请求 |
| Chat 选择 Responses 上游 | 1 | 400 `unsupported_protocol`，没有上游请求 |
| 上游 400，经网关 | 1 | `MODEL_REQUEST_FAILED` |
| 上游 401，直连 | 1 | `PROVIDER_AUTHENTICATION_FAILED` |
| 上游 500，经网关 | 4 | `MODEL_SERVICE_UNAVAILABLE` |
| HTML 200，直连 | 4 | `MODEL_STREAM_INCOMPLETE`，`Stream ended without finish_reason` |
| HTML 200，经修复网关 | 4 | 网关返回 502 并保留 `upstream_status=200`，客户端最终报服务不可用 |
| 重试上限改为 0，500 经网关 | 1 | 明确失败，不重试 |

以上 8 次预期失败与 6 次成功任务合计 14 次；同时核对了 18 条隔离网关请求与 26 条合成上游请求（含目录探测和直连测试）。对客户端终态、固定文本、请求次数、错配不出站和 HTML 状态归因的断言通过。重复失败各有独立入站 request_id，且对应上游计数，证明该复现中的重发来自客户端。

临时证据为 `/tmp/lexora-local-test.s1nVAh/run-results.json` 和 `wire-results.json`，不属于仓库文件，可能被系统清理。测试实例与监听端口均已关闭；Lexora 自身日志收尾曾报告丢弃记录，验收依据是关闭前独立导出的客户端事件和网关/fixture 记录。未覆盖长对话、工具执行、多模态和 `unlimited` 重试。

### 原连接 400 与结论更正

用户随后反馈原连接仍报 400。只读核对 05:53:23 的日志 235547：入站实际为 `/anthropic/chat/completions`，Claude 日志的 `path` 已剥去 `/anthropic` 前缀；`status=400`、`upstream_status=null`，错误明确指出该入口接受 Anthropic Messages 而非 OpenAI 请求。请求尚未出站，不是上游认证或模型拒绝。

当时运行配置的 Claude 上游为 `anthropic_messages`，Primary 上游为 `openai_responses`。因此保留现有 Claude 路由的匹配方案是：Lexora 选择 **Anthropic Messages**、Base URL 使用 `http://127.0.0.1:7865/anthropic`，手动添加并启用模型；只把地址改成 `/v1`、仍发送 Chat，也会与当时的 Primary 协议不匹配。现有修复包含模型探测、原生 Chat 接入和明确错误语义，不包含 Chat→Anthropic 自动转换。

这条在线错误已经证明新协议检查生效。此前依据单个 `dist/server/main.js` 哈希不变推断“线上未更新”不成立，现予以更正：未由本次测试执行部署，不等于线上一定没有相关修复。版本判断必须结合相关模块与实际运行行为；隔离测试通过也不能替代原连接验收。

用户之后明确确认“现在正常了”。本记录将其标为用户确认恢复，不声称由智能体修改了正式配置、重启了服务或另行完成真实上游复测；也不推断用户具体更改了哪些设置。

## 协议依据

- [OpenAI Models List](https://developers.openai.com/api/reference/resources/models/methods/list)：模型发现是 GET `/v1/models`，目录包含 `data`，与生成端点独立。
- [OpenAI Create Chat Completion](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)：Chat 请求使用 `messages`；回包为 Chat completion/chunk，不是 Responses 事件。
