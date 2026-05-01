import { resolve } from 'path'
import { join } from 'path'
import { homedir } from 'os'
import { execSync } from 'child_process'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import { createBackendFromConnection } from '@craft-agent/shared/agent/backend'
import { getWorkspaceByNameOrId, getGitBashPath, setGitBashPath, clearGitBashPath, getDefaultLlmConnection, getLlmConnections, getLlmConnection } from '@craft-agent/shared/config'
import { loadWorkspaceConfig } from '@craft-agent/shared/workspaces'
import { i18n, LOCALE_REGISTRY, type LanguageCode } from '@craft-agent/shared/i18n'
import { getMiniModel, resolveEffectiveConnectionSlug } from '@craft-agent/shared/config/llm-connections'
import { isSafeExternalUrl } from '@craft-agent/shared/utils/url-safety'
import {
  commitGitChanges,
  discardAllGitFiles,
  discardGitFile,
  fetchGitChanges,
  getGitFileDiff,
  getGitRecentCommits,
  getGitCommitDiff,
  getGitStatus,
  type GitResultFailure,
  isUsableGitBashPath,
  pullGitChanges,
  pushGitChanges,
  stageAllGitFiles,
  stageGitFile,
  unstageAllGitFiles,
  unstageGitFile,
  validateGitBashPath,
} from '@craft-agent/server-core/services'
import { validateFilePath, getWorkspaceAllowedDirs, buildBackendHostRuntimeContext } from '@craft-agent/server-core/handlers'
import type { RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import {
  requestClientOpenExternal,
  requestClientOpenPath,
  requestClientShowInFolder,
  requestClientOpenFileDialog,
} from '@craft-agent/server-core/transport'

export const CORE_HANDLED_CHANNELS = [
  RPC_CHANNELS.theme.GET_SYSTEM_PREFERENCE,
  RPC_CHANNELS.system.VERSIONS,
  RPC_CHANNELS.system.HOME_DIR,
  RPC_CHANNELS.system.IS_DEBUG_MODE,
  RPC_CHANNELS.debug.LOG,
  RPC_CHANNELS.shell.OPEN_URL,
  RPC_CHANNELS.shell.OPEN_FILE,
  RPC_CHANNELS.shell.SHOW_IN_FOLDER,
  RPC_CHANNELS.releaseNotes.GET,
  RPC_CHANNELS.releaseNotes.GET_LATEST_VERSION,
  RPC_CHANNELS.git.GET_BRANCH,
  RPC_CHANNELS.git.GET_STATUS,
  RPC_CHANNELS.git.GET_FILE_DIFF,
  RPC_CHANNELS.git.STAGE_FILE,
  RPC_CHANNELS.git.UNSTAGE_FILE,
  RPC_CHANNELS.git.DISCARD_FILE,
  RPC_CHANNELS.git.STAGE_ALL,
  RPC_CHANNELS.git.UNSTAGE_ALL,
  RPC_CHANNELS.git.DISCARD_ALL,
  RPC_CHANNELS.git.COMMIT,
  RPC_CHANNELS.git.PUSH,
  RPC_CHANNELS.git.PULL,
  RPC_CHANNELS.git.GET_RECENT_COMMITS,
  RPC_CHANNELS.git.GET_COMMIT_DIFF,
  RPC_CHANNELS.git.GENERATE_COMMIT_MESSAGE,
  RPC_CHANNELS.gitbash.CHECK,
  RPC_CHANNELS.gitbash.BROWSE,
  RPC_CHANNELS.gitbash.SET_PATH,
] as const

interface ParsedInternalDeepLink {
  navigation?: {
    view?: string
    action?: string
    actionParams?: Record<string, string>
  }
  workspaceId?: string
  /** Use client shell.openExternal fallback (e.g. window=focused links). */
  requiresExternalOpen?: boolean
  /** True when URL is intentionally consumed without navigation (auth callbacks). */
  handledNoop?: boolean
}

const COMPOUND_ROUTE_PREFIXES = new Set([
  'allSessions',
  'flagged',
  'state',
  'sources',
  'settings',
  'skills',
  'automations',
  'archived',
  'label',
  'view',
  'changes',
])

function collectDeepLinkParams(parsed: URL, pathId?: string): Record<string, string> | undefined {
  const params: Record<string, string> = {}
  if (pathId) params.id = pathId

  parsed.searchParams.forEach((value, key) => {
    if (key === 'window' || key === 'sidebar') return
    params[key] = value
  })

  return Object.keys(params).length > 0 ? params : undefined
}

function parseInternalCraftAgentsDeepLink(parsed: URL): ParsedInternalDeepLink | null {
  if (parsed.protocol !== 'craftagents:') return null

  const host = parsed.hostname
  const pathParts = parsed.pathname.split('/').filter(Boolean)
  const windowMode = parsed.searchParams.get('window')

  // Preserve window-specific behavior via OS protocol path.
  if (windowMode === 'focused' || windowMode === 'full') {
    return { requiresExternalOpen: true }
  }

  // OAuth callback links are handled by auth flow code paths.
  if (host === 'auth-callback') {
    return { handledNoop: true }
  }

  if (COMPOUND_ROUTE_PREFIXES.has(host)) {
    const viewRoute = pathParts.length > 0 ? `${host}/${pathParts.join('/')}` : host
    return { navigation: { view: viewRoute } }
  }

  if (host === 'action') {
    const action = pathParts[0]
    if (!action) return null

    const actionParams = collectDeepLinkParams(parsed, pathParts[1])
    return {
      navigation: {
        action,
        actionParams,
      },
    }
  }

  if (host === 'workspace') {
    const workspaceId = pathParts[0]
    if (!workspaceId) return null

    const routeType = pathParts[1]
    if (!routeType) return null

    if (COMPOUND_ROUTE_PREFIXES.has(routeType)) {
      return {
        workspaceId,
        navigation: { view: pathParts.slice(1).join('/') },
      }
    }

    if (routeType === 'action') {
      const action = pathParts[2]
      if (!action) return null

      return {
        workspaceId,
        navigation: {
          action,
          actionParams: collectDeepLinkParams(parsed, pathParts[3]),
        },
      }
    }
  }

  return null
}

/** Guard: reject filesystem-path actions on remote workspaces where local paths are meaningless. */
function assertLocalWorkspace(ctx: { workspaceId: string | null }, action: string): void {
  const ws = getWorkspaceByNameOrId(ctx.workspaceId ?? '')
  if (ws?.remoteServer) {
    throw new Error(`${action} is not available for remote workspaces`)
  }
}

function buildCommitMessagePrompt(args: {
  locale: string
  language: string
  status: Extract<Awaited<ReturnType<typeof getGitStatus>>, { ok: true }>
  stagedDiff: string
  customPrompt?: string
}): string {
  const { locale, language, status, stagedDiff, customPrompt } = args
  const filesSummary = status.files.map(file => {
    const stagedLabel = file.staged ? 'staged' : 'unstaged'
    return `- ${file.path} [${file.status}, ${stagedLabel}, +${file.additions}/-${file.deletions}]`
  }).join('\n')

  return [
    'You are generating a Git commit message for the current repository changes.',
    `Output language: ${language} (locale: ${locale}).`,
    'Follow conventional git commit style.',
    'Keep commit type keywords in English when appropriate, such as feat, fix, refactor, docs, test, chore, perf, ci, build, revert.',
    'Return ONLY the commit message text with no code fences or explanation.',
    'Prefer a concise subject line. Add a blank line plus bullet list body only when genuinely helpful.',
    'Base the message on the staged changes first; if nothing is staged, summarize the current working tree changes.',
    customPrompt?.trim() ? `Additional instruction: ${customPrompt.trim()}` : '',
    '',
    'Repository summary:',
    `- Branch: ${status.summary.branch}`,
    `- Ahead: ${status.summary.ahead}`,
    `- Behind: ${status.summary.behind}`,
    `- Files changed: ${status.files.length}`,
    `- Staged files: ${status.summary.staged}`,
    `- Untracked files: ${status.summary.untracked}`,
    `- Conflicts: ${status.summary.conflicts}`,
    '',
    'Changed files:',
    filesSummary || '- None',
    '',
    'Staged diff:',
    stagedDiff || '(No staged diff available. Use the file summary above.)',
  ].filter(Boolean).join('\n')
}

async function generateGitCommitMessageFromConnection(args: {
  connectionSlug: string
  workspaceId: string
  dirPath: string
  customPrompt?: string
  deps: HandlerDeps
}): Promise<{ ok: true; message: string; connectionSlug: string } | GitResultFailure> {
  const { connectionSlug, workspaceId, dirPath, customPrompt, deps } = args
  const status = getGitStatus(dirPath)
  if (!status.ok) return status

  const stagedDiff = getGitFileDiff(dirPath, '--cached')
  const diffText = stagedDiff.ok ? stagedDiff.diff : ''
  const langCode = (i18n.resolvedLanguage ?? 'en') as LanguageCode
  const langEntry = LOCALE_REGISTRY[langCode]
  const language = langEntry?.nativeName ?? 'English'
  const connection = getLlmConnection(connectionSlug)
  const resolvedMiniModel = connection ? (getMiniModel(connection) ?? connection.defaultModel) : undefined

  const backend = createBackendFromConnection(connectionSlug, {
    workspace: {
      id: workspaceId,
      name: workspaceId,
      rootPath: dirPath,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
    miniModel: resolvedMiniModel,
    session: {
      id: `git-commit-${Date.now()}`,
      workspaceId,
      workspaceName: workspaceId,
      name: 'Git Commit Message',
      messages: [],
      isProcessing: false,
      lastMessageAt: Date.now(),
      llmConnection: connectionSlug,
      createdAt: Date.now(),
    },
    isHeadless: true,
    skipConfigWatcher: true,
    systemPromptPreset: 'mini',
  } as any, buildBackendHostRuntimeContext(deps.platform))

  try {
    await backend.postInit()
    const prompt = buildCommitMessagePrompt({
      locale: langCode,
      language,
      status,
      stagedDiff: diffText,
      customPrompt,
    })
    const message = (await backend.runMiniCompletion(prompt))?.trim()
    if (!message) {
      return { ok: false, reason: 'unknown_error', message: 'Failed to generate commit message' }
    }
    return { ok: true, message, connectionSlug }
  } catch (error) {
    return { ok: false, reason: 'unknown_error', message: error instanceof Error ? error.message : 'Failed to generate commit message' }
  } finally {
    backend.destroy()
  }
}

export function registerSystemCoreHandlers(server: RpcServer, deps: HandlerDeps): void {
  const windowManager = deps.windowManager

  // Get system theme preference (dark = true, light = false)
  server.handle(RPC_CHANNELS.theme.GET_SYSTEM_PREFERENCE, async () => {
    return deps.platform.systemDarkMode?.() ?? false
  })

  // Get runtime versions (previously handled locally in preload via process.versions)
  server.handle(RPC_CHANNELS.system.VERSIONS, async () => {
    return {
      node: process.versions.node,
      chrome: process.versions.chrome ?? undefined,
      electron: process.versions.electron ?? undefined,
    }
  })

  // Get user's home directory
  server.handle(RPC_CHANNELS.system.HOME_DIR, async () => {
    return homedir()
  })

  // Check if running in debug mode (from source)
  server.handle(RPC_CHANNELS.system.IS_DEBUG_MODE, async () => {
    return !deps.platform.isPackaged
  })

  // Release notes
  server.handle(RPC_CHANNELS.releaseNotes.GET, async () => {
    const { getCombinedReleaseNotes } = require('@craft-agent/shared/release-notes') as typeof import('@craft-agent/shared/release-notes')
    return getCombinedReleaseNotes()
  })

  server.handle(RPC_CHANNELS.releaseNotes.GET_LATEST_VERSION, async () => {
    const { getLatestReleaseVersion } = require('@craft-agent/shared/release-notes') as typeof import('@craft-agent/shared/release-notes')
    return getLatestReleaseVersion()
  })

  // Get git branch for a directory (returns null if not a git repo or git unavailable)
  server.handle(RPC_CHANNELS.git.GET_BRANCH, async (_ctx, dirPath: string) => {
    try {
      const branch = execSync('git rev-parse --abbrev-ref HEAD', {
        cwd: dirPath,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 5000,
      }).trim()
      return branch || null
    } catch {
      return null
    }
  })

  server.handle(RPC_CHANNELS.git.GET_STATUS, async (_ctx, dirPath: string) => {
    return getGitStatus(dirPath)
  })

  server.handle(RPC_CHANNELS.git.GET_FILE_DIFF, async (_ctx, dirPath: string, filePath: string) => {
    return getGitFileDiff(dirPath, filePath)
  })

  server.handle(RPC_CHANNELS.git.STAGE_FILE, async (_ctx, dirPath: string, filePath: string) => {
    return stageGitFile(dirPath, filePath)
  })

  server.handle(RPC_CHANNELS.git.UNSTAGE_FILE, async (_ctx, dirPath: string, filePath: string) => {
    return unstageGitFile(dirPath, filePath)
  })

  server.handle(RPC_CHANNELS.git.DISCARD_FILE, async (_ctx, dirPath: string, filePath: string) => {
    return discardGitFile(dirPath, filePath)
  })

  server.handle(RPC_CHANNELS.git.STAGE_ALL, async (_ctx, dirPath: string) => {
    return stageAllGitFiles(dirPath)
  })

  server.handle(RPC_CHANNELS.git.UNSTAGE_ALL, async (_ctx, dirPath: string) => {
    return unstageAllGitFiles(dirPath)
  })

  server.handle(RPC_CHANNELS.git.DISCARD_ALL, async (_ctx, dirPath: string) => {
    return discardAllGitFiles(dirPath)
  })

  server.handle(RPC_CHANNELS.git.COMMIT, async (_ctx, dirPath: string, params: { message: string }) => {
    return commitGitChanges(dirPath, params)
  })

  server.handle(RPC_CHANNELS.git.FETCH, async (_ctx, dirPath: string) => {
    return fetchGitChanges(dirPath)
  })

  server.handle(RPC_CHANNELS.git.PUSH, async (_ctx, dirPath: string) => {
    return pushGitChanges(dirPath)
  })

  server.handle(RPC_CHANNELS.git.PULL, async (_ctx, dirPath: string) => {
    return pullGitChanges(dirPath)
  })

  server.handle(RPC_CHANNELS.git.GET_RECENT_COMMITS, async (_ctx, dirPath: string, limit?: number) => {
    return getGitRecentCommits(dirPath, limit)
  })

  server.handle(RPC_CHANNELS.git.GET_COMMIT_DIFF, async (_ctx, dirPath: string, commitHash: string) => {
    return getGitCommitDiff(dirPath, commitHash)
  })

  server.handle(RPC_CHANNELS.git.GENERATE_COMMIT_MESSAGE, async (_ctx, params: { workspaceId: string; dirPath: string; connectionSlug?: string; customPrompt?: string }) => {
    const wsConfig = loadWorkspaceConfig(params.dirPath)
    const connections = getLlmConnections().map(connection => ({ slug: connection.slug, isDefault: connection.slug === getDefaultLlmConnection() }))
    const connectionSlug = params.connectionSlug
      ?? resolveEffectiveConnectionSlug(undefined, wsConfig?.defaults?.defaultLlmConnection, connections)
      ?? getDefaultLlmConnection()
      ?? undefined

    if (!connectionSlug) {
      return { ok: false, reason: 'unknown_error' as const, message: 'No LLM connection configured' }
    }

    return generateGitCommitMessageFromConnection({
      connectionSlug,
      workspaceId: params.workspaceId,
      dirPath: params.dirPath,
      customPrompt: params.customPrompt,
      deps,
    })
  })

  // Git Bash detection and configuration (Windows only)
  server.handle(RPC_CHANNELS.gitbash.CHECK, async () => {
    const platform = process.platform as 'win32' | 'darwin' | 'linux'

    if (platform !== 'win32') {
      return { found: true, path: null, platform }
    }

    const commonPaths = [
      'C:\\Program Files\\Git\\bin\\bash.exe',
      'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
      join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'bin', 'bash.exe'),
      join(process.env.PROGRAMFILES || '', 'Git', 'bin', 'bash.exe'),
    ]

    const persistedPath = getGitBashPath()
    if (persistedPath) {
      if (await isUsableGitBashPath(persistedPath)) {
        process.env.CLAUDE_CODE_GIT_BASH_PATH = persistedPath.trim()
        return { found: true, path: persistedPath, platform }
      }
      clearGitBashPath()
    }

    for (const bashPath of commonPaths) {
      if (await isUsableGitBashPath(bashPath)) {
        process.env.CLAUDE_CODE_GIT_BASH_PATH = bashPath
        setGitBashPath(bashPath)
        return { found: true, path: bashPath, platform }
      }
    }

    try {
      const result = execSync('where bash', {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 5000,
      }).trim()
      const firstPath = result.split('\n')[0]?.trim()
      if (firstPath && firstPath.toLowerCase().includes('git') && await isUsableGitBashPath(firstPath)) {
        process.env.CLAUDE_CODE_GIT_BASH_PATH = firstPath
        setGitBashPath(firstPath)
        return { found: true, path: firstPath, platform }
      }
    } catch {
      // where command failed
    }

    delete process.env.CLAUDE_CODE_GIT_BASH_PATH
    return { found: false, path: null, platform }
  })

  server.handle(RPC_CHANNELS.gitbash.BROWSE, async (ctx) => {
    const result = await requestClientOpenFileDialog(server, ctx.clientId, {
      title: 'Select bash.exe',
      filters: [{ name: 'Executable', extensions: ['exe'] }],
      properties: ['openFile'],
      defaultPath: 'C:\\Program Files\\Git\\bin',
    })

    if (result.canceled || result.filePaths.length === 0) {
      return null
    }

    return result.filePaths[0]
  })

  server.handle(RPC_CHANNELS.gitbash.SET_PATH, async (_ctx, bashPath: string) => {
    const validation = await validateGitBashPath(bashPath)
    if (!validation.valid) {
      return { success: false, error: validation.error }
    }

    setGitBashPath(validation.path)
    process.env.CLAUDE_CODE_GIT_BASH_PATH = validation.path
    return { success: true }
  })

  // Debug logging from renderer -> main log file (fire-and-forget, no response)
  server.handle(RPC_CHANNELS.debug.LOG, async (_ctx, ...args: unknown[]) => {
    deps.platform.logger.info('[renderer]', ...args)
  })

  // Shell operations - open URL in external browser (or handle craftagents:// internally)
  server.handle(RPC_CHANNELS.shell.OPEN_URL, async (ctx, url: string) => {
    deps.platform.logger.info('[OPEN_URL] Received request:', url)
    try {
      const parsed = new URL(url)

      if (parsed.protocol === 'craftagents:') {
        const deepLink = parseInternalCraftAgentsDeepLink(parsed)

        if (deepLink?.handledNoop) {
          deps.platform.logger.info('[OPEN_URL] Ignoring auth-callback deep link in OPEN_URL handler')
          return
        }

        if (deepLink?.navigation?.view || deepLink?.navigation?.action) {
          const target = deepLink.workspaceId && deepLink.workspaceId !== ctx.workspaceId
            ? { to: 'workspace' as const, workspaceId: deepLink.workspaceId }
            : { to: 'client' as const, clientId: ctx.clientId }

          deps.platform.logger.info('[OPEN_URL] Routing craftagents:// URL internally via deeplink:navigate')
          server.push(RPC_CHANNELS.deeplink.NAVIGATE, target, deepLink.navigation)
          return
        }

        // For links requiring window management (e.g. window=focused/full), or
        // unknown deep-link shapes, fall back to the client protocol handler.
        deps.platform.logger.info('[OPEN_URL] Falling back to client openExternal for craftagents:// URL')
        const deepLinkResult = await requestClientOpenExternal(server, ctx.clientId, url)
        if (!deepLinkResult.opened) {
          deps.platform.logger.error(`[OPEN_URL] Client capability failed: ${deepLinkResult.error}`)
          throw new Error(`Cannot open URL on client: ${deepLinkResult.error}`)
        }
        return
      }

      if (!isSafeExternalUrl(url)) {
        throw new Error(`Refused to open URL with blocked scheme: ${parsed.protocol}`)
      }

      const result = await requestClientOpenExternal(server, ctx.clientId, url)
      if (!result.opened) {
        deps.platform.logger.error(`[OPEN_URL] Client capability failed: ${result.error}`)
        throw new Error(`Cannot open URL on client: ${result.error}`)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      deps.platform.logger.error('openUrl error:', message)
      throw new Error(`Failed to open URL: ${message}`)
    }
  })

  server.handle(RPC_CHANNELS.shell.OPEN_FILE, async (ctx, path: string) => {
    assertLocalWorkspace(ctx, 'Open file')
    try {
      // Expand ~ before resolve() — resolve() treats ~ as a literal path component
      const expanded = path.startsWith('~') ? path.replace(/^~/, homedir()) : path
      const absolutePath = resolve(expanded)
      const safePath = await validateFilePath(absolutePath, getWorkspaceAllowedDirs(ctx.workspaceId))
      const result = await requestClientOpenPath(server, ctx.clientId, safePath)
      if (result.error) throw new Error(result.error)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      deps.platform.logger.error('openFile error:', message)
      throw new Error(`Failed to open file: ${message}`)
    }
  })

  server.handle(RPC_CHANNELS.shell.SHOW_IN_FOLDER, async (ctx, path: string) => {
    assertLocalWorkspace(ctx, 'Show in folder')
    try {
      const expanded = path.startsWith('~') ? path.replace(/^~/, homedir()) : path
      const absolutePath = resolve(expanded)
      const safePath = await validateFilePath(absolutePath, getWorkspaceAllowedDirs(ctx.workspaceId))
      await requestClientShowInFolder(server, ctx.clientId, safePath)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      deps.platform.logger.error('showInFolder error:', message)
      throw new Error(`Failed to show in folder: ${message}`)
    }
  })
}
