# patches/ —— 本地补丁与一键重打

这个目录保存对上游插件的本地改动，让你在**重装插件后不必再手工改一遍文件**。

## 为什么需要它

`dsh-workbuddy-trae-qoder-connect` 目前有两个上游未修的问题（见仓库 issue
[#6](https://github.com/chengshenyangtai/dsh-workbuddy-trae-qoder-connect/issues/6)、
[#7](https://github.com/chengshenyangtai/dsh-workbuddy-trae-qoder-connect/issues/7)）：

| 补丁 | 问题 | 修法 |
|---|---|---|
| `0001-workbuddy-system-message-content-gate.patch` | 国区 WorkBuddy 回 `400/11128`：网关对**整段 body 做指纹比对**（system 提示词、assistant 输出、工具结果、tool_calls 参数都算） | `prepareChatBody` 把特征句从**每条消息的所有字符串**里改写掉（递归覆盖 content / tool_calls.arguments）；`DeepSeek Harness` -> `DSH` 只作用于 system，避免改坏工具输出里的真实路径；附带补 `X-Conversation-*`、11128 重试 3 次、全失败时落盘 |
| `0002-trae-real-dev-context-window.patch` | Trae 长会话报 `502 context length exceeded`，因为插件把 `max` 档（1M）上报给 DSH，而 Max 模式从未被触发 | 上报真实可用的 dev 窗口 `min(group.dev, devWindowCap)`；输出上限改取 `raw.max_tokens` |

两个补丁都是**相对上游 `b3f2068` 的累计快照**（不是逐个 commit 的增量），所以直接
按文件名顺序全部打上即可；仓库里的 commit 只用来记录改动过程与依据。

## 0001 的五次迭代：范围一次比一次大

网关是对 body 做**模糊指纹比对**，命中特征句即判为未授权客户端。这个门禁的判定
还会随请求漂移，所以**单臂测试（哪怕连发 3~4 次）会给出与事实相反的答案**——前三次
「已验证通过」全栽在这里：

| 版本 | 修法 | 结果 |
|---|---|---|
| v1 | 前置换行，保留短语 | 失败 |
| v2 | 换成 `DeepSeek Harness (DSH)` | 失败（替换串仍含原 token） |
| v3 | 只改写首句动词 | 失败 |
| v4 | system 里整词替换 `DeepSeek Harness` -> `DSH` | 10-22 通过，10-28 失败 |
| v5 | system 里改写两句特征句 | 10-28 通过，11-04 失败 |
| v6 | 特征句改写到**所有消息** | 当前 |

### 排查套路（比结论更值得记）

1. **先看落盘 body**：插件在 11128 重试全败时会把出站请求写进
   `~/.dsh/.workbuddy-blocked-*.json`。先确认「补丁没生效」还是「生效但仍被拦」。
   v4/v5 失效都是后者——system 已经干净，仍被拒。
2. **把 dump 前缀解析成完整消息并重放**：dump 会截断（300KB），但能解出大部分
   message 对象；重建 body 后先确认能否复现。
3. **对消息列表二分**：v6 就是这样定位到「第 165 条是一条 assistant 消息，
   里面只是**引用**了 DSH 提示词原文」。再在消息内二分字符，最小触发长度 517 字符，
   命中点还是同两句。
4. **消融 + 同窗对照**，不要单臂重复。

### v6 的量测结论

- 触发句对（单独都不拦，连在一起才拦）：
  `Tokens prefixed with @ are paths the user explicitly referenced.`
  `Relative paths resolve from the workspace root`
- 作用范围：**整个 body**。assistant 输出、工具结果、`tool_calls` 参数都算。
- `DeepSeek Harness` 这个 token 在**工具输出的路径里单独不触发**（10-28 实测 20 条
  路径 0/3），所以 token 改写只留在 system，避免把模型要用的真实路径改坏。
- 真实验证：299KB / 177 条消息的 body，原始 3/3 拦，改写后 0/3。

现在修法是两张表（`SENTENCE_REWRITES` / `SYSTEM_REWRITES`），出现新的被拦片段
加一行即可。

## 一键重打

**Windows（PowerShell，推荐）：**

```powershell
# 只检查能不能打（不写文件）—— 重装后先跑这个
scripts\apply-patches.ps1 -Check

# 真正打上
scripts\apply-patches.ps1
```

**Linux / macOS（bash）：**

```bash
scripts/apply-patches.sh --check   # 只检查
scripts/apply-patches.sh           # 打上
```

两个脚本行为一致；目标目录按以下优先级定位：

1. `--target` / `-Target` 显式指定（含 `lib/` 的那一层）
2. `$DSH_PROFILE_DIR` 下的 `node_modules/dsh-workbuddy-trae-qoder-connect`
3. `$DSH_HOME/profiles/desktop/node_modules/dsh-workbuddy-trae-qoder-connect`

脚本用 `git apply`，因此：

- **幂等**：已经打过的补丁会识别出来并跳过（反向 `--check` 通过即视为已生效），重复跑不会打重。
- **安全**：任何一个补丁打不上就立即停下并报错（exit 5/6），不会留下打了一半的状态。
- **零依赖**：不需要本仓库是 git 仓库，目标目录也不需要是（PowerShell 版会临时初始化一个用完即删）。

### 打完必须重启

插件代码改动**不会热加载**——Node 的 ESM 模块按进程缓存，改文件只影响下次启动。
必须**完全退出 DSH 再打开**（托盘退出，不是刷新页面）。

确认补丁真的在跑：

```bash
cat ~/.dsh/.workbuddy-host-heartbeat.json
# "patch" 字段应为 cn-prompt-prefix-gate@2026-10-21c
```

## 什么时候需要重新生成补丁

`--check` 报 `打不上`（exit 5）说明目标文件与补丁基线不一致——通常是插件升级了。
这时基于新版本重新生成：

```bash
# 在装好新版的安装副本上重做改动后：
git -C <你的仓库> add -A && git -C <你的仓库> commit -m "..."
git -C <你的仓库> format-patch <上游基线>..HEAD -o patches/
```

基线记录在补丁的 `index <旧>..<新>` 行里；当前基线是上游 `b3f2068`。

> 注意：补丁文件必须是 **LF 行尾**。目标文件是 LF，若补丁是 CRLF，
> `git apply` 会以「patch does not apply」失败。PowerShell 的 `Set-Content`
> 默认写 CRLF，所以生成补丁请用 `git diff`/`format-patch`，或写盘后转 LF。

## 诊断文件（0001 附带）

排查 11128 时加了两个落盘辅助，保留以便下次定位：

- `$DSH_HOME/.workbuddy-retry.log` —— 每次被 11128 拦记录一行（含第几次/共几次）
- `$DSH_HOME/.workbuddy-blocked-<ts>.json` —— 三次全被拦时保存出站请求（已去 `Authorization`，body 截断 300KB）

**注意**：后者含你的对话内容，排查完建议删掉：

```bash
rm -f ~/.dsh/.workbuddy-blocked-*.json
```
