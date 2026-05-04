# 自动压缩不显示 + 手动压缩提示已压缩 完整修复方案

## 根因分析

通过日志分析，自动压缩**确实在每轮都在运行**（`thresholdTriggered=1`，每轮都触发了 `_runAutoCompaction`），但 UI 完全不显示压缩卡片。通过逐一追踪整个事件链路，确认了三个独立的问题：

### 根因 1：contextWindow 优先级错误 — 用户设置被覆盖

`buildCustomModelsForRuntime()` 中的 contextWindow 优先级为：
1. 每模型显式值 (explicitContextWindow)
2. 提供方注册表默认值 (providerContextWindow)  
3. 用户连接级设置 (fallbackContextWindow)

对于自定义 endpoint，`providerContextWindow` 为 `undefined`（模型不在 Anthropic 注册表中），`explicitContextWindow` 始终有值（15361，从模型配置自动填充）。之前的修复尝试用 `explicitContextWindow !== providerContextWindow` 判断是否使用 fallback，但对自定义 endpoint 此比较始终为 true，导致用户设置的 20k 从未生效。

**log 证据**：`customModels=gpt-5.4-mini:15361` — 用户设置了 20000，但实际只有 15361。

### 根因 2：前端 compaction_complete 处理器静默丢弃消息

前端 `handleInfo` 收到 `compaction_complete` 事件时，只在 `session.messages` 中查找 `role='status' && statusType='compacting'` 的消息来**更新**。当压缩状态消息因事件顺序问题尚未被处理时（或事件成批到达），找不到匹配消息，压缩信息被**静默丢弃**。之前的修复添加了 fallback append，但可能由于其他过滤机制仍未生效。

### 根因 3：/compact 的 "Already compacted" 异常未正确处理

Pi SDK 的 `session.compact()` 在检测到分支最后条目已是 compaction 类型时抛出 `"Already compacted"`。虽然 `/compact` 处理器中有 try-catch，但 `requestCompact()` 调用的 `handleCompactResult()` 在 `success=false` 时 reject promise，如果 reject 发生在 try-catch 外层，错误仍会传播。

## 修复方案

### Fix 1：contextWindow 优先级 — fallbackContextWindow 始终最高

**文件**: `packages/shared/src/agent/backend/internal/drivers/pi.ts`

用户设置的 `connection.contextWindow` 应始终优先于任何默认值：

```diff
- const contextWindow = fallbackContextWindow ?? explicitContextWindow ?? providerContextWindow;
```

### Fix 2：前端 compaction handler — 总是追加消息

**文件**: `apps/electron/src/renderer/event-processor/handlers/session.ts`

当收到 `compaction_complete` 事件时：优先更新现有的 `compacting` 状态消息；如果不存在，**追加**新的压缩卡片到消息列表。

### Fix 3：/compact 异常处理加强

**文件**: `packages/shared/src/agent/pi-agent.ts`

确保 promise 层面的 `compact_result` reject 也被正确捕获为 info 消息。

## 验证方法

- 检查 customModels 日志中的 contextWindow 应为用户设置值
- 压缩发生时应有 `Got event: status` 和 `Got event: info` 的 main process 日志
- UI 应显示压缩卡片（"Context Compacted + Removed ~X tokens"）
