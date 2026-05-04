#!/usr/bin/env node
/**
 * Pi Agent Server
 *
 * Out-of-process Pi agent server communicating via JSONL over stdio.
 * Wraps @mariozechner/pi-coding-agent SDK and communicates with the main
 * Electron process using a line-delimited JSON protocol.
 *
 * The main process spawns this as a child process. All Pi SDK interactions
 * (session creation, prompting, tool execution, permissions) happen here,
 * with events forwarded back to the main process for UI rendering.
 *
 * This design isolates the Pi SDK's ESM + heavy dependencies into a
 * separate process, avoiding bundling issues in the Electron main process.
 */

import http from 'node:http';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { mkdirSync, readdirSync, statSync, existsSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';

// Pi SDK
import {
  createAgentSession,
  SessionManager as PiSessionManager,
  AuthStorage as PiAuthStorage,
  ModelRegistry as PiModelRegistry,
  createReadToolDefinition,
  createBashToolDefinition,
  createEditToolDefinition,
  createWriteToolDefinition,
  createGrepToolDefinition,
  createFindToolDefinition,
  createLsToolDefinition,
} from '@mariozechner/pi-coding-agent';
import type {
  AgentSession,
  AgentSessionEvent,
  AgentToolResult,
  AuthCredential,
  CreateAgentSessionOptions,
  ToolDefinition,
} from '@mariozechner/pi-coding-agent';

// Pi AI types
import type { TextContent as PiTextContent } from '@mariozechner/pi-ai';

// Pre-register the Bedrock provider module so the Pi SDK doesn't attempt a
// dynamic import of "./amazon-bedrock.js" — which fails in the bundled output
// because bun collapses everything into a single file.
// With the current Pi SDK (0.70.0 here), pi-ai is deduped (single hoisted
// copy), so one registration covers both pi-ai and pi-agent-core module scopes.
import { setBedrockProviderModule } from '@mariozechner/pi-ai';
import { bedrockProviderModule } from '@mariozechner/pi-ai/bedrock-provider';
setBedrockProviderModule(bedrockProviderModule);

// Model resolution (extracted for testability + custom-endpoint precedence)
import { resolvePiModel, isDeniedMiniModelId, isModelNotFoundError } from './model-resolution.ts';
import { pickProviderAppropriateMiniModel } from './pick-mini-model.ts';
import {
  buildCustomEndpointModelDef,
  normalizeCustomEndpointModelEntry,
  stripPiPrefix,
  type CustomEndpointModelEntry,
  type CustomEndpointModelOverrides,
} from './custom-endpoint-models.ts';

// Direct source imports from shared (bundled by bun build)
import { handleLargeResponse, estimateTokens, TOKEN_LIMIT } from '../../shared/src/utils/large-response.ts';
import { getSessionPlansPath, getSessionPath } from '../../shared/src/sessions/storage.ts';
import { buildCallLlmRequest, withTimeout, LLM_QUERY_TIMEOUT_MS } from '../../shared/src/agent/llm-tool.ts';
import type { LLMQueryRequest, LLMQueryResult } from '../../shared/src/agent/llm-tool.ts';
import { PI_TOOL_NAME_MAP, THINKING_TO_PI } from '../../shared/src/agent/backend/pi/constants.ts';
import { getDefaultSummarizationModel } from '../../shared/src/config/models.ts';
import { getCraftMainLogPath } from '../../shared/src/config/log-paths.ts';
import { createWebFetchTool } from './tools/web-fetch.ts';
import { resolveSearchProvider } from './tools/search/resolve-provider.ts';
import { createSearchTool } from './tools/search/create-search-tool.ts';
import { validateNativeToolInput } from './native-tool-input.ts';
import { allowCraftMetadataProperties, stripCraftMetadata } from './craft-metadata-schema.ts';

// ============================================================
// Types — JSONL Protocol
// ============================================================

/** Credential union used in init and token_update messages */
type PiCredential =
  | { type: 'api_key'; key: string }
  | { type: 'oauth'; access: string; refresh: string; expires: number }
  | { type: 'iam'; accessKeyId: string; secretAccessKey: string; region?: string; sessionToken?: string };

/** Custom endpoint protocol — determines which streaming adapter Pi SDK uses */
type CustomEndpointApi = 'openai-completions' | 'openai-responses' | 'anthropic-messages';

/** Init message from main process — configures the Pi agent server */
interface InitMessage {
  type: 'init';
  apiKey: string;
  model: string;
  cwd: string;
  thinkingLevel: string;
  workspaceRootPath: string;
  sessionId: string;
  sessionPath: string;
  workingDirectory: string;
  plansFolderPath: string;
  miniModel?: string;
  agentDir?: string;
  providerType?: string;
  authType?: string;
  workspaceId?: string;
  baseUrl?: string;
  branchFromSdkSessionId?: string;
  branchFromSessionPath?: string;
  branchFromSdkTurnId?: string;
  customEndpoint?: { api: CustomEndpointApi; supportsImages?: boolean };
  customModels?: Array<string | { id: string; contextWindow?: number; supportsImages?: boolean }>;
  piAuth?: { provider: string; credential: PiCredential };
}

/** Messages from main process (stdin) */
type InboundMessage =
  | InitMessage
  | { type: 'prompt'; id: string; message: string; systemPrompt: string; images?: Array<{ type: 'image'; data: string; mimeType: string }> }
  | { type: 'register_tools'; tools: ProxyToolDef[] }
  | { type: 'tool_execute_response'; requestId: string; result: { content: string; isError: boolean } }
  | { type: 'pre_tool_use_response'; requestId: string; action: 'allow' | 'block' | 'modify'; input?: Record<string, unknown>; reason?: string }
  | { type: 'abort' }
  | { type: 'mini_completion'; id: string; prompt: string; systemPrompt?: string; maxTokens?: number; temperature?: number }
  | { type: 'llm_query'; id: string; request: LLMQueryRequest }
  | { type: 'ensure_session_ready'; id: string }
  | { type: 'set_model'; model: string }
  | { type: 'set_thinking_level'; level: string }
  | { type: 'compact'; id: string; customInstructions?: string }
  | { type: 'set_auto_compaction'; id: string; enabled: boolean }
  | { type: 'steer'; message: string }
  | { type: 'token_update'; piAuth: { provider: string; credential: PiCredential } }
  | { type: 'shutdown' };

/** Proxy tool definition from main process */
interface ProxyToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** Canonical tool metadata propagated on Pi tool start events */
interface ToolExecutionMetadata {
  intent?: string;
  displayName?: string;
  source: 'interceptor';
}

type EnrichedToolExecutionStartEvent = Extract<AgentSessionEvent, { type: 'tool_execution_start' }> & {
  toolMetadata?: ToolExecutionMetadata;
};

type OutboundAgentEvent = AgentSessionEvent | EnrichedToolExecutionStartEvent;

/** Messages to main process (stdout) */
interface OutboundReady { type: 'ready'; sessionId: string | null; callbackPort: number }
interface OutboundEvent { type: 'event'; event: OutboundAgentEvent }
interface OutboundPreToolUseReq {
  type: 'pre_tool_use_request';
  requestId: string;
  toolName: string;
  toolCallId?: string;
  input: Record<string, unknown>;
}
interface OutboundToolExecReq { type: 'tool_execute_request'; requestId: string; toolName: string; args: Record<string, unknown> }
interface OutboundSessionToolCompleted { type: 'session_tool_completed'; toolName: string; args: Record<string, unknown>; isError: boolean; content?: string }
interface OutboundMiniResult { type: 'mini_completion_result'; id: string; text: string | null }
interface OutboundLlmQueryResult {
  type: 'llm_query_result';
  id: string;
  result: LLMQueryResult | null;
  errorMessage?: string;
  /**
   * When set, signals the main process that a generic `error` with the same code
   * was also emitted on the error channel (for centralized auth-refresh detection).
   */
  errorCode?: string;
}
interface OutboundEnsureSessionReadyResult { type: 'ensure_session_ready_result'; id: string; sessionId: string | null }
interface OutboundCompactResult {
  type: 'compact_result';
  id: string;
  success: boolean;
  result?: { summary: string; firstKeptEntryId: string; tokensBefore: number };
  errorMessage?: string;
}
interface OutboundSetAutoCompactionResult {
  type: 'set_auto_compaction_result';
  id: string;
  success: boolean;
  enabled: boolean;
  errorMessage?: string;
}
interface OutboundSessionIdUpdate { type: 'session_id_update'; sessionId: string }
interface OutboundError { type: 'error'; message: string; code?: string }

type OutboundMessage =
  | OutboundReady
  | OutboundEvent
  | OutboundPreToolUseReq
  | OutboundToolExecReq
  | OutboundSessionToolCompleted
  | OutboundMiniResult
  | OutboundLlmQueryResult
  | OutboundEnsureSessionReadyResult
  | OutboundCompactResult
  | OutboundSetAutoCompactionResult
  | OutboundSessionIdUpdate
  | OutboundError;

function normalizeSessionToolMetadataArgs(args: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...args };

  const displayName = typeof normalized._displayName === 'string'
    ? normalized._displayName
    : typeof normalized.displayName === 'string'
      ? normalized.displayName
      : undefined;

  const intent = typeof normalized._intent === 'string'
    ? normalized._intent
    : typeof normalized.intent === 'string'
      ? normalized.intent
      : typeof normalized.intention === 'string'
        ? normalized.intention
        : undefined;

  if (displayName && typeof normalized._displayName !== 'string') {
    normalized._displayName = displayName;
  }
  if (intent && typeof normalized._intent !== 'string') {
    normalized._intent = intent;
  }

  delete normalized.displayName;
  delete normalized.intent;
  delete normalized.intention;

  return normalized;
}

// ============================================================
// State
// ============================================================

let piSession: AgentSession | null = null;
let piModelRegistry: PiModelRegistry | null = null;
let moduleAuthStorage: PiAuthStorage | null = null;
let unsubscribeEvents: (() => void) | null = null;

// Init config (set on 'init' message)
let initConfig: Extract<InboundMessage, { type: 'init' }> | null = null;

// Mutable state
let currentUserMessage = '';
let currentPromptRequestId: string | null = null;
type ActiveToolContext = {
  toolName?: string;
  toolCallId?: string;
  requestId?: string;
  sourceLayer?: 'sdk-ajv' | 'native-validation' | 'auto-compaction' | 'pre-tool-use' | 'proxy-tool-request';
  args?: Record<string, unknown>;
  rawArgs?: Record<string, unknown>;
  normalizedArgs?: Record<string, unknown>;
  schemaSummary?: string;
  validationCount?: number;
  stage?: string;
};
let activeToolContext: ActiveToolContext | null = null;
let toolValidationRepeatState: {
  toolName?: string;
  sourceLayer?: string;
  count: number;
} | null = null;

// Pending promises for async handshakes
const pendingPreToolUse = new Map<string, { resolve: (response: { action: string; input?: Record<string, unknown>; reason?: string }) => void }>();
const pendingToolExecutions = new Map<string, {
  resolve: (result: { content: string; isError: boolean }) => void;
  toolName?: string;
  args?: Record<string, unknown>;
}>();

// Pending session MCP tool calls for completion detection
const pendingSessionToolCalls = new Map<string, { toolName: string; arguments: Record<string, unknown> }>();

// Proxy tool definitions from main process
let proxyToolDefs: ProxyToolDef[] = [];

// Speculative prefetch for read-only tools (enables parallel execution despite Pi SDK's sequential loop).
// When the LLM emits multiple call_llm tool calls in a single message, we fire all requests
// to the main process in parallel on message_end (before executeToolCalls iterates sequentially).
// Each proxy tool's execute() then hits the cache instead of sending a new request.
const PREFETCHABLE_TOOLS = new Set(['call_llm']);
const prefetchCache = new Map<string, Promise<{ content: string; isError: boolean }>>();

function isPrefetchableTool(toolName: string): boolean {
  const stripped = toolName.replace(/^(mcp__session__|session__)/, '');
  return PREFETCHABLE_TOOLS.has(stripped);
}

// Flag: proxy tools changed since last session creation — session needs recreation
let toolsChanged = false;

// Callback server for call_llm
let callbackServer: http.Server | null = null;
let callbackPort = 0;

// ============================================================
// JSONL I/O
// ============================================================

function send(msg: OutboundMessage): void {
  const line = JSON.stringify(msg);
  process.stdout.write(line + '\n');
}

function debugLog(message: string): void {
  // Write debug messages to stderr so they don't interfere with JSONL protocol
  process.stderr.write(`[pi-server] ${message}\n`);
}

function compactionDebugEnabled(): boolean {
  return process.env.CRAFT_DEBUG_COMPACTION === '1';
}

function compactionSummaryIoEnabled(): boolean {
  return process.env.CRAFT_DEBUG_COMPACTION_SUMMARY_IO === '1';
}

