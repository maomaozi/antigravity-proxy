# Claude 工具 schema 适配

## 原因与范围

2026-11-08 01:20–01:22（Asia/Singapore），生产日志中出现 9 次相同 400：
`tools.9.custom.input_schema: input_schema does not support oneOf, allOf, or anyOf at the top level`。
涉及 Claude Sonnet/Opus 5.5、Sonnet/Opus 4.6；这些模型随后都有成功请求记录。
问题是工具定义与上游接口的兼容性，不能据此判断模型不可用。

原请求正文没有保存，无法确认具体工具。通用 Google Schema 清洗器会把根
`oneOf` 转为根 `anyOf`，并不满足 Claude 的根对象要求。

## 实现

`src/utils/claude-schema.ts` 先处理 Claude 工具的根级组合结构，随后通过原生
`FunctionDeclaration.parametersJsonSchema` 发送 JSON Schema，绕开 Google Schema 清洗器。
Chat、Responses、namespace 工具、客户端搜索加载的工具共用这一入口。
其他模型和结构化文本输出不经过此规范化器。

策略参考 [Claude Code 的根组合结构适配](https://code.claude.com/docs/en/mcp#tool-input-schemas-with-a-root-level-combinator)：

- `allOf` 合并属性与必填项，对同名属性求交。支持类型收窄、enum/const 交集、
  数值和长度上下界、嵌套对象及数组项的兼容交集。
- `anyOf`、`oneOf` 汇总所有分支属性，保留父级必填项和各分支公共必填项。
  分支的参数组合与互斥条件写入工具 description。
- 同名属性的联合生成明确类型的参数范围。枚举取并集，范围取包络；嵌套对象
  与数组递归合并。不同类型且无法可靠表示的属性联合返回本地错误。
- 本地 `$ref` 在需要改写的 schema 中展开。未解析引用、递归引用、不支持的根约束、
  不兼容的交集等情况返回带工具名和 schema 路径的错误，不选取一个分支继续调用。
- 原工具名称、namespace、参数层级和调用 ID 保持不变，不增加包装参数。
  重试时 Claude 工具也不使用会丢弃联合分支的通用 aggressive 清洗。
- 嵌套组合、`const`、布尔及数值枚举、`additionalProperties`、本地引用和递归定义
  通过原生 JSON Schema 保留。draft-7 元组的 `items: [...]` 转为 2020-12 的
  `prefixItems`，并迁移 `additionalItems` 及指向这些位置的本地引用；字面数据不改写。

这是兼容性改写，不是完全等价的 JSON Schema 编译器。联合分支间的关联约束
在上游 schema 中会有所放宽，原规则保留在工具说明中；工具执行端仍需用原始
schema 校验参数。代理保留客户端原工具定义，不新增完整 JSON Schema 校验器。
普通 schema 及其原有嵌套联合保留原始结构，通过原生 JSON Schema 发送。

## Google 中转的额外限制

Claude Code 官方文档说明 Claude 接口支持属性内部的组合结构，但本项目还经过
Antigravity 的 Google → Claude 转换层。

真实请求发现，把不同分支的同名枚举字段简单改成属性级 `anyOf`，会进一步触发
`JSON schema is invalid ... draft 2020-12`。给该字段补充 `type` 仍然失败。
同一请求改成 `type: STRING`、`enum: ["path", "url"]` 后返回 200。
因此本实现采用明确类型的联合包络，避免生成这类属性级 `anyOf`。
这项观测限于 Google `parameters` 的中转路径，不将它概括成 Claude 直接 API 的限制。
根级组合结构仍沿用上述已验证的适配；嵌套组合改用下面的原生字段。

## 2026-11-08 23:07 的嵌套组合错误

请求 `resp_0h33ddmc66lr` 的 493 个工具中，第 39 个（索引 38）是
`mcp__rea.capture_browser_scenario`，使用 `claude-sonnet-5-5-high`。
上游请求 ID 为 `req_vrtx_011Cgqfr86hqDDkN7ipyw6tv`。
该工具的根级只有 `type/properties/required/additionalProperties`，原来的根组合
适配不会处理它。它在 `browser`、`actions.items` 等位置包含嵌套对象 `oneOf`。

用本机已安装 REA 的真实工具 schema 重建请求，旧 `parameters` 路径返回相同的
`JSON schema is invalid ... draft 2020-12`。最小嵌套对象联合、以及补上
`type: object` 的对照样本也均为 400。

Google 的 [FunctionDeclaration 官方文档](https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/rest/Shared.Types/FunctionDeclaration)
提供原生 `parametersJsonSchema`，与 `parameters` 互斥。改用这一字段后：

- 完整 `capture_browser_scenario` schema 和两个最小样本均返回 200。
- 只有 schema 包含固定字段名和值的调用测试返回了正确标记，确认字段被实际读取。
- 本机 REA 的 207 个工具转换后均通过 draft 2020-12 元 schema 校验，合并发送至
  Sonnet 5.5 也返回 200。
- 生产代理于 23:21:15（Asia/Singapore）重启，随后从 `/v1/responses` 验证
  namespace 工具调用、模拟结果回传和 SSE 调用。
- 补齐元组引用的边界测试后，于 23:24:14 再次重启加载最终版本。

样本、原始响应及验证脚本保存在忽略目录
`data/claude-nested-schema-2026-11-08/`。这是基于真实工具定义的重建验证，
不是原失败请求正文的回放；没有执行生成的浏览器工具调用。

## 诊断

上游 400 指明 `tools.N.custom.input_schema` 时，新增的 `InvalidToolSchema` 日志记录：

- 请求 ID 与工具索引；
- 原工具名；
- 原始参数与实际上游参数的顶层关键字。

不额外打印参数值、工具结果或完整请求正文。

## 验证

使用 15 个工具的构造样本，第 10 个工具含根 `oneOf`，与生产错误位置一致。
这不是原始失败请求的回放。通过真实上游验证：

| 场景 | 结果 |
| --- | --- |
| 旧转换方式 | 400，复现相同的 `tools.9.custom.input_schema` 错误 |
| Sonnet 5.5、Opus 5.5、Sonnet 4.6、Opus 4.6 的改写请求 | 均为 200，调用正确工具和参数 |
| 上述四种模型的工具结果回传 | 均为 200，最终回复包含工具返回的验证标记 |
| Sonnet 5.5 流式调用及结果回传 | 均为 200，Responses SSE 与平面参数正常 |
| 单独的 `anyOf`、`allOf`，包括同名属性的数值范围和枚举交集 | 均为 200，生成的参数符合测试条件 |

旧请求错误与 12 个改写后生成请求都保存在本地忽略目录
`data/claude-schema-2026-11-08/`，包括 `probe.ts`、`report.json`、原始响应及转换后的请求。
报告标记了直接复用已有真实响应的阶段，避免为重复验证额外调用模型。
所有库存工具结果均为模拟数据，没有实际执行第三方工具。

单元测试覆盖所有分支保留、required-only 组合、本地引用、约束冲突、
同名属性合并、原始 schema 不变、Gemini 隔离、延迟加载，以及 JSON/SSE 的调用和回传。

```bash
bun test tests/unit/claude-schema.test.ts
bun test tests/unit
bun run lint:check
```

首次根组合修复的全量结果：332 pass、0 fail，TypeScript 检查通过。
生产代理已于 2026-11-08 01:47:34（Asia/Singapore）重启。
随后通过生产 `/v1/responses` 验证：根 `oneOf` 请求返回 200，参数保持为
`{tenant: "APAC", mode: "url", url: "https://example.test/item"}`；
同名属性类型互斥的 `allOf` 在本地返回 400，错误明确包含工具名
`choose_target` 和路径 `parameters.properties.x`。结果保存于本地
`data/claude-schema-2026-11-08/production-smoke.json`。

原生 JSON Schema 修复新增了嵌套组合、原始枚举类型、递归定义、延迟加载工具、
元组升级及字面数据保护的回归覆盖。全量结果：338 pass、0 fail，TypeScript 检查通过。
