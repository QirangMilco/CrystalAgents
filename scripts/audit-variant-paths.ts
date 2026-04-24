#!/usr/bin/env bun
import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative } from 'path'

const ROOT = process.cwd()
const SCAN_DIRS = ['apps', 'packages', 'scripts']
const BLOCK_PATTERNS = [
  { label: '.craft-agent', regex: /\.craft-agent(?![\w-])/g },
  { label: '.craft-agents', regex: /\.craft-agents(?![\w-])/g },
  { label: '/.craft-agent/workspaces', regex: /\/\.craft-agent\/workspaces/g },
]

const ALLOWLIST = [
  /^apps\/electron\/resources\//,
  /^apps\/electron\/packages\/shared\/src\/interceptor-common\.ts$/,
  /^apps\/electron\/electron-builder\.yml$/,
  /^apps\/electron\/eslint-rules\//,
  /^packages\/shared\/src\/config\/app-variant\.ts$/,
  /^packages\/shared\/src\/workspaces\/storage\.ts$/,
  /^packages\/shared\/src\/config\/paths\.ts$/,
  /^packages\/shared\/src\/workspaces\/data-path\.ts$/,
  /^packages\/session-tools-core\/src\//,
  /^apps\/electron\/resources\/pi-agent-server\/index\.js$/,
  /^.*\/__tests__\//,
  /^.*\.test\.[cm]?[jt]sx?$/,
  /^.*\.spec\.[cm]?[jt]sx?$/,
  /^apps\/electron\/src\/renderer\/playground\//,
  /^packages\/shared\/src\/i18n\/locales\//,
  /^scripts\/audit-variant-paths\.ts$/,
]

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.next', 'coverage'])
const TEXT_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.md', '.yml', '.yaml', '.sh'
])

function isAllowed(relPath: string): boolean {
  return ALLOWLIST.some((rule) => rule.test(relPath))
}

function shouldScanFile(path: string): boolean {
  return Array.from(TEXT_EXTENSIONS).some((ext) => path.endsWith(ext))
}

function isDocumentationLike(relPath: string): boolean {
  if (relPath.endsWith('.md') || relPath.endsWith('.yml') || relPath.endsWith('.yaml')) return true
  if (relPath.includes('/docs/') || relPath.includes('/release-notes/')) return true
  if (relPath.endsWith('/doc-links.ts') || relPath.endsWith('/print-system-prompt.ts')) return true
  return false
}

function isCommentOnlyLine(line: string): boolean {
  const trimmed = line.trim()
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*') || trimmed.startsWith('#')
}

function isCompatibilityFallback(line: string): boolean {
  return /variant\.import\.sourceConfigDirName \|\| '\.craft-agent'/.test(line)
}

function shouldIgnoreLine(relPath: string, line: string): boolean {
  if (isDocumentationLike(relPath)) return true
  if (isCommentOnlyLine(line)) return true
  if (isCompatibilityFallback(line)) return true
  if (/suggestion:\s*[`']/.test(line)) return true
  if (line.includes('APP_ROOT') && line.includes('~/.craft-agent')) return true
  if (line.includes('craft-data:/root/.craft-agent')) return true
  return false
}

function walk(dir: string, out: string[]) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      walk(full, out)
      continue
    }
    if (stat.isFile() && shouldScanFile(full)) out.push(full)
  }
}

const files: string[] = []
for (const dir of SCAN_DIRS) {
  const full = join(ROOT, dir)
  try {
    if (statSync(full).isDirectory()) walk(full, files)
  } catch {
    // ignore missing dirs
  }
}

const violations: Array<{ file: string; line: number; label: string; text: string }> = []
for (const file of files) {
  const rel = relative(ROOT, file)
  if (isAllowed(rel)) continue
  const content = readFileSync(file, 'utf-8')
  const lines = content.split('\n')
  lines.forEach((line, index) => {
    for (const pattern of BLOCK_PATTERNS) {
      if (pattern.regex.test(line)) {
        if (shouldIgnoreLine(rel, line)) {
          pattern.regex.lastIndex = 0
          continue
        }
        violations.push({ file: rel, line: index + 1, label: pattern.label, text: line.trim() })
        pattern.regex.lastIndex = 0
      }
    }
  })
}

if (violations.length === 0) {
  console.log('audit-variant-paths: no disallowed hardcoded variant paths found')
  process.exit(0)
}

console.error('audit-variant-paths: found disallowed hardcoded variant paths\n')
for (const item of violations) {
  console.error(`- ${item.file}:${item.line} [${item.label}] ${item.text}`)
}
console.error('\nUse shared variant/path APIs instead of hardcoded .craft-agent strings.')
process.exit(1)
