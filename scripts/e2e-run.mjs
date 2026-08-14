const baseURL = process.env.SOLO_E2E_DSH_URL ?? 'http://127.0.0.1:3080'
const suggestSessionId = `solo-e2e-suggest-${globalThis.crypto.randomUUID()}`
const groupedSessionId = `solo-e2e-grouped-${globalThis.crypto.randomUUID()}`
const rootSessionId = `solo-e2e-${globalThis.crypto.randomUUID()}`

await rpc('session.create', { sessionId: suggestSessionId, cwd: process.cwd() })
await prompt(suggestSessionId, 'E2E：启动头脑风暴')
await waitFor((items) => revisionOf(items, suggestSessionId) === 0)
await prompt(suggestSessionId, 'E2E：自动建议四个方向')
const suggestedItems = await waitFor((items) => (revisionOf(items, suggestSessionId) ?? -1) >= 4)
const suggestedSpace = spaceOf(suggestedItems, suggestSessionId)
const suggestedNodes = suggestedSpace.nodes.filter((node) => node.parentId === suggestSessionId)
if (suggestedNodes.length !== 4 || new Set(suggestedNodes.map((node) => node.title)).size !== 4) {
  throw new Error('automatic suggestion mode did not create four distinct branches')
}
for (const node of suggestedNodes) {
  const item = suggestedItems.find((candidate) => candidate.sessionId === node.sessionId)
  if (!item?.blank || item.running || item.origin !== undefined) {
    throw new Error(`suggested branch "${node.title}" was unexpectedly auto-run`)
  }
  if (typeof node.inheritedHandoff !== 'string') {
    throw new Error(`suggested branch "${node.title}" is missing its Agent-authored Handoff`)
  }
  if (node.dormant !== true) {
    throw new Error(`suggested branch "${node.title}" is missing its persisted dormant state`)
  }
}

const { workspace } = await rpc('workspace.create', { path: process.cwd() })
await rpc('session.create', { sessionId: groupedSessionId, workspaceId: workspace.workspaceId })
await prompt(groupedSessionId, 'E2E：启动头脑风暴')
await waitFor((items) => revisionOf(items, groupedSessionId) === 0)
await prompt(groupedSessionId, 'E2E：自动建议四个方向')
const groupedItems = await waitFor((items) => (revisionOf(items, groupedSessionId) ?? -1) >= 4)
const groupedSpace = spaceOf(groupedItems, groupedSessionId)
const groupedNodes = groupedSpace.nodes.filter(node => node.parentId === groupedSessionId)
const workspaceList = await rpc('workspace.list', {})
const groupedWorkspace = workspaceList.items.find(item => item.workspaceId === workspace.workspaceId)
if (groupedNodes.length !== 4 || !groupedWorkspace
  || ![groupedSessionId, ...groupedNodes.map(node => node.sessionId)]
    .every(sessionId => groupedWorkspace.sessionIds.includes(sessionId))) {
  throw new Error('suggested branches did not inherit their parent Workspace account')
}

await rpc('session.create', { sessionId: rootSessionId, cwd: process.cwd() })
await prompt(rootSessionId, 'E2E：启动头脑风暴')
await waitFor((items) => revisionOf(items, rootSessionId) === 0)

const splitCommandPromise = rpc('commands/execute', {
  args: { agentId: rootSessionId, line: `/thinking split ${JSON.stringify({ title: '技术可行性' })}` },
})
const pendingItems = await waitFor((items) => {
  const space = items.find((item) => item.sessionId === rootSessionId)?.projections?.values?.soloThinking
  return space?.revision === 1 && space.nodes.some((node) => node.forkHandoffPending === true)
})
const splitCommand = await splitCommandPromise
if (splitCommand?.result?.kind !== 'success') {
  throw new Error('human split request was not admitted')
}
const rootSpace = spaceOf(pendingItems, rootSessionId)
const childNode = rootSpace.nodes.find((node) => node.parentId === rootSessionId)
if (!childNode?.forkHandoffPending || childNode.dormant !== true) {
  throw new Error('human split did not create a pending dormant child node')
}

const childSessionId = childNode.sessionId
const dormantChild = pendingItems.find((item) => item.sessionId === childSessionId)
if (!dormantChild?.blank || dormantChild.running || dormantChild.origin !== undefined) {
  throw new Error('child Session is not a dormant ordinary DSH Session')
}
await waitFor((items) => {
  const node = nodeOf(items, childSessionId, childSessionId)
  return revisionOf(items, childSessionId) === 2
    && node?.forkHandoffPending === false
    && typeof node?.inheritedHandoff === 'string'
})

