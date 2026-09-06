# Antigravity Proxy 代码审查前提假设与修复方案

本文档记录 `antigravity-proxy` 项目的代码审查结论、核心前提假设以及经过 3 位子 Agent 深度交叉讨论后达成完全共识的详细修复方案。

---

## 一、核心前提假设与设计原则

1. **局域网少数内部人使用**：
   - 本项目定位于团队内部局域网单机网关，供少数开发者通过 IDE、CLI（如 Claude Code, OpenCode）日常调用，并非面向公网的海量并发多租户服务。
   - 坚决奉行 **KISS 原则（Keep It Simple, Stupid）**：杜绝引入外部重型中间件（无 Redis、无消息队列、无分布式锁、无复杂微服务抽象），坚持单机 Bun 原生能力与内建 SQLite。
2. **完全排除安全与鉴权问题**：
   - 明确忽略任何关于缺少用户身份验证、未授权访问、API Key 暴露、CORS/CSRF 等安全防护缺失的问题，不为此类内容增加冗余防御代码。
3. **保持单文件入口与零新增生产依赖**：
   - `src/server.ts` 保持单文件路由入口，不将其碎片化拆分为多个子路由文件，仅通过提炼局部辅助函数和下沉内联业务逻辑进行代码瘦身。
   - 生产依赖维持 `"bun": "^1.0.0"`，不引入任何第三方生产依赖。
4. **确保协议高保真度与向后兼容性**：
   - 保护已通过 100% 单元测试的 Responses API 状态机与核心转换逻辑，避免破坏性重构，以防御性拦截和局部修补为主。
   - 保持现有数据存储和配置的平滑向前兼容。

---

## 二、详细修复方案（治理路线）

### 1. 协议契约与核心业务逻辑修复

#### 修复 1.1：Chat Completion 流式传输补齐 `data: [DONE]` 终止标识 (P0)
- **目标文件**：`src/utils/transform.ts`、`src/api/openai/chat.ts`
- **方案**：
  1. 在 `src/utils/transform.ts` 的 `createCompletionStreamTransformer` 的 `flush` 回调中，在清空末尾残余 buffer 后主动调用 `controller.enqueue({ type: "done" })`；
  2. 在 `src/api/openai/chat.ts` 的 `createChatCompletionStreamEncoder` 中实现 `flush(controller)`，向流末尾压入 `encoder.encode("data: [DONE]\n\n")`。
- **效果**：解决官方 OpenAI SDK、LangChain、LlamaIndex 在流式接收完毕后因缺失 sentinel 导致挂死超时的问题。

#### 修复 1.2：非流式响应 `tool_calls` 结构规范化与空内容合规 (P1)
- **目标文件**：`src/api/openai/chat.ts`
- **方案**：
  1. 在 `encodeChatCompletionResult` 中映射 `toolCalls` 时，剔除仅属于流式块的 `index` 字段；
  2. 当模型发起工具调用且无文本正文时，规范要求 `message.content` 应设为 `null` 而非空字符串 `""`。
- **效果**：防止严格模式反序列化客户端（Pydantic `extra="forbid"`、`instructor` 等）崩溃。

#### 修复 1.3：Token 统计在 Chat 响应中计入思考 Token (P1)
- **目标文件**：`src/api/openai/chat.ts`
- **方案**：
  在 `encodeUsage` 中计算 `completion_tokens` 时，将可见生成 token 与思考 token（`reasoningTokens`）累加：
  `const completionTokens = usage.outputTokens + (usage.reasoningTokensReported ? usage.reasoningTokens : 0);`，保证 `prompt_tokens + completion_tokens === total_tokens`。
- **效果**：恢复 OpenAI API 基本数学等式契约，确保测速与对账准确。

