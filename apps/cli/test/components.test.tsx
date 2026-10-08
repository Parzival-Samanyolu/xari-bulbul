import { describe, expect, it, vi } from 'vitest'
import type { ModelInfo, PermissionRequest } from '@harness/core'
import { Approval, approvalOptions } from '../src/ui/Approval.js'
import { DiffCell, ExecCell, parsePatch } from '../src/ui/cells.js'
import { Composer } from '../src/ui/Composer.js'
import { BUILTIN_COMMANDS } from '../src/ui/commands.js'
import { Footer, usageParts } from '../src/ui/Footer.js'
import { Header } from '../src/ui/Header.js'
import { Markdown, splitCommittable } from '../src/ui/Markdown.js'
import { ModelPicker } from '../src/ui/ModelPicker.js'
import { eventually, KEY, renderUi, tick } from './helpers.js'

const req = (over: Partial<PermissionRequest> = {}): PermissionRequest => ({
  callId: 'c1',
  tool: 'bash',
  kind: 'exec',
  subject: 'npm test',
  input: { command: 'npm test' },
  reason: 'Runs a shell command.',
  suggestedRule: 'bash(npm test*)',
  ...over,
})

describe('Header', () => {
  const props = { version: '0.2.0', model: 'openrouter/free', provider: 'OpenRouter', cwd: '/work/proj', mode: 'ask' as const }
  it('shows the name, version, model, folder and mode', () => {
    const { text } = renderUi(<Header {...props} columns={100} />)
    expect(text()).toContain('Xarı Bülbül v0.2.0')
    expect(text()).toContain('openrouter/free')
    expect(text()).toContain('/work/proj')
    expect(text()).toMatch(/mode\s+Ask/)
    expect(text()).toContain('▀')
  })
  it('leaves the orchid out on narrow terminals and uses ASCII without truecolor', () => {
    expect(renderUi(<Header {...props} columns={50} />).text()).not.toMatch(/[▀▄]|\(O\)/)
    expect(renderUi(<Header {...props} columns={100} />, 0).text()).toContain('_(O)_')
  })
  it('puts a setup problem where the hints go', () => {
    expect(renderUi(<Header {...props} columns={100} problem="No API key for OpenRouter." />).text()).toContain('No API key for OpenRouter.')
  })
})

describe('Approval', () => {
  it('offers once / always / no, and answers with keys', async () => {
    const onAnswer = vi.fn()
    const r = renderUi(<Approval req={req()} onAnswer={onAnswer} />)
    expect(r.text()).toContain('Run this command?')
    expect(r.text()).toContain('$ npm test')
    expect(r.text()).toContain('1. Yes, once')
    expect(r.text()).toContain('2. Yes, and allow bash(npm test*)')
    await tick()
    r.stdin.write('a')
    await eventually(() => expect(onAnswer).toHaveBeenCalledWith({ type: 'allowAlways' }))
  })

  it('never offers "always" for destructive commands', () => {
    const destructive = req({ subject: 'rm -rf build', input: { command: 'rm -rf build' }, reason: "Deletes files: build. This can't be undone.", suggestedRule: '' })
    expect(approvalOptions(destructive).map((o) => o.answer)).toEqual(['allow', 'deny'])
    const r = renderUi(<Approval req={destructive} onAnswer={() => {}} />)
    expect(r.text()).not.toContain('allow bash')
    expect(r.text()).toContain('only be allowed once')
  })

  it('collects feedback when denying, and Esc stops the turn', async () => {
    const onAnswer = vi.fn()
    const r = renderUi(<Approval req={req()} onAnswer={onAnswer} />)
    await tick()
    r.stdin.write('n')
    await tick()
    r.stdin.write('use pnpm')
    await tick()
    r.stdin.write(KEY.enter)
    await eventually(() => expect(onAnswer).toHaveBeenCalledWith({ type: 'deny', feedback: 'use pnpm' }))
    const esc = vi.fn()
    const r2 = renderUi(<Approval req={req()} onAnswer={esc} />)
    await tick()
    r2.stdin.write(KEY.esc)
    await eventually(() => expect(esc).toHaveBeenCalledWith({ type: 'deny' }, { interrupt: true }))
  })

  it('previews edits as a diff', () => {
    const r = renderUi(<Approval req={req({ tool: 'edit_file', kind: 'edit', subject: 'a.ts', input: { path: 'a.ts', old_string: 'a = 1', new_string: 'a = 2' }, suggestedRule: 'edit_file(a.ts)' })} onAnswer={() => {}} />)
    expect(r.text()).toContain('Apply this edit?')
    expect(r.text()).toContain('-a = 1')
    expect(r.text()).toContain('+a = 2')
  })
})

