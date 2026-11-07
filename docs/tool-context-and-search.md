# Namespace 去重与 Codex tool_search

验证日期：2026-11-08。代码在 `main` 分支修改。生产代理已于当天
01:14:28（Asia/Singapore）重启；Codex 客户端配置未修改。

## 超限请求与重复来源

00:46:11 的 Codex Desktop 请求通过 `/v1/responses` 使用
`antigravity-gpt-oss-120b`，实际路由到 `gpt-oss-120b-medium`。
Google 在 00:46:14 返回 HTTP 400：输入 167,238 tokens，上限 131,072。
代理诊断记录为 2 条 contents、342 个工具、800,119 字节。
没有保存原请求正文，无法恢复它的工具、系统提示与消息各自的 token 占比。

此前 Responses 转换器将 namespace 的公共描述复制进每个子工具描述。
若一个 namespace 有 N 个子工具，公共描述会重复 N 次。这是代理的
OpenAI → Google 转换策略产生的冗余。

现在每个 namespace 的公共描述只在 `systemInstruction` 中保留一次，明确限定到
带匹配 `[Responses namespace: NAME]` 标记的工具。子工具保留自己的描述、参数
schema、custom format 和可逆名称编码。同名工具仍可通过 namespace 区分。
空 namespace 和空公共说明不生成额外系统提示。

## 官方 Antigravity 客户端核对

使用本机已有的官方 Hub 2.29.0 Linux ARM 安装包及未修改的 language server：

- `dist/languageServer.js` 启动原生进程，并将 `cloud_code_endpoint` 设置为
  `https://daily-cloudcode-pa.googleapis.com`；上游请求构造位于原生程序中。
- 原生 `codeassistclient.buildFunctionDeclarations` 位于 `0x6a8b9a0`。
  此函数遍历工具、调用 `paramsToSchema`，并将工具自身的字符串字段与参数
  schema 填入 function declaration；核对的函数中没有公共 namespace 说明拼接逻辑。
- `codeassistclient.BuildGenerateContentRequest` 位于 `0x6a8bee0`，分别处理消息、
  工具声明和 tool config，并调用上述构造函数。它不是 OpenAI Responses
  namespace 的转换器，不能把代理过去的重复策略归因于官方客户端要求。

反汇编与符号摘要保存在本地忽略目录
`data/namespace-dedup-2026-11-08/{buildFunctionDeclarations.asm,BuildGenerateContentRequest.asm,native-functions.json}`。
这些是静态检查结果；本次没有抓取官方 GUI 的完整聊天会话。
去重后的字段组织是否被上游接受，由下面的实际生成请求验证。

## Gemini 3.8 Flash 去重实测

构造 3 个 namespace、共 342 个工具的固定样本。每组公共说明约 2,250 字符，
包含各组专属 region、audit tag，以及 custom 工具的输入格式。
这是构造样本，不是原始失败请求的回放。

相同账号、相同提示和工具，分别使用旧转换结果和去重后的转换结果请求真实
`gemini-3.8-flash` 上游。输入 tokens 读取 Google 的 `promptTokenCount`，不是本地估算。

| 场景 | 旧请求字节 | 去重后字节 | 旧输入 tokens | 去重后输入 tokens |
| --- | ---: | ---: | ---: | ---: |
| 普通 function | 894,117 | 130,809 | 188,095 | 44,297 |
| custom 工具 | 894,112 | 130,804 | 188,093 | 44,295 |

普通 function 场景体积减少约 85.4%，输入 tokens 减少约 76.5%。
两种转换、两类工具均返回 HTTP 200；模型选中了正确 namespace、使用了仅在
公共说明中给出的参数/输入格式。回传模拟工具结果后，模型均准确返回了指定结果。
这些测试支持本次改动的可行性，不能据此承诺所有提示或模型的行为完全相同。

## supports_search_tool 的归属

`supports_search_tool` 是 Codex 的模型元数据。官方
[ModelInfo 定义](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/openai_models.rs)
对该布尔字段使用缺省反序列化，省略时为 false。本机检查的 Gemini 3.8 Flash
自定义模型条目没有该字段。代理 `/v1/models` 的 OpenAI 模型列表并不是 Codex
的完整 ModelInfo catalog。

