// Xarı's terminal UI in Ink. Finished entries go through <Static> (printed once, into the terminal's
// own scrollback); the live part below them is redrawn. Markdown, code, diffs and the option lists
// are Gemini CLI's components (vendor/gemini); the layout, input and wiring are Xarı's.
import path from 'node:path'
import React, { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { Box, Static, Text, useApp, useInput, useStdout } from 'ink'
import type { PermissionMode, TodoItem, ToolResult } from '@harness/core'
import { LineEditor } from '../tui/editor.js'
import { MarkdownDisplay } from './vendor/gemini/MarkdownDisplay.js'
import { DiffRenderer } from './vendor/gemini/DiffRenderer.js'
import { RadioButtonSelect } from './vendor/gemini/RadioButtonSelect.js'
import { colors, theme } from './vendor/gemini/_shim.js'
import { type ChatState, type ChatStore, type Item, modeLabel, saveHistory } from './store.js'
import { hasMessage, tEn, type T } from '../i18n/index.js'
import { TContext, useT } from './t.js'

const MARK = '✿'
const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

/** A tool's name in the transcript and approvals ("Read", "Run"…); MCP tools show `server · tool`. */
export function toolLabel(name: string, t: T = tEn): string {
  const key = `tool.${name}`
  if (hasMessage(key)) return t(key)
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name)
  return mcp ? `${mcp[1]} · ${mcp[2]}` : name
}

const MODE_COLORS: Record<PermissionMode, string> = { ask: colors.Gray, acceptEdits: colors.AccentGreen, plan: colors.AccentBlue, auto: colors.AccentRed }

function useStore(store: ChatStore): ChatState {
  return useSyncExternalStore(
    (cb) => {
      store.on('change', cb)
      return () => void store.off('change', cb)
    },
    () => store.state,
  )
}

function useColumns(): number {
  const { stdout } = useStdout()
  const [cols, setCols] = useState(stdout.columns || 80)
  useEffect(() => {
    const on = () => setCols(stdout.columns || 80)
    stdout.on('resize', on)
    return () => void stdout.off('resize', on)
  }, [stdout])
  return Math.max(30, cols)
}

function useSpinner(active: boolean): string {
  const [i, setI] = useState(0)
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => setI((n) => n + 1), 90)
    return () => clearInterval(t)
  }, [active])
  return SPIN[i % SPIN.length]
}

const home = process.env.HOME ?? ''
const shortPath = (p: string) => (home && p.startsWith(home) ? `~${p.slice(home.length)}` : p)

// ---------------------------------------------------------------- transcript entries

function Banner({ item, cols }: { item: Extract<Item, { kind: 'banner' }>; cols: number }) {
  const t = useT()
  return (
    <Box borderStyle="round" borderColor={colors.AccentPurple} paddingX={1} flexDirection="column" width={Math.min(cols, 76)} marginBottom={1}>
      <Text>
        <Text color={colors.AccentPurple}>{MARK} </Text>
        <Text bold>Xarı</Text>
        <Text color={theme.text.secondary}> v{item.version}</Text>
        {item.resumed ? <Text color={theme.text.secondary}> · {t('banner.resumed', { title: item.resumed })}</Text> : null}
      </Text>
      <Text color={theme.text.secondary} wrap="truncate-middle">
        {shortPath(item.cwd)}
      </Text>
      <Text> </Text>
      <Text color={theme.text.secondary}>
        <Text color={theme.text.primary}>/help</Text> {t('banner.commands')} · <Text color={theme.text.primary}>shift+tab</Text> {t('banner.mode')} · <Text color={theme.text.primary}>esc</Text> {t('banner.stop')}
      </Text>
    </Box>
  )
}

function UserLine({ text, cols }: { text: string; cols: number }) {
  return (
    <Box marginBottom={1} width={cols}>
      <Text color={colors.AccentPurple}>› </Text>
      <Box flexGrow={1}>
        <Text bold>{text}</Text>
      </Box>
    </Box>
  )
}

