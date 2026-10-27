import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Limit, Snapshot } from '../types'

// Based on desktop-statusline by George Liu (MIT), https://github.com/centminmod/claude-plugins

const snapshot = atom({ plugin: 'usage-band', key: 'snap' } as const, null)
const warned = atom({ plugin: 'usage-band', key: 'warned' } as const, [])
// Handoff row: "Later" hides it until the chat reaches this percent.
const snoozedBelow = atom({ plugin: 'usage-band', key: 'snoozedBelow' } as const, null)

const REFRESH_MS = 10_000
const WARN_AT = [95, 80]
const HANDOFF_AT = 85
const HANDOFF_SNOOZE_TO = 95
const HANDOFF_PROMPT =
  'Run the context-handoff skill (anthropic-skills:context-handoff) now and give me the full copy-pasteable handoff block for a new chat.'
const LABELS: Record<string, string> = { five_hour: '5-hour', seven_day: 'Weekly' }
// Shorter names for the footer meters; toasts keep the long ones.
const SHORT: Record<string, string> = { five_hour: '5h', seven_day: 'Week' }
// Padding around the hand-off row, in cells.
const EDGE_CELLS = 2
// The footer meters' bars: short, so the row fits beside the model picker.
const FOOTER_BAR_PX = 48
const BAR_H = 4
const SVG_H = BAR_H

// The app sends no limits until its first reading; keep their meters so the row doesn't jump.
const PLACEHOLDER_KINDS = ['five_hour', 'seven_day']
const label = (kind: string) => LABELS[kind] ?? kind.replace(/_/g, ' ')
const short = (kind: string) => SHORT[kind] ?? label(kind)
const tone = (percent: number) => (percent >= 95 ? 'error' : percent >= 80 ? 'warning' : undefined)

// A hairline drawn as an image, so it cannot follow the theme: a translucent track reads on light and dark.
const bar = (percent: number | null, width: number) => {
  const fill = percent === null ? '' : percent >= 95 ? '#e5484d' : percent >= 80 ? '#ef9f27' : '#378add'
  const filled = percent === null ? 0 : Math.round((Math.min(percent, 100) / 100) * width)
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${SVG_H}" viewBox="0 0 ${width} ${SVG_H}">` +
    `<rect width="${width}" height="${BAR_H}" rx="2" fill="#808080" fill-opacity="0.3"/>` +
    (filled > 0 ? `<rect width="${filled}" height="${BAR_H}" rx="2" fill="${fill}"/>` : '') +
    `</svg>`
  )
}

// Desktop buttons are drawn natively with fixed padding; non-breaking spaces widen them from inside.
// Zero-width guards keep the label from being trimmed back to its words.
const SIDE = '\u00A0'.repeat(6)
const pad = (label: string) => `\u200B${SIDE}${label}${SIDE}\u200B`

const until = (iso: string, now: number) => {
  const minutes = Math.max(0, Math.round((Date.parse(iso) - now) / 60_000))
  if (minutes < 60) return `${minutes}m`
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
  const hours = Math.floor((minutes % 1440) / 60)
  return `${Math.floor(minutes / 1440)}d${hours ? ` ${hours}h` : ''}`
}

const isOnDesktop = async ($: EngineInterface) => (await $.session.surfaces()).includes('desktop')

const warn = async ($: EngineInterface, limits: Limit[], now: number) => {
  const seen = await read($, warned)
  const fresh: string[] = []

  for (const limit of limits) {
    const threshold = WARN_AT.find(t => limit.percent >= t)
    const key = `${limit.kind}@${threshold}@${limit.resetsAt}`
    if (threshold === undefined || seen.includes(key)) continue

    fresh.push(key)
    const resets = limit.resetsAt ? ` · resets in ${until(limit.resetsAt, now)}` : ''
    $.ui.toast(`${label(limit.kind)} usage limit at ${limit.percent}%${resets}`, { timeoutMs: 8000 })
  }

  if (fresh.length > 0) await update($, warned, s => [...s, ...fresh].slice(-50))
}

