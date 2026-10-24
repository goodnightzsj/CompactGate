# CompactGate

CompactGate 是一个给 Codex CLI 和 Claude Code 用的本地路由与协议适配代理。

它的作用很简单：

- 普通请求继续发到你的主上游
- 只有 compact 请求单独分流
- 必要时自动改写 compact 模型名
- Codex Responses 与 Claude Messages 可以接入不同格式的兼容上游
- 你还能在本地页面里看配置、健康状态和最近日志

如果你现在还不清楚 “compact 请求” 是什么，也没关系。你只要记住：

> CompactGate 让 Codex 在“正常对话”和“压缩上下文”这两类请求上，可以走不同的上游。

## 这个项目解决什么问题

很多时候你会遇到下面几种情况：

1. 你的主上游能跑正常对话，但不支持 compact 模型。
2. 你想把 compact 请求单独走另一家兼容 OpenAI API 的服务。
3. 你想保留原来的 Codex 使用方式，只在中间加一层本地代理。
4. 你想在本地看最近请求都走到了哪条路由，并保留完整请求 / 响应正文方便排查。
5. 你的客户端和上游分别使用 Responses、Messages 或 Chat Completions，需要在代理层转换。

CompactGate 就是为这个场景做的。

## 30 秒理解工作方式

接入后，链路会变成这样：

```text
Codex -> CompactGate -> 你的上游服务
```

CompactGate 会按规则转发：

```text
普通 /v1/* 请求                                      -> primary 主上游
/v1/responses/compact                               -> compact 策略
/v1/responses + request_kind: "compaction"          -> compact 策略
/v1/responses + input[].type: "compaction_trigger"  -> primary 上游策略（逻辑记录为 remote_v2）
```

新版 Codex 的上下文压缩有三种线上的请求形态：专用 `/responses/compact` 的 Remote V1、带 `compaction_trigger` 且仍走普通 `/responses` 的 Remote V2，以及由 `x-codex-turn-metadata` 标记为 `request_kind: "compaction"` 的本地摘要压缩。CompactGate 会识别三种形态；Remote V2 复用 primary 模型、凭据和协议，不要求上游提供 compact 模型。Responses 上游原生转发，Anthropic Messages 转成原生 compaction，Chat 上游转成普通摘要请求并返回 CompactGate 签名状态。没有这些精确信号的普通请求仍走 primary。

Remote V1 与 Remote V2 不是同一路径换了名字：

| 项目 | Remote V1 | Remote V2 |
|---|---|---|
| 请求入口 | `/v1/responses/compact` | `/v1/responses` |
| 真实触发信号 | 专用 compact 路径 | `input[].type: "compaction_trigger"` 或 `responses_compaction_v2` 元数据 |
| 实际上游 | `split` 时走独立 `compact.base_url` | 始终复用 Primary 上游与协议 |
| 模型策略 | 可改写为 compact 模型 | 保留 Primary 模型和 reasoning 策略 |
| 状态处理 | 支持响应归一化、桥接和短期去重 | Responses 保留 provider state；Messages/Chat 使用签名 `cg1_` 可移植摘要 |
| 日志 | `route=compact`、`compaction_mode=remote_v1` | `route=compact`、`compaction_mode=remote_v2` |

