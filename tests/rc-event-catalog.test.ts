import { describe, expect, it } from 'vitest'
import { KNOWN_SESSION_EVENT_TYPES, Session, SessionId } from '@deepseek-ai/dsh-session'
import { THINKING_STATE_EVENT, createSpace, foldThinkingSpace } from '../src/domain.js'
import { installRcEventCatalogEntry } from '../src/rc-event-catalog.js'

describe('DSH RC event catalog bridge', () => {
  it('uses the host SessionStore registration surface when available', () => {
    let registered: string | undefined
    let disposed = false
    const dispose = installRcEventCatalogEntry({
      registerEventType(type: string) {
        registered = type
        return () => { disposed = true }
      },
    })

    expect(registered).toBe(THINKING_STATE_EVENT)
    dispose()
    expect(disposed).toBe(true)
  })

  it('registers the required event for restore and removes only its own entry', () => {
    const wasKnown = KNOWN_SESSION_EVENT_TYPES.has(THINKING_STATE_EVENT)
    const dispose = installRcEventCatalogEntry()
    expect(KNOWN_SESSION_EVENT_TYPES.has(THINKING_STATE_EVENT)).toBe(true)

    const original = Session.create(SessionId('catalog-test'))
    original.append(THINKING_STATE_EVENT, { space: createSpace('catalog-test', 'Root', 1) })
    const restored = Session.fromRestore(original.id, structuredClone(original.events), structuredClone(original.header))
    expect(foldThinkingSpace(restored.events)?.rootSessionId).toBe('catalog-test')

    dispose()
    expect(KNOWN_SESSION_EVENT_TYPES.has(THINKING_STATE_EVENT)).toBe(wasKnown)
  })
})
