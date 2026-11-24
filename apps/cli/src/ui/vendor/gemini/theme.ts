/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * Modified for Xarı (2026): imports point at Xarı's shims (./_shim.ts) instead of Gemini CLI's
 * settings, theme manager and key bindings. See apps/cli/src/ui/vendor/gemini/README.md.
 */

import type { CSSProperties } from 'react';

import type { SemanticColors } from './semantic-tokens.js';

import {
  DEFAULT_INPUT_BACKGROUND_OPACITY,
  DEFAULT_SELECTION_OPACITY,
} from './_shim.js';
import tinygradient from 'tinygradient';
import tinycolor from 'tinycolor2';

// Define the set of Ink's named colors for quick lookup
export const INK_SUPPORTED_NAMES = new Set([
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'cyan',
  'magenta',
  'white',
  'gray',
  'grey',
  'blackbright',
  'redbright',
  'greenbright',
  'yellowbright',
  'bluebright',
  'cyanbright',
  'magentabright',
  'whitebright',
]);

// Use tinycolor's built-in names map for CSS colors, excluding ones Ink supports
export const CSS_NAME_TO_HEX_MAP = Object.fromEntries(
  Object.entries(tinycolor.names)
    .filter(([name]) => !INK_SUPPORTED_NAMES.has(name))
    .map(([name, hex]) => [name, `#${hex}`]),
);

// Mapping for ANSI bright colors that are not in tinycolor's standard CSS names
export const INK_NAME_TO_HEX_MAP: Readonly<Record<string, string>> = {
  blackbright: '#555555',
  redbright: '#ff5555',
  greenbright: '#55ff55',
  yellowbright: '#ffff55',
  bluebright: '#5555ff',
  magentabright: '#ff55ff',
  cyanbright: '#55ffff',
  whitebright: '#ffffff',
};

/**
 * Calculates the relative luminance of a color.
 * See https://www.w3.org/TR/WCAG20/#relativeluminancedef
 *
 * @param color Color string (hex or Ink-supported name)
 * @returns Luminance value (0-255)
 */
export function getLuminance(color: string): number {
  const resolved = color.toLowerCase();
  const hex = INK_NAME_TO_HEX_MAP[resolved] || resolved;

  const colorObj = tinycolor(hex);
  if (!colorObj.isValid()) {
    return 0;
  }

  // tinycolor returns 0-1, we need 0-255
  return colorObj.getLuminance() * 255;
}

/**
 * Resolves a CSS color value (name or hex) into an Ink-compatible color string.
 * @param colorValue The raw color string (e.g., 'blue', '#ff0000', 'darkkhaki').
 * @returns An Ink-compatible color string (hex or name), or undefined if not resolvable.
 */
export function resolveColor(colorValue: string): string | undefined {
  const lowerColor = colorValue.toLowerCase();

  // 1. Check if it's already a hex code and valid
  if (lowerColor.startsWith('#')) {
    if (/^#[0-9A-Fa-f]{3}([0-9A-Fa-f]{3})?$/.test(colorValue)) {
      return lowerColor;
    } else {
      return undefined;
    }
  }

  // Handle hex codes without #
  if (/^[0-9A-Fa-f]{3}([0-9A-Fa-f]{3})?$/.test(colorValue)) {
    return `#${lowerColor}`;
  }

  // 2. Check if it's an Ink supported name (lowercase)
  if (INK_SUPPORTED_NAMES.has(lowerColor)) {
    return lowerColor; // Use Ink name directly
  }

  // 3. Check if it's a known CSS name we can map to hex
  // We can't import CSS_NAME_TO_HEX_MAP here due to circular deps,
  // but we can use tinycolor directly for named colors.
  const colorObj = tinycolor(lowerColor);
  if (colorObj.isValid()) {
    return colorObj.toHexString();
  }

  // 4. Could not resolve
  return undefined;
}

export function interpolateColor(
  color1: string,
  color2: string,
  factor: number,
) {
  if (factor <= 0 && color1) {
    return color1;
  }
  if (factor >= 1 && color2) {
    return color2;
  }
  if (!color1 || !color2) {
    return '';
  }
  try {
    const gradient = tinygradient(color1, color2);
    const color = gradient.rgbAt(factor);
    return color.toHexString();
  } catch {
    return color1;
  }
}

