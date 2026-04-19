/**
 * Cross-platform resources copy script
 */

import { existsSync, cpSync, mkdirSync, copyFileSync } from "fs";
import { join } from "path";


const ROOT_DIR = join(import.meta.dir, "..");
const ELECTRON_DIR = join(ROOT_DIR, "apps/electron");
const DEFAULT_VARIANT_PATH = join(ELECTRON_DIR, "resources", "app-variant.prod.json");
const SELECTED_VARIANT_PATH = process.env.CRAFT_APP_VARIANT_PATH || DEFAULT_VARIANT_PATH;

const srcDir = join(ELECTRON_DIR, "resources");
const destDir = join(ELECTRON_DIR, "dist/resources");

function syncSelectedVariant(): void {
  for (const baseDir of [srcDir, destDir]) {
    mkdirSync(baseDir, { recursive: true });
    copyFileSync(SELECTED_VARIANT_PATH, join(baseDir, "app-variant.json"));
  }

  console.log(`🔄 Synced app variant (${SELECTED_VARIANT_PATH})`);
}

function syncSubprocessBundle(serverName: "session-mcp-server" | "pi-agent-server"): void {
  const builtIndex = join(ROOT_DIR, "packages", serverName, "dist", "index.js");

  if (!existsSync(builtIndex)) {
    console.log(`⚠️ Skipping ${serverName} sync: build output not found`);
    return;
  }

  for (const baseDir of [srcDir, destDir]) {
    const serverDir = join(baseDir, serverName);
    mkdirSync(serverDir, { recursive: true });
    copyFileSync(builtIndex, join(serverDir, "index.js"));
  }

  console.log(`🔄 Synced ${serverName} bundle`);
}

if (existsSync(srcDir)) {
  cpSync(srcDir, destDir, { recursive: true, force: true });
  syncSelectedVariant();
  syncSubprocessBundle("session-mcp-server");
  syncSubprocessBundle("pi-agent-server");
  console.log("📦 Copied resources to dist");
} else {
  console.log("⚠️ No resources directory found");
}