#### 修复 1.4：解除官方推荐模型前缀与 `isSandboxOnlyModel` 的死锁绑定 (P0)
- **目标文件**：`src/api/completion-executor.ts`
- **方案**：
  将 `isSandboxOnlyModel` 的判断改为基于剥离 `antigravity-` 前缀后的模型名称或特定仅 Sandbox 模型（如 GPT 模型），使 `antigravity-gemini-3.8-flash` 等官方模型在遭遇 Sandbox 限频时能正常故障转移至 CLI 池。
- **效果**：恢复多账号、多端点池的容灾初衷。

#### 修复 1.5：放宽打断会话时的工具调用前置拦截 (P2)
- **目标文件**：`src/utils/transform.ts`
- **方案**：
  在 `validateCompletionRequestForGoogle` 中，如果检测到非 `tool` 消息但存在 `pendingToolCalls`，不再直接返回 400 拒绝，而是清空 `pendingToolCalls` 容许打断，并在转换器中对未完成的 tool call 做安全平滑处理。
- **效果**：用户在 Agent 执行中打断取消后，历史会话仍能继续交互，不报废上下文。

---

### 2. 运行时并发、连接生命周期与稳定性修复

#### 修复 2.1：全链路打通客户端中断信号 `AbortSignal` (P0)
- **目标文件**：`src/server.ts`、`src/api/completion-executor.ts`、`src/codex/proxy.ts`
- **方案**：
  1. `src/server.ts` 入口将 `req.signal` 透传给 `executeCompletion` 及 `CodexProxyService`；
  2. `src/api/completion-executor.ts`：组合客户端中断信号与超时信号 `AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])`；并在重试循环及流消费过程中检查 `signal?.aborted` 及时中断；
  3. `src/codex/proxy.ts`：将外部 `signal` 绑定到上游 `callCodex` 请求。
- **效果**：客户端断开后立即释放上游 fetch 连接，终止无效重试，杜绝幽灵请求消耗有限配额。

#### 修复 2.2：Token 刷新 Single-Flight 并发去重 (P0)
- **目标文件**：`src/auth/manager.ts`、`src/codex/account-manager.ts`
- **方案**：
  在两个模块内维护 `refreshPromises = new Map<string, Promise<boolean>>()`。当多个并发请求命中需要刷新的同一账号时，共享正在进行的刷新 Promise。
- **效果**：彻底消除并发刷新时因 OpenAI Refresh Token 轮转机制导致的 `400 invalid_grant` 废号 Bug。

#### 修复 2.3：修复 `auth/manager.ts` 本地私有配置遮蔽 Bug (P0)
- **目标文件**：`src/auth/manager.ts`
- **方案**：
  删除 `src/auth/manager.ts:34-45` 内部硬编码的 `function getProxyConfig()`，统一调用从 `src/config/manager.ts` 导入的 `getConfigFromManager()`。
- **效果**：用户在 `config.json` 或前端后台调整的所有冷却和调度参数恢复真实生效。

#### 修复 2.4：为配额与 OAuth 外部调用添加全局超时 (P0)
- **目标文件**：`src/api/quota.ts`
- **方案**：
  在 `fetchQuota` 中为网络请求配置 `signal: AbortSignal.timeout(15_000)`。
- **效果**：防止 Google 接口丢包挂死导致 `quotaRefreshInFlight` 互斥锁无法释放、全服定时任务停摆。

#### 修复 2.5：账号状态文件采用 `.tmp` + `rename` 原子写入 (P1)
- **目标文件**：`src/auth/storage.ts`
- **方案**：
  引入带 PID 和时间戳的临时文件写入，再通过文件重命名原子覆盖原文件；高频调用补全 `await`。
- **效果**：消除并发覆盖写导致的 JSON 残缺损坏与凭据全丢隐患。

#### 修复 2.6：账号调度打分系统收敛为极简二元断路器 (P1)
- **目标文件**：`src/auth/manager.ts`
- **方案**：
  1. 彻底删除 `calculatePriority`、`modelScores`、浮点加权参数与每次成功加 2 分写盘逻辑；
  2. 收敛为二元断路器：保留 `consecutiveFailures` 与 `cooldownMap`，连续 3 次失败或遇到致命错误打入冷却；成功一次立即清零；
  3. 调度顺位：Session 强亲和 -> 候选池 Rendezvous Hashing / LRU。
