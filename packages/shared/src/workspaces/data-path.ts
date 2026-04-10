import { join } from 'path';
import { getAppVariant } from '../config/app-variant.ts';

const variant = getAppVariant();
export const WORKSPACE_DATA_DIR = variant.workspaceDataDirName || '.craft-agents';

/**
 * 工作区运行时数据目录：{workspaceRootPath}/<workspaceDataDirName>
 */
export function getWorkspaceDataPath(workspaceRootPath: string): string {
  return join(workspaceRootPath, WORKSPACE_DATA_DIR);
}
