# 全功能审查修复：第三轮

按报告顺序完成 R3-01 至 R3-10 功能修复，并修正 R3-11 文档偏差。范围为凭据草稿、Codex 状态恢复、调度身份、源流失败、Token 计量、Studio 健康状态和能力探测；没有新增依赖、恢复留存、缓存或请求上限。

## 修复与回归

| 编号 | 修复后的行为 | 主要测试 |
| --- | --- | --- |
| R3-01 | 四路草稿先应用预设 key/env，再覆盖显式直填 key；清空 key 不继承旧 host 的 env | `draft-preset-credentials.test.ts` |
| R3-02 | Codex 无输出的 `response.done(status=failed)` 加密拒绝进入既有恢复；普通 Responses 不扩展终态 | `oauth-state-failure-recovery.test.ts`、`provider-state-stream-gate.test.ts` |
| R3-03 | 直填 key 的内部身份和状态域不随备用 key 数量改变，保留隔离与续接绑定 | `direct-key-identity.test.ts`、`api-key-priority.test.ts` |
| R3-04 | 已观察的源流显式失败保留到统一结果，适配器成功终态不能掩盖错误或写入健康证据 | `oauth-state-failure-recovery.test.ts` |
| R3-05 | 草稿备份同步当前 URL 的已有预设凭据；导入后切走再切回不复活旧 key | `draft-preset-credentials.test.ts` |
| R3-06 | response/message 信封计量优先于中继补零的事件根 usage，不读取用户 metadata | `usage-envelope.scenarios.ts`、`usage-metadata.scenarios.ts` |
| R3-07 | Anthropic compact SSE 与 JSON 的输入总量、缓存读写明细一致，后续补零不抹掉计数 | `compact-stream-usage.test.ts` |
| R3-08 | 配置元数据写回不清除 bootstrap/health 错误；完整快照才提供恢复信号 | `ui-health-ownership.test.tsx` |
| R3-09 | Codex 局部状态不作废完整健康刷新；较新完整快照仍拒绝旧 HTTP 成功和失败 | `ui-health-ownership.test.tsx`、`ui-stats-lifecycle.test.tsx` |
| R3-10 | Anthropic 探测复用公共解码与 SSE 多行分帧，支持 gzip/br/deflate/zstd JSON/SSE | `compact-probe-framing.test.ts` |
| R3-11 | 文档改为两张 bridge/dedupe Map；原生 Responses 不因已见密文或缺摘要而前置 422 | `compaction-bridge.ts`、`openai-proxy-plan.ts` 与相关 llmdoc 对照 |

测试位于 `test/`，使用合成凭据、临时数据库、本地上游与真实 React hooks。完整快照的旧测试模拟已补齐真实健康更新和恢复通知；被替代的局部合并函数及其专用测试已移除，行为由 hook 集成用例覆盖。

## 行为与兼容边界

恢复继续固定目标和凭据，共享四个不同正文预算及 64 KiB/1 秒的前缀窗口；输出、工具活动、取消或响应提交后不重放。源流迟到失败只影响诊断与健康归因，不撤回已经发送给客户端的成功字节。未开启历史留存，不能据此保证完整恢复不透明 compaction 中独占的历史。

直填 key 的内部候选 ID 规范化为 legacy profile 身份，普通池项保持复合 ID，公开池 key ID 不变。旧版本多 key 直填项的持久 domain 不批量改写；跨重启首次请求可能仍读到旧 domain，成功后按当前域重新绑定。明确的 `state_domain_id` 不受影响。

备份仅同步当前连接的已有 URL 预设，不改变其他历史 URL、使用计数或时间。OAuth 不写入手动预设。计量修改只影响新响应与新日志，不回填历史数据。健康采样 revision 仅属于 UI 内存，不改变服务端 API 或持久化 Schema。

探测沿用 512 KiB 响应缓冲、30 秒 deadline、公共有界解码以及失败/终态检查。探测不支持或失败不代表较大的真实压缩请求必然失败。

## 验证记录

各项原失败反例及相关边界测试已通过。隔离副本按项目原顺序执行 `npm run check`，差异检查、样式检查、严格类型、214 个测试文件和构建全部通过：3248 项通过，1 项既有可选真实抓包用例因未复制生产抓包而跳过。测试耗时 223.89 秒；过程证据见 `.codex-tasks/20261120-review-round3-fixes/raw/check-final.log`。

构建产物合成 HTTP 冒烟通过，验证健康/公共配置、Studio HTML 与静态资源、SPA fallback、三个恢复入口、失败 compact 不缓存、SSE snapshot 和统计 worker。复用上一轮已核实的合成脚本，8 次本地上游尝试；临时地址 `http://127.0.0.1:58147` 已关闭，数据来自独立合成配置及 `/tmp/compactgate-round2-smoke-voz1FB` 临时数据库，未使用生产凭据。证据见同目录 `smoke-final.log`。

严格类型的前置诊断发现新增档案 fixture 缺少必需字段，修复并正确同步隔离副本后通过；首次诊断与误同步后的失败记录均保留。正式完整门禁首次执行通过。最终复核确认 7865 仍由 PID 8239 监听，根 `dist/server/main.js` 与 `dist/public/index.html` 的 SHA-256 均与开始时一致。

验证隔离目录为 `/tmp/compactgate-round3-fixes.zjkHfl/check`，复用与锁文件一致的既有隔离依赖。根工作区已有修改全部保留；未执行提交、push 或现有服务切换。

未验证真实供应商/OAuth、生产会话、浏览器视觉与长期并发。有限回归不能证明所有未来输入均无缺陷。
