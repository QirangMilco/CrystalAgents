import { join } from 'path';
import {
  type Arch,
  type BuildConfig,
  type Platform,
  buildMcpServers,
  copyPiAgentServer,
  copySessionServer,
  verifyMcpServersExist,
} from './common';

function parseArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

function parsePlatform(value: string | undefined): Platform {
  if (value === 'darwin' || value === 'linux' || value === 'win32') return value;
  throw new Error(`Invalid --platform value: ${value ?? '<missing>'}. Expected darwin|linux|win32.`);
}

function parseArch(value: string | undefined): Arch {
  if (value === 'x64' || value === 'arm64') return value;
  throw new Error(`Invalid --arch value: ${value ?? '<missing>'}. Expected x64|arm64.`);
}

function main(): void {
  const platform = parsePlatform(parseArg('--platform'));
  const arch = parseArch(parseArg('--arch'));

  const rootDir = process.cwd();
  const config: BuildConfig = {
    platform,
    arch,
    upload: false,
    uploadLatest: false,
    uploadScript: false,
    rootDir,
    electronDir: join(rootDir, 'apps', 'electron'),
  };

  console.log(`Staging subprocess servers for ${platform}-${arch}...`);
  buildMcpServers(config);
  copySessionServer(config);
  copyPiAgentServer(config);
  verifyMcpServersExist(config);
  console.log('Subprocess servers staged successfully.');
}

main();
