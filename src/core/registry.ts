import { MontySyntaxError, MontyTypingError } from '@pydantic/monty/node'
import { checkCode } from './runtime.js'
import type { HostTool, HostToolParam } from './types.js'

/** Holds host tools and renders the Python stubs the model sees. */
export class ToolRegistry {
  private readonly tools = new Map<string, HostTool>()
  private typeStubCache: { key: string; result: Promise<string> } | null = null

  constructor(tools: HostTool[] = []) {
    for (const tool of tools) this.add(tool)
  }

  add(tool: HostTool): void {
    if (!/^[a-z_][a-z0-9_]*$/i.test(tool.name)) {
      throw new Error(`Tool name '${tool.name}' is not a valid Python identifier`)
    }
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool '${tool.name}' is already registered`)
    }
    this.tools.set(tool.name, tool)
    this.typeStubCache = null
  }

  get(name: string): HostTool | undefined {
    return this.tools.get(name)
  }

  has(name: string): boolean {
    return this.tools.has(name)
  }

  list(): HostTool[] {
    return [...this.tools.values()]
  }

  /** Python stubs for every registered tool, for the system/tool prompt. */
  renderStubs(): string {
    return this.list().map(renderToolStub).join('\n\n')
  }

  /**
   * Type-only declarations for Monty's checker. Invalid legacy prose types
   * fall back to Any for that tool. Interpreter/infrastructure failures do not
   * disable checking. Cache keys include dynamic parameter and return types.
   */
  renderTypeStubs(): Promise<string> {
    const tools = this.list().sort((a, b) => a.name.localeCompare(b.name, 'en'))
    const stubs = tools.map((tool) => {
      const params = renderParams(tool, (p) => ' | None = None')
      return { name: tool.name, stub: 'def ' + tool.name + '(' + params + ') -> ' + tool.returns + ':\n    raise NotImplementedError' }
    })
    const key = JSON.stringify(stubs)
    if (this.typeStubCache?.key !== key) {
      this.typeStubCache = {
        key,
        result: Promise.all(stubs.map(({ name, stub }) => validatedTypeStub(name, stub))).then((values) => values.join('\n')),
      }
    }
    return this.typeStubCache.result
  }
}

function renderParams(tool: HostTool, optionalSuffix: (p: HostToolParam) => string): string {
  return tool.params
    .map((p) => `${p.name}: ${p.type}${p.optional ? optionalSuffix(p) : ''}`)
    .join(', ')
}

const validatedStubs = new Map<string, Promise<string>>()

function validatedTypeStub(name: string, stub: string): Promise<string> {
  let result = validatedStubs.get(stub)
  if (!result) {
    result = checkCode('pass', { typeCheck: true, stubs: stub })
      .then(() => stub, (error: unknown) => {
        if (error instanceof MontyTypingError || error instanceof MontySyntaxError) return name + ': Any'
        throw error
      })
    if (validatedStubs.size >= 256) validatedStubs.delete(validatedStubs.keys().next().value!)
    validatedStubs.set(stub, result)
  }
  return result
}

/**
 * Renders one tool as a Python function stub with a docstring, e.g.:
 *
 *     def read_file(path: str) -> str:
 *         """Read a text file.
 *
 *         Args:
 *             path: Path relative to the workspace root.
 *
 *         Returns:
 *             str: the file text
 *         """
 */
export function renderToolStub(tool: HostTool): string {
  const params = renderParams(tool, () => ' = ...')

  const doc: string[] = [tool.description.trim()]
  const described = tool.params.filter((p) => p.description)
  if (described.length > 0) {
    doc.push('', 'Args:')
    for (const p of described) doc.push(`    ${p.name}: ${p.description}`)
  }
  if (tool.returnsDescription) {
    doc.push('', 'Returns:', `    ${tool.returns}: ${tool.returnsDescription}`)
  }

  const body = doc.length === 1 ? `"""${doc[0]}"""` : `"""${doc.join('\n')}\n"""`
  const indented = body
    .split('\n')
    .map((line) => (line === '' ? '' : `    ${line}`))
    .join('\n')
  return `def ${tool.name}(${params}) -> ${tool.returns}:\n${indented}`
}

/** Counterexample pool for the import rule; filtered against what's importable. */
const BLOCKED_EXAMPLES = ['time', 'random', 'collections', 'requests', 'numpy']

/**
 * Ground rules for the model writing sandboxed Python, reflecting monty's
 * verified behavior (docs/research/03-monty.md). Include alongside the stubs.
 * Pass the result of `probeImportableModules()` so the import list reflects
 * the installed interpreter rather than a guess.
 */
export function renderPythonToolRules(importableModules: string[]): string {
  const blocked = BLOCKED_EXAMPLES.filter((m) => !importableModules.includes(m))
  return `\
- Call tools as plain functions, WITHOUT \`await\`.
- Use print() to surface anything you need to see; printed output is returned to you.
- The value of the last top-level expression is returned as the result (expressions
  inside if/try blocks are not).
- Imports: ONLY these modules exist: ${importableModules.join(', ')}. Anything else
  (e.g. ${blocked.join(', ')}) raises ModuleNotFoundError — there are no third-party
  packages.
- Class definitions and match statements are not supported.
- Tool failures raise normal Python exceptions you can catch (e.g. ValueError,
  FileNotFoundError, OSError).`
}