function deepSeekCacheDebugEnabled(): boolean {
  return process.env.CRAFT_DEBUG_DEEPSEEK_CACHE === '1';
}

function deepSeekCacheDebug(message: string, details?: Record<string, unknown>): void {
  if (!deepSeekCacheDebugEnabled()) return;
  const payload = details ? ` ${JSON.stringify(details)}` : '';
  process.stderr.write(`[deepseek-cache] PiServer ${message}${payload}\n`);
}

function getElectronMainLogPath(): string {
  return getCraftMainLogPath();
}

function persistCompactionFailure(message: string): void {
  const line = `${new Date().toISOString()} [pi-server] [compaction-summary-io] ${message}\n`;
  try {
    const logPath = getElectronMainLogPath();
    mkdirSync(join(logPath, '..'), { recursive: true });
    appendFileSync(logPath, line, 'utf8');
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[pi-server] failed to persist compaction failure log: ${errorMessage}\n`);
  }
}

function logCompactionDebug(message: string): void {
  if (compactionDebugEnabled()) {
    debugLog(`[compaction-debug] ${message}`);
  }
}

function logCompactionSummaryIo(message: string): void {
  if (compactionSummaryIoEnabled()) {
    debugLog(`[compaction-summary-io] ${message}`);
  }
}

function logCompactionFailure(message: string): void {
  debugLog(`[compaction-summary-io] ${message}`);
  persistCompactionFailure(message);
}

function isToolValidationFailureMessage(message: string): boolean {
  return message.includes('Validation failed for tool "') && message.includes('Received arguments:');
}

function persistToolValidationFailure(message: string): void {
  const line = `${new Date().toISOString()} [pi-server] [tool-validation] ${message}\n`;
  try {
    const logPath = getElectronMainLogPath();
    mkdirSync(join(logPath, '..'), { recursive: true });
    appendFileSync(logPath, line, 'utf8');
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[pi-server] failed to persist tool validation log: ${errorMessage}\n`);
  }
}

function logToolValidationFailure(message: string): void {
  debugLog(`[tool-validation] ${message}`);
  persistToolValidationFailure(message);
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function getPromptSnippet(): string {
  const text = compactWhitespace(currentUserMessage || '');
  if (!text) return '∅';
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

function summarizeToolSchema(schema: Record<string, unknown> | undefined): string | undefined {
  if (!schema) return undefined;
  const required = Array.isArray(schema.required) ? schema.required.filter((v): v is string => typeof v === 'string') : [];
  const properties = schema.properties && typeof schema.properties === 'object'
    ? Object.keys(schema.properties as Record<string, unknown>).sort()
    : [];
  const additionalProperties = schema.additionalProperties === undefined
    ? 'default'
    : String(schema.additionalProperties);
  return `required=${required.join(',') || '∅'} properties=${properties.join(',') || '∅'} additionalProperties=${additionalProperties}`;
}

function updateToolValidationRepeatState(toolName: string | undefined, sourceLayer: string | undefined): number {
  const state = toolValidationRepeatState;
  if (state && state.toolName === toolName && state.sourceLayer === sourceLayer) {
    const nextCount = state.count + 1;
    toolValidationRepeatState = { ...state, count: nextCount };
    return nextCount;
  }
  toolValidationRepeatState = { toolName, sourceLayer, count: 1 };
  return 1;
}

function classifyCompactionError(errorMessage: string): string {
  if (errorMessage.includes('_autoCompactionAbortController')) return 'local-state';
  if (errorMessage.includes('Summarization failed:')) return 'upstream-stream';
  if (errorMessage.includes('stream ID') || errorMessage.includes('INTERNAL_ERROR')) return 'upstream-stream';
  if (errorMessage.includes('Failed to parse') || errorMessage.includes('JSON')) return 'downstream-parse';
  return 'unknown';
}

function classifyToolValidationFailure(errorMessage: string): string {
  if (errorMessage.includes('must have required property')) return 'missing-required-args';
  if (errorMessage.includes('must NOT have additional properties')) return 'unexpected-arguments';
  if (errorMessage.includes('must be object')) return 'invalid-arg-shape';
  return 'tool-validation';
}

function formatFailureContext(base: Record<string, string | number | undefined>, extraDebug?: Record<string, string | number | undefined>): string {
  const fields: Array<[string, string | number | undefined]> = [
    ['sessionId', initConfig?.sessionId],
    ['requestId', currentPromptRequestId ?? activeToolContext?.requestId],
    ['toolCallId', activeToolContext?.toolCallId],
    ['toolName', activeToolContext?.toolName],
    ['sourceLayer', activeToolContext?.sourceLayer],
    ['stage', activeToolContext?.stage],
    ['validationCount', activeToolContext?.validationCount],
    ['schemaSummary', activeToolContext?.schemaSummary],
    ...Object.entries(base),
  ];
  if (process.env.CRAFT_DEBUG === '1') {
    fields.push(['promptSnippet', getPromptSnippet()]);
    for (const [key, value] of Object.entries(extraDebug ?? {})) {
      fields.push([key, value]);
    }
    if (activeToolContext?.args) {
      fields.push(['arguments', JSON.stringify(activeToolContext.args)]);
    }
    if (activeToolContext?.rawArgs) {
      fields.push(['rawArguments', JSON.stringify(activeToolContext.rawArgs)]);
    }
    if (activeToolContext?.normalizedArgs) {
      fields.push(['normalizedArguments', JSON.stringify(activeToolContext.normalizedArgs)]);
    }
  }
  return fields
    .filter(([, value]) => value !== undefined && value !== '')
    .map(([key, value]) => `${key}=${JSON.stringify(String(value))}`)
    .join(' ');
}

function parsePositiveIntEnv(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) {
    debugLog(`[compaction-debug] ignoring invalid ${name}=${JSON.stringify(raw)} (expected positive integer)`);
    return undefined;
  }
  return value;
}

function parseUnitIntervalEnv(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value) || value <= 0 || value >= 1) {
    debugLog(`[compaction-debug] ignoring invalid ${name}=${JSON.stringify(raw)} (expected 0-1 exclusive)`);
    return undefined;
  }
  return value;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function calculateContextTokensFromUsage(usage: {
  totalTokens?: number;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
} | undefined): number | undefined {
  if (!usage) return undefined;
  return usage.totalTokens || (usage.input || 0) + (usage.output || 0) + (usage.cacheRead || 0) + (usage.cacheWrite || 0);
}

function estimateMessageTextChars(message: any): number {
  if (!message) return 0;
  if (typeof message.content === 'string') return message.content.length;
  if (!Array.isArray(message.content)) return 0;
  let chars = 0;
  for (const block of message.content) {
    if (block?.type === 'text' && typeof block.text === 'string') chars += block.text.length;
    if (block?.type === 'thinking' && typeof block.thinking === 'string') chars += block.thinking.length;
    if (block?.type === 'toolCall') chars += JSON.stringify(block.arguments ?? '').length;
  }
  return chars;
}

function summarizeMessageWindow(messages: any[] | undefined): string {
  if (!Array.isArray(messages) || messages.length === 0) return 'messages=0';
  const assistantCount = messages.filter(message => message?.role === 'assistant').length;
  const userCount = messages.filter(message => message?.role === 'user').length;
  const toolResultCount = messages.filter(message => message?.role === 'toolResult').length;
  const approxChars = messages.reduce((sum, message) => sum + estimateMessageTextChars(message), 0);
  return `messages=${messages.length} users=${userCount} assistants=${assistantCount} toolResults=${toolResultCount} approxChars=${approxChars}`;
}

function describeModel(model: any): string {
  if (!model) return 'model=missing';
  return `provider=${model.provider ?? 'unknown'} model=${model.id ?? 'unknown'} contextWindow=${model.contextWindow ?? 0} reasoning=${model.reasoning ? 1 : 0}`;
}

function describeCompactionSettings(settings: any): string {
  if (!settings) return 'settings=missing';
  return `enabled=${settings.enabled ? 1 : 0} reserveTokens=${settings.reserveTokens ?? 'na'} keepRecentTokens=${settings.keepRecentTokens ?? 'na'}`;
}

function describeCompactionResult(result: any): string {
  if (!result) return 'result=missing';
  const summaryLength = typeof result.summary === 'string' ? result.summary.length : 0;
  const readFiles = Array.isArray(result.details?.readFiles) ? result.details.readFiles.length : 0;
  const modifiedFiles = Array.isArray(result.details?.modifiedFiles) ? result.details.modifiedFiles.length : 0;
  return `summaryLength=${summaryLength} firstKeptEntryId=${result.firstKeptEntryId ?? 'missing'} tokensBefore=${result.tokensBefore ?? 'na'} readFiles=${readFiles} modifiedFiles=${modifiedFiles}`;
}

function describeAbortController(value: unknown): string {
  if (!value || typeof value !== 'object') return 'missing';
  const signal = (value as { signal?: AbortSignal }).signal;
  if (!signal) return 'no-signal';
  return signal.aborted ? 'present:aborted' : 'present:active';
}

