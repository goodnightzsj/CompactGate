# CompactGate

CompactGate 是一个给 Codex CLI 用的本地代理。

它的作用很简单：

- 普通请求继续发到你的主上游
- 只有 compact 请求单独分流
- 必要时自动改写 compact 模型名
- 你还能在本地页面里看配置、健康状态和最近日志

如果你现在还不清楚 “compact 请求” 是什么，也没关系。你只要记住：

> CompactGate 让 Codex 在“正常对话”和“压缩上下文”这两类请求上，可以走不同的上游。

## 这个项目解决什么问题

很多时候你会遇到下面几种情况：

1. 你的主上游能跑正常对话，但不支持 compact 模型。
2. 你想把 compact 请求单独走另一家兼容 OpenAI API 的服务。
3. 你想保留原来的 Codex 使用方式，只在中间加一层本地代理。
4. 你想在本地看最近请求都走到了哪条路由，并保留完整请求 / 响应正文方便排查。

CompactGate 就是为这个场景做的。

## 30 秒理解工作方式

接入后，链路会变成这样：

```text
Codex -> CompactGate -> 你的上游服务
```

CompactGate 会按规则转发：

```text
普通 /v1/* 请求          -> primary 主上游
/v1/responses/compact -> compact 上游，或者仍走 primary
```

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

如果你不想用环境变量，也可以先启动服务，再去 Studio 页面里直接保存 API Key。

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

## Codex 怎么接入

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

这两项不要随便改，尤其是 `name` 必须保持 `"OpenAI"`，否则 Codex 可能不会按预期调用 `/v1/responses/compact`。

## 配置文件怎么理解

下面是一个最常见的配置例子：

```json
{
  "listen": "127.0.0.1:7865",
  "primary": {
    "base_url": "https://primary.example/v1",
    "api_key_env": "PRIMARY_API_KEY"
  },
  "compact": {
    "base_url": "https://compact.example/v1",
    "api_key_env": "COMPACT_API_KEY",
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
  }
}
```

`logging.keep_recent` 控制 Studio 首屏和 `/api/logs/recent` 默认返回多少条日志，范围是 1 到 2000，不是 SQLite 日志保留上限。SQLite 请求日志默认最多占用 1 GiB；超过后先清空历史正文并保留元数据，仍超限时才按时间顺序删除最早的元数据行。

推荐使用分离存储：保持 `logging.persist_body = false`，再设置 `logging.capture_dir`。每个代理请求会写入一份独立 JSON，单段正文默认最多 1 MiB，受管抓包文件合计默认最多 20 GiB。目录超限时只删除最旧抓包，SQLite 元数据继续保留并把 `capture_status` 标为 `purged`。把 `capture_dir` 热更新为 `null` 可停止新抓包；`COMPACTGATE_CAPTURE_DIR` 和 `COMPACTGATE_CAPTURE_BODY_MAX_BYTES` 仍优先于配置文件。

`logging.redact_body` 是为旧配置保留的兼容字段，当前不会改变 SQLite 正文或抓包正文；敏感鉴权请求头始终单独脱敏。Studio 不提供这个无效开关，保存其他日志设置时也不会重写它。

最重要的字段只有这些：

### `primary`

普通请求走的主上游。

### `compact`

compact 请求走的上游。

### `compact.upstream_mode`

可选值：

- `split`：compact 请求走 `compact.base_url`
- `primary`：compact 请求也走 `primary.base_url`

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

## Studio 页面能做什么

打开 `http://127.0.0.1:7865/` 后，你可以直接：

- 修改主上游和 compact 上游地址
- 切换 `split` / `primary` 模式
- 切换 linked / custom 模型改写方式
- 直接保存 API Key
- 预览某条请求会走哪条路由
- 查看健康状态
- 实时查看最近日志

日志是实时刷新的，使用的是 SSE。

默认情况下，日志会记录这些信息：

- 路由类型
- 状态码
- 模型映射
- 上游主机
- 耗时
- request id
- 可选的客户端请求体
- 可选的实际上游请求体
- 可选的上游响应体

元数据始终持久化到本地 SQLite。只有 `logging.persist_body = true` 时正文才进入 SQLite；推荐保持关闭并通过有界抓包目录按需诊断。Studio 日志列表不返回正文或本机抓包路径，展开详情后也只有点击“查看抓包”才会加载原始内容。

## 日志和本地数据库

请求元数据会持久化到 SQLite，不按页面展示数量自动删除。数据库文件、WAL 和 SHM 侧写文件合计默认上限为 1 GiB。超过上限时，CompactGate 先清空四段历史正文并把 `body_status` 标为 `purged`；回收后仍超限才删除最早的元数据行。维护任务执行 SQLite checkpoint/vacuum 回收磁盘空间。

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

### `GET /api/health`

查看服务和上下游状态。

### `GET /api/config`

查看当前运行配置。

注意：这个接口不会返回明文 API Key。

### `GET /api/config/export`

导出完整配置。

### `PATCH /api/config`

热更新配置并写回磁盘，不需要重启。

### `POST /api/test-route`

预览一条请求最终会怎么路由、怎么改模型。

### `GET /api/logs/recent`

分页读取日志。默认返回 `logging.keep_recent` 条；历史记录可以用 `limit` 和 `offset` 继续读取。

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

按需读取受管抓包。写入中返回 202，从未保存返回 404，已清理或文件丢失返回 410，重复请求 ID 返回 409。

### `GET /api/logs/:request_id/capture/download`

下载同一条受管抓包的 JSON 文件，不暴露本机路径。

### `POST /api/logs/maintenance/purge-bodies`

请求体必须包含 `{ "confirm": true }`。清空 SQLite 中四段历史正文、保留元数据行，并返回清理条数和清理前后数据库大小。

### `GET /api/events`

SSE 实时事件流。

它会推送两类事件：

- `snapshot`：当前配置、健康状态、当前日志页
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

```bash
npm test
npm run build
```

## 常见问题

### 1. Codex 没有调用 `/v1/responses/compact`

先检查 Codex 配置里是不是：

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

直接把：

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

当前版本在 `compact.upstream_mode = "split"` 时，会把成功 compact 响应里的可读 summary 状态记录下来。下一次包含同一段 `encrypted_content` 的普通 `/v1/responses` 请求会继续走 primary，但 CompactGate 会先把可读 compact 状态转换成 assistant summary message，再转发给 primary。

这个修复支持英文和中文等 Unicode 可读摘要，可以避免把可读摘要误当成不可解密的 compact 加密状态发给 primary。如果 compact 上游只返回不可读的加密状态，CompactGate 不能解密它，primary 仍可能无法恢复这段压缩上下文。

如果你刚更新代码，请重新执行构建并重启 CompactGate，让运行中的 `dist/server/main.js` 加载新版本。
