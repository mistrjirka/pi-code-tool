import { randomBytes } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MountDir } from '@pydantic/monty/node'
import { Session } from '../src/index.js'
import type { HostTool } from '../src/index.js'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function workspace(value = 'before') {
  const directory = await mkdtemp(join(tmpdir(), 'pi-checkpoint-test-'))
  directories.push(directory)
  const file = join(directory, 'value.txt')
  await writeFile(file, value)
  return {
    file,
    mount: () => new MountDir({ virtualPath: '/workspace', hostPath: directory, mode: 'read-only' }),
  }
}

function hostTool(name: string, execute: HostTool['execute'], requiresApproval = false): HostTool {
  return { name, description: name, params: [], returns: 'str', execute, requiresApproval }
}

describe('native session checkpoints', () => {
  it('preserves reads before and after a mutation while new reads see current files', async () => {
    const files = await workspace()
    let changes = 0
    const change = hostTool('change', async () => {
      changes++
      await writeFile(files.file, 'after')
      return 'changed'
    }, true)
    const session = new Session({ tools: [change] })
    const first = await session.run([
      'captured = open("/workspace/value.txt").read()',
      'assert captured == "before"',
      'change()',
      'after_change = open("/workspace/value.txt").read()',
    ].join('\n'), { mount: files.mount(), onApproval: () => true })
    expect(first.status, first.error).toBe('ok')
    await writeFile(files.file, 'latest')
    const next = await session.run('[captured, after_change, open("/workspace/value.txt").read()]', {
      mount: files.mount(),
    })
    expect(next.output, next.error).toEqual(['before', 'after', 'latest'])
    expect(next.calls).toEqual([])
    expect(changes).toBe(1)

    const restored = Session.load(session.dump(), { tools: [change] })
    await rm(files.file)
    const old = await restored.run('[captured, after_change]')
    expect(old.output, old.error).toEqual(['before', 'after'])
    expect(changes).toBe(1)
  })

  it('never repeats an old effect after a changed read and never consumes a new identical effect', async () => {
    const files = await workspace('yes')
    let effects = 0
    const effect = hostTool('effect', () => String(++effects), true)
    const session = new Session({ tools: [effect] })
    expect((await session.run(
      'if open("/workspace/value.txt").read() == "yes":\n    receipt = effect()',
      { mount: files.mount(), onApproval: () => true },
    )).status).toBe('ok')
    await writeFile(files.file, 'no')
    expect((await session.run('receipt', { mount: files.mount() })).output).toBe('1')
    expect(effects).toBe(1)
    let approvals = 0
    const fresh = await session.run('effect()', {
      mount: files.mount(), onApproval: () => { approvals++; return true },
    })
    expect(fresh.output, fresh.error).toBe('2')
    expect(fresh.calls).toHaveLength(1)
    expect(effects).toBe(2)
    expect(approvals).toBe(1)
  })

  it('resumes a saved pending frame without rereading prior files or repeating effects', async () => {
    const files = await workspace()
    let edits = 0
    let writes = 0
    const edit = hostTool('edit', async () => {
      edits++
      await writeFile(files.file, 'after')
      return 'edited'
    }, true)
    const write = hostTool('write', () => { writes++; return 'written' }, true)
    const session = new Session({ tools: [edit, write] })
    const decisions: Array<boolean | 'suspend'> = [true, 'suspend']
    const first = await session.run([
      'before = open("/workspace/value.txt").read()',
      'assert before == "before"',
      'edit()',
      'after = open("/workspace/value.txt").read()',
      'write()',
      '[before, after, open("/workspace/value.txt").read()]',
    ].join('\n'), { mount: files.mount(), onApproval: () => decisions.shift()! })
    expect(first.status, first.error).toBe('suspended')
    const restored = Session.load(session.dump(), { tools: [edit, write] })
    await writeFile(files.file, 'external')
    const resumed = await restored.resume({ mount: files.mount(), onApproval: () => true })
    expect(resumed.output, resumed.error).toEqual(['before', 'after', 'external'])
    expect(resumed.calls.map((call) => call.tool)).toEqual(['write'])
    expect(edits).toBe(1)
    expect(writes).toBe(1)
  })

  it('uses current mounts and does not restore revoked filesystem access', async () => {
    const files = await workspace()
    const session = new Session()
    expect((await session.run('saved = open("/workspace/value.txt").read()', {
      mount: files.mount(),
    })).status).toBe('ok')
    const restored = Session.load(session.dump())
    const denied = await restored.run('open("/workspace/value.txt").read()')
    expect(denied.status).toBe('error')
    expect(denied.error).toContain('PermissionError')
    expect((await restored.run('saved')).output).toBe('before')
  })

  it('preserves the checkpoint when helper types change but ignores descriptions and tool ordering', async () => {
    let calls = 0
    const alpha = hostTool('alpha', () => { calls++; return 'kept' })
    const beta = hostTool('beta', () => 'unused')
    const session = new Session({ tools: [alpha, beta] })
    expect((await session.run('saved = alpha()')).status).toBe('ok')
    const snapshot = session.dump()
    const compatible = Session.load(snapshot, { tools: [
      { ...beta, description: 'Different docs' },
      { ...alpha, description: 'Also different' },
    ] })
    expect((await compatible.run('saved')).output).toBe('kept')
    const changed = Session.load(snapshot, { tools: [
      { ...alpha, params: [{ name: 'required', type: 'int' }] }, beta,
    ] })
    const rejected = await changed.run('alpha(1)')
    expect(rejected.error).toContain('reset=true')
    expect(rejected.calls).toEqual([])
    expect(changed.dump()).toBe(snapshot)
    expect(calls).toBe(1)
  })

  it('rejects changed execution limits before running and preserves exact saved state', async () => {
    const session = new Session({ limits: { maxDurationSecs: 1 } })
    expect((await session.run('saved = 1')).status).toBe('ok')
    const snapshot = session.dump()
    const rejected = await session.run('print("must not run")', { limits: { maxDurationSecs: 2 } })
    expect(rejected.error).toContain('execution limits')
    expect(rejected.stdout).toBe('')
    expect(session.dump()).toBe(snapshot)
    expect((await session.run('saved')).output).toBe(1)
  })

  it('preserves private inputs, variables and functions across native dump/load', async () => {
    const session = new Session()
    const first = await session.run(
      '_value = _base + 1\ndef _increment(value: int) -> int:\n    return value + 1',
      { inputs: { _base: 40 } },
    )
    expect(first.status, first.error).toBe('ok')
    const restored = Session.load(session.dump())
    const next = await restored.run('[_base, _value, _increment(_value)]')
    expect(next.output, next.error).toEqual([40, 41, 42])
    const saved = restored.dump()
    const unknown = await restored.run('_not_defined')
    expect(unknown.errorKind).toBe('typing')
    expect(unknown.calls).toEqual([])
    expect(restored.dump()).toBe(saved)
  })

  it('admits new input names without replaying earlier inputs or values', async () => {
    const session = new Session()
    expect((await session.run('saved = first + 1', { inputs: { first: 40 } })).status).toBe('ok')
    const later = await session.run('[saved, first, second]', { inputs: { first: 5, second: 9 } })
    expect(later.output, later.error).toEqual([41, 5, 9])
  })

  it('resets execution time for every new feed after checkpoint restore', async () => {
    const session = new Session({ typeCheck: false, limits: { maxDurationSecs: 0.05 } })
    for (let index = 0; index < 35; index++) {
      const result = await session.run('i=0\nwhile i<20000:\n    i+=1')
      expect(result.status, 'feed ' + index + ': ' + result.error).toBe('ok')
    }
    const restored = Session.load(session.dump(), { typeCheck: false, limits: { maxDurationSecs: 0.05 } })
    expect((await restored.run('i')).output).toBe(20000)
  }, 20_000)

  it('clears a pending frame after accepted work fails so a later resume cannot repeat it', async () => {
    let effects = 0
    const effect = hostTool('effect', () => String(++effects), true)
    const session = new Session({ tools: [effect] })
    expect((await session.run('saved = 7')).status).toBe('ok')
    expect((await session.run('effect()\n1 / 0', { onApproval: () => 'suspend' })).status).toBe('suspended')
    const failed = await session.resume({ onApproval: () => true })
    expect(failed.status).toBe('error')
    expect(failed.error).toContain('no pending frame')
    expect(effects).toBe(1)
    const restored = Session.load(session.dump(), { tools: [effect] })
    await expect(restored.resume({ onApproval: () => true })).rejects.toThrow('No suspended run')
    expect((await restored.run('saved')).output).toBe(7)
    expect(effects).toBe(1)
  })

  it('clears a pending frame when checkpoint size fails after an approved effect', async () => {
    let effects = 0
    const payload = randomBytes(20_000).toString('hex')
    const effect = hostTool('effect', () => { effects++; return payload }, true)
    const session = new Session({ tools: [effect], maxCheckpointBytes: 4096 })
    expect((await session.run('saved = 3')).status).toBe('ok')
    expect((await session.run('large = effect()', { onApproval: () => 'suspend' })).status).toBe('suspended')
    const failed = await session.resume({ onApproval: () => true })
    expect(failed.status).toBe('error')
    expect(failed.error).toContain('checkpoint exceeds')
    expect(session.suspendedCode).toBeNull()
    await expect(session.resume()).rejects.toThrow('No suspended run')
    expect((await session.run('saved')).output).toBe(3)
    expect(effects).toBe(1)
  })

  it('does not keep a retry frame after a denied gate catches its error and reads a file', async () => {
    const files = await workspace()
    const effect = hostTool('effect', () => 'unreachable', true)
    const session = new Session({ tools: [effect] })
    const snippet = [
      'try:', '    effect()', 'except PermissionError:', '    pass',
      'observed = open("/workspace/value.txt").read()', '1 / 0',
    ].join('\n')
    expect((await session.run(snippet, { mount: files.mount(), onApproval: () => 'suspend' })).status).toBe('suspended')
    const result = await session.resume({ mount: files.mount(), onApproval: () => false })
    expect(result.error).toContain('ZeroDivisionError')
    expect(session.suspendedCode).toBeNull()
  })

  it('aborts a resumed call without retaining a frame that would run it again', async () => {
    let effects = 0
    const controller = new AbortController()
    const effect = hostTool('effect', () => {
      effects++
      controller.abort()
      return 'done'
    }, true)
    const session = new Session({ tools: [effect] })
    expect((await session.run('effect()', { onApproval: () => 'suspend' })).status).toBe('suspended')
    const result = await session.resume({ onApproval: () => true, signal: controller.signal })
    expect(result.errorKind).toBe('aborted')
    expect(effects).toBe(1)
    expect(session.suspendedCode).toBeNull()
    expect((await session.run('1')).output).toBe(1)
  })
})
