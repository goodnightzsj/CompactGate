# 全功能审查 16 项修复

本轮按确认报告落实 F01–F16，覆盖配置、加密状态恢复、调度、协议转换、抓包、关停、代理、UI 和输入验证。没有增加依赖、持久化 Schema 或会话留存默认值；保留同目标重试、总超时和已输出后不重放的约束。

## 修复与回归对应

| 编号 | 修复后的行为 | 主要回归 |
|---|---|---|
| F01 | 跨目标选择凭据预设时清除旧密钥池句柄；显式新密钥与同 URL 继承保留；四种路由的保存、档案和草稿备份保持一致 | `preset-credential-boundary.test.ts`、`ui-preset-credentials.test.tsx`、配置凭据/档案场景 |
| F02 | 完整草稿备份保留非表单字段，包括恢复留存时长 | `ui-config-form-state.test.ts` 的 ConfigStore 导出导入 |
| F03 | 实际发送正文的嵌套 agent 块定位转为稳定密文 hash，连续恢复不会发生索引漂移；无效块坐标停止恢复，不扩大删除 | `provider-state-migration.test.ts` 的连续、缓存及无效定位 |
| F04 | 原生 Responses local compact、Remote V1 复用共享状态恢复；三入口均支持明确 HTTP/早期 SSE 错误和 off 开关 | `provider-state-entrypoints.test.ts`、stream gate/recovery、compact bridge |
| F05 | 非活动档案退出轮转后，旧粘性会话不能重新选中并激活它 | `primary-failover-key-pool.test.ts`、Primary 故障转移场景 |
| F06 | Responses→Anthropic 保留 JSON Schema 输出约束，不支持的格式明确报错 | `protocol-request-fidelity.test.ts` |
| F07 | 工具结果中的图片、文档和文本按顺序转换为 Anthropic 内容块 | 同上，含协议往返 |
| F08 | Chat/Anthropic 转换接受省略 type 的合法 Responses 消息，保留非法 role/content/type 的拒绝 | 同上，四种角色与非法输入 |
| F09 | 抓包写入/清理失败输出诊断；扫描失败作废估算；ENOENT 竞争不报故障 | `debug-capture.test.ts`、抓包相关场景 |
| F10 | 本地错误抓包记录实际客户端状态、头和正文；缺失客户端响应的失败记录不判透明等价 | `capture-local-errors.test.ts`、`capture-diff.test.ts`、UI 抓包 |
| F11 | 单项 drain 失败不跳过后续资源释放；多项失败聚合，保留原始原因 | `server-shutdown.test.ts` |
| F12 | IPv6 socket 地址、CONNECT authority 和 NO_PROXY 端口匹配各用正确格式 | `upstream-proxy-ipv6.test.ts`、已有代理测试 |
| F13 | 清空粘性时长输入框保持空值，保存时省略；显式 0 继续表示关闭 | `ui-sticky-input.test.tsx` 的真实 DOM 输入 |
| F14 | 新克隆可从无凭据 plist 模板生成本机配置；已有本机文件仍被忽略 | `plutil -lint scripts/compactgate.plist.example`、README |
| F15 | stats/recent 拒绝不存在的日期及非法时间，保持闰年、小数秒与合法时区偏移 | `server-log-analytics.scenarios.ts` |
| F16 | 探测中 HTTP 200 的失败/未完成 JSON 或 SSE 不因部分 compaction 或后续 DONE 被判支持 | `server-compact-capability-probe.scenarios.ts` |

F04 的 compact 入口只采用明确状态错误恢复，不新增 Primary 泛化失败证据或持久规则。最多四种不同正文，整个逻辑请求共享三次 502/503/504 额外重试；恢复结果不写入原始请求的 compact 去重缓存，检查点继承真实 fidelity。移除被拒的密文可能丢失其独占上下文，仍以 `degraded` 明示。

F06 的格式映射依据 [Anthropic 结构化输出合同](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)；F08 的可选 type 依据 [Responses EasyInputMessage 合同](https://developers.openai.com/api/reference/resources/responses/methods/create)。保留现有转换边界，不宣称所有供应商方言都等价。

## 验证与范围

各缺陷先保留失败复现，再执行针对性回归；复审额外补齐了 compact 草稿备份的旧池继承和无效加密块坐标两个边界。类型诊断发现的配套类型遗漏已修正。

关停补测验证了身份和 OAuth 同时持久化失败时仍关闭日志，返回包含两项原错误的聚合异常。转换 SSE 已经输出后断开、客户端正文副本缺失时，保留缺失事实并显示无法比较；本轮没有新增部分转换正文留存。

隔离目录 `/tmp/compactgate-full-fixes.U9Bti0/check` 中以 `VITEST_MAX_WORKERS=2 npm run check` 按原顺序完成差异检查、样式检查、严格类型检查、全量测试及生产构建：196 个测试文件通过，3117 项通过，1 项因隔离目录没有真实 welfare 抓包而按既有条件跳过。

默认并发的首次门禁有 4 项既有用例超过 5000ms，涉及大流、日志大正文和预设数量循环；3111 项通过、1 项跳过。保留 `full-check.log`，没有修改超时、断言或项目并发配置。两 worker 的针对性诊断同 3 个文件 68 项全过，原超时用例为 412–1070ms；随后完整门禁记录在 `full-check-workers2.log`。这支持测试资源争用判断，不宣称默认并发问题已修复。

编译产物的合成 HTTP 冒烟通过：健康接口、Studio HTML/哈希 JS 缓存、SPA 回退、Primary/local/Remote V1 三个恢复入口，以及 SQLite 统计 worker。三个入口各先收到状态错误，再恢复成功，合计 6 次出站；恢复头均为 recovered/degraded。临时地址 `http://127.0.0.1:62016`，合成配置/数据在 `/tmp/compactgate-full-fixes-smoke-w7kwH5`，验证结束已正常关闭。记录为 `/tmp/compactgate-full-fixes.U9Bti0/smoke.log`。

测试仅使用临时目录、合成凭据/上游和空闲端口；没有读取生产配置、调用真实供应商、安装 LaunchAgent 或替换现有服务。原 7865 服务 PID 76953 保持，根 dist 产物未覆盖。UI 通过 jsdom 真实输入/选择事件和静态资源 HTTP 验证，未做浏览器视觉验收。最小实现约束使本轮复用现有恢复协调器、内容转换器和事务结算，没有引入额外恢复层、缓存或依赖。
