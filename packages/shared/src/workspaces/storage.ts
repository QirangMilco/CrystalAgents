/**
 * Workspace Storage
 *
 * CRUD operations for workspaces.
 * Workspaces can be stored anywhere on disk via rootPath.
 * Default location: ~/.craft-agent/workspaces/
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  rmSync,
  statSync,
  renameSync,
  cpSync,
  appendFileSync,
} from 'fs';
import { dirname, join } from 'path';
import { randomUUID } from 'crypto';
import { expandPath, toPortablePath } from '../utils/paths.ts';
import { atomicWriteFileSync, readJsonFileSync } from '../utils/files.ts';
import { getWorkspaceDataPath } from './data-path.ts';
import { getDefaultStatusConfig, saveStatusConfig, ensureDefaultIconFiles } from '../statuses/storage.ts';
import { getDefaultLabelConfig, saveLabelConfig } from '../labels/storage.ts';
import { loadConfigDefaults } from '../config/storage.ts';
import { CONFIG_DIR } from '../config/paths.ts';
import { getAppVariant } from '../config/app-variant.ts';
import { parsePermissionMode, PERMISSION_MODE_ORDER } from '../agent/mode-types.ts';
import { normalizeThinkingLevel } from '../agent/thinking-levels.ts';
import type {
  WorkspaceConfig,
  CreateWorkspaceInput,
  LoadedWorkspace,
  WorkspaceSummary,
} from './types.ts';

const DEFAULT_WORKSPACES_DIR = join(CONFIG_DIR, 'workspaces');

// ============================================================
// Path Utilities
// ============================================================

/**
 * Get the default workspaces directory (~/.craft-agent/workspaces/)
 */
export function getDefaultWorkspacesDir(): string {
  return DEFAULT_WORKSPACES_DIR;
}

/**
 * Ensure default workspaces directory exists
 */
export function ensureDefaultWorkspacesDir(): void {
  if (!existsSync(DEFAULT_WORKSPACES_DIR)) {
    mkdirSync(DEFAULT_WORKSPACES_DIR, { recursive: true });
  }
}

/**
 * Get workspace root path from ID
 * @param workspaceId - Workspace ID
 * @returns Absolute path to workspace root in default location
 */
export function getWorkspacePath(workspaceId: string): string {
  return join(DEFAULT_WORKSPACES_DIR, workspaceId);
}

/**
 * Get path to workspace sources directory
 * @param rootPath - Absolute path to workspace root folder
 */
export function getWorkspaceSourcesPath(rootPath: string): string {
  return join(getWorkspaceDataPath(rootPath), 'sources');
}

/**
 * Get path to workspace sessions directory
 * @param rootPath - Absolute path to workspace root folder
 */
export function getWorkspaceSessionsPath(rootPath: string): string {
  return join(getWorkspaceDataPath(rootPath), 'sessions');
}

/**
 * Get path to workspace skills directory
 * @param rootPath - Absolute path to workspace root folder
 */
export function getWorkspaceSkillsPath(rootPath: string): string {
  return join(getWorkspaceDataPath(rootPath), 'skills');
}

/**
 * Get path to workspace-scoped config.json stored under the workspace data dir.
 */
export function getWorkspaceConfigPath(rootPath: string): string {
  return join(getWorkspaceDataPath(rootPath), 'config.json');
}

/**
 * Get path to workspace SDK plugin manifest stored under the workspace data dir.
 */
export function getWorkspacePluginManifestPath(rootPath: string): string {
  return join(getWorkspaceDataPath(rootPath), '.claude-plugin', 'plugin.json');
}

// ============================================================
// Config Operations
// ============================================================

/**
 * Load workspace config.json from a workspace folder
 * @param rootPath - Absolute path to workspace root folder
 */
export function loadWorkspaceConfig(rootPath: string): WorkspaceConfig | null {
  const configPath = getWorkspaceConfigPath(rootPath);
  if (!existsSync(configPath)) return null;

  try {
    const config = readJsonFileSync<WorkspaceConfig>(configPath);

    // Expand path variables in defaults for portability
    if (config.defaults?.workingDirectory) {
      config.defaults.workingDirectory = expandPath(config.defaults.workingDirectory);
    }

    // Compatibility: accept canonical or legacy permission mode names on read
    if (config.defaults?.permissionMode && typeof config.defaults.permissionMode === 'string') {
      const parsed = parsePermissionMode(config.defaults.permissionMode);
      config.defaults.permissionMode = parsed ?? undefined;
    }

    if (Array.isArray(config.defaults?.cyclablePermissionModes)) {
      const normalized = config.defaults.cyclablePermissionModes
        .map(mode => (typeof mode === 'string' ? parsePermissionMode(mode) : null))
        .filter((mode): mode is NonNullable<typeof mode> => !!mode)
        .filter((mode, index, arr) => arr.indexOf(mode) === index);

      config.defaults.cyclablePermissionModes = normalized.length >= 2
        ? normalized
        : [...PERMISSION_MODE_ORDER];
    }

    if (config.defaults && 'thinkingLevel' in config.defaults) {
      // TODO: Remove legacy 'think' normalization after old persisted workspace configs
      // have realistically aged out across upgrades.
      config.defaults.thinkingLevel = normalizeThinkingLevel(config.defaults.thinkingLevel);
    }

    return config;
  } catch {
    return null;
  }
}

/**
 * Save workspace config.json to a workspace folder
 * @param rootPath - Absolute path to workspace root folder
 */
export function saveWorkspaceConfig(rootPath: string, config: WorkspaceConfig): void {
  if (!existsSync(rootPath)) {
    mkdirSync(rootPath, { recursive: true });
  }

  // Convert paths to portable form for cross-machine compatibility
  const storageConfig: WorkspaceConfig = {
    ...config,
    updatedAt: Date.now(),
  };

  if (storageConfig.defaults?.workingDirectory) {
    storageConfig.defaults = {
      ...storageConfig.defaults,
      workingDirectory: toPortablePath(storageConfig.defaults.workingDirectory),
    };
  }

  // Use atomic write to prevent corruption on crash/interrupt
  const configPath = getWorkspaceConfigPath(rootPath);
  mkdirSync(dirname(configPath), { recursive: true });
  atomicWriteFileSync(configPath, JSON.stringify(storageConfig, null, 2));
}