function Reply({ text, first, cols, pending }: { text: string; first: boolean; cols: number; pending?: boolean }) {
  return (
    <Box marginBottom={pending ? 0 : 1}>
      <Box width={2} flexShrink={0}>
        <Text color={colors.AccentGreen}>{first ? MARK : ' '}</Text>
      </Box>
      <Box flexDirection="column" flexGrow={1}>
        <MarkdownDisplay text={text.replace(/\n+$/, '')} isPending={!!pending} terminalWidth={cols - 2} />
      </Box>
    </Box>
  )
}

function ToolResultView({ name, result, state, cwd, cols }: { name: string; result: ToolResult; state: 'ok' | 'error' | 'denied'; cwd: string; cols: number }) {
  const t = useT()
  const first = (s: string) => s.trim().split('\n')[0] ?? ''
  if (state === 'denied') return <ResultLine color={colors.AccentYellow} text={first(result.content) || t('result.notAllowed')} />
  if (state === 'error') return <ResultLine color={colors.AccentRed} text={first(result.content)} />
  if (result.display?.kind === 'diff') {
    const d = result.display
    const file = d.path.startsWith(`${cwd}/`) ? path.relative(cwd, d.path) : d.path
    return (
      <Box flexDirection="column">
        <Text>
          <Text color={theme.text.secondary}>{'  ↳ '}</Text>
          <Text color={colors.AccentGreen}>+{d.added}</Text> <Text color={colors.AccentRed}>-{d.removed}</Text> <Text color={theme.text.secondary}>{file}</Text>
        </Text>
        <Box paddingLeft={4}>
          <DiffRenderer diffContent={d.patch} filename={d.path} terminalWidth={cols - 4} availableTerminalHeight={24} />
        </Box>
      </Box>
    )
  }
  const lines = result.content.replace(/\s+$/, '').split('\n').filter((l, i, a) => l || i < a.length - 1)
  if (name === 'todo_write' || name === 'ask_user' || !result.content) return null
  if (name === 'bash' || name === 'bash_output') {
    const tail = lines.slice(-4)
    return (
      <Box flexDirection="column">
        {lines.length > 4 && <ResultLine text={t('result.linesAbove', { count: lines.length - 4 })} />}
        {tail.map((l, i) => (
          <Text key={i} color={theme.text.secondary} wrap="truncate">
            {i === 0 && lines.length <= 4 ? '  ↳ ' : '    '}
            {l}
          </Text>
        ))}
      </Box>
    )
  }
  return <ResultLine text={`${lines[0]}${lines.length > 1 ? `  ${t('result.lineCount', { count: lines.length })}` : ''}`} />
}

const ResultLine = ({ text, color }: { text: string; color?: string }) => (
  <Text color={color ?? theme.text.secondary} wrap="truncate">
    {'  ↳ '}
    {text}
  </Text>
)

function ToolLine({ name, subject, state, spin }: { name: string; subject: string; state: 'running' | 'ok' | 'error' | 'denied'; spin?: string }) {
  const t = useT()
  const dot = state === 'running' ? <Text color={colors.AccentPurple}>{spin}</Text> : state === 'ok' ? <Text color={colors.AccentGreen}>◆</Text> : state === 'denied' ? <Text color={colors.AccentYellow}>◇</Text> : <Text color={colors.AccentRed}>◆</Text>
  return (
    <Text wrap="truncate">
      {dot} <Text bold>{toolLabel(name, t)}</Text> <Text color={theme.text.secondary}>{subject}</Text>
    </Text>
  )
}

function Todos({ todos }: { todos: TodoItem[] }) {
  const t = useT()
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={theme.text.secondary}> {t('todos.title')}</Text>
      {todos.map((todo, i) => (
        <Text key={i} wrap="truncate">
          {'  '}
          {todo.status === 'completed' ? <Text color={colors.AccentGreen}>☑ </Text> : todo.status === 'in_progress' ? <Text color={colors.AccentPurple}>▣ </Text> : <Text color={theme.text.secondary}>☐ </Text>}
          <Text bold={todo.status === 'in_progress'} color={todo.status === 'completed' ? theme.text.secondary : undefined} strikethrough={todo.status === 'completed'}>
            {todo.content}
          </Text>
        </Text>
      ))}
    </Box>
  )
}

