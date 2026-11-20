# 全功能修复第四轮

2026-11-20。针对第四轮审查确认的 8 项问题，按报告顺序修复；基于已有未提交改动继续工作，没有重写或回退前轮修改。

## 修复与行为边界

| 编号 | 修复 | 权威位置与验证 |
| --- | --- | --- |
| R4-01 | 选择 URL 预设后编辑、清空或撤销清空直填 key，保留预设环境凭据归属，避免继承旧目标的环境密钥。手工修改 URL、切换 OAuth 仍取消原预设绑定。 | `RouteConfigPanel.tsx`；18 项真实 UI 顺序测试及既有保存/导出/池隔离，共 44 项通过。 |
| R4-02 | assistant refusal 历史可继续回放：Chat 保留 refusal 块，Messages 保留拒绝文字；混合顺序、角色与非法块校验不变。 | `protocol-conversion.ts`；历史转换、真实 Chat 两轮请求及既有协议，共 82 项通过。 |
| R4-03 | Primary 和复用 Primary 的 compact 在自动切换档案时，将配置队列/落盘等待纳入总请求预算及客户端取消。结束等待后释放预留，不再出站；底层原子提交和通知仍完整完成。 | `openai-proxy.ts` 复用 `waitForRequestPreparation`；两入口正常/超时/断连及调度回归，共 64 项通过。 |
| R4-04 | Codex 首个终态后继续保留已观察到的失败/incomplete/error。失败不记成功健康证据或检查点，即使尾帧保留相同 output。客户端不重复终态或重放已输出请求。 | `oauth-response.ts`、`provider-state-checkpoints.ts`；JSON/SSE、留存 0/1 小时矩阵及既有 OAuth/恢复回归，共 170 项通过。 |
| R4-05 | 普通与 compact 的 Anthropic SSE 在转换前逐字段合并计量；部分重报、补零、分帧增长和缓存折叠均沿用日志计量规则。 | `protocol-stream.ts` 复用 `normalizeUsageRecord`/`mergeUsage`；JSON 对照、真实 HTTP 与计量回归，共 84 项通过。 |
| R4-06 | 导出操作独立持有错误，仅最新请求更新；不覆盖 bootstrap/health 状态，同时失败时并列展示，导出先失败再成功仍保留健康错误。横幅可重试原导出方式。 | `useConfigActions.ts`、`useStudioPageModels.ts`；9 项导出组合和试算、健康、写入回归共 124 项通过。 |
| R4-07 | 试算绑定已保存 config revision。版本变化清结果/错误并取消在途请求，旧成功/失败不回填；同版本快照和草稿编辑保留结果。 | `useRoutePreviewAction.ts`；含 A→B→A、迟到失败、写入顺序及档案回归，共 119 项通过（含前项 6 个导出测试，不重复汇总）。 |
| R4-08 | 使用 Node 平台信号编号返回 `128 + signal`，SIGKILL 返回 137；正常退出码与启动失败传播保留。 | `agent-launcher.ts`；11 项通过，含真实合成 Node 子进程与监听释放。 |

各项日志位于 `.codex-tasks/20261120-review-round4-fixes/raw/r4-*.log`。测试数是各检查集合数量，存在交叉，不相加当作全量总数。

导出错误的连续故障补验先确认 2 个反例失败、2 个对照通过；将导出错误留在操作 owner 后全部通过。静态导出用例继续检查 revision 和拒绝下载，错误呈现由真实 React hook 用例验证，见 `r4-06-chain-before.log`、`r4-06-owner-final.log`。

原有 `ui-lifecycle` 中 4 个旧预期依赖健康/导出相互清错，随本次错误归属合同更新为精确检查双错误并列和各自恢复，保留健康快照时序断言；相关 47 项通过，见 `r4-06-lifecycle-final.log`。未将偶然重跑通过视为修复。

## 验证

针对性回归和独立严格类型检查已通过。类型诊断首次发现两处新测试夹具类型问题及隔离副本漏拷既有 `upstream-latency.ts`；修正后通过，保留首次失败记录。代码与测试没有为通过而削弱断言。

隔离目录 `/tmp/compactgate-round4-fixes.Bs6COv/check` 的完整 `npm run check` 已按 diff、style、strict type、全量测试、build 顺序通过：220 个测试文件、3355 项通过、1 项跳过；日志为 `raw/check-final.log`。跳过项依赖未提供的真实 welfare 抓包，未读取或复制生产抓包补齐。最终验证副本的 `src/`、`test/` 与工作区一致。

构建产物合成 HTTP 冒烟通过，检查健康与公开配置、Studio HTML/缓存资源/SPA 回退、三个加密状态恢复入口、失败 compact 不缓存、Studio SSE 与统计 worker；共 8 次合成上游请求，日志为 `raw/smoke-final.log`。临时预览地址 `http://127.0.0.1:54864` 已随验收关闭，数据仅来自 `/tmp/compactgate-round2-smoke-g1Imwh` 中独立生成的合成配置、凭据和数据库。

验收前后确认现有 `127.0.0.1:7865` 仍为 PID 8239，根 `dist/server/main.js` 与 `dist/public/index.html` 的 SHA256 均与基线一致；未切换服务。根仓库 diff 检查和 15 个本地文档链接检查通过。

## 保留边界

- 本轮不新增依赖、持久化 Schema、缓存、请求拒绝上限或恢复留存设置。检查点仍默认关闭；普通 Responses 不因 Codex 专属 `response.done` 被放宽终态要求。
- 失败证据限于结算前实际观察到的源流。已结束请求后的不可见尾流无法追溯；已交付字节不会被撤回。
- 调度超时结束的是请求等待，已经启动的配置事务仍可能稍后提交，避免破坏原子落盘和通知语义。
- 复现与验证只用随机空闲端口、合成配置/凭据/数据库和隔离构建。未调用真实 Codex/Claude CLI，未检查生产会话或真实厂商 OAuth。
- 未做真实浏览器视觉、长期负载与全部供应商组合验证；全量回归不表示穷尽所有未来输入和时序。未提交、push 或部署，当前服务保持原样。
