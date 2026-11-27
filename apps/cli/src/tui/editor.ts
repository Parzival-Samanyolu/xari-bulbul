// The prompt's text and cursor. No terminal here: the UI feeds it keys and draws `lines()`.

/** Word characters for Ctrl+W and Alt+←/→, Unicode-aware so "Bülbül" counts as one word. */
const WORD = /[\p{L}\p{N}_]/u

export class LineEditor {
  text = ''
  /** Cursor position as an index into `text` (in UTF-16 code units, never inside a surrogate pair). */
  pos = 0
  private history: string[]
  /** Where Up/Down is in history; history.length = the draft being typed. */
  private hIndex: number
  private draft = ''

  constructor(history: string[] = []) {
    this.history = [...history]
    this.hIndex = this.history.length
  }

  get empty() {
    return this.text.length === 0
  }

  set(text: string) {
    this.text = text
    this.pos = text.length
  }

  clear() {
    this.set('')
    this.hIndex = this.history.length
  }

  insert(s: string) {
    // Pasted text keeps its newlines; tabs become spaces so the cursor maths stays simple.
    const clean = s.replace(/\r\n?/g, '\n').replace(/\t/g, '  ')
    this.text = this.text.slice(0, this.pos) + clean + this.text.slice(this.pos)
    this.pos += clean.length
  }

  private prevPos(p: number) {
    if (p <= 0) return 0
    const c = this.text.charCodeAt(p - 1)
    return c >= 0xdc00 && c <= 0xdfff && p >= 2 ? p - 2 : p - 1
  }

  private nextPos(p: number) {
    if (p >= this.text.length) return this.text.length
    const c = this.text.charCodeAt(p)
    return c >= 0xd800 && c <= 0xdbff ? p + 2 : p + 1
  }

  backspace() {
    if (!this.pos) return
    const p = this.prevPos(this.pos)
    this.text = this.text.slice(0, p) + this.text.slice(this.pos)
    this.pos = p
  }

  del() {
    const n = this.nextPos(this.pos)
    this.text = this.text.slice(0, this.pos) + this.text.slice(n)
  }

  left() {
    this.pos = this.prevPos(this.pos)
  }

  right() {
    this.pos = this.nextPos(this.pos)
  }

  wordLeft() {
    let p = this.pos
    while (p > 0 && !WORD.test(this.text[p - 1])) p--
    while (p > 0 && WORD.test(this.text[p - 1])) p--
    this.pos = p
  }

  wordRight() {
    let p = this.pos
    while (p < this.text.length && !WORD.test(this.text[p])) p++
    while (p < this.text.length && WORD.test(this.text[p])) p++
    this.pos = p
  }

  private lineStart() {
    return this.text.lastIndexOf('\n', this.pos - 1) + 1
  }

  private lineEnd() {
    const i = this.text.indexOf('\n', this.pos)
    return i === -1 ? this.text.length : i
  }

  home() {
    this.pos = this.lineStart()
  }

  end() {
    this.pos = this.lineEnd()
  }

  /** Ctrl+U: delete from the start of the line to the cursor. */
  killBefore() {
    const s = this.lineStart()
    this.text = this.text.slice(0, s) + this.text.slice(this.pos)
    this.pos = s
  }

  /** Ctrl+K: delete from the cursor to the end of the line (or the newline, at its end). */
  killAfter() {
    const e = this.lineEnd()
    this.text = this.text.slice(0, this.pos) + this.text.slice(e === this.pos ? e + 1 : e)
  }

  /** Ctrl+W: delete the word before the cursor. */
  killWord() {
    const end = this.pos
    this.wordLeft()
    this.text = this.text.slice(0, this.pos) + this.text.slice(end)
  }

  /** Which line the cursor is on and its column (in characters). */
  cursor(): { row: number; col: number } {
    const before = this.text.slice(0, this.pos)
    const row = before.split('\n').length - 1
    return { row, col: [...before.slice(before.lastIndexOf('\n') + 1)].length }
  }

  lines(): string[] {
    return this.text.split('\n')
  }

  /** Up: previous line of a multi-line prompt, else older history. Returns false when nothing moved. */
  up(): boolean {
    const { row, col } = this.cursor()
    if (row > 0) {
      this.moveToLine(row - 1, col)
      return true
    }
    if (this.hIndex === 0) return false
    if (this.hIndex === this.history.length) this.draft = this.text
    this.hIndex--
    this.set(this.history[this.hIndex])
    return true
  }

  down(): boolean {
    const { row, col } = this.cursor()
    if (row < this.lines().length - 1) {
      this.moveToLine(row + 1, col)
      return true
    }
    if (this.hIndex >= this.history.length) return false
    this.hIndex++
    this.set(this.hIndex === this.history.length ? this.draft : this.history[this.hIndex])
    return true
  }

  private moveToLine(row: number, col: number) {
    const ls = this.lines()
    let p = 0
    for (let i = 0; i < row; i++) p += ls[i].length + 1
    const chars = [...ls[row]].slice(0, col).join('')
    this.pos = p + chars.length
  }

  /** Takes the text for sending and remembers it (no repeats of the last entry). */
  submit(): string {
    const t = this.text
    if (t.trim() && this.history[this.history.length - 1] !== t) this.history.push(t)
    if (this.history.length > 500) this.history = this.history.slice(-500)
    this.clear()
    return t
  }

  get past(): string[] {
    return this.history
  }
}
