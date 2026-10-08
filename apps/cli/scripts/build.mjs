// Bundles xb into one ESM file (dist/xb.js) with the engine, Ink and React inlined,
// so the npm package has no runtime dependencies. `--compile` then builds single-file
// binaries with Bun for each release target (bun must be on PATH, or use `npx bun`).
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const out = path.join(root, 'dist', 'xb.js')

await build({
  entryPoints: [path.join(root, 'src', 'main.tsx')],
  outfile: out,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  jsx: 'automatic',
  minify: false,
  sourcemap: false,
  legalComments: 'none',
  // Ink connects to React DevTools only when DEV=true; ship a no-op stand-in instead.
  plugins: [
    {
      name: 'no-devtools',
      setup(b) {
        b.onResolve({ filter: /^react-devtools-core$/ }, () => ({ path: 'react-devtools-core', namespace: 'stub' }))
        b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export default { initialize() {}, connectToDevTools() {} }', loader: 'js' }))
      },
    },
  ],
  define: { 'process.env.NODE_ENV': '"production"' },
  banner: {
    js: [
      "import { createRequire as __xbRequire } from 'node:module';",
      'const require = __xbRequire(import.meta.url);',
    ].join('\n'),
  },
  logLevel: 'warning',
})
fs.chmodSync(out, 0o755)
console.log(`built ${path.relative(root, out)} (${(fs.statSync(out).size / 1e6).toFixed(1)} MB)`)

const compile = process.argv.includes('--compile')
if (compile) {
  const targets = (process.argv.find((a) => a.startsWith('--targets='))?.slice(10) ?? 'bun-darwin-arm64,bun-darwin-x64,bun-linux-x64').split(',')
  const bun = process.env.BUN ?? 'bun'
  fs.mkdirSync(path.join(root, 'release'), { recursive: true })
  for (const target of targets) {
    const file = path.join(root, 'release', target.replace(/^bun-/, 'xb-'), 'xb')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    execFileSync(bun, ['build', out, '--compile', `--target=${target}`, '--outfile', file], { stdio: 'inherit' })
    console.log(`compiled ${path.relative(root, file)}`)
  }
}
