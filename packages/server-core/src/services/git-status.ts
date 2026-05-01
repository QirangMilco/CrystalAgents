import { execFileSync } from 'child_process'
import type {
  ChangedFileItem,
  GitActionResult,
  GitCommitDetailResult,
  GitCommitParams,
  GitFileDiffResult,
  GitRecentCommitItem,
  GitRecentCommitsResult,
  GitStatusResult,
} from '@craft-agent/shared/protocol'

const GIT_TIMEOUT_MS = 5000

export type GitResultFailure = Extract<GitStatusResult | GitFileDiffResult | GitActionResult, { ok: false }>

function runGit(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: GIT_TIMEOUT_MS,
  }).toString()
}

function classifyGitError(error: unknown): GitResultFailure {
  const stderr = typeof error === 'object' && error !== null && 'stderr' in error
    ? String((error as { stderr?: unknown }).stderr ?? '')
    : ''
  const message = stderr || (error instanceof Error ? error.message : 'Unknown git error')

  if (
    message.includes('not a git repository') ||
    message.includes('not a git repo') ||
    message.includes('fatal: not a git repository')
  ) {
    return { ok: false, reason: 'not_repo', message }
  }

  if (
    message.includes('ENOENT') ||
    message.includes('spawnSync git ENOENT') ||
    message.includes('command not found')
  ) {
    return { ok: false, reason: 'git_unavailable', message }
  }

  return { ok: false, reason: 'unknown_error', message }
}