export function getThemeTypeFromBackgroundColor(
  backgroundColor: string | undefined,
): 'light' | 'dark' | undefined {
  if (!backgroundColor) {
    return undefined;
  }

  const resolvedColor = resolveColor(backgroundColor);
  if (!resolvedColor) {
    return undefined;
  }

  const luminance = getLuminance(resolvedColor);
  return luminance > 128 ? 'light' : 'dark';
}


export type ThemeType = 'light' | 'dark' | 'ansi' | 'custom';

export interface ColorsTheme {
  type: ThemeType;
  Background: string;
  Foreground: string;
  LightBlue: string;
  AccentBlue: string;
  AccentPurple: string;
  AccentCyan: string;
  AccentGreen: string;
  AccentYellow: string;
  AccentRed: string;
  DiffAdded: string;
  DiffRemoved: string;
  Comment: string;
  Gray: string;
  DarkGray: string;
  InputBackground?: string;
  MessageBackground?: string;
  FocusBackground?: string;
  FocusColor?: string;
  GradientColors?: string[];
}

export const lightTheme: ColorsTheme = {
  type: 'light',
  Background: '#FFFFFF',
  Foreground: '#000000',
  LightBlue: '#005FAF',
  AccentBlue: '#005FAF',
  AccentPurple: '#5F00FF',
  AccentCyan: '#005F87',
  AccentGreen: '#005F00',
  AccentYellow: '#875F00',
  AccentRed: '#AF0000',
  DiffAdded: '#D7FFD7',
  DiffRemoved: '#FFD7D7',
  Comment: '#008700',
  Gray: '#5F5F5F',
  DarkGray: '#5F5F5F',
  InputBackground: '#E4E4E4',
  MessageBackground: '#FAFAFA',
  FocusBackground: '#D7FFD7',
  GradientColors: ['#4796E4', '#847ACE', '#C3677F'],
};

export const darkTheme: ColorsTheme = {
  type: 'dark',
  Background: '#000000',
  Foreground: '#FFFFFF',
  LightBlue: '#AFD7D7',
  AccentBlue: '#87AFFF',
  AccentPurple: '#D7AFFF',
  AccentCyan: '#87D7D7',
  AccentGreen: '#D7FFD7',
  AccentYellow: '#FFFFAF',
  AccentRed: '#FF87AF',
  DiffAdded: '#005F00',
  DiffRemoved: '#5F0000',
  Comment: '#AFAFAF',
  Gray: '#AFAFAF',
  DarkGray: '#878787',
  InputBackground: '#5F5F5F',
  MessageBackground: '#5F5F5F',
  FocusBackground: '#005F00',
  GradientColors: ['#4796E4', '#847ACE', '#C3677F'],
};

export const ansiTheme: ColorsTheme = {
  type: 'ansi',
  Background: 'black',
  Foreground: '',
  LightBlue: 'blue',
  AccentBlue: 'blue',
  AccentPurple: 'magenta',
  AccentCyan: 'cyan',
  AccentGreen: 'green',
  AccentYellow: 'yellow',
  AccentRed: 'red',
  DiffAdded: 'green',
  DiffRemoved: 'red',
  Comment: 'gray',
  Gray: 'gray',
  DarkGray: 'gray',
  InputBackground: 'black',
  MessageBackground: 'black',
  FocusBackground: 'black',
};

export class Theme {
  /**
   * The default foreground color for text when no specific highlight rule applies.
   * This is an Ink-compatible color string (hex or name).
   */
  readonly defaultColor: string;
  /**
   * Stores the mapping from highlight.js class names (e.g., 'hljs-keyword')
   * to Ink-compatible color strings (hex or name).
   */
  protected readonly _colorMap: Readonly<Record<string, string>>;
  readonly semanticColors: SemanticColors;