function patchSessionAutoCompaction(session: AgentSession): void {
  const sessionInternal = session as any;
  if (sessionInternal.__craftAutoCompactionPatched) {
    return;
  }

  const originalRunAutoCompaction = sessionInternal._runAutoCompaction;
  const originalCheckCompaction = sessionInternal._checkCompaction;
  if (typeof originalRunAutoCompaction !== 'function') {
    throw new Error(
      'Pi SDK internal API changed: _runAutoCompaction not found. ' +
      'Update auto-compaction patch for the new SDK version.',
    );
  }
  if (typeof originalCheckCompaction !== 'function') {
    throw new Error(
      'Pi SDK internal API changed: _checkCompaction not found. ' +
      'Update auto-compaction patch for the new SDK version.',
    );
  }

  const debugContextWindow = parsePositiveIntEnv('CRAFT_DEBUG_COMPACTION_CONTEXT_WINDOW');
  const debugThreshold = parseUnitIntervalEnv('CRAFT_DEBUG_COMPACTION_THRESHOLD');
  const forceCompactEveryTurns = parsePositiveIntEnv('CRAFT_DEBUG_FORCE_COMPACT_EVERY_TURNS');
  const compactionDelayMs = parsePositiveIntEnv('CRAFT_DEBUG_COMPACTION_DELAY_MS');

  sessionInternal.__craftAutoCompactionPatched = true;
  sessionInternal.__craftAutoCompactionSequence = Promise.resolve();
  sessionInternal.__craftAutoCompactionRunId = 0;
  sessionInternal.__craftAssistantTurnCount = 0;
  sessionInternal.__craftActiveCompactionRun = null;
  sessionInternal.__craftCompactionDebugConfig = {
    debugContextWindow,
    debugThreshold,
    forceCompactEveryTurns,
    compactionDelayMs,
  };

  sessionInternal._runAutoCompaction = async function patchedRunAutoCompaction(this: any, reason: string, willRetry: boolean) {
    const runId = ++this.__craftAutoCompactionRunId;
    const execute = async () => {
      const delayMs = this.__craftCompactionDebugConfig?.compactionDelayMs;
      const startedAt = Date.now();
      this.__craftActiveCompactionRun = { runId, reason, willRetry, startedAt };
      logCompactionDebug(
        `start run=${runId} reason=${reason} willRetry=${willRetry ? 1 : 0} ` +
        `isCompacting=${this.isCompacting ? 1 : 0} autoController=${describeAbortController(this._autoCompactionAbortController)} ` +
        `manualController=${describeAbortController(this._compactionAbortController)} delayMs=${delayMs ?? 0}`,
      );

      if (compactionSummaryIoEnabled()) {
        const settings = this.settingsManager?.getCompactionSettings?.();
        const branchEntries = this.sessionManager?.getBranch?.() ?? [];
        const stateMessages = this.agent?.state?.messages ?? [];
        const trailingCompactionEntry = branchEntries.length > 0 && branchEntries[branchEntries.length - 1]?.type === 'compaction';
        logCompactionSummaryIo(
          `preflight run=${runId} reason=${reason} willRetry=${willRetry ? 1 : 0} ` +
          `${describeModel(this.model)} ${describeCompactionSettings(settings)} ` +
          `branchEntries=${branchEntries.length} trailingCompactionEntry=${trailingCompactionEntry ? 1 : 0} ` +
          `${summarizeMessageWindow(stateMessages)}`,
        );
        try {
          const authResult = this.model ? await this._modelRegistry?.getApiKeyAndHeaders?.(this.model) : undefined;
          logCompactionSummaryIo(
            `auth run=${runId} modelPresent=${this.model ? 1 : 0} ok=${authResult?.ok ? 1 : 0} ` +
            `hasApiKey=${authResult?.apiKey ? 1 : 0} headerCount=${authResult?.headers ? Object.keys(authResult.headers).length : 0}`,
          );
        } catch (error) {
          const errorMessage = error instanceof Error ? error.stack || error.message : String(error);
          logCompactionSummaryIo(`auth-error run=${runId} error=${JSON.stringify(errorMessage)}`);
        }
      }

      try {
        if (delayMs) {
          logCompactionDebug(`delay-before-run run=${runId} delayMs=${delayMs}`);
          await delay(delayMs);
        }
        const result = await originalRunAutoCompaction.call(this, reason, willRetry);
        logCompactionDebug(
          `finish run=${runId} reason=${reason} autoController=${describeAbortController(this._autoCompactionAbortController)} ` +
          `manualController=${describeAbortController(this._compactionAbortController)}`,
        );
        if (compactionSummaryIoEnabled()) {
          logCompactionSummaryIo(`return run=${runId} reason=${reason} elapsedMs=${Date.now() - startedAt}`);
        }
        return result;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.stack || error.message : String(error);
        logCompactionDebug(
          `error run=${runId} reason=${reason} autoController=${describeAbortController(this._autoCompactionAbortController)} ` +
          `manualController=${describeAbortController(this._compactionAbortController)} error=${JSON.stringify(errorMessage)}`,
        );
        activeToolContext = {
          sourceLayer: 'auto-compaction',
        };
        const failureMessage = formatFailureContext(
          {
            category: 'auto-compaction',
            runId,
            reason,
            elapsedMs: Date.now() - startedAt,
            failureClass: classifyCompactionError(errorMessage),
            model: describeModel(this.model),
            settings: describeCompactionSettings(this.settingsManager?.getCompactionSettings?.()),
            error: errorMessage,
            autoController: describeAbortController(this._autoCompactionAbortController),
            manualController: describeAbortController(this._compactionAbortController),
          },
          {
            willRetry: willRetry ? 1 : 0,
            branchSummary: summarizeMessageWindow(this.agent?.state?.messages ?? []),
            activeRun: JSON.stringify(this.__craftActiveCompactionRun ?? null),
          },
        );
        if (compactionSummaryIoEnabled()) {
          logCompactionSummaryIo(failureMessage);
        } else {
          logCompactionFailure(failureMessage);
        }
        throw error;
      } finally {
        if (this.__craftActiveCompactionRun?.runId === runId) {
          this.__craftActiveCompactionRun = null;
        }
      }
    };

    const sequence = Promise.resolve(this.__craftAutoCompactionSequence)
      .catch(() => undefined)
      .then(execute);

    this.__craftAutoCompactionSequence = sequence.catch(() => undefined);
    return sequence;
  };

  const originalEmit = sessionInternal._emit;
  if (typeof originalEmit === 'function') {
    sessionInternal._emit = function patchedEmit(this: any, event: any) {
      if (compactionSummaryIoEnabled() && event?.type === 'compaction_start') {
        const activeRun = this.__craftActiveCompactionRun;
        logCompactionSummaryIo(
          `event-start run=${activeRun?.runId ?? 'na'} reason=${event.reason ?? activeRun?.reason ?? 'unknown'} ` +
          `autoController=${describeAbortController(this._autoCompactionAbortController)} ` +
          `manualController=${describeAbortController(this._compactionAbortController)}`,
        );
      }
      if (event?.type === 'compaction_end') {
        const activeRun = this.__craftActiveCompactionRun;
        const elapsedMs = activeRun?.startedAt ? Date.now() - activeRun.startedAt : 'na';
        activeToolContext = {
          sourceLayer: 'auto-compaction',
        };
        const message = formatFailureContext(
          {
            category: 'auto-compaction',
            runId: activeRun?.runId ?? 'na',
            reason: event.reason ?? activeRun?.reason ?? 'unknown',
            aborted: event.aborted ? 1 : 0,
            willRetry: event.willRetry ? 1 : 0,
            elapsedMs,
            model: describeModel(this.model),
            settings: describeCompactionSettings(this.settingsManager?.getCompactionSettings?.()),
            result: describeCompactionResult(event.result),
            error: event.errorMessage ?? '',
            autoController: describeAbortController(this._autoCompactionAbortController),
            manualController: describeAbortController(this._compactionAbortController),
          },
          {
            branchSummary: summarizeMessageWindow(this.agent?.state?.messages ?? []),
          },
        );
        if (event.errorMessage) {
          logCompactionFailure(message);
        } else if (compactionSummaryIoEnabled()) {
          logCompactionSummaryIo(message);
        }
      }
      return originalEmit.call(this, event);
    };
  }

  sessionInternal._checkCompaction = async function patchedCheckCompaction(this: any, assistantMessage: any, skipAbortedCheck = true) {
    const settings = this.settingsManager?.getCompactionSettings?.();
    if (!settings?.enabled) return;
    if (skipAbortedCheck && assistantMessage?.stopReason === 'aborted') return;

    const debugConfig = this.__craftCompactionDebugConfig ?? {};
    const sameModel = !!(this.model && assistantMessage?.provider === this.model.provider && assistantMessage?.model === this.model.id);
    const currentTurn = ++this.__craftAssistantTurnCount;

    const originalContextWindow = this.model?.contextWindow ?? 0;
    const effectiveContextWindow = debugConfig.debugContextWindow || originalContextWindow;
    const effectiveReserveTokens = debugConfig.debugThreshold && effectiveContextWindow > 0
      ? Math.max(1, Math.floor(effectiveContextWindow * (1 - debugConfig.debugThreshold)))
      : settings.reserveTokens;

    const entries = this.sessionManager?.getBranch?.() ?? [];
    const compactionEntry = (() => {
      for (let i = entries.length - 1; i >= 0; i--) {
        if (entries[i]?.type === 'compaction') return entries[i];
      }
      return null;
    })();

    const assistantIsFromBeforeCompaction = !!(
      compactionEntry &&
      assistantMessage?.timestamp <= new Date(compactionEntry.timestamp).getTime()
    );
    if (assistantIsFromBeforeCompaction) return;

    const forcedByTurn = !!(
      debugConfig.forceCompactEveryTurns &&
      currentTurn % debugConfig.forceCompactEveryTurns === 0
    );

    if (assistantMessage?.stopReason === 'error') {
      logCompactionDebug(
        `check turn=${currentTurn} stopReason=error sameModel=${sameModel ? 1 : 0} ` +
        `originalContextWindow=${originalContextWindow} effectiveContextWindow=${effectiveContextWindow} ` +
        `forceEveryTurns=${debugConfig.forceCompactEveryTurns ?? 0} forcedByTurn=${forcedByTurn ? 1 : 0} delegated=1`,
      );
      if (forcedByTurn) {
        await this._runAutoCompaction('threshold', false);
        return;
      }
      return originalCheckCompaction.call(this, assistantMessage, skipAbortedCheck);
    }

    const contextTokens = calculateContextTokensFromUsage(assistantMessage?.usage);
    const thresholdTriggered = typeof contextTokens === 'number' && effectiveContextWindow > 0
      ? contextTokens > effectiveContextWindow - effectiveReserveTokens
      : false;

    logCompactionDebug(
      `check turn=${currentTurn} stopReason=${assistantMessage?.stopReason ?? 'unknown'} sameModel=${sameModel ? 1 : 0} ` +
      `contextTokens=${contextTokens ?? 'na'} originalContextWindow=${originalContextWindow} effectiveContextWindow=${effectiveContextWindow} ` +
      `reserveTokens=${settings.reserveTokens} effectiveReserveTokens=${effectiveReserveTokens} ` +
      `forceEveryTurns=${debugConfig.forceCompactEveryTurns ?? 0} forcedByTurn=${forcedByTurn ? 1 : 0} ` +
      `threshold=${debugConfig.debugThreshold ?? 'default'} thresholdTriggered=${thresholdTriggered ? 1 : 0}`,
    );

    if (forcedByTurn || thresholdTriggered) {
      await this._runAutoCompaction('threshold', false);
      return;
    }

    return originalCheckCompaction.call(this, assistantMessage, skipAbortedCheck);
  };

  logCompactionDebug(
    `Installed Pi SDK auto-compaction patch contextWindow=${debugContextWindow ?? 'default'} ` +
    `threshold=${debugThreshold ?? 'default'} forceEveryTurns=${forceCompactEveryTurns ?? 0} delayMs=${compactionDelayMs ?? 0}`,
  );
  logCompactionSummaryIo(
    `Installed compaction summary diagnostics enabled=1 contextWindow=${debugContextWindow ?? 'default'} ` +
    `threshold=${debugThreshold ?? 'default'} forceEveryTurns=${forceCompactEveryTurns ?? 0} delayMs=${compactionDelayMs ?? 0}`,
  );
}

/** Find the most recent .jsonl session file in a directory. */
function findMostRecentSessionFile(sessionDir: string): string | null {
  if (!existsSync(sessionDir)) return null;
  let best: { path: string; mtime: number } | null = null;
  for (const entry of readdirSync(sessionDir)) {
    if (!entry.endsWith('.jsonl')) continue;
    const fullPath = join(sessionDir, entry);
    const mtime = statSync(fullPath).mtimeMs;
    if (!best || mtime > best.mtime) {
      best = { path: fullPath, mtime };
    }
  }
  return best?.path ?? null;
}

// ============================================================
// Callback Server (for call_llm from session MCP server)
// ============================================================

