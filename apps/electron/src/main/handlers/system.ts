import { app } from 'electron'
import { resolve, join, dirname } from 'path'
import { homedir } from 'os'
import { execSync } from 'child_process'
import { appendFileSync, mkdirSync } from 'fs'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import { getGitBashPath, setGitBashPath, clearGitBashPath, getAppVariant, getCraftRendererDebugLogPath, getDefaultLlmConnection, getLlmConnections, getLlmConnection } from '@craft-agent/shared/config'
import { loadWorkspaceConfig } from '@craft-agent/shared/workspaces'
import { createBackendFromConnection } from '@craft-agent/shared/agent/backend'
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
import type { HandlerDeps } from './handler-deps'
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

function getRendererDebugLogPath(mainLogPath?: string): string | undefined {
  if (mainLogPath) {
    return join(dirname(mainLogPath), 'renderer-debug.log')
  }

  try {
    const logsDir = app.getPath('logs')
    return logsDir ? join(logsDir, 'renderer-debug.log') : getCraftRendererDebugLogPath()
  } catch {
    return getCraftRendererDebugLogPath()
  }
}

function persistRendererDebugLog(mainLogPath: string | undefined, args: unknown[]): void {
  const debugLogPath = getRendererDebugLogPath(mainLogPath)
  if (!debugLogPath) return

  const payload = {
    timestamp: new Date().toISOString(),
    scope: 'renderer',
    message: args,
  }

  mkdirSync(dirname(debugLogPath), { recursive: true })
  appendFileSync(debugLogPath, `${JSON.stringify(payload)}\n`, 'utf8')
}

export const GUI_HANDLED_CHANNELS = [
  RPC_CHANNELS.update.CHECK,
  RPC_CHANNELS.update.GET_INFO,
  RPC_CHANNELS.update.INSTALL,
  RPC_CHANNELS.update.DISMISS,
  RPC_CHANNELS.update.GET_DISMISSED,
  RPC_CHANNELS.badge.REFRESH,
  RPC_CHANNELS.badge.SET_ICON,
  RPC_CHANNELS.window.GET_FOCUS_STATE,
  RPC_CHANNELS.notification.SHOW,
  RPC_CHANNELS.notification.GET_ENABLED,
  RPC_CHANNELS.notification.SET_ENABLED,
  RPC_CHANNELS.menu.QUIT,
  RPC_CHANNELS.menu.NEW_WINDOW,
  RPC_CHANNELS.menu.MINIMIZE,
  RPC_CHANNELS.menu.MAXIMIZE,
  RPC_CHANNELS.menu.ZOOM_IN,
  RPC_CHANNELS.menu.ZOOM_OUT,
  RPC_CHANNELS.menu.ZOOM_RESET,
  RPC_CHANNELS.menu.TOGGLE_DEV_TOOLS,
  RPC_CHANNELS.menu.UNDO,
  RPC_CHANNELS.menu.REDO,
  RPC_CHANNELS.menu.CUT,
  RPC_CHANNELS.menu.COPY,
  RPC_CHANNELS.menu.PASTE,
  RPC_CHANNELS.menu.SELECT_ALL,
] as const