  /**
   * Creates a new Theme instance.
   * @param name The name of the theme.
   * @param rawMappings The raw CSSProperties mappings from a react-syntax-highlighter theme object.
   */
  constructor(
    readonly name: string,
    readonly type: ThemeType,
    rawMappings: Record<string, CSSProperties>,
    readonly colors: ColorsTheme,
    semanticColors?: SemanticColors,
  ) {
    this.semanticColors = semanticColors ?? {
      text: {
        primary: this.colors.Foreground,
        secondary: this.colors.Gray,
        link: this.colors.AccentBlue,
        accent: this.colors.AccentPurple,
        response: this.colors.Foreground,
      },
      background: {
        primary: this.colors.Background,
        message:
          this.colors.MessageBackground ??
          interpolateColor(
            this.colors.Background,
            this.colors.Gray,
            DEFAULT_INPUT_BACKGROUND_OPACITY,
          ),
        input:
          this.colors.InputBackground ??
          interpolateColor(
            this.colors.Background,
            this.colors.Gray,
            DEFAULT_INPUT_BACKGROUND_OPACITY,
          ),
        focus:
          this.colors.FocusBackground ??
          interpolateColor(
            this.colors.Background,
            this.colors.FocusColor ?? this.colors.AccentGreen,
            DEFAULT_SELECTION_OPACITY,
          ),
        diff: {
          added: this.colors.DiffAdded,
          removed: this.colors.DiffRemoved,
        },
      },
      border: {
        default: this.colors.DarkGray,
      },
      ui: {
        comment: this.colors.Gray,
        symbol: this.colors.AccentCyan,
        active: this.colors.AccentBlue,
        dark: this.colors.DarkGray,
        focus: this.colors.FocusColor ?? this.colors.AccentGreen,
        gradient: this.colors.GradientColors,
      },
      status: {
        error: this.colors.AccentRed,
        success: this.colors.AccentGreen,
        warning: this.colors.AccentYellow,
      },
    };
    this._colorMap = Object.freeze(this._buildColorMap(rawMappings)); // Build and freeze the map

    // Determine the default foreground color
    const rawDefaultColor = rawMappings['hljs']?.color;
    this.defaultColor =
      (rawDefaultColor ? Theme._resolveColor(rawDefaultColor) : undefined) ??
      ''; // Default to empty string if not found or resolvable
  }

  /**
   * Gets the Ink-compatible color string for a given highlight.js class name.
   * @param hljsClass The highlight.js class name (e.g., 'hljs-keyword', 'hljs-string').
   * @returns The corresponding Ink color string (hex or name) if it exists.
   */
  getInkColor(hljsClass: string): string | undefined {
    return this._colorMap[hljsClass];
  }

  /**
   * Resolves a CSS color value (name or hex) into an Ink-compatible color string.
   * @param colorValue The raw color string (e.g., 'blue', '#ff0000', 'darkkhaki').
   * @returns An Ink-compatible color string (hex or name), or undefined if not resolvable.
   */
  private static _resolveColor(colorValue: string): string | undefined {
    return resolveColor(colorValue);
  }

  /**
   * Builds the internal map from highlight.js class names to Ink-compatible color strings.
   * This method is protected and primarily intended for use by the constructor.
   * @param hljsTheme The raw CSSProperties mappings from a react-syntax-highlighter theme object.
   * @returns An Ink-compatible theme map (Record<string, string>).
   */
  protected _buildColorMap(
    hljsTheme: Record<string, CSSProperties>,
  ): Record<string, string> {
    const inkTheme: Record<string, string> = {};
    for (const key in hljsTheme) {
      // Ensure the key starts with 'hljs-' or is 'hljs' for the base style
      if (!key.startsWith('hljs-') && key !== 'hljs') {
        continue; // Skip keys not related to highlighting classes
      }

      const style = hljsTheme[key];
      if (style?.color) {
        const resolvedColor = Theme._resolveColor(style.color);
        if (resolvedColor !== undefined) {
          // Use the original key from the hljsTheme (e.g., 'hljs-keyword')
          inkTheme[key] = resolvedColor;
        }
        // If color is not resolvable, it's omitted from the map,
        // this enables falling back to the default foreground color.
      }
      // We currently only care about the 'color' property for Ink rendering.
      // Other properties like background, fontStyle, etc., are ignored.
    }
    return inkTheme;
  }
}

