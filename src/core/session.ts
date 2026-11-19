import { CodeRunner } from './runner.js'
import type { InterpreterCheckpoint } from './runner.js'
import { DEFAULT_MAX_CHECKPOINT_BYTES, MONTY_VERSION, checkCheckpointSize } from './runtime.js'
import type { CodeRunnerOptions } from './runner.js'
import type { RunOptions, RunResult } from './types.js'

interface SuspendedRun {
  code: string
  checkpoint: string
}

interface SessionState {
  version: 3
  montyVersion: string
  length: number
  contract: string | null
  checkpoint: string | null
  suspended: SuspendedRun | null
}

export interface SessionOptions extends CodeRunnerOptions {
  /** Maximum bytes in each native checkpoint. Default 64 MiB. */
  maxCheckpointBytes?: number
}

const stateFailure = (error: string): RunResult => ({
  status: 'error', output: undefined, stdout: '', stdoutTruncated: false,
  calls: [], errorKind: 'state', error,
})

/**
 * Persistent Python heap and call stack, stored as native checkpoints.
 * Only the newly submitted snippet executes. Earlier code, filesystem reads,
 * host calls, approvals and printed output are never replayed.
 *
 * A failed snippet restores its previous Python heap. External changes remain.
 * A suspended snippet also retains that idle heap for explicit abandonment.
 */
export class Session {
  private readonly runner: CodeRunner
  private readonly maxCheckpointBytes: number
  private checkpoint: string | null = null
  private contract: string | null = null
  private completed = 0
  private suspended: SuspendedRun | null = null
  private busy = false

  constructor(options: SessionOptions = {}) {
    this.runner = new CodeRunner(options)
    this.maxCheckpointBytes = options.maxCheckpointBytes ?? DEFAULT_MAX_CHECKPOINT_BYTES
    if (!Number.isSafeInteger(this.maxCheckpointBytes) || this.maxCheckpointBytes < 1) {
      throw new Error('maxCheckpointBytes must be a positive safe integer')
    }
  }

  get length(): number {
    return this.completed
  }

  get suspendedCode(): string | null {
    return this.suspended?.code ?? null
  }

  async run(code: string, options: RunOptions = {}): Promise<RunResult> {
    if (this.suspended) {
      throw new Error('A run is suspended; call resume() or abandon() before running new code')
    }
    return this.execute(code, options, false)
  }

  async resume(options: RunOptions = {}): Promise<RunResult> {
    if (!this.suspended) throw new Error('No suspended run to resume')
    return this.execute(this.suspended.code, options, true)
  }

  /** Discard only the paused frame. Completed host effects are not undone. */
  abandon(): boolean {
    this.ensureIdle()
    if (!this.suspended) return false
    this.suspended = null
    if (!this.checkpoint) this.contract = null
    return true
  }

  reset(): void {
    this.ensureIdle()
    this.checkpoint = null
    this.contract = null
    this.suspended = null
    this.completed = 0
  }

  private ensureIdle(): void {
    if (this.busy) throw new Error('This Python session is already executing')
  }