OpenAI Codex 官方 [`0.140.0` 发布说明](https://github.com/openai/codex/releases/tag/rust-v0.140.0)把 Remote Compaction V2 改为默认启用，因此 CompactGate 把 `0.140.0` 记作“V2 默认起点”，而不是“V1 被删除”的硬切换点。账号灰度、配置、桌面内置 CLI 和二开版本仍可能改变实际行为，所以 Studio 按“实际请求 > 历史观测 > 本机版本基线”的顺序展示协议；所有兼容路径始终保留。

服务启动时会执行一次有超时保护的 `codex --version`，之后每 6 小时刷新本机版本。真实请求里的 User-Agent 更权威，例如 `codex-tui/0.144.1-cometix` 会拆成原始版本 `0.144.1-cometix`、官方数字基线 `0.144.1` 和二开变体 `cometix`；如果它实际发送 V1，Studio 仍显示 V1，不会因为数字基线较新而强制标成 V2。

你只需要把 Codex 的 `base_url` 改成 CompactGate，本地代理就会替你处理剩下的事情。

## 最短上手

### 1. 安装依赖

```bash
npm install
```

### 2. 复制配置文件

```bash
cp compactgate.example.json compactgate.json
```

### 3. 修改 `compactgate.json`

先至少改这几个值：

- `primary.base_url`：你的主上游地址
- `compact.base_url`：你的 compact 上游地址
- `primary.api_key_env`：主上游密钥环境变量名
- `compact.api_key_env`：compact 上游密钥环境变量名

如果你暂时只想走一套上游，也可以把：

```json
"upstream_mode": "primary"
```

这样 compact 请求也会走主上游。

### 4. 设置环境变量

```bash
export PRIMARY_API_KEY="你的主上游密钥"
export COMPACT_API_KEY="你的 compact 上游密钥"
```

如果你不想用环境变量，也可以先启动服务，再去 Studio 页面里直接保存 API Key，或在“档案”中添加厂商 OAuth 连接。

### 5. 启动

```bash
npm run build
npm start
```

启动后打开：

```text
http://127.0.0.1:7865/
```

这里就是 CompactGate Studio。

### 6.（可选）装成随登录自启的常驻服务

上面的 `npm start` 是前台进程，关掉终端就没了。要让 CompactGate 一直在，装成 macOS LaunchAgent。

这一步不是必须的：不装也能正常用，只是每次开机要手动起。

#### 1. 编译命名壳程序

```bash
npm run build:launcher
```

生成 `bin/compactgate`，一个把 node 路径 `execv` 过去的小壳（源码 `scripts/launcher.c`）。

**为什么需要它**：macOS「系统设置 → 通用 → 登录项与扩展」里显示的服务名，取自**可执行文件名**而不是 plist 的 `Label`。直接指向 `node`，那一栏就会登记成 `node` / `Node.js Foundation`——既认不出来，也容易当成无用进程被关掉。壳程序用 ad-hoc 签名即可，`npm run build:launcher` 已经代劳。

产物不在版本控制里（复制或重建都会让签名失效），克隆仓库后必须自己跑一次。

#### 2. 改 plist 里的路径

`scripts/compactgate.plist` 里有几处写死的绝对路径，按你的机器改：

| 键 | 改成 |
|---|---|
| `ProgramArguments[1]` | 你的 `node` 绝对路径（`which node`） |
| `ProgramArguments[2]` | 这个仓库的 `dist/server/main.js` 绝对路径 |
| `WorkingDirectory` | 仓库根目录 |
| `EnvironmentVariables` → `COMPACTGATE_CONFIG` | `compactgate.json` 绝对路径 |
| `EnvironmentVariables` → `PATH` | 至少含 node 与 `/opt/homebrew/bin` |
| `StandardOutPath` / `StandardErrorPath` | 你想让日志落到哪 |
| `COMPACTGATE_CONFIG` 旁的两个 `_PROXY` | 走代理才需要；`NO_PROXY` 里务必保留 `127.0.0.1` |

`PATH` 里必须有 `/opt/homebrew/bin`：服务启动时会同步跑一次 `codex --version`，找不到命令时版本检测会静默降级。

#### 3. 安装并启动

```bash
cp scripts/compactgate.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/compactgate.plist
```

`bootstrap` 有时会返回 `Bootstrap failed: 5: Input/output error`，但服务其实已经起来了——判断成败要看下面这条，不要只看它的退出码：

```bash
launchctl list | grep compactgate
curl -s http://127.0.0.1:7865/api/health
```

#### 4. 日常命令

```bash
npm run restart    # 重新编译并重启（改完源码用这个）
npm run stop       # 停止；5 秒后若无人监听会自动拉起
npm run defer-start 5   # 手动臂化一次延迟启动，做危险操作前用
```

`npm run stop` 是**临时**语义：它在停止前先安排一次 5 秒后的检查，发现端口没人监听就重新启动。要真正停住：

```bash
COMPACTGATE_STOP_AUTO_RESTART_SECONDS=0 npm run stop
```

彻底卸载（连自启定义一起删）：

```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/compactgate.plist
```

#### 5. 它替你兜了什么

| 场景 | 行为 |
|---|---|
| 进程崩溃 / 被 `kill -9` | `KeepAlive` 自动拉回（约数秒） |
| 开机、登录 | `RunAtLoad` 自动启动 |
| `npm run restart` | `launchctl kickstart -k`，先杀后起，不留空窗 |
| 收到 SIGTERM / SIGINT | 结束 Studio SSE、关闭空闲连接，3 秒后强制关闭剩余 HTTP 连接；等待请求收尾、抓包清理及后台写入后关闭 SQLite，以 `exit(0)` 收尾。10 秒未排空或重复信号时非零退出；同步阻塞期间计时器无法执行 |

`exit(0)` 与崩溃的区分正是 `KeepAlive{SuccessfulExit:false}` 的依据——正常停止不会被当成崩溃重新拉起。

## Codex 怎么接入

构建后可以直接用一次性启动器，不修改 `~/.codex/config.toml`：

```bash
node dist/server/cli.js agent codex -- --model gpt-5.5
node dist/server/cli.js agent codex --profile PROFILE_ID -- --model gpt-5.5
```

通过 npm link 或包管理器安装 bin 后，可将 `node dist/server/cli.js` 换成
`compactgate`。`--url` 可覆盖默认的 `http://127.0.0.1:7865`，`--` 后的参数
原样传给 Codex。

把 Codex 的 OpenAI 兼容 `base_url` 指向 CompactGate：

```toml
model_provider = "compactgate"
model = "gpt-5.5"

[model_providers.compactgate]
name = "OpenAI"
wire_api = "responses"
requires_openai_auth = true
base_url = "http://127.0.0.1:7865/v1"
```

这里有一个非常重要的点：

```toml
name = "OpenAI"
wire_api = "responses"
```

这两项不要随便改，尤其是 `name` 必须保持 `"OpenAI"`，否则 Codex 可能不会启用预期的 Responses 和远程压缩能力。不同 Codex 版本不一定都调用 `/v1/responses/compact`，也可能使用上面另外两种压缩请求形态。

## Claude Code 怎么接入

同一个启动器通过进程内 `--settings` 指向 CompactGate，不写
`~/.claude/settings.json`：

```bash
node dist/server/cli.js agent claude
node dist/server/cli.js agent claude --profile PROFILE_ID -- --model sonnet
```

启动器把 `ANTHROPIC_BASE_URL` 设为 `http://127.0.0.1:7865/anthropic`；指定
profile 时，再通过 `ANTHROPIC_CUSTOM_HEADERS` 注入请求级
`x-compactgate-profile`。`--url` 与 `--` 的语义和 Codex 启动器一致。

## 配置文件怎么理解

下面是一个最常见的配置例子：

```json
{
  "listen": "127.0.0.1:7865",
  "primary": {
    "base_url": "https://primary.example/v1",
    "api_key_env": "PRIMARY_API_KEY",
    "upstream_protocol": "openai_responses",
    "model_override": "",
    "reasoning_effort": "",
    "state_domain_id": ""
  },
  "compact": {
    "base_url": "https://compact.example/v1",
    "api_key_env": "COMPACT_API_KEY",
    "upstream_protocol": "openai_responses",
    "upstream_mode": "split",
    "model_mode": "linked",
    "model_template": "{model}-openai-compact",
    "model_override": ""
  },
  "timeouts": {
    "primary_ms": 120000,
    "compact_ms": 900000
  },
  "logging": {
    "redact_body": true,
    "persist_body": false,
    "keep_recent": 200,
    "capture_dir": null,
    "capture_body_max_bytes": 1048576,
    "capture_dir_max_bytes": 21474836480,
    "max_database_bytes": 1073741824
  },
  "primary_failover": {
    "auto_schedule": true,
    "state_portability": "recover_on_error"
  }
}
```

Codex 的 `primary.base_url` 和 `compact.base_url` 表示完整上游 API 根，例如 `https://host/v1` 或 `https://host/api/paas/v4`。CompactGate 会精确移除客户端请求开头的 `/v1`，再把剩余端点拼到该 API 根，因此不会因拼接额外生成 `/v1/v1/responses`，也不会破坏 `/v4` 这类供应商版本路径。

Claude 的 `claude.primary.base_url` 表示上游主机或供应商前缀，例如 `https://api.anthropic.com` 或 `https://host/anthropic`。`/v1/messages` 会追加到该前缀；如果 base URL 已以完整 `/v1` 段结尾，则拼接边界只保留一个 `/v1`。Claude Messages POST 返回 404 时，CompactGate 不会猜测并重试其他路径。

### `*.upstream_protocol`

主路由与压缩路由都保存明确的上游协议。可选值为：

- `openai_responses`：OpenAI Responses API
- `anthropic_messages`：Anthropic Messages API
- `openai_chat`：OpenAI Chat Completions API

旧配置不需要手工迁移：Codex 的 `primary` / `compact` 默认保持
`openai_responses`，Claude 的 `claude.primary` / `claude.compact` 默认保持
`anthropic_messages`。同协议请求继续直通，只有协议不同时才转换请求和响应。

| 客户端入口 | Responses 上游 | Messages 上游 | Chat 上游 |
|---|---|---|---|
| Codex `/v1/responses` | 直通 | 转换 | 转换 |
| Codex `/v1/responses/compact` | 直通 | 原生或可移植压缩转换 | 明确拒绝 |
| Claude `/anthropic/v1/messages` | 转换 | 直通 | 转换 |
| Claude `/anthropic/v1/messages/count_tokens` | 转换为 `/v1/responses/input_tokens` | 直通 | 返回 501 |
| 其他 agent `/v1/chat/completions` | 返回 400 | 返回 400 | 直通 |

其他 agent 不需要伪装成 Codex 或 Claude Code。请按客户端协议配置：OpenAI
Chat 使用 `http://127.0.0.1:7865/v1` 并选择 `openai_chat` 上游；Responses
使用同一 OpenAI API 根；Anthropic Messages 使用 `http://127.0.0.1:7865/anthropic`。
兼容 `POST /chat/completions` 和 `POST /anthropic/messages`（含 `/messages/count_tokens`）别名。
把 Chat/Responses 请求发到 `/anthropic`，或把 Chat 请求交给非 Chat 上游，会在出站前
返回结构化 `unsupported_protocol` 400；尚未实现 Chat 客户端到其他协议的双向转换。

模型探测支持 `GET /v1/models`、`GET /models`、`GET /anthropic/v1/models` 和
`GET /anthropic/models`，使用对应路由的上游与凭据，不进入生成协议转换。
上游目录、分页、查询参数和错误原样保留，不伪造目录、不猜测其他路径重试；
供应商专有目录格式仍由该供应商决定。成功状态的 HTML 不是模型/生成 API 响应，
会返回 502 并记录真实上游状态，提示检查 `base_url` 与协议。
400 不触发网关重试，但第三方客户端若自行重发所有错误，仍需调整其重试或连接配置。
现场证据、修复边界与验证见[通用 agent 兼容方案](docs/2026-10-24-agent-protocol-compatibility.md)。

Lexora Buddy 0.15.0 安装版已实测支持 Chat、Responses 和 Anthropic Messages。自定义 Anthropic 供应商不支持自动同步模型，需手动添加并启用；不要为了同步模型而选 Chat 再连接 `/anthropic`，目录可能获取成功，但生成仍会返回 400。默认重试上限 3 表示最多 4 次请求，实测 500、HTML/不完整流会重试，协议错配 400 不重试；上限设为 0 可用于排障，但不能修复协议错配。隔离测试通过不代表原连接已恢复，验收还须核对实际连接和真实请求。

协议转换覆盖文本、图片、自定义 function tools、tool result、JSON/SSE、usage
和错误响应。Responses 与 Messages 之间还会保留可移植的 reasoning/compaction
状态；无法安全移植的 provider-private 状态会明确失败。转换到 Chat 的路径只承诺无状态的
文本、图片和 function tool 交互；reasoning、compaction、structured output、
provider tools 和多 choice 不会被静默丢弃，而是在请求发送前或流解析时返回明确错误。

Messages 上游若提供非标准扩展 `usage.reasoning_tokens`（例如 oc-go-cc），普通与
compaction 的 JSON/SSE 转换会保留为 Responses 的
`usage.output_tokens_details.reasoning_tokens`，下游响应和日志使用同一转换结果。
只接收非负整数；未提供或无效时省略，明确报告的 0 保留，但后续省略或零值流帧不会抹掉
已观测的正数。它是 `output_tokens` 的拆分，不额外增加输出或总量，也不回填旧日志。
这只补齐上游已报告的用量明细，不启用额外推理能力，也不改变请求路由、模型参数或
压缩摘要与状态桥接逻辑；未提供该扩展字段的上游保持原有行为。

Claude Code 的手工摘要提示仍按现有规则走 `claude.primary`，CompactGate 不根据
提示词猜测压缩流量；`claude.compact` 继续作为独立配置、凭据和 profile 元数据保存。

`logging.keep_recent` 控制 Studio 首屏和 `/api/logs/recent` 默认返回多少条日志，范围是 1 到 2000，不是 SQLite 日志保留上限。SQLite 请求日志默认最多占用 1 GiB；先 checkpoint 回收 WAL，重新测量仍超限才清空历史正文并保留元数据，再超限才删除最早的元数据行。

自动容量维护在已提交的 SQLite 操作之间给网络 I/O 留出 5ms 调度窗口，保留现有 SQL 事务与删除顺序；期间的新写入会在必要时触发新的“正文优先”检查。关闭服务或禁用容量上限会取消尚未执行的阶段，已提交的正文/元数据变更仍通知 Studio。显式 `purge-bodies` 继续同步完成或明确报错。单次 UPDATE/VACUUM 仍同步，接近 1GiB 的元数据压力库实测可暂停约 5 秒，此调整不保证低尾延迟。

推荐使用分离存储：保持 `logging.persist_body = false`，再设置 `logging.capture_dir`。每个代理请求会写入一份独立 JSON，单段正文默认最多 8 MiB，受管抓包文件合计默认最多 20 GiB。目录超限时只删除最旧抓包，SQLite 元数据继续保留并把 `capture_status` 标为 `purged`。把 `capture_dir` 热更新为 `null` 可停止新抓包；`COMPACTGATE_CAPTURE_DIR` 和 `COMPACTGATE_CAPTURE_BODY_MAX_BYTES` 仍优先于配置文件。

实时 SSE 的诊断副本最多 8 MiB，不截断成功的直通交付；SQLite 正文和抓包明确标记副本截断，抓包 `byte_length` 保留实际观察字节数。SSE 中的续接 ID 独立于正文前缀保留，截断前缀不覆盖最终用量。生产代理的单事件观察预算从 64 KiB 提高为 8 MiB，以容纳携带完整输出的终态事件；超预算事件会计入 `stream_oversized_event_count`，缺失用量显示为未知，不把早期值当最终值。

成功 JSON 响应还携带续接 ID 等业务元数据，不能只保留诊断前缀：其完整缓冲、RemoteV1 完整压缩结果及协议转换累计输入各限 32 MiB，超限明确中断且不缓存不完整结果。同协议透明流的终态修复只限制待解析单帧，不限制整个流。这些均为每请求预算，并非全进程内存上限；观察预算之外的元数据无法保证可恢复。

请求 deadline 仍包含本地准备耗时。尚未创建出站请求就耗尽预算时，返回超时但不计上游健康失败，也不广播密钥活动；真实连接失败仍计入健康，重试前预算耗尽也不会抹掉此前已经发生的出站尝试。

`logging.redact_body` 是为旧配置保留的兼容字段，当前不会改变 SQLite 正文或抓包正文；鉴权头、Cookie 头和常见凭据查询参数始终单独脱敏。Studio 不提供这个无效开关，保存其他日志设置时也不会重写它。

最重要的字段只有这些：

### `primary`

普通请求走的主上游。

`primary.model_override` 非空时覆盖请求模型；`primary.reasoning_effort` 可设为 `low`、`medium`、`high`、`xhigh` 或 `max`，仅对 Responses API 写入 `reasoning.effort`。两者留空都表示保留客户端请求。旧配置中的 `none` 仍会按原值转发，但不会出现在 Studio 下拉选项中；需要取消覆盖时应改为“跟随请求”。

`primary.state_domain_id` 用来声明该 profile 的 provider 状态域。保存的 profile 留空时按 profile ID 隔离；没有 profile 的直连配置才回退到上游 URL origin。只有两个 profile 明确配置相同值时，CompactGate 才把它们视为可直接共享 encrypted reasoning/compaction 状态。

旧对话切换 profile 后失败的根因不是路由仍指向旧 host，而是请求正文携带了旧上游签发的 provider-private state。welfare 抓包样本包含 59 个 reasoning item（其中 15 个 `encrypted_content` 为 null 或格式无效）、1 个 compaction item 和 51 组工具调用；原实现切换 host 后仍把这些状态逐字节发给新上游，而新对话没有这批外域状态，所以新对话可以成功。CPA/CLIProxyAPI 只验证 GPT reasoning 密文的外层格式，不能证明新上游可解密；sub2api 还会从不可变正文重建每次尝试、跨 passthrough 边界删除整个 reasoning，并在明确的 `400 invalid_encrypted_content` 后定向重试。CompactGate 组合这些边界，并额外处理 compaction、工具配对、状态域绑定和流式响应提交点。

### `primary_failover.state_portability`

- `off`：不做旧会话迁移。
- `recover_on_error`：默认值。第一次始终把当前请求原样发给选中的 profile；只有明确的可修复 400，或具有目标健康和状态域证据的兼容性失败，才从原始请求体派生恢复请求。旧配置值 `compatibility_first` 和 `domain_aware` 在加载时归一化为此模式。

明确 `400 invalid_encrypted_content` 或 `previous_response_not_found` 直接执行一次错误专用修复。修复后仍返回同一明确 400 时,若跨域证据成立仍可继续 strict。welfare 一类泛化失败必须同时满足：请求含 provider-owned state、目标 profile 最近 15 分钟有同模型/端点的无状态成功，以及已知状态域不匹配；来源未知时还要求 10 分钟内出现两次相同失败。恢复链为原始请求、CPA 低损清理、严格跨域清理；错误专用修复按错误位置插入。所有请求固定在当前 profile/host，最多发送 4 个不同 body，且每次都从同一份不可变请求体派生。只有完整成功响应才更新持久绑定。

`agentrouter.org`（含子域）的原生 Responses 另有一项定向恢复：首发收到 `The requested item was created under a different Azure OpenAI resource...` 的 HTTP 400 后，若 `store=false`、无存储引用且 compaction 携带密文，只删除 `compaction.id`，在同一上游重试一次。也识别已知 Go 数字 `error.code` 解码失败包装中的一层 `raw:` JSON 与可选末尾 trace；未知包装、畸形内层 JSON 不用于该定向恢复。密文与其余上下文保持不变；第二次失败直接返回，不继续 CPA/strict，原始错误不被解包结果替换。此尝试不保证跨资源密文可用，且 `state_portability=off` 时不启用。

通过 `POST /api/config/profiles/apply` 手动应用 Codex profile 是一次权威切换：CompactGate 会清除旧的进程内会话 stickiness，并强制下一次 Primary 选择新 profile，即使 `auto_schedule=true`。自动调度内部同步 active profile 不触发该强制逻辑。

### `compact`

compact 请求走的上游。

CompactGate 只在以下精确信号出现时标记为压缩流量：路径是 `/v1/responses/compact`（`remote_v1`）；`/v1/responses` 的 Codex turn metadata 中 `request_kind` 是 `compaction`（`local`，实现为 `responses_compaction_v2` 时为 `remote_v2`）；或者 input 中存在 `type: "compaction_trigger"`（`remote_v2`）。body 中的 `client_metadata` 优先于兼容请求头。压缩成功后的普通 `/v1/responses` 后续 turn 即使携带 `type: "compaction"` 和 V2 beta 标记，也保持普通 `primary` 日志；Responses provider state 原样保留，CompactGate 签名状态可还原为摘要消息。它不会根据提示词、模型名或 token 数猜测请求用途。Remote V2 的真实压缩动作仍使用 Primary 上游。

### `compact.upstream_mode`

可选值：

- `split`：local/Remote V1 compact 请求走 `compact.base_url`
- `primary`：local/Remote V1 compact 请求也走 `primary.base_url`

Remote V2 始终走 primary 上游，不受此项切换，也不会改写为 compact 模型。

### `compact.model_mode`

可选值：

- `linked`：按模板改写模型名
- `custom`：无论原模型是什么，都改成固定模型

### `compact.model_template`

当 `model_mode = "linked"` 时使用。

比如：

```text
{model}-openai-compact
```

如果原模型是：

```text
gpt-5.5
```

那么 compact 请求会被改写成：

```text
gpt-5.5-openai-compact
```

### `compact.model_override`

当 `model_mode = "custom"` 时使用。

例如你可以固定改成：

```text
my-compact-model
```

### 上游扩展头与显式代理

`primary`、`compact`、`claude.primary`、`claude.compact` 都支持：

```json
{
  "extra_headers": {
    "x-provider-feature": "enabled"
  },
  "proxy_url": "http://user:pass@127.0.0.1:8080"
}
```

`extra_headers` 会随 profile 保存，但禁止认证、Cookie、长度和 hop-by-hop 头；
值不会从 `GET /api/config` 返回，抓包也按配置头名动态脱敏。`proxy_url` 仅接受
HTTP CONNECT 代理，显式配置优先于环境代理且非法值直接失败，不会静默直连。

HTTPS CONNECT 隧道会复用：每个目标最多保留 2 条空闲连接，每个代理最多 8 条，
代理缓存最多 8 项，空闲 4 秒后关闭。缓存淘汰不打断在途请求，最后一个服务关闭后
释放空闲隧道；活动请求仍遵循原有总超时，不因连接复用自动重发失败的模型 POST。

成功 SSE 终态后，若客户端先于上游 HTTP EOF 断开，自有 CONNECT agent 会尝试
消费剩余响应以保留连接。业务结果、usage 和请求耗时仍按原边界结算，尾部不会
继续写入已结算结果；每次收尾最多 500 毫秒和 64 KiB（线上字节），每个代理
最多同时收尾 8 条，且不延长原请求 deadline。这些是保守资源上限，不是实测
最优参数。超限、连接异常或 agent 退役时关闭尾部；最后一个服务 owner 退出
也会取消收尾，不影响其他 owner 的在途请求。终态前取消、失败响应与非自有
agent 保持原有处理；上游要求关闭连接或不正常结束 HTTP 时不能保证复用。

真实模型请求的传输诊断默认关闭。需要时在**获准启动的实例**环境中设置
`COMPACTGATE_TRANSPORT_DIAGNOSTICS=1`，每次出站尝试结束后会向标准输出打印
一条 `type=upstream_transport` 的 JSON，不写入数据库，也不更改 tok/s 口径。
启用或关闭它不代表已获得重启现有服务的授权。

- `request_id` 关联服务端生成的请求日志 ID，`attempt_id` 区分同一请求的多次
  出站尝试；无关联请求 ID 的内部调用为 `null`。不输出正文、路径、query、
  请求头、凭据或错误原文，仅保留上游 host、状态和有限原因分类。
- `*_ms` 均为相对本次尝试起点的单调耗时；未发生的阶段为 `null`。
  `request_elapsed_at_start_ms` 是尝试开始时原请求已耗时，可能包含前次尝试和退避。
- `reused_socket` 来自 Node 的实际请求标记；`socket_ready_ms` 对 CONNECT 包含
  隧道与 TLS 就绪时间；`request_sent_ms` 是本地写出完成，不代表上游已接收。
- `headers_ms`、`first_body_byte_ms` 分别表示收到响应头和首个正文块，不等同于
  首个可见文本 token。`terminal_observed_ms` 是识别语义终态的时刻，压缩响应
  在解码后观测；无法识别的终态保持 `null`，不能直接据此推算纯模型生成时间。
- `result_settled_ms`、`http_end_ms`、`request_closed_ms` 分别表示尝试结果结算、
  HTTP 消费完毕和 Node ClientRequest 结束。`request_closed_ms` 与 `close_reason`
  **不表示 TCP socket 已关闭**：正常完成时连接仍可能留在池中。
- `drain_started_ms`、`drain_bytes`、`drain_outcome` 标识收尾。结果包括 `complete`、
  `timeout`、`byte_limit`、`capacity`、`retired`、`closed`，未尝试为 `null`；
  `complete` 只证明 HTTP 收尾完整，不保证连接被后续请求复用。

诊断仅用于有限时段排查；输出量随实际尝试数增长，由进程日志的既有保留策略管理。
先对比同上游、同模型与相近输入/缓存样本的复用标记及建连耗时，再决定是否调整
4 秒空闲期限。连接优化无法替代上游限流、异常或大输入缓存未命中的独立排查。

排查冷/热连接耗时时，可对公开、无鉴权的 HTTPS 地址执行：

```bash
npx tsx scripts/upstream-latency.ts https://example.com/ http://127.0.0.1:7897
```

脚本连续发送 3 次 GET，输出实际复用标记及连接就绪（含 CONNECT/TLS）、发送完成、
响应头、首个正文块和结束时刻，时间单位为毫秒，均相对本次请求开始；`body_ms`
单独表示收到响应头后的耗时。每次最多 10 秒、正文最多 1 MiB，不输出正文或头，
不读项目配置，不接受带凭据的 URL 或带 query/fragment 的目标，不自动跟随重定向。
这用于定位连接成本，不代替真实模型生成吞吐，也不改变现有日志或 Token 统计口径。
失败仅输出脱敏错误码：参数非法为 `PROBE_INVALID_URL`，正文超限为
`PROBE_RESPONSE_TOO_LARGE`，总超时为 `ABORT_ERR`；其他网络错误保留其错误码。

### Claude 场景路由

`claude.scene_map` 可为 `long_context`、`background`、`web_search`、`thinking`、
`image` 和 `default` 指定 `profile_id` 与可选 `model`。`long_context_bytes` 使用
UTF-8 文本字节数判断，图片 base64 不计入。优先级固定为：显式请求 profile、
长上下文、后台任务、Web 搜索、思考、图片、默认。

Codex 与 Claude 请求都可携带 `x-compactgate-profile: PROFILE_ID` 做单次精确选择；
仅 loopback 客户端可用，转发前会删除，并且不会修改 active profile、健康度或粘性。

### Claude 思考参数适配

模型映射默认只修改 `model`，保留客户端的 `thinking` 与 `output_config`。
未知中转、自定义模型以及中转上的 Claude 同名模型，不再因为模型名未命中规则
就把 `effort` 换成 `budget_tokens`。例如 DeepSeek 自定义模型收到的
`output_config.effort: "max"` 会原样转发；字段是否生效仍取决于该中转的实际实现。

自动兼容仅在模型确实改变、最终端点为 `https://api.anthropic.com/v1/messages`、
目标 ID 已核实且不接受原 thinking 模式时启用。规则按具体 ID 匹配，
不推测未来版本、带前缀的别名或其他供应商能力：

- 已知 4.5 模型只接受手动预算；Opus 4.5 同时支持 `low`/`medium`/`high` effort，转换时保留受支持档位。
- Opus/Sonnet 4.6 与 Mythos Preview 接受两种模式，保留客户端原模式。
- 已登记的 adaptive-only 模型只在收到手动预算时转换；已有受支持 effort 优先于比例估算。
- 只调整必要字段，保留 `output_config.format` 等其他字段；不主动开启已关闭的思考。
- `count_tokens` 不做此适配；OpenAI 上游继续由已有转换器处理，`max` 映射为 `xhigh`。

兼容转换中的预算/档位比例是近似策略，不是官方等价关系；手动预算转成 effort
后不再具有相同的思考 token 硬上限，但不会扩大原 `max_tokens`。
仅在需要转换时，缺失/非法的 `max_tokens` 或预算、未知/不支持的明确 effort、
没有明确 effort 的 adaptive→预算请求、冲突的 adaptive+budget 参数会返回 422。
生成手动预算还要求 `max_tokens > 1024`；不足时不再静默关闭思考。
原样透传的请求仍由上游校验，不因本地规则未知而被拦截。

升级无需迁移配置或重填六槽位。曾依赖旧启发式的中转可能暴露参数不兼容；
应核实具体上游合同，不能恢复“所有未知模型都转预算”。能力依据见
[Anthropic thinking 支持表](https://platform.claude.com/docs/en/build-with-claude/thinking-troubleshooting)、
[effort 说明](https://platform.claude.com/docs/en/build-with-claude/effort)；
[DeepSeek 官方兼容说明](https://api-docs.deepseek.com/guides/anthropic_api)不代表第三方中转已实现相同行为。

## Studio 页面能做什么

打开 `http://127.0.0.1:7865/` 后，你可以直接：

- 修改主上游和 compact 上游地址
- 为 Codex/Claude 的主路由和压缩路由选择上游协议
- 切换 `split` / `primary` 模式
- 切换 linked / custom 模型改写方式
- 从已保存的 Primary/Claude 上游按需拉取模型并选择思考强度，或保留自定义兼容模型
- Claude 模型选择后可确认同步到全部 6 个角色槽位，也可保留单槽位修改
- 直接保存 API Key，为同一档案的多把密钥设置优先级
- 预览某条请求会走哪条路由
- 查看健康状态
- 实时查看最近日志

Claude 每次成功拉取模型目录后，首次选择只修改当前槽位，并就地展示模型名称、六槽位范围与覆盖提醒。点击“应用到全部 6 个槽位”才会统一填写；选择“仅此槽位”或在确认区域按 Escape 不会覆盖其他槽位，重新拉取前不重复提示。批量操作仍只更新草稿，保存配置后生效，之后可继续逐项调整；不会修改 Codex 模型设置。

配置页五个 Tab 分别使用 `/config/profiles`、`/config/routes`、`/config/model`、`/config/logging` 和 `/config/portable`，可通过浏览器前进、后退回顾切换历史。旧 `/config/preview` 入口进入路由工作区。

配置页不要求一屏放下全部内容：主内容区统一纵向滚动，表单最大宽度为 1080px。连接页依次展示基础连接、密钥池、压缩策略与高级策略；短模型表单按内容高度展示。未修改时保存状态跟随内容，有草稿或错误时突出粘性保存栏，低高度窗口改回文档流以免遮挡字段；保存仍作用于全部配置。备份页先选择文件，再展开摘要和覆盖确认。

预览或重新部署必须使用新的空闲端口，并隔离构建产物、配置和数据库；不得覆盖当前服务使用的 `dist/`，也不得停止、重启或替换现有服务。预览使用合成数据，不复制生产凭据。详见项目 `AGENTS.md`。

总览直接展示已生效的两端档案、主路由与主模型覆盖，并提供统计、用量与试算入口。配置页顶部显示当前客户端、运行档案及全部草稿的待应用范围；切换页面不会应用草稿。未取得健康数据时显示未知状态，不把加载中计为缺密钥或异常。

模型目录不会在页面加载时自动联网。手动凭据按已保存的 base URL 生成 OpenAI-compatible `/v1/models` 或 `/models` 候选；仅当端点返回 404/405 时尝试下一条路径。OAuth 连接使用厂商绑定的目录和认证方式，不尝试任意地址。修改 URL 或凭据草稿后需先保存，再拉取对应上游目录。

日志是实时刷新的，使用的是 SSE；断线恢复后重新读取连续首屏，保持计数与后续分页一致。仪表盘每分钟刷新并推进相对时间窗，用量页选择的固定日期不会随刷新漂移。

HTTP 日志页与 SSE 插入共享 SQLite 序号，避免分页期间新增漏行、筛选统计重复计数；自动存储清理或手工正文/抓包清理后，按当前筛选重新读取连续首屏，放弃旧分页窗口。刷新失败时保留上次结果并暂停分页，可重试恢复。

仪表盘和用量可按所展示统计的实际时间范围下钻到日志；响应模型与 Host 使用精确匹配，不用模糊搜索替代。日志筛选区直接显示响应模型与开始时间范围，窄屏同样可见；模型可切换为“全部响应模型”而保留时间，时间菜单可移除时间与模型限定并保留其他条件，也可清除全部筛选。总览与路由始终使用全局记录。“样本概览”移至独立页面（`/#samples`），从日志页或导航进入，与请求日志共用筛选条件、实时记录和已加载分页窗口；日志页不再内联展示分组。样本页完整展示分组、调用数、失败数、成功率和最近最多十次结果，可加载更早记录，不代表全库或上游健康探测。

桌面日志默认沿用完整12列，保留独立的首响应与耗时；模型差异放在响应模型列，类型下方只展示一行生成速度，例如 `235.0 tok/s`，不加“生成/平均”前缀。可切换精简7列，合并模型链路、上游凭据、输入/输出 Token 与首响应/总耗时；精简列与移动卡片同样只展示生成速度，无可靠样本时显示 `-`，不回退为平均速度。“响应声明不同”只比较上游明确声明与目标模型，不把目标推断当证据，也不代表模型指纹鉴定。详情保留生成速度、平均输出吞吐与采样信息：平均输出吞吐仍为输出 Token / 总耗时，包含等待；生成速度采用同一次上游源流的输出 Token / 首个有效输出至成功终态的耗时。不改变原有用量和健康统计。

正文清理已提交但 SQLite 空间回收失败时，仍通知页面刷新，并明确报告“正文已清、空间回收失败”。非 SQLite 模式下抓包目录可清空后继续编辑；留空保存将关闭抓包。日志表在中等宽度下可局部横向滚动，720px 及以下保留卡片布局；Token 明细支持键盘操作，复制失败会显示原因。

仪表盘的时间范围、来源维度与度量，用量的日期/粒度与端点度量，以及配置客户端展示范围，在跨页返回时保留；刷新浏览器后恢复默认值。统计首次进入只加载一次，隐藏页面暂停轮询，重新可见时立即刷新。更改用量日期后若仍显示上次统计，会标明实际日期范围并禁用 CSV 导出，直到所选范围加载成功。没有请求时保留关键指标，将空图表与表格合并为一处操作提示。开启系统“减少动态效果”时实时日志立即显示，不等待逐条动画。

分布图百分比以所展示统计范围的总量为分母；Host/模型为按请求量选取的 Top 12，端点为 Top 8，未展示项不会被重新归一化。模型路径可查看对应 Host 与响应模型的日志（不额外限定请求模型）。用量趋势支持点击图例选择 Token 系列，左轴随可见系列调整；缓存率以虚线叠加在同一绘图区，右轴固定为 0–100%，精确读数保留。时段明细每页24行，CSV始终导出全部时段。样本概览支持局部检索上游、模型、凭据标签和按失败数排序，不改变请求日志的共享筛选；日志也可通过筛选标签逐项移除条件。

“导出完整备份”仅把草稿合入同版本的已保存配置；版本冲突时拒绝导出，可改用“仅导出已保存配置”。两种备份都可能包含直填密钥，应妥善保管。

导入候选以最后选择的文件为准，清除选择会使旧读取失效。已确认的导入不会因重新选文件而取消；提交结果标明原文件，且不会清除新候选，同一时间只允许一笔导入提交。

默认情况下，日志会记录这些信息：

- 路由类型
- 状态码
- 模型映射
- 实际发送给 Primary Responses 上游的 `reasoning.effort`
- 上游主机
- 耗时
- request id
- 可选的客户端请求体
- 可选的实际上游请求体
- 可选的上游响应体

元数据始终持久化到本地 SQLite。只有 `logging.persist_body = true` 时正文才进入 SQLite；推荐保持关闭并通过有界抓包目录按需诊断。Studio 日志列表不返回正文或本机抓包路径，展开详情后也只有点击“查看抓包”才会加载原始内容。抓包查看器会对“客户端请求 → 上游请求”和“上游响应 → 客户端响应”做最多 200 项的结构化 JSON 对比；正文截断或不是 JSON 时明确标为不可比较。压缩日志还保存实现名、请求 compaction/trigger 数和响应 compaction 数，便于定位协议漂移。

### 密钥池与优先级

在“连接与路由”的 Codex 或 Claude 主路由中，通过“API Key 使用顺序”统一排列直填密钥与池内密钥。支持拖拽、上移、下移、置顶和撤销排序；例如排成 `2→1→3→4` 后保存即可。数字优先级在展开项中编辑，为 **0–100 的整数，数值越大越优先**；旧配置或留空按 0 保存。

- 配置字段为直填密钥的 `api_key_priority` 和池条目的 `api_keys[].priority`；编辑优先级、标签或顺序不会更换条目 ID，也不会清空已保存密钥。
- 自动调度先保留健康可用的会话绑定，再为新会话选择本档案中最高可用优先级。高优先级密钥处于冷却、隔离或仅服务旧会话的保留期时，会使用下一档；全部阻塞时仍按最快解封规则回填。
- 同级使用原来的 `fill_first`（按配置顺序使用，直填密钥在前）或 `spread`（分摊新会话）；优先级不跨档案比较，不改变档案路由顺序。
- Codex 关闭 `primary_failover.auto_schedule` 时，仍沿用固定选择行为，优先级只决定首把密钥，不开启自动故障切换。退出轮转的档案不参与自动候选选择，显式指定 Codex 档案也不启用自动调度。健康检查和模型目录等非轮转入口使用排序后的首把已配置密钥。

排序复用现有优先级字段，不新增顺序字段；撤销只恢复排序，不抹掉标签或密钥草稿。`spread` 不允许直接拖动破坏同级分摊，须先显式切换到故障转移。最多 101 把可生成严格优先顺序，停用与未填写项保留在列表但不计入候选。

Claude 默认路由与档案路由的密钥池都会根据完整流结果更新健康：HTTP 200 的错误/不完整流不算成功，客户端取消不触发冷却；未请求上游的本地结果只释放占用，不解除隔离。迟到的成功不能解除较新失败建立的限制。同 ID 更换凭据、目标或停用后重新启用会失效旧实例，旧请求不能污染新实例；单纯调序不清空健康。Primary 和 Claude 在途请求只释放自己预留的占用，不影响同 ID 新凭据的请求。

Primary 的本地准备失败以及复用 Primary 的 compact 缓存命中也只释放占用，不计上游故障或成功，不解除健康限制。

“首选”仅表示草稿优先级；“Active · 最近选用”来自真实代理请求发起前的脱敏 SSE `key_activity` 事件，只包含客户端作用域、档案/密钥 ID、时间与配置版本，不保存凭据或新增持久化数据。它不是实时健康、成功标记，也不代表所有会话只用这一把。刷新页面、断线或配置变更后等待新的观察；未保存的替换密钥不继承旧标记。预览、健康检查、模型目录和缓存命中不会伪造活动记录。

池内切换不是逐请求循环：已有健康会话继续绑定原 key，调序不会重置绑定或冷却。Codex 需要有效活动档案、自动调度开启且未退出轮转；显式指定 Codex 档案绕过自动调度。Claude 在请求解析到档案且有多把候选时默认启用池内选择；退出轮转后，新旧会话都固定使用排序后的首把启用密钥，即使它正在冷却，也不会自动切换。重新启用轮转后恢复健康与粘性选择规则。401/配额、429、瞬时错误按各自隔离/冷却阈值影响**后续请求**，不是失败请求立即跨 key 重发。

## 档案 OAuth

在 `/config/profiles` 添加授权连接，按厂商选择浏览器或设备码授权。授权完成后，填写模型 ID 并创建 Codex 或 Claude 档案；创建不会应用，也不会清除现有草稿。已有连接还可在“连接与路由”中绑定到四个独立槽位。绑定会清除该槽位互斥的 API key、环境变量和密钥池，URL 与上游协议由厂商连接管理。

| 厂商 | 授权方式 | 使用边界 |
| --- | --- | --- |
| OpenAI / ChatGPT Codex | 浏览器 PKCE、设备码 | ChatGPT Codex 权限，不等同 Platform API 额度；浏览器回调需要本机 1455 端口可用 |
| Google Gemini / Vertex AI | 浏览器 PKCE | 自有 Desktop OAuth Client ID/Secret、Cloud 项目与区域；使用项目权限和账单，不接入消费者订阅 |
| Qwen Code | 设备码 | 使用账号返回的受信模型端点和权限 |
| Kimi Code | 设备码 | Coding 端点、Anthropic Messages 格式，受套餐权限限制 |
| xAI | 设备码 | 受账号授予的 API 权限限制 |
| GitHub Copilot | 设备码、服务端令牌交换 | 仅 github.com；不自动开启组织策略禁用的模型 |
| OpenRouter | 浏览器 PKCE | 生成用户控制的 API key，无自动续期令牌 |

协议参考：[OpenAI](https://developers.openai.com/codex/auth)、[Vertex AI](https://cloud.google.com/vertex-ai/generative-ai/docs/start/openai)、[Qwen Code](https://github.com/QwenLM/qwen-code)、[OpenRouter](https://openrouter.ai/docs/guides/overview/auth/oauth)。公开协议或 CLI 的实现不代表厂商承诺第三方兼容性；模型目录可读也不等于模型调用已验证。Vertex 的兼容接口不提供账号模型目录，需填写项目启用的 `google/模型ID`。

Claude.ai 订阅登录不在此范围，Anthropic API 继续使用手动密钥，参见[厂商认证使用边界](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use)。OAuth 不改变已有协议转换限制：Chat 不支持的请求、私有 provider state 和厂商未支持的端点仍会明确失败。Codex OAuth 使用厂商 SSE 约定，非流式客户端收到聚合 JSON；Platform 专属参数不等同订阅接口参数。

凭据保存在配置同目录的 `compactgate-oauth.json`（自定义配置名对应 `<配置名>-oauth.json`），以 `0600` 权限原子写入，不进入公开配置、导出或版本备份。该文件包含敏感令牌，应按密钥文件保管；不是操作系统钥匙串。导入配置只带连接 ID，另一台机器缺少对应连接时明确报错，不回退其他密钥。过期连接按需刷新，同一连接并发刷新合并；被撤销时显示需重新授权。断开保留档案引用并删除本地凭据，不自动撤销厂商端授权；重新授权会创建新连接，需重新绑定原档案。

授权须从 loopback Studio 地址发起；离开授权面板会取消未完成会话。OAuth 主路由默认不参与自动轮转；应用后会持续固定在该档案（包括新会话和服务重启），直到手动应用其他档案。也可使用请求级 `--profile`，仅影响当前请求，不依赖故障转移主动选择该账号。

## 日志和本地数据库

日志颜色表示完整请求结果，不只是 HTTP 状态。`status >= 400`、非空 `error_summary`、失败/未完成终止事件或非成功 `stream_outcome` 均按错误显示；Token 用量只做计量，不能证明请求成功。HTTP 200 后收到 `response.failed`、`response.incomplete` 或断流仍显示红色，并保留原始 200；真实 502 不再因有 Token 显示绿色。`response.failed` 后即使出现 `[DONE]`，也不会覆盖失败。

同一判定用于前端列表、SQLite 筛选和统计；Primary 健康判定也不再以用量覆盖错误。新版启动会在事务中重建旧版正常/错误汇总，保留原始历史日志，不修改状态码或正文。

请求元数据会持久化到 SQLite，不按页面展示数量自动删除。数据库文件、WAL 和 SHM 侧写文件合计默认上限为 1 GiB。CompactGate 先完成 checkpoint 并重新测量；仍超限才清空四段历史正文并把 `body_status` 标为 `purged`，回收后仍超限才删除最早的元数据行。checkpoint 未完成会报告维护失败，不继续按旧占用量清理正文。

默认文件位置是：

```text
compactgate-logs.sqlite
```

日志库路径固定由配置文件路径派生。例如 `compactgate.json` 对应同目录的 `compactgate-logs.sqlite`。

## 调试抓包

如果你需要把单次请求写成独立 JSON 文件，包含脱敏后的请求头和正文，可以临时打开调试捕获：

```bash
COMPACTGATE_CAPTURE_DIR=/path/to/captures npm start
```

也可以在 Studio 的“配置 → 日志存储”中选择“分离存储”并设置目录。默认不开启抓包。

## 管理 API

如果你想自己对接页面或脚本，可以用这些接口：

管理接口仅接受 loopback Host；浏览器请求还必须来自 HTTP(S) loopback Origin，`Origin: null`、空值和跨站来源会被拒绝。没有 Origin 的本机命令行调用保持可用。

### `GET /api/health`

查看服务和上下游状态。

### `GET /api/config`

查看当前运行配置。

注意：这个接口不会返回明文 API Key。

### `GET /api/config/export`

导出完整配置。

这是本地可移植备份，会保留配置中直填的 API Key；`GET /api/config` 才是用于页面展示的脱敏配置。

可传 `?revision=<配置版本>`，服务端在同一次同步快照中校验版本；过期版本返回 409，不返回完整配置。省略版本仍导出当前已保存配置。

每次配置持久化前还会在同目录创建 `0600` 版本备份并保留最近 10 份：

- `GET /api/config/backups`：列出备份元数据
- `POST /api/config/backups/restore`：传 `{"backup_id":"...","confirm":true}` 恢复
- `DELETE /api/config/backups`：传相同确认结构删除

恢复前会先校验 JSON 和完整配置合同；校验或提交前失败不会改变内存或当前配置文件。全量导入还会拒绝已知对象/数组容器的错误类型，不将它们静默当作省略字段。

配置与 OAuth 文件在 rename 前设置权限并同步正文；rename 后若无法确认目录同步，返回明确的“已提交但耐久性未确认”错误。此时已保存内容和运行状态保持一致，新令牌不会被旧令牌覆盖；先检查存储，不要将 HTTP 500 直接理解为“没有保存”。

### `PATCH /api/config`

热更新配置并写回磁盘，不需要重启。

### `POST /api/test-route`

预览一条请求最终会怎么路由、怎么改模型。

### OAuth 管理接口

- `GET /api/oauth/providers`、`GET /api/oauth/accounts`：厂商与公开连接状态，不返回令牌。
- `POST /api/oauth/sessions`：传 `provider`、`method`、`label`；Google 另传 `settings` 中的 `client_id`、`client_secret`、`project_id`、`location`。
- `GET /api/oauth/sessions/:id`：查看状态；设备授权用 `POST /api/oauth/sessions/:id/poll`，遵守返回的 `poll_after_ms`。
- `POST /api/oauth/sessions/:id/complete`：传完整 `callback_url`，校验回调地址、state 和一次性授权状态。
- `DELETE /api/oauth/sessions/:id`：取消待定会话，不撤回已完成授权。
- `POST /api/oauth/accounts/:id/refresh`、`GET /api/oauth/accounts/:id/models`：刷新凭据、按需读取厂商模型目录。
- `DELETE /api/oauth/accounts/:id`：传 `{"confirm":true}` 断开本地连接。
- `POST /api/oauth/profiles`：传 `account_id`、`scope`、`name`、`model`、`revision`，新建但不应用；同名档案和版本冲突明确拒绝。

### `POST /api/compact/capability-probe`

传 `{"model":"MODEL"}` 对当前 compact 路径执行一次真实、30 秒上限、512 KiB
响应上限的原生压缩探测。探测不会写日志、bridge、去重、profile 健康或故障转移
状态；Chat 上游直接返回不支持，网络/上游错误通过 `supported=false` 返回。

### `GET /api/logs/recent`

分页读取日志。默认返回 `logging.keep_recent` 条；历史记录可以用 `limit` 和 `offset` 继续读取。

页面的 `latest_sequence` 是所有筛选之外的最新 SQLite 插入 ID，日志条目的 `sequence` 与 SSE 中相同，用于判断事件是否已计入快照。更新事件不增加计数；旧客户端可以忽略这两个新增字段。

`search` 使用字面子串匹配，`%`、`_` 和反斜杠不作为通配符；ASCII 字母不区分大小写，非 ASCII 字符按原文匹配。HTTP 查询与 SSE 实时筛选遵循相同规则。

统计下钻使用成对的 RFC 3339 `from` / `to`，按请求开始时间左闭右开，最长 31 天。可同时指定 `model` 精确匹配统计中的有效响应模型（上游声明或已标记的目标推断），空值 `model=` 选择未识别模型；省略则不限模型。时间与模型条件同样约束通道、状态和 Host 分面计数；`all_total` 仍是全库保留总数。

可以加筛选：

```text
?route=primary
?route=compact
?host=api.example.com
?limit=200&offset=200
```

### `GET /api/logs/:request_id`

按响应头 `x-compactgate-request-id` 查询单条元数据日志、正文状态与抓包生命周期状态。本机抓包路径和正文内容不会返回。不存在返回 404；旧数据库中若有重复请求 ID，返回 409 且不会删除历史日志。

### `GET /api/logs/:request_id/capture`

按需读取受管抓包。写入中返回 202，从未保存返回 404，已清理或文件丢失返回 410，重复请求 ID 返回 409。gzip/br/deflate 显示解压限制为 8MiB，超限显示诊断提示，仍可下载原始字节。

### `GET /api/logs/:request_id/capture/download`

下载同一条受管抓包的原始 JSON 文件，不派生或解压显示正文，不暴露本机路径。

### `POST /api/logs/maintenance/purge-bodies`

请求体必须包含 `{ "confirm": true }`。清空 SQLite 中四段历史正文、保留元数据行，并返回清理条数和清理前后数据库大小。

### `GET /api/events`

SSE 实时事件流。

它会推送两类事件：

- `snapshot`：当前配置、健康状态、当前日志页；维护改变日志数据时带 `logs_invalidated: true`，客户端应按当前筛选重新查询，而非合并旧窗口
- `log`：一条新完成的代理日志

## 开发

启动后端开发模式：

```bash
npm run dev
```

如果你还想单独跑前端开发服务器，再开一个终端：

```bash
npx vite --host 127.0.0.1 --port 5173
```

运行检查：

有运行中服务时，下面的构建与测试须在隔离副本执行，不覆盖服务使用的根 `dist/`。

```bash
npm test
npm run build
```

`test/ui-lifecycle.test.tsx` 使用测试专用 jsdom 与真实 React StrictMode，覆盖配置保存/SSE、模型目录 A→B→A、日志筛选/分页/重连竞态，可用 `npx vitest run test/ui-lifecycle.test.tsx` 单独运行。

`npx tsx scripts/benchmark-storage-prune.ts 1024 bodies cooperative` 创建并清理合成临时 SQLite 库及随机端口，测量回收、事件循环暂停和独立线程代理首字节延迟；不接受现有数据库或配置路径。用 `single-turn` 对照同一 SQL 的单轮执行，用 `metadata` 替换 `bodies` 测元数据压力分布。2026-10-23 本机 1.04GiB 正文库三组对照中，最大首字节延迟中位数从 382ms 降至 299ms，回收总耗时中位数从 386ms 增至 393ms；结果依赖硬件与数据分布，不能外推到生产。

2026-10-24 提交前复核：包含最新通用 agent 协议兼容的完整版本，在隔离副本通过 `npm run check`（146 个测试文件、1605 项通过、1 项因缺少本地抓包 fixture 跳过）。构建产物的合成 Primary/Claude 请求、用量落盘和 HTML/JS 资源冒烟通过；8MiB 正文/元数据库回收自检均通过。未使用生产凭据、重启现有服务或覆盖根 `dist/`；本次未重测 1GiB 性能对照。

Studio 总览随入口加载，其余页面首次打开时按需下载；React 运行时单独分包缓存。页面加载失败时仍可切换导航，也可手动刷新重试；刷新会丢失未保存的修改。

## 常见问题

### 1. Codex 没有调用 `/v1/responses/compact`，压缩还能分流吗

可以。新版 Codex 还可能把压缩请求发到普通 `/v1/responses`：本地压缩由 `x-codex-turn-metadata` 中的 `request_kind: "compaction"` 标识，Remote V2 由 `input[].type: "compaction_trigger"` 标识。CompactGate 会把它们记录为 `compact` 逻辑流量，但 Remote V2 实际复用 primary 上游与协议，不走 `/responses/compact`，也不需要 compact 模型。

如果日志仍显示为 `primary`，再检查 Codex 配置里是不是：

```toml
name = "OpenAI"
wire_api = "responses"
```

### 2. compact 请求走错了上游

去 Studio 页面里看：

- `compact.upstream_mode` 是不是你想要的值
- `compact.base_url` 配得对不对

也可以用 `POST /api/test-route` 预览。

### 3. 主上游已经支持 compact 模型，还需要单独 compact 上游吗

不需要。

这只影响 local/Remote V1。直接把：

```json
"upstream_mode": "primary"
```

这样 compact 请求也走主上游。

### 4. 日志会保存哪些正文

默认 `logging.persist_body = false`，SQLite 只保存可检索元数据，不保存客户端请求体、实际上游请求体、上游响应体或客户端响应体。兼容模式可打开 `persist_body`，但数据库达到容量上限时会优先清理这些正文。

需要原始请求和响应时，推荐配置有大小上限的独立抓包目录：

```bash
COMPACTGATE_CAPTURE_DIR=/path/to/captures
```

### 5. split 模式下 compact 之后下一次普通请求报错怎么办

请确认你运行的是新版 CompactGate。

这类报错通常不是超时。常见现象是 Codex 提示：

```text
Stream disconnected before completion: stream closed before response.completed
```

如果 primary 上游收到原始 `type: "compaction"`，但不能验证其中的 `encrypted_content`，上游可能会返回 `invalid_encrypted_content`，并且响应流里没有 Codex 需要的 `response.completed` 事件，最终就会显示上面的断流错误。

如果日志同时显示 `status=502` 与 `Client disconnected before upstream response completed.`，需要继续查看 `upstream_status`、`stream_terminal_event`、`client_disconnect_phase` 和 `stream_outcome`。Remote V2 或 Remote V1 在已经收到 `response.completed`/`[DONE]` 后，Codex CLI 可能先关闭连接而上游 HTTP 流尚未发出 `end`;新版会保留真实上游状态和已缓冲响应，并记录 `stream_outcome=success`、`client_disconnect_phase=after_terminal`，不再把它当作压缩失败。终止事件之前关闭仍记录为客户端取消或未完成流；真实上游 5xx 仍保留为上游错误。

日志中的 `response_model` 只表示响应中明确返回的模型。流式观察与全文解析均优先采用首次有效 `response.completed` 模型声明，否则保留最后一次有效声明。Remote V2 的 `response.compaction` 可能不携带 `model`，此时 `response_model` 保持为空，`effective_response_model` 则在成功时使用 `target_model`，并由 `response_model_source=target_fallback` 标记为“目标模型推断”。没有模型声明的失败、取消或未完成流标记为 `unavailable`。超出流观察器 payload 上限的完整 `response.completed` 仍会按事件名识别，但不能据此推测未读取的模型，并记录 `stream_oversized_event_count` 供诊断。

Studio 的“首响应”表示收到上游第一个响应数据块的耗时，可能是元信息或心跳，不等于首个生成 Token。历史 API/SQLite 字段仍名为 `first_token_ms`，统计中的同名前缀字段也沿用这一口径，不重新解释历史数据。

`generation_sample` 是日志 API/SSE 与 SQLite 中新增的可空采样对象：`first_output_ms` 是相对本次请求开始的首有效输出耗时，`duration_ms` 是该源流从首有效输出到成功终态的耗时，`output_tokens` 是同一次源流结尾报告的输出计数。它只用于生成速度，不额外计费，也不与转换后的日志用量混算。采样复用有界 SSE 解压/观察器，识别已支持协议的非空文本、思考与工具调用输出，忽略信封、心跳、空增量和签名；在源协议终态冻结，不等待 HTTP 收尾、连接池 drain 或日志落盘。重试只保留最终响应的样本。

旧日志、源 JSON、计数端点、缓存重放、失败、终态前取消、不完整流、缺失最终输出 usage 或观察受损时不推算生成速度；成功终态后正常提前断开沿用既有成功语义，可保留完整采样。正常完整采样不足 100ms 时保留原始值，但显示 `-`，不沿用上次速度。诊断正文前缀截断不等于观察器失效：只要完整源流仍被有效观察，样本可保留。生成速度是代理观察值，仍受上游缓冲、网络、解压调度和未展示思考的影响，不是纯 GPU 解码速度，也不保证与 dsh/ccline 的不同观察点读数完全一致。

当前版本在 `compact.upstream_mode = "split"` 时，会把成功 compact 响应里的可读 summary 状态记录下来。下一次包含同一段 `encrypted_content` 的普通 `/v1/responses` 请求会继续走 primary，但 CompactGate 会先把可读 compact 状态转换成 assistant summary message，再转发给 primary。

这个修复支持英文和中文等 Unicode 可读摘要，可以避免把可读摘要误当成不可解密的 compact 加密状态发给 primary。如果 compact 上游只返回不可读的加密状态，CompactGate 不能解密它，primary 仍可能无法恢复这段压缩上下文。

如果你刚更新代码，请重新执行构建并重启 CompactGate，让运行中的 `dist/server/main.js` 加载新版本。
