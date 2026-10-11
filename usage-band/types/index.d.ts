export type Limit = { kind: string; percent: number; resetsAt: string | null }

export type Snapshot = {
  at: number
  startedAt: number
  prompts: number
  contextPercent: number | null
  contextTokens: number | null
  contextWindow: number
  costUsd: number | null
  limits: Limit[]
}

declare module 'claude-code' {
  interface PluginState {
    'usage-band': {
      snap: Snapshot | null
      warned: string[]
      snoozedBelow: number | null
    }
  }
}