  private async execute(code: string, options: RunOptions, resuming: boolean): Promise<RunResult> {
    this.ensureIdle()
    if (Buffer.byteLength(code) > this.maxCheckpointBytes) {
      return stateFailure('Submitted Python code exceeds the checkpoint size limit. Previous state was preserved.')
    }
    const contract = this.runner.contract(options)
    if (this.contract !== null && contract !== this.contract) {
      return stateFailure(
        'cannot safely restore this Python session after helper types, execution limits, ' +
        'or type-check settings changed. Saved state was preserved and no code ran. ' +
        'Use reset=true to start a session with the current settings.',
      )
    }
    const previous = this.suspended
    const serialized = resuming ? previous!.checkpoint : this.checkpoint
    const initial: InterpreterCheckpoint | undefined = serialized ? {
      kind: resuming ? 'suspended' : 'idle',
      bytes: Buffer.from(serialized, 'base64'),
    } : undefined

    this.busy = true
    try {
      const outcome = await this.runner.runCheckpoint(code, options, initial, this.maxCheckpointBytes)
      const result = outcome.result
      if (result.status === 'ok') {
        if (outcome.checkpoint?.kind !== 'idle') throw new Error('Missing completed interpreter checkpoint')
        this.checkpoint = outcome.checkpoint.bytes.toString('base64')
        this.contract = contract
        this.suspended = null
        this.completed++
      } else if (result.status === 'suspended') {
        if (outcome.checkpoint?.kind !== 'suspended') throw new Error('Missing suspended interpreter checkpoint')
        this.suspended = { code, checkpoint: outcome.checkpoint.bytes.toString('base64') }
        this.contract = contract
      } else if (resuming && !outcome.retrySuspension) {
        // Reusing the old pending frame here could repeat a tool that already
        // executed, including when serialization or a size limit fails afterward.
        this.suspended = null
        if (!this.checkpoint) this.contract = null
        result.error += '\nThe suspended snippet stopped. Previous Python state was restored; ' +
          'completed host calls were not undone. There is no pending frame to retry.'
      }
      return result
    } finally {
      this.busy = false
    }
  }

  dump(): string {
    const state: SessionState = {
      version: 3,
      montyVersion: MONTY_VERSION,
      length: this.completed,
      contract: this.contract,
      checkpoint: this.checkpoint,
      suspended: this.suspended,
    }
    return JSON.stringify(state)
  }

  static load(serialized: string, options: SessionOptions = {}): Session {
    let state: SessionState
    try {
      state = JSON.parse(serialized) as SessionState
    } catch {
      throw new Error('cannot safely restore invalid Python state. Saved state must be preserved; use reset=true.')
    }
    if (!state || state.version !== 3) {
      throw new Error(
        'cannot safely restore legacy Python replay state: its original filesystem reads were not saved. ' +
        'Saved state must be preserved; use reset=true to start a new session.',
      )
    }
    if (state.montyVersion !== MONTY_VERSION) {
      throw new Error(
        'cannot safely restore a Python checkpoint from a different interpreter version. ' +
        'Saved state must be preserved; use reset=true to start a new session.',
      )
    }
    const session = new Session(options)
    const validContract = state.contract === null ||
      (typeof state.contract === 'string' && /^[a-f0-9]{64}$/.test(state.contract))
    if (!Number.isSafeInteger(state.length) || state.length < 0 || !validContract ||
        (state.checkpoint !== null && typeof state.checkpoint !== 'string') ||
        (state.suspended !== null && (!state.suspended || typeof state.suspended.code !== 'string' ||
          typeof state.suspended.checkpoint !== 'string')) ||
        ((state.checkpoint !== null || state.suspended !== null) && state.contract === null)) {
      throw new Error('cannot safely restore malformed Python state. Saved state must be preserved; use reset=true.')
    }
    for (const checkpoint of [state.checkpoint, state.suspended?.checkpoint]) {
      if (checkpoint === null || checkpoint === undefined) continue
      if (checkpoint.length === 0 || checkpoint.length % 4 !== 0 ||
          !/^[A-Za-z0-9+/]*={0,2}$/.test(checkpoint)) {
        throw new Error('cannot safely restore malformed Python checkpoint bytes. Use reset=true.')
      }
      if (checkpoint.length > Math.ceil(session.maxCheckpointBytes / 3) * 4) {
        throw new Error('cannot safely restore a Python checkpoint above the size limit. Use reset=true.')
      }
      const bytes = Buffer.from(checkpoint, 'base64')
      checkCheckpointSize(bytes, session.maxCheckpointBytes)
      if (bytes.toString('base64') !== checkpoint) {
        throw new Error('cannot safely restore malformed Python checkpoint bytes. Use reset=true.')
      }
    }
    session.checkpoint = state.checkpoint
    session.contract = state.contract
    session.completed = state.length
    session.suspended = state.suspended
    return session
  }
}
