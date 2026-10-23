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
- 现有服务仍为 PID 48299、127.0.0.1:7865，根 `dist/server/main.js` SHA-256 仍为 `20a0b910c71927862475d5cadfe03e1083d97a2aa1e9f6c235131f0618b785c4`。23 个未涉及的既有修改文件与任务前快照逐字节一致。
- 提交版单独排除工作区内未提交的存储/传输优化，在 `/tmp/compactgate-agent-commit.CquRnB` 再跑完整 `npm run check`：141 个文件、1550 项通过、1 项跳过，类型检查与构建通过；日志 `/tmp/compactgate-agent-commit-check.log`。
- 未部署，未用真实 agent/生产上游重放对话。供应商专有目录结构保持原样，不承诺任意目录格式自动转换为 OpenAI schema；提交/推送状态以 Git 为准。

## 协议依据

- [OpenAI Models List](https://developers.openai.com/api/reference/resources/models/methods/list)：模型发现是 GET `/v1/models`，目录包含 `data`，与生成端点独立。
- [OpenAI Create Chat Completion](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)：Chat 请求使用 `messages`；回包为 Chat completion/chunk，不是 Responses 事件。
