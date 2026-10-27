import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { iconFor, parseList } from '../hooks/register'

const LIST = [
  'Checking MCP server health…',
  '',
  'blender: uv run blender-mcp - ✔ Connected',
  'pdfcraft: /Users/s/Documents/02 Projects/15 ArtCraft MCP Setup/bin/pdfcraft-cli mcp - ✔ Connected',
  'unreal: http://127.0.0.1:8000/mcp (HTTP) - ✘ Failed to connect — ECONNREFUSED: Unable to connect.',
].join('\n')

// Stands in for the engine: three servers, pdfcraft turned off for this folder.
const machine = (on: On, opened: string[] = []) => {
  const ran: string[] = []
  on('session.start', (_$, e) => e as any)
  on('env.get', (_$, e) => ({ value: e.name === 'HOME' ? '/h' : '/bin/claude' }))
  on('clock.now', () => ({ value: 1_000 }))
  on('command.register', () => ({ value: undefined }))
  on('ui.open', (_$, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true as const } }
  })
  on('process.run', () => ({ value: { exitCode: 0, stdout: LIST, stderr: '' } }))
  on('tool.list', () => ({ value: [{ name: 'mcp__blender__render', description: '', mcp: true }, { name: 'mcp__blender__scene', description: '', mcp: true }, { name: 'Read', description: '', mcp: false }] }))
  on('fs.read', () => ({ value: JSON.stringify({ projects: { '/w': { disabledMcpServers: ['pdfcraft'] } } }) }))
  on('command.run', { command: 'mcp' }, (_$, e) => {
    ran.push(e.args)
    return { text: 'ok' }
  })
  return ran
}

const pane = ($: any) => $.ui.mount({ plugin: 'mcp-panel', surface: 'desktop', component: 'Pane', requestId: 'mcp-panel', props: { title: 'MCP servers', isFocused: false, bodyColumns: 70, placement: 'dock' as const } })

test('reads each line of mcp list', () => {
  const rows = parseList(LIST)
  expect(rows.map(r => r.name)).toEqual(['blender', 'pdfcraft', 'unreal'])
  expect(rows[2].health).toBe('down')
  expect(rows[2].detail).toBe('Not running')
  expect(rows[2].group).toBe('3D')
  expect(rows[1].group).toBe('ArtCraft')
  expect(iconFor('blender')).toBe('🧊')
})

test('shows cards, retries a broken server and turns one on', async ($, on) => {
  const ran = machine(on)
  await $.session.start({ cwd: '/w' } as any)
  await $.command.run({ command: 'mcp-panel', args: '' })
  const ui = await pane($)

  expect(await ui.find({ type: 'Text', text: '2 tools' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '1 down' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Off in this folder' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'ArtCraft' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Not running' })).toBeDefined()

  await ui.press({ key: 'retry-unreal' })
  await ui.press({ key: 'toggle-pdfcraft' })
  await ui.press({ key: 'refresh' })
  expect(ran).toEqual(['reconnect unreal', 'enable pdfcraft'])
})

test('the footer MCP button opens the pane', async ($, on) => {
  const opened: string[] = []
  machine(on, opened)
  // Stands in for the engine's own footer drawing, which the button is drawn beside.
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  const footer = await $.ui.mount({ plugin: 'mcp-panel', surface: 'desktop', component: 'SessionMode', props: { modes: [] } } as any)
  expect(await footer.find({ type: 'Text', text: 'engine' })).toBeDefined()
  await footer.press({ key: 'footer-mcp' })
  expect(opened).toEqual(['mcp-panel'])
})
