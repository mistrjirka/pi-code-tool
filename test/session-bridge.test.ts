import { describe, expect, it } from 'vitest'
import { APPROVAL_CHOICES, createPythonExtension } from '../src/pi/extension.js'
import type { PiBridgeContext, PiBridgeTool } from '../src/pi/bridge.js'

interface CodeTool {
  name: string
  description: string
  prepareLoadout?: (loadout: { callable: readonly PiBridgeTool[] }) => { descriptions: Record<string, string> }
  execute: (
    id: string,
    params: { code?: string; reset?: boolean; resume?: boolean },
    signal?: AbortSignal,
    onUpdate?: (partial: unknown) => void,
    ctx?: unknown,
  ) => Promise<{ content: { type: string; text: string }[]; details: { status: string; calls: string[] } }>
}

async function load(options: Parameters<typeof createPythonExtension>[0] = {}): Promise<CodeTool> {
  let registered: CodeTool | undefined
  await createPythonExtension({
    noBuiltins: true, mountWorkspace: false, toolStore: false, ...options,
  })({
    registerTool: (tool: CodeTool) => { registered = tool },
    on: () => {},
  } as never)
  if (!registered) throw new Error('Code tool was not registered')
  return registered
}

const textResult = (text: string, isError = false) => ({
  result: { content: [{ type: 'text', text }] },
  isError,
})
const readTool = (parameter = 'path'): PiBridgeTool => ({
  name: 'read', description: 'Read the current session file.',
  parameters: { properties: { [parameter]: { type: 'string' } }, required: [parameter] },
})
const bashTool: PiBridgeTool = {
  name: 'bash', description: 'Registered shell override.',
  parameters: {
    properties: { command: { type: 'string' }, background: { type: 'boolean' } },
    required: ['command'],
  },
}
const editTool: PiBridgeTool = {
  name: 'edit', description: 'Apply registered multi-edit schema.',
  parameters: {
    properties: { path: { type: 'string' }, edits: { type: 'array' } },
    required: ['path', 'edits'],
  },
}

function gate() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

