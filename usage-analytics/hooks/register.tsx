import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Chat, Tab, View } from '../types'

// What every chat would cost at Anthropic's API list prices, read from Claude Code's own
// transcripts (~/.claude/projects). Claude deletes those after 30 days, so each chat's
// cost per day and model is also kept in this mod's store, and history outlives them.

const PANE = 'usage-analytics'
// The ledger itself stays in this module; the pane subscribes to its revision number only, so a click never ships the whole history.
const revAtom = atom({ plugin: 'usage-analytics', key: 'rev' } as const, 0)
const viewAtom = atom({ plugin: 'usage-analytics', key: 'view' } as const, {
  period: '',
  from: '',
  to: '',
  tab: 'chats',
  open: null,
  cal: '',
  edge: 'from',
  chart: 'bars',
  week: '',
  isAll: false,
} as View)
const scannedAtom = atom({ plugin: 'usage-analytics', key: 'scannedAt' } as const, 0)
const statusAtom = atom({ plugin: 'usage-analytics', key: 'status' } as const, '')

const REFRESH_MS = 120_000
// $.fs.read stops at 4 MiB; bigger transcripts are streamed through `cat`.
const READ_LIMIT = 4_000_000
const COL_PX = 12.5
const TOP = 5
const BAR_H = 4
const AIR = 6
const RULE_H = 7
const TAB_NOUN: Record<Tab, string> = { chats: 'chat', projects: 'project', models: 'model' }
const ACCENT = '#7F77DD'
const MAX_W = 520
const BIG_PX = 30
const PLOT_H = 120
// Room above the plot for the hover label.
const TIP_H = 24
// Room under the plot for the day names.
const LABEL_H = 18
const MONTH_TABS = 5

// USD per million tokens: input, output, cache read. Cache writes are 1.25x input (5-minute)
// and 2x input (1-hour); fast mode doubles everything. Most specific prefix first.
const PRICES: [string, number, number, number][] = [
  ['claude-fable-5-1', 10, 50, 0.25],
  ['claude-mythos-5-1', 10, 50, 0.25],
  ['claude-fable-5', 10, 50, 1],
  ['claude-mythos', 10, 50, 1],
  ['claude-opus-5-5', 4, 20, 0.2],
  ['claude-opus-5', 5, 25, 0.5],
  ['claude-opus-4-8', 5, 25, 0.5],
  ['claude-opus-4-7', 5, 25, 0.5],
  ['claude-opus-4-6', 5, 25, 0.5],
  ['claude-opus-4-5', 5, 25, 0.5],
  ['claude-opus-4', 15, 75, 1.5],
  ['claude-sonnet-5-5', 2, 10, 0.2],
  ['claude-sonnet-5', 2, 10, 0.2],
  ['claude-sonnet-4', 3, 15, 0.3],
  ['claude-haiku-5-5', 0.1, 0.5, 0.01],
  ['claude-haiku-4-5', 1, 5, 0.1],
]
const FALLBACK: [string, number, number, number] = ['claude-opus-5-5', 4, 20, 0.2]

type Usage = {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number }
  speed?: string
}
type Draft = Chat & { seen: Set<string>; firstPrompt?: string; hasTitle?: number }
type Line = { id: string; name: string; eur: number }

const priceUsd = (model: string, u: Usage) => {
  const [, inp, out, rd] = PRICES.find(([prefix]) => model.startsWith(prefix)) ?? FALLBACK
  const w1 = u.cache_creation?.ephemeral_1h_input_tokens ?? 0
  const w5 = u.cache_creation ? (u.cache_creation.ephemeral_5m_input_tokens ?? 0) : (u.cache_creation_input_tokens ?? 0)
  const usd =
    ((u.input_tokens ?? 0) * inp +
      w5 * inp * 1.25 +
      w1 * inp * 2 +
      (u.cache_read_input_tokens ?? 0) * rd +
      (u.output_tokens ?? 0) * out) /
    1e6
  return u.speed === 'fast' ? usd * 2 : usd
}

// claude-opus-5-5 → Opus 5.5; claude-haiku-4-5-20251001 → Haiku 4.5
const modelName = (id: string) => {
  const [family = id, ...version] = id.replace(/^claude-/, '').replace(/-\d{8}$/, '').split('-')
  return `${family.charAt(0).toUpperCase()}${family.slice(1)} ${version.join('.')}`.trim()
}