function HistoryItem({ item, cols }: { item: Item; cols: number }) {
  switch (item.kind) {
    case 'banner':
      return <Banner item={item} cols={cols} />
    case 'user':
      return <UserLine text={item.text} cols={cols} />
    case 'reply':
      return <Reply text={item.text} first={item.first} cols={cols} />
    case 'tool':
      return (
        <Box flexDirection="column" marginBottom={1}>
          <ToolLine name={item.name} subject={item.subject} state={item.state} />
          <ToolResultView name={item.name} result={item.result} state={item.state} cwd={item.cwd} cols={cols} />
        </Box>
      )
    case 'todos':
      return <Todos todos={item.todos} />
    case 'notice': {
      const color = { info: theme.text.secondary, warn: colors.AccentYellow, error: colors.AccentRed, ok: colors.AccentGreen }[item.level]
      return (
        <Box marginBottom={1}>
          <Text color={color}>
            {item.level === 'error' ? '  ✕ ' : '  ◇ '}
            {item.text}
          </Text>
        </Box>
      )
    }
    case 'lines':
      return (
        <Box flexDirection="column" marginBottom={1}>
          {item.title && <Text bold>{item.title}</Text>}
          {item.rows.map(([k, v], i) => (
            <Text key={i} wrap="truncate">
              {'  '}
              <Text color={colors.AccentPurple}>{k.padEnd(16)}</Text> {v}
            </Text>
          ))}
        </Box>
      )
  }
}

// ---------------------------------------------------------------- approvals, questions, lists

function Panel({ title, children, cols }: { title: string; children: React.ReactNode; cols: number }) {
  return (
    <Box borderStyle="round" borderColor={colors.AccentPurple} flexDirection="column" paddingX={1} width={cols}>
      <Text bold color={colors.AccentPurple}>
        {title}
      </Text>
      {children}
    </Box>
  )
}

/** What an approval shows: the command, the change, or the request as JSON. */
function Preview({ input, cols }: { input: Record<string, unknown>; cols: number }) {
  if (typeof input.command === 'string')
    return (
      <Box marginY={1} flexDirection="column">
        {input.command
          .split('\n')
          .slice(0, 10)
          .map((l, i) => (
            <Text key={i} color={colors.AccentCyan}>
              $ {l}
            </Text>
          ))}
      </Box>
    )
  const edits = Array.isArray(input.edits) ? (input.edits as Record<string, unknown>[]) : typeof input.old_string === 'string' ? [input] : []
  const file = String(input.path ?? input.file_path ?? '')
  if (edits.length) {
    const patch = edits
      .slice(0, 4)
      .map((e) => {
        const del = String(e.old_string ?? '').replace(/\n$/, '').split('\n')
        const add = String(e.new_string ?? '').replace(/\n$/, '').split('\n')
        return `@@ -1,${del.length} +1,${add.length} @@\n${del.map((l) => `-${l}`).join('\n')}\n${add.map((l) => `+${l}`).join('\n')}`
      })
      .join('\n')
    return (
      <Box marginY={1}>
        <DiffRenderer diffContent={`--- a/${file}\n+++ b/${file}\n${patch}`} filename={file} terminalWidth={cols - 4} availableTerminalHeight={16} />
      </Box>
    )
  }
  if (typeof input.content === 'string') {
    const ls = input.content.replace(/\n$/, '').split('\n')
    return (
      <Box marginY={1}>
        <DiffRenderer diffContent={`--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${ls.length} @@\n${ls.map((l) => `+${l}`).join('\n')}`} filename={file} terminalWidth={cols - 4} availableTerminalHeight={16} />
      </Box>
    )
  }
  const json = JSON.stringify(input)
  return json && json !== '{}' ? (
    <Box marginY={1}>
      <Text color={theme.text.secondary} wrap="truncate-end">
        {json}
      </Text>
    </Box>
  ) : null
}

