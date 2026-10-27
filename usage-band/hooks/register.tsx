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
// Shorter names for the one-line band; toasts keep the long ones.
const SHORT: Record<string, string> = { five_hour: '5h', seven_day: 'Week' }
// Desktop metrics in CSS px: one column of `bodyColumns`, and one Box cell of padding.
const COL_PX = 12.5
const CELL_PX = 15
const SPARE = 0.95
const PAD_CELLS = 4
// Clear space between the band's content and the edge of its box.
const EDGE_CELLS = 2
const MIN_BAR_PX = 24
const MAX_BAR_PX = 120
// Share of the leftover width a bar may take; the rest is safety margin, since text widths are estimates.
const BAR_SPARE = 0.7
const BAR_H = 4
const AIR = 0
const SVG_H = BAR_H + AIR * 2
// Clear space above and below the band, as an image so it can be thinner than a blank row.
const EDGE_PX = 6
// Space between the items inside one cell, in cells.
const ITEM_GAP = 1

// The app sends no limits until its first reading; keep their columns so the layout doesn't jump.
const PLACEHOLDER_KINDS = ['five_hour', 'seven_day']
// Rough desktop width of one character (on the generous side), to size the bars.
const CHAR_PX = 10
// Share of the band each meter gets; the rest at the right holds the Usage link.
const METER_SHARE = 0.44
const METER_WIDTH = `${METER_SHARE * 100}%`
const label = (kind: string) => LABELS[kind] ?? kind.replace(/_/g, ' ')
const short = (kind: string) => SHORT[kind] ?? label(kind)
const tone = (percent: number) => (percent >= 95 ? 'error' : percent >= 80 ? 'warning' : undefined)

// A hairline drawn as an image, so it cannot follow the theme: a translucent track reads on light and dark.
const bar = (percent: number | null, width: number) => {
  const fill = percent === null ? '' : percent >= 95 ? '#e5484d' : percent >= 80 ? '#ef9f27' : '#378add'
  const filled = percent === null ? 0 : Math.round((Math.min(percent, 100) / 100) * width)
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${SVG_H}" viewBox="0 0 ${width} ${SVG_H}">` +
    `<rect y="${AIR}" width="${width}" height="${BAR_H}" rx="3" fill="#808080" fill-opacity="0.3"/>` +
    (filled > 0 ? `<rect y="${AIR}" width="${filled}" height="${BAR_H}" rx="3" fill="${fill}"/>` : '') +
    `</svg>`
  )
}

// Empty clear space of an exact height.
const spacer = (width: number, height: number) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
  // An invisible rect, so the empty image is not collapsed to nothing.
  `<rect width="${width}" height="${height}" fill="#000" fill-opacity="0"/></svg>`

// A full-width hairline between the handoff row and the meters.
const DIVIDER_H = 18
const divider = (width: number) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${DIVIDER_H}" viewBox="0 0 ${width} ${DIVIDER_H}">` +
  `<rect y="${DIVIDER_H / 2}" width="${width}" height="1" fill="#808080" fill-opacity="0.4"/></svg>`

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

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.surface !== 'desktop' || e.props.hasSurvey) return next(e)

    const snap = await read($, snapshot)
    if (snap === null) return next(e)

    const { Box, Button, Svg, Text } = $.ui.resolve(e)

    // The 5-hour and weekly limits side by side on one line, with the Usage link at the far right.
    const availPx = e.props.bodyColumns * COL_PX * SPARE - EDGE_CELLS * 2 * CELL_PX
    const halfPx = availPx * METER_SHARE - PAD_CELLS * CELL_PX
    // Both bars are the same width, sized to the widest cell ("Week 100% ↻ 6d 23h") with room to spare.
    const words = ('Week'.length + '100%'.length + '↻ 6d 23h'.length) * CHAR_PX + 3 * ITEM_GAP * CELL_PX
    const barPx = Math.max(MIN_BAR_PX, Math.min(MAX_BAR_PX, Math.floor((halfPx - words) * BAR_SPARE)))
    const meter = (name: string, value: string, percent: number | null, resets = '') => (
      <Box flexDirection="row" alignItems="center" columnGap={ITEM_GAP} width={METER_WIDTH} paddingRight={PAD_CELLS}>
        <Box flexShrink={0}><Text>{name}</Text></Box>
        <Svg source={bar(percent, barPx)} alt={percent !== null ? `${name} ${percent}% used` : ''} width={barPx} height={SVG_H} />
        <Box flexShrink={0}><Text bold color={percent === null ? undefined : tone(percent)}>{value}</Text></Box>
        {/* Never squeezed, so a reset time like "2d 11h" can't break onto two lines. */}
        {resets ? <Box flexShrink={0}><Text dimColor wrap="truncate-end">{resets}</Text></Box> : null}
      </Box>
    )

    // The reset time follows the %, dimmed, e.g. "↻ 3h 43m".
    const limits =
      snap.limits.length === 0
        ? PLACEHOLDER_KINDS.map(kind => meter(short(kind), '–', null))
        : snap.limits.map(l => meter(short(l.kind), `${l.percent}%`, l.percent, l.resetsAt ? `↻ ${until(l.resetsAt, snap.at)}` : ''))

    const snooze = await read($, snoozedBelow)
    const pct = snap.contextPercent
    const isHandoff = pct !== null && pct >= HANDOFF_AT && (snooze === null || pct >= snooze)
    const handoff = isHandoff ? (
      <Box flexDirection="column" width="100%" marginBottom={1}>
      <Box flexDirection="row" alignItems="center" width="100%" columnGap={4}>
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
      <Box marginTop={1} marginBottom={1}>
        <Svg source={divider(Math.floor(availPx))} alt="" width={Math.floor(availPx)} height={DIVIDER_H} />
      </Box>
      </Box>
    ) : null

    return (
      <Box flexDirection="column" width="100%" paddingX={EDGE_CELLS}>
        <Svg source={spacer(Math.floor(availPx), EDGE_PX)} alt="" width={Math.floor(availPx)} height={EDGE_PX} />
        {handoff}
        <Box flexDirection="row" alignItems="center" width="100%">
          {limits}
          <Box flexGrow={1} flexDirection="row" justifyContent="flex-end">
            {/* Opens the usage-analytics side pane (its /spend command). */}
            <Button key="open-usage" label="Usage ›" plain onPress={() => void $.command.run({ command: 'spend' })} />
          </Box>
        </Box>
        <Svg source={spacer(Math.floor(availPx), EDGE_PX)} alt="" width={Math.floor(availPx)} height={EDGE_PX} />
      </Box>
    )
  })
}
