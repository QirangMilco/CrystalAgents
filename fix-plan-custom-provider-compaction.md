# 自定义 Provider 压缩问题修复方案

## 问题分析

用户反馈了两个问题：

### 问题 1：模型设置的上下文窗口不影响自动压缩

**根因**：当通过 `set_model` 切换到自定义 endpoint 的新模型时，如果在 Pi SDK 的子进程中尚未注册该模型，`handleSetModel` 会动态注册它——但只传了 `{ id: bareId }`，没有携带用户在连接配置中设置的 `contextWindow` 和 `supportsImages`。Pi SDK 的 `buildCustomEndpointModelDef` 因此使用默认值 `131_072`，而不是用户设置的值。

这导致三个后果：
- **`this.model?.contextWindow` 不正确**：自动压缩的阈值计算 `contextTokens > effectiveContextWindow - effectiveReserveTokens` 使用了错误的 contextWindow
- **Pi SDK 的 overflow 检测**：`isContextOverflow(message, contextWindow)` 也使用了错误的 contextWindow
- **底部上下文信息显示错误**：`tokenUsage.contextWindow` 来自 adapter 的 `setContextWindow()`，其值来自 `modelDef?.contextWindow ?? runtimeContextWindow`——主进程侧的 runtime 有正确的自定义模型 contextWindow 信息，但当模型 ID 不在静态 MODEL_REGISTRY 中时，`modelDef` 为 undefined，回退到 `runtimeContextWindow`，这部分是正确的。但子进程侧的模型对象 contextWindow 错误，导致 usage 事件中报告的 contextWindow 也可能错误。

### 问题 2：手动触发压缩时出现 "Already compacted" 错误

**根因**：Pi SDK 的 `session.compact()` 方法在检测到分支中最后一个条目已经是 `compaction` 类型时会抛出 `"Already compacted"` 错误。这个错误在 `/compact` 命令处理中未被捕获，直接传播到聊天流，前端的 `/compact` 斜杠命令变成了错误消息。

## 修复方案

### Fix 1：动态注册模型时携带 contextWindow（`pi-agent-server/src/index.ts`）

在 `handleSetModel` 中，当需要动态注册模型时，从 `initConfig.customModels` 中查找该模型的 `contextWindow` 和 `supportsImages` 配置：

```typescript
const existingConfig = (initConfig.customModels ?? []).find(
  (m) => typeof m === 'object' && stripPiPrefix(m.id) === bareId,
);
registerCustomEndpointModels(..., [existingConfig ?? { id: bareId }]);
```

如果找到已有的配置，直接使用它（包含 contextWindow）；否则使用默认的 `{ id: bareId }`。

### Fix 2：/compact 命令优雅处理已知错误（`shared/src/agent/pi-agent.ts`）

用 try-catch 包裹 `requestCompact()` 调用，将 Pi SDK 的已知错误转为友好的 info 消息而非抛出错误：

| SDK 错误 | 友好的消息 |
| --- | --- |
| `"Already compacted"` | "Context is already compacted. No further compaction needed." |
| `"Nothing to compact (session too small)"` | "Session is too small to compact. Continue the conversation and try again later." |
| 其他错误 | "Compaction failed: {原错误消息}" |

## 验证

- TypeScript 编译无错误
- 动态注册模型时正确携带 contextWindow
- `/compact` 命令不再因 "Already compacted" 报错
