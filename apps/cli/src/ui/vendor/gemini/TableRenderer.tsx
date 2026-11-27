/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * Rewritten for Xarı (2026): Gemini CLI's table renderer wraps cells with styled-text helpers
 * that exist only in its own fork of Ink. This keeps the same props and look (inline Markdown in
 * cells, bold headers, box-drawing borders, columns shrunk to fit) using plain Ink.
 */
import React, { useMemo } from 'react'
import { Box, Text } from 'ink'
import stringWidth from 'string-width'
import stripAnsi from 'strip-ansi'
import { theme, safeRepeat } from './_shim.js'
import { parseMarkdownToANSI } from './markdownParsingUtils.js'
import { stripUnsafeCharacters } from './textUtils.js'

interface TableRendererProps {
  headers: string[]
  rows: string[][]
  terminalWidth: number
}

const MIN_COLUMN_WIDTH = 5
const COLUMN_PADDING = 2
const TABLE_MARGIN = 2

/** Wraps plain text to `width` columns at spaces (long words are split). */
function wrapPlain(text: string, width: number): string[] {
  const out: string[] = []
  for (const para of text.split('\n')) {
    let line = ''
    for (const word of para.split(/(\s+)/)) {
      if (!word) continue
      if (stringWidth(line + word) <= width) {
        line += word
        continue
      }
      if (line.trim()) out.push(line.trimEnd())
      line = word.trimStart()
      while (stringWidth(line) > width) {
        let cut = ''
        for (const ch of line) {
          if (stringWidth(cut + ch) > width) break
          cut += ch
        }
        out.push(cut)
        line = line.slice(cut.length)
      }
    }
    out.push(line.trimEnd())
  }
  return out.length ? out : ['']
}

/** Fits column widths into the terminal: natural widths first, then shrinks the widest columns. */
function columnWidths(cells: string[][], available: number): number[] {
  const n = Math.max(...cells.map((r) => r.length))
  const natural = Array.from({ length: n }, (_, c) => Math.max(MIN_COLUMN_WIDTH, ...cells.map((r) => stringWidth(r[c] ?? ''))))
  const budget = Math.max(n * MIN_COLUMN_WIDTH, available - n * (COLUMN_PADDING + 1) - 1)
  const widths = [...natural]
  while (widths.reduce((a, b) => a + b, 0) > budget) {
    const i = widths.indexOf(Math.max(...widths))
    if (widths[i] <= MIN_COLUMN_WIDTH) break
    widths[i]--
  }
  return widths
}

export const TableRenderer: React.FC<TableRendererProps> = ({ headers, rows, terminalWidth }) => {
  const plain = useMemo(() => {
    const toPlain = (cell: string) => stripAnsi(parseMarkdownToANSI(stripUnsafeCharacters(cell ?? '')))
    return { headers: headers.map(toPlain), rows: rows.map((r) => headers.map((_, i) => toPlain(r[i] ?? ''))) }
  }, [headers, rows])
  const widths = columnWidths([plain.headers, ...plain.rows], terminalWidth - TABLE_MARGIN)

  const border = (l: string, m: string, r: string) => (
    <Text color={theme.border.default}>{l + widths.map((w) => safeRepeat('─', w + COLUMN_PADDING)).join(m) + r}</Text>
  )
  const row = (cells: string[], header: boolean, key: string) => {
    const wrapped = cells.map((c, i) => wrapPlain(c, widths[i]))
    const height = Math.max(...wrapped.map((w) => w.length))
    return Array.from({ length: height }, (_, line) => (
      <Text key={`${key}-${line}`}>
        <Text color={theme.border.default}>│</Text>
        {wrapped.map((w, i) => {
          const text = w[line] ?? ''
          return (
            <React.Fragment key={i}>
              <Text bold={header} color={header ? theme.text.link : theme.text.primary}>
                {' ' + text + safeRepeat(' ', widths[i] - stringWidth(text) + 1)}
              </Text>
              <Text color={theme.border.default}>│</Text>
            </React.Fragment>
          )
        })}
      </Text>
    ))
  }

  return (
    <Box flexDirection="column" marginY={1}>
      {border('┌', '┬', '┐')}
      {row(plain.headers, true, 'h')}
      {border('├', '┼', '┤')}
      {plain.rows.map((r, i) => row(r, false, `r${i}`))}
      {border('└', '┴', '┘')}
    </Box>
  )
}
