# agy 1.5.9 checkpoint 上限与环境变量分析

分析对象：`/home/maozi/.local/bin/agy`，Linux ARM64 ELF，版本 `1.5.9`。
原始文件 SHA-256：`684136e4246393499343c9ba07ac4a69fa97729178f702d0132b50520d7ed699`。
参考脚本：`/home/maozi/antigravity_700k.py`。

结论：`AGY_CLI_AUTO_COMPACT_OVERRIDE` 能写入实际 checkpoint 预算，但本版本只对
通过上下文选择白名单的模型生效。静态白名单只有 `Gemini 4 Argon`。
因此不能用它普遍替代参考脚本的补丁，尤其不能直接用于未进入白名单的 Claude 模型。
分析依据是原始二进制的函数表、反汇编、ELF 重定位和内嵌 JSON。后续移植的脚本及验证
方式见文末；未进行 700k 上下文端到端测试。下列地址均为本文件的链接虚拟地址。

## 参考脚本修改了什么

脚本同时做两类修改：

1. 定位 `cortex/utils/utils.GetCheckpointConfig`，将 `min(budget, 256000)`
   中比较和取值的两个常量都改成 `700000`。
2. 修改 `model_profiles` 中 `CASCADE_USE_EXPERIMENT_CHECKPOINTER`
   的顶层 `max_token_limit`，把原值 `256000` 改成 `700000`。

agy 也包含这两层配置。本文件内嵌的 `M124`、`M400`、`M408`、`M525`、`M667`
五个 profile 的该值是 `256000`；其他 profile 还有 `80000`、`128000`、
`160000`、`512000`，参考脚本的逻辑不会修改它们。

## 环境变量实际经过的路径

| 位置 | 已确认行为 |
| --- | --- |
| `Store.ContextWindow`，`0x9e276e0` | 根据所选模型解析显示名称，先检查模型白名单 |
| `0x9e27790` → `0x9e277c8` | 不在名单中就返回空字符串，在读取变量前结束 |
| 静态 slice `0xc84e4a0` | 长度为 1，唯一元素为 `Gemini 4 Argon`；UI 的 `offersContextWindow` 也读取此名单 |
| `AutoCompactOverrideSpec`，`0x9e27460` | 调用 `os.Getenv("AGY_CLI_AUTO_COMPACT_OVERRIDE")` 并 `TrimSpace` |
| `AutoCompactOverride`，`0x9e274b0` | 解析绝对值或百分比，将结果格式化成十进制字符串 |
| `Manager.syncContextWindow`，`0x9e279e0` | 把 `Store.ContextWindow()` 的结果传给 backend |
| `ServerBackend.SetContextWindow`，`0x9b4a980` | 保存该字符串 |
| `buildCascadeConfigInternal`，`0x9b46ee8` 起 | 读取 backend 上下文值，调用 `ContextWindow.MaxTokenLimit` |
| `0x9b46f1c` | 检查本次构建配置的模型与当前所选模型相同 |
| `0x9b46f3c`、`0x9b46f64` | 写入 `CheckpointConfig.MaxTokenLimit`，再安装到 `CascadeConfig.CheckpointConfig` |

环境变量不是只改变状态栏显示。它产生请求配置中的实际 `max_token_limit`。
但模型检查意味着不能假定同一覆盖值会传给其他模型或使用其他模型的子任务。

解析规则：

- `700000`：十进制无符号 32 位整数，必须大于零。
- `70%`：整数百分比，范围 `1..100`，需要正的模型容量作为基数。
- `700k`、`0`、空值和非法文本不会得到有效覆盖。
- 不要根据变量名理解为“额外增加 700000”；这是目标预算的绝对值。

对通过模型检查的会话，可用以下启动方式，再选择 Gemini 4 Argon：

```bash
AGY_CLI_AUTO_COMPACT_OVERRIDE=700000 agy
```

## 与 GetCheckpointConfig 的先后关系

`GetCheckpointConfig` 位于 `0x8327a40`。在其一个分支中：

