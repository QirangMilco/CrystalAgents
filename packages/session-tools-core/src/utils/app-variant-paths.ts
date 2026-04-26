import { existsSync } from 'fs';
import { join } from 'path';

export const APP_VARIANT_FILE_NAME = 'app-variant.json';
export const APP_VARIANT_PROD_FILE_NAME = 'app-variant.prod.json';
export const APP_VARIANT_DEV_FILE_NAME = 'app-variant.dev.json';

export function getRepoElectronDir(rootDir: string = process.cwd()): string {
  return join(rootDir, 'apps', 'electron');
}

export function getRepoElectronResourcesDir(rootDir: string = process.cwd()): string {
  return join(getRepoElectronDir(rootDir), 'resources');
}

export function getRepoAppVariantProdPath(rootDir: string = process.cwd()): string {
  return join(getRepoElectronResourcesDir(rootDir), APP_VARIANT_PROD_FILE_NAME);
}

export function getRepoAppVariantDevPath(rootDir: string = process.cwd()): string {
  return join(getRepoElectronResourcesDir(rootDir), APP_VARIANT_DEV_FILE_NAME);
}

export function getRepoRuntimeAppVariantPath(rootDir: string = process.cwd()): string {
  return join(getRepoElectronResourcesDir(rootDir), APP_VARIANT_FILE_NAME);
}

export function getSelectedAppVariantPath(rootDir: string = process.cwd()): string {
  return process.env.CRAFT_APP_VARIANT_PATH || getRepoAppVariantProdPath(rootDir);
}

export function resolveRuntimeAppVariantPath(options: {
  rootDir?: string;
  bundledAssetsDir?: string | null;
} = {}): string | null {
  const rootDir = options.rootDir ?? process.cwd();
  const fromEnv = process.env.CRAFT_APP_VARIANT_PATH;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;

  // Packaged runtime candidate: process.resourcesPath is available before main bootstrap logic.
  // Example: /Applications/Crystal Agents.app/Contents/Resources
  const electronResourcesPath = (process as { resourcesPath?: string }).resourcesPath;
  if (electronResourcesPath) {
    const packagedCandidates = [
      join(electronResourcesPath, 'app', 'resources', APP_VARIANT_FILE_NAME),
      join(electronResourcesPath, 'app', 'dist', 'resources', APP_VARIANT_FILE_NAME),
    ];
    for (const packagedPath of packagedCandidates) {
      if (existsSync(packagedPath)) return packagedPath;
    }
  }

  // Secondary packaged runtime candidate from bootstrap env (when available).
  const resourcesBase = process.env.CRAFT_RESOURCES_BASE;
  if (resourcesBase) {
    const packagedCandidates = [
      join(resourcesBase, 'resources', APP_VARIANT_FILE_NAME),
      join(resourcesBase, 'dist', 'resources', APP_VARIANT_FILE_NAME),
    ];
    for (const packagedPath of packagedCandidates) {
      if (existsSync(packagedPath)) return packagedPath;
    }
  }

  if (options.bundledAssetsDir) {
    const bundledPath = join(options.bundledAssetsDir, APP_VARIANT_FILE_NAME);
    if (existsSync(bundledPath)) return bundledPath;
  }

  const repoRuntimePath = getRepoRuntimeAppVariantPath(rootDir);
  if (existsSync(repoRuntimePath)) return repoRuntimePath;

  const repoProdPath = getRepoAppVariantProdPath(rootDir);
  if (existsSync(repoProdPath)) return repoProdPath;

  return null;
}
