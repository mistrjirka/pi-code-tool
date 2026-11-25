import type { AgentEndEvent } from '@earendil-works/pi-coding-agent'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RunResult } from '../core/types.js'
import type { OutputReference } from './output.js'

export interface CodeCellReference {
  id: string
  status: 'running' | 'complete' | 'unknown'
}

export interface PythonDetails {
  status: RunResult['status'] | 'running' | 'unknown'
  state: string
  calls: string[]
  output?: OutputReference
  cell?: CodeCellReference
  historical?: true
}

// The runtime owns these bounded records. Structural types support the older Pi SDK used to build this package.
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }
export interface NestedCalls {
  calls: {
    id: string
    name: string
    arguments?: { [key: string]: JsonValue }
    argumentsBytes?: number
    status: 'ok' | 'error' | 'unfinished'
    durationMs?: number
    error?: string
  }[]
  complete: boolean
}
type ToolUsage = Extract<AgentEndEvent['messages'][number], { role: 'assistant' }>['usage']

export interface CodeResult {
  content: { type: 'text'; text: string }[]
  details: PythonDetails
  isError?: boolean
  nestedCalls?: NestedCalls
  usage?: ToolUsage
}

export interface UserSteeringContext {
  /** Boundary cancellation. User steering is a separate event and does not abort this signal. */
  signal?: AbortSignal
  publishToolCompletion?(result: CodeResult): void
  hasPendingUserSteering?(): boolean
  onUserSteering?(listener: () => void): () => void
  takeNestedToolCalls?(): { calls?: NestedCalls; usage?: ToolUsage } | undefined
}

type CellRecord =
  | { version: 1; id: string; status: 'running'; state: string }
  | { version: 1; id: string; status: 'complete'; result: CodeResult; observation?: string }

/** Owns one execution while its foreground waiter can yield to user input. */
export class CodeCell {
  readonly id = randomUUID()
  readonly controller = new AbortController()
  readonly promise: Promise<CodeResult>
  foreground = true
  yieldRequested = false
  waitReason: 'steering' | 'aborted' = 'steering'
  /** Saved output without session-specific continuation instructions. Never sent as result metadata. */
  observation: string | undefined
  private result: CodeResult | undefined
  private detached = false
  private storageError: string | undefined
  private readonly directory: string
  private readonly state: string

  constructor(
    directory: string,
    state: string,
    signal: AbortSignal | undefined,
    run: (cell: CodeCell) => Promise<CodeResult>,
    readonly publishCompletion?: (result: CodeResult) => void,
  ) {
    this.directory = directory
    this.state = state
    const abort = () => this.controller.abort(signal?.reason)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    // Schedule execution after construction so all observers see a complete cell.
    this.promise = Promise.resolve().then(() => run(this)).catch((error: unknown): CodeResult => ({
      content: [{ type: 'text', text: 'Code execution failed: ' +
        (error instanceof Error ? error.message : String(error)) +
        '\nHost calls may have completed. Inspect their effects before retrying.' }],
      details: { status: 'error', state, calls: [] },
    })).then((result) => {
      signal?.removeEventListener('abort', abort)
      this.result = result
      if (this.detached) this.persist()
      return result
    })
  }

  async wait(context: UserSteeringContext, signal?: AbortSignal): Promise<CodeResult | undefined> {
    // The original tool call owns the streaming callback. A later wait has a new id.
    this.foreground = !this.detached
    let notify: () => void = () => {}
    const steering = new Promise<undefined>((resolve) => {
      notify = () => {
        this.yieldRequested = true
        resolve(undefined)
      }
    })
    const unsubscribe = context.onUserSteering?.(() => { this.waitReason = 'steering'; notify() })
    const abort = () => { this.waitReason = 'aborted'; notify() }
    signal?.addEventListener('abort', abort, { once: true })
    try {
      // Subscribe before checking to avoid losing an input between those steps.
      if (context.hasPendingUserSteering?.()) { this.waitReason = 'steering'; notify() }
      if (signal?.aborted) abort()
      const result = await Promise.race([this.promise, steering])
      if (result) return result
      this.detached = true
      this.persist()
      return this.result
    } finally {
      this.foreground = false
      unsubscribe?.()
      signal?.removeEventListener('abort', abort)
    }
  }

