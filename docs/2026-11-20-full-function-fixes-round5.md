# 全功能修复第五轮

2026-11-20。按第五轮审查确认的 14 项顺序修复，保留已有工作区变更。范围和验收记录位于 `.codex-tasks/20261120-review-round5-fixes/`。

## 修复与合同

| 编号 | 结果 | 实现与回归 |
| --- | --- | --- |
| R5-01 | 超过数据库配额时先回收已释放页，避免检查点删除后误删可保留日志。 | `logger.ts`；`logger-freed-pages.test.ts`，同步/deferred、无空页对照。 |
| R5-02 | Studio 保存/覆盖档案要求已加载 config 和 formRevision，加载失败不发写请求。 | `configProfilePersistenceActions.ts`、`ProfileScopeCard.tsx`；`ui-profile-loading.test.tsx`，两作用域和覆盖确认。 |
| R5-03 | completed 事件内部的 failed/incomplete/error 仍按失败结算，不记健康证据、compact 去重或生成样本。 | `upstream-openai-stream.ts`、`usage-error.ts`；`responses-envelope-status.test.ts`，JSON/SSE 和普通/compact 对照。 |
| R5-04 | Anthropic 普通和 compact 转换发出终态后不再发内容或第二个终态。 | `protocol-stream.ts`；`protocol-anthropic-terminal.test.ts`，转换及 HTTP。 |
| R5-05 | 连续恢复先将实际请求中的位置变成稳定定位；无 ID/字符串密文时使用请求内条目指纹，保留无关 compaction。 | `provider-state-migration.ts`、`provider-state-portability.ts`；`provider-state-recovery-boundaries.test.ts`，指纹规则不落盘且保留既有缓存的回归。 |
| R5-06 | 通用恢复的后续尝试重新排除鉴权、限流、配额、模型/端点错误。 | `provider-state-migration.ts` 复用既有资格函数；两次失败门槛 HTTP 与合法 strict 对照。 |
| R5-07 | 压缩错误按响应头解码后执行相同排除规则，解码失败停止通用降级。 | `provider-state-evidence.ts` 复用 `decodeResponseText`；identity/gzip/br/deflate/zstd 及 HTTP。 |
| R5-08 | 导入、启动加载、备份恢复拒绝已知标量字段的错误类型，避免静默清空凭据或采纳默认值。 | `config-import-validation.ts`；`config-import-validation.test.ts`，失败保留内存、版本、文件和备份，合法省略及 legacy 保留。 |
| R5-09 | 同 kind 预设 ID 唯一；编辑 URL 后自动记录旧地址会避开已占用 ID。 | `config-route-presets.ts`、`config.ts`；`config-preset-identity.test.ts`，可选中性、原子拒绝和跨 kind 对照。 |
| R5-10 | API 纯改名不改写 URL 预设的凭据、时间或次数。 | `config-profile-mutations.ts`；`config-profile-rename.test.ts`，Codex/Claude HTTP。 |
| R5-11 | 超时响应后，请求生命周期仍持有完整的自动档案提交及通知，关停等待结束再关库。 | `openai-proxy.ts`、`http.ts`；`scheduled-profile-shutdown.test.ts`，真实合成 main.ts 子进程、SIGTERM、primary/compact、迟到失败。 |
| R5-12 | Claude 亲和按 profile/session 分域，各场景档案不覆盖彼此的 key pin。 | `claude-key-pool.ts`；`claude-profile-affinity.test.ts`，选择器及跨场景 HTTP。 |
| R5-13 | 身份写入确认进入共享 health，增加读取 revision；导航、旧 GET 和较新 SSE 保持正确归属。 | `useStudioBootstrap.ts`、`ClientIdentityPanel.tsx`；`ui-studio-live-state.test.tsx`，无 SSE、晚读、写失败和较新快照。 |
| R5-14 | capture 生命周期更新取消旧读取并作废旧 pending/空/错误状态，保留已加载正文。 | `LogCaptureViewer.tsx`；`ui-studio-live-state.test.tsx`，终态更新与迟到 202。 |

