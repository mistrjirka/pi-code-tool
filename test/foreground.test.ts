import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createPythonExtension } from '../src/pi/extension.js'
import type { CodeResult, UserSteeringContext } from '../src/pi/execution.js'
import type { HostTool } from '../src/core/types.js'

interface Params {
  code?: string
  reset?: boolean
  resume?: boolean
  abandon?: boolean
  output?: string
  offset?: number
  limit?: number
  wait?: string
  cancel?: string
}
interface TestTool {
  execute(id: string, params: Params, signal?: AbortSignal, update?: (result: CodeResult) => void,
    context?: unknown): Promise<CodeResult>
}

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'code-foreground-'))
  directories.push(path)
  return path
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
async function load(outputDirectory: string, tools: HostTool[] = [], bridgePiTools = false) {
  let tool!: TestTool
  let restore!: (event: unknown, context: unknown) => void
  let beforeSettle!: (event: unknown, context: unknown) => Promise<void> | void
  let pending = false
  const listeners = new Set<() => void>()
  const context: UserSteeringContext = {
    hasPendingUserSteering: () => pending,
    onUserSteering: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
  await createPythonExtension({
    outputDirectory, tools, toolStore: false, noBuiltins: true, bridgePiTools, autoApprove: true,
  })({
    registerTool: (registered: TestTool) => { tool = registered },
    on: (name: string, handler: typeof beforeSettle) => {
      if (name === 'session_start') restore = handler
      if (name === 'agent_before_settle') beforeSettle = handler
    },
  } as never)
  return {
    tool, context, listeners,
    steer: () => { pending = true; for (const listener of listeners) listener() },
    consume: () => { pending = false },
    settle: (extra: Record<string, unknown> = {}) => beforeSettle({}, { ...context, ...extra }),
    restoreEntries: (entries: unknown[]) => restore({}, { sessionManager: { getBranch: () => entries } }),
    restore: (result: CodeResult) => restore({}, {
      sessionManager: { getBranch: () => [{ type: 'message', message: { toolName: 'code', details: result.details } }] },
    }),
    run: (params: Params, extra: Record<string, unknown> = {}, update?: (result: CodeResult) => void) =>
      tool.execute('call', params, undefined, update, { ...context, ...extra }),
  }
}
function host(name: string, execute: HostTool['execute']): HostTool {
  return { name, description: name, params: [], returns: 'str', execute }
}

describe('foreground code yielding', () => {
  it('returns before the running host call finishes, then checkpoints and resumes without repeating work', async () => {
    const started = deferred<void>()
    const release = deferred<string>()
    let firstCalls = 0
    let laterCalls = 0
    const extension = await load(await directory(), [
      host('first', () => { firstCalls++; started.resolve(); return release.promise }),
      host('later', () => { laterCalls++; return 'later' }),
    ])
    const updates: CodeResult[] = []
    const executing = extension.run({ code: 'a = first()\nprint(a)\nb = later()\n[a, b]' }, {}, (update) => updates.push(update))
    await started.promise
    extension.steer()
    const yielded = await executing
    expect(yielded.details.status).toBe('running')
    const id = yielded.details.cell!.id
    expect(extension.listeners.size).toBe(0)
    const emitted = updates.length
    expect((await extension.run({ code: '1' })).content[0].text).toContain('still running')
    expect((await extension.run({ reset: true, code: '1' })).details.status).toBe('error')
    extension.consume()
    release.resolve('first')
    const paused = await extension.run({ wait: id })
    expect(paused.details.status, paused.content[0].text).toBe('suspended')
    expect(paused.content[0].text).toContain('[paused]')
    expect(firstCalls).toBe(1)
    expect(laterCalls).toBe(0)
    expect(updates.length).toBe(emitted) // The original foreground no longer owns updates.
    const resumed = await extension.run({ resume: true })
    expect(resumed.details.status, resumed.content[0].text).toBe('ok')
    expect(resumed.content[0].text).toContain('["first","later"]')
    expect(firstCalls).toBe(1)
    expect(laterCalls).toBe(1)
  })

  it('loads a completed cell after restart and keeps newer state when a handle is read twice', async () => {
    const outputDirectory = await directory()
    const started = deferred<void>()
    const release = deferred<string>()
    let effects = 0
    const tools = [host('effect', () => { effects++; started.resolve(); return release.promise })]
    const first = await load(outputDirectory, tools)
    const evidence = {
      calls: { calls: [{ id: 'original/1', name: 'write', arguments: { path: 'result.txt' },
        status: 'ok' as const, durationMs: 17 }], complete: true },
      usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 5,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    }
    let takes = 0
    const executing = first.run({ code: 'saved = effect()\nsaved' }, {
      takeNestedToolCalls: () => { takes++; return evidence },
    })
    await started.promise
    first.steer()
    const yielded = await executing
    const id = yielded.details.cell!.id
    first.consume()
    release.resolve('kept')
    const completed = await first.run({ wait: id })
    expect(completed.details.status).toBe('ok')
    expect(completed.nestedCalls).toEqual(evidence.calls)
    expect(completed.usage).toEqual(evidence.usage)
    expect(takes).toBe(1)
    const restarted = await load(outputDirectory, tools)
    restarted.restore(yielded)
    const restored = await restarted.run({ wait: id })
    expect(restored.content[0].text).toContain('kept')
    expect(restored.nestedCalls).toEqual(evidence.calls)
    expect(restored.usage).toEqual(evidence.usage)
    expect(effects).toBe(1)
    const newer = await restarted.run({ code: 'saved = "newer"' })
    const duplicate = await restarted.run({ wait: id })
    expect(duplicate.details.state).toBe(newer.details.state)
    expect(duplicate.details.calls).toEqual([])
    expect(duplicate.nestedCalls).toBeUndefined()
    expect(duplicate.usage).toBeUndefined()
    restarted.restore(duplicate)
    expect((await restarted.run({ code: 'saved' })).content[0].text).toBe('=> "newer"')
    expect(effects).toBe(1)
  })

  it('never replays a cell whose completion is unknown after restart', async () => {
    const outputDirectory = await directory()
    const started = deferred<void>()
    const release = deferred<string>()
    let effects = 0
    const tools = [host('effect', () => { effects++; started.resolve(); return release.promise })]
    const first = await load(outputDirectory, tools)
    const executing = first.run({ code: 'effect()' })
    await started.promise
    first.steer()
    const yielded = await executing
    const id = yielded.details.cell!.id
    const restarted = await load(outputDirectory, tools)
    restarted.restore(yielded)
    const unknown = await restarted.run({ wait: id })
    expect(unknown.details.status).toBe('unknown')
    expect(unknown.content[0].text).toContain('will not be replayed')
    expect((await restarted.run({ code: 'effect()' })).details.status).toBe('error')
    expect(effects).toBe(1)
    const observer = await load(outputDirectory, tools)
    await observer.run({ code: 'kept = 7' })
    const observation = await observer.run({ wait: id })
    expect(observation.details.status).toBe('unknown')
    expect(observation.details.cell).toBeUndefined()
    observer.restore(observation)
    expect((await observer.run({ code: 'kept' })).content[0].text).toBe('=> 7')
    await restarted.run({ abandon: true })
    expect((await restarted.run({ code: '1' })).content[0].text).toBe('=> 1')
    first.consume()
    release.resolve('done')
    await first.run({ wait: id }) // Release the original interpreter before cleanup.
  })

  it('cancels only when explicitly requested and releases the session for new code', async () => {
    const extension = await load(await directory(), [], true)
    const started = deferred<void>()
    let aborted = false
    let executions = 0
    const context = {
      tools: [{ name: 'bash', description: 'bash', parameters: { properties: { command: { type: 'string' } }, required: ['command'] } }],
      executeTool: (_name: string, _args: unknown, options: { signal: AbortSignal }) => {
        executions++
        started.resolve()
        return new Promise<never>((_resolve, reject) => {
          options.signal.addEventListener('abort', () => {
            aborted = true
            reject(new Error('cancelled'))
          }, { once: true })
        })
      },
    }
    const executing = extension.run({ code: 'bash("slow")' }, context)
    await started.promise
    extension.steer()
    const yielded = await executing
    expect(aborted).toBe(false)
    extension.consume()
    const cancelled = await extension.run({ cancel: yielded.details.cell!.id }, context)
    expect(aborted).toBe(true)
    expect(cancelled.details.status).toBe('error')
    expect(cancelled.content[0].text).toContain('aborted')
    expect(executions).toBe(1)
    expect((await extension.run({ code: '2' })).content[0].text).toBe('=> 2')
  })

  it('forwards the original caller cancellation to the in-flight registered tool', async () => {
    const extension = await load(await directory(), [], true)
    const started = deferred<void>()
    let aborted = false
    const context = {
      tools: [{ name: 'read', description: 'read', parameters: { properties: { path: { type: 'string' } }, required: ['path'] } }],
      executeTool: (_name: string, _args: unknown, options: { signal: AbortSignal }) => {
        started.resolve()
        return new Promise<never>((_resolve, reject) => {
          options.signal.addEventListener('abort', () => {
            aborted = true
            reject(new Error('cancelled original caller'))
          }, { once: true })
        })
      },
    }
    const controller = new AbortController()
    const executing = extension.tool.execute('initial', { code: 'read("slow")' }, controller.signal,
      undefined, { ...extension.context, ...context })
    await started.promise
    controller.abort()
    const result = await executing
    expect(aborted).toBe(true)
    const final = result.details.cell ? await extension.run({ wait: result.details.cell.id }, context) : result
    expect(final.details.status).toBe('error')
    expect(final.content[0].text).toContain('aborted')
    expect(extension.listeners.size).toBe(0)
  })

  it('stops a later foreground wait without cancelling or replaying the background host call', async () => {
    const started = deferred<void>()
    const release = deferred<string>()
    let calls = 0
    const extension = await load(await directory(), [
      host('slow', () => { calls++; started.resolve(); return release.promise }),
    ])
    const original = new AbortController()
    const executing = extension.tool.execute('initial', { code: 'slow()' }, original.signal,
      undefined, extension.context)
    await started.promise
    extension.steer()
    const yielded = await executing
    extension.consume()
    const later = new AbortController()
    const waiting = extension.tool.execute('wait', { wait: yielded.details.cell!.id },
      later.signal, undefined, extension.context)
    later.abort()
    const stopped = await waiting
    expect(stopped.details.status).toBe('running')
    expect(stopped.content[0].text).toContain('stopped waiting')
    expect(original.signal.aborted).toBe(false)
    expect(extension.listeners.size).toBe(0)
    release.resolve('finished once')
    expect((await extension.run({ wait: yielded.details.cell!.id })).content[0].text)
      .toContain('finished once')
    expect(calls).toBe(1)
  })

  it('isolates a live detached continuation from a newly selected session branch', async () => {
    const started = deferred<void>()
    const release = deferred<string>()
    let laterCalls = 0
    const extension = await load(await directory(), [
      host('slow', () => { started.resolve(); return release.promise }),
      host('later', () => { laterCalls++; return 'later' }),
    ])
    const base = await extension.run({ code: 'value: str = "base"' })
    expect(base.details.status, base.content[0].text).toBe('ok')
    const executing = extension.run({ code: 'value = slow()\nlater()' })
    await Promise.race([
      started.promise,
      executing.then((result) => { throw new Error('Execution ended before slow call: ' + result.content[0].text) }),
    ])
    extension.steer()
    const yielded = await executing
    extension.consume()
    extension.restore(base)
    const branch = await extension.run({ code: 'value = "new branch"' })
    expect(branch.details.status, branch.content[0].text).toBe('ok')
    const observerAbort = new AbortController()
    const observing = extension.tool.execute('observe-old', { wait: yielded.details.cell!.id },
      observerAbort.signal, undefined, extension.context)
    observerAbort.abort()
    const observation = await observing
    expect(observation.details.status).toBe('running')
    expect(observation.details.cell).toBeUndefined()
    extension.restore(observation)
    release.resolve('old continuation')
    const old = await extension.run({ wait: yielded.details.cell!.id })
    expect(old.details.status).toBe('ok')
    expect(old.details.historical).toBe(true)
    expect(old.content[0].text).toContain('Recorded status: paused')
    expect(old.content[0].text).not.toContain('"resume": true')
    expect(old.content[0].text).not.toContain('"abandon":true')
    expect(old.details.state).toBe(branch.details.state)
    expect(laterCalls).toBe(0)
    expect((await extension.run({ code: 'value' })).content[0].text).toBe('=> "new branch"')
  })


  it('observes an old paused cell without directing or changing the newer paused script', async () => {
    const outputDirectory = await directory()
    const started = [deferred<void>(), deferred<void>()]
    const releases = [deferred<string>(), deferred<string>()]
    let slowCalls = 0
    let finishCalls = 0
    const tools = [
      host('slow', () => {
        const index = slowCalls++
        started[index].resolve()
        return releases[index].promise
      }),
      host('finish', () => 'finished-' + ++finishCalls),
    ]
    const extension = await load(outputDirectory, tools)
    const evidence = {
      calls: { calls: [{ id: 'original/1', name: 'write', status: 'ok' as const }], complete: true },
      usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 5,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    }
    const initial = extension.run({
      code: 'print("saved stdout: resume and abandon are data")\nvalue: str = slow()\nvalue = finish()\nvalue',
    }, { takeNestedToolCalls: () => evidence })
    await started[0].promise
    extension.steer()
    const first = await initial
    const oldId = first.details.cell!.id
    extension.consume()
    releases[0].resolve('old')
    const paused = await extension.run({ wait: oldId })
    expect(paused.content[0].text).toContain('"resume": true')
    expect(paused.nestedCalls).toEqual(evidence.calls)
    expect((await extension.run({ resume: true })).content[0].text).toContain('finished-1')

    const next = extension.run({ code: 'value = slow()\nvalue = finish()\nvalue' })
    await started[1].promise
    extension.steer()
    const newer = await next
    extension.consume()
    releases[1].resolve('new')
    const current = await extension.run({ wait: newer.details.cell!.id })
    expect(current.details.status).toBe('suspended')
    const observation = await extension.run({ wait: oldId })
    expect(observation.details.historical).toBe(true)
    expect(observation.details.status).toBe('ok')
    expect(observation.details.state).toBe(current.details.state)
    expect(observation.details.calls).toEqual([])
    expect(observation.nestedCalls).toBeUndefined()
    expect(observation.usage).toBeUndefined()
    expect(observation.content[0].text).toContain('Recorded status: paused')
    expect(observation.content[0].text).toContain('cannot control the current Python script')
    expect(observation.content[0].text).toContain('saved stdout: resume and abandon are data')
    expect(observation.content[0].text).not.toContain('"resume": true')
    expect(observation.content[0].text).not.toContain('"abandon":true')

    // Older cell records lack a separate preview. Never replay their stale footer.
    const file = join(outputDirectory, 'cells', oldId + '.json')
    const record: Record<string, unknown> = JSON.parse(await readFile(file, 'utf8'))
    delete record.observation
    await writeFile(file, JSON.stringify(record))
    const legacy = await extension.run({ wait: oldId })
    expect(legacy.content[0].text).toContain('original output preview is unavailable')
    expect(legacy.content[0].text).not.toContain('"resume": true')
    expect(legacy.details.state).toBe(current.details.state)

    const restarted = await load(outputDirectory, tools)
    restarted.restore(observation)
    const resumed = await restarted.run({ resume: true })
    expect(resumed.content[0].text).toContain('finished-2')
    expect(slowCalls).toBe(2)
    expect(finishCalls).toBe(2)
  })

  it('rejects incompatible control flags without discarding a pending cell', async () => {
    const started = deferred<void>()
    const release = deferred<string>()
    const extension = await load(await directory(), [
      host('slow', () => { started.resolve(); return release.promise }),
    ])
    const executing = extension.run({ code: 'value = slow()\nvalue' })
    await started.promise
    extension.steer()
    const yielded = await executing
    extension.consume()
    release.resolve('kept')
    // An invalid request must keep the pending handle even if execution just finished.
    const rejected = await extension.run({ resume: true, abandon: true })
    expect(rejected.details.status).toBe('error')
    expect(rejected.details.cell?.id).toBe(yielded.details.cell!.id)
    const completed = await extension.run({ wait: yielded.details.cell!.id })
    expect(completed.content[0].text).toBe('=> "kept"')
  })


  it('publishes detached completion before settlement while keeping new input responsive', async () => {
    const outputDirectory = await directory()
    const started = deferred<void>()
    const release = deferred<string>()
    let firstCalls = 0
    let laterCalls = 0
    let takes = 0
    const tools = [
      host('first', () => { firstCalls++; started.resolve(); return release.promise }),
      host('later', () => { laterCalls++; return 'later' }),
    ]
    const extension = await load(outputDirectory, tools)
    const published: CodeResult[] = []
    const evidence = {
      calls: { calls: [{ id: 'original/1', name: 'write', arguments: { path: 'saved.txt' },
        status: 'ok' as const }], complete: true },
      usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 5,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    }
    const executing = extension.run({ code: 'value = first()\nprint(value)\nlater()' }, {
      takeNestedToolCalls: () => { takes++; return evidence },
      publishToolCompletion: (result: CodeResult) => published.push(result),
    })
    await started.promise
    extension.steer()
    const yielded = await executing
    extension.consume()
    const interrupted = extension.settle()
    expect(published).toHaveLength(0)
    extension.steer()
    await interrupted
    expect(published).toHaveLength(0)
    expect(extension.listeners.size).toBe(0)
    extension.consume()
    const settling = extension.settle()
    release.resolve('written once')
    await settling
    expect(published).toHaveLength(1)
    const completed = published[0]
    expect(completed.details.status).toBe('suspended')
    expect(completed.details.cell).toEqual({ id: yielded.details.cell!.id, status: 'complete' })
    expect(completed.nestedCalls).toEqual(evidence.calls)
    expect(completed.usage).toEqual(evidence.usage)
    expect(completed.isError).toBe(false)
    expect(takes).toBe(1)
    expect(firstCalls).toBe(1)
    expect(laterCalls).toBe(0)
    expect(extension.listeners.size).toBe(0)
    await extension.settle()
    expect(published).toHaveLength(1)
    const duplicate = await extension.run({ wait: yielded.details.cell!.id })
    expect(duplicate.details.historical).toBe(true)
    expect(duplicate.nestedCalls).toBeUndefined()
    expect(duplicate.usage).toBeUndefined()

    const restarted = await load(outputDirectory, tools)
    restarted.restoreEntries([
      { type: 'message', message: { toolName: 'code', details: yielded.details } },
      { type: 'tool_completion', toolCallId: 'call', toolName: 'code', result: completed },
    ])
    const resumed = await restarted.run({ resume: true })
    expect(resumed.details.status, resumed.content[0].text).toBe('ok')
    expect(firstCalls).toBe(1)
    expect(laterCalls).toBe(1)
    expect((await restarted.run({ code: 'value' })).content[0].text).toBe('=> "written once"')
  })

  it.each(['wait', 'settle'])('delivers completed evidence once when %s starts collecting first', async (first) => {
    const started = deferred<void>()
    const release = deferred<string>()
    const extension = await load(await directory(), [
      host('effect', () => { started.resolve(); return release.promise }),
    ])
    const published: CodeResult[] = []
    const evidence = {
      calls: { calls: [{ id: 'original/1', name: 'write', status: 'ok' as const }], complete: true },
      usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 5,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    }
    const executing = extension.run({ code: 'value = effect()\nvalue' }, {
      takeNestedToolCalls: () => evidence,
      publishToolCompletion: (result: CodeResult) => published.push(result),
    })
    await started.promise
    extension.steer()
    const yielded = await executing
    extension.consume()
    let waiting: Promise<CodeResult>
    let settling: Promise<void> | void
    if (first === 'wait') {
      waiting = extension.run({ wait: yielded.details.cell!.id })
      settling = extension.settle()
    } else {
      settling = extension.settle()
      waiting = extension.run({ wait: yielded.details.cell!.id })
    }
    release.resolve('done')
    const [collected] = await Promise.all([waiting, settling])
    const deliveries = [...published, collected].filter((result) => result.nestedCalls !== undefined)
    expect(deliveries).toHaveLength(1)
    expect(deliveries[0].nestedCalls).toEqual(evidence.calls)
    expect(deliveries[0].usage).toEqual(evidence.usage)
    expect((await extension.run({ code: 'value' })).content[0].text).toBe('=> "done"')
    expect(extension.listeners.size).toBe(0)
  })

  it('keeps a completed pending cell recoverable when publication fails', async () => {
    const started = deferred<void>()
    const release = deferred<string>()
    const extension = await load(await directory(), [
      host('effect', () => { started.resolve(); return release.promise }),
    ])
    const executing = extension.run({ code: 'value = effect()\nvalue' }, {
      publishToolCompletion: () => { throw new Error('session append failed') },
    })
    await started.promise
    extension.steer()
    const yielded = await executing
    extension.consume()
    release.resolve('kept')
    await expect(extension.settle()).rejects.toThrow('session append failed')
    const blocked = await extension.run({ code: '1' })
    expect(blocked.details.cell!.id).toBe(yielded.details.cell!.id)
    expect(blocked.content[0].text).toContain('Collect the pending')
    const collected = await extension.run({ wait: yielded.details.cell!.id })
    expect(collected.content[0].text).toBe('=> "kept"')
    expect((await extension.run({ code: 'value' })).content[0].text).toBe('=> "kept"')
  })

  it('does not publish or adopt a completion into a newly selected branch', async () => {
    const started = deferred<void>()
    const release = deferred<string>()
    const extension = await load(await directory(), [
      host('effect', () => { started.resolve(); return release.promise }),
    ])
    const published: CodeResult[] = []
    const base = await extension.run({ code: 'value: str = "base"' })
    const executing = extension.run({ code: 'value = effect()\nvalue' }, {
      publishToolCompletion: (result: CodeResult) => published.push(result),
    })
    await started.promise
    extension.steer()
    const yielded = await executing
    extension.consume()
    const settling = extension.settle()
    extension.restore(base)
    const newer = await extension.run({ code: 'value = "new branch"' })
    release.resolve('old branch')
    await settling
    expect(published).toHaveLength(0)
    const historical = await extension.run({ wait: yielded.details.cell!.id })
    expect(historical.details.historical).toBe(true)
    expect(historical.details.state).toBe(newer.details.state)
    expect((await extension.run({ code: 'value' })).content[0].text).toBe('=> "new branch"')
  })

  it('cancels a held host call when the settlement boundary is explicitly stopped', async () => {
    const extension = await load(await directory(), [], true)
    const started = deferred<void>()
    const published: CodeResult[] = []
    let aborted = false
    const context = {
      publishToolCompletion: (result: CodeResult) => published.push(result),
      tools: [{ name: 'read', description: 'read',
        parameters: { properties: { path: { type: 'string' } }, required: ['path'] } }],
      executeTool: (_name: string, _args: unknown, options: { signal: AbortSignal }) => {
        started.resolve()
        return new Promise<never>((_resolve, reject) => {
          options.signal.addEventListener('abort', () => {
            aborted = true
            reject(new Error('boundary cancelled'))
          }, { once: true })
        })
      },
    }
    const executing = extension.run({ code: 'read("held")' }, context)
    await started.promise
    extension.steer()
    const yielded = await executing
    extension.consume()
    const controller = new AbortController()
    const settling = extension.settle({ signal: controller.signal })
    controller.abort()
    await settling
    expect(aborted).toBe(true)
    expect(published).toHaveLength(0)
    expect(extension.listeners.size).toBe(0)
    const result = await extension.run({ wait: yielded.details.cell!.id })
    expect(result.details.status).toBe('error')
    expect(result.content[0].text).toContain('aborted')
  })

  it('retains complete large stdout and its traceback while bounding every streamed update', async () => {
    const outputDirectory = await directory()
    const extension = await load(outputDirectory)
    const updates: string[] = []
    const result = await extension.run({
      code: 'for i in range(1500):\n    print("x" * 1000)\nprint("last diagnostic")\n1 / 0',
    }, {}, (partial) => updates.push(partial.content[0].text))
    expect(result.details.status).toBe('error')
    expect(Buffer.byteLength(result.content[0].text)).toBeLessThan(8192)
    expect(result.content[0].text).toContain('last diagnostic')
    expect(result.content[0].text).toContain('ZeroDivisionError')
    expect(Math.max(...updates.map((value) => Buffer.byteLength(value)))).toBeLessThan(8192)
    expect(updates.length).toBeLessThan(60)
    const id = result.details.output!.id
    const full = await readFile(join(outputDirectory, id + '.txt'), 'utf8')
    expect(full.length).toBeGreaterThan(1_500_000)
    expect(full).toContain('last diagnostic')
    expect(full).toContain('ZeroDivisionError')
    const restarted = await load(outputDirectory)
    restarted.restore(result)
    const page = await restarted.run({ output: id, offset: 1_501_500, limit: 512 })
    expect(page.content[0].text).toContain('last diagnostic')
    expect(page.content[0].text).toContain('ZeroDivisionError')
    expect(page.details.calls).toEqual([])
  }, 15_000)
})
