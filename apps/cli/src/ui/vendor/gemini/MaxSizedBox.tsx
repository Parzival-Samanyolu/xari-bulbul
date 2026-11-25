/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * Rewritten for Xarı (2026): Gemini CLI's version measures its children with a ResizeObserver
 * from its own fork of Ink. This one keeps the same props; it counts child rows (the code and
 * diff renderers pass one element per line) and says how many it left out, in Xarı's interface
 * language.
 */
import React from 'react'
import { Box, Text } from 'ink'
import { theme, useT } from './_shim.js'

/** The smallest height a constrained box is given. */
export const MINIMUM_MAX_HEIGHT = 2

export interface MaxSizedBoxProps {
  children?: React.ReactNode
  maxWidth?: number
  maxHeight?: number
  overflowDirection?: 'top' | 'bottom'
  additionalHiddenLinesCount?: number
  paddingX?: number
}

/** Shows at most `maxHeight` rows of its children, with a note for the rows it hides. */
export const MaxSizedBox: React.FC<MaxSizedBoxProps> = ({ children, maxWidth, maxHeight, overflowDirection = 'top', additionalHiddenLinesCount = 0, paddingX = 0 }) => {
  const t = useT()
  const rows = React.Children.toArray(children)
  const limit = maxHeight === undefined ? rows.length : Math.max(MINIMUM_MAX_HEIGHT, maxHeight) - 1
  const hidden = Math.max(0, rows.length - limit) + additionalHiddenLinesCount
  const shown = hidden ? (overflowDirection === 'top' ? rows.slice(rows.length - limit) : rows.slice(0, limit)) : rows
  const note = hidden ? (
    <Text color={theme.text.secondary} wrap="truncate">
      {t(overflowDirection === 'top' ? 'result.linesAbove' : 'result.linesBelow', { count: hidden })}
    </Text>
  ) : null
  return (
    <Box flexDirection="column" width={maxWidth} paddingX={paddingX}>
      {overflowDirection === 'top' && note}
      {shown}
      {overflowDirection === 'bottom' && note}
    </Box>
  )
}
