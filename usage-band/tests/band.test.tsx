import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const FOOTER = { modes: [] as string[] }
const PROPS = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 140, scroll: { offset: 0, bodyRows: 10 }, view: {} }
const NOW = Date.parse('2026-10-11T10:00:00Z')

const usage = (fiveHour: number, weekly: number, ctx = 7) => ({
  startedAt: NOW - 60_000,
  context: { tokens: ctx * 10_000, window: 1_000_000, percent: ctx },
  rateLimits: [
    { kind: 'five_hour', percentUsed: fiveHour, resetsAt: '2026-10-11T14:12:00Z' },
    { kind: 'seven_day', percentUsed: weekly, resetsAt: '2026-10-16T19:00:00Z' },
  ],
  cost: { usd: 1 },
})

// Stands in for the engine: a desktop session with this usage, two prompts in.
const session = (on: On, fiveHour: number, weekly: number, ctx = 7) => {
  on('session.surfaces', () => ({ value: ['desktop' as const] }))
  on('session.usage', () => ({ value: usage(fiveHour, weekly, ctx) }))
  on('session.turns', () => ({ value: 2 }))
  on('clock.now', () => ({ value: NOW }))
  on('session.measure', (_$, e) => e)
  // Stands in for the engine's own drawing (and any mod beneath), which the band keeps beside its own.
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
}

const measure = (fiveHour: number, weekly: number, ctx = 7) => {
  const u = usage(fiveHour, weekly, ctx)
  return { context: u.context, rateLimits: u.rateLimits, cost: u.cost, changed: ['rateLimits' as const] }
}

test('the footer under the prompt shows the 5-hour and weekly limits, reset times and the Usage link', async ($, on) => {
  session(on, 2, 28)
  await $.session.measure(measure(2, 28))
  const ui = await $.ui.mount({ plugin: 'usage-band', surface: 'desktop', component: 'SessionMode', props: FOOTER })

  expect(await ui.find({ type: 'Text', text: '5h' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '2%' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Week' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '28%' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '↻ 4h 12m' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '↻ 5d 9h' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Context' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '€1.00' })).toBeUndefined()
  // The MCP button and mode labels drawn beneath still show.
  expect(await ui.find({ type: 'Text', text: 'engine' })).toBeDefined()
})

test('nothing above the prompt until the chat is nearly full', async ($, on) => {
  session(on, 2, 28, 60)
  await $.session.measure(measure(2, 28, 60))
  const ui = await $.ui.mount({ plugin: 'usage-band', surface: 'desktop', component: 'AbovePrompt', props: PROPS })
  expect(await ui.find({ type: 'Text', text: '5h' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'engine' })).toBeDefined()
})

test('the Usage link opens the usage pane', async ($, on) => {
  session(on, 2, 28)
  const ran: string[] = []
  on('command.run', (_$, e) => {
    ran.push(e.command)
    return { text: '' }
  })
  await $.session.measure(measure(2, 28))
  const ui = await $.ui.mount({ plugin: 'usage-band', surface: 'desktop', component: 'SessionMode', props: FOOTER })

  await ui.press({ key: 'open-usage' })
  expect(ran).toEqual(['spend'])
})

test('colours a limit amber past 80% and red past 95%', async ($, on) => {
  session(on, 86, 97)
  await $.session.measure(measure(86, 97))
  const ui = await $.ui.mount({ plugin: 'usage-band', surface: 'desktop', component: 'SessionMode', props: FOOTER })

  expect((await ui.find({ type: 'Text', text: '86%' }))?.props).toMatchObject({ color: 'warning' })
  expect((await ui.find({ type: 'Text', text: '97%' }))?.props).toMatchObject({ color: 'error' })
})

test('handoff row: Hand off submits the handoff prompt, then hides', async ($, on) => {
  session(on, 2, 28, 87)
  const sent: string[] = []
  on('prompt.submit', (_$, e) => {
    sent.push(e.text)
    return { text: e.text } as never
  })
  await $.session.measure(measure(2, 28, 87))
  const ui = await $.ui.mount({ plugin: 'usage-band', surface: 'desktop', component: 'AbovePrompt', props: PROPS })

  expect(await ui.find({ key: 'handoff' })).toBeDefined()
  await ui.press({ key: 'handoff' })
  expect(sent[0]).toContain('context-handoff')
  expect(await ui.find({ key: 'handoff' })).toBeUndefined()
})

test('handoff row stays hidden below 85%', async ($, on) => {
  session(on, 2, 28, 60)
  await $.session.measure(measure(2, 28, 60))
  const ui = await $.ui.mount({ plugin: 'usage-band', surface: 'desktop', component: 'AbovePrompt', props: PROPS })
  expect(await ui.find({ key: 'handoff' })).toBeUndefined()
})
