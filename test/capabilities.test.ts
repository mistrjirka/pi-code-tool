import { describe, expect, it } from 'vitest'
import { probeImportableModules } from '../src/index.js'

describe('probeImportableModules', () => {
  it('reports real interpreter capabilities', async () => {
    const modules = await probeImportableModules()
    expect(modules).toContain('json')
    expect(modules).toContain('re')
    expect(modules).toContain('pathlib')
    expect(modules).toContain('time') // supported by the pinned Monty 1.0.0
  })

  it('respects a custom candidate list', async () => {
    expect(await probeImportableModules(['json', 'definitely_not_a_module'])).toEqual(['json'])
  })
})

import { probeTypeCheckerGaps, renderPythonToolRules } from '../src/index.js'

describe('probeTypeCheckerGaps', () => {
  it('finds unresolved names without executing candidate code', async () => {
    expect(await probeTypeCheckerGaps(['len', '__missing_runtime_name__'])).toEqual(['__missing_runtime_name__'])
  })
})

describe('renderPythonToolRules', () => {
  it('drops importable modules from the blocked counterexamples', () => {
    const rules = renderPythonToolRules(['json', 'time'])
    expect(rules).toContain('ONLY these modules exist: json, time')
    expect(rules).not.toMatch(/e\.g\.[^\n]*time/)
    expect(rules).toMatch(/e\.g\.[^\n]*random/)
  })
})
