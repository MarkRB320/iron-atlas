import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = join(root, 'dist');
const outputs = { 'server/index.js': 'worker/index.js', '.openai/hosting.json': '.openai/hosting.json' };
mkdirSync(out, { recursive: true });
function check(dir, prefix = '') {
  for (const entry of readdirSync(dir, {withFileTypes: true})) {
    const path = prefix + entry.name;
    if (entry.isDirectory() && Object.keys(outputs).some(key => key.startsWith(path + '/'))) {
      check(join(dir, entry.name), path + '/');
    } else if (!entry.isFile() || !Object.hasOwn(outputs, path)) throw Error('Unexpected file in site build: ' + path);
  }
}
check(out);
for (const [dest, src] of Object.entries(outputs)) {
  mkdirSync(dirname(join(out, dest)), {recursive: true});
  copyFileSync(join(root, src), join(out, dest));
}