```text
0x8327b54..0x8327b68:
    x4 = 0x3e800               # 256000
    compare budget, x4
    x4 = 0x3e800
    budget = min_unsigned(budget, x4)
```

这是默认配置生成路径中的限制，不是配置合并结束后的统一硬上限。
`augmentConversationalConfigWithExperiment` 先处理默认 checkpoint 和实验配置，
再于 `0x8481864` 合并传入配置。外层 `GetCascadeConversationalConfigWithExperiment`
再于 `0x84827f0` 合并配置，随后调用 `clampAndValidateConfig`。
因此有效的显式 `max_token_limit` 可以覆盖默认生成值和实验中的值。

最终仍调用 `ClampCheckpointConfigForModelInfo`（`0x83283d0`）：它会依据模型容量、
planner 输出预留，以及特定 strategy 的摘要模型容量继续降低预算。
这里没有统一的 `256000` 常量上限。因此环境变量能绕过默认的 256k 预算，
但不会扩大模型本身的输入容量。不能仅凭设置成功就断言最终一定是 700k。

## 若需要给其他模型移植参考补丁

可以移植“默认配置常量 + profile”两处修改，但需要重新实现 ELF/ARM64 定位。
本文件对应的 clamp 有两组 `mov` / `movk`，应把两组 `0x3e800` 都改成
`0xaae60`（700000），同时修改上述五个 profile，保留其他字段。
这仍然受后续模型容量检查约束。

另一条路线是修改 CLI 的模型白名单判断，让环境变量用于更多模型；这会改变 CLI
上下文选择行为，作用范围不同于参考脚本，不能当成等效移植。

实际编写补丁时应保留参考脚本的函数内唯一匹配、原字节校验、备份、哈希记录和恢复机制。
不要复用这里的固定地址跨版本打补丁，也不要照搬 PE `.text` 的偏移计算：本 ELF 的
Go `runtime.text` 为 `0x6f480c0`，与 `.text` 节起始位置有 `0xc0` 的差异。

## 已移植的补丁脚本

`scripts/agy_700k.py` 使用 Python 标准库，支持 Linux ARM64 ELF。默认目标为 PATH 中的
`agy`，找不到时使用 `~/.local/bin/agy`；其他文件使用 `--file /path/to/agy` 指定。

在仓库根目录执行：

```bash
python3 scripts/agy_700k.py check
python3 scripts/agy_700k.py apply
python3 scripts/agy_700k.py restore
```

脚本通过 ELF 的 Go moduledata 重定位恢复 `runtime.text`，定位唯一的
`GetCheckpointConfig`，验证完整 ARM64 比较/选择指令模式后修改两组常量。
profile 修改保持原脚本的 JSON 语义校验。它不更改 CLI 模型白名单。

默认在 `${XDG_STATE_HOME:-~/.local/state}/agy-700k/` 保存：

- `<原始 SHA-256>.original`：完整原始文件备份。
- `<补丁后 SHA-256>.json`：包含原始哈希和修改字节的恢复记录。

可以用 `--state-dir /path/to/state` 指定其他位置。应用时会在目标目录生成临时文件，
验证反向定位、原文件未变化及备份哈希，再原子替换。重复应用和重复恢复均不产生新的修改。
恢复必须通过原始 SHA-256 校验；未知架构、指令模式变化或不匹配的字节会直接报错。
已经运行的进程继续使用旧映像，需要退出并重新启动 agy。

验证命令（集成测试需要未修改的 agy，也可以使用 `.original` 备份）：

```bash
AGY_PATCH_TEST_BINARY=/path/to/original/agy \
  PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests/unit -p test_agy_700k.py -v
```

6 项测试覆盖完整文件逐块比对、备份、重复应用、精确恢复、启动检查、错误架构、
异常比较指令、损坏恢复记录和 JSON 修改范围。启动检查仅运行 `--version`，不发起模型请求。
该验证证明补丁正确落在本地预算逻辑上，模型实际可用上下文仍受模型容量及服务端限制约束。