function OverlayView({ state, store, editorEmpty, cols }: { state: ChatState; store: ChatStore; editorEmpty: boolean; cols: number }) {
  const t = useT()
  const o = state.overlay!
  if (o.kind === 'permission') {
    const req = o.req
    return (
      <Panel title={t('approval.title')} cols={cols}>
        <Text>
          <Text bold>{toolLabel(req.tool, t)}</Text> {req.subject}
        </Text>
        {req.reason ? <Text color={theme.text.secondary}>{req.reason}</Text> : null}
        <Preview input={(req.input ?? {}) as Record<string, unknown>} cols={cols - 4} />
        <RadioButtonSelect
          isFocused={editorEmpty}
          items={[
            { key: 'yes', value: 'yes', label: t('approval.yes') },
            { key: 'always', value: 'always', label: t('approval.always'), sublabel: req.suggestedRule },
            { key: 'no', value: 'no', label: t('approval.no'), sublabel: t('approval.noHint') },
          ]}
          onSelect={(v) => store.answerPermission(v === 'yes' ? { type: 'allow' } : v === 'always' ? { type: 'allowAlways' } : { type: 'deny' })}
        />
      </Panel>
    )
  }
  if (o.kind === 'question') {
    const multi = !!o.req.multiSelect
    return (
      <Panel title={t('question.title')} cols={cols}>
        <Text>{o.req.question}</Text>
        <Box marginTop={1}>
          <RadioButtonSelect
            isFocused={editorEmpty}
            showNumbers={!multi}
            items={o.req.options.map((opt, i) => ({ key: String(i), value: i, label: multi ? `${o.checked.includes(i) ? '◉' : '○'} ${opt}` : opt }))}
            onSelect={(i) => (multi ? store.answerQuestion(o.checked.sort().map((x) => o.req.options[x]).join(', ') || o.req.options[i]) : store.answerQuestion(o.req.options[i]))}
            onHighlight={(i) => (highlighted.current = i)}
          />
        </Box>
        <Text color={theme.text.secondary}>{multi ? t('question.multiHint') : t('question.hint')}</Text>
      </Panel>
    )
  }
  return (
    <Panel title={o.title} cols={cols}>
      <RadioButtonSelect items={o.choices.map((c, i) => ({ key: String(i), value: i, label: c.label, sublabel: c.hint }))} initialIndex={o.initial} maxItemsToShow={10} showScrollArrows showNumbers={false} onSelect={(i) => store.pick(i)} />
      <Text color={theme.text.secondary}>{t('picker.hint')}</Text>
    </Panel>
  )
}

/** Which option of an open multi-choice question is highlighted (space toggles it). */
const highlighted = { current: 0 }

// ---------------------------------------------------------------- the prompt

function InputBox({ editor, placeholder, cols, busy }: { editor: LineEditor; placeholder: string; cols: number; busy: boolean }) {
  const { row, col } = editor.cursor()
  const lines = editor.lines()
  return (
    <Box borderStyle="round" borderColor={busy ? colors.DarkGray : colors.Gray} paddingX={1} width={cols} flexDirection="column">
      {editor.empty ? (
        <Text>
          <Text color={colors.AccentPurple}>› </Text>
          <Text inverse> </Text>
          <Text color={theme.text.secondary}>{placeholder}</Text>
        </Text>
      ) : (
        lines.map((line, i) => {
          const chars = [...line]
          const before = i === row ? chars.slice(0, col).join('') : line
          const at = i === row ? (chars[col] ?? ' ') : ''
          const after = i === row ? chars.slice(col + 1).join('') : ''
          return (
            <Text key={i} wrap="wrap">
              <Text color={colors.AccentPurple}>{i === 0 ? '› ' : '  '}</Text>
              {before}
              {i === row ? <Text inverse>{at}</Text> : null}
              {after}
            </Text>
          )
        })
      )}
    </Box>
  )
}

function Footer({ state, cols }: { state: ChatState; cols: number }) {
  const t = useT()
  const ctx = state.contextPct
  return (
    <Box width={cols} paddingX={1}>
      <Box flexGrow={1}>
        <Text wrap="truncate">
          <Text color={MODE_COLORS[state.mode]}>⏵ {modeLabel(state.mode, t)}</Text>
          <Text color={theme.text.secondary}> · shift+tab</Text>
          {state.queue.length ? <Text color={colors.AccentPurple}> · {t('footer.queued', { count: state.queue.length })}</Text> : null}
          {state.hint ? <Text color={theme.text.secondary}> · {state.hint}</Text> : null}
        </Text>
      </Box>
      <Text wrap="truncate" color={theme.text.secondary}>
        {state.model}
        {ctx != null ? <Text color={ctx >= 80 ? colors.AccentYellow : theme.text.secondary}> · {t('footer.context', { percent: ctx })}</Text> : null}
        {state.cost > 0 ? ` · $${state.cost < 0.01 ? state.cost.toFixed(4) : state.cost.toFixed(2)}` : ''}
      </Text>
    </Box>
  )
}

