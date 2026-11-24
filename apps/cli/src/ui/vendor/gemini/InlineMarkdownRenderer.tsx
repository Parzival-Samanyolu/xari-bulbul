/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * Modified for Xarı (2026): imports point at Xarı's shims (./_shim.ts) instead of Gemini CLI's
 * settings, theme manager and key bindings. See apps/cli/src/ui/vendor/gemini/README.md.
 */

import React from 'react';
import { Text } from 'ink';
import { parseMarkdownToANSI } from './markdownParsingUtils.js';
import { stripUnsafeCharacters } from './textUtils.js';

interface RenderInlineProps {
  text: string;
  defaultColor?: string;
}

const RenderInlineInternal: React.FC<RenderInlineProps> = ({
  text: rawText,
  defaultColor,
}) => {
  const text = stripUnsafeCharacters(rawText);
  const ansiText = parseMarkdownToANSI(text, defaultColor);

  return <Text>{ansiText}</Text>;
};

export const RenderInline = React.memo(RenderInlineInternal);