describe('tool cells', () => {
  const patch = ['--- a.ts', '+++ a.ts', '@@ -1,3 +1,3 @@', ' one', '-two', '+TWO', ' three', ''].join('\n')

  it('renders diffs with counts and line numbers', () => {
    expect(parsePatch(patch).map((l) => `${l.sign}${l.newNo ?? l.oldNo}`)).toEqual([' 1', '-2', '+2', ' 3'])
    const t = renderUi(<DiffCell display={{ kind: 'diff', path: 'a.ts', patch, added: 1, removed: 1 }} verb="Edited" />).text()
    expect(t).toContain('Edited a.ts (+1 -1)')
    expect(t).toMatch(/2 -two/)
    expect(t).toMatch(/2 \+TWO/)
  })

  it('condenses command output and shows a failing exit code', () => {
    const out = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n') + '\n[exit code: 1]'
    const tool = { callId: '1', name: 'bash', subject: 'npm test', input: {}, startedAt: 0, result: { content: out, isError: true }, durationMs: 2100 }
    const t = renderUi(<ExecCell tool={tool} />).text()
    expect(t).toContain('Ran npm test')
    expect(t).toContain('line 1')
    expect(t).toContain('line 12')
    expect(t).not.toContain('line 6')
    expect(t).toContain('+7 lines (ctrl+o to expand)')
    expect(t).toContain('exit 1')
    expect(t).toContain('2s')
    expect(renderUi(<ExecCell tool={tool} expanded />).text()).toContain('line 6')
  })
})

describe('Markdown', () => {
  it('renders headings, lists, code and inline marks', () => {
    const t = renderUi(<Markdown text={'# Title\n\n- one **bold**\n- two `code`\n\n```ts\nconst x = 1\n```'} />).text()
    expect(t).toContain('Title')
    expect(t).toContain('• one bold')
    expect(t).toContain('• two code')
    expect(t).toContain('▏ const x = 1')
  })
  it('only commits complete blocks outside code fences', () => {
    expect(splitCommittable('para one\n\npara two')).toEqual(['para one\n\n', 'para two'])
    expect(splitCommittable('```\ncode\n\nmore')).toEqual(['', '```\ncode\n\nmore'])
  })
})

describe('Footer', () => {
  const totals = { requests: 3, promptTokens: 12_345, completionTokens: 678, cachedTokens: 0, cost: 0.0123, costPartial: false }
  it('always shows context, tokens and cost at 80 columns', () => {
    const t = renderUi(<Footer mode="auto" model="openrouter/free" session={totals} today={totals} context={{ used: 34_000, length: 100_000 }} columns={78} />).text()
    expect(t).toContain('Full auto')
    expect(t).toContain('34% context')
    expect(t).toContain('↑12k ↓678')
    expect(t).toContain('$0.012')
  })
  it('lists usage parts in priority order', () => {
    expect(usageParts({ session: totals, today: totals, context: { used: 0, length: 0 }, model: 'm' })[0]).toBe('0% context')
  })
})

