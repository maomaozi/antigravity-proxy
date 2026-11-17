# Codex → Antigravity 最小改动设计

日期：2026-11-17。按用户最新要求收敛的设计方案。当前仅完成设计，未修改生产代码、配置或运行状态。

## 范围与顺序

本轮实现两组改动：系统提示词替换；账号固定、429 保护和 TOS 隔离。复用现有额度采集与 SQLite，不新增完整请求正文采集或大型诊断系统。修改在 main 分支进行。

主要入口是 Codex 使用的 `/v1/responses` → Antigravity 路由。提示词替换放在 Google systemInstruction 构建处，因此其他 OpenAI 兼容入口最终发送到 Antigravity 的系统文本也采用同样规则。独立 Codex provider 不经过此转换层。

## 1. 系统提示词替换

每轮在发送 Google 请求前，仅对最终合并的 `systemInstruction.parts[].text` 中已知身份模板进行替换：

1. 应用版本化的已知身份模板规则。优先匹配完整模板、完整身份句，长规则优先；保留句子后面的任务规则，避免重复拼接和残留 `.,` 等畸形连接。
2. 未命中的文本原样保留；不对剩余 codex 做词级、子串或普通自然语言兜底替换。

首批模板规则覆盖本机已见的 `You are Codex, a coding agent.`，以及 `You are Codex, an agent based on GPT-<version>.` 和 `a coding agent based on GPT-<version>` 变体，整体替换为 Antigravity 编程助手身份句。这里只将其作为已知身份模板处理，不宣称已经证实它们是本地触发词；版本位置使用受限匹配，不能跨行吞掉任意后续规则。匹配限定为身份声明位置，代码块、引用示例中的同句保留；其他客户端身份模板需有明确规则才处理，不用模糊匹配整个 prompt。

顶层 instructions、input 中 system/developer、namespace 公共说明会在现有 adapter 中合并，因此最终替换可覆盖完整历史里的系统文本。保留现有 namespace 去重和 tool_search 机制，要求转换幂等。

身份模板外的路径、环境变量、工具/namespace、HTTP header、代码示例及普通文本原样保留。HTTP 路由、会话标识、tool declaration 的真实名称、call_id、用户消息、assistant 历史、工具输出不改。仅记录模板规则 ID 与命中数，不记录 prompt 正文。

### 1.1 本机实际 system/developer 文本核查

后续核查已确认这不是假设风险。样本为本项目的本地会话 `rollout-2026-11-11T13-51-13-01a1c929-0e1c-7613-a968-8e7dcf5d71c8.jsonl`，客户端 0.167.0、provider 为 gemini、首个 turn_context 模型为 antigravity-gemini-4-argon。会话元数据中的基础指令是 `You are Codex, a coding agent.`；初始 developer 文本有 13,005 字符、34 处大小写不敏感的 codex，其中含下列实际引用。元数据还保留了另一模型的 base-instructions provenance，因此不能把它当作整个会话模型从未变化的证据。

下表保留此前无差别替换的离线核查结果，说明收窄范围的依据；现行身份模板规则保留这些引用。

| 实际引用 | 此前无差别替换会产生的文本 | 核查结果 |
| --- | --- | --- |
| `/home/maozi/.codex/skills/.system` | `/home/maozi/.antigravity/skills/.system` | 原目录存在；替换后的目录不存在。 |
| `/home/maozi/.codex/plugins/cache/openai-curated-remote` | `/home/maozi/.antigravity/plugins/cache/openai-curated-remote` | 原目录存在；替换后的目录不存在。 |
| `$CODEX_HOME/skills` | `$antigravity_HOME/skills` | 改变环境变量名，不再引用原变量。 |
| `mcp__codex_apps__github` | `mcp__antigravity_apps__github` | 改变工具命名空间引用，真实工具声明没有同步改名。 |
| `mcp__codex_tui` | `mcp__antigravity_tui` | 同样改变工具命名空间引用。 |

本机 Gemini/Antigravity 自定义模型 catalog 的基础指令目前也只有上述一句身份说明；复杂标识主要来自动态注入的技能说明和工具目录。另抽查 11-13、11-14、11-17 的本项目会话，其 developer 文本同样包含这些类别；这些会话使用 OpenAI provider，仅作跨版本文本佐证。