## 验证记录

逐项针对性检查均通过，原始输出为任务目录 `raw/r5-*.log`。测试集合有交叉，不相加当作全量总数。

关停补测首次 compact fixture 沿用了默认长超时，因此并未触发预期的“响应先超时、提交仍待完成”。已将合成 compact 预算与 primary 一致，保留首次失败记录，修正后两个 compact 子进程用例通过。没有修改产品语义或削弱断言来掩盖失败。

最终 `npm run check` 按原顺序完成差异检查、样式检查、严格类型检查、全量测试及构建，退出码 0。230 个测试文件通过，3460 项通过、1 项因既有真实抓包 fixture 缺失而跳过；没有读取或复制生产抓包。完整日志：`.codex-tasks/20261120-review-round5-fixes/raw/check-final.log`。

最终复核将 R5-05 条目指纹限定在当前请求内，避免旧版本忽略新定位字段后扩大清理范围。调整后的恢复回归 345 项通过、1 项既有跳过；随后重跑上述完整门禁。复核未确认其他阻断问题。首轮检查记录保留，不能替代最终代码验收。

构建产物 HTTP 冒烟通过：健康与公开配置、Studio HTML/静态资源/SPA、primary/local/remote_v1 三类恢复入口、失败 compact 不缓存、SSE 快照和统计 worker。共 5 次代理请求、8 次合成上游调用。临时地址 `http://127.0.0.1:64611` 在验证结束后已关闭；数据位于 `/tmp/compactgate-round2-smoke-S1jG8o`，全部为本地生成的合成数据。脚本复用既有 round2 冒烟，实际加载本轮构建产物，结果见 `raw/smoke-final.log`。

本轮验证目录为 `/tmp/compactgate-round5-fixes.XtfhyP/check`，依赖锁与隔离依赖副本一致，最终 src/test 与工作区一致；原工作区已有的修改保留，隔离仓库以修复前快照作为 diff 基线。更新文档的 17 个本地链接有效，工作区 `git diff --check` 通过。

## 行为变化与保留边界

- 严格导入新增标量类型拒绝，同 kind 预设 ID 冲突明确拒绝；普通 PATCH 的其他宽容合并语义保留。
- 不新增依赖、数据库表、恢复缓存、持久化字段或留存开关。条目指纹仅用于请求内定位，不写入恢复 policy，也不保存条目正文；旧记录可读，检查点仍默认关闭。
- 调度超时结束客户端等待，已开始的原子提交仍可能稍后生效；关停会等待完整提交和通知，超过现有进程退出预算仍明确失败。
- 失败流已交付的字节不能撤回；修复统一结算和转换终态，不保证第三方客户端识别所有畸形协议。
- 所有验证使用独立目录、空闲端口、合成凭据和数据库。未读取生产会话、运行真实 Codex/Claude CLI、访问厂商 OAuth，未做真实浏览器视觉或长期负载验证。
- 本轮修复验收时未提交、push 或部署。验收后 7865 监听仍为 PID 8239，根 dist 校验与修复前一致：`server/main.js` SHA-256 为 `d1e80c1acb169446b2ada53d2fe232bf3380e54bba56835cd65493baa34e7979`，`public/index.html` 为 `26d50ef3acbc405a2944d9e85240afae8044828e066f183ae2d69b6e57c4e2ed`。

## 后续提交范围

同日用户授权同步文档后提交并推送，范围包括 11 月 18–20 日已完成但尚未提交的请求容量、全局恢复、协议、配置、存储、调度、服务脚本及 Studio 修复，也包括对应回归和阶段文档。本轮 14 项属于这个累计提交；各阶段测试数量不重复累加，最终统一验收以本文的 230 文件、3460 项通过为准。

提交前再次确认源码、测试、依赖锁及构建配置与上述已通过的隔离副本一致；文档同步校正请求准备阶段的主动超时说明。README 与 `docs/` 纳入提交，`llmdoc/` 和 `.codex-tasks/` 按既有规则仅本地维护，不强制加入版本控制。提交推送不执行服务切换。