describe('Composer', () => {
  const base = {
    active: true,
    width: 80,
    commands: BUILTIN_COMMANDS,
    listFiles: async () => ['src/app.ts', 'README.md'],
    history: ['first', 'second'],
    onEscape: () => false,
    onCtrlC: () => {},
    onCycleMode: () => {},
    onModelPicker: () => {},
    onExpand: () => {},
    onToggleShortcuts: () => {},
  }

  it('submits on enter and inserts newlines with ctrl+j', async () => {
    const onSubmit = vi.fn()
    const r = renderUi(<Composer {...base} onSubmit={onSubmit} />)
    expect(r.text()).toContain('Ask Xarı Bülbül to do anything')
    await tick()
    r.stdin.write('hello')
    await tick()
    r.stdin.write(KEY.ctrlJ)
    await tick()
    r.stdin.write('world')
    await tick()
    r.stdin.write(KEY.enter)
    await eventually(() => expect(onSubmit).toHaveBeenCalledWith('hello\nworld', 'hello\nworld'))
  })

  it('recalls history with the up arrow', async () => {
    const r = renderUi(<Composer {...base} onSubmit={() => {}} />)
    await tick()
    r.stdin.write(KEY.up)
    await eventually(() => expect(r.text()).toContain('second'))
    r.stdin.write(KEY.up)
    await eventually(() => expect(r.text()).toContain('first'))
  })

  it('filters the slash popup and runs a command with enter', async () => {
    const onSubmit = vi.fn()
    const r = renderUi(<Composer {...base} onSubmit={onSubmit} />)
    await tick()
    r.stdin.write('/sta')
    await eventually(() => expect(r.text()).toContain('/status'))
    expect(r.text()).not.toContain('/compact')
    r.stdin.write(KEY.enter)
    await eventually(() => expect(onSubmit).toHaveBeenCalledWith('/status', '/status'))
  })

  it('completes @ mentions from project files', async () => {
    const r = renderUi(<Composer {...base} onSubmit={() => {}} />)
    await tick()
    r.stdin.write('see @app')
    await eventually(() => expect(r.text()).toContain('src/app.ts'))
    r.stdin.write(KEY.tab)
    await eventually(() => expect(r.text()).toContain('see @src/app.ts'))
  })

  it('cycles the mode on shift+tab and opens the model picker on ctrl+k', async () => {
    const onCycleMode = vi.fn()
    const onModelPicker = vi.fn()
    const r = renderUi(<Composer {...base} onSubmit={() => {}} onCycleMode={onCycleMode} onModelPicker={onModelPicker} />)
    await tick()
    r.stdin.write(KEY.shiftTab)
    r.stdin.write('\x0b')
    await eventually(() => {
      expect(onCycleMode).toHaveBeenCalled()
      expect(onModelPicker).toHaveBeenCalled()
    })
  })
})

describe('ModelPicker', () => {
  const m = (id: string, o: Partial<ModelInfo> = {}): ModelInfo => ({ id, name: id, providerId: 'or', free: false, supportsTools: true, ...o })
  const models = [
    m('free/a', { name: 'A Free (free)', free: true, pricing: { prompt: 0, completion: 0 }, created: 2, contextLength: 32_000 }),
    m('paid/b', { name: 'B Paid', pricing: { prompt: 1e-6, completion: 2e-6 }, created: 3 }),
  ]
  const props = {
    providers: [{ id: 'or', name: 'OpenRouter', ready: true }],
    load: async () => models,
    favorites: [],
    recent: [],
    picker: { freeOnly: true, toolsOnly: true, sort: 'newest' as const },
    width: 90,
    onClose: () => {},
    onToggleFavorite: () => {},
    onPickerChange: () => {},
  }

  it('opens on free models and shows the full catalog with ctrl+a', async () => {
    const onPickerChange = vi.fn()
    const r = renderUi(<ModelPicker {...props} onChoose={() => {}} onPickerChange={onPickerChange} />)
    await eventually(() => expect(r.text()).toContain('A Free'))
    expect(r.text()).not.toContain('B Paid')
    expect(r.text()).toContain('free only')
    r.stdin.write(KEY.ctrlA)
    await eventually(() => expect(r.text()).toContain('B Paid'))
    expect(onPickerChange).toHaveBeenCalledWith({ freeOnly: false })
  })

  it('filters by typing and chooses with enter', async () => {
    const onChoose = vi.fn()
    const r = renderUi(<ModelPicker {...props} picker={{ ...props.picker, freeOnly: false }} onChoose={onChoose} />)
    await eventually(() => expect(r.text()).toContain('B Paid'))
    r.stdin.write('paid')
    await eventually(() => expect(r.text()).not.toContain('A Free'))
    r.stdin.write(KEY.enter)
    await eventually(() => expect(onChoose).toHaveBeenCalledWith({ providerId: 'or', modelId: 'paid/b' }))
  })
})
