# DSH Web 端到端复现

这套流程使用 DSH 自己的 DeepSeek adapter、Agent loop、Web RPC、JSONL persistence、Projection 和浏览器模块加载。受控 Provider 只替代外部模型响应，不绕过 DSH，也不用于评估真实模型的工具选择质量。

先安装插件：

```bash
npm install
npm run verify
npm pack
dsh plugin --profile web add ./dsh-plugin-solo-thinking-0.1.18.tgz
```

终端 A 启动受控 Provider：

```bash
SOLO_E2E_PROVIDER_KEY=solo-e2e-key npm run e2e:provider
```

终端 B 启动 DSH Web。测试 patch 只关闭 LLM 标题生成，让 Provider 的请求序列只属于对话 Agent；普通标题 fallback 仍工作：

```bash
DEEPSEEK_BASE_URL=http://127.0.0.1:8000/v1 \
DEEPSEEK_API_KEY=solo-e2e-key \
dsh --profile web --patch ./scripts/e2e.patch.yml
```

终端 C 运行完整工具链：

```bash
npm run e2e:run
```

成功输出包含建议/根/子 Session ID、`suggestedBranches: 4`、`suggestedBranchesDormant: true`、`workspaceInherited: true`、生命周期树的 `revision: 7`、两个 `agent-authored` Handoff 标记、`childStatus: "returned"`、`parentNotice: true` 和 `childSessionPreserved: true`。脚本同时断言：

- `thinking_start → thinking_suggest` 一次建立四个互不重名的普通子 Session，均带定向 Handoff，保持 blank 且没有 `origin: subagent`；
- 在真实 Workspace 下启动的根 Session，其四个建议子 Session 都会持久化进入同一个 Workspace 账户，不落入“未分组”；
- `thinking_start → /thinking split → thinking_fork_handoff → /thinking checkpoint → thinking_checkpoint → /thinking return → thinking_return` 都经过真实 DSH Agent loop；
- human split 先产生 revision 1 的 `forkHandoffPending`，父 Agent 完成定向继承后产生 revision 2；子 Session 仍是 `blank: true`、`running: false`、`dormant: true`，且没有 `origin: subagent`；
- 子 Session 可用普通 `session.prompt` 唤醒，持久化 dormancy 在 revision 3 清除；
- `/thinking checkpoint` 先产生 revision 4 的刷新锁，再由分支 Agent 产生 revision 5 的 Current State；
- `/thinking return` 先产生 revision 6 的 `returning` 状态，再由分支 Agent 产生 revision 7 的 returned Handoff；
- Return 完成后子 Session 仍可读取，不会在 tool result 落盘前被销毁；
- 根与子 Session 最终都持有 revision 7，父 Session 另有一条持久化 Handoff notice，且父 Agent 没有被自动唤醒。

浏览器打开 `http://127.0.0.1:3080`。包含 `conversation.details.aux` 的 DSH 会在最终根会话右侧自动打开思考树；否则切换到「头脑风暴」。点击“技术可行性”只应选中节点，明确点击「进入分支对话」才导航；在右栏发送消息不应离开根会话。

最后重启同一条 DSH 命令，再打开两个 Session；两边仍应显示 revision 7。可在根节点新建一个分支，关闭 Provider 让它保持 `forkHandoffPending`，重启 DSH 和 Provider 后点击“让父 Agent 重试”：父 Agent 应调用 `thinking_fork_handoff`，节点变为可进入。这条路径同时验证 cold Session 的连续 seq 复制、控制轮保活和普通路由恢复。
