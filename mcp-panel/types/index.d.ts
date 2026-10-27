export type Health = 'ok' | 'down' | 'auth' | 'unknown'
export type Server = { name: string; group: string; order: number; health: Health; detail: string; tools: number; isOff: boolean }
export type Board = { servers: Server[]; checkedAt: number; isChecking: boolean; busy: string; note: string }

declare module 'claude-code' {
  interface PluginState {
    'mcp-panel': { board: Board }
  }
}
