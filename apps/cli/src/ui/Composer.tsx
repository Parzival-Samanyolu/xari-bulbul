import { Box, Text, useInput, usePaste } from 'ink'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTheme } from '../theme/palette.js'
import * as E from './editor.js'
import { Popup, type PopupRow } from './Popup.js'

export interface CommandInfo {
  name: string
  description: string
  /** Shown after the name; a command with args waits for them instead of running at once. */
  args?: string
  source?: 'builtin' | 'user' | 'project'
}

export interface ComposerProps {
  active: boolean
  width: number
  placeholder?: string
  commands: CommandInfo[]
  /** Lists project files for @ mentions (called once, lazily). */
  listFiles: () => Promise<string[]>
  history: string[]
  /** `display` keeps paste placeholders; `text` has them expanded. */
  onSubmit: (text: string, display: string) => void
  /** Returns true when handled (e.g. interrupting a running turn). */
  onEscape: () => boolean
  onCtrlC: (hadText: boolean) => void
  onCycleMode: () => void
  onModelPicker: () => void
  onExpand: () => void
  onToggleShortcuts: () => void
  /** Draft restored from outside (e.g. after Esc in an approval). */
  draft?: string
}

const MAX_POPUP = 8

/**
 * The prompt at the bottom: multi-line editing, input history, bracketed paste with placeholders
 * for big pastes, `/` command popup and `@` file mentions with fuzzy filtering.
 */
