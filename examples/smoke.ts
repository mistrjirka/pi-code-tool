/** Smoke-test the native feed, suspension, checkpoint, output and limit APIs. */
import assert from 'node:assert/strict'
import {
  FunctionSnapshot, Monty, MontyComplete, MontyRuntimeError, NameLookupSnapshot,
} from '@pydantic/monty/node'

const pool = await Monty.create({ minProcesses: 0, maxProcesses: 1 })
let session = await pool.checkout({ limits: { maxFeedDurationSecs: 1 } })
try {
  const printed: string[] = []
  const result = await session.feedRun(
    'saved = await get_temp("Tokyo")\nprint(saved)\nsaved',
    {
      externalLookup: { get_temp: async (city: unknown) => city === 'Tokyo' ? 28 : 17 },
      printCallback: (_stream, text) => { printed.push(text) },
    },
  )
  assert.equal(result, 28)
  assert.equal(printed.join(''), '28\n')
  console.log('Passed async host calls and captured output')

  const state = await session.dump()
  await session.close()
  session = await pool.checkout()
  await session.loadSession(state)
  assert.equal(await session.feedRun('saved + 1'), 29)
  console.log('Passed native heap checkpoint and restore')

  let progress = await session.feedStart('double(7) + double(3)')
  let calls = 0
  while (!(progress instanceof MontyComplete)) {
    if (progress instanceof NameLookupSnapshot) {
      progress = await progress.resume(progress.variableName)
    } else if (progress instanceof FunctionSnapshot) {
      calls++
      progress = await progress.resume(Number(progress.args[0]) * 2)
    } else {
      throw new Error('Unexpected future')
    }
  }
  assert.equal(progress.output, 20)
  assert.equal(calls, 2)
  console.log('Passed manual host-call suspension and resume')

  await assert.rejects(session.feedRun('def fail():\n    return 1 / 0\nfail()'), (error: unknown) => {
    assert(error instanceof MontyRuntimeError)
    assert.match(error.display('traceback'), /ZeroDivisionError/)
    return true
  })
  await assert.rejects(session.feedRun('while True:\n    pass'), /time limit exceeded/)
  console.log('Passed Python tracebacks and per-feed execution limits')
} finally {
  await session.close()
  await pool.close()
}
