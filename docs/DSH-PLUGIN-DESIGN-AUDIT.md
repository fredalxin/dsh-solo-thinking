# DSH 插件设计对齐审计

审计基线：DeepSeek Harness `master` 文档与本地源码，2026-08-15。

## 官方插件模型的核心

1. **插件贡献能力，组合决定实现。** 消费方通过 `inject` 依赖 `sessions`、`tools` 一类具名服务，而不是在运行时绑定具体提供方。提供方消失时，Cordis 会卸载依赖它的 fiber；服务恢复后再加载。因此所谓“动态替换”首先是服务提供方替换，不是运行中替换 npm 依赖。
2. **一切长生命周期资源都必须可回卷。** Cordis 的事件、工具和注册表 API 自带 effect；外部订阅、watcher、连接和自行创建的 Agent handle 必须放入 `ctx.effect()` 并返回 disposer。HMR、配置变更和服务丢失都走同一卸载路径。
3. **bundle 与 profile 分工。** `dsh.bundle` 只回答包贡献什么 patch；profile 的直接依赖和 `dsh.profile.bundles` 才回答实际安装并启用什么。npm 的传递依赖或 peer dependency 不会替用户挂载另一个 bundle。
4. **Host 与 Client 是同一包的两个运行面。** `exports["./client"]` 与 `dsh.client` 让浏览器 bundle 进入模块图；`dsh.client.inject` 是包名级图元数据，真正的激活等待仍由客户端 `export const inject = [...]` 的服务依赖和 `slots.inject(...)` 的插槽声明控制。
5. **稳定身份是增量更新的锚点。** patch 行需要稳定 `id`。新增或删除 client 包后必须重启，因为 DSH 会缓存包元数据；开发态已在图中的 bundle 内容变更，才由 Client HMR 的 `rebuilt()` 通道刷新。生产图不包含 HMR 驱动。

官方依据：

- [Lifecycle and effects](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-tutorial/02-lifecycle-and-effects.md)
- [Services](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-tutorial/03-services.md)
- [Composition and HMR](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-tutorial/06-composition-and-hmr.md)
- [Packaging and installing a plugin](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md)
- [Client modules](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/client-modules.md)

## Solo Thinking 对齐结果

| 检查项 | 实现 | 结论 |
|---|---|---|
| Host 硬依赖 | 顶层只注入 `agents`、`sessions`、`systemPrompt`、`tools`、`workspaceRegistry` 这些服务名 | 符合 |
| Host 可选能力 | `commands`、`sessionProjections` 使用嵌套 `ctx.inject`；`sessionPersistence`、`agentPresets` 在使用点探测 | 符合，缺失时只降级对应能力 |
| Better Sidebar | 只在嵌套 `betterSidebar` fiber 中注册 Tab；注册和订阅位于一个 effect；服务卸载后完整回卷，恢复后重新注册 | 符合动态替换语义 |
| 插槽组合 | 对话主 Tab、官方右栏与输入按钮均通过 `slots.inject` 等待插槽声明 | 符合，不依赖 apply 顺序 |
| Provider 耦合 | 运行时只消费 `betterSidebar` 服务；`dsh-better-sidebar` 仅作为可选 peer 提供公开 TypeScript contract，不被打包 | 在 Better Sidebar 尚未拆出独立 Service Definition 包的条件下，耦合已限制在类型边界 |
| Profile 依赖 | 安装器把 Better Sidebar 与 Solo Thinking 都作为 profile 直接依赖安装 | 符合；peer 只表达兼容范围，不负责启用 |
| Client 模块 | 导出预构建 `./client`，声明 web 平台与实际 runtime bundle 依赖；激活依赖为 `slots`、`sessions`、`layout` | 符合 |
| HMR 清理 | 工具、事件、Prompt、Projection、Command 使用 effect-aware API；外部侧栏订阅、自动打开缓存和 Agent handle 有显式清理 | 符合，并有 provider replacement 回归测试 |
| 配置身份 | `cordis.patch.yml` 使用稳定 `id: solo-thinking` | 符合 |
| 分发 | npm/tarball 携带预构建 `lib/`；GitHub tag 仓库也提交 `lib/`，不依赖安装期构建 | 符合官方的预构建分发路径 |

## 有意保留的兼容层

当前 DSH RC 的 Session 持久化事件词表还没有在所有版本暴露下游注册服务。插件优先调用 `sessions.registerEventType`；旧版才临时向官方导出的 live catalog 注册 `solo-thinking/state`，并把反向删除放在 effect disposer 中。它是可逆的版本兼容层，不是理想的长期 service seam；等最低 DSH 版本统一提供注册 API 后应删除 fallback。

## 实际边界

- Better Sidebar 在运行中被卸载或替换：Solo Thinking 主功能和官方完整 Tab 保持工作，侧栏子 fiber 回卷；服务恢复后 Tab 与预热订阅重新注册。
- 安装或删除 `dsh-better-sidebar` npm 包：需要重启 DSH。因为这改变的是 client 包集合，不属于同一进程内的服务替换。
- 修改已加载的 Solo Thinking browser bundle：只有挂载了 DSH Client HMR 的开发组合会热更新；生产启动必须重启。

## Profile peer dependency 检查

对本机最终 profile 执行 `dsh plugin --profile web peers check` 后，缺失项全部归属于 `dsh-better-sidebar@0.12.1`，没有 Solo Thinking 的缺失 peer：

- DSH 与 React peer 由宿主应用提供并通过 DSH 的包解析回退被运行时使用，但 pnpm 只检查 profile 自己的依赖树，因此报告缺失。不要仅为消除提示把 React 或整套 DSH 包重复安装进 profile，否则可能制造 client singleton 双实例。
- `@xterm/addon-fit@0.10.0` 要求 `@xterm/xterm`，而 Better Sidebar 0.12.1 仍直接依赖旧包名 `xterm`。这是 Better Sidebar 的上游依赖声明债务，应由其升级到同一代 xterm 包解决。

当前运行时组合已通过 `--dump-config` 同时挂载两个 bundle，3080 Web 服务返回 200。安装器继续以最终组合验证为成功条件，但不会掩盖这条上游 peer 警告。
