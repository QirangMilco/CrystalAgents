/**
 * Build output validation script.
 *
 * Ensures required bundled assets exist after build/copy steps.
 * Run: bun scripts/validate-assets.ts
 */

import { existsSync, statSync } from 'fs';
import { join } from 'path';

const requiredPaths = [
  'dist/main.cjs',
  'dist/bootstrap-preload.cjs',
  'dist/browser-toolbar-preload.cjs',
  'dist/interceptor.cjs',
  'dist/resources',
  'dist/resources/docs',
  'dist/resources/release-notes',
  'dist/resources/permissions',
  'dist/resources/themes',
  'dist/resources/tool-icons',
  'dist/resources/app-variant.json',
];

let hasError = false;

for (const rel of requiredPaths) {
  const full = join(process.cwd(), rel);
  if (!existsSync(full)) {
    console.error(`✗ Missing required asset: ${rel}`);
    hasError = true;
    continue;
  }

  try {
    const stat = statSync(full);
    if (rel.endsWith('/')) {
      if (!stat.isDirectory()) {
        console.error(`✗ Expected directory but got file: ${rel}`);
        hasError = true;
      }
    }
  } catch (err) {
    console.error(`✗ Failed to stat asset: ${rel}`);
    hasError = true;
  }
}

if (hasError) {
  process.exit(1);
}

console.log('✓ Build assets validated');