describe('session-backed Python bridge', () => {
  it('renders only callable helpers using their current registered schemas', async () => {
    const code = await load()
    const first = code.prepareLoadout!({ callable: [readTool('file'), bashTool] }).descriptions.code
    expect(first).toContain('def read(file: str)')
    expect(first).toContain('background: bool = ...')
    expect(first).not.toContain('def edit(')
    expect(first).not.toContain('def write(')
    expect(first).toContain('print(read("file.txt"))')
    expect(first).not.toContain('print(ls(')
    expect(first).not.toContain('NOT standalone')
    expect(first).toContain('mirror callable registered Pi tools')
    const empty = code.prepareLoadout!({ callable: [] }).descriptions.code
    expect(empty).toContain('print(1 + 1)')
    expect(empty).not.toContain('def read(')
    const second = code.prepareLoadout!({ callable: [readTool('resource')] }).descriptions.code
    expect(second).toContain('def read(resource: str)')
    expect(second).not.toContain('def bash(')
    expect(second).not.toContain('def read(file:')
  })

  it('uses the current schema for Python checking, positional mapping, and registered dispatch', async () => {
    const code = await load({ autoApprove: true })
    const controller = new AbortController()
    const calls: Array<{ name: string; args: Record<string, unknown>; signal?: AbortSignal }> = []
    const context: PiBridgeContext = {
      tools: [readTool('file'), bashTool],
      executeTool: async (name, args, options) => {
        calls.push({ name, args, signal: options?.signal })
        return textResult(name === 'read' ? String(args.file) : 'background override')
      },
    }
    const first = await code.execute('one', {
      code: 'print(read(file="notes.txt"))\nprint(bash("safe command", background=True))',
    }, controller.signal, undefined, context)
    expect(first.details.status).toBe('ok')
    expect(calls.map(({ signal: _signal, ...call }) => call)).toEqual([
      { name: 'read', args: { file: 'notes.txt' } },
      { name: 'bash', args: { command: 'safe command', background: true } },
    ])
    expect(calls[0].signal?.aborted).toBe(false)
    expect(calls[1].signal).toBe(calls[0].signal)
    context.tools = [readTool('resource')]
    const second = await code.execute('two', { reset: true, code: 'read(resource="changed")' },
      undefined, undefined, context)
    expect(second.details.status).toBe('ok')
    expect(calls.at(-1)?.args).toEqual({ resource: 'changed' })
  })

  it('converts real Python dictionaries recursively before registered validation', async () => {
    const code = await load()
    const titles: string[] = []
    const calls: Record<string, unknown>[] = []
    const context = {
      tools: [editTool],
      hasUI: true,
      ui: { select: async (title: string) => { titles.push(title); return APPROVAL_CHOICES.approve } },
      executeTool: async (_name: string, args: Record<string, unknown>) => {
        calls.push(args)
        return textResult('edited')
      },
    }
    const result = await code.execute('edit', {
      code: 'edit("notes.txt", [{"oldText": "old", "newText": "new", "extra": {"tags": ["one", {"key": True}]}}])',
    }, undefined, undefined, context)
    expect(result.details.status).toBe('ok')
    expect(calls).toEqual([{
      path: 'notes.txt',
      edits: [{ oldText: 'old', newText: 'new', extra: { tags: ['one', { key: true }] } }],
    }])
    expect(titles[0]).toContain('"oldText":"old"')
    expect(titles[0]).toContain('"newText":"new"')
  })

  it('rejects non-string dictionary keys before dispatch, without partial writes', async () => {
    const code = await load({ autoApprove: true })
    let writes = 0
    const context: PiBridgeContext = {
      tools: [editTool],
      executeTool: async () => { writes++; return textResult('unexpected write') },
    }
    const result = await code.execute('invalid-edit', {
      code: 'edit("notes.txt", [{"oldText": "old", "newText": "new"}, {1: "bad key"}])',
    }, undefined, undefined, context)
    expect(result.details.status).toBe('error')
    expect(result.content[0].text).toContain('TypeError: Tool dictionaries require string keys')
    expect(writes).toBe(0)
  })

  it('keeps per-call approval denial ahead of registered tool execution', async () => {
    const code = await load()
    let calls = 0
    const context = {
      tools: [bashTool], hasUI: true,
      ui: { select: async () => APPROVAL_CHOICES.deny },
      executeTool: async () => { calls++; return textResult('unexpected execution') },
    }
    const result = await code.execute('denied', { code: 'bash("safe command")' },
      undefined, undefined, context)
    expect(result.details.status).toBe('error')
    expect(result.content[0].text).toContain('PermissionError')
    expect(calls).toBe(0)
  })

  it('turns registered validation and permission failures into catchable Python errors', async () => {
    const code = await load({ autoApprove: true })
    const context: PiBridgeContext = {
      tools: [readTool()],
      executeTool: async () => textResult('permission extension blocked this call', true),
    }
    const result = await code.execute('blocked', {
      code: 'try:\n    read("notes.txt")\nexcept RuntimeError as e:\n    print(str(e))',
    }, undefined, undefined, context)
    expect(result.details.status).toBe('ok')
    expect(result.content[0].text).toContain('permission extension blocked this call')
  })

  it('does not use built-in fallbacks when a current session tool is unavailable', async () => {
    const code = await load()
    let calls = 0
    const context: PiBridgeContext = {
      tools: [],
      executeTool: async () => { calls++; return textResult('unexpected execution') },
    }
    const result = await code.execute('unavailable', { code: 'read("package.json")' },
      undefined, undefined, context)
    expect(result.details.status).toBe('error')
    expect(result.content[0].text).toContain("Tool 'read' is not callable in this session")
    expect(calls).toBe(0)
    context.tools = [readTool()]
    const description = code.prepareLoadout!({ callable: context.tools }).descriptions.code
    expect(description).not.toContain('def find(')
    expect(description).not.toContain('def grep(')
    expect(description).not.toContain('def ls(')
    const disabledFind = await code.execute('disabled-find', { reset: true, code: 'find("*.ts")' },
      undefined, undefined, context)
    expect(disabledFind.details.status).toBe('error')
    expect(disabledFind.content[0].text).toContain("Tool 'find' is not callable in this session")
    expect(calls).toBe(0)
  })

  it('does not expose the outer custom tool name as a recursive helper', async () => {
    const code = await load({ toolName: 'bash', autoApprove: true })
    let calls = 0
    const context: PiBridgeContext = {
      tools: [bashTool],
      executeTool: async () => { calls++; return textResult('unexpected recursion') },
    }
    expect(code.description).not.toContain('def bash(')
    const result = await code.execute('outer', { code: 'bash("safe command")' },
      undefined, undefined, context)
    expect(result.details.status).toBe('error')
    expect(calls).toBe(0)
  })

  it('keeps overlapping sessions and their cancellation signals separate', async () => {
    const first = await load()
    const second = await load()
    const enteredFirst = gate()
    const enteredSecond = gate()
    const releaseFirst = gate()
    const releaseSecond = gate()
    const firstController = new AbortController()
    const secondController = new AbortController()
    const calls: Array<{ session: string; name: string; args: Record<string, unknown>; signal?: AbortSignal }> = []
    const firstContext: PiBridgeContext = {
      tools: [readTool('file')],
      executeTool: async (name, args, options) => {
        calls.push({ session: 'first', name, args, signal: options?.signal })
        enteredFirst.resolve()
        await releaseFirst.promise
        return textResult('first session')
      },
    }
    const secondContext: PiBridgeContext = {
      tools: [readTool('resource')],
      executeTool: async (name, args, options) => {
        calls.push({ session: 'second', name, args, signal: options?.signal })
        enteredSecond.resolve()
        await releaseSecond.promise
        return textResult('second session')
      },
    }
    const firstRun = first.execute('first', { code: 'read(file="a")' },
      firstController.signal, undefined, firstContext)
    await enteredFirst.promise
    const secondRun = second.execute('second', { code: 'read(resource="b")' },
      secondController.signal, undefined, secondContext)
    await enteredSecond.promise
    releaseSecond.resolve()
    expect((await secondRun).content[0].text).toContain('second session')
    releaseFirst.resolve()
    expect((await firstRun).content[0].text).toContain('first session')
    expect(calls.map(({ signal: _signal, ...call }) => call)).toEqual([
      { session: 'first', name: 'read', args: { file: 'a' } },
      { session: 'second', name: 'read', args: { resource: 'b' } },
    ])
    expect(calls[0].signal?.aborted).toBe(false)
    expect(calls[1].signal?.aborted).toBe(false)
    expect(calls[0].signal).not.toBe(calls[1].signal)
    // A completed cell must release its original caller's abort listener.
    firstController.abort()
    expect(calls[0].signal?.aborted).toBe(false)
    expect(calls[1].signal?.aborted).toBe(false)
  })
})
