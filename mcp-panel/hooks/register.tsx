import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Board, Health, Server } from '../types'

const PANE = 'mcp-panel'
const EMPTY: Board = { servers: [], checkedAt: 0, isChecking: false, busy: '', note: '' }
const boardAtom = atom({ plugin: 'mcp-panel', key: 'board' } as const, EMPTY)

// A picture per server, picked from words in its name; a plug otherwise.
const ICONS: [RegExp, string][] = [
  [/unreal|unity|game/i, '🎮'],
  [/blender|3d/i, '🧊'],
  [/photo|image/i, '🖼️'],
  [/film|video|movie/i, '🎬'],
  [/effect|motion/i, '✨'],
  [/light/i, '💡'],
  [/pdf|doc/i, '📄'],
  [/vector|design|figma/i, '✏️'],
  [/mail|gmail/i, '✉️'],
  [/notion|drive|slack|asana/i, '🗂️'],
  [/rea|reverse|search/i, '🔍'],
  [/laya|decide|route/i, '🧭'],
]
export const iconFor = (name: string) => ICONS.find(([re]) => re.test(name))?.[1] ?? '🔌'

// How tool names spell a server: anything but letters, digits, _ and - becomes _.
const toolKey = (name: string) => name.replace(/[^A-Za-z0-9_-]/g, '_')

// One line of `claude mcp list`: "name: command - ✔ Connected".
export const parseList = (stdout: string): { name: string; group: string; order: number; health: Health; detail: string }[] =>
  stdout.split('\n').flatMap((line, order) => {
    const colon = line.indexOf(': ')
    const dash = line.lastIndexOf(' - ')
    if (colon <= 0 || dash <= colon) return []
    const name = line.slice(0, colon).trim()
    const status = line.slice(dash + 3).trim()
    const health: Health = /\bConnected\b/.test(status) ? 'ok' : /auth/i.test(status) ? 'auth' : /fail/i.test(status) ? 'down' : 'unknown'
    const command = line.slice(colon + 2, dash)
    return [{ name, group: groupFor(name, command), order, health, detail: health === 'ok' ? '' : reasonFor(status) }]
  })

// Which group a card sits in: the project folder that ships the server
// ("02 Projects/15 ArtCraft MCP Setup" -> "ArtCraft"), else a kind by name.
export const groupFor = (name: string, command: string) => {
  const project = /02 Projects\/\d+\s+([^/]+)\//.exec(command)?.[1]
  if (project) return project.replace(/\s+MCP Setup$/i, '').replace(/\s+MCP$/i, '').trim()
  if (/blender|unreal|unity|3d/i.test(name)) return '3D'
  if (/^claude\.ai /i.test(name) || /^https?:/.test(command.trim())) return 'Online'
  return 'Other'
}

// The error in a few plain words: what a card has room for.
export const reasonFor = (status: string) => {
  if (/ECONNREFUSED/i.test(status)) return 'Not running'
  if (/CONNECTION_CLOSED|connection closed/i.test(status)) return 'Closed on start'
  if (/timed? ?out|ETIMEDOUT/i.test(status)) return 'Timed out'
  if (/ENOENT|not found/i.test(status)) return 'App not found'
  if (/auth/i.test(status)) return 'Needs sign-in'
  return 'Down'
}

let cwd = ''

const set = ($: EngineInterface, change: Partial<Board>) => update($, boardAtom, b => ({ ...b, ...change }))

// Servers turned off for this folder, as `/mcp disable` records them in ~/.claude.json.
const offList = async ($: EngineInterface): Promise<string[]> => {
  try {
    const home = await $.env.get('HOME')
    const config = JSON.parse(await $.fs.read(`${home}/.claude.json`)) as { projects?: Record<string, { disabledMcpServers?: string[] }> }
    return config.projects?.[cwd]?.disabledMcpServers ?? []
  } catch {
    return []
  }
}

const check = async ($: EngineInterface) => {
  if ((await read($, boardAtom)).isChecking) return
  await set($, { isChecking: true, note: '' })
  try {
    const cli = (await $.env.get('CLAUDE_CODE_EXECPATH')) ?? 'claude'
    const [listed, tools, off] = await Promise.all([
      $.process.run([cli, 'mcp', 'list'], { timeoutMs: 90_000 }),
      $.tool.list(),
      offList($),
    ])
    const counts: Record<string, number> = {}
    for (const t of tools) {
      if (!t.mcp) continue
      const server = t.name.split('__')[1] ?? ''
      counts[server] = (counts[server] ?? 0) + 1
    }
    const servers: Server[] = parseList(listed.stdout).map(s => ({
      ...s,
      tools: counts[toolKey(s.name)] ?? 0,
      isOff: off.includes(s.name),
    }))
    // Newest first: `mcp list` prints servers in the order they were added.
    servers.sort((a, b) => b.order - a.order)
    await set($, {
      servers,
      checkedAt: await $.clock.now(),
      note: servers.length === 0 ? (listed.stderr.trim() || 'No MCP servers found.') : '',
    })
  } catch (error) {
    await set($, { note: `Couldn't check your servers: ${(error as Error).message}` })
  } finally {
    await set($, { isChecking: false })
  }
}

