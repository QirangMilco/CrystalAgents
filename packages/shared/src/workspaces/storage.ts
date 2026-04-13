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
} from 'fs';
import { join } from 'path';
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

// ============================================================
// Config Operations
// ============================================================

/**
 * Load workspace config.json from a workspace folder
 * @param rootPath - Absolute path to workspace root folder
 */
export function loadWorkspaceConfig(rootPath: string): WorkspaceConfig | null {
  const configPath = join(rootPath, 'config.json');
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
  atomicWriteFileSync(join(rootPath, 'config.json'), JSON.stringify(storageConfig, null, 2));
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
  return existsSync(join(rootPath, 'config.json'));
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
  const pluginDir = join(rootPath, '.claude-plugin');
  const manifestPath = join(pluginDir, 'plugin.json');

  if (existsSync(manifestPath)) return;

  // Create .claude-plugin directory
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
  message?: string;
}

export interface WorkspaceRecordImportResult {
  sourcePath: string;
  workspaceDataDir: string;
  imported: string[];
  skipped: string[];
  warnings: string[];
  results: Array<{
    name: string;
    status: 'imported' | 'skipped' | 'missing' | 'failed';
    detail: string;
  }>;
  hasImportableData: boolean;
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

  return {
    hasLegacyData: detectedEntries.length > 0,
    officialDataDir,
    workspaceDataDir: dataDir,
    detectedEntries,
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
      message: !sourceExists ? 'Source path does not exist.' : 'Source path is not a directory.',
    };
  }

  const availableEntries: WorkspaceRecordImportStatus['availableEntries'] = [];
  const missingEntries: string[] = [];

  for (const dirName of LEGACY_WORKSPACE_DATA_DIRS) {
    const sourceEntry = join(sourcePath, dirName);
    if (existsSync(sourceEntry) && statSync(sourceEntry).isDirectory()) {
      const targetPath = join(workspaceDataDir, dirName);
      availableEntries.push({
        name: dirName,
        sourcePath: sourceEntry,
        targetPath,
        kind: 'dir',
        targetExists: existsSync(targetPath),
      });
    } else {
      missingEntries.push(dirName);
    }
  }

  for (const fileName of LEGACY_WORKSPACE_DATA_FILES) {
    const sourceEntry = join(sourcePath, fileName);
    if (existsSync(sourceEntry) && statSync(sourceEntry).isFile()) {
      const targetPath = join(workspaceDataDir, fileName);
      availableEntries.push({
        name: fileName,
        sourcePath: sourceEntry,
        targetPath,
        kind: 'file',
        targetExists: existsSync(targetPath),
      });
    } else {
      missingEntries.push(fileName);
    }
  }

  return {
    sourcePath,
    workspaceDataDir,
    sourceExists: true,
    sourceIsDirectory: true,
    hasImportableData: availableEntries.length > 0,
    availableEntries,
    missingEntries,
  };
}

export function importWorkspaceRecordDataFromSource(rootPath: string, sourcePath: string): WorkspaceRecordImportResult {
  const status = detectWorkspaceRecordImportStatus(rootPath, sourcePath);
  const results: WorkspaceRecordImportResult['results'] = [];
  const imported: string[] = [];
  const skipped: string[] = [];
  const warnings: string[] = [];

  if (!status.sourceExists || !status.sourceIsDirectory || !status.hasImportableData) {
    if (status.message) {
      warnings.push(status.message);
    }
    for (const name of status.missingEntries) {
      results.push({
        name,
        status: 'missing',
        detail: 'Entry not found in selected source directory.',
      });
    }
    return {
      sourcePath,
      workspaceDataDir: status.workspaceDataDir,
      imported,
      skipped,
      warnings,
      results,
      hasImportableData: false,
    };
  }

  if (status.sourcePath === status.workspaceDataDir) {
    const detail = 'Source directory is the current workspace data directory; import aborted.';
    warnings.push(detail);
    return {
      sourcePath,
      workspaceDataDir: status.workspaceDataDir,
      imported,
      skipped,
      warnings,
      results: [
        {
          name: '.',
          status: 'failed',
          detail,
        },
      ],
      hasImportableData: true,
    };
  }

  mkdirSync(status.workspaceDataDir, { recursive: true });

  for (const entry of status.availableEntries) {
    if (entry.targetExists) {
      skipped.push(entry.name);
      results.push({
        name: entry.name,
        status: 'skipped',
        detail: 'Target entry already exists in current workspace data directory.',
      });
      continue;
    }

    try {
      cpSync(entry.sourcePath, entry.targetPath, { recursive: entry.kind === 'dir', force: false, errorOnExist: false });
      imported.push(entry.name);
      results.push({
        name: entry.name,
        status: 'imported',
        detail: 'Imported into current workspace data directory.',
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      warnings.push(`${entry.name}: ${detail}`);
      results.push({
        name: entry.name,
        status: 'failed',
        detail,
      });
    }
  }

  for (const missing of status.missingEntries) {
    results.push({
      name: missing,
      status: 'missing',
      detail: 'Entry not found in selected source directory.',
    });
  }

  return {
    sourcePath,
    workspaceDataDir: status.workspaceDataDir,
    imported,
    skipped,
    warnings,
    results,
    hasImportableData: true,
  };
}

export function importWorkspaceRecordDataFromWorkspaceRoot(rootPath: string): WorkspaceRecordImportResult {
  const detection = detectLegacyWorkspaceData(rootPath);
  const results: WorkspaceRecordImportResult['results'] = [];
  const imported: string[] = [];
  const skipped: string[] = [];
  const warnings: string[] = [];

  if (!detection.hasLegacyData) {
    return {
      sourcePath: detection.officialDataDir,
      workspaceDataDir: detection.workspaceDataDir,
      imported,
      skipped,
      warnings,
      results,
      hasImportableData: false,
    };
  }

  mkdirSync(detection.workspaceDataDir, { recursive: true });

  for (const entry of detection.detectedEntries) {
    if (entry.targetExists) {
      skipped.push(entry.name);
      results.push({
        name: entry.name,
        status: 'skipped',
        detail: 'Target entry already exists in current workspace data directory.',
      });
      continue;
    }

    const isDir = entry.kind === 'official-dir' || entry.kind === 'legacy-dir';
    try {
      cpSync(entry.sourcePath, entry.targetPath, { recursive: isDir, force: false, errorOnExist: false });
      imported.push(entry.name);
      results.push({
        name: entry.name,
        status: 'imported',
        detail: 'Copied into current workspace data directory.',
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      warnings.push(`${entry.name}: ${detail}`);
      results.push({
        name: entry.name,
        status: 'failed',
        detail,
      });
    }
  }

  return {
    sourcePath: detection.officialDataDir,
    workspaceDataDir: detection.workspaceDataDir,
    imported,
    skipped,
    warnings,
    results,
    hasImportableData: true,
  };
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
