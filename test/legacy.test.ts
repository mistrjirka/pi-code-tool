import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MountDir } from '@pydantic/monty/node'
import { afterEach, describe, expect, it } from 'vitest'
import { Session } from '../src/index.js'
import type { HostTool } from '../src/index.js'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function workspace(value: string) {
  const directory = await mkdtemp(join(tmpdir(), 'pi-legacy-import-'))
  directories.push(directory)
  const file = join(directory, 'value.txt')
  await writeFile(file, value)
  return {
    file,
    mount: (mode: 'read-only' | 'read-write' = 'read-only') => new MountDir({
      hostPath: directory, virtualPath: '/workspace', mode,
    }),
  }
}

const key = (...args: unknown[]) => JSON.stringify([args, {}])
const state = (snippets: unknown[], calls: unknown[] = [], extra: Record<string, unknown> = {}) =>
  JSON.stringify({ version: 2, snippets, calls, stdout: '', ...extra }, null, 2)

function tools(events: string[]): HostTool[] {
  return [
    {
      name: 'read', description: 'read', params: [{ name: 'path', type: 'str' }], returns: 'str',
      execute: ([path]) => { events.push('read:' + path); return 'current' },
    },
    {
      name: 'effect', description: 'effect', params: [{ name: 'value', type: 'int' }], returns: 'int',
      requiresApproval: true,
      execute: ([value]) => { events.push('effect:' + value); return value },
    },
  ]
}