export function Composer(p: ComposerProps) {
  const t = useTheme()
  const [buf, setBuf] = useState<E.Buffer>(p.draft ? { text: p.draft, cursor: p.draft.length } : E.empty)
  const [sel, setSel] = useState(0)
  const [hist, setHist] = useState<{ index: number; draft: string } | null>(null)
  const [files, setFiles] = useState<string[] | null>(null)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const pastes = useRef(new Map<string, string>())

  useEffect(() => {
    if (p.draft !== undefined) setBuf({ text: p.draft, cursor: p.draft.length })
  }, [p.draft])

  const token = E.activeToken(buf)
  const tokenKey = token ? `${token.kind}:${token.start}:${token.query}` : null
  useEffect(() => {
    if (token?.kind === 'mention' && files === null) {
      setFiles([])
      p.listFiles().then(setFiles, () => setFiles([]))
    }
  }, [token?.kind])

  const popupRows: PopupRow[] = useMemo(() => {
    if (!token || dismissed === tokenKey) return []
    if (token.kind === 'slash') {
      return p.commands
        .map((c) => ({ c, score: E.fuzzyScore(token.query, c.name) }))
        .filter((x) => x.score !== null)
        .sort((a, b) => a.score! - b.score!)
        .map(({ c }) => ({
          key: c.name,
          label: `/${c.name}${c.args ? ` ${c.args}` : ''}`,
          detail: c.description + (c.source && c.source !== 'builtin' ? ` (${c.source})` : ''),
          match: E.fuzzyIndices(token.query, c.name).map((i) => i + 1),
        }))
    }
    return (files ?? [])
      .map((f) => ({ f, score: E.fuzzyScore(token.query, f) }))
      .filter((x) => x.score !== null)
      .sort((a, b) => a.score! - b.score! || a.f.length - b.f.length)
      .slice(0, 50)
      .map(({ f }) => ({ key: f, label: f, match: E.fuzzyIndices(token.query, f) }))
  }, [tokenKey, files, p.commands, dismissed])
  const popupOpen = popupRows.length > 0
  const selIdx = Math.min(sel, Math.max(0, popupRows.length - 1))

  const set = (b: E.Buffer) => {
    setBuf(b)
    setSel(0)
  }

  const submit = (text: string) => {
    const full = E.expandPastes(text, pastes.current)
    if (!full.trim()) return
    pastes.current.clear()
    setHist(null)
    set(E.empty)
    p.onSubmit(full, text)
  }

  /** Accepts the popup selection; `run` submits a no-argument command straight away. */
  const accept = (run: boolean) => {
    const row = popupRows[selIdx]
    if (!row || !token) return
    if (token.kind === 'slash') {
      const cmd = p.commands.find((c) => c.name === row.key)
      if (run && cmd && !cmd.args) return submit(`/${row.key}`)
      set(E.replaceToken(buf, token.start, `/${row.key} `))
    } else {
      set(E.replaceToken(buf, token.start, `@${row.key} `))
    }
  }

  usePaste(
    (text) => {
      const clean = text.replace(/\r\n?/g, '\n')
      if (clean.length > E.PASTE_CHARS || clean.split('\n').length > E.PASTE_LINES) {
        const label = E.pasteLabel(clean, pastes.current.size + 1)
        pastes.current.set(label, clean)
        set(E.insert(buf, label))
      } else set(E.insert(buf, clean))
    },
    { isActive: p.active },
  )

  useInput(
    (input, key) => {
      if (key.ctrl && input === 'c') {
        const had = buf.text.length > 0
        if (had) {
          pastes.current.clear()
          set(E.empty)
        }
        return p.onCtrlC(had)
      }
      if (key.escape) {
        if (popupOpen) return setDismissed(tokenKey)
        p.onEscape()
        return
      }
      if (key.tab && key.shift) return p.onCycleMode()
      if (key.ctrl && input === 'k') return p.onModelPicker()
      if (key.ctrl && input === 'o') return p.onExpand()
      if (popupOpen) {
        if (key.upArrow) return setSel((selIdx + popupRows.length - 1) % popupRows.length)
        if (key.downArrow) return setSel((selIdx + 1) % popupRows.length)
        if (key.tab) return accept(false)
        if (key.return && !key.shift && !key.meta) return accept(true)
      }
      // Newline: shift+enter (kitty), alt+enter, ctrl+j, or a trailing backslash before enter.
      if ((key.return && (key.shift || key.meta)) || input === '\n') return set(E.insert(buf, '\n'))
      if (key.return) {
        if (buf.text.slice(0, buf.cursor).endsWith('\\')) return set(E.insert(E.backspace(buf), '\n'))
        return submit(buf.text)
      }
      if (key.upArrow) {
        const moved = E.up(buf)
        if (moved) return set(moved)
        if (!p.history.length) return
        const index = hist ? Math.min(hist.index + 1, p.history.length - 1) : 0
        const draft = hist?.draft ?? buf.text
        setHist({ index, draft })
        const text = p.history[p.history.length - 1 - index]
        return set({ text, cursor: text.length })
      }
      if (key.downArrow) {
        const moved = E.down(buf)
        if (moved) return set(moved)
        if (!hist) return
        if (hist.index === 0) {
          setHist(null)
          return set({ text: hist.draft, cursor: hist.draft.length })
        }
        const index = hist.index - 1
        setHist({ ...hist, index })
        const text = p.history[p.history.length - 1 - index]
        return set({ text, cursor: text.length })
      }
      if (key.leftArrow) return set(key.meta || key.ctrl ? E.wordLeft(buf) : E.left(buf))
      if (key.rightArrow) return set(key.meta || key.ctrl ? E.wordRight(buf) : E.right(buf))
      if (key.home || (key.ctrl && input === 'a')) return set(E.home(buf))
      if (key.end || (key.ctrl && input === 'e')) return set(E.end(buf))
      if (key.backspace) return set(key.meta ? E.deleteWord(buf) : E.backspace(buf))
      if (key.delete) return set(E.del(buf))
      if (key.ctrl && input === 'w') return set(E.deleteWord(buf))
      if (key.ctrl && input === 'u') return set(E.deleteToLineStart(buf))
      if (input === '?' && !buf.text) return p.onToggleShortcuts()
      if (input && !key.ctrl && !key.meta) {
        setDismissed(null)
        set(E.insert(buf, input.replace(/\r\n?/g, '\n')))
      }
    },
    { isActive: p.active },
  )

  const lines = buf.text.split('\n')
  let offset = 0
  const cursorLine = buf.text.slice(0, buf.cursor).split('\n').length - 1
  return (
    <Box flexDirection="column">
      {popupOpen && p.active && (
        <Popup
          rows={popupRows}
          selected={selIdx}
          maxRows={MAX_POPUP}
          width={p.width}
          footer={token?.kind === 'slash' ? '⏎ run · tab complete · esc close' : '⏎/tab insert · esc close'}
        />
      )}
      <Box flexDirection="column" backgroundColor={t.panel} paddingX={1} marginTop={1} width={p.width}>
        {lines.map((line, i) => {
          const start = offset
          offset += line.length + 1
          const isCursorLine = p.active && i === cursorLine
          const col = buf.cursor - start
          return (
            <Box key={i}>
              <Text color={t.accent} bold>
                {i === 0 ? '› ' : '  '}
              </Text>
              {!buf.text && i === 0 ? (
                <Text>
                  {p.active ? <Text inverse> </Text> : null}
                  <Text color={t.muted}>{p.placeholder ?? 'Ask Xarı Bülbül to do anything'}</Text>
                </Text>
              ) : isCursorLine ? (
                <Text>
                  {line.slice(0, col)}
                  <Text inverse>{line[col] ?? ' '}</Text>
                  {line.slice(col + 1)}
                </Text>
              ) : (
                <Text>{line || ' '}</Text>
              )}
            </Box>
          )
        })}
      </Box>
    </Box>
  )
}