async function startCallbackServer(): Promise<void> {
  if (callbackServer) return;

  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/call-llm') {
      res.writeHead(404);
      res.end();
      return;
    }
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;

      debugLog('Received call_llm request via callback server');
      const result = await preExecuteCallLlm(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      debugLog(`call_llm via callback failed: ${msg}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: msg }));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      callbackPort = typeof addr === 'object' && addr ? addr.port : 0;
      debugLog(`Callback server listening on 127.0.0.1:${callbackPort}`);
      resolve();
    });
    server.on('error', reject);
  });

  callbackServer = server;
}

function stopCallbackServer(): void {
  if (callbackServer) {
    callbackServer.close();
    callbackServer = null;
    callbackPort = 0;
  }
}

// ============================================================
// Pi Session Management
// ============================================================

function resolvedCwd(): string {
  const wd = initConfig?.cwd || initConfig?.workingDirectory || process.cwd();
  if (wd.startsWith('~/')) return join(homedir(), wd.slice(2));
  if (wd === '~') return homedir();
  return wd;
}

// Helper: derive preferCustomEndpoint flag from init config
function shouldPreferCustomEndpoint(): boolean {
  return Boolean(initConfig?.customEndpoint && initConfig?.baseUrl?.trim());
}

/**
 * Expose the active Pi model API/provider/base URL to the interceptor process.
 * This gives the interceptor a robust routing hint (instead of brittle URL-only matching).
 */
function setInterceptorApiHints(model: { api?: string; provider?: string; baseUrl?: string } | undefined): void {
  if (!model) {
    delete process.env.CRAFT_PI_MODEL_API;
    delete process.env.CRAFT_PI_MODEL_PROVIDER;
    delete process.env.CRAFT_PI_MODEL_BASE_URL;
    return;
  }

  process.env.CRAFT_PI_MODEL_API = model.api || '';
  process.env.CRAFT_PI_MODEL_PROVIDER = model.provider || '';
  process.env.CRAFT_PI_MODEL_BASE_URL = model.baseUrl || '';

  debugLog(
    `[interceptor-hint] api=${process.env.CRAFT_PI_MODEL_API || '-'} provider=${process.env.CRAFT_PI_MODEL_PROVIDER || '-'} baseUrl=${process.env.CRAFT_PI_MODEL_BASE_URL || '-'}`,
  );
}

/**
 * Resolve the API key for custom endpoint auth.
 * Returns empty string for local endpoints (Ollama etc.) that don't need auth.
 */
function resolveCustomEndpointApiKey(): string {
  if (initConfig?.piAuth?.credential?.type === 'api_key') {
    return initConfig.piAuth.credential.key;
  }
  const key = initConfig?.apiKey || '';
  if (!key && initConfig?.baseUrl) {
    if (isLocalhostUrl(initConfig.baseUrl)) {
      // Local endpoints (Ollama, LM Studio) don't need auth.
      // Pi SDK requires a truthy apiKey to register models, so use a placeholder.
      return 'not-needed';
    }
    debugLog('[custom-endpoint] Warning: no API key found for non-localhost endpoint — requests will likely fail');
  }
  return key;
}

function isLocalhostUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname;
    const normalizedHostname = hostname.startsWith('[') && hostname.endsWith(']')
      ? hostname.slice(1, -1)
      : hostname;
    return normalizedHostname === 'localhost' || normalizedHostname === '127.0.0.1' || normalizedHostname === '::1';
  } catch {
    return false;
  }
}

/** Model IDs currently registered under the custom-endpoint provider */
let customEndpointModelIds: Set<string> = new Set();

/**
 * Register (or re-register) the custom-endpoint provider with the given models.
 * Note: registerProvider replaces the entire provider, so we maintain a Set of all
 * known model IDs and always pass the full set.
 */
const customModelOverrides = new Map<string, CustomEndpointModelOverrides>();

function registerCustomEndpointModels(
  registry: PiModelRegistry,
  api: CustomEndpointApi,
  baseUrl: string,
  models: CustomEndpointModelEntry[],
): void {
  for (const m of models) {
    customEndpointModelIds.add(m.id);
    if (m.contextWindow || m.supportsImages !== undefined) {
      customModelOverrides.set(m.id, {
        ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
        ...(m.supportsImages !== undefined ? { supportsImages: m.supportsImages } : {}),
      });
    }
  }
  const allIds = [...customEndpointModelIds];
  registry.registerProvider('custom-endpoint', {
    baseUrl,
    apiKey: resolveCustomEndpointApiKey(),
    api,
    authHeader: true,
    models: allIds.map(id => buildCustomEndpointModelDef(
      id,
      { supportsImages: initConfig?.customEndpoint?.supportsImages === true },
      customModelOverrides.get(id),
    )),
  });
  debugLog(`Registered custom endpoint: ${baseUrl} with ${allIds.length} model(s) [${allIds.join(', ')}], api: ${api}`);
}

/**
 * Create an in-memory auth storage pre-loaded with the user's credentials
 * and a model registry backed by it. Used by both the main session and
 * ephemeral queryLlm sessions.
 */
function createAuthenticatedRegistry(): {
  authStorage: PiAuthStorage;
  modelRegistry: PiModelRegistry;
} {
  // Reuse module-level authStorage if already created (allows token_update to mutate it).
  // Only create a new one on first call or after re-init.
  if (!moduleAuthStorage) {
    moduleAuthStorage = PiAuthStorage.inMemory();
  }
  const authStorage = moduleAuthStorage;
  if (initConfig?.piAuth) {
    const { provider, credential } = initConfig.piAuth;
    // Pi SDK 0.70.0's AuthCredential union (ApiKeyCredential | OAuthCredential) doesn't
    // include 'iam' as a first-class member, but the auth storage accepts it at runtime
    // — the Bedrock provider module reads AWS env directly; this `set` keeps Pi SDK's
    // internal provider-tracking consistent regardless of credential shape.
    authStorage.set(provider, credential as unknown as AuthCredential);
    debugLog(`Injected ${credential.type} credential for provider: ${provider}`);
  } else if (initConfig?.apiKey) {
    authStorage.set('anthropic', { type: 'api_key', key: initConfig.apiKey });
    debugLog('Injected API key into auth storage (legacy fallback)');
  }

  const modelRegistry = PiModelRegistry.inMemory(authStorage);

  // Register custom endpoint models dynamically via Pi SDK's registerProvider API.
  // This makes arbitrary OpenAI/Anthropic-compatible endpoints work through the Pi SDK
  // by creating synthetic Model<Api> objects that the SDK requires.
  const hasCustomEndpoint = !!initConfig?.baseUrl?.trim();
  if (hasCustomEndpoint && initConfig?.customEndpoint) {
    const { api } = initConfig.customEndpoint;
    const modelEntries: CustomEndpointModelEntry[] = (initConfig.customModels?.length
      ? initConfig.customModels
      : [initConfig.model || 'default']
    ).map(normalizeCustomEndpointModelEntry);
    customEndpointModelIds = new Set();  // Reset on fresh registry creation
    registerCustomEndpointModels(modelRegistry, api, initConfig.baseUrl!.trim(), modelEntries);
  } else if (hasCustomEndpoint && !initConfig?.customEndpoint) {
    debugLog('Custom endpoint without protocol config — models may not resolve. Set customEndpoint.api for proper routing.');
  }

  return { authStorage, modelRegistry };
}

async function ensureSession(): Promise<AgentSession> {
  if (piSession) return piSession;
  if (!initConfig) throw new Error('Cannot create session: init not received');

  const cwd = resolvedCwd();

  const { authStorage, modelRegistry } = createAuthenticatedRegistry();
  // Store at module scope for set_model handler
  piModelRegistry = modelRegistry;

  // Build tools: coding tools + web tools wrapped with permission hooks + proxy tools.
  // Search provider is selected based on the user's LLM connection:
  //   - OpenAI/OpenRouter → Responses API built-in web_search
  //   - ChatGPT Plus (openai-codex) → ChatGPT backend responses endpoint
  //   - Google → Gemini API with googleSearch grounding
  //   - Others → DuckDuckGo fallback
  //
  // IMPORTANT: resolve dynamically on each search call so token_update refreshes
  // are used without recreating the session.
  const searchProvider = {
    get name() {
      return resolveSearchProvider(initConfig?.piAuth).name;
    },
    async search(query: string, count: number) {
      return resolveSearchProvider(initConfig?.piAuth).search(query, count);
    },
  };
  const searchTool = createSearchTool(searchProvider);
  const webFetchTool = createWebFetchTool(() =>
    initConfig ? getSessionPath(initConfig.workspaceRootPath, initConfig.sessionId) : null
  );
  const webTools = [searchTool, webFetchTool];

  // Pi SDK 0.70.0 registration contract:
  //   - `customTools` accepts ToolDefinition[] — our hook-wrapped objects go here
  //   - `tools` is a string[] name allowlist — MUST include every tool we want active,
  //     otherwise Pi SDK defaults to the built-in [read, bash, edit, write] set and
  //     silently filters out everything else. Custom tool names with matching built-in
  //     names override the SDK's raw implementation inside _refreshToolRegistry, so
  //     our hooked versions take effect (permissions + large-response summarization).
  //   - Do NOT pass tool *objects* to `tools` — `allowedToolNames = new Set(options.tools)`
  //     then `.has(name)` returns false for every string lookup → zero tools active.
  const builtinDefs = [
    createReadToolDefinition(cwd),
    createBashToolDefinition(cwd),
    createEditToolDefinition(cwd),
    createWriteToolDefinition(cwd),
    createGrepToolDefinition(cwd),
    createFindToolDefinition(cwd),
    createLsToolDefinition(cwd),
  ];
  const proxyTools = buildProxyTools();
  const wrappedAll = wrapToolsWithHooks([...builtinDefs, ...webTools, ...proxyTools]);
  const toolAllowlist = wrappedAll.map(t => t.name);
  debugLog(`Session tools: ${builtinDefs.length} builtin + ${webTools.length} web + ${proxyTools.length} proxy = ${wrappedAll.length} total`);

  // Build session options
  const sessionOptions: CreateAgentSessionOptions = {
    cwd,
    authStorage,
    modelRegistry,
    customTools: wrappedAll,
    tools: toolAllowlist,
  };

  // Extension isolation: set agentDir to a temp directory under session path
  // to prevent loading global Pi extensions from ~/.pi/agent
  if (initConfig.sessionPath) {
    const agentDir = initConfig.agentDir || join(initConfig.sessionPath, '.pi-agent');
    mkdirSync(agentDir, { recursive: true });
    sessionOptions.agentDir = agentDir;

    // Session resume: use a per-Craft-session directory so the Pi SDK can
    // persist and resume its own session across subprocess restarts.
    // continueRecent() loads the existing session if one exists, otherwise
    // creates a new one — so this handles both first-run and resume.
    const sessionDir = join(initConfig.sessionPath, '.pi-sessions');
    mkdirSync(sessionDir, { recursive: true });

    if (initConfig.branchFromSessionPath) {
      // Branching: fork from the parent session's Pi session file.
      // Branches must not silently degrade to fresh sessions.
      const parentPiSessionDir = join(initConfig.branchFromSessionPath, '.pi-sessions');
      const parentPiSessionFile = findMostRecentSessionFile(parentPiSessionDir);
      if (!parentPiSessionFile) {
        throw new Error(`Pi branch preflight failed: no parent Pi session file found in ${parentPiSessionDir}`);
      }

      debugLog(`Forking Pi session from parent: ${parentPiSessionFile}`);
      const forkedSessionManager = PiSessionManager.forkFrom(parentPiSessionFile, cwd, sessionDir);

      // Strict branch cutoff: move leaf to the selected parent entry if provided.
      // This is Pi's equivalent of Claude resumeSessionAt.
      if (initConfig.branchFromSdkTurnId) {
        const anchorId = initConfig.branchFromSdkTurnId;
        const anchorEntry = forkedSessionManager.getEntry(anchorId);
        if (!anchorEntry) {
          throw new Error(`Pi branch preflight failed: branch anchor not found: ${anchorId}`);
        }
        forkedSessionManager.branch(anchorId);
        debugLog(`Applied Pi branch cutoff at entry: ${anchorId}`);
      }

      sessionOptions.sessionManager = forkedSessionManager;
    } else {
      sessionOptions.sessionManager = PiSessionManager.continueRecent(cwd, sessionDir);
    }

  }

  // Set model if specified
  if (initConfig.model) {
    try {
      const piModel = resolvePiModel(modelRegistry, initConfig.model, initConfig.piAuth?.provider, shouldPreferCustomEndpoint());
      if (piModel) {
        // Verify resolved model's provider is compatible with the authenticated provider.
        // Without this, a model that resolves to a different provider (e.g. azure-openai-responses
        // when authed as github-copilot) would cause "No API key found" at runtime.
        const resolvedProvider = (piModel as any)?.provider;
        const isCompatible = !initConfig.piAuth ||
          resolvedProvider === initConfig.piAuth.provider ||
          resolvedProvider === 'custom-endpoint';
        if (isCompatible) {
          sessionOptions.model = piModel;
          setInterceptorApiHints(piModel as { api?: string; provider?: string; baseUrl?: string });
        } else {
          debugLog(`Model ${initConfig.model} resolved to incompatible provider ${resolvedProvider} (expected ${initConfig.piAuth!.provider}), skipping`);
          setInterceptorApiHints(undefined);
        }
      } else {
        setInterceptorApiHints(undefined);
      }
    } catch {
      debugLog(`Could not resolve Pi model: ${initConfig.model}`);
      setInterceptorApiHints(undefined);
    }
  } else {
    setInterceptorApiHints(undefined);
  }

  // Set thinking level
  const piThinkingLevel = THINKING_TO_PI[initConfig.thinkingLevel as keyof typeof THINKING_TO_PI];
  if (piThinkingLevel) {
    sessionOptions.thinkingLevel = piThinkingLevel;
  }

  // Create the session — tools flow through customTools + allowlist (see comment above).
  const { session } = await createAgentSession(sessionOptions);
  piSession = session;

  // Pi SDK's createAgentSession ignores custom AgentTool objects passed via
  // `tools` — it only accepts its own internal Tool type and creates instances
  // internally. Inject our wrapped tools (with permission hooks) and proxy
  // tools via _baseToolsOverride, then rebuild the runtime so the session
  // actually uses them.
  const sessionInternal = piSession as any;
  if (typeof sessionInternal._buildRuntime !== 'function') {
    throw new Error(
      'Pi SDK internal API changed: _buildRuntime not found. ' +
      'Update ensureSession() for the new SDK version.',
    );
  }

  patchSessionAutoCompaction(piSession);

  const baseToolsOverride: Record<string, ToolDefinition<any, any>> = {};
  for (const tool of wrappedAll) {
    baseToolsOverride[tool.name] = tool;
  }
  sessionInternal._baseToolsOverride = baseToolsOverride;
  sessionInternal._buildRuntime({
    activeToolNames: Object.keys(baseToolsOverride),
    includeAllExtensionTools: true,
  });


  toolsChanged = false;
  debugLog(`Created Pi session: ${session.sessionId} (${wrappedAll.length} tools)`);

  // Notify main process of session ID
  send({ type: 'session_id_update', sessionId: session.sessionId });

  return session;
}


// ============================================================
// Tool Wrapping (Permission Enforcement + Large Response Summarization)
// ============================================================

/**
 * Shared permission enforcement for both coding tools and proxy tools.
 * Checks mode-manager rules and, in Ask mode, prompts the user via the
 * pending-permissions handshake. Throws on deny or block.
 */
/**
 * Send pre_tool_use_request to main process and wait for response.
 * Returns the (potentially modified) input if approved, throws if blocked.
 * All permission checking, transforms, and source activation happen in the main process.
 */
async function requestPreToolUseApproval(
  sdkToolName: string,
  input: Record<string, unknown>,
  toolCallId?: string,
): Promise<Record<string, unknown>> {
  const requestId = `pi-ptu-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const normalizedInput = normalizeSessionToolMetadataArgs(input);
  activeToolContext = {
    ...(activeToolContext ?? {}),
    toolName: sdkToolName,
    toolCallId,
    requestId,
    sourceLayer: 'pre-tool-use',
    rawArgs: input,
    normalizedArgs: normalizedInput,
    args: normalizedInput,
    stage: 'pre-tool-use-request',
  };

  if (process.env.CRAFT_DEBUG_TOOL_TITLES === '1') {
    debugLog(`[tool-title-debug][subprocess] pre_tool_use_request ${sdkToolName} (${toolCallId ?? 'no-call-id'}) keys=${Object.keys(normalizedInput).sort().join(',') || '∅'} hasDisplayName=${typeof normalizedInput._displayName === 'string' ? 1 : 0} hasIntent=${typeof normalizedInput._intent === 'string' ? 1 : 0}`);
  }
  if (process.env.CRAFT_DEBUG_TOOL_ARGS === '1') {
    debugLog(`[tool-args-debug][subprocess] pre_tool_use_request tool=${sdkToolName} requestId=${requestId} toolCallId=${toolCallId ?? '∅'} keys=${Object.keys(normalizedInput).sort().join(',') || '∅'} payload=${JSON.stringify(normalizedInput)}`);
  }
  if (process.env.CRAFT_DEBUG_SUBMIT_PLAN === '1' && (sdkToolName === 'mcp__session__SubmitPlan' || sdkToolName === 'SubmitPlan')) {
    debugLog(`[submit-plan-debug][subprocess] pre_tool_use_request tool=${sdkToolName} toolCallId=${toolCallId ?? 'no-call-id'} keys=${Object.keys(normalizedInput).sort().join(',') || '∅'} hasDisplayName=${typeof normalizedInput._displayName === 'string' ? 1 : 0} hasIntent=${typeof normalizedInput._intent === 'string' ? 1 : 0} payload=${JSON.stringify(normalizedInput)}`);
  }

  send({
    type: 'pre_tool_use_request',
    requestId,
    toolName: sdkToolName,
    ...(toolCallId ? { toolCallId } : {}),
    input: normalizedInput,
  });

  const response = await new Promise<{ action: string; input?: Record<string, unknown>; reason?: string }>((resolve) => {
    pendingPreToolUse.set(requestId, { resolve });
  });

  if (process.env.CRAFT_DEBUG_SUBMIT_PLAN === '1' && (sdkToolName === 'mcp__session__SubmitPlan' || sdkToolName === 'SubmitPlan')) {
    const responsePayload = response.action === 'modify' && response.input ? normalizeSessionToolMetadataArgs(response.input) : normalizedInput;
    debugLog(`[submit-plan-debug][subprocess] pre_tool_use_response tool=${sdkToolName} action=${response.action} keys=${Object.keys(responsePayload).sort().join(',') || '∅'} hasDisplayName=${typeof responsePayload._displayName === 'string' ? 1 : 0} hasIntent=${typeof responsePayload._intent === 'string' ? 1 : 0} payload=${JSON.stringify(responsePayload)}`);
  }

  if (process.env.CRAFT_DEBUG_TOOL_ARGS === '1') {
    const responsePayload = response.action === 'modify' && response.input ? normalizeSessionToolMetadataArgs(response.input) : normalizedInput;
    debugLog(`[tool-args-debug][subprocess] pre_tool_use_response tool=${sdkToolName} requestId=${requestId} action=${response.action} keys=${Object.keys(responsePayload).sort().join(',') || '∅'} payload=${JSON.stringify(responsePayload)} reason=${JSON.stringify(response.reason ?? null)}`);
  }

  if (response.action === 'block') {
    throw new Error(response.reason || `Tool "${sdkToolName}" is not allowed`);
  }

  return response.action === 'modify' && response.input ? normalizeSessionToolMetadataArgs(response.input) : normalizedInput;
}

function wrapToolsWithHooks(tools: ToolDefinition<any, any>[]): ToolDefinition<any, any>[] {
  return tools.map(tool => wrapSingleTool(tool));
}

function makeErrorResult(message: string): AgentToolResult<any> {
  return {
    content: [{ type: 'text', text: message }],
    details: { isError: true },
  };
}

function wrapSingleTool(tool: ToolDefinition<any, any>): ToolDefinition<any, any> {
  const originalExecute = tool.execute;
  const parameters = allowCraftMetadataProperties(tool.parameters);

  const wrappedExecute: ToolDefinition<any, any>['execute'] = async (
    toolCallId,
    params,
    signal,
    onUpdate,
    ctx,
  ) => {
    const sdkToolName = PI_TOOL_NAME_MAP[tool.name] || tool.name;
    const isDebugNativeTool = process.env.CRAFT_DEBUG_TOOL_ARGS === '1' && (sdkToolName === 'Read' || sdkToolName === 'Bash');
    let inputObj: Record<string, unknown> = { ...(params as Record<string, unknown>) };

    if (isDebugNativeTool) {
      debugLog(`[tool-args-debug][subprocess] native_execute_start tool=${sdkToolName} toolCallId=${toolCallId} rawKeys=${Object.keys(params ?? {}).sort().join(',') || '∅'} rawPayload=${JSON.stringify(params ?? {})}`);
    }

    // Extract intent before main process strips metadata (used for summarization)
    const intent = typeof inputObj._intent === 'string' ? inputObj._intent : undefined;

    // Normalize Pi SDK parameter names: path → file_path
    if ((sdkToolName === 'Write' || sdkToolName === 'Edit' || sdkToolName === 'MultiEdit' || sdkToolName === 'NotebookEdit')
        && typeof inputObj.path === 'string' && !inputObj.file_path) {
      inputObj = { ...inputObj, file_path: inputObj.path };
    }

    if (isDebugNativeTool) {
      debugLog(`[tool-args-debug][subprocess] native_execute_pre_ptu tool=${sdkToolName} toolCallId=${toolCallId} keys=${Object.keys(inputObj).sort().join(',') || '∅'} payload=${JSON.stringify(inputObj)}`);
    }

    const validation = validateNativeToolInput(sdkToolName, inputObj);
    if (!validation.ok) {
      debugLog(`[tool-args-debug][subprocess] native_execute_invalid_input tool=${sdkToolName} toolCallId=${toolCallId} missing=${validation.missing} keys=${Object.keys(inputObj).sort().join(',') || '∅'} payload=${JSON.stringify(inputObj)}`);
      const rawFailureClass = classifyToolValidationFailure(validation.message);
      const validationCount = updateToolValidationRepeatState(sdkToolName, 'native-validation');
      activeToolContext = {
        toolName: sdkToolName,
        toolCallId,
        requestId: currentPromptRequestId ?? activeToolContext?.requestId,
        sourceLayer: 'native-validation',
        args: inputObj,
        rawArgs: params as Record<string, unknown>,
        normalizedArgs: inputObj,
        schemaSummary: summarizeToolSchema(tool.parameters as Record<string, unknown> | undefined),
        validationCount,
        stage: 'native-execute-pre-ptu',
      };
      logToolValidationFailure(formatFailureContext({
        category: 'tool-validation',
        toolName: sdkToolName,
        missing: validation.missing,
        message: validation.message,
        sourceLayer: 'native-validation',
        failureClass: rawFailureClass,
      }));
      return {
        content: [{ type: 'text', text: validation.message }],
        details: { isError: true },
      };
    }

    // Send to main process for permission checking + transforms
    inputObj = await requestPreToolUseApproval(sdkToolName, inputObj, toolCallId);

    if (isDebugNativeTool) {
      debugLog(`[tool-args-debug][subprocess] native_execute_post_ptu tool=${sdkToolName} toolCallId=${toolCallId} keys=${Object.keys(inputObj).sort().join(',') || '∅'} payload=${JSON.stringify(inputObj)}`);
    }

    // Metadata is for Craft UI only. Keep a final defensive strip here so the
    // upstream Pi tool implementation always receives clean executable args,
    // even if a future pre-tool-use path returns `allow` without modification.
    inputObj = stripCraftMetadata(inputObj);

    // Execute original tool with (potentially modified) input
    const result = await originalExecute(toolCallId, inputObj, signal, onUpdate, ctx);

    // --- Post-execute: large response summarization ---

    if (isDebugNativeTool) {
      debugLog(`[tool-args-debug][subprocess] native_execute_result tool=${sdkToolName} toolCallId=${toolCallId} isError=${result.details?.isError ? 1 : 0} contentTypes=${result.content.map(c => c.type).join(',') || '∅'}`);
    }

    const resultText = result.content
      .filter((c): c is PiTextContent => c.type === 'text')
      .map(c => c.text)
      .join('');

    if (estimateTokens(resultText) > TOKEN_LIMIT && initConfig) {
      try {
        const sessionPath = getSessionPath(
          initConfig.workspaceRootPath,
          initConfig.sessionId,
        );

        const largeResult = await handleLargeResponse({
          text: resultText,
          sessionPath,
          context: {
            toolName: sdkToolName,
            input: inputObj,
            intent,
            userRequest: currentUserMessage,
          },
          summarize: runMiniCompletion,
        });

        if (largeResult) {
          return {
            content: [{ type: 'text', text: largeResult.message }],
            details: result.details,
          };
        }
      } catch (error) {
        debugLog(
          `Large response handling failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return result;
  };

  return {
    ...tool,
    parameters,
    execute: wrappedExecute,
  };
}

// ============================================================
// Proxy Tools (tools executed in main process)
// ============================================================

function buildProxyTools(): ToolDefinition<any, any>[] {
  debugLog(`Building proxy tools from ${proxyToolDefs.length} definitions: ${proxyToolDefs.map(t => t.name).join(', ')}`);

  return proxyToolDefs.map<ToolDefinition<any, any>>(def => {
    const label = def.name
      .replace(/^mcp__.*?__/, '')
      .replace(/_/g, ' ')
      .replace(/([a-z])([A-Z])/g, '$1 $2');

    return {
    name: def.name,
    label,
    description: def.description,
    // Pi SDK omits tools without promptSnippet from the system prompt's
    // "Available tools" section, making them invisible to the LLM.
    // Derive a snippet from the description so proxy tools are listed.
    promptSnippet: def.description.length > 200
      ? def.description.slice(0, 197) + '...'
      : def.description,
    parameters: def.inputSchema,
    execute: async (
      toolCallId: string,
      params: any,
    ): Promise<AgentToolResult<any>> => {
      // Check speculative prefetch cache first (parallel call_llm optimization).
      // If this tool was prefetched on message_end, the request is already in-flight —
      // just await the result instead of sending a duplicate request.
      const prefetched = prefetchCache.get(toolCallId);
      if (prefetched) {
        prefetchCache.delete(toolCallId);
        debugLog(`Prefetch cache hit for ${def.name} (toolCallId: ${toolCallId})`);
        const result = await prefetched;
        return {
          content: [{ type: 'text', text: result.content }],
          details: result.isError ? { isError: true } : undefined,
        };
      }

      const inputObj = { ...(params as Record<string, unknown>) };
      activeToolContext = {
        toolName: def.name,
        toolCallId,
        sourceLayer: 'proxy-tool-request',
        rawArgs: params as Record<string, unknown>,
        normalizedArgs: inputObj,
        args: inputObj,
        schemaSummary: summarizeToolSchema(def.inputSchema as Record<string, unknown> | undefined),
        stage: 'proxy-tool-pre-ptu',
      };

      // Permission checking via main process
      const approvedInput = await requestPreToolUseApproval(def.name, inputObj, toolCallId);

      // Execute via main process
      const requestId = `proxy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      if (process.env.CRAFT_DEBUG_SUBMIT_PLAN === '1' && (def.name === 'mcp__session__SubmitPlan' || def.name === 'SubmitPlan')) {
        debugLog(`[submit-plan-debug][subprocess] tool_execute_request tool=${def.name} requestId=${requestId} keys=${Object.keys(approvedInput).sort().join(',') || '∅'} hasDisplayName=${typeof approvedInput._displayName === 'string' ? 1 : 0} hasIntent=${typeof approvedInput._intent === 'string' ? 1 : 0} payload=${JSON.stringify(approvedInput)}`);
      }
      if (process.env.CRAFT_DEBUG_TOOL_ARGS === '1') {
        debugLog(`[tool-args-debug][subprocess] tool_execute_request tool=${def.name} requestId=${requestId} keys=${Object.keys(approvedInput).sort().join(',') || '∅'} payload=${JSON.stringify(approvedInput)}`);
      }

      activeToolContext = {
        ...(activeToolContext ?? {}),
        requestId,
        args: approvedInput,
        normalizedArgs: approvedInput,
        stage: 'proxy-tool-execute-request',
      };

      send({
        type: 'tool_execute_request',
        requestId,
        toolName: def.name,
        args: approvedInput,
      });

      const result = await new Promise<{ content: string; isError: boolean }>((resolve) => {
        pendingToolExecutions.set(requestId, { resolve, toolName: def.name, args: approvedInput });
      });

      return {
        content: [{ type: 'text', text: result.content }],
        details: result.isError ? { isError: true } : undefined,
      };
    },
  };
  });
}

// ============================================================
// LLM Query (ephemeral session for call_llm + mini completions)
// ============================================================

async function queryLlm(request: LLMQueryRequest): Promise<LLMQueryResult> {
  if (!initConfig) throw new Error('Cannot run queryLlm: init not received');

  debugLog('[queryLlm] Starting');

  // Pick mini model. If the configured miniModel uses a different provider than
  // what the user authenticated with (e.g. gemini-2.5-pro when only anthropic
  // credentials exist), fall back to the default summarization model which uses
  // the same provider family.
  let model = request.model ?? initConfig.miniModel ?? getDefaultSummarizationModel();

  // Create authenticated registry upfront — used by both the provider guard and the ephemeral session.
  const { authStorage, modelRegistry } = createAuthenticatedRegistry();

  const piAuthProvider = initConfig.piAuth?.provider;

  // If piAuth is set, ensure the mini model uses the same provider.
  // Pi SDK will fail with "No API key found" if the model requires a different provider.
  // Exception: 'custom-endpoint' provider is always compatible because it has its own
  // API key configured via resolveCustomEndpointApiKey() and doesn't use authStorage.
  if (initConfig.piAuth) {
    const authProvider = initConfig.piAuth.provider;
    const bareModel = model.startsWith('pi/') ? model.slice(3) : model;
    const resolved = resolvePiModel(modelRegistry, bareModel, authProvider, shouldPreferCustomEndpoint());
    const resolvedProvider = (resolved as any)?.provider;
    const isCompatible = resolvedProvider === authProvider || resolvedProvider === 'custom-endpoint';
    if (!resolved || !isCompatible || isDeniedMiniModelId(model, piAuthProvider)) {
      // Anthropic: keep Haiku (the cheap/fast mini). For every other provider
      // Haiku is unresolvable, so walk PI_PREFERRED_DEFAULTS for a model that
      // actually works under the user's auth.
      const providerDefault = authProvider === 'anthropic'
        ? undefined
        : pickProviderAppropriateMiniModel(authProvider, modelRegistry, shouldPreferCustomEndpoint());
      const fallback = providerDefault ?? getDefaultSummarizationModel();
      debugLog(`[queryLlm] Model ${bareModel} incompatible with ${authProvider} (resolved: ${resolvedProvider}), falling back to ${fallback}`);
      model = fallback;
    }
  }

  const runQueryWithModel = async (modelId: string): Promise<string> => {
    debugLog(`[queryLlm] Using model: ${modelId}`);

    // Resolve model — fail fast if unresolvable so we don't let the Pi SDK
    // fall back to its own internal default (which may require a provider
    // the user hasn't authenticated with, surfacing as a misleading
    // "No API key found for <provider>" error).
    const piModel = resolvePiModel(modelRegistry, modelId, initConfig!.piAuth?.provider, shouldPreferCustomEndpoint());
    if (!piModel) {
      throw new Error(
        `Could not resolve mini model "${modelId}" for provider "${initConfig!.piAuth?.provider ?? '(unknown)'}"`,
      );
    }

    // Create minimal ephemeral session
    const ephemeralOptions: CreateAgentSessionOptions = {
      cwd: resolvedCwd(),
      authStorage,
      modelRegistry,
      tools: [],
      sessionManager: PiSessionManager.inMemory(),
      model: piModel,
    };

    const { session: ephemeralSession } = await createAgentSession(ephemeralOptions);

    // Pi SDK ignores options.model for ephemeral sessions (same issue as options.tools).
    // Explicitly set the model after creation to ensure the mini model is used.
    try {
      await ephemeralSession.setModel(piModel);
    } catch {
      debugLog(`[queryLlm] Failed to set model on ephemeral session, proceeding with default`);
    }

    debugLog(`[queryLlm] Created ephemeral session: ${ephemeralSession.sessionId}`);

    // Set system prompt
    if (request.systemPrompt) {
      ephemeralSession.agent.state.systemPrompt = request.systemPrompt;
    } else {
      ephemeralSession.agent.state.systemPrompt = 'Reply with ONLY the requested text. No explanation.';
    }

    // Collect response text and errors from events
    let result = '';
    let lastError = '';
    let completionResolve: () => void;
    const completionPromise = new Promise<void>((resolve) => {
      completionResolve = resolve;
    });

    const unsub = ephemeralSession.subscribe((event: AgentSessionEvent) => {
      if (event.type === 'message_end') {
        // Only capture assistant messages — Pi SDK emits message_end for user messages too
        const msg = event.message as {
          role?: string;
          content?: string | Array<{ type: string; text?: string }>;
          stopReason?: string;
          errorMessage?: string;
        };
        if (msg.role !== 'assistant') return;

        // Capture API errors from message_end (e.g. auth failures, model errors)
        if (msg.stopReason === 'error' && msg.errorMessage) {
          lastError = msg.errorMessage;
          debugLog(`[queryLlm] API error in message_end: ${msg.errorMessage}`);
        }

        if (typeof msg.content === 'string') {
          result = msg.content;
        } else if (Array.isArray(msg.content)) {
          result = msg.content
            .filter((c) => c.type === 'text' && c.text)
            .map((c) => c.text!)
            .join('');
        }
      }
      if (event.type === 'agent_end') {
        completionResolve();
      }
    });

    try {
      await ephemeralSession.prompt(request.prompt);
      await withTimeout(
        completionPromise,
        LLM_QUERY_TIMEOUT_MS,
        `queryLlm timed out after ${LLM_QUERY_TIMEOUT_MS / 1000}s`
      );
      debugLog(`[queryLlm] Result length: ${result.trim().length}`);

      // If we got no text but captured an error, throw so callers see the real issue
      if (!result.trim() && lastError) {
        throw new Error(lastError);
      }

      return result.trim();
    } finally {
      unsub();
      ephemeralSession.dispose();
    }
  };

  const fallbackCandidates = [
    // Removed 'pi/gpt-5.1-codex-mini' (#596) — stale on several OpenAI catalogs.
    // The connection-configured miniModel is still tried via `initConfig.miniModel`.
    'pi/gpt-5-mini',
    initConfig.miniModel,
    getDefaultSummarizationModel(),
  ].filter((candidate): candidate is string => !!candidate && !isDeniedMiniModelId(candidate, piAuthProvider));

  const triedModels = new Set<string>();
  let currentModel = model;

  while (true) {
    triedModels.add(currentModel);
    try {
      const text = await runQueryWithModel(currentModel);
      return { text, model: currentModel };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      const shouldRetry = isModelNotFoundError(errorMsg);

      if (!shouldRetry) {
        throw error;
      }

      const retryModel = fallbackCandidates.find(candidate => {
        if (triedModels.has(candidate)) return false;
        try {
          const resolved = resolvePiModel(modelRegistry, candidate, initConfig!.piAuth?.provider, shouldPreferCustomEndpoint());
          if (!resolved) return false;
          if (initConfig!.piAuth) {
            const rp = (resolved as any).provider;
            if (rp !== initConfig!.piAuth.provider && rp !== 'custom-endpoint') {
              return false;
            }
          }
          return true;
        } catch {
          return false;
        }
      });

      if (!retryModel) {
        throw error;
      }

      debugLog(`[queryLlm] Model ${currentModel} not found, retrying with ${retryModel}`);
      currentModel = retryModel;
    }
  }
}

async function preExecuteCallLlm(input: Record<string, unknown>): Promise<LLMQueryResult> {
  const sessionPath = initConfig
    ? getSessionPath(initConfig.workspaceRootPath, initConfig.sessionId)
    : undefined;
  const request = await buildCallLlmRequest(input, { backendName: 'Pi', sessionPath });
  return queryLlm(request);
}

async function runMiniCompletion(
  prompt: string,
  options?: { systemPrompt?: string; maxTokens?: number; temperature?: number }
): Promise<string | null> {
  try {
    const result = await queryLlm({
      prompt,
      systemPrompt: options?.systemPrompt,
      maxTokens: options?.maxTokens,
      temperature: options?.temperature,
    });
    const text = result.text || null;
    debugLog(`[runMiniCompletion] Result: ${text ? `"${text.slice(0, 200)}"` : 'null'}`);
    return text;
  } catch (error) {
    debugLog(`[runMiniCompletion] Failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

// ============================================================
// Event Handling
// ============================================================

function extractToolExecutionMetadata(args: Record<string, unknown> | undefined): ToolExecutionMetadata | undefined {
  if (!args) return undefined;

  const normalized = normalizeSessionToolMetadataArgs(args);
  const intent = typeof normalized._intent === 'string' ? normalized._intent : undefined;
  const displayName = typeof normalized._displayName === 'string' ? normalized._displayName : undefined;

  if (!intent && !displayName) return undefined;

  return {
    intent,
    displayName,
    source: 'interceptor',
  };
}

function normalizeDeepSeekUsage(event: AgentSessionEvent): AgentSessionEvent {
  if (event.type !== 'message_end') return event;
  const message = (event as any).message;
  const usage = message?.usage;
  if (!usage || typeof usage !== 'object') return event;

  const cacheHit = usage.prompt_cache_hit_tokens ?? usage.promptCacheHitTokens;
  const cacheMiss = usage.prompt_cache_miss_tokens ?? usage.promptCacheMissTokens;
  const promptTokens = usage.prompt_tokens ?? usage.promptTokens;
  const completionTokens = usage.completion_tokens ?? usage.completionTokens;

  if (typeof cacheHit !== 'number' && typeof cacheMiss !== 'number') {
    const mappedCacheRead = usage.cacheRead;
    const mappedInput = usage.input;
    const isDeepSeekMappedCache = (message?.provider === 'deepseek' || String(message?.model ?? '').includes('deepseek'))
      && typeof mappedCacheRead === 'number'
      && mappedCacheRead > 0
      && typeof mappedInput === 'number';

    if (!isDeepSeekMappedCache) {
      deepSeekCacheDebug('raw usage has no DeepSeek cache fields', {
        model: message?.model,
        provider: message?.provider,
        input: usage.input,
        output: usage.output,
        cacheRead: usage.cacheRead,
        cacheWrite: usage.cacheWrite,
        promptTokens,
        completionTokens,
      });
      return event;
    }

    deepSeekCacheDebug('normalized mapped cache usage', {
      model: message?.model,
      provider: message?.provider,
      mappedInput,
      mappedOutput: usage.output,
      mappedCacheRead,
      mappedCacheWrite: usage.cacheWrite,
      inferredCacheMiss: mappedInput,
      inferredPromptTokens: mappedInput + mappedCacheRead,
    });

    return {
      ...(event as Record<string, unknown>),
      message: {
        ...message,
        usage: {
          ...usage,
          input: mappedInput,
          cacheRead: mappedCacheRead,
          cacheWrite: usage.cacheWrite ?? 0,
          cacheMiss: mappedInput,
          promptTokens: mappedInput + mappedCacheRead,
        },
      },
    } as unknown as AgentSessionEvent;
  }

  const normalizedHit = typeof cacheHit === 'number' ? cacheHit : 0;
  const normalizedMiss = typeof cacheMiss === 'number'
    ? cacheMiss
    : (typeof promptTokens === 'number' ? Math.max(0, promptTokens - normalizedHit) : 0);

  deepSeekCacheDebug('normalized usage', {
    model: message?.model,
    provider: message?.provider,
    rawPromptCacheHitTokens: cacheHit,
    rawPromptCacheMissTokens: cacheMiss,
    rawPromptTokens: promptTokens,
    rawCompletionTokens: completionTokens,
    normalizedInput: normalizedMiss,
    normalizedOutput: typeof completionTokens === 'number' ? completionTokens : usage.output,
    normalizedCacheRead: normalizedHit,
    normalizedCacheMiss: normalizedMiss,
    normalizedPromptTokens: typeof promptTokens === 'number' ? promptTokens : normalizedHit + normalizedMiss,
  });

  return {
    ...(event as Record<string, unknown>),
    message: {
      ...message,
      usage: {
        ...usage,
        // PiEventAdapter computes inputTokens as input + cacheRead.
        // DeepSeek prompt_tokens already equals hit + miss, so set input to miss only.
        input: normalizedMiss,
        output: typeof completionTokens === 'number' ? completionTokens : usage.output,
        cacheRead: normalizedHit,
        cacheWrite: usage.cacheWrite ?? 0,
        cacheMiss: normalizedMiss,
        promptTokens: typeof promptTokens === 'number' ? promptTokens : normalizedHit + normalizedMiss,
      },
    },
  } as unknown as AgentSessionEvent;
}

function handleSessionEvent(event: AgentSessionEvent): void {
  let forwardedEvent: OutboundAgentEvent = normalizeDeepSeekUsage(event) as OutboundAgentEvent;

  // Log API errors for debugging and attach provider-native turn anchor for branch cutoffs.
  if (event.type === 'message_end') {
    const msg = event.message as { role?: string; stopReason?: string; errorMessage?: string } | undefined;
    if (msg?.stopReason === 'error') {
      debugLog(`API error in message_end: ${msg.errorMessage || 'unknown'}`);
    }

    if (msg?.role === 'assistant' && piSession) {
      const sdkTurnAnchor = piSession.sessionManager.getLeafId();
      if (sdkTurnAnchor) {
        // Enrichment: main process reads `sdkTurnAnchor` off the forwarded event to
        // set branch cutoff points. The SDK's event shape doesn't declare this field,
        // so the cast is intentional.
        forwardedEvent = {
          ...(forwardedEvent as Record<string, unknown>),
          sdkTurnAnchor,
        } as unknown as OutboundAgentEvent;
      }

      // Speculative prefetch: if the assistant message contains 2+ prefetchable tool calls,
      // fire all requests to the main process in parallel NOW, before executeToolCalls
      // iterates sequentially. Each proxy tool's execute() will hit the cache.
      const content = (msg as { content?: Array<{ type: string; id?: string; name?: string; arguments?: unknown }> }).content;
      if (Array.isArray(content)) {
        const prefetchableToolCalls = content.filter(
          (c) => c.type === 'toolCall' && c.name && isPrefetchableTool(c.name),
        );
        if (prefetchableToolCalls.length >= 2) {
          const firstPrefetchableToolCall = prefetchableToolCalls[0]!;
          debugLog(`Prefetching ${prefetchableToolCalls.length} parallel ${firstPrefetchableToolCall.name} calls`);
          for (const tc of prefetchableToolCalls) {
            const requestId = `prefetch-${tc.id}`;
            const promise = new Promise<{ content: string; isError: boolean }>((resolve) => {
              pendingToolExecutions.set(requestId, { resolve, toolName: tc.name, args: (tc.arguments ?? {}) as Record<string, unknown> });
            });
            send({
              type: 'tool_execute_request',
              requestId,
              toolName: tc.name!,
              args: (tc.arguments ?? {}) as Record<string, unknown>,
            });
            prefetchCache.set(tc.id!, promise);
          }
        }
      }
    }
  }

  // Detect session MCP tool completions + enrich tool starts with canonical metadata
  if (event.type === 'tool_execution_start') {
    const toolName = event.toolName;
    activeToolContext = {
      toolName,
      toolCallId: event.toolCallId,
      sourceLayer: activeToolContext?.sourceLayer,
      requestId: activeToolContext?.requestId,
      args: (event.args ?? {}) as Record<string, unknown>,
    };
    if (toolName.startsWith('session__') || toolName.startsWith('mcp__session__')) {
      const mcpToolName = toolName.replace(/^(mcp__session__|session__)/, '');
      pendingSessionToolCalls.set(event.toolCallId, {
        toolName: mcpToolName,
        arguments: (event.args ?? {}) as Record<string, unknown>,
      });
    }

    const toolMetadata = extractToolExecutionMetadata((event.args ?? {}) as Record<string, unknown>);
    if (toolMetadata) {
      forwardedEvent = {
        ...event,
        toolMetadata,
      };
    }
  }

  if (event.type === 'tool_execution_end') {
    const pending = pendingSessionToolCalls.get(event.toolCallId);
    if (pending) {
      pendingSessionToolCalls.delete(event.toolCallId);
      const content = Array.isArray(event.result?.content)
        ? event.result.content
            .filter((item: unknown): item is { type: string; text?: string } => !!item && typeof item === 'object')
            .filter((item: { type: string; text?: string }) => item.type === 'text' && typeof item.text === 'string')
            .map((item: { type: string; text?: string }) => item.text)
            .join('\n')
        : '';
      send({
        type: 'session_tool_completed',
        toolName: pending.toolName,
        args: pending.arguments,
        isError: !!event.isError,
        ...(content ? { content } : {}),
      });
    }
  }

  // Forward all events to main process
  send({ type: 'event', event: forwardedEvent });
}

// ============================================================
// Command Handlers
// ============================================================

async function handleInit(msg: Extract<InboundMessage, { type: 'init' }>): Promise<void> {
  // Clean up any existing session from a previous init
  if (piSession) {
    if (unsubscribeEvents) {
      unsubscribeEvents();
      unsubscribeEvents = null;
    }
    piSession.dispose();
    piSession = null;
    moduleAuthStorage = null; // Reset so createAuthenticatedRegistry() creates fresh storage
    debugLog('Cleaned up existing session for re-init');
  }

  initConfig = msg;

  // Azure OpenAI requires a tenant-specific endpoint URL.
  // The Pi SDK (via Vercel AI SDK) reads AZURE_OPENAI_BASE_URL from env.
  if (msg.piAuth?.provider === 'azure-openai-responses' && msg.baseUrl) {
    process.env.AZURE_OPENAI_BASE_URL = msg.baseUrl;
    debugLog(`Set AZURE_OPENAI_BASE_URL=${msg.baseUrl}`);
  }

  // Start callback server for call_llm (idempotent — skips if already running)
  await startCallbackServer();

  send({
    type: 'ready',
    sessionId: null,
    callbackPort,
  });
}

function isContextOverflowErrorMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes('context_length_exceeded') ||
    normalized.includes('exceeds the context window') ||
    normalized.includes('context window') && normalized.includes('exceed') ||
    normalized.includes('too many tokens') ||
    normalized.includes('token limit exceeded')
  );
}

/**
 * Wait for any in-flight compaction to finish before sending a prompt.
 * Prevents a race in the Pi SDK where concurrent _runAutoCompaction calls
 * crash on a shared AbortController (see craft-agents-oss#464).
 */
async function waitForCompaction(session: { isCompacting: boolean }, timeoutMs = 60_000): Promise<void> {
  if (!session.isCompacting) return;
  debugLog('Waiting for in-flight compaction to finish before prompt...');
  logCompactionDebug(`wait-start timeoutMs=${timeoutMs} isCompacting=${session.isCompacting ? 1 : 0}`);
  const start = Date.now();
  while (session.isCompacting) {
    if (Date.now() - start > timeoutMs) {
      debugLog('Compaction wait timed out after 60s, proceeding anyway');
      logCompactionDebug(`wait-timeout elapsedMs=${Date.now() - start}`);
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  if (Date.now() - start < timeoutMs) {
    debugLog('Compaction finished, proceeding with prompt');
    logCompactionDebug(`wait-finish elapsedMs=${Date.now() - start}`);
  }
}

async function handlePrompt(msg: Extract<InboundMessage, { type: 'prompt' }>): Promise<void> {
  currentUserMessage = msg.message;
  currentPromptRequestId = `prompt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  activeToolContext = null;

  try {
    // If proxy tools changed since last session creation, dispose and recreate.
    // This avoids calling _buildRuntime() for dynamic tool updates — instead
    // we create a fresh session via continueRecent() with all tools known upfront.
    if (toolsChanged && piSession) {
      debugLog('Recreating session due to tool changes');
      if (unsubscribeEvents) {
        unsubscribeEvents();
        unsubscribeEvents = null;
      }
      piSession.dispose();
      piSession = null;
    }

    const session = await ensureSession();

    // Set system prompt
    if (msg.systemPrompt) {
      session.agent.state.systemPrompt = msg.systemPrompt;
    }

    // Wire up event handler
    if (unsubscribeEvents) {
      unsubscribeEvents();
    }
    unsubscribeEvents = session.subscribe(handleSessionEvent);

    // Wait for any in-flight auto-compaction to avoid race (craft-agents-oss#464)
    await waitForCompaction(session);

    // Fire prompt — use followUp when session is already streaming so the
    // message is queued instead of throwing "Agent is already processing".
    await session.prompt(msg.message, {
      images: msg.images && msg.images.length > 0 ? msg.images : undefined,
      streamingBehavior: 'followUp',
    });
    currentPromptRequestId = null;
    activeToolContext = null;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);

    // Fallback hardening: if the provider surfaced a context-overflow error,
    // force a manual compact and retry this prompt once.
    if (isContextOverflowErrorMessage(errorMsg)) {
      debugLog(`Prompt overflow detected, attempting compact+retry: ${errorMsg}`);
      try {
        const session = await ensureSession();
        await session.compact();
        await waitForCompaction(session);
        await session.prompt(msg.message, {
          images: msg.images && msg.images.length > 0 ? msg.images : undefined,
          streamingBehavior: 'followUp',
        });
        debugLog('Compact+retry succeeded after overflow');
        currentPromptRequestId = null;
        activeToolContext = null;
        return;
      } catch (retryError) {
        const retryMsg = retryError instanceof Error ? retryError.message : String(retryError);
        debugLog(`Compact+retry failed: ${retryMsg}`);
        send({
          type: 'error',
          message: `Prompt overflow recovery failed: ${retryMsg}`,
          code: 'prompt_overflow_recovery_failed',
        });
        send({ type: 'event', event: { type: 'agent_end', messages: [] } });
        currentPromptRequestId = null;
        activeToolContext = null;
        return;
      }
    }

    debugLog(`Prompt failed: ${errorMsg}`);
    if (isToolValidationFailureMessage(errorMsg)) {
      const toolNameFromError = errorMsg.match(/Validation failed for tool "([^"]+)"/)?.[1];
      const previousToolContext = activeToolContext as ActiveToolContext | null;
      const previousToolName = previousToolContext?.toolName;
      const previousStage = previousToolContext?.stage;
      const validationCount = updateToolValidationRepeatState(toolNameFromError ?? previousToolName, 'sdk-ajv');
      activeToolContext = {
        ...(previousToolContext ?? {}),
        toolName: toolNameFromError ?? previousToolName,
        sourceLayer: 'sdk-ajv',
        validationCount,
        stage: previousStage ?? 'handle-prompt-catch',
      };
      logToolValidationFailure(formatFailureContext(
        {
          category: 'tool-validation',
          sourceLayer: 'sdk-ajv',
          failureClass: classifyToolValidationFailure(errorMsg),
          message: errorMsg,
        },
        {
          rawError: errorMsg,
        },
      ));
    }
    send({ type: 'error', message: errorMsg, code: 'prompt_error' });
    // Send synthetic agent_end so the main process event queue unblocks
    send({ type: 'event', event: { type: 'agent_end', messages: [] } });
    currentPromptRequestId = null;
    activeToolContext = null;
  }
}

function handleRegisterTools(msg: Extract<InboundMessage, { type: 'register_tools' }>): void {
  if (process.env.CRAFT_DEBUG_TOOL_TITLES === '1' || process.env.CRAFT_DEBUG_TOOL_ARGS === '1') {
    for (const tool of msg.tools) {
      const isDebugTool = tool.name.startsWith('mcp__session__') || tool.name === 'Read' || tool.name === 'Bash';
      if (!isDebugTool) continue;
      const inputSchema = (tool.inputSchema && typeof tool.inputSchema === 'object'
        ? tool.inputSchema as { properties?: Record<string, unknown>; required?: string[] }
        : undefined) ?? {};
      const properties = inputSchema.properties ?? {};
      if (process.env.CRAFT_DEBUG_TOOL_TITLES === '1') {
        debugLog(`[tool-title-debug][subprocess] register_tool ${tool.name} hasDisplayNameSchema=${'_displayName' in properties ? 1 : 0} hasIntentSchema=${'_intent' in properties ? 1 : 0} propertyKeys=${Object.keys(properties).sort().join(',') || '∅'}`);
      }
      if (process.env.CRAFT_DEBUG_TOOL_ARGS === '1') {
        debugLog(`[tool-args-debug][subprocess] register_tool ${tool.name} required=${Array.isArray(inputSchema.required) ? inputSchema.required.join(',') : '∅'} propertyKeys=${Object.keys(properties).sort().join(',') || '∅'}`);
      }
    }
  }

  // Merge: replace existing tools by name, add new ones
  const incoming = new Map(msg.tools.map(t => [t.name, t]));
  proxyToolDefs = [
    ...proxyToolDefs.filter(t => !incoming.has(t.name)),
    ...msg.tools,
  ];
  debugLog(`Registered ${msg.tools.length} proxy tools (total: ${proxyToolDefs.length}): ${msg.tools.map(t => t.name).join(', ')}`);

  // If session exists, mark for recreation on next prompt.
  // Don't dispose mid-generation — the flag is checked in handlePrompt().
  if (piSession) {
    toolsChanged = true;
    debugLog('Proxy tools changed — session will be recreated on next prompt');
  }
}

function handleToolExecuteResponse(msg: Extract<InboundMessage, { type: 'tool_execute_response' }>): void {
  if (process.env.CRAFT_DEBUG_TOOL_ARGS === '1') {
    debugLog(`[tool-args-debug][subprocess] tool_execute_response requestId=${msg.requestId} isError=${msg.result.isError ? 1 : 0} content=${JSON.stringify(msg.result.content)}`);
  }
  const pending = pendingToolExecutions.get(msg.requestId);
  if (pending) {
    pendingToolExecutions.delete(msg.requestId);
    activeToolContext = {
      requestId: msg.requestId,
      toolName: pending.toolName,
      args: pending.args,
      sourceLayer: activeToolContext?.sourceLayer,
    };
    pending.resolve(msg.result);
  } else {
    debugLog(`No pending tool execution for requestId: ${msg.requestId}`);
  }
}

function handlePreToolUseResponse(msg: Extract<InboundMessage, { type: 'pre_tool_use_response' }>): void {
  if (process.env.CRAFT_DEBUG_TOOL_ARGS === '1') {
    const normalizedInput = msg.action === 'modify' && msg.input ? normalizeSessionToolMetadataArgs(msg.input) : undefined;
    debugLog(`[tool-args-debug][subprocess] inbound_pre_tool_use_response requestId=${msg.requestId} action=${msg.action} keys=${Object.keys(normalizedInput ?? {}).sort().join(',') || '∅'} payload=${JSON.stringify(normalizedInput ?? null)} reason=${JSON.stringify(msg.reason ?? null)}`);
  }
  const pending = pendingPreToolUse.get(msg.requestId);
  if (pending) {
    pendingPreToolUse.delete(msg.requestId);
    pending.resolve({ action: msg.action, input: msg.input, reason: msg.reason });
  } else {
    debugLog(`No pending pre_tool_use for requestId: ${msg.requestId}`);
  }
}

async function handleAbort(): Promise<void> {
  if (piSession) {
    try {
      await piSession.abort();
    } catch (error) {
      debugLog(`Abort failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Reject all pending pre-tool-use requests
  for (const [, pending] of pendingPreToolUse) {
    pending.resolve({ action: 'block', reason: 'Aborted' });
  }
  pendingPreToolUse.clear();

  // Clear speculative prefetch cache — in-flight prefetches will resolve but never be consumed
  prefetchCache.clear();
}

async function handleMiniCompletion(msg: Extract<InboundMessage, { type: 'mini_completion' }>): Promise<void> {
  // Call queryLlm directly (not runMiniCompletion) so auth errors propagate
  // as 'error' messages instead of being swallowed and returned as null.
  // runMiniCompletion is kept for the summarize callback where null is acceptable.
  try {
    const result = await queryLlm({
      prompt: msg.prompt,
      systemPrompt: msg.systemPrompt,
      maxTokens: msg.maxTokens,
      temperature: msg.temperature,
    });
    send({ type: 'mini_completion_result', id: msg.id, text: result.text || null });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    debugLog(`[handleMiniCompletion] Error: ${errorMsg}`);
    send({ type: 'error', message: errorMsg, code: 'mini_completion_error' });
  }
}

// INVARIANT: the full LLMQueryRequest shape must pass through this RPC unchanged.
// Adding a field to LLMQueryRequest? Nothing to do here — we pass `msg.request`
// to queryLlm() verbatim. But verify queryLlm() actually honors the new field;
// request-propagation + request-honoring are independent (see #596).
async function handleLlmQuery(msg: Extract<InboundMessage, { type: 'llm_query' }>): Promise<void> {
  try {
    const result = await queryLlm(msg.request);
    send({ type: 'llm_query_result', id: msg.id, result });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    debugLog(`[handleLlmQuery] Error: ${errorMsg}`);
    // Dual-emit: the generic `error` channel drives main-process OAuth
    // auth-refresh detection (centralized in PiAgent), while the targeted
    // `llm_query_result` rejects the pending promise for this specific call.
    send({ type: 'error', message: errorMsg, code: 'llm_query_error' });
    send({ type: 'llm_query_result', id: msg.id, result: null, errorMessage: errorMsg, errorCode: 'llm_query_error' });
  }
}

async function handleEnsureSessionReady(msg: Extract<InboundMessage, { type: 'ensure_session_ready' }>): Promise<void> {
  const session = await ensureSession();
  send({
    type: 'ensure_session_ready_result',
    id: msg.id,
    sessionId: session.sessionId || null,
  });
}

async function handleCompact(msg: Extract<InboundMessage, { type: 'compact' }>): Promise<void> {
  try {
    const session = await ensureSession();
    const result = await session.compact(msg.customInstructions);
    send({
      type: 'compact_result',
      id: msg.id,
      success: true,
      result: {
        summary: result.summary,
        firstKeptEntryId: result.firstKeptEntryId,
        tokensBefore: result.tokensBefore,
      },
    });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    debugLog(`[compact] Failed: ${errorMsg}`);
    send({
      type: 'compact_result',
      id: msg.id,
      success: false,
      errorMessage: errorMsg,
    });
  }
}

async function handleSetAutoCompaction(msg: Extract<InboundMessage, { type: 'set_auto_compaction' }>): Promise<void> {
  try {
    const session = await ensureSession();
    session.setAutoCompactionEnabled(msg.enabled);
    send({
      type: 'set_auto_compaction_result',
      id: msg.id,
      success: true,
      enabled: session.autoCompactionEnabled,
    });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    debugLog(`[set_auto_compaction] Failed: ${errorMsg}`);
    send({
      type: 'set_auto_compaction_result',
      id: msg.id,
      success: false,
      enabled: msg.enabled,
      errorMessage: errorMsg,
    });
  }
}

async function handleSetModel(msg: Extract<InboundMessage, { type: 'set_model' }>): Promise<void> {
  debugLog(`[set_model] Received: ${msg.model}`);
  if (!piSession || !piModelRegistry) {
    debugLog(`[set_model] No active session or model registry, ignoring`);
    return;
  }
  let piModel = resolvePiModel(piModelRegistry, msg.model, initConfig?.piAuth?.provider, shouldPreferCustomEndpoint());

  // For custom endpoints, dynamically register unknown models so mid-session switching works.
  // Uses registerCustomEndpointModels which accumulates into the existing model set
  // (registerProvider replaces, so we track all IDs and re-register the full set).
  //
  // Look up the model's contextWindow and supportsImages from the init config's customModels
  // so the Pi SDK model registration has the user-configured values, which affects both
  // auto-compaction threshold calculation (this.model?.contextWindow) and the context window
  // reported in usage events sent back to the main process for the bottom-of-screen display.
  if (!piModel && initConfig?.baseUrl?.trim() && initConfig?.customEndpoint) {
    const bareId = stripPiPrefix(msg.model);
    const existingConfig = (initConfig.customModels ?? []).find(
      (m): m is { id: string; contextWindow?: number; supportsImages?: boolean } =>
        typeof m === 'object' && stripPiPrefix(m.id) === bareId,
    );
    registerCustomEndpointModels(piModelRegistry, initConfig.customEndpoint.api, initConfig.baseUrl!.trim(), [
      existingConfig ?? { id: bareId },
    ]);
    piModel = piModelRegistry.find('custom-endpoint', bareId) ?? undefined;
    debugLog(`[set_model] Dynamically registered custom endpoint model: ${bareId}${existingConfig?.contextWindow ? ` contextWindow=${existingConfig.contextWindow}` : ''}`);
  }

  if (!piModel) {
    debugLog(`[set_model] Could not resolve model: ${msg.model}`);
    setInterceptorApiHints(undefined);
    return;
  }
  try {
    await piSession.setModel(piModel);
    setInterceptorApiHints(piModel as { api?: string; provider?: string; baseUrl?: string });
    debugLog(`[set_model] Model changed to: ${msg.model} (resolved: ${piModel.provider}/${piModel.id})`);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    debugLog(`[set_model] Failed to set model: ${errorMsg}`);
  }
}

async function handleSetThinkingLevel(msg: Extract<InboundMessage, { type: 'set_thinking_level' }>): Promise<void> {
  debugLog(`[set_thinking_level] Received: ${msg.level}`);

  if (!piSession) {
    debugLog('[set_thinking_level] No active session, ignoring');
    return;
  }

  const piLevel = THINKING_TO_PI[msg.level as keyof typeof THINKING_TO_PI];
  if (!piLevel) {
    debugLog(`[set_thinking_level] No Pi mapping for level: ${msg.level}`);
    return;
  }

  try {
    piSession.setThinkingLevel(piLevel);
    debugLog(`[set_thinking_level] Thinking level changed to: ${msg.level} (mapped: ${piLevel})`);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    debugLog(`[set_thinking_level] Failed to set thinking level: ${errorMsg}`);
  }
}

function handleShutdown(): void {
  debugLog('Shutdown requested');

  // Unsubscribe events
  if (unsubscribeEvents) {
    unsubscribeEvents();
    unsubscribeEvents = null;
  }

  // Dispose session
  if (piSession) {
    piSession.dispose();
    piSession = null;
  }

  // Stop callback server
  stopCallbackServer();

  // Reject pending promises
  for (const [, pending] of pendingPreToolUse) {
    pending.resolve({ action: 'block', reason: 'Server shutting down' });
  }
  pendingPreToolUse.clear();

  for (const [, pending] of pendingToolExecutions) {
    pending.resolve({ content: 'Server shutting down', isError: true });
  }
  pendingToolExecutions.clear();

  process.exit(0);
}

// ============================================================
// Main JSONL Reader Loop
// ============================================================

async function processMessage(msg: InboundMessage): Promise<void> {
  switch (msg.type) {
    case 'init':
      await handleInit(msg);
      break;

    case 'prompt':
      await handlePrompt(msg);
      break;

    case 'register_tools':
      handleRegisterTools(msg);
      break;

    case 'tool_execute_response':
      handleToolExecuteResponse(msg);
      break;

    case 'pre_tool_use_response':
      handlePreToolUseResponse(msg);
      break;

    case 'abort':
      await handleAbort();
      break;

    case 'mini_completion':
      await handleMiniCompletion(msg);
      break;

    case 'llm_query':
      await handleLlmQuery(msg);
      break;

    case 'ensure_session_ready':
      await handleEnsureSessionReady(msg);
      break;

    case 'set_model':
      await handleSetModel(msg);
      break;

    case 'set_thinking_level':
      await handleSetThinkingLevel(msg);
      break;

    case 'compact':
      await handleCompact(msg);
      break;

    case 'set_auto_compaction':
      await handleSetAutoCompaction(msg);
      break;

    case 'steer':
      if (piSession) {
        debugLog(`Steering with: "${msg.message.slice(0, 100)}"`);
        await piSession.steer(msg.message);
      } else {
        debugLog('Steer ignored — no active session');
      }
      break;

    case 'token_update':
      if (moduleAuthStorage) {
        const { provider, credential } = msg.piAuth;
        // See ambient comment at the initial `authStorage.set` call — same shape reason.
        moduleAuthStorage.set(provider, credential as unknown as AuthCredential);
        if (initConfig) {
          initConfig.piAuth = msg.piAuth;
        }
        debugLog(`Updated ${credential.type} credential for provider: ${provider}`);
      } else {
        debugLog('token_update received but no authStorage initialized');
      }
      break;

    case 'shutdown':
      handleShutdown();
      break;

    default:
      debugLog(`Unknown message type: ${(msg as any).type}`);
  }
}

function main(): void {
  debugLog('Pi agent server starting');
  debugLog(`[submit-plan-debug][subprocess] startup env CRAFT_DEBUG_SUBMIT_PLAN=${process.env.CRAFT_DEBUG_SUBMIT_PLAN ?? 'unset'} CRAFT_DEBUG_TOOL_TITLES=${process.env.CRAFT_DEBUG_TOOL_TITLES ?? 'unset'} CRAFT_DEBUG_TOOL_ARGS=${process.env.CRAFT_DEBUG_TOOL_ARGS ?? 'unset'}`);

  const rl = createInterface({ input: process.stdin });

  rl.on('line', (line: string) => {
    if (!line.trim()) return;
    try {
      const msg = JSON.parse(line) as InboundMessage;
      processMessage(msg).catch((error) => {
        const errorMsg = error instanceof Error ? error.message : String(error);
        debugLog(`Error processing message: ${errorMsg}`);
        send({ type: 'error', message: errorMsg });
      });
    } catch (parseError) {
      debugLog(`Failed to parse JSONL: ${parseError}`);
    }
  });

  rl.on('close', () => {
    debugLog('stdin closed, shutting down');
    handleShutdown();
  });

  // Handle unexpected errors — process state is unreliable after these,
  // so we attempt to report and then exit immediately.
  // send() is wrapped in try/catch because stdout itself may be broken
  // (e.g. EFAULT from a closed pipe), and we must not let the error
  // report trigger another uncaughtException (which would loop).
  process.on('uncaughtException', (error) => {
    debugLog(`Uncaught exception: ${error.message}`);
    try {
      send({ type: 'error', message: `Uncaught exception: ${error.message}`, code: 'uncaught' });
    } catch {
      // stdout may be broken — swallow to avoid re-triggering
    }
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    debugLog(`Unhandled rejection: ${msg}`);
    try {
      send({ type: 'error', message: `Unhandled rejection: ${msg}`, code: 'unhandled_rejection' });
    } catch {
      // stdout may be broken — swallow to avoid re-triggering
    }
    process.exit(1);
  });
}

main();
