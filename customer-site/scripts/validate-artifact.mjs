import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const workerPath = resolve(projectRoot, "dist/server/index.js");
const manifestPath = resolve(projectRoot, "dist/.openai/hosting.json");

const [source, manifest] = await Promise.all([
  readFile(workerPath, "utf8"),
  readFile(manifestPath, "utf8"),
]);
JSON.parse(manifest);

// A data URL forces ESM parsing even though the generated output has no package.json.
const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const workerModule = await import(moduleUrl);
assert.equal(
  typeof workerModule.default?.fetch,
  "function",
  `${pathToFileURL(workerPath)} must export default.fetch`,
);

const worker = workerModule.default;
const origin = 'https://ironatlas.insomnia-it.co.uk';
for (const [path, status, type, method = 'GET'] of [
  ['/', 200, 'text/html'], ['/account/', 200, 'text/html'], ['/account/portal.js', 200, 'application/javascript'],
  ['/account/', 200, 'text/html', 'HEAD'], ['/account', 308, null], ['/config.js', 200, 'application/javascript'],
  ['/assets/iron-atlas-icon.png', 200, 'image/png'], ['/privacy/', 200, 'text/html'], ['/terms/', 200, 'text/html'], ['/.openai/hosting.json', 404, 'text/html'],
  ['/account/', 405, null, 'POST'],
]) {
  const result = await worker.fetch(new Request(origin + path, {method}));
  assert.equal(result.status, status, path);
  assert.equal(result.headers.get('cache-control'), 'no-store', path);
  assert.equal(result.headers.get('referrer-policy'), 'no-referrer', path);
  assert.equal(result.headers.get('x-frame-options'), 'DENY', path);
  assert.match(result.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  if (type) assert.ok(result.headers.get('content-type').startsWith(type), path);
  if (status === 308) assert.equal(result.headers.get('location'), origin + '/account/');
  if (method === 'HEAD') assert.equal(await result.text(), '');
  if (type === 'image/png') assert.equal(Buffer.from(await result.arrayBuffer()).subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
}
console.log("Verified the worker, routes, privacy headers, image bytes, redirect, and method restrictions.");
