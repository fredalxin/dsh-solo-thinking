import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { THINKING_STATE_EVENT, createSpace, foldThinkingSpace } from '../lib/index.js'
import { installRcEventCatalogEntry } from '../lib/index.js'

const storageRoot = await mkdtemp(join(tmpdir(), 'dsh-solo-thinking-'))
const id = SessionId('solo-thinking-persistence-check')

const first = new Context()
const unregisterFirst = installRcEventCatalogEntry()
await first.plugin(SessionStore)
await first.plugin(JsonlSessionPersistence, {
  root: storageRoot,
  compression: 'none',
  writeBatchMaxDelayMs: 1,
})
const session = first.sessions.create(id)
session.append(THINKING_STATE_EVENT, { space: createSpace(id, 'Persistence check', 1) })
await first.fiber.dispose()
unregisterFirst()

const second = new Context()
const unregisterSecond = installRcEventCatalogEntry()
await second.plugin(SessionStore)
await second.plugin(JsonlSessionPersistence, {
  root: storageRoot,
  compression: 'none',
  writeBatchMaxDelayMs: 1,
})
const restored = await second.sessionPersistence.load(id)
const space = foldThinkingSpace(restored.events)
await second.fiber.dispose()
unregisterSecond()

if (space?.rootSessionId !== id || restored.events.at(-1)?.type !== THINKING_STATE_EVENT) {
  throw new Error('Thinking state did not survive the real DSH JSONL persistence reload')
}

console.log('DSH JSONL persistence reload succeeded')
