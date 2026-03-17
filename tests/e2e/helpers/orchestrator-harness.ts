/**
 * OrchestratorHarness — boots the full orchestrator with test-friendly config.
 *
 * Points at the TmuxTestHarness's isolated socket and uses fast polling intervals.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createOrchestrator, type OrchestratorHandle } from '@sirko/orchestrator'
import type { OrchestratorConfig } from '@sirko/orchestrator'

export interface OrchestratorHarnessOptions {
  tmuxSocketName: string
  /** Override any config values */
  configOverrides?: Partial<OrchestratorConfig>
}

export class OrchestratorHarness {
  private handle: OrchestratorHandle | null = null
  private _dataDir: string | null = null
  private readonly options: OrchestratorHarnessOptions

  constructor(options: OrchestratorHarnessOptions) {
    this.options = options
  }

  get orchestrator(): OrchestratorHandle {
    if (this.handle === null) throw new Error('Orchestrator not started')
    return this.handle
  }

  get dataDir(): string {
    if (this._dataDir === null) throw new Error('Orchestrator not started')
    return this._dataDir
  }

  async start(): Promise<OrchestratorHandle> {
    this._dataDir = await mkdtemp(join(tmpdir(), 'sirko-e2e-'))

    const config: OrchestratorConfig = {
      dataDir: this._dataDir,
      logDir: join(this._dataDir, 'logs'),
      tmuxSocketPath: this.options.tmuxSocketName,
      quiescenceCheckIntervalMs: 100,
      outputCoalesceWindowMs: 20,
      logLevel: 'debug',
      ...this.options.configOverrides,
    }

    this.handle = await createOrchestrator(config)
    await this.handle.start()
    return this.handle
  }

  async stop(): Promise<void> {
    if (this.handle !== null) {
      await this.handle.stop()
      this.handle = null
    }
  }

  async cleanup(): Promise<void> {
    await this.stop()
    if (this._dataDir !== null) {
      await rm(this._dataDir, { recursive: true, force: true })
      this._dataDir = null
    }
  }
}