describe('legacy session import', () => {
  it.each([1, 2])('imports version %i once and keeps new identical calls live', async (version) => {
    const events: string[] = []
    const hostTools = tools(events)
    const raw = state([
      { code: 'record = read("same")\nreceipt = effect(7)\nsaved_x = x\ndef _double(n: int) -> int:\n    return n * 2\nprint("old output")', inputs: { x: 1 } },
      { code: 'scaled = x * 2', inputs: { x: 2 } },
    ], [
      { tool: 'read', ...(version === 2 ? { key: key('same') } : {}), result: 'historical' },
      { tool: 'effect', ...(version === 2 ? { key: key(7) } : {}), result: 7 },
    ], { version, stdout: 'old output\n' })
    const session = Session.load(raw, { tools: hostTools })
    expect(session.dump()).toBe(raw)
    let approvals = 0
    const prints: string[] = []
    const result = await session.run('[record, read("same"), receipt, effect(7), saved_x, scaled, x, _double(2)]', {
      inputs: { x: 3 }, onApproval: () => { approvals++; return true }, onPrint: (text) => prints.push(text),
    })
    expect(result.status, result.error).toBe('ok')
    expect(result.output).toEqual(['historical', 'current', 7, 7, 2, 4, 3, 4])
    expect(events).toEqual(['read:same', 'effect:7'])
    expect(approvals).toBe(1)
    expect(result.calls.map((call) => call.tool)).toEqual(['read', 'effect'])
    expect(result.stdout).toBe('')
    expect(prints).toEqual([])
    expect(JSON.parse(session.dump()).version).toBe(3)
    const restored = Session.load(session.dump(), { tools: hostTools })
    expect((await restored.run('[record, _double(3), saved_x, x]')).output).toEqual(['historical', 6, 2, 3])
    expect(events).toHaveLength(2)
  })

  it('keeps static checking of recovered private functions and new helpers before effects', async () => {
    const events: string[] = []
    const session = Session.load(state([{ code: '_x = 4\ndef _double(n: int) -> int:\n    return n * 2' }]), {
      tools: tools(events),
    })
    expect((await session.run('_double(_x)')).output).toBe(8)
    for (const code of ['effect(1)\n_double("bad")', 'effect(1)\nmissing_value', 'effect(1)\nread(123)']) {
      const failed = await session.run(code, { onApproval: () => true })
      expect(failed.errorKind, failed.error).toBe('typing')
      expect(failed.calls).toEqual([])
    }
    expect(events).toEqual([])
  })

  it('replays caught saved errors and denials without calls or approval', async () => {
    const events: string[] = []
    const raw = state([{ code: [
      'try:', '    read("failed")', 'except RuntimeError as error:', '    failure = str(error)',
      'try:', '    effect(3)', 'except PermissionError as error:', '    denial = str(error)',
    ].join('\n') }], [
      { tool: 'read', key: key('failed'), error: { pythonType: 'RuntimeError', message: 'saved failure' } },
      { tool: 'effect', key: key(3), denied: true },
    ])
    let approvals = 0
    const session = Session.load(raw, { tools: tools(events) })
    const result = await session.run('[failure, denial]', { onApproval: () => { approvals++; return true } })
    expect(result.output, result.error).toEqual(['saved failure', 'effect call denied by the user'])
    expect(events).toEqual([])
    expect(approvals).toBe(0)
  })

  it('uses current readonly file observations once, then preserves them across restart', async () => {
    const files = await workspace('at import')
    const raw = state([{ code: 'captured = open("/workspace/value.txt").read()' }])
    const session = Session.load(raw)
    expect((await session.run('captured', { mount: files.mount() })).output).toBe('at import')
    await writeFile(files.file, 'latest')
    const restored = Session.load(session.dump())
    const next = await restored.run('[captured, open("/workspace/value.txt").read()]', { mount: files.mount() })
    expect(next.output, next.error).toEqual(['at import', 'latest'])
    await rm(files.file)
    expect((await Session.load(restored.dump()).run('captured')).output).toBe('at import')
  })

  it('downscopes current writable mounts and preserves caught historical permission errors', async () => {
    const files = await workspace('unchanged')
    const raw = state([{ code: [
      'from pathlib import Path', 'denied = False', 'try:',
      '    Path("/workspace/value.txt").write_text("must not write")',
      'except PermissionError:', '    denied = True',
      'captured = Path("/workspace/value.txt").read_text()',
    ].join('\n') }])
    const session = Session.load(raw)
    const result = await session.run('[denied, captured]', { mount: files.mount('read-write') })
    expect(result.output, result.error).toEqual([true, 'unchanged'])
    expect(await readFile(files.file, 'utf8')).toBe('unchanged')
  })

  it('preserves poisoned state exactly, permits retry, and never dispatches fresh code on failure', async () => {
    const files = await workspace('changed')
    const events: string[] = []
    const raw = state([{ code: 'captured = open("/workspace/value.txt").read()\nassert captured == "original"\nreceipt = effect(1)' }], [
      { tool: 'effect', key: key(1), result: 1 },
    ])
    const session = Session.load(raw, { tools: tools(events) })
    const failed = await session.run('effect(2)', { mount: files.mount(), onApproval: () => true })
    expect(failed.errorKind).toBe('state')
    expect(failed.error).toContain('cannot safely restore legacy Python state')
    expect(failed.error).toContain('AssertionError')
    expect(session.dump()).toBe(raw)
    expect(events).toEqual([])
    await writeFile(files.file, 'original')
    expect((await session.run('[captured, receipt]', { mount: files.mount() })).output).toEqual(['original', 1])
    expect(events).toEqual([])
  })

  it.each([
    ['effect(2)', 'arguments changed'],
    ['read("same")', 'order changed'],
    ['effect(1)\neffect(2)', 'uncached historical helper'],
    ['pass', 'consumed 0 of 1'],
  ])('never falls through to live dispatch for divergent history: %s', async (code, reason) => {
    const events: string[] = []
    const raw = state([{ code }], [{ tool: 'effect', key: key(1), result: 1 }])
    const session = Session.load(raw, { tools: tools(events) })
    const result = await session.run('effect(1)', { onApproval: () => true })
    expect(result.errorKind, result.error).toBe('state')
    expect(result.error).toContain(reason)
    expect(session.dump()).toBe(raw)
    expect(events).toEqual([])
  })

  it('does not let Python catch cache mismatches and consume a fresh effect', async () => {
    const events: string[] = []
    const raw = state([{ code: 'try:\n    effect(2)\nexcept Exception:\n    pass' }], [
      { tool: 'effect', key: key(1), result: 1 },
    ])
    const session = Session.load(raw, { tools: tools(events) })
    const result = await session.run('effect(1)', { onApproval: () => true })
    expect(result.error).toContain('arguments changed')
    expect(session.dump()).toBe(raw)
    expect(events).toEqual([])
  })

  it('keeps pending input overrides separate from the committed rollback heap', async () => {
    const events: string[] = []
    const hostTools = tools(events)
    const raw = state([{ code: 'derived = x * 2', inputs: { x: 1 } }], [
      { tool: 'read', key: key('6'), result: 'cached six' },
    ], { suspended: {
      code: 'cached = read(str(derived))\nreceipt = effect(derived)\n[derived, cached, receipt, x]',
      inputs: { x: 3 }, cacheLen: 0, stdout: '',
    } })
    const session = Session.load(raw, { tools: hostTools })
    const suspended = await session.resume({ onApproval: () => 'suspend' })
    expect(suspended.status, suspended.error).toBe('suspended')
    expect(suspended.suspendedCall?.args).toEqual([6])
    expect(events).toEqual([])
    const saved = session.dump()
    const resumed = await Session.load(saved, { tools: hostTools }).resume({ onApproval: () => true })
    expect(resumed.output, resumed.error).toEqual([6, 'cached six', 6, 3])
    expect(events).toEqual(['effect:6'])
    const abandoned = Session.load(saved, { tools: hostTools })
    expect(abandoned.abandon()).toBe(true)
    expect((await abandoned.run('[derived, x]')).output).toEqual([2, 1])
    const legacyAbandon = Session.load(raw, { tools: hostTools })
    expect(legacyAbandon.abandon()).toBe(true)
    expect(JSON.parse(legacyAbandon.dump()).calls).toEqual([])
    expect((await legacyAbandon.run('[derived, x]')).output).toEqual([2, 1])
    expect(events).toEqual(['effect:6'])
  })

  it('preserves a failed legacy resume cache and can explicitly abandon it', async () => {
    const events: string[] = []
    const raw = state([{ code: 'kept = 7' }], [{ tool: 'effect', key: key(1), result: 1 }], {
      suspended: { code: 'effect(1)\n1 / 0', cacheLen: 0, stdout: '' },
    })
    const session = Session.load(raw, { tools: tools(events) })
    const result = await session.resume({ onApproval: () => true })
    expect(result.errorKind, result.error).toBe('state')
    expect(result.error).toContain('ZeroDivisionError')
    expect(session.dump()).toBe(raw)
    expect(events).toEqual([])
    expect(session.abandon()).toBe(true)
    expect((await session.run('kept')).output).toBe(7)
  })

  it('rejects missing saved results instead of inventing None', () => {
    expect(() => Session.load(state([{ code: 'saved = effect(1)' }], [{ tool: 'effect', key: key(1) }]))).toThrow('malformed legacy')
  })

  it('preserves old default OS errors without changing fresh native behavior', async () => {
    const raw = state([{ code: [
      'import os', 'blocked = False', 'try:', '    os.getenv("LEGACY_UNUSED_TEST_VAR")',
      'except RuntimeError:', '    blocked = True',
    ].join('\n') }])
    const session = Session.load(raw)
    const result = await session.run('import time\ntime.sleep(0)\nblocked')
    expect(result.output, result.error).toBe(true)
    expect(JSON.parse(session.dump()).version).toBe(3)
  })

  it('never automatically sleeps while reconstructing historical code', async () => {
    const raw = state([{ code: 'import time\ntime.sleep(0)' }])
    const session = Session.load(raw)
    const result = await session.run('1')
    expect(result.errorKind, result.error).toBe('state')
    expect(result.error).toContain('sleep')
    expect(session.dump()).toBe(raw)
  })

  it('keeps raw state when the imported checkpoint exceeds its bound', async () => {
    const raw = state([{ code: 'saved = 1' }])
    const session = Session.load(raw, { maxCheckpointBytes: 32 })
    const result = await session.run('saved')
    expect(result.errorKind).toBe('state')
    expect(result.error).toContain('checkpoint exceeds')
    expect(session.dump()).toBe(raw)
  })
})