  get isComplete(): boolean {
    return this.result !== undefined
  }

  cancel(): void {
    this.controller.abort(new Error('Code cell cancelled'))
  }

  get persistenceWarning(): string {
    return this.storageError ? ' Cell state could not be saved: ' + this.storageError + '.' : ''
  }

  private persist(): void {
    const record: CellRecord = this.result
      ? { version: 1, id: this.id, status: 'complete', result: this.result, observation: this.observation }
      : { version: 1, id: this.id, status: 'running', state: this.state }
    try {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 })
      const file = join(this.directory, this.id + '.json')
      const temporary = file + '.' + randomUUID() + '.tmp'
      try {
        writeFileSync(temporary, JSON.stringify(record), { flag: 'wx', mode: 0o600 })
        renameSync(temporary, file)
      } finally {
        try { unlinkSync(temporary) } catch { /* rename removed the temporary path. */ }
      }
      this.storageError = undefined
    } catch (error) {
      this.storageError = (error instanceof Error ? error.message : String(error)).slice(0, 180)
    }
  }
}

/** Missing completion means the old process may have executed effects. Never replay it. */
export function readCodeCell(directory: string, id: string): CellRecord {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)) {
    throw new Error('Invalid code cell id')
  }
  const record: unknown = JSON.parse(readFileSync(join(directory, id + '.json'), 'utf8'))
  if (!record || typeof record !== 'object' || !('version' in record) || record.version !== 1 ||
      !('id' in record) || record.id !== id || !('status' in record)) {
    throw new Error('Malformed saved code cell')
  }
  if (record.status === 'running' && 'state' in record && typeof record.state === 'string') {
    return { version: 1, id, status: 'running', state: record.state }
  }
  if (record.status === 'complete' && 'result' in record && validResult(record.result) &&
      (!('observation' in record) || record.observation === undefined || typeof record.observation === 'string')) {
    return { version: 1, id, status: 'complete', result: record.result,
      observation: 'observation' in record ? record.observation as string | undefined : undefined }
  }
  throw new Error('Malformed saved code cell')
}

function validResult(value: unknown): value is CodeResult {
  if (!value || typeof value !== 'object' || !('content' in value) || !Array.isArray(value.content) ||
      !value.content.every((block: unknown) => block !== null && typeof block === 'object' &&
        'type' in block && block.type === 'text' && 'text' in block && typeof block.text === 'string') ||
      !('details' in value) || !value.details || typeof value.details !== 'object') return false
  const details = value.details
  return 'state' in details && typeof details.state === 'string' &&
    'status' in details && ['ok', 'error', 'suspended'].includes(String(details.status)) &&
    'calls' in details && Array.isArray(details.calls) &&
    details.calls.every((name: unknown) => typeof name === 'string') &&
    (!('isError' in value) || value.isError === undefined || typeof value.isError === 'boolean') &&
    (!('nestedCalls' in value) || value.nestedCalls === undefined || validNestedCalls(value.nestedCalls)) &&
    (!('usage' in value) || value.usage === undefined || validUsage(value.usage))
}

// Cell JSON is a disk trust boundary, unlike the already typed runtime callbacks.
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function validNestedCalls(value: unknown): value is NestedCalls {
  return record(value) && typeof value.complete === 'boolean' && Array.isArray(value.calls) &&
    value.calls.every((call: unknown) => record(call) &&
      typeof call.id === 'string' && typeof call.name === 'string' &&
      ['ok', 'error', 'unfinished'].includes(String(call.status)) &&
      (call.arguments === undefined || record(call.arguments)) &&
      (call.argumentsBytes === undefined || typeof call.argumentsBytes === 'number') &&
      (call.durationMs === undefined || typeof call.durationMs === 'number') &&
      (call.error === undefined || typeof call.error === 'string'))
}

function validUsage(value: unknown): value is ToolUsage {
  if (!record(value) || !record(value.cost)) return false
  const cost = value.cost
  return ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens']
    .every((key) => typeof value[key] === 'number') &&
    ['input', 'output', 'cacheRead', 'cacheWrite', 'total']
      .every((key) => typeof cost[key] === 'number')
}
