import { createServer } from 'node:http'

const port = Number(process.env.SOLO_E2E_PROVIDER_PORT ?? 8_000)
const apiKey = process.env.SOLO_E2E_PROVIDER_KEY ?? 'solo-e2e-key'
let call = 0

const actionFor = (messages) => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== 'user') continue
    const text = messageText(message.content)
    if (text.includes('[solo-thinking:split-request]')) {
      const childId = text.match(/exact pending child id is:\s*(thinking-[\w-]+)/)?.[1]
      if (!childId) throw new Error('split request is missing its pending child id')
      return {
        index,
        delayMs: 250,
        tool: {
          name: 'thinking_fork_handoff',
          arguments: {
            childId,
            handoff: '# Handoff\n\n## Objective and scope\n验证 DSH 插件端到端技术路径。\n\n## Confirmed conclusions\n根节点已启动，子分支只继承定向交接。\n\n## Evidence or artifacts\nsoloThinking pending projection 已生成。\n\n## Unresolved questions\n需要验证 Current State 与 Return。\n\n## Risks and assumptions\n不复制父分支原始对话。\n\n## Recommended first action\n开始技术分支并刷新 Current State。',
          },
        },
      }
    }
    if (text.includes('[solo-thinking:checkpoint-request]')) {
      return {
        index,
        delayMs: 250,
        tool: {
          name: 'thinking_checkpoint',
          arguments: {
            handoff: '# Handoff\n\n## Objective and scope\n验证独立 DSH Session。\n\n## Confirmed conclusions\n普通 DSH Session 可承载隔离分支。\n\n## Evidence or artifacts\n子 Session 初始为 blank，且未自动唤醒。\n\n## Unresolved questions\n需要验证最终回传。\n\n## Risks and assumptions\n真实模型的工具选择质量需单独验证。\n\n## Recommended next action\n返回最终 Handoff。',
          },
        },
      }
    }
    if (text.includes('[solo-thinking:return-request]')) {
      return {
        index,
        delayMs: 250,
        tool: {
          name: 'thinking_return',
          arguments: {
            handoff: '# Final Handoff\n\n## Conclusions\nDSH Web、Agent loop、工具、Projection 与独立 Session 路径已连通。\n\n## Evidence / Artifacts\n完成 start、split、checkpoint、returning 与 Agent-authored return。\n\n## Unresolved risks\n真实模型的工具选择质量需单独用有效 API Key 验证。\n\n## Recommended next action\n在父 Session 展开持久化 Handoff，并继续综合。',
          },
        },
      }
    }
    if (text.includes('E2E：自动建议四个方向')) {
      const directions = [
        ['用户价值', '验证目标用户、核心痛点与高频使用场景。'],
        ['技术路径', '验证架构边界、依赖、风险与最小实现路径。'],
        ['商业模型', '验证付费对象、定价假设与可持续性。'],
        ['体验设计', '验证首次使用、分支控制与结果回收体验。'],
      ].map(([title, objective]) => ({
        title,
        handoff: `# Handoff\n\n## Objective and scope\n${objective}\n\n## Confirmed conclusions\n根分支已建立头脑风暴空间。\n\n## Evidence or artifacts\n来自根分支的自动建议。\n\n## Unresolved questions\n需要在本分支继续验证。\n\n## Risks and assumptions\n不要读取其他分支原始对话。\n\n## Recommended first action\n先列出三项关键假设。`,
      }))
      return { index, tool: { name: 'thinking_suggest', arguments: { directions } } }
    }
    if (text.includes('E2E：启动头脑风暴')) {
      return { index, tool: { name: 'thinking_start', arguments: { title: 'Solo DSH 完整端到端' } } }
    }
    if (text.includes('E2E：开始技术分支')) return { index }
  }
}

const server = createServer(async (request, response) => {
  const path = new URL(request.url ?? '/', 'http://solo-e2e.invalid').pathname
  if (request.method !== 'POST' || !path.endsWith('/chat/completions')) {
    response.writeHead(request.method === 'POST' ? 404 : 405).end()
    return
  }
  if (request.headers.authorization !== `Bearer ${apiKey}`) {
    response.writeHead(401, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: { message: 'invalid e2e bearer token', code: 'invalid_api_key' } }))
    return
  }

  let body
  try {
    body = JSON.parse(await readBody(request))
  } catch {
    response.writeHead(400, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: { message: 'invalid JSON', code: 'invalid_json' } }))
    return
  }

  const messages = Array.isArray(body.messages) ? body.messages : []
  const action = actionFor(messages)
  const lastToolIndex = messages.findLastIndex((message) => message?.role === 'tool')
  const afterTool = action !== undefined && lastToolIndex > action.index
  const tool = afterTool ? undefined : action?.tool
  if (tool) {
    if (action?.delayMs) await new Promise((resolve) => setTimeout(resolve, action.delayMs))
    const id = `solo-e2e-call-${++call}`
    streamTool(response, id, tool.name, JSON.stringify(tool.arguments))
    process.stdout.write(`${JSON.stringify({ type: 'tool', id, name: tool.name })}\n`)
    return
  }

  streamText(response, afterTool ? 'Controlled E2E tool round completed.' : 'Controlled E2E provider found no matching action.')
  process.stdout.write(`${JSON.stringify({ type: 'text', afterTool })}\n`)
})

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`${JSON.stringify({ type: 'ready', baseURL: `http://127.0.0.1:${port}/v1` })}\n`)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(signal === 'SIGINT' ? 130 : 143)))
}

function messageText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((part) => typeof part?.text === 'string' ? part.text : '').join('\n')
}

async function readBody(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

function openSse(response) {
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  response.flushHeaders()
}

function writeSse(response, payload) {
  response.write(`data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`)
}

function finish(response, reason, outputTokens) {
  writeSse(response, {
    choices: [{ index: 0, delta: { content: '' }, finish_reason: reason }],
    usage: { prompt_tokens: 3, completion_tokens: outputTokens },
  })
  writeSse(response, '[DONE]')
  response.end()
}

function streamText(response, text) {
  openSse(response)
  writeSse(response, { choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })
  finish(response, 'stop', Array.from(text).length)
}

function streamTool(response, id, name, args) {
  const midpoint = Math.max(1, Math.floor(args.length / 2))
  openSse(response)
  writeSse(response, {
    choices: [{
      index: 0,
      delta: {
        tool_calls: [{
          index: 0,
          id,
          type: 'function',
          function: { name, arguments: args.slice(0, midpoint) },
        }],
      },
      finish_reason: null,
    }],
  })
  writeSse(response, {
    choices: [{
      index: 0,
      delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(midpoint) } }] },
      finish_reason: null,
    }],
  })
  finish(response, 'tool_calls', 2)
}
