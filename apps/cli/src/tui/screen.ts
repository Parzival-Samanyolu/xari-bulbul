// Two layers: lines printed for good (they scroll up into the terminal's own history, so
// scrolling, search and copy work as usual) and a live region at the bottom that is redrawn.
import { cursor, truncate } from './ansi.js'

export interface Frame {
  lines: string[]
  /** Where the terminal cursor goes (the prompt's caret); hidden when absent. */
  cursor?: { row: number; col: number }
}

/** Synchronized output: terminals that support it paint the whole update at once (no flicker). */
const BEGIN = '\x1b[?2026h'
const END = '\x1b[?2026l'

export class Screen {
  /** Row of the live region the terminal cursor is on now. */
  private cursorRow = 0
  private last: Frame = { lines: [] }

  constructor(private readonly out: NodeJS.WriteStream) {}

  get cols(): number {
    return Math.max(20, this.out.columns || 80)
  }

  get rows(): number {
    return Math.max(8, this.out.rows || 24)
  }

  private toTop(): string {
    return `\r${cursor.up(this.cursorRow)}${cursor.clearDown}`
  }

  /** Prints lines above the live region; they stay in the scrollback. */
  print(lines: string[], live: Frame = this.last) {
    let s = this.toTop()
    for (const l of lines) s += `${l}\n`
    this.cursorRow = 0
    this.out.write(BEGIN + s + this.draw(live) + END)
  }

  render(live: Frame) {
    this.out.write(BEGIN + this.toTop() + this.draw(live) + END)
  }

  /** Repaints the live region, e.g. after a resize. */
  refresh() {
    this.render(this.last)
  }

  /** Clears the live region and leaves the cursor on a fresh line (before exiting). */
  close() {
    this.out.write(`${this.toTop()}${cursor.show}`)
    this.cursorRow = 0
    this.last = { lines: [] }
  }

  private draw(f: Frame): string {
    this.last = f
    const cols = this.cols
    // Never taller than the window: keep the bottom (the prompt) and drop the top.
    const max = this.rows - 1
    const drop = Math.max(0, f.lines.length - max)
    const lines = f.lines.slice(drop).map((l) => truncate(l, cols))
    if (!lines.length) {
      this.cursorRow = 0
      return cursor.hide
    }
    let s = lines.join('\n')
    const bottom = lines.length - 1
    if (f.cursor && f.cursor.row - drop >= 0) {
      const row = Math.min(bottom, f.cursor.row - drop)
      s += cursor.up(bottom - row) + cursor.col(Math.min(cols - 1, f.cursor.col)) + cursor.show
      this.cursorRow = row
    } else {
      s += cursor.hide
      this.cursorRow = bottom
    }
    return s
  }
}