await prompt(childSessionId, 'E2E：开始技术分支')
await waitFor((items) => {
  const item = items.find((candidate) => candidate.sessionId === childSessionId)
  const node = nodeOf(items, childSessionId, childSessionId)
  return item?.running === false
    && item?.blank === false
    && revisionOf(items, childSessionId) === 3
    && node?.dormant === undefined
})

const checkpointCommandPromise = rpc('commands/execute', {
  args: { agentId: childSessionId, line: '/thinking checkpoint' },
})
await waitFor((items) => {
  const node = nodeOf(items, childSessionId, childSessionId)
  return revisionOf(items, childSessionId) === 4
    && typeof node?.checkpointRefreshingAt === 'number'
})
const checkpointCommand = await checkpointCommandPromise
if (checkpointCommand?.result?.kind !== 'success') {
  throw new Error('human Current State refresh request was not admitted')
}
await waitFor((items) => {
  const node = nodeOf(items, childSessionId, childSessionId)
  return revisionOf(items, childSessionId) === 5
    && node?.checkpointRefreshingAt === undefined
    && typeof node?.checkpointHandoff === 'string'
})

const returnCommandPromise = rpc('commands/execute', {
  args: { agentId: childSessionId, line: '/thinking return' },
})
await waitFor((items) => {
  const node = nodeOf(items, childSessionId, childSessionId)
  return revisionOf(items, childSessionId) === 6 && node?.status === 'returning'
})
const returnCommand = await returnCommandPromise
if (returnCommand?.result?.kind !== 'success') {
  throw new Error('strict /thinking return command was not admitted')
}
const returnedItems = await waitFor((items) => {
  const node = nodeOf(items, childSessionId, childSessionId)
  return revisionOf(items, childSessionId) === 7 && node?.status === 'returned'
})

const rootFinal = spaceOf(returnedItems, rootSessionId)
const childFinal = spaceOf(returnedItems, childSessionId)
if (rootFinal.revision !== 7 || childFinal.revision !== 7) {
  throw new Error('final Thinking state was not replicated to both Sessions')
}
if (returnedItems.find((item) => item.sessionId === rootSessionId)?.running) {
  throw new Error('return unexpectedly woke the parent Agent')
}

const rootHistory = await rpc('session.history', { sessionId: rootSessionId, maxMessages: 100 })
const returnNotice = rootHistory.events.find(({ event }) => (
  event.type === 'user/message'
  && event.data?.source?.kind === 'plugin'
  && event.data.source.plugin === 'dsh-plugin-solo-thinking:return'
))
const noticeText = returnNotice?.event?.data?.content
  ?.map((part) => typeof part?.text === 'string' ? part.text : '')
  .join('\n')
if (!noticeText?.includes('Handoff returned from 技术可行性') || !noticeText.includes('## Conclusions')) {
  throw new Error('parent Session is missing the persistent returned Handoff notice')
}

process.stdout.write(`${JSON.stringify({
  ok: true,
  suggestSessionId,
  suggestedBranches: 4,
  suggestedBranchesDormant: true,
  groupedBranches: 4,
  workspaceInherited: true,
  rootSessionId,
  childSessionId,
  revision: 7,
  splitHandoff: 'agent-authored',
  checkpointHandoff: 'agent-authored',
  childStatus: 'returned',
  parentNotice: true,
})}\n`)

async function prompt(sessionId, text) {
  await rpc('session.prompt', {
    sessionId,
    mode: 'queue',
    content: [{ type: 'text', text }],
  })
}

async function waitFor(predicate, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const { items } = await rpc('session.list', {})
    if (predicate(items)) return items
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`DSH E2E condition did not settle within ${timeoutMs}ms`)
}

async function rpc(method, payload) {
  const response = await fetch(`${baseURL}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: `solo-e2e-${globalThis.crypto.randomUUID()}`,
      method,
      payload,
    }),
  })
  if (!response.ok) throw new Error(`${method} failed over HTTP ${response.status}`)
  const body = await response.json()
  if (!body.result?.ok) {
    throw new Error(`${method} failed: ${body.result?.error?.code}: ${body.result?.error?.message}`)
  }
  return body.result.value
}

function spaceOf(items, sessionId) {
  const space = items.find((item) => item.sessionId === sessionId)?.projections?.values?.soloThinking
  if (!space) throw new Error(`Session "${sessionId}" has no soloThinking projection`)
  return space
}

function revisionOf(items, sessionId) {
  return items.find((item) => item.sessionId === sessionId)?.projections?.values?.soloThinking?.revision
}

function nodeOf(items, sessionId, nodeSessionId) {
  return items
    .find((item) => item.sessionId === sessionId)
    ?.projections?.values?.soloThinking
    ?.nodes.find((node) => node.sessionId === nodeSessionId)
}
