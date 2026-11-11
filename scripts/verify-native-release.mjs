import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifySourceRelease } from './verify-source-release.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const target = process.argv[2]
const webDirs = { android: 'android/app/src/main/assets/public', ios: 'ios/App/App/public' }
if (!Object.hasOwn(webDirs, target)) throw new Error('Pass android or ios.')
verifySourceRelease(root)

execFileSync(process.execPath, [join(root, 'scripts/check-store-config.mjs'), target], {
  cwd: root,
  stdio: 'inherit',
})

// Capacitor can add its own bridge files to this directory. Every source asset
// must be present and current before either IDE packages a release.
function checkCopies(relativeDir) {
  for (const entry of readdirSync(join(root, 'www', relativeDir), { withFileTypes: true })) {
    const relative = join(relativeDir, entry.name)
    if (entry.isDirectory()) {
      checkCopies(relative)
      continue
    }
    const source = readFileSync(join(root, 'www', relative))
    const copy = readFileSync(resolve(root, webDirs[target], relative))
    if (!source.equals(copy)) throw new Error(`Outdated native copy of ${relative}. Run npm run sync.`)
  }
}
checkCopies('')