const pad = (n: number) => String(n).padStart(2, '0')
const dayOf = (ms: number) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const shortDay = (date: string) => {
  const [, m, d] = date.split('-').map(Number)
  return `${d} ${MONTHS[m - 1].slice(0, 3)}`
}
const monthLabel = (period: string, now: number) => {
  const [y, m] = period.split('-').map(Number)
  return new Date(now).getFullYear() === y ? MONTHS[m - 1] : `${MONTHS[m - 1]} ${y}`
}
const euro = (n: number) => `€${n.toFixed(2)}`
const lastSegment = (path: string) => path.replace(/\/+$/, '').split('/').pop() || path


// Reads one transcript into `chat`: cost per day and model (each API reply counted once), title, project.
const parseTranscript = (text: string, chat: Draft, home: string) => {
  for (const line of text.split('\n')) {
    const isReply = line.includes('"type":"assistant"') && line.includes('"usage"')
    const isTitle = line.includes('-title"')
    const isPrompt = !chat.firstPrompt && line.includes('"type":"user"')
    if (!isReply && !isTitle && !isPrompt) continue

    let row: any
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }

    if (row.type === 'custom-title' && row.customTitle) {
      chat.t = row.customTitle
      chat.hasTitle = 2
    } else if (row.type === 'ai-title' && row.aiTitle && (chat.hasTitle ?? 0) < 2) {
      chat.t = row.aiTitle
      chat.hasTitle = 1
    } else if (row.type === 'user' && typeof row.message?.content === 'string' && !row.message.content.startsWith('<')) {
      chat.firstPrompt = row.message.content.replace(/\s+/g, ' ').trim().slice(0, 80)
    } else if (row.type === 'assistant' && row.message?.usage && row.timestamp) {
      const id = row.message.id ?? row.uuid
      if (chat.seen.has(id)) continue
      chat.seen.add(id)
      const usd = priceUsd(row.message.model ?? '', row.message.usage)
      if (usd === 0) continue
      if (!chat.p && row.cwd) chat.p = row.cwd === home ? 'Home' : lastSegment(row.cwd)
      const day = (chat.d[dayOf(Date.parse(row.timestamp))] ??= {})
      const model = modelName(row.message.model ?? 'unknown')
      day[model] = (day[model] ?? 0) + usd
    }
  }
}

const readWhole = async ($: EngineInterface, path: string, size: number) => {
  if (size <= READ_LIMIT) return (await $.fs.read(path)) as string
  let text = ''
  for await (const piece of $.process.spawn({ argv: ['/bin/cat', path] })) {
    if (piece.stream === 'stdout') text += piece.text
  }
  return text
}

let isScanning = false
let isPaneOpen = false
let ledger: Record<string, Chat> | null = null
// Per transcript file: its size and how many bytes of whole lines are already counted.
const marks = new Map<string, { size: number; offset: number }>()
// Per chat: the running totals of its transcript, so a growing chat only reads what was added.
const drafts = new Map<string, Draft>()

const utf8Length = (text: string) => {
  let bytes = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code < 0xdc00) {
      bytes += 4
      i++
    } else bytes += 3
  }
  return bytes
}

const readFrom = async ($: EngineInterface, path: string, offset: number) => {
  let text = ''
  for await (const piece of $.process.spawn({ argv: ['/usr/bin/tail', '-c', `+${offset + 1}`, path] })) {
    if (piece.stream === 'stdout') text += piece.text
  }
  return text
}