- **效果**：大幅降低系统复杂性，消除无意义的高频磁盘 I/O。

#### 修复 2.7：会话绑定账号微等待与 429 真实重试秒数透传 (P2)
- **目标文件**：`src/auth/manager.ts`、`src/api/completion-executor.ts`
- **方案**：
  1. 废止 60 秒长睡眠；仅对会话绑定账号且剩余冷却 $\le 3$ 秒时，结合 `AbortSignal` 进行可中断的微等待保 Prompt Cache；超过 3 秒立即切号；
  2. 在 `completion-executor.ts` 中将从 429 响应解析出的 `resetSeconds` 正确透传给 `markCooldown`。

#### 修复 2.8：SQLite 复合索引优化 (P2)
- **目标文件**：`src/session/store.ts`
- **方案**：
  增加复合索引：`CREATE INDEX IF NOT EXISTS idx_request_token_usage_session_model ON request_token_usage(session_key, model)`。
- **效果**：消除会话列表查询时的全表扫描，避免读写锁争用。

---

### 3. 代码简洁性、死代码清理与模块规整

#### 修复 3.1：彻底清理 `src/scripts/` 中 11 个调试废弃脚本 (P1)
- **方案**：
  1. 将唯一的正式运维脚本 `src/scripts/reset-accounts.ts` 移动至项目根目录 `scripts/reset-accounts.ts`；
  2. 更新 `package.json` 中的命令为 `"reset-accounts": "bun run scripts/reset-accounts.ts"`；
  3. 彻底删除 `src/scripts/` 下其余 11 个临时排查脚本及 `src/scripts/` 目录本身。
- **效果**：立减 700+ 行死代码，清爽源码目录。

#### 修复 3.2：清理死代码与废弃导出 (P1)
- **方案**：
  1. 删除 `src/auth/storage.ts` 中未使用的 `loadAccounts`；
  2. 删除 `src/api/quota.ts` 中只写无读的 `supportedModelsCache`；
  3. 移除 `src/config/manager.ts` 中历史废弃字段的手工 `delete`。

#### 修复 3.3：`src/server.ts` 单文件精简与统一响应助手 (P1)
- **方案**：
  1. 在 `server.ts` 顶部提炼统一 `json(data, status, extraHeaders)` 与 `jsonError(message, status, code)` 助手；
  2. 统一步调使用 `cleanPath` 进行所有接口与页面路由匹配；
  3. 对 `req.json()` 进行安全包裹，解析失败直接返回 400；
  4. 清理 31 处手工拼接的 CORS 头。
- **效果**：削减 250+ 行冗余样板代码，单文件结构扁平清晰，阅读一目了然。

#### 修复 3.4：提取公共 `rendezvousScore` 工具函数 (P1)
- **方案**：
  将重复拷贝在 `src/auth/manager.ts` 与 `src/codex/account-manager.ts` 的 `rendezvousScore` 提取为 `src/utils/hash.ts`。

---

## 三、实施顺序与验证要求

1. **第一阶段**：基础修复与死代码清理（脚本迁移、哈希提取、死代码移除、配置遮蔽修复）；
2. **第二阶段**：稳定性与并发控制（Single-Flight、AbortSignal 串联、原子文件写入、微等待、超时保护）；
3. **第三阶段**：协议与业务逻辑（`[DONE]` 补全、Token 统计修正、tool_calls 规范化、前缀解绑、前置校验放宽）；
4. **第四阶段**：`server.ts` 与 SQLite 索引精简落地；
5. **第五阶段**：运行全量单元测试与类型检查，确保 100% 通过；
6. **第六阶段**：启动 3 个子 Agent 进行多视角独立 Review 与验收辩论，直至全员签收。
