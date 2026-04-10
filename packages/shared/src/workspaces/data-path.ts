import { join } from 'path';

export const WORKSPACE_DATA_DIR = '.craft-agents';

/**
 * 工作区运行时数据目录：{workspaceRootPath}/.craft-agents
 */
export function getWorkspaceDataPath(workspaceRootPath: string): string {
  return join(workspaceRootPath, WORKSPACE_DATA_DIR);
}