// ============================================================
// Load Operations
// ============================================================

/**
 * Count subdirectories in a path
 */
function countSubdirs(dirPath: string): number {
  if (!existsSync(dirPath)) return 0;
  try {
    return readdirSync(dirPath, { withFileTypes: true }).filter((d) => d.isDirectory()).length;
  } catch {
    return 0;
  }
}

/**
 * List subdirectory names in a path
 */
function listSubdirNames(dirPath: string): string[] {
  if (!existsSync(dirPath)) return [];
  try {
    return readdirSync(dirPath, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

/**
 * Load workspace with summary info from a rootPath
 * @param rootPath - Absolute path to workspace root folder
 */
export function loadWorkspace(rootPath: string): LoadedWorkspace | null {
  const config = loadWorkspaceConfig(rootPath);
  if (!config) return null;

  // Ensure plugin manifest exists (migration for existing workspaces)
  ensurePluginManifest(rootPath, config.name);

  // Ensure workspace data directories exist for the current format.
  // Legacy runtime data migration is user-triggered only.
  ensureWorkspaceDataDirectories(rootPath);

  return {
    config,
    sourceSlugs: listSubdirNames(getWorkspaceSourcesPath(rootPath)),
    sessionCount: countSubdirs(getWorkspaceSessionsPath(rootPath)),
  };
}

/**
 * Get workspace summary from a rootPath
 * @param rootPath - Absolute path to workspace root folder
 */
export function getWorkspaceSummary(rootPath: string): WorkspaceSummary | null {
  const config = loadWorkspaceConfig(rootPath);
  if (!config) return null;

  return {
    slug: config.slug,
    name: config.name,
    sourceCount: countSubdirs(getWorkspaceSourcesPath(rootPath)),
    sessionCount: countSubdirs(getWorkspaceSessionsPath(rootPath)),
    createdAt: config.createdAt,
    updatedAt: config.updatedAt,
  };
}

// ============================================================
// Create/Delete Operations
// ============================================================

/**
 * Generate URL-safe slug from name
 */
export function generateSlug(name: string): string {
  let slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 50);

  if (!slug) {
    slug = 'workspace';
  }

  return slug;
}

/**
 * Generate a unique folder path for a workspace by appending a numeric suffix
 * if the slug-based folder already exists.
 * E.g., "my-workspace", "my-workspace-2", "my-workspace-3", ...
 *
 * @param name - Display name to derive the slug from
 * @param baseDir - Parent directory where workspace folders live (e.g., ~/.craft-agent/workspaces/)
 * @returns Full path to a unique, non-existing folder
 */
export function generateUniqueWorkspacePath(name: string, baseDir: string): string {
  const slug = generateSlug(name);
  let candidate = join(baseDir, slug);

  if (!existsSync(candidate)) {
    return candidate;
  }

  // Append numeric suffix until we find a non-existing path
  let counter = 2;
  while (existsSync(join(baseDir, `${slug}-${counter}`))) {
    counter++;
  }

  return join(baseDir, `${slug}-${counter}`);
}

/**
 * Create workspace folder structure at a given path
 * @param rootPath - Absolute path where workspace folder will be created
 * @param name - Display name for the workspace
 * @param defaults - Optional default settings for new sessions
 * @returns The created WorkspaceConfig
 */
export function createWorkspaceAtPath(
  rootPath: string,
  name: string,
  defaults?: WorkspaceConfig['defaults']
): WorkspaceConfig {
  const now = Date.now();
  const slug = generateSlug(name);

  // Load global defaults from config-defaults.json
  const globalDefaults = loadConfigDefaults();

  // Merge global defaults with provided defaults
  // AI settings (model, thinkingLevel, defaultLlmConnection) are left undefined
  // so they fall back to app-level defaults
  const workspaceDefaults: WorkspaceConfig['defaults'] = {
    model: undefined,
    thinkingLevel: undefined,
    // defaultLlmConnection: undefined - falls back to app default
    permissionMode: globalDefaults.workspaceDefaults.permissionMode,
    cyclablePermissionModes: globalDefaults.workspaceDefaults.cyclablePermissionModes,
    enabledSourceSlugs: [],
    workingDirectory: undefined,
    ...defaults, // User-provided defaults override global defaults
  };

  const config: WorkspaceConfig = {
    id: `ws_${randomUUID().slice(0, 8)}`,
    name,
    slug,
    defaults: workspaceDefaults,
    localMcpServers: globalDefaults.workspaceDefaults.localMcpServers,
    createdAt: now,
    updatedAt: now,
  };

  // Create workspace directory structure
  mkdirSync(rootPath, { recursive: true });
  ensureWorkspaceDataDirectories(rootPath);

  // Save config
  saveWorkspaceConfig(rootPath, config);

  // Initialize status configuration with defaults
  saveStatusConfig(rootPath, getDefaultStatusConfig());
  ensureDefaultIconFiles(rootPath);

  // Initialize label configuration with defaults (two nested groups + valued labels)
  saveLabelConfig(rootPath, getDefaultLabelConfig());

  // Initialize plugin manifest for SDK integration (enables skills, commands, agents)
  ensurePluginManifest(rootPath, name);

  return config;
}

/**
 * Delete a workspace folder and all its contents
 * @param rootPath - Absolute path to workspace root folder
 */
export function deleteWorkspaceFolder(rootPath: string): boolean {
  if (!existsSync(rootPath)) return false;

  try {
    rmSync(rootPath, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a valid workspace exists at a path
 * @param rootPath - Absolute path to check
 */
export function isValidWorkspace(rootPath: string): boolean {
  return existsSync(getWorkspaceConfigPath(rootPath));
}

/**
 * Rename a workspace (updates config.json in the workspace folder)
 * @param rootPath - Absolute path to workspace root folder
 * @param newName - New display name
 */
export function renameWorkspaceFolder(rootPath: string, newName: string): boolean {
  const config = loadWorkspaceConfig(rootPath);
  if (!config) return false;

  config.name = newName.trim();
  saveWorkspaceConfig(rootPath, config);
  return true;
}

// ============================================================
// Auto-Discovery (for default workspace location)
// ============================================================

/**
 * Discover workspace folders in the default location that have valid config.json
 * Returns paths to valid workspaces found in ~/.craft-agent/workspaces/
 */
export function discoverWorkspacesInDefaultLocation(): string[] {
  const discovered: string[] = [];

  if (!existsSync(DEFAULT_WORKSPACES_DIR)) {
    return discovered;
  }

  try {
    const entries = readdirSync(DEFAULT_WORKSPACES_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const rootPath = join(DEFAULT_WORKSPACES_DIR, entry.name);
      if (isValidWorkspace(rootPath)) {
        discovered.push(rootPath);
      }
    }
  } catch {
    // Ignore errors scanning directory
  }

  return discovered;
}

// ============================================================
// Workspace Color Theme
// ============================================================

/**
 * Get the color theme setting for a workspace.
 * Returns undefined if workspace uses the app default.
 *
 * @param rootPath - Absolute path to workspace root folder
 * @returns Theme ID or undefined (inherit from app default)
 */
export function getWorkspaceColorTheme(rootPath: string): string | undefined {
  const config = loadWorkspaceConfig(rootPath);
  return config?.defaults?.colorTheme;
}

/**
 * Set the color theme for a workspace.
 * Pass undefined to clear and use app default.
 *
 * @param rootPath - Absolute path to workspace root folder
 * @param themeId - Preset theme ID or undefined to inherit
 */
export function setWorkspaceColorTheme(rootPath: string, themeId: string | undefined): void {
  const config = loadWorkspaceConfig(rootPath);
  if (!config) return;

  // Validate theme ID if provided (skip for undefined = inherit default)
  // Only allow alphanumeric characters, hyphens, and underscores (max 64 chars)
  if (themeId && themeId !== 'default') {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(themeId)) {
      console.warn(`[workspace-storage] Invalid theme ID rejected: ${themeId}`);
      return;
    }
  }

  // Initialize defaults if not present
  if (!config.defaults) {
    config.defaults = {};
  }

  if (themeId) {
    config.defaults.colorTheme = themeId;
  } else {
    delete config.defaults.colorTheme;
  }

  saveWorkspaceConfig(rootPath, config);
}

// ============================================================
// Local MCP Configuration
// ============================================================

/**
 * Check if local (stdio) MCP servers are enabled for a workspace.
 * Resolution order: ENV (CRAFT_LOCAL_MCP_ENABLED) > workspace config > default (true)
 *
 * @param rootPath - Absolute path to workspace root folder
 * @returns true if local MCP servers should be enabled
 */
export function isLocalMcpEnabled(rootPath: string): boolean {
  // 1. Environment variable override (highest priority)
  const envValue = process.env.CRAFT_LOCAL_MCP_ENABLED;
  if (envValue !== undefined) {
    return envValue.toLowerCase() === 'true';
  }

  // 2. Workspace config
  const config = loadWorkspaceConfig(rootPath);
  if (config?.localMcpServers?.enabled !== undefined) {
    return config.localMcpServers.enabled;
  }

  // 3. Default: enabled
  return true;
}

// ============================================================
// Exports
// ============================================================

// ============================================================
// Plugin Manifest (for SDK plugin integration)
// ============================================================

/**
 * Ensure workspace has a .claude-plugin/plugin.json manifest.
 * This allows the workspace to be loaded as an SDK plugin,
 * enabling skills, commands, and agents from the workspace.
 *
 * @param rootPath - Absolute path to workspace root folder
 * @param workspaceName - Display name for the workspace (used in plugin name)
 */
export function ensurePluginManifest(rootPath: string, workspaceName: string): void {
  const manifestPath = getWorkspacePluginManifestPath(rootPath);
  if (existsSync(manifestPath)) return;

  const pluginDir = dirname(manifestPath);
  if (!existsSync(pluginDir)) {
    mkdirSync(pluginDir, { recursive: true });
  }

  // Create minimal plugin manifest
  const manifest = {
    name: `craft-workspace-${workspaceName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    version: '1.0.0',
  };

  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}

const OFFICIAL_WORKSPACE_DATA_DIR = getAppVariant().import.sourceConfigDirName || '.craft-agent';

const LEGACY_WORKSPACE_DATA_DIRS = [
  'sources',
  'sessions',
  'skills',
  'labels',
  'statuses',
] as const;

const LEGACY_WORKSPACE_DATA_FILES = [
  'permissions.json',
  'views.json',
  'automations.json',
  'automations-history.jsonl',
  'automations-retry-queue.jsonl',
  'events.jsonl',
] as const;

function ensureWorkspaceDataDirectories(rootPath: string): void {
  mkdirSync(getWorkspaceDataPath(rootPath), { recursive: true });
  mkdirSync(getWorkspaceSourcesPath(rootPath), { recursive: true });
  mkdirSync(getWorkspaceSessionsPath(rootPath), { recursive: true });
  mkdirSync(getWorkspaceSkillsPath(rootPath), { recursive: true });
}

function buildBackupName(name: string): string {
  return `${name}.legacy-backup-${Date.now()}`;
}

/**
 * 检测是否为官方 Craft Agents 管理过的工作区：
 * 1) 显式标记：存在 .craft-agent
 * 2) 隐式结构：存在 legacy 目录/文件（sessions/skills/sources/...）
 */
export interface LegacyWorkspaceDetectionResult {
  hasLegacyData: boolean;
  officialDataDir: string;
  workspaceDataDir: string;
  detectedEntries: Array<{
    name: string;
    sourcePath: string;
    targetPath: string;
    kind: 'official-dir' | 'official-file' | 'legacy-dir' | 'legacy-file';
    targetExists: boolean;
  }>;
  previewGroups: WorkspaceRecordImportPreviewGroup[];
}

export type WorkspaceRecordImportCategory =
  | 'sources'
  | 'sessions'
  | 'skills'
  | 'labels'
  | 'statuses'
  | 'permissions'
  | 'views'
  | 'automations'
  | 'automations-history'
  | 'automations-retry-queue'
  | 'events';

export interface WorkspaceRecordImportPreviewItem {
  id: string;
  name: string;
  sourcePath: string;
  targetPath: string;
  targetExists: boolean;
  kind: 'dir' | 'file';
}

export interface WorkspaceRecordImportPreviewGroup {
  id: WorkspaceRecordImportCategory;
  name: string;
  sourcePath: string;
  targetPath: string;
  kind: 'dir' | 'file';
  targetExists: boolean;
  totalCount: number;
  importableCount: number;
  skippedCount: number;
  items: WorkspaceRecordImportPreviewItem[];
}

export interface WorkspaceRecordImportStatus {
  sourcePath: string;
  workspaceDataDir: string;
  sourceExists: boolean;
  sourceIsDirectory: boolean;
  hasImportableData: boolean;
  availableEntries: Array<{
    name: string;
    sourcePath: string;
    targetPath: string;
    kind: 'dir' | 'file';
    targetExists: boolean;
  }>;
  missingEntries: string[];
  previewGroups: WorkspaceRecordImportPreviewGroup[];
  message?: string;
}

export interface WorkspaceRecordImportResult {
  sourcePath: string;
  workspaceDataDir: string;
  imported: string[];
  skipped: string[];
  warnings: string[];
  results: Array<{
    category: WorkspaceRecordImportCategory | 'unknown';
    name: string;
    status: 'imported' | 'skipped' | 'missing' | 'failed';
    detail: string;
  }>;
  previewGroups: WorkspaceRecordImportPreviewGroup[];
  hasImportableData: boolean;
}

const IMPORT_GROUP_META: Record<WorkspaceRecordImportCategory, { name: string; kind: 'dir' | 'file' }> = {
  sources: { name: 'Sources', kind: 'dir' },
  sessions: { name: 'Sessions', kind: 'dir' },
  skills: { name: 'Skills', kind: 'dir' },
  labels: { name: 'Labels', kind: 'dir' },
  statuses: { name: 'Statuses', kind: 'dir' },
  permissions: { name: 'Permissions', kind: 'file' },
  views: { name: 'Views', kind: 'file' },
  automations: { name: 'Automations', kind: 'file' },
  'automations-history': { name: 'Automation history', kind: 'file' },
  'automations-retry-queue': { name: 'Automation retry queue', kind: 'file' },
  events: { name: 'Events', kind: 'file' },
};

function getCategoryForEntryName(name: string): WorkspaceRecordImportCategory {
  switch (name) {
    case 'sources': return 'sources';
    case 'sessions': return 'sessions';
    case 'skills': return 'skills';
    case 'labels': return 'labels';
    case 'statuses': return 'statuses';
    case 'permissions.json': return 'permissions';
    case 'views.json': return 'views';
    case 'automations.json': return 'automations';
    case 'automations-history.jsonl': return 'automations-history';
    case 'automations-retry-queue.jsonl': return 'automations-retry-queue';
    case 'events.jsonl':
    default:
      return 'events';
  }
}

function safeReadJson(filePath: string): unknown | null {
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

function countJsonlRecords(filePath: string): number {
  try {
    return readFileSync(filePath, 'utf-8').split('\n').filter(line => line.trim().length > 0).length;
  } catch {
    return 0;
  }
}

function isMergeableJsonlCategory(category: WorkspaceRecordImportCategory): boolean {
  return category === 'events'
    || category === 'automations-history'
    || category === 'automations-retry-queue';
}

function mergeJsonlFile(sourcePath: string, targetPath: string): { appendedLines: number; duplicateLines: number; changed: boolean } {
  const sourceText = readFileSync(sourcePath, 'utf-8');
  const sourceLines = sourceText.split('\n').filter(line => line.trim().length > 0);
  if (sourceLines.length === 0) {
    return { appendedLines: 0, duplicateLines: 0, changed: false };
  }

  mkdirSync(dirname(targetPath), { recursive: true });
  if (!existsSync(targetPath)) {
    writeFileSync(targetPath, `${sourceLines.join('\n')}\n`);
    return { appendedLines: sourceLines.length, duplicateLines: 0, changed: true };
  }

  const targetText = readFileSync(targetPath, 'utf-8');
  const existingLines = targetText.split('\n').filter(line => line.trim().length > 0);
  const seen = new Set(existingLines);
  const linesToAppend: string[] = [];
  let duplicateLines = 0;

  for (const line of sourceLines) {
    if (seen.has(line)) {
      duplicateLines += 1;
      continue;
    }
    seen.add(line);
    linesToAppend.push(line);
  }

  if (linesToAppend.length === 0) {
    return { appendedLines: 0, duplicateLines, changed: false };
  }

  const needsLeadingNewline = targetText.length > 0 && !targetText.endsWith('\n');
  const payload = `${needsLeadingNewline ? '\n' : ''}${linesToAppend.join('\n')}\n`;
  appendFileSync(targetPath, payload);
  return { appendedLines: linesToAppend.length, duplicateLines, changed: true };
}

function buildSessionPreviewItems(sourcePath: string, targetPath: string): WorkspaceRecordImportPreviewItem[] {
  if (!existsSync(sourcePath) || !statSync(sourcePath).isDirectory()) return [];

  const items: WorkspaceRecordImportPreviewItem[] = [];
  for (const entry of readdirSync(sourcePath, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const sessionDir = join(sourcePath, entry.name);
    const sessionFile = join(sessionDir, 'session.jsonl');
    if (!existsSync(sessionFile)) continue;
    items.push({
      id: entry.name,
      name: entry.name,
      sourcePath: sessionDir,
      targetPath: join(targetPath, entry.name),
      targetExists: existsSync(join(targetPath, entry.name)),
      kind: 'dir',
    });
  }
  return items;
}

function buildSlugDirPreviewItems(sourcePath: string, targetPath: string, requiredFile: string): WorkspaceRecordImportPreviewItem[] {
  if (!existsSync(sourcePath) || !statSync(sourcePath).isDirectory()) return [];

  const items: WorkspaceRecordImportPreviewItem[] = [];
  for (const entry of readdirSync(sourcePath, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const itemDir = join(sourcePath, entry.name);
    if (!existsSync(join(itemDir, requiredFile))) continue;
    items.push({
      id: entry.name,
      name: entry.name,
      sourcePath: itemDir,
      targetPath: join(targetPath, entry.name),
      targetExists: existsSync(join(targetPath, entry.name)),
      kind: 'dir',
    });
  }
  return items;
}

function buildSingleFilePreviewItem(sourcePath: string, targetPath: string, name: string): WorkspaceRecordImportPreviewItem[] {
  if (!existsSync(sourcePath) || !statSync(sourcePath).isFile()) return [];
  return [{
    id: name,
    name,
    sourcePath,
    targetPath,
    targetExists: existsSync(targetPath),
    kind: 'file',
  }];
}

function buildNamedJsonItems(
  sourcePath: string,
  targetPath: string,
  fileName: string,
  names: string[],
  targetExists: boolean,
): WorkspaceRecordImportPreviewItem[] {
  return names.map((name, index) => ({
    id: `${fileName}:${index}`,
    name,
    sourcePath,
    targetPath,
    targetExists,
    kind: 'file',
  }));
}

function buildPreviewItemsForEntry(category: WorkspaceRecordImportCategory, sourcePath: string, targetPath: string): WorkspaceRecordImportPreviewItem[] {
  switch (category) {
    case 'sessions':
      return buildSessionPreviewItems(sourcePath, targetPath);
    case 'sources':
      return buildSlugDirPreviewItems(sourcePath, targetPath, 'config.json');
    case 'skills':
      return buildSlugDirPreviewItems(sourcePath, targetPath, 'SKILL.md');
    case 'labels': {
      const filePath = join(sourcePath, 'config.json');
      const raw = safeReadJson(filePath) as { labels?: Array<{ id?: string; name?: string }> } | null;
      const names = raw?.labels?.map((label, index) => label.name || label.id || `label-${index + 1}`) ?? [];
      return names.length > 0
        ? buildNamedJsonItems(filePath, filePath.replace(sourcePath, targetPath), 'labels/config.json', names, existsSync(targetPath))
        : buildSingleFilePreviewItem(filePath, join(targetPath, 'config.json'), 'labels/config.json');
    }
    case 'statuses': {
      const filePath = join(sourcePath, 'config.json');
      const raw = safeReadJson(filePath) as { statuses?: Array<{ id?: string; name?: string }> } | null;
      const names = raw?.statuses?.map((status, index) => status.name || status.id || `status-${index + 1}`) ?? [];
      return names.length > 0
        ? buildNamedJsonItems(filePath, filePath.replace(sourcePath, targetPath), 'statuses/config.json', names, existsSync(targetPath))
        : buildSingleFilePreviewItem(filePath, join(targetPath, 'config.json'), 'statuses/config.json');
    }
    case 'automations': {
      const raw = safeReadJson(sourcePath) as { automations?: Record<string, Array<{ id?: string; name?: string }>> } | null;
      const names = raw?.automations
        ? Object.values(raw.automations).flatMap((items) => items.map((item, index) => item.name || item.id || `automation-${index + 1}`))
        : [];
      return names.length > 0
        ? buildNamedJsonItems(sourcePath, targetPath, 'automations.json', names, existsSync(targetPath))
        : buildSingleFilePreviewItem(sourcePath, targetPath, 'automations.json');
    }
    case 'views': {
      const raw = safeReadJson(sourcePath) as { views?: Array<{ name?: string; id?: string }> } | Array<{ name?: string; id?: string }> | null;
      const views = Array.isArray(raw) ? raw : raw?.views;
      const names = views?.map((view, index) => view.name || view.id || `view-${index + 1}`) ?? [];
      return names.length > 0
        ? buildNamedJsonItems(sourcePath, targetPath, 'views.json', names, existsSync(targetPath))
        : buildSingleFilePreviewItem(sourcePath, targetPath, 'views.json');
    }
    case 'permissions':
      return buildSingleFilePreviewItem(sourcePath, targetPath, 'permissions.json');
    case 'automations-history': {
      const count = countJsonlRecords(sourcePath);
      const names = count > 0 ? Array.from({ length: count }, (_, index) => `history-${index + 1}`) : [];
      return names.length > 0
        ? buildNamedJsonItems(sourcePath, targetPath, 'automations-history.jsonl', names, existsSync(targetPath))
        : buildSingleFilePreviewItem(sourcePath, targetPath, 'automations-history.jsonl');
    }
    case 'automations-retry-queue': {
      const count = countJsonlRecords(sourcePath);
      const names = count > 0 ? Array.from({ length: count }, (_, index) => `retry-${index + 1}`) : [];
      return names.length > 0
        ? buildNamedJsonItems(sourcePath, targetPath, 'automations-retry-queue.jsonl', names, existsSync(targetPath))
        : buildSingleFilePreviewItem(sourcePath, targetPath, 'automations-retry-queue.jsonl');
    }
    case 'events': {
      const count = countJsonlRecords(sourcePath);
      const names = count > 0 ? Array.from({ length: count }, (_, index) => `event-${index + 1}`) : [];
      return names.length > 0
        ? buildNamedJsonItems(sourcePath, targetPath, 'events.jsonl', names, existsSync(targetPath))
        : buildSingleFilePreviewItem(sourcePath, targetPath, 'events.jsonl');
    }
  }
}

function createPreviewGroup(
  category: WorkspaceRecordImportCategory,
  sourcePath: string,
  targetPath: string,
  targetExists: boolean,
): WorkspaceRecordImportPreviewGroup {
  const meta = IMPORT_GROUP_META[category];
  const items = buildPreviewItemsForEntry(category, sourcePath, targetPath);
  const totalCount = items.length;
  const skippedCount = items.filter(item => item.targetExists).length;
  return {
    id: category,
    name: meta.name,
    sourcePath,
    targetPath,
    kind: meta.kind,
    targetExists,
    totalCount,
    importableCount: Math.max(0, totalCount - skippedCount),
    skippedCount,
    items,
  };
}

function mergePreviewGroups(groups: WorkspaceRecordImportPreviewGroup[]): WorkspaceRecordImportPreviewGroup[] {
  const merged = new Map<WorkspaceRecordImportCategory, WorkspaceRecordImportPreviewGroup>();

  for (const group of groups) {
    const existing = merged.get(group.id);
    if (!existing) {
      merged.set(group.id, { ...group, items: [...group.items] });
      continue;
    }

    const seen = new Set(existing.items.map(item => item.targetPath));
    for (const item of group.items) {
      if (seen.has(item.targetPath)) continue;
      existing.items.push(item);
      seen.add(item.targetPath);
    }
    existing.totalCount = existing.items.length;
    existing.skippedCount = existing.items.filter(item => item.targetExists).length;
    existing.importableCount = Math.max(0, existing.totalCount - existing.skippedCount);
    existing.targetExists = existing.items.length > 0 ? existing.items.every(item => item.targetExists) : existing.targetExists;
  }

  return Array.from(merged.values());
}

function detectWorkspaceRecordImportStatusFromCandidates(
  rootPath: string,
  sourcePath: string,
  candidates: Array<{ basePath: string; kindPrefix?: 'official' | 'legacy' }>,
): WorkspaceRecordImportStatus {
  const workspaceDataDir = getWorkspaceDataPath(rootPath);
  const availableEntries: WorkspaceRecordImportStatus['availableEntries'] = [];
  const missingEntries = new Set<string>();
  const previewGroups: WorkspaceRecordImportPreviewGroup[] = [];

  for (const dirName of LEGACY_WORKSPACE_DATA_DIRS) {
    let found = false;
    for (const candidate of candidates) {
      const sourceEntry = join(candidate.basePath, dirName);
      if (existsSync(sourceEntry) && statSync(sourceEntry).isDirectory()) {
        const targetPath = join(workspaceDataDir, dirName);
        availableEntries.push({
          name: dirName,
          sourcePath: sourceEntry,
          targetPath,
          kind: 'dir',
          targetExists: existsSync(targetPath),
        });
        previewGroups.push(createPreviewGroup(getCategoryForEntryName(dirName), sourceEntry, targetPath, existsSync(targetPath)));
        found = true;
      }
    }
    if (!found) missingEntries.add(dirName);
  }

  for (const fileName of LEGACY_WORKSPACE_DATA_FILES) {
    let found = false;
    for (const candidate of candidates) {
      const sourceEntry = join(candidate.basePath, fileName);
      if (existsSync(sourceEntry) && statSync(sourceEntry).isFile()) {
        const targetPath = join(workspaceDataDir, fileName);
        availableEntries.push({
          name: fileName,
          sourcePath: sourceEntry,
          targetPath,
          kind: 'file',
          targetExists: existsSync(targetPath),
        });
        previewGroups.push(createPreviewGroup(getCategoryForEntryName(fileName), sourceEntry, targetPath, existsSync(targetPath)));
        found = true;
        break;
      }
    }
    if (!found) missingEntries.add(fileName);
  }

  const mergedPreviewGroups = mergePreviewGroups(previewGroups).filter(group => group.totalCount > 0);

  return {
    sourcePath,
    workspaceDataDir,
    sourceExists: true,
    sourceIsDirectory: true,
    hasImportableData: mergedPreviewGroups.some(group => group.totalCount > 0),
    availableEntries,
    missingEntries: Array.from(missingEntries),
    previewGroups: mergedPreviewGroups,
  };
}

function isOfficialManagedWorkspace(rootPath: string): boolean {
  const explicitDir = join(rootPath, OFFICIAL_WORKSPACE_DATA_DIR);
  if (existsSync(explicitDir) && statSync(explicitDir).isDirectory()) {
    return true;
  }

  for (const dirName of LEGACY_WORKSPACE_DATA_DIRS) {
    const p = join(rootPath, dirName);
    if (existsSync(p) && statSync(p).isDirectory()) {
      return true;
    }
  }

  for (const fileName of LEGACY_WORKSPACE_DATA_FILES) {
    const p = join(rootPath, fileName);
    if (existsSync(p) && statSync(p).isFile()) {
      return true;
    }
  }

  return false;
}

export function detectLegacyWorkspaceData(rootPath: string): LegacyWorkspaceDetectionResult {
  const dataDir = getWorkspaceDataPath(rootPath);
  const officialDataDir = join(rootPath, OFFICIAL_WORKSPACE_DATA_DIR);
  const detectedEntries: LegacyWorkspaceDetectionResult['detectedEntries'] = [];

  for (const dirName of LEGACY_WORKSPACE_DATA_DIRS) {
    const sourcePath = join(officialDataDir, dirName);
    if (existsSync(sourcePath)) {
      detectedEntries.push({
        name: dirName,
        sourcePath,
        targetPath: join(dataDir, dirName),
        kind: 'official-dir',
        targetExists: existsSync(join(dataDir, dirName)),
      });
    }
  }

  for (const fileName of LEGACY_WORKSPACE_DATA_FILES) {
    const sourcePath = join(officialDataDir, fileName);
    if (existsSync(sourcePath)) {
      detectedEntries.push({
        name: fileName,
        sourcePath,
        targetPath: join(dataDir, fileName),
        kind: 'official-file',
        targetExists: existsSync(join(dataDir, fileName)),
      });
    }
  }

  for (const dirName of LEGACY_WORKSPACE_DATA_DIRS) {
    const sourcePath = join(rootPath, dirName);
    if (existsSync(sourcePath)) {
      detectedEntries.push({
        name: dirName,
        sourcePath,
        targetPath: join(dataDir, dirName),
        kind: 'legacy-dir',
        targetExists: existsSync(join(dataDir, dirName)),
      });
    }
  }

  for (const fileName of LEGACY_WORKSPACE_DATA_FILES) {
    const sourcePath = join(rootPath, fileName);
    if (existsSync(sourcePath)) {
      detectedEntries.push({
        name: fileName,
        sourcePath,
        targetPath: join(dataDir, fileName),
        kind: 'legacy-file',
        targetExists: existsSync(join(dataDir, fileName)),
      });
    }
  }

  const previewStatus = detectWorkspaceRecordImportStatusFromCandidates(rootPath, officialDataDir, [
    { basePath: officialDataDir, kindPrefix: 'official' },
    { basePath: rootPath, kindPrefix: 'legacy' },
  ]);

  return {
    hasLegacyData: detectedEntries.length > 0,
    officialDataDir,
    workspaceDataDir: dataDir,
    detectedEntries,
    previewGroups: previewStatus.previewGroups,
  };
}

export function detectWorkspaceRecordImportStatus(rootPath: string, sourcePath: string): WorkspaceRecordImportStatus {
  const workspaceDataDir = getWorkspaceDataPath(rootPath);

  if (!sourcePath || !sourcePath.trim()) {
    return {
      sourcePath,
      workspaceDataDir,
      sourceExists: false,
      sourceIsDirectory: false,
      hasImportableData: false,
      availableEntries: [],
      missingEntries: [...LEGACY_WORKSPACE_DATA_DIRS, ...LEGACY_WORKSPACE_DATA_FILES],
      previewGroups: [],
      message: 'Source path is empty.',
    };
  }

  const sourceExists = existsSync(sourcePath);
  const sourceIsDirectory = sourceExists ? statSync(sourcePath).isDirectory() : false;
  if (!sourceExists || !sourceIsDirectory) {
    return {
      sourcePath,
      workspaceDataDir,
      sourceExists,
      sourceIsDirectory,
      hasImportableData: false,
      availableEntries: [],
      missingEntries: [...LEGACY_WORKSPACE_DATA_DIRS, ...LEGACY_WORKSPACE_DATA_FILES],
      previewGroups: [],
      message: !sourceExists ? 'Source path does not exist.' : 'Source path is not a directory.',
    };
  }

  return detectWorkspaceRecordImportStatusFromCandidates(rootPath, sourcePath, [{ basePath: sourcePath }]);
}

function buildImportResultFromStatus(
  status: WorkspaceRecordImportStatus,
  abortDetail?: string,
): WorkspaceRecordImportResult {
  const results: WorkspaceRecordImportResult['results'] = [];
  const imported: string[] = [];
  const skipped: string[] = [];
  const warnings: string[] = [];

  if (!status.sourceExists || !status.sourceIsDirectory || !status.hasImportableData) {
    if (status.message) warnings.push(status.message);
    for (const name of status.missingEntries) {
      results.push({
        category: getCategoryForEntryName(name),
        name,
        status: 'missing',
        detail: 'Entry not found in selected source directory.',
      });
    }
    return {
      sourcePath: status.sourcePath,
      workspaceDataDir: status.workspaceDataDir,
      imported,
      skipped,
      warnings,
      results,
      previewGroups: status.previewGroups,
      hasImportableData: false,
    };
  }

  if (abortDetail) {
    warnings.push(abortDetail);
    return {
      sourcePath: status.sourcePath,
      workspaceDataDir: status.workspaceDataDir,
      imported,
      skipped,
      warnings,
      results: [{ category: 'unknown', name: '.', status: 'failed', detail: abortDetail }],
      previewGroups: status.previewGroups,
      hasImportableData: true,
    };
  }

  mkdirSync(status.workspaceDataDir, { recursive: true });

  for (const group of status.previewGroups) {
    const isMergeableJsonlGroup = group.kind === 'file' && isMergeableJsonlCategory(group.id);
    const mergedFilePaths = new Set<string>();

    for (const item of group.items) {
      if (isMergeableJsonlGroup) {
        if (mergedFilePaths.has(item.targetPath)) continue;
        mergedFilePaths.add(item.targetPath);

        try {
          const mergeResult = mergeJsonlFile(item.sourcePath, item.targetPath);
          if (!mergeResult.changed) {
            skipped.push(`${group.id}:${item.name}`);
            results.push({
              category: group.id,
              name: item.name,
              status: 'skipped',
              detail: mergeResult.duplicateLines > 0
                ? `All ${mergeResult.duplicateLines} JSONL record(s) already exist in target file; nothing was merged.`
                : 'Source JSONL file is empty; nothing was merged.',
            });
            continue;
          }

          imported.push(`${group.id}:${item.name}`);
          results.push({
            category: group.id,
            name: item.name,
            status: 'imported',
            detail: item.targetExists
              ? `Merged ${mergeResult.appendedLines} new JSONL record(s) into existing target file; skipped ${mergeResult.duplicateLines} duplicate record(s).`
              : `Imported ${mergeResult.appendedLines} JSONL record(s) into new target file.`,
          });
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          warnings.push(`${item.name}: ${detail}`);
          results.push({
            category: group.id,
            name: item.name,
            status: 'failed',
            detail,
          });
        }
        continue;
      }

      if (item.targetExists) {
        skipped.push(`${group.id}:${item.name}`);
        results.push({
          category: group.id,
          name: item.name,
          status: 'skipped',
          detail: 'Target entry already exists in current workspace data directory.',
        });
        continue;
      }

      try {
        if (item.kind === 'dir') {
          cpSync(item.sourcePath, item.targetPath, { recursive: true, force: false, errorOnExist: false });
        } else {
          mkdirSync(dirname(item.targetPath), { recursive: true });
          cpSync(item.sourcePath, item.targetPath, { recursive: false, force: false, errorOnExist: false });
        }
        imported.push(`${group.id}:${item.name}`);
        results.push({
          category: group.id,
          name: item.name,
          status: 'imported',
          detail: 'Imported into current workspace data directory.',
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        warnings.push(`${item.name}: ${detail}`);
        results.push({
          category: group.id,
          name: item.name,
          status: 'failed',
          detail,
        });
      }
    }
  }

  for (const missing of status.missingEntries) {
    results.push({
      category: getCategoryForEntryName(missing),
      name: missing,
      status: 'missing',
      detail: 'Entry not found in selected source directory.',
    });
  }

  return {
    sourcePath: status.sourcePath,
    workspaceDataDir: status.workspaceDataDir,
    imported,
    skipped,
    warnings,
    results,
    previewGroups: status.previewGroups,
    hasImportableData: true,
  };
}

export function importWorkspaceRecordDataFromSource(rootPath: string, sourcePath: string): WorkspaceRecordImportResult {
  const status = detectWorkspaceRecordImportStatus(rootPath, sourcePath);

  if (status.sourcePath === status.workspaceDataDir) {
    return buildImportResultFromStatus(status, 'Source directory is the current workspace data directory; import aborted.');
  }

  return buildImportResultFromStatus(status);
}

export function importWorkspaceRecordDataFromWorkspaceRoot(rootPath: string): WorkspaceRecordImportResult {
  const detection = detectLegacyWorkspaceData(rootPath);
  const status = detectWorkspaceRecordImportStatusFromCandidates(rootPath, detection.officialDataDir, [
    { basePath: detection.officialDataDir, kindPrefix: 'official' },
    { basePath: rootPath, kindPrefix: 'legacy' },
  ]);

  if (!detection.hasLegacyData) {
    return buildImportResultFromStatus({
      ...status,
      hasImportableData: false,
      previewGroups: [],
    });
  }

  return buildImportResultFromStatus(status);
}

function moveEntryWithBackup(
  sourcePath: string,
  targetPath: string,
  backupBaseDir: string,
  backupName: string,
  onConflict: 'backup' | 'skip' = 'backup',
): void {
  if (!existsSync(sourcePath)) return;

  if (!existsSync(targetPath)) {
    renameSync(sourcePath, targetPath);
    return;
  }

  if (onConflict === 'skip') {
    return;
  }

  const backupPath = join(backupBaseDir, buildBackupName(backupName));
  renameSync(sourcePath, backupPath);
}

/**
 * 迁移历史工作区数据：
 * - root/.craft-agent/* -> root/<WORKSPACE_DATA_DIR>/*
 * - root/{sessions,skills,sources,labels,statuses} -> root/<WORKSPACE_DATA_DIR>/*
 * - root/{permissions.json,views.json,automations*.jsonl,events.jsonl} -> root/<WORKSPACE_DATA_DIR>/*
 *
 * 冲突策略：
 * - .craft-agent -> 新目录：目标已存在则跳过（避免并存场景反复产生 backup）
 * - 根目录 legacy -> 新目录：目标已存在则将旧项重命名为 *.legacy-backup-{timestamp}
 */
export function migrateLegacyWorkspaceData(rootPath: string): void {
  const dataDir = getWorkspaceDataPath(rootPath);
  mkdirSync(dataDir, { recursive: true });

  const officialDataDir = join(rootPath, OFFICIAL_WORKSPACE_DATA_DIR);

  // 情况 A：存在 .craft-agent，先迁移其内部内容到目标目录。
  // 注意：若目标已存在，跳过冲突项而不是重命名为 legacy-backup。
  // 这样可避免与官方目录并存时在每次加载/交互中持续产生 backup 噪音文件。
  if (existsSync(officialDataDir) && statSync(officialDataDir).isDirectory()) {
    for (const dirName of LEGACY_WORKSPACE_DATA_DIRS) {
      const sourcePath = join(officialDataDir, dirName);
      const targetPath = join(dataDir, dirName);
      moveEntryWithBackup(sourcePath, targetPath, officialDataDir, dirName, 'skip');
    }

    for (const fileName of LEGACY_WORKSPACE_DATA_FILES) {
      const sourcePath = join(officialDataDir, fileName);
      const targetPath = join(dataDir, fileName);
      moveEntryWithBackup(sourcePath, targetPath, officialDataDir, fileName, 'skip');
    }

    // 若 .craft-agent 迁移后已为空，则保留目录不删除（避免破坏用户预期）
  }

  // 情况 B：根目录 legacy 结构（官方历史管理痕迹）
  for (const dirName of LEGACY_WORKSPACE_DATA_DIRS) {
    const legacyPath = join(rootPath, dirName);
    const targetPath = join(dataDir, dirName);
    moveEntryWithBackup(legacyPath, targetPath, rootPath, dirName);
  }

  for (const fileName of LEGACY_WORKSPACE_DATA_FILES) {
    const legacyPath = join(rootPath, fileName);
    const targetPath = join(dataDir, fileName);
    moveEntryWithBackup(legacyPath, targetPath, rootPath, fileName);
  }

  // 若工作区检测到官方管理痕迹但目标目录尚无内容，确保目录已创建
  if (isOfficialManagedWorkspace(rootPath) && !existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }
}

export { CONFIG_DIR, DEFAULT_WORKSPACES_DIR };
