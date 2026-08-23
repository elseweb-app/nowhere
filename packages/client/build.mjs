import { build } from 'esbuild'

await build({
  entryPoints: ['src/index.js'],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2022'],
  outfile: 'dist/index.js',
  sourcemap: true,
  minify: false,
})