// Counts what changed since the last scan: new chats whole, growing chats only their new lines.
const scan = async ($: EngineInterface) => {
  if (isScanning) return
  isScanning = true
  try {
    const home = (await $.env.get('HOME')) ?? ''
    const root = `${home}/.claude/projects`
    ledger ??= ((await $.store.get('v2.chats')) ?? {}) as Record<string, Chat>
    const seen = ((await $.store.get('v2.seen')) ?? {}) as Record<string, string>
    let changed = 0

    const projects = (await $.fs.exists(root)) ? await $.fs.list(root) : []
    for (const project of projects.filter(p => p.kind === 'dir')) {
      const dir = `${root}/${project.name}`
      const entries = await $.fs.list(dir)
      for (const main of entries.filter(e => e.kind === 'file' && e.name.endsWith('.jsonl'))) {
        const id = main.name.slice(0, -'.jsonl'.length)
        const files = [{ path: `${dir}/${main.name}`, size: main.size, mtimeMs: main.mtimeMs }]
        const subDir = `${dir}/${id}/subagents`
        if (entries.some(e => e.name === id && e.kind === 'dir') && (await $.fs.exists(subDir))) {
          for (const sub of await $.fs.list(subDir)) {
            if (sub.kind === 'file' && sub.name.endsWith('.jsonl')) files.push({ path: `${subDir}/${sub.name}`, size: sub.size, mtimeMs: sub.mtimeMs })
          }
        }

        const signature = files.map(f => `${f.size}:${f.mtimeMs}`).join('|')
        let draft = drafts.get(id)
        if (seen[id] === signature && draft === undefined) continue
        if (draft !== undefined && files.every(f => marks.get(f.path)?.size === f.size)) continue

        // A file that shrank, or a chat not yet counted in this session, is counted from the top.
        if (draft === undefined || files.some(f => (marks.get(f.path)?.size ?? 0) > f.size)) {
          draft = { t: '', p: '', d: {}, seen: new Set() }
          for (const file of files) marks.delete(file.path)
        }
        for (const file of files) {
          const mark = marks.get(file.path) ?? { size: 0, offset: 0 }
          if (mark.size === file.size) continue
          const text = mark.offset === 0 ? await readWhole($, file.path, file.size) : await readFrom($, file.path, mark.offset)
          // Only whole lines: a line still being written is read next time.
          const whole = text.slice(0, text.lastIndexOf('\n') + 1)
          parseTranscript(whole, draft, home)
          marks.set(file.path, { size: file.size, offset: mark.offset + utf8Length(whole) })
        }
        drafts.set(id, draft)
        seen[id] = signature
        changed++
        if (Object.keys(draft.d).length === 0) continue

        const old = ledger[id]
        ledger[id] = {
          t: draft.t || old?.t || draft.firstPrompt || 'Untitled chat',
          p: draft.p || old?.p || lastSegment(project.name.replace(/-/g, '/')),
          // Days the transcript still has are recounted; older days stay as logged.
          d: { ...old?.d, ...JSON.parse(JSON.stringify(draft.d)) },
        }
      }
    }

    const now = await $.clock.now()
    if (changed > 0) {
      await $.store.set('v2.chats', ledger)
      await $.store.set('v2.seen', seen)
      await update($, revAtom, n => n + 1)
    }
    await update($, scannedAtom, () => now)
    await update($, statusAtom, () => '')
  } catch (error) {
    await update($, statusAtom, () => `Couldn't read your chats: ${(error as Error).message}`)
  } finally {
    isScanning = false
  }
}

const open = async ($: EngineInterface) => {
  isPaneOpen = true
  // Asks for the keyboard, so the first click on the pane presses instead of only focusing it.
  await $.ui.open({ id: PANE, title: 'Usage', focus: true })
  await scan($)
}

const setView = ($: EngineInterface, change: Partial<View>) => update($, viewAtom, v => ({ ...v, ...change }))

// Euros per chat, project and model over the days `isIn` accepts.
const breakdown = (chats: Record<string, Chat>, isIn: (day: string) => boolean, eurRate: number) => {
  const byChat: (Line & { project: string; models: Record<string, number>; first: string; last: string })[] = []
  const byProject: Record<string, number> = {}
  const byModel: Record<string, number> = {}
  let total = 0

  for (const [id, chat] of Object.entries(chats)) {
    const models: Record<string, number> = {}
    const days = Object.keys(chat.d).filter(isIn).sort()
    let sum = 0
    for (const day of days) {
      for (const [model, usd] of Object.entries(chat.d[day])) {
        const eur = usd * eurRate
        models[model] = (models[model] ?? 0) + eur
        byModel[model] = (byModel[model] ?? 0) + eur
        sum += eur
      }
    }
    if (sum <= 0) continue
    total += sum
    byProject[chat.p] = (byProject[chat.p] ?? 0) + sum
    byChat.push({ id, name: chat.t, eur: sum, project: chat.p, models, first: days[0], last: days[days.length - 1] })
  }

  const desc = (a: Line, b: Line) => b.eur - a.eur
  const lines = (sums: Record<string, number>) => Object.entries(sums).map(([name, eur]) => ({ id: name, name, eur })).sort(desc)
  return { total, chats: byChat.sort(desc), projects: lines(byProject), models: lines(byModel) }
}

