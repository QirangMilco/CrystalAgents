# Upstream Sync Report

## 基本信息
- 当前分支：main
- 同步分支：sync-upstream-20260425
- 上游 remote / branch：upstream/main
- 同步前提交：fe7648aa71010486721bd3f9052135ef7ad8fcb4
- 同步后提交：10d63b3c6adeed1d141761b55a1f8ea831a6dc85
- 上游提交范围：c55fcda(v0.8.8) → 72087dd(v0.8.11)

## 本地特有 feature 基线
- Crystal Agents 品牌与变体配置：保留 `@crystal-agent/electron`、`app-variant`、Electron 构建与日志路径能力。
- 工作区数据目录变体：保留 `.crystal-agent` / `.crystal-agent-dev` 与 workspace data dir API，消息网关目录已改为 `getWorkspaceDataPath()`。
- 会话克隆与摘要创建：保留 `onCloneSession` / `onCreateSessionFromSummary`，补齐 Playground mock 回调。
- 工具元数据验证：保留 `withSessionToolMetadata()` 包装，并接入上游消息工具。
- 工作区旧版数据迁移与导入：保留国际化键与 UI 文案。
- Electron 日志路径：保留 `getCraftMainLogPath()` / `resolveCraftLogsDir()`，消息网关日志接入变体感知日志目录。

## 上游新增 feature
- v0.8.8–v0.8.11：已合入。
- Messaging Gateway / WhatsApp / Telegram：已合入，并将消息目录适配 Crystal workspace data path。
- inter-session messaging / messaging session tools：已合入，并保留 session tool metadata schema。
- label resolve、thinking levels、model config、Sentry / UI preview 相关更新：已合入并通过类型检查。
- release notes、docs、build scripts、worker build：已合入。

## 冲突处理
- `README.md`：保留 Crystal fork feature 摘要，并追加上游 README 正文。
- `apps/electron/package.json`：保留 `@crystal-agent/electron` 包名，更新 `version` / `upstreamVersion` 到 0.8.11。
- `apps/electron/src/main/logger.ts`：合并上游消息网关结构化日志，日志目录使用 Crystal 变体路径 API。
- `apps/electron/src/renderer/components/app-shell/ChatDisplay.tsx`：保留本地会话记录导航、滚动恢复和 local-storage 逻辑，接入上游 follow-up helper 与 error action。
- `apps/electron/src/renderer/components/app-shell/TopBar.tsx`：保留专注模式按钮和侧栏隐藏逻辑。
- `apps/electron/src/renderer/components/workspace/AddWorkspaceStep_CreateNew.tsx`：保留动态 `defaultConfigDirName` 展示。
- `packages/server-core/src/handlers/rpc/llm-connections.ts`：融合本地 custom endpoint provider hint 与上游 loopback no-auth 支持。
- `packages/session-tools-core/src/tool-defs.ts`：保留元数据包装，接入 `send_agent_message` 与 messaging gateway tools。
- `packages/shared/src/i18n/locales/*`：保留本地 workspace import 文案，接入上游 messaging 文案。
- `packages/ui/src/components/chat/TurnCard.tsx`：保留本地工具标题调试与稳定 steps summary，接入上游 i18n fallback。
- `bun.lock`：由 `bun install --ignore-scripts` 重建。

## 变体与路径审计
- 运行时硬编码回退已修复：Electron/headless messaging dir 使用 `getWorkspaceDataPath()`。
- 审计脚本已增强：注释、文档、示例、本地化展示文案和兼容 fallback 不再被误判为阻断项。
- `bun run audit:variant-paths`：通过。

## 验证结果
- `bun run typecheck:shared`：通过。
- `bun run test:shared:all`：通过，70 pass，0 fail。
- `bun run typecheck:electron`：通过。
- `bun run audit:variant-paths`：通过。

## 遗留风险
- `bun install` 普通模式曾因 Electron postinstall 网络请求 `ECONNRESET` 中断；已使用 `bun install --ignore-scripts` 完成依赖解析与锁文件更新。
- 未执行完整 `bun run typecheck:all`、`bun run lint`、`bun test`、Electron build；本次验证覆盖 shared、Electron typecheck、shared tests 与变体审计。
