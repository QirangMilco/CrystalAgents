import { describe, expect, it } from 'bun:test'
import { getAssistantTurnUiKey, type AssistantTurn } from '../turn-utils'

function makeAssistantTurn(overrides: Partial<AssistantTurn> = {}): AssistantTurn {
  return {
    type: 'assistant',
    turnId: 'pi-turn-1',
    activities: [],
    response: undefined,
    intent: undefined,
    isStreaming: false,
    isComplete: true,
    timestamp: 123,
    ...overrides,
  }
}

describe('getAssistantTurnUiKey', () => {
  it('uses a stable turn-level key for activity turns', () => {
    const turn = makeAssistantTurn({
      activities: [{ id: 'tool-1', type: 'tool', status: 'completed', timestamp: 1 } as AssistantTurn['activities'][number]],
      turnId: 'pi-turn-1',
      timestamp: 555,
      response: {
        text: 'Done',
        isStreaming: false,
        messageId: 'msg-final-1',
      },
    })

    expect(getAssistantTurnUiKey(turn, 0)).toBe('assistant:turn:pi-turn-1:555')
  })

  it('uses the same turn-level key for response-only turns', () => {
    const turn = makeAssistantTurn({
      turnId: 'pi-turn-1',
      timestamp: 555,
      response: {
        text: 'Done',
        isStreaming: false,
        messageId: 'msg-final-1',
      },
    })

    expect(getAssistantTurnUiKey(turn, 0)).toBe('assistant:turn:pi-turn-1:555')
  })

  it('does not depend on list index or activity ordering', () => {
    const turn = makeAssistantTurn({
      activities: [{ id: 'tool-1', type: 'tool', status: 'completed', timestamp: 1 } as AssistantTurn['activities'][number]],
      turnId: 'pi-turn-1',
      timestamp: 555,
    })
    const reorderedTurn = makeAssistantTurn({
      activities: [{ id: 'tool-2', type: 'tool', status: 'completed', timestamp: 2 } as AssistantTurn['activities'][number]],
      turnId: 'pi-turn-1',
      timestamp: 555,
    })

    const keyA = getAssistantTurnUiKey(turn, 2)
    const keyB = getAssistantTurnUiKey(reorderedTurn, 3)

    expect(keyA).toBe('assistant:turn:pi-turn-1:555')
    expect(keyB).toBe(keyA)
  })
})