// ---------------------------------------------------------------- the app

export function App({ store, editor, historyFile }: { store: ChatStore; editor: LineEditor; historyFile: string }) {
  const state = useStore(store)
  const t = store.t
  const cols = useColumns()
  const { exit } = useApp()
  const spin = useSpinner(state.running)
  const [, redraw] = useState(0)
  const [lastCtrlC, setLastCtrlC] = useState(0)
  const [lastEsc, setLastEsc] = useState(0)
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    if (!state.running) return
    const t = setInterval(() => setElapsed(Math.round((Date.now() - state.turnStarted) / 1000)), 500)
    return () => clearInterval(t)
  }, [state.running, state.turnStarted])
  // Quitting first clears the live part (prompt, status), then exits on the next frame.
  const [quitting, setQuitting] = useState(false)
  const quit = () => setQuitting(true)
  useEffect(() => {
    if (quitting) setTimeout(exit, 30)
  }, [quitting, exit])
  useEffect(() => {
    store.on('quit', quit)
    return () => void store.off('quit', quit)
  }, [store])

  const touch = () => redraw((n) => n + 1)
  const submit = () => {
    const text = editor.text
    if (!text.trim()) return touch()
    editor.submit()
    saveHistory(historyFile, editor.past)
    touch()
    // Typed during an approval: "no, do this instead". During a question: the answer.
    if (state.overlay?.kind === 'permission') return store.answerPermission({ type: 'deny', feedback: text.trim() })
    if (state.overlay?.kind === 'question') return store.answerQuestion(text.trim())
    void store.submit(text)
  }
  const o = state.overlay
  const typed = editor.text
  const suggestions = useMemo(() => (/^\/\S*$/.test(typed) && !o ? store.commands(typed.slice(1)).slice(0, 6) : []), [typed, o, store])

  useInput((input, key) => {
    // Ctrl+C: close what's open, stop, clear, then (twice) quit.
    if (key.ctrl && input === 'c') {
      if (o) return store.cancelOverlay()
      if (store.stop()) return
      if (!editor.empty) return editor.clear(), touch()
      if (Date.now() - lastCtrlC < 2000) return quit()
      setLastCtrlC(Date.now())
      return store.flash(t('notice.pressCtrlCAgain'))
    }
    if (key.ctrl && input === 'd' && editor.empty && !o) return quit()
    if (key.escape) {
      if (o) return store.cancelOverlay()
      if (store.stop()) return
      if (!editor.empty && Date.now() - lastEsc < 600) editor.clear()
      setLastEsc(Date.now())
      return touch()
    }
    if (key.tab && key.shift) return store.cycleMode()

    // While an option list is open and nothing is typed, it gets the arrows, numbers and Enter.
    if (o && editor.empty) {
      if (key.upArrow || key.downArrow || key.return) return
      if (o.kind !== 'question' && /^[1-9]$/.test(input)) return
      if (o.kind === 'question' && !o.req.multiSelect && /^[1-9]$/.test(input)) return
      if (o.kind === 'question' && o.req.multiSelect && input === ' ') return store.toggleChoice(highlighted.current)
      if (o.kind === 'picker' && (input === 'j' || input === 'k')) return
      if (o.kind === 'permission' && /^[yan]$/i.test(input)) {
        const v = input.toLowerCase()
        if (v === 'y') return store.answerPermission({ type: 'allow' })
        if (v === 'a') return store.answerPermission({ type: 'allowAlways' })
      }
    }

    if (key.tab) {
      const first = suggestions[0]
      if (first) editor.set(`/${first.name} `)
      return touch()
    }
    // Keys that arrive in one burst (fast typing) end with Enter as part of the text; a chunk
    // whose only line break is its last character is typing plus Enter, not a pasted block.
    if (input.length > 1 && /[\r\n]$/.test(input) && !/[\x00-\x1f\x7f]/.test(input.slice(0, -1))) {
      editor.insert(input.slice(0, -1))
      return submit()
    }
    if (key.return && !key.meta && !key.shift) return submit()
    if (key.return || (key.ctrl && input === 'j')) editor.insert('\n')
    else if (key.backspace || key.delete) key.meta || key.ctrl ? editor.killWord() : editor.backspace()
    else if (key.leftArrow) key.meta || key.ctrl ? editor.wordLeft() : editor.left()
    else if (key.rightArrow) key.meta || key.ctrl ? editor.wordRight() : editor.right()
    else if (key.home || (key.ctrl && input === 'a')) editor.home()
    else if (key.end || (key.ctrl && input === 'e')) editor.end()
    else if (key.upArrow) editor.up()
    else if (key.downArrow) editor.down()
    else if (key.ctrl && input === 'u') editor.killBefore()
    else if (key.ctrl && input === 'k') editor.killAfter()
    else if (key.ctrl && input === 'w') editor.killWord()
    else if (key.meta && input === 'b') editor.wordLeft()
    else if (key.meta && input === 'f') editor.wordRight()
    else if (input && !key.ctrl && !key.meta) editor.insert(input)
    touch()
  })

  const label = t(state.tools.length ? 'status.working' : state.reply ? 'status.writing' : state.thinking ? 'status.thinking' : 'status.waiting')
  const placeholder = t(o?.kind === 'permission' ? 'placeholder.permission' : o?.kind === 'question' ? 'placeholder.question' : state.running ? 'placeholder.queue' : 'placeholder.idle')
  const tokens = state.tokensOut >= 1000 ? `${(state.tokensOut / 1000).toFixed(1)}k` : String(state.tokensOut)
  const status = [t('status.seconds', { seconds: elapsed }), ...(state.tokensOut ? [t('status.tokens', { tokens })] : []), t('status.escToStop')].join(' · ')

  const transcript = <Static items={state.items}>{(item) => <HistoryItem key={item.id} item={item} cols={cols} />}</Static>
  if (quitting) return <TContext.Provider value={t}>{transcript}</TContext.Provider>

  return (
    <TContext.Provider value={t}>
      {transcript}
      <Box flexDirection="column" width={cols}>
        {state.reply.trim() ? <Reply text={state.reply} first={!state.replyStarted} cols={cols} pending /> : null}
        {state.running && state.thinking && !state.reply && !state.tools.length ? (
          <Text color={theme.text.secondary} wrap="truncate">
            {`  ◇ ${t('status.thinkingLine')} `}
            <Text italic>{state.thinking.replace(/\s+/g, ' ').trim().slice(-160)}</Text>
          </Text>
        ) : null}
        {state.tools.map((t) => (
          <Box key={t.callId} flexDirection="column">
            <ToolLine name={t.name} subject={t.subject} state="running" spin={spin} />
            {t.progress
              .split('\n')
              .filter(Boolean)
              .slice(-3)
              .map((l, i) => (
                <Text key={i} color={theme.text.secondary} wrap="truncate">
                  {'    '}
                  {l}
                </Text>
              ))}
          </Box>
        ))}
        {state.running && !o ? (
          <Box marginTop={1}>
            <Text>
              <Text color={colors.AccentPurple}>{spin} </Text>
              <Text>{label}… </Text>
              <Text color={theme.text.secondary}>
                ({status})
              </Text>
            </Text>
          </Box>
        ) : null}
        {o ? (
          <Box marginTop={1}>
            <OverlayView state={state} store={store} editorEmpty={editor.empty} cols={cols} />
          </Box>
        ) : null}
        <Box marginTop={1}>
          <InputBox editor={editor} placeholder={placeholder} cols={cols} busy={state.running} />
        </Box>
        {suggestions.map((c) => (
          <Text key={c.name} wrap="truncate">
            {'  '}
            <Text color={colors.AccentPurple}>/{c.name}</Text>
            <Text color={theme.text.secondary}> {c.description}</Text>
          </Text>
        ))}
        <Footer state={state} cols={cols} />
      </Box>
    </TContext.Provider>
  )
}
