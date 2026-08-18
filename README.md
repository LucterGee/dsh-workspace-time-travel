# dsh-workspace-time-travel（对话时间机器）

DSH Web 插件：在每轮对话消息旁增加一个「↩ 回退」按钮，点击后弹出三个选项：

1. **恢复代码和对话** — 先把工作区文件回退到该轮结束时的快照，再把对话分支（fork）到该位置并切换到新分支；
2. **恢复对话** — 只创建对话分支（等同内置分支按钮），文件不动；
3. **恢复代码** — 只回退工作区文件，对话继续向后走。

文件回退前会先弹出**变更预览**（哪些文件将被恢复/删除），确认后才执行；执行前自动备份当前状态，对话框里可**一键撤销**。全程不依赖、不触碰你的 git 仓库。

## 原理

- 主机侧（`lib/index.js`）：监听 `session/event`，每轮 `turn/end` 后用内容寻址方式快照工作区文件树（哈希去重、mtime 缓存加速，只存变更过的文件字节），快照按"该轮结尾 assistant 消息的 seq"为键，与对话 fork 的边界锚点一一对应。快照数据存于 `~/.dsh/storages/dsh-workspace-time-travel/`（blob + 每会话清单）。
- 浏览器侧（`lib/client.js`）：注册进 `conversation.chat.turnTail` 插槽（每轮消息尾部、内置分支按钮旁边），通过 `/tt/*` 路由与主机通信。
- 安全边界与官方 git-graph 插件一致：`/tt` 路由仅限 loopback 访问，且只允许操作已注册的工作区路径。

## 安装

```bash
cd <本目录>
dsh plugin --profile web add link:.
```

然后**重启 `dsh web`**（主机侧插件需要重新加载），刷新页面。

> 注意：插件加载后从**下一轮完成的对话**开始记录快照；之前的历史轮次没有快照，不会显示回退按钮（"恢复对话"仍可用内置分支按钮实现）。

## 卸载

```bash
dsh plugin --profile web remove dsh-workspace-time-travel
```

快照数据目录（`~/.dsh/storages/dsh-workspace-time-travel/`）不会被自动删除，确认不需要后可手动清理。

## 配置（可选）

`~/.dsh/dsh-workspace-tt.json`：

```json
{
  "ignore": [".git", "node_modules", ".DS_Store", "dist"],
  "maxFileBytes": 20971520
}
```

- `ignore`：扫描时忽略的目录/文件名（任何层级）。默认 `[".git", "node_modules", ".DS_Store", ".idea", ".vscode"]`。
- `maxFileBytes`：单文件大小上限，超过的文件只跟踪存在性、不存内容（回退时无法恢复其内容）。默认 20MB。

## 已知限制

- 快照只覆盖运行 `dsh web` 进程内会话的工作区（headless / 其他进程的会话不产生快照）。
- 符号链接不追踪（防止快照泄漏工作区外文件）；超过大小上限的文件不存内容。
- 回退是"把工作区整体还原到该轮结束时的状态"：之后新建的文件会被删除、删除的文件会被恢复——这正是"回到该位置"的语义，执行前请确认预览列表。
- 若当前有正在生成的回复，请等它结束后再回退。

## 开发（TypeScript）

源码在 `src/`，构建产物在 `lib/`（`lib/client.js` 由构建脚本生成，勿手改）：

- `src/store.ts` — 快照存储核心（纯逻辑，无 cordis 依赖，可单测）
- `src/index.ts` — 主机侧插件入口（`session/event` 监听 + `/tt/*` 路由）
- `src/client/` — 浏览器侧（`api.ts` / `styles.ts` / `index.tsx`）
- `scripts/build-client.mjs` — esbuild 将客户端打包为 CJS 并包进 `window.__ModuleLoader__.load` 外壳（shell 按原样伺服该文件）

```bash
pnpm install
pnpm run build    # tsc 主机侧 + esbuild 客户端 + 客户端类型检查
pnpm test         # 存储核心单测（node --test）
```

类型面直接引用官方 SDK 的 rc.7 类型包（`@deepseek-ai/dsh-session`、`dsh-host-webserver`、`dsh-client-runtime`、`dsh-client-ui-conversation`、`dsh-client-ui-slots` 等，均为 devDependencies，不影响 profile 运行时）。修改后重新 `pnpm run build`，再重启 `dsh web` 并刷新页面。
