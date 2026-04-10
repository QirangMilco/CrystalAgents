import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

interface AppVariantConfig {
  appId?: string;
  productName?: string;
  artifactNamePrefix?: string;
  dmgTitle?: string;
}

const ROOT = process.cwd();
const ELECTRON_DIR = join(ROOT, 'apps', 'electron');
const resourcesVariantPath = join(ELECTRON_DIR, 'resources', 'app-variant.json');
const baseBuilderPath = join(ELECTRON_DIR, 'electron-builder.yml');
const outDir = join(ELECTRON_DIR, 'dist');
const outBuilderPath = join(outDir, 'electron-builder.generated.yml');

function loadVariant(): AppVariantConfig {
  try {
    return JSON.parse(readFileSync(resourcesVariantPath, 'utf-8')) as AppVariantConfig;
  } catch {
    return {};
  }
}

function replaceTopLevelField(yaml: string, key: string, value: string): string {
  const safe = value.replace(/"/g, '\\"');
  const line = `${key}: "${safe}"`;
  const re = new RegExp(`^${key}:\\s*.*$`, 'm');
  if (re.test(yaml)) {
    return yaml.replace(re, line);
  }
  return `${line}\n${yaml}`;
}

function replaceDmgTitle(yaml: string, value: string): string {
  const safe = value.replace(/"/g, '\\"');
  const re = /^\s{2}title:\s*.*$/m;
  const replacement = `  title: "${safe}"`;
  if (re.test(yaml)) {
    return yaml.replace(re, replacement);
  }
  return yaml;
}

function replaceArtifactNames(yaml: string, prefix: string): string {
  const safe = prefix.replace(/"/g, '\\"');
  const templateExt = `${safe}-\${arch}.\${ext}`.replace(/\\\$\{arch\}/g, '${arch}').replace(/\\\$\{ext\}/g, '${ext}');
  const templateDmg = `${safe}-\${arch}.dmg`.replace(/\\\$\{arch\}/g, '${arch}');

  let result = yaml;
  result = result.replace(/artifactName:\s*"[^"]*\$\{arch\}\.\$\{ext\}"/g, `artifactName: "${templateExt}"`);
  result = result.replace(/artifactName:\s*"[^"]*\$\{arch\}\.dmg"/g, `artifactName: "${templateDmg}"`);
  return result;
}

function main(): void {
  const variant = loadVariant();
  let yaml = readFileSync(baseBuilderPath, 'utf-8');

  if (variant.appId) {
    yaml = replaceTopLevelField(yaml, 'appId', variant.appId);
  }

  if (variant.productName) {
    yaml = replaceTopLevelField(yaml, 'productName', variant.productName);
  }

  if (variant.dmgTitle) {
    yaml = replaceDmgTitle(yaml, variant.dmgTitle);
  }

  if (variant.artifactNamePrefix) {
    yaml = replaceArtifactNames(yaml, variant.artifactNamePrefix);
  }

  mkdirSync(outDir, { recursive: true });
  writeFileSync(outBuilderPath, yaml, 'utf-8');
  process.stdout.write(`${outBuilderPath}\n`);
}

main();
