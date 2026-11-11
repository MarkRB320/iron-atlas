import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { resolve, join, posix } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const hash = data => createHash('sha256').update(data).digest('hex');
const rebuild = 'Run scripts/build-source-release.py, then sync the native project.';
const privateTests = new Set(['tests/mac-transfer.test.cjs', 'tests/mac-signing-assets.test.cjs']);

function dynamicFiles(root) {
  const files = [];
  for (const [folder, pattern] of [['www/licenses', /\.(txt|html|json)$/], ['tests', /\.test\.(cjs|mjs)$/]]) {
    for (const name of readdirSync(join(root, folder))) {
      const relative = `${folder}/${name}`;
      if (pattern.test(name) && !privateTests.has(relative)) files.push(relative);
    }
  }
  const folder = 'android/app/src/main/res';
  for (const entry of readdirSync(join(root, folder), { withFileTypes: true })) {
    if (!/^[a-z][a-z0-9-]*$/.test(entry.name)) continue;
    assert.ok(!entry.isSymbolicLink(), 'Source resource directory must not be a symbolic link.');
    if (entry.isDirectory()) for (const name of readdirSync(join(root, folder, entry.name))) {
      if (/^[a-z0-9_]+\.(xml|png)$/.test(name)) files.push(`${folder}/${entry.name}/${name}`);
    }
  }
  return files.sort();
}

// Python writes deterministic, uncompressed ZIP members without descriptors.
// Verify their actual bytes as well as the external manifest's archive digest.
function verifyMembers(archive, manifest) {
  let offset = 0;
  const found = [];
  while (offset + 4 <= archive.length && archive.readUInt32LE(offset) === 0x04034b50) {
    assert.ok(offset + 30 <= archive.length, 'Truncated source ZIP header.');
    const flags = archive.readUInt16LE(offset + 6), method = archive.readUInt16LE(offset + 8);
    const compressed = archive.readUInt32LE(offset + 18), size = archive.readUInt32LE(offset + 22);
    const nameLength = archive.readUInt16LE(offset + 26), extraLength = archive.readUInt16LE(offset + 28);
    assert.equal(flags & 9, 0, 'Source ZIP must not use encryption or a data descriptor.');
    assert.equal(method, 0, 'Source ZIP must use reproducible uncompressed members.');
    assert.equal(compressed, size, 'Source ZIP size mismatch.');
    const start = offset + 30 + nameLength + extraLength, end = start + size;
    assert.ok(start <= archive.length && end <= archive.length, 'Truncated source ZIP member.');
    const name = archive.subarray(offset + 30, offset + 30 + nameLength).toString('utf8');
    assert.ok(name.startsWith('IronAtlas/'), 'Unexpected source ZIP root.');
    const relative = name.slice('IronAtlas/'.length);
    assert.equal(hash(archive.subarray(start, end)), manifest.files[relative], `Source ZIP differs for ${relative}. ${rebuild}`);
    assert.equal(size, manifest.fileSizes[relative], `Source ZIP size differs for ${relative}.`);
    found.push(relative);
    offset = end;
  }
  assert.ok(offset + 4 <= archive.length && archive.readUInt32LE(offset) === 0x02014b50, 'Source ZIP central directory missing.');
  assert.deepEqual(found, Object.keys(manifest.files), 'Source ZIP contents differ from the manifest.');
}

export function verifySourceRelease(directory = fileURLToPath(new URL('../', import.meta.url))) {
  const root = realpathSync(directory);
  const manifestPath = join(root, 'www/source/manifest.json');
  assert.ok(lstatSync(manifestPath).isFile() && realpathSync(manifestPath) === manifestPath, 'Source manifest path redirects.');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.schemaVersion, 1, 'Unsupported corresponding-source manifest.');
  assert.equal(manifest.archive, 'iron-atlas-source.zip');
  assert.ok(manifest.files && manifest.fileSizes && !Array.isArray(manifest.files), 'Source manifest has no file map.');
  const files = Object.keys(manifest.files);
  assert.deepEqual(files, [...files].sort(), 'Source manifest must use sorted paths.');
  assert.equal(files.length, manifest.fileCount, 'Source manifest count differs.');
  assert.deepEqual(Object.keys(manifest.fileSizes), files, 'Source size manifest differs.');
  for (const required of ['LICENSE', 'NOTICE.md', 'SOURCE.md', 'www/index.html', 'www/config.js',
    'www/opengym/training-tools.js', 'www/opengym/provenance.json', 'scripts/build-source-release.py',
    'scripts/pack-mac.py', 'scripts/verify-source-release.mjs', 'android/app/build.gradle',
    'ios/App/App.xcodeproj/project.pbxproj', 'customer-support-source/worker-handler.mjs']) {
    assert.ok(Object.hasOwn(manifest.files, required), `Required corresponding source missing: ${required}`);
  }
  for (const relative of dynamicFiles(root)) {
    assert.ok(Object.hasOwn(manifest.files, relative), `New corresponding source omitted: ${relative}. ${rebuild}`);
  }
  for (const relative of files) {
    assert.ok(relative && !relative.includes('\\') && !relative.includes(':') && !relative.includes('\0') && posix.normalize(relative) === relative &&
      !relative.startsWith('/') && !relative.startsWith('../') && !relative.includes('/../') &&
      !relative.startsWith('www/source/'), 'Invalid corresponding-source path.');
    assert.match(manifest.files[relative], /^[a-f0-9]{64}$/, 'Invalid source digest.');
    const file = resolve(root, relative);
    assert.ok(lstatSync(file).isFile() && realpathSync(file) === file, `Source path redirects: ${relative}`);
    const content = readFileSync(file);
    assert.equal(content.length, manifest.fileSizes[relative], `Stale source size for ${relative}. ${rebuild}`);
    assert.equal(hash(content), manifest.files[relative], `Stale corresponding source for ${relative}. ${rebuild}`);
  }
  const archivePath = join(root, 'www/source/iron-atlas-source.zip');
  assert.ok(lstatSync(archivePath).isFile() && realpathSync(archivePath) === archivePath, 'Source ZIP path redirects.');
  const archive = readFileSync(archivePath);
  assert.equal(hash(archive), manifest.archiveSha256, `Corresponding-source archive differs. ${rebuild}`);
  verifyMembers(archive, manifest);
  return { files: files.length, sha256: manifest.archiveSha256 };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const result = verifySourceRelease();
  console.log(`${result.files} corresponding-source files and bundled ZIP verified.`);
}
