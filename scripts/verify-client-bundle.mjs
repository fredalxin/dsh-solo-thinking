import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
let registration
const window = {
  __ModuleLoader__: {
    load(value) {
      registration = value
    },
  },
}

vm.runInNewContext(source, { window }, { filename: 'lib/client.js' })
if (registration?.id !== 'dsh-plugin-solo-thinking' || typeof registration.factory !== 'function') {
  throw new Error('client bundle did not register the expected DSH module')
}

const runtime = registration.factory((id) => {
  if (id === 'react') return { useMemo: (factory) => factory() }
  if (id === 'react/jsx-runtime') return { jsx: () => null, jsxs: () => null }
  if (id === '@deepseek-ai/dsh-client-ui-primitives') return { MarkdownText: () => null }
  throw new Error(`unexpected client runtime dependency: ${id}`)
})

if (typeof runtime?.apply !== 'function' || !Array.isArray(runtime?.inject)) {
  throw new Error('client bundle factory did not export a valid DSH plugin')
}

console.log('DSH client module bundle loaded successfully')