因此需要同时具备两项条件：代理能转换客户端搜索协议，Codex 当前使用的模型
catalog 条目也声明支持搜索。仅修改 capability 标志会让旧代理遇到不认识的
`tool_search` 工具类型并返回 400。

在 `model_catalog_json` 指向的 JSON 文件中，向现有模型条目合并以下字段：

```json
"supports_search_tool": true
```

保留条目的其他字段，重新加载 Codex 客户端并使用新会话验证。
这个字段不是顶层 `config.toml` 或代理 `config.json` 选项。

## 客户端搜索桥接

Codex 的官方
[tool_search 定义](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/tool_search_spec.rs)
使用 `execution: "client"`，查询 schema 由客户端提供。
实现遵循 OpenAI 的
[client-executed tool search 协议](https://developers.openai.com/api/docs/guides/tools-tool-search)：

1. 将客户端搜索工具转换成一个普通 Google function，保留其 description 和 parameters。
2. 模型调用此 function 时，向 Codex 返回 `tool_search_call`，包含对象形式的
   arguments、`execution: "client"` 与可关联的 call ID。
3. Codex 执行搜索并通过 `tool_search_output.tools` 返回匹配的工具定义。
4. 从完整输入历史恢复已加载工具，将它们加入 Google 的 function declarations；
   其余 `defer_loading: true` 工具继续保持未加载。
5. 搜索结果消息只放已加载工具的名称与 namespace，schema 只放在声明中。
   普通工具调用与结果回传沿用已有协议及 Gemini thought signature 处理。

也支持 developer `additional_tools` 输入项，以及加载后才出现的 function/custom
工具。重复声明按工具身份合并。没有搜索工具的旧请求继续按 eager loading 处理。
所有状态从请求历史恢复，不另外持久化工具搜索会话。

## 工具搜索实测

将上述 342 个工具全部声明为 deferred，保留一个客户端搜索工具。
客户端搜索结果使用确定的模拟返回，只加载 APAC namespace 的 `lookup_item`；
不执行真实库存或第三方工具。模型生成步骤均访问真实 Gemini 3.8 Flash。

| 阶段 | JSON 输入 tokens | 流式输入 tokens | 上游工具声明数 |
| --- | ---: | ---: | ---: |
| 发现所需工具 | 202 | 202 | 1 |
| 加载并调用 lookup_item | 934 | 939 | 2 |
| 读取工具结果并回复 | 1,197 | 1,208 | 2 |

两条三轮链路均返回 HTTP 200：搜索参数为对象，加载后选中了
`inventory_apac.lookup_item`，参数包括 `region=ap-southeast-1`、
`audit_tag=APAC-741`，最终回复为 `VERIFIED-DEFERRED-RESULT`。
流式链路使用真实 `streamGenerateContent?alt=sse`，经过项目的 Google 流解析器
与 Responses SSE 编码器，并验证了最终 typed search item。

范围和限制：

- 这里提供的是 Google function calling 到 Codex 客户端搜索的协议桥接，
  不是 Gemini 原生 Responses tool_search，也不实现 hosted/server 搜索。
- Google 使用当前请求的完整 function declarations，新增工具可能改变缓存前缀；
  不承诺 OpenAI 原生工具搜索的尾部注入和缓存保持行为。
- 本次未自动运行一个新的 Codex agent，也未验证 Windows Desktop 的完整 UI 会话；
  客户端配置启用后仍需观察实际请求是否带有 `tool_search` 和 deferred 定义。

可重复的协议回归测试：

```bash
bun test tests/unit/responses-tool-search.test.ts
bun run lint:check
```

本次 live probe、原始上游响应和汇总分别保存在本地忽略目录的
`probe.ts`、`report.json`、`tool-search-probe.ts`、`tool-search-report.json`。
单元回归结果为 320 pass、0 fail，TypeScript 检查通过。

重启后另通过生产代理 HTTP 接口验证：`/v1/models` 返回 200；向
`/v1/responses` 发送 Gemini 3.8 Flash 客户端搜索请求也返回 200，包含一个
`execution: "client"` 的 `tool_search_call`，上游报告 100 输入 tokens。
