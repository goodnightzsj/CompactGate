# 全局兼容修复与公开实现对照

核对日期：2026-11-05。范围是本项目服务端的全局及 host 上游兼容修复，包括请求改写、协议桥接、模型/计数端点、状态恢复、流完整性和重试路由；不包含无关 Studio UI 或管理功能重构。

## 结论与实施

公开项目有相同故障，但不存在可直接复制、保证任意供应商都正常的统一删除器。本次把有依据的改进落在现有公共所有者处，无新增依赖、配置开关、会话副本或负向缓存。

1. `provider-state-portability.ts` 统一统计顶层 `encrypted_content` 与 agent message 内的加密块。普通消息、function/custom tool 调用及结果、web search 的明文载荷存在时，只移除协议层的密文副本，不遍历工具参数或用户正文。被拒 reasoning 保留可读摘要，移除无可读内容的空壳及失效 ID。
2. compaction 归因复用相同载体范围：存在其他密文时，缩略错误不能被误判成只剩 compaction。明确定位继续优先，完整密文也能定位 agent 内部的具体块。成功修复规则的指纹同步包含新增载体，变更密文后重新分类。
3. `provider-state-stream.ts` 复用现有解压/SSE 观察器，暂存最多 64 KiB 原始前缀、最长 1 秒，并限制单个解码事件为 64 KiB。只在完整收到明确的 `response.failed`/`error` 状态错误、尚无输出时，交回原恢复协调器；真实 HTTP 状态仍记为 200。
4. `primary-failover-result.ts` 接受 `retry-after-ms`，优先于 `Retry-After`；后者兼容小数秒和 HTTP date。无效毫秒头回到标准头。保留原单次等待、总截止时间和账号冷却上限，不增加重试次数。
5. `protocol-stream.ts` 不再在 Anthropic 显式错误后追加成功终态；空流、仅心跳、未闭合工具块或缺少结束原因的工具回合，以 SSE 错误结束。已有文本截流保留机制继续使用，诊断仍以真实上游流为准。

## 恢复边界

- 未知状态首发原样；`state_portability: off` 不启用错误恢复。协议错误、鉴权/配额错误不能因文案中出现 encrypted 就触发清理。
- HTTP 400 明确错误和上述早期 HTTP 200 SSE 共用一个分类器/协调器，固定同一目标与凭据，最多四个不同请求正文，并复用取消、总超时、截断及去重检查。没有安全的新正文时交付真实错误。
- 允许缓冲的前导事件只有无输出的 `response.created`/`response.in_progress` 及心跳。任何输出项、工具进度、未知/矛盾/损坏事件，或大小/时间超限，立即转为透传；之后不重放。已经交付的 SSE 错误不能撤回。错误后上游不结束 HTTP 流时，1 秒预算到期也会透传，不无限等待恢复。
- 未恢复的 SSE 保留原始状态、头部及正文；解压失败不能被当成可重试的状态错误。初始化失败、取消、终态提前断连都会释放暂存流。
- compaction 仍先尝试去 ID，再考虑已可用摘要/完整历史。用户先前授权的有损丢弃只在本轮明确拒绝、`store=false`、无存储引用、目标确定且还有其他输入时使用；不会因为缓存命中就在首发删除压缩历史。详情见[统一恢复说明](2026-11-05-provider-state-recovery.md)。
- 不透明且无明文的未知载体保留；没有工具配对证据时不伪造调用，不把工具输出冒充用户消息。无法在本地解密，也不能保证中转站后面的账号不轮换。

## 公开实现核对矩阵

“保留”表示已有实现与适用边界足够，不为融合而新增第二套逻辑；issue 只能证明存在报告，不能证明修复已经合并或适用于本项目。

