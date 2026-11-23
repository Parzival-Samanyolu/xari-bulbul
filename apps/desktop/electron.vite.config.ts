import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'
import type { Plugin } from 'vite'

// Strict CSP for the packaged app. Dev skips it because Vite's HMR needs inline scripts.
const csp = (): Plugin => ({
  name: 'harness-csp',
  apply: 'build',
  transformIndexHtml: (html) =>
    html.replace(
      '<head>',
      `<head>\n    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; object-src 'none'; base-uri 'none'" />`,
    ),
})

// Which app to build: `xari` (Xarı Bülbül, the default) or `qaqash` (Qaqaş), from `--mode qaqash`
// or XARI_EDITION=qaqash. See src/shared/edition.ts.
const editionFor = (mode: string) => (mode === 'qaqash' || process.env.XARI_EDITION === 'qaqash' ? 'qaqash' : 'xari')

export default defineConfig(({ mode }) => {
  const define = { __EDITION__: JSON.stringify(editionFor(mode)) }
  return {
    main: {
      // Only `dependencies` are externalized; @harness/core and friends are devDependencies and get bundled.
      build: { externalizeDeps: true },
      define,
    },
    preload: {
      build: { externalizeDeps: true },
      define,
    },
    renderer: {
      define,
      root: resolve(__dirname, 'src/renderer'),
      build: { rollupOptions: { input: resolve(__dirname, 'src/renderer/index.html') } },
      plugins: [react(), csp()],
    },
  }
})