export const register: Register = (on, options) => {
  const parsed = Number(String(options.eur_rate ?? '').replace(',', '.'))
  const eurRate = Number.isFinite(parsed) && parsed > 0 ? parsed : 0.86

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: 'spend', description: 'Show what your chats cost per day, project and chat' })
    // Logs costs in the background every session, so history is kept even when the pane stays shut.
    void scan($)
    $.clock.every(REFRESH_MS, () => void (isPaneOpen ? scan($) : undefined))

    return started
  })

  on('command.run', { command: 'spend' }, async $ => {
    await open($)

    return { text: 'Usage pane opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Svg, Button } = $.ui.resolve(e)
    await read($, revAtom)
    const chats = ledger
    const view = await read($, viewAtom)
    const note = await read($, statusAtom)
    const scannedAt = await read($, scannedAtom)
    const now = await $.clock.now()

    if (chats === null) return <Text dimColor>{note || 'Adding up your chats…'}</Text>

    const today = dayOf(now)
    const thisMonth = today.slice(0, 7)
    const months = [...new Set([thisMonth, ...Object.values(chats).flatMap(c => Object.keys(c.d).map(day => day.slice(0, 7)))])].sort().reverse()
    const period = view.period || thisMonth
    const isCustom = period === 'custom'
    const lo = view.from || null
    const hi = view.to || view.from || null
    const hasRange = isCustom && lo !== null
    const isIn = (day: string) => (isCustom ? hasRange && day >= lo! && day <= hi! : day.startsWith(period))

    const todayEur = breakdown(chats, day => day === today, eurRate).total
    const shown = breakdown(chats, isIn, eurRate)
    const label = isCustom ? (hasRange ? (lo === hi ? shortDay(lo!) : `${shortDay(lo!)} – ${shortDay(hi!)}`) : 'Pick dates') : monthLabel(period, now)

    const width = Math.min(MAX_W, Math.max(120, Math.floor(e.props.bodyColumns * COL_PX * 0.9)))
    const bar = (share: number) => {
      const filled = Math.max(2, Math.round(share * width))
      return (
        `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${BAR_H + AIR * 2}" viewBox="0 0 ${width} ${BAR_H + AIR * 2}">` +
        `<rect y="${AIR}" width="${width}" height="${BAR_H}" rx="2" fill="#808080" fill-opacity="0.25"/>` +
        `<rect y="${AIR}" width="${filled}" height="${BAR_H}" rx="2" fill="#7F77DD"/></svg>`
      )
    }

    // Text has one size, so the big figures are drawn as images, colored for light or dark.
    const figure = (value: string, isRight = false) => {
      const px = BIG_PX
      const w = Math.ceil(value.length * px * 0.62)
      const tall = Math.round(px * 1.3)
      return (
        <Svg
          source={
            `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${tall}" viewBox="0 0 ${w} ${tall}">` +
            `<style>text{fill:#1f1e1d;font:500 ${px}px -apple-system,system-ui,sans-serif}@media (prefers-color-scheme:dark){text{fill:#f5f4ef}}</style>` +
            `<text x="${isRight ? w : 0}" y="${px}"${isRight ? ' text-anchor="end"' : ''}>${value}</text></svg>`
          }
          alt={value}
          width={w}
          height={tall}
        />
      )
    }

    const rangeValue = isCustom && !hasRange ? '–' : euro(shown.total)
    const hero = (name: string, value: string, isRight: boolean) => (
      <Box flexDirection="column" alignItems={isRight ? 'flex-end' : 'flex-start'}>
        <Text dimColor>{name}</Text>
        {figure(value, isRight)}
      </Box>
    )

    // The chart shows one week, Monday to Sunday: this week, or the period's last week when it lies in the past.
    const mondayOf = (day: string) => {
      const [y, m, d] = day.split('-').map(Number)
      return dayOf(new Date(y, m - 1, d - ((new Date(y, m - 1, d).getDay() + 6) % 7)).getTime())
    }
    const addDays = (day: string, n: number) => {
      const [y, m, d] = day.split('-').map(Number)
      return dayOf(new Date(y, m - 1, d + n).getTime())
    }
    const periodEnd = isCustom ? (hi ?? today) : `${period}-${pad(new Date(+period.slice(0, 4), +period.slice(5, 7), 0).getDate())}`
    const thisWeek = mondayOf(today)
    const week = view.week || mondayOf(periodEnd < today ? periodEnd : today)
    const days = Array.from({ length: 7 }, (_, i) => addDays(week, i))
    const perDay: Record<string, number> = {}
    for (const chat of Object.values(chats)) {
      for (const day of days) for (const usd of Object.values(chat.d[day] ?? {})) perDay[day] = (perDay[day] ?? 0) + usd * eurRate
    }
    const peak = Math.max(0.01, ...days.map(day => perDay[day] ?? 0))
    const slot = width / days.length
    const weekEur = days.reduce((sum, day) => sum + (perDay[day] ?? 0), 0)
    const isCurve = view.chart === 'curve'
    const plotY = (eur: number) => TIP_H + PLOT_H - (eur / peak) * (PLOT_H - 4)
    const points = days.map((day, i) => ({ x: i * slot + slot / 2, y: plotY(perDay[day] ?? 0) }))
    // Smooth without overshoot: each segment bends through the horizontal midpoint.
    const curvePath = points
      .map((pt, i) => {
        if (i === 0) return `M${pt.x.toFixed(1)},${pt.y.toFixed(1)}`
        const prev = points[i - 1]
        const mid = ((prev.x + pt.x) / 2).toFixed(1)
        return `C${mid},${prev.y.toFixed(1)} ${mid},${pt.y.toFixed(1)} ${pt.x.toFixed(1)},${pt.y.toFixed(1)}`
      })
      .join('')
    const base = TIP_H + PLOT_H
    const area = points.length > 0 ? `${curvePath}L${points[points.length - 1].x.toFixed(1)},${base}L${points[0].x.toFixed(1)},${base}Z` : ''
    const weekday = (day: string) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8)).getDay()]
    // Drawn in a sandboxed frame so CSS hover works: each day shows its amount on hover.
    const chartH = TIP_H + PLOT_H + LABEL_H
    const daily =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${chartH}" viewBox="0 0 ${width} ${chartH}">` +
      `<style>` +
      `.tip,.dot{display:none}.d:hover .tip,.d:hover .dot{display:inline}.d:hover .hit{fill:#808080;fill-opacity:.12}.d:hover .b{opacity:.8}` +
      `.lab{fill:#6b6a65;font:12px -apple-system,system-ui,sans-serif}.tip rect{fill:#2b2a27}.tip text{fill:#f5f4ef;font:500 11px -apple-system,system-ui,sans-serif}` +
      `@media (prefers-color-scheme:dark){.lab{fill:#a6a49c}.tip rect{fill:#f5f4ef}.tip text{fill:#1f1e1d}}` +
      `</style>` +
      (isCurve ? `<path d="${area}" fill="${ACCENT}" fill-opacity="0.15"/><path d="${curvePath}" fill="none" stroke="${ACCENT}" stroke-width="2"/>` : '') +
      days
        .map((day, i) => {
          const eur = perDay[day] ?? 0
          const x0 = i * slot
          const barH = eur > 0 ? Math.max(2, Math.round((eur / peak) * (PLOT_H - 4))) : 1
          const look = eur > 0 ? `fill="${ACCENT}"` : `fill="#808080" fill-opacity="${day > today ? 0.15 : 0.35}"`
          const text = `${weekday(day)} ${shortDay(day)} · ${euro(eur)}`
          const tipW = Math.ceil(text.length * 6.3 + 14)
          const tipX = Math.min(Math.max(0, x0 + slot / 2 - tipW / 2), width - tipW)
          return (
            `<g class="d"><rect class="hit" x="${x0.toFixed(1)}" y="0" width="${slot.toFixed(1)}" height="${chartH}" fill="transparent"/>` +
            (isCurve
              ? `<circle class="dot" cx="${points[i].x.toFixed(1)}" cy="${points[i].y.toFixed(1)}" r="3.5" fill="${ACCENT}"/>`
              : `<rect class="b" x="${(x0 + slot * 0.18).toFixed(1)}" y="${base - barH}" width="${(slot * 0.64).toFixed(1)}" height="${barH}" rx="4" ${look}/>`) +
            `<text class="lab" x="${(x0 + slot / 2).toFixed(1)}" y="${base + LABEL_H - 3}" text-anchor="middle">${weekday(day).slice(0, 2)} ${Number(day.slice(8))}</text>` +
            `<g class="tip"><rect x="${tipX.toFixed(1)}" y="0" width="${tipW}" height="${TIP_H - 4}" rx="4"/>` +
            `<text x="${(tipX + tipW / 2).toFixed(1)}" y="${TIP_H - 9}" text-anchor="middle">${text}</text></g></g>`
          )
        })
        .join('') +
      `</svg>`

    // Month tabs: the last few months with chats (and this one), oldest first, then Custom.
    const monthTabs = months.slice(0, MONTH_TABS).reverse()
    const tabName = (m: string) => {
      const [y, mo] = m.split('-').map(Number)
      return new Date(now).getFullYear() === y ? MONTHS[mo - 1].slice(0, 3) : `${MONTHS[mo - 1].slice(0, 3)} ${String(y).slice(2)}`
    }
    const pick = (value: string, name: string) => (
      <Button
        key={`period-${value}`}
        label={name}
        variant={period === value ? 'primary' : 'secondary'}
        onPress={() => void setView($, { period: value, week: '', open: null, isAll: false, cal: value === 'custom' && !view.cal ? thisMonth : view.cal, edge: 'from' })}
      />
    )

    // The date picker: quick ranges, then a month calendar where a first click starts the range and a second ends it.
    const calMonth = view.cal || thisMonth
    const shiftDay = (n: number) => dayOf(new Date(new Date(now).getFullYear(), new Date(now).getMonth(), new Date(now).getDate() + n).getTime())
    const shiftMonth = (month: string, n: number) => dayOf(new Date(+month.slice(0, 4), +month.slice(5, 7) - 1 + n, 1).getTime()).slice(0, 7)
    const monthEnd = (month: string) => `${month}-${pad(new Date(+month.slice(0, 4), +month.slice(5, 7), 0).getDate())}`
    const lastMonth = shiftMonth(thisMonth, -1)
    const presets: [string, string, string][] = [
      ['Today', today, today],
      ['Yesterday', shiftDay(-1), shiftDay(-1)],
      ['Last 7 days', shiftDay(-6), today],
      ['Last 30 days', shiftDay(-29), today],
      ['This month', `${thisMonth}-01`, today],
      ['Last month', `${lastMonth}-01`, monthEnd(lastMonth)],
    ]
    // A day click fills whichever end is active (Start first), then moves on to End, as in Google and Meta Ads.
    const pickDay = (day: string) =>
      void update($, viewAtom, v => {
        if (v.edge === 'to' && v.from) return day < v.from ? { ...v, from: day, to: v.from, edge: 'from' } : { ...v, to: day, edge: 'from' }
        return { ...v, from: day, to: v.to && v.to >= day ? v.to : '', edge: 'to' }
      })
    const [cy, cm] = calMonth.split('-').map(Number)
    const lead = (new Date(cy, cm - 1, 1).getDay() + 6) % 7
    const cells = [...Array(lead).fill(''), ...Array.from({ length: new Date(cy, cm, 0).getDate() }, (_, i) => `${calMonth}-${pad(i + 1)}`)]
    const weeks = Array.from({ length: Math.ceil(cells.length / 7) }, (_, i) => cells.slice(i * 7, i * 7 + 7))
    const cell = (child: unknown) => (
      <Box width="14%" justifyContent="center">
        {child}
      </Box>
    )
    const dayCell = (day: string) => {
      if (!day) return cell(null)
      const isPicked = lo !== null && day >= lo && day <= (hi ?? lo)
      return cell(
        <Button key={`day-${day}`} label={String(Number(day.slice(8)))} variant={isPicked ? 'primary' : 'secondary'} dimColor={day > today} onPress={() => pickDay(day)} />,
      )
    }
    const edge = (which: 'from' | 'to', name: string, value: string) => (
      <Box flexDirection="column" width="48%">
        <Text dimColor>{name}</Text>
        <Button
          key={`edge-${which}`}
          label={value ? shortDay(value) : 'Pick a day'}
          variant={view.edge === which ? 'primary' : 'secondary'}
          onPress={() => void setView($, { edge: which })}
        />
      </Box>
    )
    const picker = (
      <Box flexDirection="column" marginTop={2} borderStyle="round" borderColor="subtle" paddingX={2} paddingY={1}>
        <Box flexDirection="row" flexWrap="wrap" columnGap={1} rowGap={1}>
          {presets.map(([name, a, b]) => (
            <Button
              key={`preset-${name}`}
              label={name}
              variant={lo === a && hi === b ? 'primary' : 'secondary'}
              onPress={() => void setView($, { from: a, to: b, week: '', cal: a.slice(0, 7), edge: 'from' })}
            />
          ))}
        </Box>

        <Box flexDirection="row" justifyContent="space-between" alignItems="flex-end" marginTop={2}>
          {edge('from', 'Start', view.from)}
          {edge('to', 'End', view.to)}
        </Box>

        <Box flexDirection="row" justifyContent="space-between" alignItems="center" marginTop={2}>
          <Button key="cal-prev" label="‹" onPress={() => void setView($, { cal: shiftMonth(calMonth, -1) })} />
          <Text bold>
            {MONTHS[cm - 1]} {cy}
          </Text>
          <Button key="cal-next" label="›" onPress={() => void setView($, { cal: shiftMonth(calMonth, 1) })} />
        </Box>
        <Box flexDirection="row" marginTop={1}>
          {['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'].map(name => cell(<Text dimColor>{name}</Text>))}
        </Box>
        <Box flexDirection="column" rowGap={1} marginTop={1}>
          {weeks.map(week => (
            <Box flexDirection="row">{[...week, ...Array(7 - week.length).fill('')].map(dayCell)}</Box>
          ))}
        </Box>

        <Box flexDirection="row" justifyContent="space-between" alignItems="center" marginTop={2}>
          <Text dimColor>{lo === null ? 'Pick a start day' : view.to ? label : 'Now pick an end day'}</Text>
          {lo !== null ? <Button key="clear" label="Clear" plain dimColor onPress={() => void setView($, { from: '', to: '', edge: 'from' })} /> : null}
        </Box>
      </Box>
    )

    const tabs: [Tab, string][] = [['chats', 'Chats'], ['projects', 'Projects'], ['models', 'Models']]
    const all: Line[] = shown[view.tab]
    const rows = view.isAll ? all : all.slice(0, TOP)
    const rest = all.slice(rows.length)
    const max = rows[0]?.eur ?? 1

    const detail = (id: string) => {
      const chat = shown.chats.find(c => c.id === id)
      if (!chat) return null
      const when = chat.first === chat.last ? shortDay(chat.first) : `${shortDay(chat.first)} – ${shortDay(chat.last)}`
      const item = (name: string, value: string) => (
        <Box flexDirection="row" justifyContent="space-between">
          <Text dimColor>{name}</Text>
          <Text dimColor>{value}</Text>
        </Box>
      )
      return (
        <Box flexDirection="column" paddingLeft={2} marginBottom={1}>
          {item('Project', chat.project)}
          {Object.entries(chat.models)
            .sort((a, b) => b[1] - a[1])
            .map(([model, eur]) => item(model, euro(eur)))}
          {item('When', when)}
        </Box>
      )
    }

    const row = (line: Line) => {
      const isChat = view.tab === 'chats'
      const isOpen = isChat && view.open === line.id
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Box flexDirection="row" justifyContent="space-between">
            {isChat ? (
              <Button key={`row-${line.id}`} plain onPress={() => void setView($, { open: isOpen ? null : line.id })}>
                <Text wrap="truncate-end">{line.name}</Text>
              </Button>
            ) : (
              <Text wrap="truncate-end">{line.name}</Text>
            )}
            <Text dimColor>{euro(line.eur)}</Text>
          </Box>
          <Svg source={bar(line.eur / max)} alt={`${Math.round((line.eur / max) * 100)}% of the top row`} width={width} height={BAR_H + AIR * 2} />
          {isOpen ? detail(line.id) : null}
        </Box>
      )
    }

    const minutes = Math.round((now - scannedAt) / 60_000)
    const rule = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${RULE_H}" viewBox="0 0 ${width} ${RULE_H}"><rect y="${RULE_H / 2}" width="${width}" height="1" fill="#808080" fill-opacity="0.5"/></svg>`

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" columnGap={1} rowGap={1} flexWrap="wrap">
          {monthTabs.map(m => pick(m, tabName(m)))}
          {pick('custom', 'Custom')}
        </Box>
        {isCustom ? picker : null}

        <Box flexDirection="row" justifyContent="space-between" marginTop={2}>
          {/* A custom range is what you came for, so it takes the left; a month keeps Today there. */}
          {isCustom ? hero(label, rangeValue, false) : hero('Today', euro(todayEur), false)}
          {isCustom ? hero('Today', euro(todayEur), true) : hero(label, rangeValue, true)}
        </Box>
        {days.length > 0 ? (
          <Box flexDirection="column" marginTop={2}>
            <Box flexDirection="row" justifyContent="space-between" alignItems="center" marginBottom={1}>
              <Box flexDirection="row" alignItems="center" columnGap={1}>
                <Button key="week-prev" label="‹" onPress={() => void setView($, { week: addDays(week, -7) })} />
                <Text>
                  {shortDay(days[0])} – {shortDay(days[6])} <Text dimColor>· {euro(weekEur)}</Text>
                </Text>
                {week < thisWeek ? <Button key="week-next" label="›" onPress={() => void setView($, { week: addDays(week, 7) })} /> : null}
              </Box>
              <Box flexDirection="row" columnGap={1}>
              <Button key="chart-bars" label="Bars" variant={isCurve ? 'secondary' : 'primary'} onPress={() => void setView($, { chart: 'bars' })} />
              <Button key="chart-curve" label="Curve" variant={isCurve ? 'primary' : 'secondary'} onPress={() => void setView($, { chart: 'curve' })} />
              </Box>
            </Box>
            <Svg
              source={daily}
              alt={`Cost per day as ${isCurve ? 'a curve' : 'bars'}, ${shortDay(days[0])} to ${shortDay(days[days.length - 1])}`}
              width={width}
              height={chartH}
              isInteractive
            />
          </Box>
        ) : null}

        <Box flexDirection="row" gap={3} marginTop={3} marginBottom={2}>
          {tabs.map(([tab, name]) =>
            view.tab === tab ? (
              <Text bold color={ACCENT}>{name}</Text>
            ) : (
              <Button key={`tab-${tab}`} plain dimColor onPress={() => void setView($, { tab, open: null, isAll: false })}>
                {name}
              </Button>
            ),
          )}
        </Box>

        {rows.length === 0 ? <Text dimColor>{isCustom && !hasRange ? 'Pick dates to see that period.' : 'No chats in this period.'}</Text> : rows.map(row)}
        {rest.length > 0 ? (
          <Box flexDirection="row" justifyContent="space-between">
            <Button key="more" plain dimColor onPress={() => void setView($, { isAll: true })}>
              {`${rest.length} more`}
            </Button>
            <Text dimColor>{euro(rest.reduce((sum, line) => sum + line.eur, 0))}</Text>
          </Box>
        ) : view.isAll && all.length > TOP ? (
          <Button key="less" plain dimColor onPress={() => void setView($, { isAll: false })}>
            Show fewer
          </Button>
        ) : null}

        {all.length > 0 ? (
          <Box flexDirection="column" marginTop={1} rowGap={1}>
            <Svg source={rule} alt="Total line" width={width} height={RULE_H} />
            <Box flexDirection="row" justifyContent="space-between">
              <Text bold>
                Total · {all.length} {TAB_NOUN[view.tab]}{all.length === 1 ? '' : 's'}
              </Text>
              <Text bold>{euro(shown.total)}</Text>
            </Box>
          </Box>
        ) : null}

        {note ? <Text color="error">{note}</Text> : null}
        <Box marginTop={2}>
          <Text dimColor>At API prices · updated {minutes < 1 ? 'just now' : `${minutes}m ago`}</Text>
        </Box>
      </Box>
    )
  })
}
