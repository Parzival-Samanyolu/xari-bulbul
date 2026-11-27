// Bundles the CLI (and @harness/core with its dependencies) into one file: dist/xari.mjs.
import { chmodSync } from 'node:fs'
import { build } from 'esbuild'

// Ink loads React's devtools bridge when DEV is set; the CLI never uses it, so it's stubbed out.
const noDevtools = {
  name: 'no-react-devtools',
  setup(b) {
    b.onResolve({ filter: /^react-devtools-core$/ }, () => ({ path: 'react-devtools-core', namespace: 'stub' }))
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export default { initialize() {}, connectToDevTools() {} }', loader: 'js' }))
  },
}

await build({
  entryPoints: ['src/bin.ts'],
  jsx: 'automatic',
  plugins: [noDevtools],
  define: { 'process.env.NODE_ENV': '"production"' },
  outfile: 'dist/xari.mjs',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  banner: {
    js: [
      '#!/usr/bin/env node',
      // Bundled CommonJS packages (mailparser, nodemailer…) call require() and use __dirname.
      "import { createRequire as __cr } from 'node:module'; import { fileURLToPath as __fu } from 'node:url'; import { dirname as __dn } from 'node:path';",
      'const require = __cr(import.meta.url); const __filename = __fu(import.meta.url); const __dirname = __dn(__filename);',
    ].join('\n'),
  },
  logLevel: 'info',
})
chmodSync('dist/xari.mjs', 0o755)
