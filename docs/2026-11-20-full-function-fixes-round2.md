# 全功能审查修复：第二轮

本轮按审查顺序处理 R2-01 至 R2-14。保持已有协议、配置持久化、留存开关及成功请求行为；未增加依赖或部署到现有服务。

## 修复与回归边界

| 编号 | 修复后的行为 | 主要回归 |
| --- | --- | --- |
| R2-01 | 冲突覆盖按草稿祖先合并，隐藏连接变更须显式采用；失败不推进 revision，保存期间编辑保留 | `config-conflict-credentials.test.ts`、`ui-config-write-order.test.tsx` |
| R2-02 | 工具 id 后补或复用 index 时，后续仅带 index 的参数仍归属正确调用 | `protocol-fix-regressions.test.ts` |
| R2-03 | JSON error/failed/incomplete 和 SSE error 不记成功、不写成功压缩缓存；DONE 不抹掉失败 | `response-business-failure.test.ts`、`upstream-openai-stream.test.ts` |
| R2-04 | 草稿备份同步两个客户端活动档案，导入后的真实请求使用草稿；非活动档案不变 | `draft-backup-active-profile.test.ts` |
| R2-05 | 上传与 OAuth 等待执行剩余 deadline；单请求退出不取消共享刷新，未出站不惩罚健康 | `request-preparation-deadline.test.ts`、`upstream-attempt-attribution.test.ts` |
| R2-06 | transient、历史错误率与延迟评分在最后有效结果 60 秒后失效，使同级恢复 key 可重新参与调度 | `primary-key-recovery.scenarios.ts`、`primary-failover-key-pool.test.ts` |
| R2-07 | 用量只读协议计量位置，用户 metadata/工具内容不再污染 Token 统计 | `usage-metadata.scenarios.ts`、`usage.test.ts` |
| R2-08 | 大 Studio 快照分片并按 drain 继续发送；区分单帧与后续积压，保留慢客户端清理 | `studio-large-snapshot.test.ts`、`state-and-storage-bounds.test.ts` |
| R2-09 | 日志恢复触发必要的实际 bootstrap；配置未恢复时保留错误与重试入口 | `ui-bootstrap-poll.test.tsx`、`ui-stats-lifecycle.test.tsx` |
| R2-10 | 覆盖活动档案的确认明确说明立即应用；非活动档案只保存 | `ui-profile-overwrite.test.tsx` |
| R2-11 | 档案保存只校验并提交对应客户端；保存全部配置仍完整校验 | `ui-config-profile-persistence.test.ts`、`api-key-priority.test.ts` |
| R2-12 | Codex OAuth 探测复用实际响应适配，保留原始失败/截断检查，正确接受 response.done | `compact-capability-probe.test.ts`、`server-compact-capability-probe.scenarios.ts` |
| R2-13 | 预览入口规范化请求头大小写，与真实 HTTP 选择同一请求级档案 | `server-openai-request-profile.scenarios.ts` |
| R2-14 | 预览与实际代理共享方法/端点转换条件；未知端点不因协议不同误标 translate | `route-preview-protocol.scenarios.ts`、`routing.test.ts` |

测试文件均位于 `test/`。新增回归使用合成凭据、临时数据库与本地上游；配置和预览使用真实 HTTP 对照，UI 使用真实组件/hook 与 reducer。

## 兼容与行为变化

四路公开配置增加不透明的 `connection_revision`，用于判断隐藏连接材料是否变化；它由进程随机密钥生成、不含可重用凭据摘要，不替代模型目录标记。重启后标记变化，尚未提交的连接编辑可能需显式采用已保存连接；独立模型与日志编辑继续保留。冲突拒绝只给原草稿添加标记，不将中间远端值变为本地编辑，避免后续远端更新被覆盖。

公共 scope 提取器移至 `src/shared/config-profile.ts`，服务端保留原导出。导出同步活动档案只作用于“包含草稿”的备份；“仅导出已保存配置”和全量导入合同保持。

Compact 本地准备超时返回 502，与传输 deadline 一致；其他普通准备错误保持 400。准备阶段仅取消本次等待；OAuth 共享刷新仍可服务其他请求。请求体完成前未知是否属于 compact 时使用两路较大预算，完成分类后执行实际路由的剩余预算。

健康硬冷却、隔离、优先级和粘性没有取消；评分失效仅恢复参与选择的机会，不证明上游健康。Studio 单帧不受积压门槛限制，后续帧超过 8 MiB 或持续 30 秒无 drain 时仍断开慢连接；序列化和排队仍占内存。

业务失败识别不改变上游原 HTTP 状态与正文，不扩大自动重放或加密字段清理。用量修复只影响新记录，不改写历史统计。Codex OAuth 探测仍受 512 KiB/30 秒限制，普通 Responses 不接受专属 response.done 终态；探测失败不代表真实大响应请求必然失败。

## 验证记录

最终隔离工作目录：`/tmp/compactgate-round2-final.CaAZoW/check`，按现有锁文件执行 `npm ci`，未修改项目依赖。完整任务记录为 `.codex-tasks/20261120-review-round2-fixes/PROGRESS.md`，最终门禁与冒烟日志保存在同目录 `raw/check-final.log`、`raw/smoke.log`。

14 项定向回归已完成。最终 `npm run check` 按既有顺序通过差异、样式、严格类型、全量测试和构建：207 个文件、3199 项通过、1 项因既有私有抓包 fixture 缺失跳过。源代码和测试与隔离副本逐字节一致，根工作区另行执行 `git diff --check` 通过。

构建产物使用随机端口 `http://127.0.0.1:59127` 完成冒烟，结束后已关闭。数据来自合成上游和 `/tmp/compactgate-round2-smoke-U2LMUX` 内独立配置/SQLite，未使用生产会话或凭据。验证健康与公开配置、HTML/JS 缓存头、SPA 路径、primary/local/remote_v1 三条加密恢复入口、失败 compact 不缓存、Studio SSE 快照和统计 worker；5 条代理请求产生 8 次合成上游尝试，断言全部通过。

复核追加的配置交错反例先确认失败（remote-B 覆盖 remote-C），随后修复，相关 3 文件 48 项通过。早期完整门禁有 6 项旧断言因 R2-03 更改 `response.failed/incomplete` 的默认错误摘要而失败；已恢复原兜底文案，保留实际上游错误的详细摘要，未修改断言。相关 8 文件 117 项通过，最终全量也覆盖这些场景。

续跑时，早期 `/tmp/compactgate-round2-fixes.3tCOer` 的隔离目录、原始日志及第三次门禁进程已不可用，其结果只保留在任务记录中，未将未确认完成的门禁算作通过；最终验证使用重建的隔离副本。续跑前后，现有 7865 服务 PID 均为 8239，根 `dist/server/main.js`、`dist/public/index.html` 的 SHA-256 仍与任务最初基线一致；本轮未执行服务切换或覆盖根产物。

R2-12 首次相关套件 90 通过、1 条既有 Qwen 授权用例超过 5 秒；单独诊断同一用例 86ms 通过，最终全量也通过，未修改生产逻辑或测试超时，不把后续通过称作已消除偶发超时。早期一次误在根目录执行的定向测试因缺少 jsdom worker 失败，后续测试/构建均使用依赖完整的隔离目录。

未验证真实供应商/OAuth、生产会话、浏览器视觉与移动端人工交互、长期并发或断电。有限回归与代码复核不能保证穷尽所有缺陷。