`src/api/openai/responses.ts` 的 adaptInputItems 会把 developer/system 的文本追加到 systemParts，最后合并为一条 system 消息；transform 再将其序列化为 Google systemInstruction。所以在当前设计的最终 system 文本上执行全量替换，确实会改到这些引用。这是本地会话文本与转换代码的核查，不是已保存的完整上游网络报文。

离线将该会话记录的 base_instructions 和初始 developer 消息送入现有 adaptResponsesRequest，得到 1 条合并后的 system 消息；检查确认技能路径、环境变量、GitHub namespace 和 TUI namespace 四类引用均保留在其中。该验证未发送网络请求。

按用户最新决定，现行方案仅替换已知身份模板，上表中的路径、环境变量、工具/namespace 和协议标识全部保留；身份模板外普通自然语言中的 Codex 也保留。

## 2. 账号固定与重试保护

### 2.1 首次发送前固定，外层重试复用

保留正常会话的账号亲和，同时新增小型、持久化的 routing guard。不能仅在成功后写绑定，也不能只保存在一次 HTTP 请求的 triedEmails 中。

- 第一次选中 A 后，在调用上游之前原子写入会话/模型的账号固定记录。该记录独立于用量统计，不把失败伪记为成功。
- 会话身份复用现有 thread/session metadata 等解析结果，在提示词改写之前确定，防止替换规则改变身份。
- 同一逻辑请求另用完整模型可见 payload 的稳定摘要识别；排除 requestId、时间戳、账号与凭据，包含模型、思考档位、system、消息、工具。没有稳定会话 ID 时，该摘要作为完全相同外层重试的回退键，按调用方隔离。
- guard 保存 account、保护原因、retryAt 和请求尝试预算。服务重启后继续生效；摘要不保存正文。
- scheduler 先检查 guard。保护中的 A 即使处于等待、刷新失败或暂不可用，也只等待或返回错误，不能调用 rescue 选择 B。相同请求并发通过原子 guard 检查，防止绕过保护。

### 2.2 明显还有额度却返回 429

复用 `getAccountModelQuotas` / `getAccountQuotaWindows`，按实际上游模型、thinking 档位和所属配额组判断。不能用账号其他模型的剩余额度代替。

“明显还有额度”按最新要求定义为：最近 1 分钟（60 秒）成功获取的有效数据中，当前模型所有必需的有效窗口/配额约束均剩余超过 5%。这里的 5% 是保护策略默认值，不是已验证的 Google 阈值。相关 5h / weekly 任一耗尽都不算明显充足；无法匹配窗口也不算有充足证据。quota 和 quotaWindows 各自检查更新时间，不用其中一项的新鲜时间为另一项旧数据背书。

当前额度结构没有采集时间，需给 quota 和 quotaWindows 分别补成功更新时间，和采集结果一起保存；旧数据不补造时间。不添加第二套额度统计。

现有全池定时刷新周期为 5 分钟。1 分钟要求针对判断时的数据新鲜度，不自动增加全池轮询频率：遇到 429 而相关数据超过 60 秒时，合并一次同账号、相关额度数据的按需刷新；刷新完成后重新判断，失败或仍不完整时继续停止轮换。外层重试复用 guard 和刷新中的任务，不能各自触发刷新。

当 A 返回 429：

| 状态 | 行为 |
| --- | --- |
| 明显还有额度 | 立即停止本次上游尝试，不换 B，不扣账号健康分、不把额度标为 0；写入会话/模型的 429 保护。 |
| 数据缺失、超过 60 秒或只有通用 RESOURCE_EXHAUSTED | 保守停止轮换，标记原因未明；数据缺失或过期时合并一次同账号额度刷新，不能让每次外层重试重复刷新。 |
| 上游明确 QUOTA_EXHAUSTED，但新鲜缓存显示充足 | 按额度证据冲突处理，先保护并复核，不能直接扫池。 |
| 上游明确额度耗尽，且同账号刷新或有效配额窗口也确认耗尽 | 解除本次的“疑似请求相关 429”状态，按真实配额处理；保留准确重置时间，只有这种明确账号不可用的情形才允许走正常候选账号选择。 |

