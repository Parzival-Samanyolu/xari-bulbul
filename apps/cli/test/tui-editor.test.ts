import { describe, expect, it } from 'vitest'
import { LineEditor } from '../src/tui/editor.js'

describe('LineEditor', () => {
  it('inserts, moves and deletes around emoji and accented letters', () => {
    const e = new LineEditor()
    e.insert('Bülbül 🌸')
    e.backspace()
    expect(e.text).toBe('Bülbül ')
    e.home()
    e.right()
    e.del()
    expect(e.text).toBe('Blbül ')
    e.end()
    e.insert('x')
    expect(e.text).toBe('Blbül x')
  })

  it('moves and deletes by words', () => {
    const e = new LineEditor()
    e.insert('fix the xarı bülbül build')
    e.killWord()
    expect(e.text).toBe('fix the xarı bülbül ')
    e.wordLeft()
    e.wordLeft()
    expect(e.cursor().col).toBe(8)
    e.wordRight()
    expect(e.cursor().col).toBe(12)
  })

  it('handles multi-line prompts and kill commands per line', () => {
    const e = new LineEditor()
    e.insert('one\ntwo\r\nthree')
    expect(e.lines()).toEqual(['one', 'two', 'three'])
    e.up()
    expect(e.cursor()).toEqual({ row: 1, col: 3 })
    e.killBefore()
    expect(e.lines()).toEqual(['one', '', 'three'])
    e.killAfter()
    expect(e.lines()).toEqual(['one', 'three'])
  })

  it('walks history with Up/Down and keeps the draft', () => {
    const e = new LineEditor(['first', 'second'])
    e.insert('draft')
    expect(e.up()).toBe(true)
    expect(e.text).toBe('second')
    e.up()
    expect(e.text).toBe('first')
    expect(e.up()).toBe(false)
    e.down()
    e.down()
    expect(e.text).toBe('draft')
    expect(e.down()).toBe(false)
  })

  it('remembers sent prompts without repeating the last one', () => {
    const e = new LineEditor()
    e.insert('a')
    expect(e.submit()).toBe('a')
    e.insert('a')
    e.submit()
    e.insert('  ')
    e.submit()
    expect(e.past).toEqual(['a'])
    expect(e.empty).toBe(true)
  })
})