// Runs the built-in /mcp command for one server, then checks again.
const act = async ($: EngineInterface, verb: 'reconnect' | 'enable' | 'disable', name: string) => {
  await set($, { busy: name, note: '' })
  try {
    await $.command.run({ command: 'mcp', args: `${verb} ${name}` })
    if (verb !== 'reconnect') {
      await update($, boardAtom, b => ({ ...b, servers: b.servers.map(s => (s.name === name ? { ...s, isOff: verb === 'disable' } : s)) }))
    }
  } catch (error) {
    await set($, { note: `Couldn't ${verb} ${name}: ${(error as Error).message}` })
  } finally {
    await set($, { busy: '' })
  }
  await check($)
}

const open = async ($: EngineInterface) => {
  await $.ui.open({ id: PANE, title: 'MCP servers', focus: true })
  void check($)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    cwd = e.cwd
    const started = await next(e)
    await $.command.register({ name: 'mcp-panel', description: 'Show your MCP servers as cards, with retry and on/off' })

    return started
  })

  on('command.run', { command: 'mcp-panel' }, async $ => {
    await open($)

    return { text: 'MCP servers pane opened.' }
  })

  // An "MCP" button in the prompt footer, beside the model picker; the footer's own mode labels stay after it.
  // Draws its button, then whatever else draws in this footer slot (usage-band's meters, the mode labels).
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const rest = await next(e)
    const { Box, Button } = $.ui.resolve(e)
    const board = await read($, boardAtom)
    const down = board.servers.filter(s => s.health !== 'ok' && !s.isOff).length

    return (
      <Box flexDirection="row" gap={1} alignItems="center">
        <Button key="footer-mcp" label={down ? `MCP · ${down} down` : 'MCP'} plain onPress={() => void open($)} />
        {rest}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const board = await read($, boardAtom)
    const now = await $.clock.now()
    const cols = (e.props.bodyColumns ?? 40) >= 60 ? 3 : 2
    const width = cols === 3 ? '31%' : '47%'

    const live = board.servers.filter(s => s.health === 'ok' && !s.isOff).length
    const down = board.servers.filter(s => s.health !== 'ok' && !s.isOff).length
    const ago = board.checkedAt ? Math.max(0, Math.round((now - board.checkedAt) / 60_000)) : -1

    const card = (s: Server) => {
      const isBad = !s.isOff && s.health !== 'ok'
      const isBusy = board.busy === s.name
      const status = s.isOff ? 'Off in this folder' : s.health === 'ok' ? `${s.tools} tools` : s.health === 'auth' ? 'Needs sign-in' : s.detail || 'Down'

      return (
        <Box key={`card-${s.name}`} flexDirection="column" width={width} borderStyle="round" borderColor={isBad ? 'error' : undefined} borderDimColor={!isBad} paddingX={1}>
          <Box flexDirection="row" gap={1}>
            <Text>{iconFor(s.name)}</Text>
            <Text bold dimColor={s.isOff} wrap="truncate-end">{s.name}</Text>
            <Box flexGrow={1} />
            <Text color={s.isOff ? 'inactive' : s.health === 'ok' ? 'success' : 'error'}>●</Text>
          </Box>
          <Text color={isBad ? 'error' : undefined} dimColor={!isBad} wrap="truncate-end">{isBusy ? 'Working…' : status}</Text>
          <Box flexDirection="row" alignItems="center" justifyContent="space-between" marginTop={1}>
            {isBad ? <Button key={`retry-${s.name}`} label="Retry" variant="primary" onPress={() => void act($, 'reconnect', s.name)} /> : <Box />}
            <Button
              key={`toggle-${s.name}`}
              label={s.isOff ? 'Turn on' : 'Turn off'}
              plain
              dimColor={!s.isOff}
              onPress={() => void act($, s.isOff ? 'enable' : 'disable', s.name)}
            />
          </Box>
        </Box>
      )
    }

    // Groups in the order of their newest server; cards inside stay newest first.
    const groups: { name: string; servers: Server[] }[] = []
    for (const s of board.servers) {
      const found = groups.find(g => g.name === s.group)
      if (found) found.servers.push(s)
      else groups.push({ name: s.group, servers: [s] })
    }

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" gap={1} alignItems="center">
          <Text color="success">{live} live</Text>
          <Text color={down ? 'error' : 'inactive'}>{down} down</Text>
          <Box flexGrow={1} />
          <Text dimColor>{board.isChecking ? 'Checking…' : ago < 0 ? '' : ago === 0 ? 'just now' : `${ago}m ago`}</Text>
          <Button key="refresh" label="Refresh" onPress={() => void check($)} />
        </Box>
        {board.note ? <Text color="warning">{board.note}</Text> : null}
        {board.servers.length === 0 && board.isChecking ? <Text dimColor>Checking your servers… this takes a few seconds.</Text> : null}
        {groups.map(g => (
          <Box key={`group-${g.name}`} flexDirection="column" gap={1}>
            <Box flexDirection="row" gap={1}>
              <Text bold>{g.name}</Text>
              <Text dimColor>
                {g.servers.filter(s => s.health === 'ok' && !s.isOff).length}/{g.servers.length} live
              </Text>
            </Box>
            <Box flexDirection="row" flexWrap="wrap" columnGap={1} rowGap={1}>
              {g.servers.map(card)}
            </Box>
          </Box>
        ))}
      </Box>
    )
  })
}
