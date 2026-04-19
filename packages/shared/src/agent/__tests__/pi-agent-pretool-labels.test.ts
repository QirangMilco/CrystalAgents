import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { PiAgent } from '../pi-agent.ts'
import type { BackendConfig } from '../backend/types.ts'

let origFlag: string | undefined

beforeAll(() => {
  origFlag = process.env.CRAFT_FEATURE_CRAFT_AGENTS_CLI
  process.env.CRAFT_FEATURE_CRAFT_AGENTS_CLI = '1'
})

afterAll(() => {
  if (origFlag === undefined) {
    delete process.env.CRAFT_FEATURE_CRAFT_AGENTS_CLI
  } else {
    process.env.CRAFT_FEATURE_CRAFT_AGENTS_CLI = origFlag
  }
})

function createConfig(overrides?: {
  workspaceRootPath?: string
  workingDirectory?: string
}): BackendConfig {
  const workspaceRootPath = overrides?.workspaceRootPath ?? '/tmp/ws-root'
  const workingDirectory = overrides?.workingDirectory ?? '/tmp/project-root'

  return {
    provider: 'pi',
    workspace: {
      id: 'ws-test',
      name: 'Test Workspace',
      rootPath: workspaceRootPath,
    } as any,
    session: {
      id: 'session-test',
      workspaceRootPath,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory,
    } as any,
    isHeadless: true,
  }
}

describe('PiAgent pre-tool labels guard', () => {
  it('blocks Read on workspace labels/config.json even when session workingDirectory is outside workspace root', async () => {
    const workspaceRootPath = '/tmp/ws-root'
    const workingDirectory = '/tmp/project-root'
    const agent = new PiAgent(createConfig({ workspaceRootPath, workingDirectory }))

    const sent: Array<Record<string, unknown>> = []
    ;(agent as any).send = (message: Record<string, unknown>) => {
      sent.push(message)
    }
    ;(agent as any).emitAutomationEvent = async () => {}

    await (agent as any).handlePreToolUseRequest({
      requestId: 'req-1',
      toolName: 'Read',
      input: { file_path: `${workspaceRootPath}/labels/config.json` },
    })

    expect(sent.length).toBeGreaterThan(0)

    const response = sent.at(-1)
    expect(response?.type).toBe('pre_tool_use_response')
    expect(response?.action).toBe('block')
    expect(String(response?.reason ?? '')).toContain('craft-agent label --help')

    agent.destroy()
  })

  it('backfills tool_start metadata when tool_execution_start arrives before PreToolUse', async () => {
    const agent = new PiAgent(createConfig())

    const sent: Array<Record<string, unknown>> = []
    const queuedEvents: Array<Record<string, unknown>> = []

    ;(agent as any).send = (message: Record<string, unknown>) => {
      sent.push(message)
    }
    ;(agent as any).emitAutomationEvent = async () => {}
    ;(agent as any).eventQueue.enqueue = (event: Record<string, unknown>) => {
      queuedEvents.push(event)
    }

    ;(agent as any).handleSubprocessEvent({
      type: 'tool_execution_start',
      toolName: 'mcp__session__script_sandbox',
      toolCallId: 'call-race-1',
      args: {
        language: 'python3',
        script: 'print(1)',
      },
    })

    expect((agent as any).pendingToolStartBackfillByCallId.get('call-race-1')).toBeTruthy()

    await (agent as any).handlePreToolUseRequest({
      requestId: 'req-race-1',
      toolName: 'mcp__session__script_sandbox',
      toolCallId: 'call-race-1',
      input: {
        language: 'python3',
        script: 'print(1)',
        _displayName: '运行脚本',
        _intent: '执行一段 Python 诊断脚本。',
      },
    })

    const backfilledEvents = queuedEvents.filter(event => event.type === 'tool_start' && event.toolUseId === 'call-race-1')
    expect(backfilledEvents.length).toBeGreaterThanOrEqual(2)
    const backfilled = backfilledEvents.at(-1)
    expect(backfilled).toBeTruthy()
    expect(backfilled?.toolName).toBe('mcp__session__script_sandbox')
    expect(backfilled?.intent).toBe('执行一段 Python 诊断脚本。')
    expect(backfilled?.displayName).toBe('运行脚本')
    expect((agent as any).pendingToolStartBackfillByCallId.has('call-race-1')).toBe(false)

    const response = sent.at(-1)
    const action = typeof response?.action === 'string' ? response.action : undefined
    expect(response?.type).toBe('pre_tool_use_response')
    expect(action === 'allow' || action === 'modify').toBe(true)

    agent.destroy()
  })
})