export const HANDLED_CHANNELS = [
  ...CORE_HANDLED_CHANNELS,
  ...GUI_HANDLED_CHANNELS,
] as const

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
      chrome: process.versions.chrome,
      electron: process.versions.electron,
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
    try {
      persistRendererDebugLog(deps.platform.getLogFilePath?.(), args)
    } catch (error) {
      deps.platform.logger.error('[renderer-debug] Failed to persist debug log:', error)
    }
  })

  // Shell operations - open URL in external browser (or handle craftagents:// internally)
  server.handle(RPC_CHANNELS.shell.OPEN_URL, async (ctx, url: string) => {
    deps.platform.logger.info('[OPEN_URL] Received request:', url)
    try {
      const parsed = new URL(url)

      // Handle craftagents:// URLs internally via deep link handler (GUI only)
      if (parsed.protocol === 'craftagents:') {
        if (!windowManager) return
        deps.platform.logger.info('[OPEN_URL] Handling as deep link')
        const { handleDeepLink } = await import('../deep-link')
        const resolver = (wcId: number) => windowManager.getClientIdForWindow(wcId)
        const result = await handleDeepLink(url, windowManager, server.push.bind(server), resolver, ctx.clientId)
        deps.platform.logger.info('[OPEN_URL] Deep link result:', result)
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
    try {
      const expanded = path.startsWith('~') ? path.replace(/^~/, homedir()) : path
      const absolutePath = resolve(expanded)
      const workspaceId = ctx.workspaceId ?? deps.windowManager?.getWorkspaceForWindow(ctx.webContentsId!)
      const safePath = await validateFilePath(absolutePath, getWorkspaceAllowedDirs(workspaceId))
      const result = await requestClientOpenPath(server, ctx.clientId, safePath)
      if (result.error) throw new Error(result.error)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      deps.platform.logger.error('openFile error:', message)
      throw new Error(`Failed to open file: ${message}`)
    }
  })

  server.handle(RPC_CHANNELS.shell.SHOW_IN_FOLDER, async (ctx, path: string) => {
    try {
      const expanded = path.startsWith('~') ? path.replace(/^~/, homedir()) : path
      const absolutePath = resolve(expanded)
      const workspaceId = ctx.workspaceId ?? deps.windowManager?.getWorkspaceForWindow(ctx.webContentsId!)
      const safePath = await validateFilePath(absolutePath, getWorkspaceAllowedDirs(workspaceId))
      await requestClientShowInFolder(server, ctx.clientId, safePath)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      deps.platform.logger.error('showInFolder error:', message)
      throw new Error(`Failed to show in folder: ${message}`)
    }
  })
}

export function registerSystemGuiHandlers(server: RpcServer, deps: HandlerDeps): void {
  const { sessionManager } = deps
  const windowManager = deps.windowManager

  // Auto-update handlers
  server.handle(RPC_CHANNELS.update.CHECK, async () => {
    const { checkForUpdates } = await import('../auto-update')
    const updatePolicy = getAppVariant().update
    return checkForUpdates({ autoDownload: updatePolicy.autoDownload })
  })

  server.handle(RPC_CHANNELS.update.GET_INFO, async () => {
    const { getUpdateInfo } = await import('../auto-update')
    return getUpdateInfo()
  })

  server.handle(RPC_CHANNELS.update.INSTALL, async () => {
    const { installUpdate } = await import('../auto-update')
    return installUpdate()
  })

  server.handle(RPC_CHANNELS.update.DISMISS, async (_ctx, version: string) => {
    const { setDismissedUpdateVersion } = await import('@craft-agent/shared/config')
    setDismissedUpdateVersion(version)
  })

  server.handle(RPC_CHANNELS.update.GET_DISMISSED, async () => {
    const { getDismissedUpdateVersion } = await import('@craft-agent/shared/config')
    return getDismissedUpdateVersion()
  })

  // Menu actions from renderer (for unified Craft menu)
  server.handle(RPC_CHANNELS.menu.QUIT, async () => {
    deps.platform.quit?.()
  })

  server.handle(RPC_CHANNELS.menu.NEW_WINDOW, async (ctx) => {
    if (!windowManager) return
    const workspaceId = ctx.workspaceId ?? windowManager.getWorkspaceForWindow(ctx.webContentsId!)
    if (workspaceId) {
      windowManager.createWindow({ workspaceId })
    }
  })

  server.handle(RPC_CHANNELS.menu.MINIMIZE, async (ctx) => {
    if (!windowManager) return
    const win = windowManager.getWindowByWebContentsId(ctx.webContentsId!)
    win?.minimize()
  })

  server.handle(RPC_CHANNELS.menu.MAXIMIZE, async (ctx) => {
    if (!windowManager) return
    const win = windowManager.getWindowByWebContentsId(ctx.webContentsId!)
    if (win) {
      if (win.isMaximized()) {
        win.unmaximize()
      } else {
        win.maximize()
      }
    }
  })

  server.handle(RPC_CHANNELS.menu.ZOOM_IN, async (ctx) => {
    if (!windowManager) return
    const win = windowManager.getWindowByWebContentsId(ctx.webContentsId!)
    if (win) {
      const currentZoom = win.webContents.getZoomFactor()
      win.webContents.setZoomFactor(Math.min(currentZoom + 0.1, 3.0))
    }
  })

  server.handle(RPC_CHANNELS.menu.ZOOM_OUT, async (ctx) => {
    if (!windowManager) return
    const win = windowManager.getWindowByWebContentsId(ctx.webContentsId!)
    if (win) {
      const currentZoom = win.webContents.getZoomFactor()
      win.webContents.setZoomFactor(Math.max(currentZoom - 0.1, 0.5))
    }
  })

  server.handle(RPC_CHANNELS.menu.ZOOM_RESET, async (ctx) => {
    if (!windowManager) return
    const win = windowManager.getWindowByWebContentsId(ctx.webContentsId!)
    win?.webContents.setZoomFactor(1.0)
  })

  server.handle(RPC_CHANNELS.menu.TOGGLE_DEV_TOOLS, async (ctx) => {
    if (!windowManager) return
    const win = windowManager.getWindowByWebContentsId(ctx.webContentsId!)
    win?.webContents.toggleDevTools()
  })

  server.handle(RPC_CHANNELS.menu.UNDO, async (ctx) => {
    if (!windowManager) return
    const win = windowManager.getWindowByWebContentsId(ctx.webContentsId!)
    win?.webContents.undo()
  })

  server.handle(RPC_CHANNELS.menu.REDO, async (ctx) => {
    if (!windowManager) return
    const win = windowManager.getWindowByWebContentsId(ctx.webContentsId!)
    win?.webContents.redo()
  })

  server.handle(RPC_CHANNELS.menu.CUT, async (ctx) => {
    if (!windowManager) return
    const win = windowManager.getWindowByWebContentsId(ctx.webContentsId!)
    win?.webContents.cut()
  })

  server.handle(RPC_CHANNELS.menu.COPY, async (ctx) => {
    if (!windowManager) return
    const win = windowManager.getWindowByWebContentsId(ctx.webContentsId!)
    win?.webContents.copy()
  })

  server.handle(RPC_CHANNELS.menu.PASTE, async (ctx) => {
    if (!windowManager) return
    const win = windowManager.getWindowByWebContentsId(ctx.webContentsId!)
    win?.webContents.paste()
  })

  server.handle(RPC_CHANNELS.menu.SELECT_ALL, async (ctx) => {
    if (!windowManager) return
    const win = windowManager.getWindowByWebContentsId(ctx.webContentsId!)
    win?.webContents.selectAll()
  })

  // Notifications
  server.handle(RPC_CHANNELS.notification.SHOW, async (_ctx, title: string, body: string, workspaceId: string, sessionId: string) => {
    const { showNotification } = await import('../notifications')
    showNotification(title, body, workspaceId, sessionId)
  })

  server.handle(RPC_CHANNELS.notification.GET_ENABLED, async () => {
    const { getNotificationsEnabled } = await import('@craft-agent/shared/config/storage')
    return getNotificationsEnabled()
  })

  server.handle(RPC_CHANNELS.notification.SET_ENABLED, async (_ctx, enabled: boolean) => {
    const { setNotificationsEnabled } = await import('@craft-agent/shared/config/storage')
    setNotificationsEnabled(enabled)

    if (enabled) {
      const { showNotification } = await import('../notifications')
      showNotification('Notifications enabled', 'You will be notified when tasks complete.', '', '')
    }
  })

  // Badge and window focus
  server.handle(RPC_CHANNELS.badge.REFRESH, async () => {
    try {
      await sessionManager.waitForInit()
    } catch {
      // continue
    }
    sessionManager.refreshBadge()
  })

  server.handle(RPC_CHANNELS.badge.SET_ICON, async (_ctx, dataUrl: string) => {
    const { setDockIconWithBadge } = await import('../notifications')
    setDockIconWithBadge(dataUrl)
  })

  server.handle(RPC_CHANNELS.window.GET_FOCUS_STATE, async () => {
    const { isAnyWindowFocused } = require('../notifications')
    return isAnyWindowFocused()
  })
}

export function registerSystemHandlers(server: RpcServer, deps: HandlerDeps): void {
  registerSystemCoreHandlers(server, deps)
  registerSystemGuiHandlers(server, deps)
}
