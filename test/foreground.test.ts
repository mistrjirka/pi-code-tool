import { mkdtemp, readFile, rm } from 'node:fs/promises'
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
    on: (name: string, handler: typeof restore) => { if (name === 'session_start') restore = handler },
  } as never)
  return {
    tool, context, listeners,
    steer: () => { pending = true; for (const listener of listeners) listener() },
    consume: () => { pending = false },
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
    expect(old.details.status).toBe('suspended')
    expect(old.details.state).toBe(branch.details.state)
    expect(laterCalls).toBe(0)
    expect((await extension.run({ code: 'value' })).content[0].text).toBe('=> "new branch"')
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