| 本项目修复类别 / 所有者 | 公开依据与做法 | 融合决策 |
| --- | --- | --- |
| 全局密文恢复、reasoning 空项 / portability | [Magpie 修复](https://github.com/yetone/magpie/commit/b59e4b747f70ea5ff77db84f08aa377152e532ac) 分阶段去 seals；[LiteLLM 事故复盘](https://docs.litellm.ai/blog/responses-api-encrypted-content-incident) 按原部署路由、不可用时去不兼容推理密文；[sub2api 源码](https://github.com/Wei-Shaw/sub2api/tree/8e92c892b47f3f934f18ce63da4c4dcb75f0b6bd) 对明确加密失败做单次修复 | 已融合完整载体识别及空 reasoning 清理。保留有用明文，不复制 Magpie 的新缓存或无差别整项删除 |
| compaction、失效 ID、continuation / portability、checkpoints | Magpie 将 compaction 作为另一步；[OpenAI compaction 合同](https://developers.openai.com/api/docs/guides/compaction) 要求保留返回的完整窗口 | 已消除错误归因；保留现有 ID→摘要/检查点→获准有损路径。不声称有损路径等同于官方无损压缩 |
| GPT/Fernet 外形检查 / CPA cleanup | [CLIProxyAPI 固定版本](https://github.com/router-for-me/CLIProxyAPI/tree/585f97deac9aa57c700301221fb1a7085e1827cc) 的 signature/compatibility 实现检查密文包形态和 stateless ID | 保留；外形合法不代表目标能解密，不扩展成全局预删所有密文 |
| agent message、普通 message、web_search 密文 / portability | Magpie 对非 reasoning/compaction item 的顶层 seal 处理比只枚举 reasoning 更完整；[sub2api #8301](https://github.com/Wei-Shaw/sub2api/issues/8301) 报告嵌套 agent 漏处理 | 已融合顶层载体、嵌套定位和缓存指纹；仅有密文而无可重放载荷的项不猜测 |
| HTTP 200 SSE 错误 / upstream-client | [sub2api #7708](https://github.com/Wei-Shaw/sub2api/issues/7708) 报告 SSE 错误漏掉；[CLIProxyAPI bootstrap 配置](https://github.com/router-for-me/CLIProxyAPI/blob/585f97deac9aa57c700301221fb1a7085e1827cc/config.example.yaml#L394) 在首输出前暂存并有可选时间预算 | 已融合有界前缀，采用主动 1 秒计时和 64 KiB 上限，不复制默认无限时间或跨凭据重放 |
| Responses-Lite / muyuan header quirk | [Headroom #1820](https://github.com/headroomlabs-ai/headroom/pull/1820) 已合并：WebSocket flat/enveloped payload 还要清理镜像字段；[AxonHub #2020](https://github.com/looplj/axonhub/pull/2020) 已合并：支持 Lite 时反而需要 all_turns/parallel_tool_calls 合同 | 保留 muyuan 的已验证 header 规则。当前无 WebSocket 上游，不能据此全局删除 HTTP 正文字段或关闭所有 Lite |
| 1M beta / anyrouter | [CLIProxyAPI #2898](https://github.com/router-for-me/CLIProxyAPI/pull/2898) 已合并，移除其 Claude 路径中过时的强制 beta | 保留 anyrouter 已复现的“必须带 beta”规则；其他产品的端点行为不能推翻该 host 证据 |
| 首发普通 item ID / agentrouter | CLIProxyAPI stateless 兼容去 reasoning ID；Magpie 优先原账号 | 保留 agentrouter 明确 `store=false`、无远端引用的普通 item ID 处理；资源冲突后的 compaction 修复已经全局化。不能全局删除承担工具关联的 ID |
| 本地 count_tokens / agentrouter、anyrouter | [sub2api #2729](https://github.com/Wei-Shaw/sub2api/pull/2729) 是未合并的本地估算提案 | 保留现有只对已知不支持端点的 host 估算，覆盖 system/messages/tools；不将字符估算宣称为计费精确值，不替换支持原生计数的上游 |
| tool_reference / opencode.9962510.xyz | [Claude Code #31936](https://github.com/anthropics/claude-code/issues/31936) 报告对所有自定义端点禁用会破坏 deferred tools，增加上下文 | 保留已验证 host 的工具名称替换和 tool_result 结构；不能推广到所有 host，也不推断该 issue 已提供通用代理实现 |
| 图片输入切换 / token-plan-sgp.xiaomimimo.com | [xiaomi-mimo-proxy](https://github.com/windycn/xiaomi-mimo-proxy/tree/99842258acdd8583932ae5dfde002f97a0b91261) 说明不同 MiMo 型号的多模态差异，保留用户图片；另含 reasoning 缓存方案 | 保留本项目专属端点的 mimo-v2.5 图片模型选择。无需移入其历史 reasoning 缓存或静默删除图片 |
| thinking/effort 映射 / claude-models、protocol-conversion | [Anthropic thinking 文档](https://platform.claude.com/docs/en/build-with-claude/extended-thinking)；[CC Switch #1128](https://github.com/farion1231/cc-switch/issues/1128) 与 [#1131 提案](https://github.com/farion1231/cc-switch/pull/1131) 针对百炼 adaptive 不兼容，讨论存在反复；[OmniRoute #13696](https://github.com/diegosouzapw/OmniRoute/issues/13696) 是 agentrouter GLM 的提案 | 保留按已核实端点/具体模型 ID 的能力表和显式参数验证；不把未知模型一律改预算或关闭 thinking，不依据未验证提案新增 host 行为 |
| Responses/Messages/Chat 工具流转换 / protocol-stream | [LiteLLM #17652](https://github.com/BerriAI/litellm/pull/17652) 已合并，message item done 不能提前结束包含后续工具调用的响应 | 本项目按 response 终态结束、按 ID/index 合并工具事件已有对应逻辑；保留现有实现与回归，不照搬其在单个 function done 结束的不同合同 |
| 缺失终态、部分工具参数 / protocol-stream | [CLIProxyAPI #6707](https://github.com/router-for-me/CLIProxyAPI/issues/6707) 报告提前 EOF 合成成功会隐藏工具截断 | 已在本项目复现并修复原生 Anthropic 的错误/空流/未完成工具回合。外部 issue 是问题证据，具体守卫由本项目测试确认 |
| SSE 多行、分块 UTF-8、压缩 / observer、protocol-stream | [CLIProxyAPI SSE 修复](https://github.com/router-for-me/CLIProxyAPI/commit/80eb03709a569a7620b6bba4f1e4f30f8170d3bd) 正确编码多行 data 并重组帧 | 复用已有解析/解压器；新增门控在 gzip/br/deflate/zstd、逐字节 UTF-8、多行 data 下验证。不引入猜测性 JSON 拼接 |
| completed.output 与 done items / checkpoints、OAuth bridge | [CLIProxyAPI bb8408ce](https://github.com/router-for-me/CLIProxyAPI/commit/bb8408cef591cd292ecb41ff4ff805d11a489315) 从 output_item.done 回填缺失/空 output | 本项目已有桥接合并和严格检查点校验。保留连续索引、无冲突、已完成的要求；不把矛盾空 output、缺项或 added 片段作为完整历史 |
| reasoning 与缓存 usage / protocol-conversion、usage-utils | [OpenAI SSE 事件合同](https://developers.openai.com/api/reference/resources/responses/streaming-events)；LiteLLM Responses 转换实现 | 保留已验证的 reasoning_tokens、cached tokens 合同、非负整数与完整终态用量；不把推理细分重复计入总量，不用新增估计覆盖缺失值 |
| 429/5xx 等待 / primary-failover-result | [OpenAI Node SDK](https://github.com/openai/openai-node/blob/738695092f2d8e9e092de7bd19f0994e0ba68e25/src/client.ts#L2176) 优先 retry-after-ms，再读秒/日期并限制等待 | 已融合头优先级与小数秒；继续使用本项目 8 秒单次重试等待、10 分钟冷却上限和总请求截止时间 |
| 账号亲和、冷却、状态域 / primary-failover、binding | LiteLLM 的部署 ID 包装让后续回到原模型部署；[New API #8063](https://github.com/QuantumNous/new-api/issues/8063) 报告亲和重试重复选中失败通道；CLIProxyAPI 配置区分账号亲和与重试轮次 | 保留既有 state domain、key/profile 隔离与失败分类。不新增 wire wrapper、跨服务状态缓存或第二套调度；同一 URL/key 不等于中转内部同一资源 |
| 端点别名、/v1 边界、模型发现、HTML 200 / routing、upstream-url/models、upstream-client | [LiteLLM #13693](https://github.com/BerriAI/litellm/issues/13693) 是 URL 拼接问题报告且标为 not planned；SDK 将协议端点与 base URL 分开 | 保留现有按协议拼接、模型目录受限候选及 HTML 明确失败。未找到足以替换当前规则的通用实现，不猜路径重放生成 POST |
| CONNECT、流取消、整体截止时间与缓冲预算 / upstream-proxy-agent/client | CLIProxyAPI 配置明确区分握手超时、流 bootstrap 与 keepalive；OpenAI SDK 的超时/重试边界 | 保留本项目 agent 所有权、取消、终态 drain 和响应预算。新增门控接入同一生命周期，不另建连接池或后台保活任务 |

本轮公开源码固定点还包括：Magpie `c2b8814e751cc12e52545febcd4417ed13494a7d`、LiteLLM `5c60824024a70f89053f1faed9c46c0e0b5e144d`、CC Switch `ca58c0313360eae7c851fbd7553c1614c7af03e7`。CC Switch 的 `ccswitch-openai-reasoning-v1:` 包装适用于其跨协议桥接；它不提供跨账号解密，因此没有移入本项目。仅在公开源码中核对机制并按本项目合同独立实现，没有复制整套代理、增加第三方代码依赖。

## 验证与运行边界

新增测试先暴露故障：最初载体/SSE 18 项中 12 项失败；重试头/Anthropic 补充组 22 项中 9 项失败；新增载体缓存指纹和 agent 内部定位 6 项失败。对应修复后均通过。

隔离副本 `/tmp/compactgate-global-compatibility.UGRyTW` 最终完整 `npm run check` 已通过：159 个测试文件，2467 项通过、1 项跳过；diff、style、严格类型检查和前后端构建通过。首轮门禁通过后，复查补充了“只有 message_start 的空响应”失败回归并修正，因此再次执行完整门禁。跳过项依赖本地真实抓包，本轮未读取或复制。使用与当前 lockfile 一致的隔离依赖，无修改根目录依赖或 `dist/`。

直接导入隔离构建产物的 HTTP 冒烟通过：用户提供的 `code:null`、`gAAA...1pU=` 原错误形态经四次不同正文恢复；验证 web_search 密文清理、compaction 去 ID 后有损移除、`degraded` 响应头、留存为 0、Anthropic 空响应明确报错及静态页面 200。临时 URL 为 `http://127.0.0.1:64667`，上游 fixture 为 `http://127.0.0.1:64666/v1`，均已关闭；独立合成数据位于 `/tmp/compactgate-synthetic-smoke-FuboVw`。运行环境通过 `env -i` 清空继承变量，版本探测使用本地 stub。

当前工作区全部 source/test 与已验证副本逐字节一致。实现验收时服务为 PID 87759、`127.0.0.1:7865`，根 `dist/server/main.js` SHA256 为 `20a0b910c71927862475d5cadfe03e1083d97a2aa1e9f6c235131f0618b785c4`。后续文档与提交阶段观察到 PID 已变为 59623，根产物指纹一致；本轮未操作该服务。

用户已授权同步文档并提交推送。README 与本目录记录可版本化的行为、研究和验证边界；`llmdoc/` 已同步相应事实，按既有 Git 忽略规则仅本地维护。

新增回归包括有界 SSE 的大小/时间上限、四种压缩、解码损坏、多行/UTF-8 分块、输出/工具/未知事件后不可重放、完整四步恢复、取消、终态断连和原错误保留。运行中服务未部署；本地合成成功不代表 agentrouter、anyrouter 或其他真实中转已接纳。

回退使用 `state_portability: off` 停止自动状态恢复；它不关闭正常代理与现有 host 适配。原 `state_recovery_retention_hours: 0` 保持关闭正文恢复留存。已丢弃 compaction 中独占的历史不能从新输出恢复。
