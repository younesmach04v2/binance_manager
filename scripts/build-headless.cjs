// Bundles the headless server into a single Node file.
//   node scripts/build-headless.cjs           -> out/headless/binance-manager-server.js   (PC, Raspberry Pi: Node 20+)
//   node scripts/build-headless.cjs --mobile  -> out/mobile/nodejs/index.js + package.json (embedded Node 18 inside the Android app)
const fs = require('fs')
const path = require('path')
const { build } = require('esbuild')
const { version } = require('../package.json')

const mobile = process.argv.includes('--mobile')
const outdir = mobile ? path.join(__dirname, '..', 'out', 'mobile', 'nodejs') : path.join(__dirname, '..', 'out', 'headless')
const outfile = path.join(outdir, mobile ? 'index.js' : 'binance-manager-server.js')

build({
  entryPoints: [path.join(__dirname, '..', 'src', 'main', 'headless.ts')],
  bundle: true,
  platform: 'node',
  target: mobile ? 'node18' : 'node20',
  format: 'cjs',
  outfile,
  // `ws` optional native accelerators (pure-JS fallback exists); `bridge` is provided by nodejs-mobile inside the app.
  external: ['bufferutil', 'utf-8-validate', 'bridge'],
  define: { __APP_VERSION__: JSON.stringify(version) },
  banner: mobile ? undefined : { js: '#!/usr/bin/env node' },
  legalComments: 'none',
  logLevel: 'info'
})
  .then(() => {
    if (mobile) {
      fs.writeFileSync(
        path.join(outdir, 'package.json'),
        JSON.stringify({ name: 'binance-manager-server', version, private: true, main: 'index.js' }, null, 2)
      )
    }
    console.log(`server written to ${path.relative(process.cwd(), outfile)}`)
  })
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
