import { describe, expect, it } from 'bun:test'
import { resolveStatusIconSource } from '../status-icon'

describe('resolveStatusIconSource', () => {
  const workspaceDataDir = '.crystal-agent'

  it('treats bare icon filenames as local overrides in statuses/icons', () => {
    expect(resolveStatusIconSource('todo', workspaceDataDir, 'in-progress.svg')).toEqual({
      iconPath: '.crystal-agent/statuses/icons/in-progress.svg',
      iconDir: '.crystal-agent/statuses/icons',
    })
  })

  it('treats .webp filenames as local overrides', () => {
    expect(resolveStatusIconSource('todo', workspaceDataDir, 'custom-icon.webp')).toEqual({
      iconPath: '.crystal-agent/statuses/icons/custom-icon.webp',
      iconDir: '.crystal-agent/statuses/icons',
    })
  })

  it('rejects nested paths from being treated as local overrides', () => {
    expect(resolveStatusIconSource('todo', workspaceDataDir, '../in-progress.svg')).toEqual({
      iconValue: '../in-progress.svg',
      iconFileName: 'todo',
      iconDir: '.crystal-agent/statuses/icons',
    })
  })

  it('preserves emoji and url icon values', () => {
    expect(resolveStatusIconSource('todo', workspaceDataDir, '✅')).toEqual({
      iconValue: '✅',
      iconFileName: 'todo',
      iconDir: '.crystal-agent/statuses/icons',
    })

    expect(resolveStatusIconSource('todo', workspaceDataDir, 'https://example.com/icon.svg')).toEqual({
      iconValue: 'https://example.com/icon.svg',
      iconFileName: 'todo',
      iconDir: '.crystal-agent/statuses/icons',
    })
  })
})
