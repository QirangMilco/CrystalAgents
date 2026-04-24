import { homedir } from 'os';
import { join } from 'path';

function normalizeNonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function resolveCraftLogsDir(): string {
  const explicitLogsDir = normalizeNonEmpty(process.env.CRAFT_LOGS_DIR);
  if (explicitLogsDir) return explicitLogsDir;

  const electronUserDataDir = normalizeNonEmpty(process.env.CRAFT_ELECTRON_USER_DATA_DIR);
  if (electronUserDataDir) return join(electronUserDataDir, 'logs');

  const configDir = normalizeNonEmpty(process.env.CRAFT_CONFIG_DIR);
  if (configDir) return join(configDir, 'electron', 'logs');

  return join(homedir(), 'Library/Logs/@crystal-agent/electron');
}

export function getCraftMainLogPath(): string {
  return join(resolveCraftLogsDir(), 'main.log');
}

export function getCraftRendererDebugLogPath(): string {
  return join(resolveCraftLogsDir(), 'renderer-debug.log');
}
