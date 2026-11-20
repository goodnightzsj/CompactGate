# 三项复审修复（2026-11-19 开始）

按顺序修复最近改动复审确认的三项问题。保留现有可选留存、协议转换、失败响应及资源预算，不新增配置、Schema 或依赖。

| 问题 | 修复与边界 | 验证 |
| --- | --- | --- |
| Responses 切到 Chat/Messages 后第三轮 422 | plan 保留转换前已恢复的 Responses 请求；成功后用客户端完整 Responses 输出续存新 ID。保留工具回合和 fidelity；关闭留存、代次撤销、源或客户端截断、失败、取消、观察受损及输出不完整时不存。原生 Responses 仍核对适配前后输出窗口 | 8 组 JSON/SSE × Chat/Messages × exact/degraded 四轮 HTTP，修前均在第三轮失败；检查点拒绝边界与路由共 115 项通过 |
| CR 单独换行的 SSE 被误判或转换失败 | 公共分帧、观察器、协议转换、检查点、模型提取和能力探测接受 CR/LF/CRLF。跨块 CRLF 只消费一次；保留 UTF-8、原文、预算及既有 EOF 修补 | 15 文件 263 项通过，含原生/OAuth 历史恢复、早期加密失败、压缩流、多行数据、逐字节切分、32 MiB 帧预算 |
| 合法压缩空正文显示为无法解压 | 严格解压允许空输出，flush 仍需非空前缀；zstd 零输出另校验完整帧边界，防止运行时将截断帧静默视为空输出 | 抓包、日志 API、UI 共 85 项通过；合法 gzip/br/deflate/zstd 空流、截断、超限和原始字节保留 |

SSE 行结束依据 [WHATWG §9.2.5–6](https://html.spec.whatwg.org/multipage/server-sent-events.html#parsing-an-event-stream)。本次只统一换行，保留项目 EOF 兼容，不宣称实现完整浏览器 EventSource 规范。观察预算修正了 CRLF 中 CR 曾被暂计为字段字节的问题，不改变配置值。

Node v22.22.0 的 [ZstdDecompressContext](https://github.com/nodejs/node/blob/v22.22.0/src/node_zlib.cc) 只对解压错误码报错，未将“还需要更多输入”作为失败；本地复现了不完整帧头返回空 Buffer。有限边界检查遵循 [Zstandard v1.5.7 帧格式](https://github.com/facebook/zstd/blob/v1.5.7/doc/zstd_compression_format.md)，内容及校验和仍交给 zlib；只在零输出时执行，保留既有非空前缀展示。测试覆盖无长度头、校验和、多块、拼接帧、可跳帧及每个截断前缀。

隔离验证目录为 `/tmp/compactgate-three.wimD30`。`env -i PATH="$PATH" npm run check` 已通过差异、样式、严格类型、188 个测试文件（2929 项通过、1 项因缺少本地抓包 fixture 跳过）和构建。失败与修后日志保留在 `.codex-tasks/20261119-review-three-fixes/raw/`；首次 SSE 回归中的 OAuth 文本断言已按现有 `input_text` 适配格式修正。

最终逐字节核对根目录与隔离目录的 405 个源码/测试文件一致。现有 `127.0.0.1:7865` 仍为 PID 19095；根 `dist/` 共 230 个文件，最新修改时间仍为 2026-11-19 02:41:11（北京时间），未被本轮构建覆盖。README 与受影响 llmdoc 已同步。

检查点仍默认关闭，无法补造从未留存的历史。HTTP 与 OAuth 验证均用合成授权及本地上游，未使用真实账号。既有工作区改动保留；未提交、push 或切换现有服务，运行中的服务尚未采用本轮修复。
