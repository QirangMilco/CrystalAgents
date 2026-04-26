export {
  APP_VARIANT_DEV_FILE_NAME,
  APP_VARIANT_FILE_NAME,
  APP_VARIANT_PROD_FILE_NAME,
  getRepoAppVariantDevPath,
  getRepoAppVariantProdPath,
  getRepoElectronDir,
  getRepoElectronResourcesDir,
  getRepoRuntimeAppVariantPath,
  getSelectedAppVariantPath,
} from '@craft-agent/session-tools-core/app-variant-paths';

import { resolveRuntimeAppVariantPath as resolveCoreRuntimeAppVariantPath } from '@craft-agent/session-tools-core/app-variant-paths';
import { getBundledAssetsDir } from '../utils/paths.ts';

export function resolveRuntimeAppVariantPath(rootDir: string = process.cwd()): string | null {
  return resolveCoreRuntimeAppVariantPath({
    rootDir,
    bundledAssetsDir: getBundledAssetsDir('.'),
  });
}
