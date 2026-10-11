// One chat as logged: title, project, and USD per local day per model.
export type Chat = { t: string; p: string; d: Record<string, Record<string, number>> }

export type Tab = 'chats' | 'projects' | 'models'

export type View = {
  // A month as YYYY-MM, or 'custom' for the from/to range.
  period: string
  // The custom range as YYYY-MM-DD; `to` empty until the second click.
  from: string
  to: string
  tab: Tab
  open: string | null
  // The month the date picker shows, YYYY-MM.
  cal: string
  // Which end of the custom range the next day click fills.
  edge: 'from' | 'to'
  chart: 'bars' | 'curve'
  // The Monday of the week the chart shows, YYYY-MM-DD; empty for the default week.
  week: string
  isAll: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'usage-analytics': {
      rev: number
      view: View
      scannedAt: number
      status: string
    }
  }
}
