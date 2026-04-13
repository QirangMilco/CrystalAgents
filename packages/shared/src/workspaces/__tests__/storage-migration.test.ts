import { describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { migrateLegacyWorkspaceData } from '../storage.ts';

function createTempWorkspaceRoot(): string {
  return mkdtempSync(join(tmpdir(), 'crystal-workspace-migrate-'));
}

function listLegacyBackups(dir: string, prefix: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.startsWith(`${prefix}.legacy-backup-`));
}

describe('migrateLegacyWorkspaceData', () => {
  it('官方目录冲突时跳过而不是生成 backup', () => {
    const root = createTempWorkspaceRoot();

    const officialSessions = join(root, '.craft-agent', 'sessions', 'official-session');
    mkdirSync(officialSessions, { recursive: true });

    const targetSessions = join(root, '.crystal-agent', 'sessions', 'fork-session');
    mkdirSync(targetSessions, { recursive: true });

    migrateLegacyWorkspaceData(root);

    expect(existsSync(join(root, '.craft-agent', 'sessions'))).toBe(true);
    expect(existsSync(join(root, '.crystal-agent', 'sessions'))).toBe(true);

    const backups = listLegacyBackups(join(root, '.craft-agent'), 'sessions');
    expect(backups.length).toBe(0);
  });

  it('官方目录目标不存在时仍会迁移', () => {
    const root = createTempWorkspaceRoot();

    const officialSkills = join(root, '.craft-agent', 'skills', 'legacy-skill');
    mkdirSync(officialSkills, { recursive: true });

    migrateLegacyWorkspaceData(root);

    expect(existsSync(join(root, '.craft-agent', 'skills'))).toBe(false);
    expect(existsSync(join(root, '.crystal-agent', 'skills', 'legacy-skill'))).toBe(true);
  });

  it('根目录 legacy 冲突时仍保留 backup 策略', () => {
    const root = createTempWorkspaceRoot();

    const legacySessions = join(root, 'sessions', 'legacy-session');
    mkdirSync(legacySessions, { recursive: true });

    const targetSessions = join(root, '.crystal-agent', 'sessions', 'fork-session');
    mkdirSync(targetSessions, { recursive: true });

    migrateLegacyWorkspaceData(root);

    expect(existsSync(join(root, 'sessions'))).toBe(false);
    const backups = listLegacyBackups(root, 'sessions');
    expect(backups.length).toBe(1);
  });
});
