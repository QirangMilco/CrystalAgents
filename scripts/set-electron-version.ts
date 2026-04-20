import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

interface PackageJson {
  version: string;
  [key: string]: unknown;
}

const ROOT = process.cwd();
const packageJsonPath = join(ROOT, 'apps', 'electron', 'package.json');

function fail(message: string): never {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

function readPackageJson(): PackageJson {
  return JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as PackageJson;
}

function writePackageJson(pkg: PackageJson): void {
  writeFileSync(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf-8');
}

function buildCandidateVersion(baseVersion: string): string {
  const runNumber = process.env.GITHUB_RUN_NUMBER?.trim();
  if (!runNumber) {
    fail('GITHUB_RUN_NUMBER is required for candidate builds');
  }
  return `${baseVersion}-dev.${runNumber}`;
}

function getReleaseNumber(): string {
  const releaseNumber = process.env.CRYSTAL_RELEASE_NUMBER?.trim();
  if (!releaseNumber) {
    fail('CRYSTAL_RELEASE_NUMBER is required for release builds');
  }
  if (!/^\d+$/.test(releaseNumber)) {
    fail('CRYSTAL_RELEASE_NUMBER must be a positive integer');
  }
  return releaseNumber;
}

function buildReleaseVersion(baseVersion: string): string {
  return `${baseVersion}.${getReleaseNumber()}`;
}

function buildPrereleaseVersion(baseVersion: string): string {
  return `${baseVersion}-rc.${getReleaseNumber()}`;
}

function main(): void {
  const mode = process.argv[2]?.trim();
  if (!mode || !['candidate', 'release', 'prerelease'].includes(mode)) {
    fail('Usage: bun run scripts/set-electron-version.ts <candidate|release|prerelease>');
  }

  const pkg = readPackageJson();
  const baseVersion = pkg.version;
  let nextVersion: string;

  if (mode === 'candidate') {
    nextVersion = buildCandidateVersion(baseVersion);
  } else if (mode === 'prerelease') {
    nextVersion = buildPrereleaseVersion(baseVersion);
  } else {
    nextVersion = buildReleaseVersion(baseVersion);
  }

  pkg.version = nextVersion;
  writePackageJson(pkg);
  process.stdout.write(`${nextVersion}\n`);
}

main();