const refresh = async ($: EngineInterface) => {
  if (!(await isOnDesktop($))) return

  const [usage, now, prompts] = await Promise.all([$.session.usage(), $.clock.now(), $.session.turns()])
  const limits = usage.rateLimits.map(r => ({ kind: r.kind, percent: r.percentUsed, resetsAt: r.resetsAt ?? null }))

  const snap: Snapshot = {
    at: now,
    startedAt: usage.startedAt,
    prompts,
    contextPercent: usage.context.percent ?? null,
    contextTokens: usage.context.tokens ?? null,
    contextWindow: usage.context.window,
    costUsd: usage.cost?.usd ?? null,
    limits,
  }

  await update($, snapshot, () => snap)
  if (snap.contextPercent !== null && snap.contextPercent < HANDOFF_AT) await update($, snoozedBelow, () => null)
  await warn($, limits, now)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await refresh($)
    $.clock.every(REFRESH_MS, () => void refresh($))

    return started
  })

  on('session.attach', { surface: 'desktop' }, async ($, e, next) => {
    const attached = await next(e)
    await refresh($)

    return attached
  })

  on('session.measure', async ($, e, next) => {
    const measured = await next(e)
    await refresh($)

    return measured
  })

  // After every tool call too, so the band moves during a long reply, not only when it ends.
  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    void refresh($)

    return result
  })

  on('turn.complete', async ($, e, next) => {
    const completed = await next(e)
    await refresh($)

    return completed
  })

  // Above the prompt: only the hand-off row, and only once the chat is nearly full.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.surface !== 'desktop' || e.props.hasSurvey) return next(e)

    const snap = await read($, snapshot)
    const snooze = await read($, snoozedBelow)
    const pct = snap?.contextPercent ?? null
    const isHandoff = pct !== null && pct >= HANDOFF_AT && (snooze === null || pct >= snooze)
    if (!isHandoff) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="row" alignItems="center" width="100%" columnGap={4} paddingX={EDGE_CELLS} paddingY={1}>
        <Box flexGrow={1} flexDirection="column">
          <Text bold color="warning">This chat is {pct}% full</Text>
          <Text dimColor>Hand off to a fresh chat before quality drops</Text>
        </Box>
        <Box flexDirection="row" alignItems="center" columnGap={3}>
          <Button key="handoff-later" label={pad('Later')} onPress={() => update($, snoozedBelow, () => HANDOFF_SNOOZE_TO)} />
          <Button
            key="handoff"
            label={pad('Hand off')}
            variant="primary"
            onPress={async () => {
              await update($, snoozedBelow, () => 101)
              await $.prompt.submit({ text: HANDOFF_PROMPT, asUser: true })
            }}
          />
        </Box>
      </Box>
    )
  })

  // Under the prompt, in the footer row: the 5-hour and weekly meters and the Usage link, then
  // whatever else draws there (the mcp-panel button, the mode labels), so both mods show.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const rest = await next(e)
    if (e.surface !== 'desktop') return rest

    const snap = await read($, snapshot)
    if (snap === null) return rest

    const { Box, Button, Svg, Text } = $.ui.resolve(e)
    const meter = (name: string, value: string, percent: number | null, resets = '') => (
      <Box key={`meter-${name}`} flexDirection="row" alignItems="center" columnGap={1}>
        <Text dimColor>{name}</Text>
        <Svg source={bar(percent, FOOTER_BAR_PX)} alt={percent !== null ? `${name} ${percent}% used` : ''} width={FOOTER_BAR_PX} height={SVG_H} />
        <Text bold color={percent === null ? undefined : tone(percent)}>{value}</Text>
        {resets ? <Text dimColor>{resets}</Text> : null}
      </Box>
    )
    // The reset time follows the %, dimmed, e.g. "↻ 3h 43m".
    const limits =
      snap.limits.length === 0
        ? PLACEHOLDER_KINDS.map(kind => meter(short(kind), '–', null))
        : snap.limits.map(l => meter(short(l.kind), `${l.percent}%`, l.percent, l.resetsAt ? `↻ ${until(l.resetsAt, snap.at)}` : ''))

    return (
      <Box flexDirection="row" alignItems="center" columnGap={3}>
        {limits}
        {/* Opens the usage-analytics side pane (its /spend command). */}
        <Button key="open-usage" label="Usage ›" plain onPress={() => void $.command.run({ command: 'spend' })} />
        {rest}
      </Box>
    )
  })
}
