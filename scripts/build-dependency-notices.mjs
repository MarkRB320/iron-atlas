import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
const notices = ['Iron Atlas — bundled npm dependency notices\n\nGenerated from package-lock.json and unmodified installed packages.\nThese components retain their own licences. Native dependencies are also identified\nby the Gradle and Swift package source files; review their notices before distribution.'];
let count = 0;
for (const [relative, info] of Object.entries(lock.packages).sort(([a], [b]) => a.localeCompare(b, 'en'))) {
  if (!relative || info.dev) continue;
  if (!relative.startsWith('node_modules/') || relative.includes('..')) throw Error('Invalid dependency path');
  const dir = resolve(root, relative);
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  if (pkg.version !== info.version) throw Error(`Install the lockfile version of ${pkg.name}`);
  const names = readdirSync(dir).filter(name => /^(?:licen[cs]e|copying|notice)(?:\.[a-z0-9]+)?$/i.test(name)).sort();
  // This published type-only package omits its upstream repository licence.
  // Retrieved from RevenueCat/purchases-hybrid-common LICENSE, Git blob
  // 128883bdff3696994faed4fce564ea7a37285e60 on 11 November 2026.
  const supplemental = !names.length && pkg.name === '@revenuecat/purchases-typescript-internal-esm'
    ? readFileSync(join(root, 'www/licenses/revenuecat-hybrid-common.txt'), 'utf8') : '';
  if (!names.length && !supplemental) throw Error(`Missing licence text for ${pkg.name}`);
  notices.push(`\n${'='.repeat(72)}\n${pkg.name} ${info.version}\nLicence: ${info.license || pkg.license}\nSource package: ${info.resolved}\n` + (supplemental || names.map(name => `\n${name}\n${readFileSync(join(dir, name), 'utf8').trim()}\n`).join('')));
  count++;
}
writeFileSync(join(root, 'www/licenses/dependencies.txt'), notices.join('\n') + '\n');
console.log(`Wrote notices for ${count} locked runtime dependencies.`);
