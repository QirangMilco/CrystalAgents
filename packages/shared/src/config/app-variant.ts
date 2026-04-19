import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { getBundledAssetsDir } from '../utils/paths.ts';

export interface AppVariantConfig {
  appId: string;
  productName: string;
  bundleDisplayName: string;
  artifactNamePrefix: string;
  dmgTitle: string;
  deeplinkScheme: string;
  configDirName: string;
  workspaceDataDirName: string;
  update: {
    enabled: boolean;
    checkOnLaunch: boolean;
    autoDownload: boolean;
    autoInstallOnQuit: boolean;
  };
  import: {
    sourceConfigDirName: string;
    copyOnFirstLaunch: boolean;
    workspaceDetection: boolean;
    include: string[];
  };
}

const DEFAULT_APP_VARIANT: AppVariantConfig = {
  appId: 'com.lukilabs.craft-agent',
  productName: 'Craft Agents',
  bundleDisplayName: 'Craft Agents',
  artifactNamePrefix: 'Craft-Agents',
  dmgTitle: 'Craft Agents',
  deeplinkScheme: 'craftagents',
  configDirName: '.craft-agent',
  workspaceDataDirName: '.craft-agents',
  update: {
    enabled: true,
    checkOnLaunch: true,
    autoDownload: true,
    autoInstallOnQuit: true,
  },
  import: {
    sourceConfigDirName: '.craft-agent',
    copyOnFirstLaunch: false,
    workspaceDetection: true,
    include: [
      'config.json',
      'preferences.json',
      'credentials.enc',
      'workspaces',
      'theme.json',
      'themes',
      'permissions',
      'tool-icons',
    ],
  },
};

let cachedVariant: AppVariantConfig | null = null;

function resolveVariantPath(): string | null {
  const fromEnv = process.env.CRAFT_APP_VARIANT_PATH;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;

  // Packaged runtime candidate: process.resourcesPath is available before main bootstrap logic.
  // Example: /Applications/Crystal Agents.app/Contents/Resources
  const electronResourcesPath = (process as { resourcesPath?: string }).resourcesPath;
  if (electronResourcesPath) {
    const packagedCandidates = [
      join(electronResourcesPath, 'app', 'resources', 'app-variant.json'),
      join(electronResourcesPath, 'app', 'dist', 'resources', 'app-variant.json'),
    ];
    for (const packagedPath of packagedCandidates) {
      if (existsSync(packagedPath)) return packagedPath;
    }
  }

  // Secondary packaged runtime candidate from bootstrap env (when available).
  const resourcesBase = process.env.CRAFT_RESOURCES_BASE;
  if (resourcesBase) {
    const packagedCandidates = [
      join(resourcesBase, 'resources', 'app-variant.json'),
      join(resourcesBase, 'dist', 'resources', 'app-variant.json'),
    ];
    for (const packagedPath of packagedCandidates) {
      if (existsSync(packagedPath)) return packagedPath;
    }
  }

  const bundledDir = getBundledAssetsDir('.');
  if (bundledDir) {
    const bundledPath = join(bundledDir, 'app-variant.json');
    if (existsSync(bundledPath)) return bundledPath;
  }

  const devPath = join(process.cwd(), 'apps', 'electron', 'resources', 'app-variant.json');
  if (existsSync(devPath)) return devPath;

  return null;
}

function parseVariantFile(path: string): Partial<AppVariantConfig> | null {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as Partial<AppVariantConfig>;
  } catch {
    return null;
  }
}

function mergeVariant(partial: Partial<AppVariantConfig>): AppVariantConfig {
  return {
    ...DEFAULT_APP_VARIANT,
    ...partial,
    update: {
      ...DEFAULT_APP_VARIANT.update,
      ...(partial.update ?? {}),
    },
    import: {
      ...DEFAULT_APP_VARIANT.import,
      ...(partial.import ?? {}),
      include: Array.isArray(partial.import?.include)
        ? partial.import!.include.filter((v): v is string => typeof v === 'string' && v.length > 0)
        : DEFAULT_APP_VARIANT.import.include,
    },
  };
}

export function getAppVariant(): AppVariantConfig {
  if (cachedVariant) return cachedVariant;

  const variantPath = resolveVariantPath();
  if (!variantPath) {
    cachedVariant = DEFAULT_APP_VARIANT;
    return cachedVariant;
  }

  const parsed = parseVariantFile(variantPath);
  cachedVariant = parsed ? mergeVariant(parsed) : DEFAULT_APP_VARIANT;
  return cachedVariant;
}

export function resetAppVariantCacheForTests(): void {
  cachedVariant = null;
}
