import { describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { detectWorkspaceRecordImportStatus, importWorkspaceRecordDataFromSource } from '../storage.ts'
import { getWorkspaceDataPath } from '../data-path.ts'

function createTempWorkspaceRoot(): string {
  return mkdtempSync(join(tmpdir(), 'crystal-workspace-import-'))
}

describe('workspace record import preview', () => {
  it('builds preview groups with per-item counts including sessions', () => {
    const root = createTempWorkspaceRoot()
    const source = join(root, 'upstream')

    mkdirSync(join(source, 'sessions', 'session-a'), { recursive: true })
    writeFileSync(join(source, 'sessions', 'session-a', 'session.jsonl'), '{"id":"session-a"}\n')
    mkdirSync(join(source, 'sessions', 'session-b'), { recursive: true })
    writeFileSync(join(source, 'sessions', 'session-b', 'session.jsonl'), '{"id":"session-b"}\n')

    mkdirSync(join(source, 'skills', 'my-skill'), { recursive: true })
    writeFileSync(join(source, 'skills', 'my-skill', 'SKILL.md'), '---\nname: Test\ndescription: Test\n---\nbody')

    mkdirSync(join(source, 'sources', 'my-source'), { recursive: true })
    writeFileSync(join(source, 'sources', 'my-source', 'config.json'), '{"name":"x","type":"api","baseUrl":"https://example.com"}')

    const workspaceDataDir = getWorkspaceDataPath(root)
    mkdirSync(join(workspaceDataDir, 'sessions', 'session-b'), { recursive: true })

    const status = detectWorkspaceRecordImportStatus(root, source)
    const sessionsGroup = status.previewGroups.find((group) => group.id === 'sessions')
    const skillsGroup = status.previewGroups.find((group) => group.id === 'skills')
    const sourcesGroup = status.previewGroups.find((group) => group.id === 'sources')

    expect(status.hasImportableData).toBe(true)
    expect(sessionsGroup?.totalCount).toBe(2)
    expect(sessionsGroup?.importableCount).toBe(1)
    expect(sessionsGroup?.skippedCount).toBe(1)
    expect(skillsGroup?.totalCount).toBe(1)
    expect(sourcesGroup?.totalCount).toBe(1)
  })

  it('imports sessions as per-item results instead of whole-folder skip', () => {
    const root = createTempWorkspaceRoot()
    const source = join(root, 'upstream')

    mkdirSync(join(source, 'sessions', 'session-a'), { recursive: true })
    writeFileSync(join(source, 'sessions', 'session-a', 'session.jsonl'), '{"id":"session-a"}\n')
    mkdirSync(join(source, 'sessions', 'session-b'), { recursive: true })
    writeFileSync(join(source, 'sessions', 'session-b', 'session.jsonl'), '{"id":"session-b"}\n')

    const workspaceDataDir = getWorkspaceDataPath(root)
    mkdirSync(join(workspaceDataDir, 'sessions', 'session-b'), { recursive: true })

    const result = importWorkspaceRecordDataFromSource(root, source)

    expect(result.results.some((item) => item.category === 'sessions' && item.name === 'session-a' && item.status === 'imported')).toBe(true)
    expect(result.results.some((item) => item.category === 'sessions' && item.name === 'session-b' && item.status === 'skipped')).toBe(true)
    expect(existsSync(join(workspaceDataDir, 'sessions', 'session-a', 'session.jsonl'))).toBe(true)
  })

  it('merges events jsonl with line-level dedup into existing target file', () => {
    const root = createTempWorkspaceRoot()
    const source = join(root, 'upstream')
    mkdirSync(source, { recursive: true })
    writeFileSync(join(source, 'events.jsonl'), '{"id":"e-2"}\n{"id":"e-3"}\n')

    const workspaceDataDir = getWorkspaceDataPath(root)
    mkdirSync(workspaceDataDir, { recursive: true })
    writeFileSync(join(workspaceDataDir, 'events.jsonl'), '{"id":"e-1"}\n{"id":"e-2"}\n')

    const result = importWorkspaceRecordDataFromSource(root, source)
    const eventsResult = result.results.find((item) => item.category === 'events' && item.status === 'imported')
    const mergedContent = readFileSync(join(workspaceDataDir, 'events.jsonl'), 'utf-8')

    expect(eventsResult).toBeDefined()
    expect(eventsResult?.detail).toContain('Merged 1 new JSONL record(s)')
    expect(eventsResult?.detail).toContain('skipped 1 duplicate record(s)')
    expect(mergedContent).toBe('{"id":"e-1"}\n{"id":"e-2"}\n{"id":"e-3"}\n')
  })
})
