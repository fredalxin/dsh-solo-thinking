import { KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'
import { THINKING_STATE_EVENT } from './domain.js'

interface RuntimeEventCatalog {
  registerEventType?: (type: string) => () => void
}

/**
 * DSH 0.1.0-rc.6 generates a closed persistence vocabulary and exposes no
 * downstream registration service yet. Register this plugin's required event
 * in the exported live catalog until DSH adds that service.
 */
export function installRcEventCatalogEntry(runtime?: unknown): () => void {
  const register = (runtime as RuntimeEventCatalog | undefined)?.registerEventType
  if (register) return register.call(runtime, THINKING_STATE_EVENT)
  const catalog = KNOWN_SESSION_EVENT_TYPES as Set<string>
  const alreadyKnown = catalog.has(THINKING_STATE_EVENT)
  catalog.add(THINKING_STATE_EVENT)
  return () => {
    if (!alreadyKnown) catalog.delete(THINKING_STATE_EVENT)
  }
}
