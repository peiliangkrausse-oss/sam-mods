import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const NOW = new Date(2026, 9, 11, 12, 0).getTime()
const ROOT = '/h/.claude/projects'
const DIR = `${ROOT}/-h-work`

const reply = (id: string, ts: string, model: string, usage: object) =>
  JSON.stringify({ type: 'assistant', timestamp: ts, cwd: '/h/work', message: { id, model, usage } })

// Opus 5.5: 1M output tokens = $20; a repeated record of the same reply is counted once.
// Sonnet 5.5: 1M 1-hour cache writes = 2 x $2 = $4. Fast mode doubles.
const TRANSCRIPT = [
  JSON.stringify({ type: 'user', message: { content: 'Fix the budget tab' } }),
  reply('m1', '2026-10-11T09:00:00', 'claude-opus-5-5', { output_tokens: 1_000_000 }),
  reply('m1', '2026-10-11T09:00:00', 'claude-opus-5-5', { output_tokens: 1_000_000 }),
  reply('m2', '2026-10-10T09:00:00', 'claude-sonnet-5-5', { cache_creation: { ephemeral_1h_input_tokens: 1_000_000 } }),
  reply('m3', '2026-09-20T09:00:00', 'claude-opus-5-5', { input_tokens: 1_000_000, speed: 'fast' }),
  JSON.stringify({ type: 'custom-title', customTitle: 'Budget tab' }),
].join('\n') + '\n'

const entry = (name: string, kind: 'file' | 'dir', size = 100) => ({ name, kind, size, mtimeMs: 1, isLink: false })

// Stands in for the engine: one project with one chat, an empty store, a fixed clock.
const machine = (on: On) => {
  const store: Record<string, unknown> = {}
  on('env.get', () => ({ value: '/h' }))
  on('clock.now', () => ({ value: NOW }))
  on('clock.every', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('fs.exists', () => ({ value: true }))
  on('fs.list', (_$, e) => ({ value: e.path === ROOT ? [entry('-h-work', 'dir')] : e.path === DIR ? [entry('c1.jsonl', 'file')] : [] }))
  on('fs.read', () => ({ value: TRANSCRIPT }))
  on('store.get', (_$, e) => ({ value: store[e.key] }))
  on('store.set', (_$, e) => {
    store[e.key] = e.value
    return { value: undefined }
  })
  return store
}

const PROPS = { title: 'Usage', isFocused: false, bodyColumns: 30, placement: 'dock' as const }
const pane = ($: any) => $.ui.mount({ plugin: 'usage-analytics', surface: 'desktop', component: 'Pane', requestId: 'usage-analytics', props: PROPS })

test('prices each model, counts a reply once, and shows today and the month big', { options: { eur_rate: '0.5' } }, async ($, on) => {
  machine(on)
  await $.command.run({ command: 'spend', args: '' })
  const ui = await pane($)

  // Today $20 -> €10. October $20 + $4 -> €12.
  expect(await ui.find({ type: 'Svg', alt: '€10.00' })).toBeDefined()
  expect(await ui.find({ type: 'Svg', alt: '€12.00' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Budget tab' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Total · 1 chat' })).toBeDefined()

  await ui.press({ key: 'chart-curve' })
  expect(await ui.find({ type: 'Svg', alt: 'Cost per day as a curve, 5 Oct to 11 Oct' })).toBeDefined()
  await ui.press({ key: 'week-prev' })
  expect(await ui.find({ type: 'Svg', alt: 'Cost per day as a curve, 28 Sep to 4 Oct' })).toBeDefined()
})

test('picks another month, a custom range, the models view, and opens a chat', { options: { eur_rate: '0.5' } }, async ($, on) => {
  machine(on)
  await $.command.run({ command: 'spend', args: '' })
  const ui = await pane($)

  // September: $4 doubled by fast mode -> €4.
  await ui.press({ key: 'period-2026-09' })
  expect(await ui.find({ type: 'Svg', alt: '€4.00' })).toBeDefined()

  // 10 Oct to 10 Oct (start, then end): the Sonnet cache write, $4 -> €2.
  await ui.press({ key: 'period-custom' })
  await ui.press({ key: 'day-2026-10-10' })
  await ui.press({ key: 'day-2026-10-10' })
  expect(await ui.find({ type: 'Svg', alt: '€2.00' })).toBeDefined()

  // 20 Sep to 11 Oct, picked across two months: everything, $4 x 2 + $4 + $20 -> €16.
  await ui.press({ key: 'cal-prev' })
  await ui.press({ key: 'edge-from' })
  await ui.press({ key: 'day-2026-09-20' })
  await ui.press({ key: 'cal-next' })
  await ui.press({ key: 'day-2026-10-11' })
  expect(await ui.find({ type: 'Svg', alt: '€16.00' })).toBeDefined()

  // Last 7 days: the Opus reply today and the Sonnet write yesterday, $24 -> €12.
  await ui.press({ key: 'preset-Last 7 days' })
  expect(await ui.find({ type: 'Svg', alt: '€12.00' })).toBeDefined()

  await ui.press({ key: 'tab-models' })
  expect(await ui.find({ type: 'Text', text: 'Sonnet 5.5' })).toBeDefined()

  await ui.press({ key: 'tab-chats' })
  await ui.press({ key: 'row-c1' })
  expect(await ui.find({ type: 'Text', text: 'Project' })).toBeDefined()
})

test('keeps logged days after Claude deletes the transcript', async ($, on) => {
  const store = machine(on)
  store['v2.chats'] = { old: { t: 'Old chat', p: 'work', d: { '2026-10-01': { 'Opus 5.5': 1 } } } }
  store['v2.seen'] = { old: 'gone' }
  await $.command.run({ command: 'spend', args: '' })

  const chats = store['v2.chats'] as Record<string, { t: string }>
  expect(chats.old.t).toBe('Old chat')
  expect(chats.c1.t).toBe('Budget tab')
})
