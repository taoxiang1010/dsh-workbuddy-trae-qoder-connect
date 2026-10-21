# patches/ —— 本地补丁与一键重打

这个目录保存对上游插件的本地改动，让你在**重装插件后不必再手工改一遍文件**。

## 为什么需要它

`dsh-workbuddy-trae-qoder-connect` 目前有两个上游未修的问题（见仓库 issue
[#6](https://github.com/chengshenyangtai/dsh-workbuddy-trae-qoder-connect/issues/6)、
[#7](https://github.com/chengshenyangtai/dsh-workbuddy-trae-qoder-connect/issues/7)）：

| 补丁 | 问题 | 修法 |
|---|---|---|
| `0001-workbuddy-system-prompt-prefix-gate.patch` | 国区 WorkBuddy 每一轮都回 `400/11128`，因为 DSH 的 system prompt 以 `You are an AI agent powered by DeepSeek Harness` 开头，命中上游的内容门禁 | `prepareChatBody` 给首条 system 消息前置一个换行；附带把 `X-Conversation-*` 补到国区、并对 11128 重试至多 3 次 |
| `0002-trae-real-dev-context-window.patch` | Trae 长会话报 `502 context length exceeded`，因为插件把 `max` 档（1M）上报给 DSH，而 Max 模式从未被触发 | 上报真实可用的 dev 窗口 `min(group.dev, devWindowCap)`；输出上限改取 `raw.max_tokens` |

两个补丁分别对应两个 commit，历史与 issue 一一对应。

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