对充足额度的 429，HTTP 返回 429，错误码如 `upstream_429_with_quota`，附 retry 信息；初始 retryAt 至少 60 秒，同时尊重更长的有效上游等待提示。`Retry-After` 仅帮助客户端退避，真正禁止换号依赖服务端 guard。

Codex 在等待期内再次提交时，直接返回同一保护结果，不重新选号。到 retryAt 后只允许 A 做一次有界尝试；再次 429 延续保护，成功解除 429 保护但保留正常账号亲和。时间到期本身不授权换 B。会话中后续同模型请求也不能因 A 的冷却而自动切号。

### 2.3 普通错误优先同账号

默认每个逻辑请求先在 A 最多尝试 3 次（首次 + 2 次退避重试），仅对网络错误、超时、明确临时 5xx 等可重试故障执行。401 只在 A 刷新 token 后重试一次。确定性 400/工具 schema 错误直接返回或在 A 做既有 schema 修复，不靠换号修复内容问题。

A 的普通故障重试耗尽后，才允许选择 B；每个逻辑请求最多接触 2 个账号，总尝试数严格受 `config.retry.maxAttempts` 限制，去掉账号数量放大预算的 Math.max。总预算低于 3 时，不能为了切号突破预算。

只有普通故障可走上述降级；额度充足或原因未明的 429、TOS 永远不能借普通错误分支换号。外层 HTTP 重试沿用逻辑请求的预算与当前账号，不从头再扫 A/B/C；预算耗尽在短期错误结果保留期间直接返回。已经输出流式内容或客户端取消后不重试。

## 3. TOS 持久隔离

收到明确 `TOS_VIOLATION` 时：

1. 将 A 的 Antigravity 服务状态持久化为 suspended，记录检测时间、原因和申诉入口。
2. 当前请求返回 403，停止轮换；为当前会话/模型保留终止状态，外层同会话重试仍返回封禁结果，不能选 B。
3. 禁止 10 分钟到期自动恢复，后台 activation、额度刷新和模型 discovery 都跳过该服务已隔离的账号。
4. 加载旧格式 suspension 或 poolSuspensions 中的 TOS 时迁移为持久隔离，不能自动清除。恢复通过明确的人工操作，并保留隔离直至受控验证成功。
5. 独立 Codex provider 和其他账号既有会话保持独立；不把单个账号 TOS 判为整个 Google 账号所有产品被封。

## 4. 拟修改文件与验收

| 文件 | 改动 |
| --- | --- |
| `src/utils/transform.ts`、新增提示词替换模块 | 仅替换已知身份模板，未命中文本保留；幂等。 |
| `src/api/completion-executor.ts`、`src/auth/manager.ts` | 发送前固定、同号重试、guard 优先、真实总预算、429/TOS 停止轮换。 |
| `src/session/store.ts`、`src/session/identity.ts` | guard 持久化、相同请求摘要与外层重试关联；复用稳定会话解析。 |
| `src/utils/errors.ts` | 区分明确额度耗尽、普通限流、原因未明 429、TOS。 |
| `src/api/quota.ts`、`src/auth/{types,storage}.ts` | 额度成功采集时间、TOS 状态持久化及旧状态迁移。 |
| `src/models.ts`、`src/api/window-activation.ts` 和 discovery 入口 | 所有后台路径尊重持久 TOS 隔离。 |

关键测试：已知身份模板精确替换、长规则优先与幂等；未知身份句和普通 Codex 文本保留；多轮 system/developer 覆盖；路径、环境变量、工具/namespace、代码和引用示例保持原样；额度充足 A 429 后代理内/HTTP 外层重试均不触及 B；过期/冲突配额不误轮换；普通错误先 A 再 B 且不超总预算；TOS 首次/重启/后台/外层重试均隔离；并发与流式输出后的行为。

实施时先跑针对性行为测试，再跑 `bun test tests/unit` 与 `bun run lint:check`。本轮不将批量实号探测作为验收条件。