function parseBranchHeader(line: string): Pick<Extract<GitStatusResult, { ok: true }>, 'summary'>['summary'] {
  const summary = {
    branch: '',
    ahead: 0,
    behind: 0,
    modified: 0,
    staged: 0,
    untracked: 0,
    conflicts: 0,
  }

  const content = line.replace(/^##\s*/, '')
  const [branchPart, trackingPart] = content.split('...')
  summary.branch = (branchPart || '').trim() || 'HEAD'

  if (trackingPart) {
    const aheadMatch = trackingPart.match(/ahead\s+(\d+)/)
    const behindMatch = trackingPart.match(/behind\s+(\d+)/)
    summary.ahead = aheadMatch ? Number(aheadMatch[1]) : 0
    summary.behind = behindMatch ? Number(behindMatch[1]) : 0
  }

  return summary
}

function isConflictStatus(indexStatus: string, workingTreeStatus: string): boolean {
  const raw = `${indexStatus}${workingTreeStatus}`
  return ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(raw)
}

function parsePorcelainLine(line: string): ChangedFileItem | null {
  if (!line) return null

  const rawStatus = line.slice(0, 2)
  const indexStatus = rawStatus[0] ?? ' '
  const workingTreeStatus = rawStatus[1] ?? ' '
  const rawPath = line.slice(3)

  const conflict = isConflictStatus(indexStatus, workingTreeStatus)
  const untracked = rawStatus === '??'
  const staged = !untracked && indexStatus !== ' ' && indexStatus !== '?'
  const unstaged = untracked || (workingTreeStatus !== ' ' && workingTreeStatus !== '?')

  let status: ChangedFileItem['status'] = 'modified'
  let path = rawPath
  let oldPath: string | undefined

  if (conflict) {
    status = 'conflict'
  } else if (untracked) {
    status = 'untracked'
  } else if (indexStatus === 'R' || workingTreeStatus === 'R') {
    status = 'renamed'
    const [from, to] = rawPath.split(' -> ')
    oldPath = from
    path = to || rawPath
  } else if (indexStatus === 'A' || workingTreeStatus === 'A') {
    status = 'added'
  } else if (indexStatus === 'D' || workingTreeStatus === 'D') {
    status = 'deleted'
  }

  return {
    path,
    oldPath,
    status,
    staged,
    unstaged,
    additions: 0,
    deletions: 0,
    rawStatus,
  }
}

function parseNumstat(output: string): Map<string, { additions: number; deletions: number }> {
  const stats = new Map<string, { additions: number; deletions: number }>()

  for (const line of output.split('\n')) {
    if (!line.trim()) continue
    const [additionsRaw, deletionsRaw, ...pathParts] = line.split('\t')
    const path = pathParts[pathParts.length - 1]
    if (!path) continue

    const additions = additionsRaw === '-' ? 0 : Number(additionsRaw) || 0
    const deletions = deletionsRaw === '-' ? 0 : Number(deletionsRaw) || 0
    const current = stats.get(path) ?? { additions: 0, deletions: 0 }
    stats.set(path, {
      additions: current.additions + additions,
      deletions: current.deletions + deletions,
    })
  }

  return stats
}

function okAction(message?: string): GitActionResult {
  return { ok: true, message }
}

function hasResolvableHead(dirPath: string): boolean {
  try {
    runGit(dirPath, ['rev-parse', '--verify', 'HEAD'])
    return true
  } catch {
    return false
  }
}

function resolveDiscardArgs(filePath?: string): string[] {
  return filePath ? ['restore', '--source=HEAD', '--staged', '--worktree', '--', filePath] : ['reset', '--hard', 'HEAD']
}

export function getGitStatus(dirPath: string): GitStatusResult {
  try {
    const porcelain = runGit(dirPath, ['status', '--porcelain=v1', '-b'])
    const lines = porcelain.split('\n').filter(Boolean)
    const header = lines.find(line => line.startsWith('##'))
    const summary = parseBranchHeader(header ?? '## HEAD')
    const files: ChangedFileItem[] = []

    for (const line of lines) {
      if (line.startsWith('##')) continue
      const item = parsePorcelainLine(line)
      if (!item) continue
      files.push(item)
      if (item.status === 'conflict') summary.conflicts += 1
      if (item.status === 'untracked') summary.untracked += 1
      if (item.staged) summary.staged += 1
      if (item.unstaged || item.status === 'modified' || item.status === 'deleted') summary.modified += 1
    }

    const stats = new Map<string, { additions: number; deletions: number }>()
    for (const args of [
      ['diff', '--numstat'],
      ['diff', '--cached', '--numstat'],
    ]) {
      const parsed = parseNumstat(runGit(dirPath, args))
      for (const [path, value] of parsed) {
        const current = stats.get(path) ?? { additions: 0, deletions: 0 }
        stats.set(path, {
          additions: current.additions + value.additions,
          deletions: current.deletions + value.deletions,
        })
      }
    }

    for (const file of files) {
      const stat = stats.get(file.path)
      if (stat) {
        file.additions = stat.additions
        file.deletions = stat.deletions
      }
    }

    return { ok: true, summary, files }
  } catch (error) {
    return classifyGitError(error) as GitStatusResult
  }
}

export function getGitFileDiff(dirPath: string, filePath: string): GitFileDiffResult {
  try {
    if (filePath === '--cached') {
      const diff = runGit(dirPath, ['diff', '--cached'])
      return { ok: true, diff }
    }

    const diff = runGit(dirPath, ['diff', '--', filePath])
    const cachedDiff = runGit(dirPath, ['diff', '--cached', '--', filePath])
    const unifiedDiff = [cachedDiff, diff].filter(Boolean).join('\n')
    return { ok: true, diff: unifiedDiff }
  } catch (error) {
    return classifyGitError(error) as GitFileDiffResult
  }
}

export function stageGitFile(dirPath: string, filePath: string): GitActionResult {
  try {
    runGit(dirPath, ['add', '--', filePath])
    return okAction()
  } catch (error) {
    return classifyGitError(error) as GitActionResult
  }
}

export function unstageGitFile(dirPath: string, filePath: string): GitActionResult {
  try {
    if (hasResolvableHead(dirPath)) {
      runGit(dirPath, ['restore', '--staged', '--', filePath])
    } else {
      runGit(dirPath, ['rm', '--cached', '--ignore-unmatch', '--', filePath])
    }
    return okAction()
  } catch (error) {
    return classifyGitError(error) as GitActionResult
  }
}

export function discardGitFile(dirPath: string, filePath: string): GitActionResult {
  try {
    runGit(dirPath, resolveDiscardArgs(filePath))
    return okAction()
  } catch (error) {
    return classifyGitError(error) as GitActionResult
  }
}

export function stageAllGitFiles(dirPath: string): GitActionResult {
  try {
    runGit(dirPath, ['add', '--all'])
    return okAction()
  } catch (error) {
    return classifyGitError(error) as GitActionResult
  }
}

export function unstageAllGitFiles(dirPath: string): GitActionResult {
  try {
    if (hasResolvableHead(dirPath)) {
      runGit(dirPath, ['restore', '--staged', '.'])
    } else {
      runGit(dirPath, ['rm', '--cached', '-r', '--ignore-unmatch', '.'])
    }
    return okAction()
  } catch (error) {
    return classifyGitError(error) as GitActionResult
  }
}

export function discardAllGitFiles(dirPath: string): GitActionResult {
  try {
    runGit(dirPath, resolveDiscardArgs())
    runGit(dirPath, ['clean', '-fd'])
    return okAction()
  } catch (error) {
    return classifyGitError(error) as GitActionResult
  }
}

export function commitGitChanges(dirPath: string, params: GitCommitParams): GitActionResult {
  try {
    runGit(dirPath, ['commit', '-m', params.message])
    return okAction()
  } catch (error) {
    return classifyGitError(error) as GitActionResult
  }
}

export function fetchGitChanges(dirPath: string): GitActionResult {
  try {
    runGit(dirPath, ['fetch'])
    return okAction()
  } catch (error) {
    return classifyGitError(error) as GitActionResult
  }
}

export function pushGitChanges(dirPath: string): GitActionResult {
  try {
    runGit(dirPath, ['push'])
    return okAction()
  } catch (error) {
    return classifyGitError(error) as GitActionResult
  }
}

export function pullGitChanges(dirPath: string): GitActionResult {
  try {
    runGit(dirPath, ['pull'])
    return okAction()
  } catch (error) {
    return classifyGitError(error) as GitActionResult
  }
}

function parseDecorations(rawDecorations?: string): string[] {
  if (!rawDecorations) return []
  return rawDecorations
    .split(',')
    .map(part => part.trim())
    .filter(Boolean)
}

function parseCommitLine(line: string): GitRecentCommitItem | null {
  const [hash, shortHash, subject, authorName, authoredAt, rawDecorations = '', rawParents = ''] = line.split('\x1f')
  if (!hash || !shortHash || !subject) return null
  const parentHashes = rawParents.trim() ? rawParents.trim().split(/\s+/).filter(Boolean) : []
  return {
    hash,
    shortHash,
    subject,
    authorName,
    authoredAt,
    refNames: parseDecorations(rawDecorations),
    parentHashes,
    isMergeCommit: parentHashes.length > 1,
  }
}

export function getGitRecentCommits(dirPath: string, limit = 20): GitRecentCommitsResult | GitResultFailure {
  try {
    const safeLimit = Math.max(1, Math.min(limit, 50))
    const format = ['%H', '%h', '%s', '%an', '%aI', '%D', '%P'].join('%x1f')
    const output = runGit(dirPath, ['log', '--decorate=short', `--max-count=${safeLimit}`, `--pretty=format:${format}`])
    const commits: GitRecentCommitItem[] = output
      .split('\n')
      .filter(Boolean)
      .map(parseCommitLine)
      .filter((commit): commit is GitRecentCommitItem => !!commit)

    return { ok: true, commits }
  } catch (error) {
    return classifyGitError(error)
  }
}

export function getGitCommitDiff(dirPath: string, commitHash: string): GitCommitDetailResult | GitResultFailure {
  try {
    const format = ['%H', '%h', '%s', '%an', '%aI', '%D', '%P'].join('%x1f')
    const summary = runGit(dirPath, ['show', '--decorate=short', '--no-patch', `--pretty=format:${format}`, commitHash]).trim()
    const commit = parseCommitLine(summary)
    if (!commit) {
      return { ok: false, reason: 'unknown_error', message: 'Unable to parse commit metadata' }
    }
    const diff = runGit(dirPath, ['show', '--format=', '--stat=0', commitHash])
    return { ok: true, commit, diff }
  } catch (error) {
    return classifyGitError(error)
  }
}
