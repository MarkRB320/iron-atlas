#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash, randomUUID, sign } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync,
  readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const expected = Object.freeze({
  appStoreId: '6829905071', bundleId: 'uk.co.insomniait.ironatlas', version: '1.2.0', build: '1',
});
const root = fileURLToPath(new URL('../', import.meta.url));
const hash = data => createHash('sha256').update(data).digest('hex');
function writeReceipt(path, receipt) {
  const temporary = path + '.' + randomUUID() + '.tmp';
  writeFileSync(temporary, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  renameSync(temporary, path);
}
const contained = (parent, child) => {
  const path = relative(parent, child);
  return !path || (!path.startsWith('..' + sep) && path !== '..' && !isAbsolute(path));
};
const synced = path => /(?:^|[\\/])(?:OneDrive[^\\/]*|Dropbox|Google Drive|GoogleDrive|CloudStorage|Mobile Documents|iCloud Drive)(?:[\\/]|$)/i.test(path);

export function validateInfo(info) {
  assert.equal(info.CFBundleIdentifier, expected.bundleId, 'Unexpected signed bundle identifier');
  assert.equal(info.CFBundleShortVersionString, expected.version, 'Unexpected signed app version');
  assert.equal(String(info.CFBundleVersion), expected.build, 'Unexpected signed build number');
  assert.equal(info.ITSAppUsesNonExemptEncryption, false, 'Archive must declare the reviewed encryption exemption');
  assert.ok(info.CFBundleSupportedPlatforms?.includes('iPhoneOS'), 'Expected a device build');
  assert.ok(Number(/^iphoneos(\d+)/.exec(info.DTSDKName || '')?.[1]) >= 26, 'Expected iOS SDK 26 or newer');
}

export function validateProvisioning(profile, entitlements, team, distribution, now = Date.now()) {
  assert.ok(profile.TeamIdentifier?.includes(team), 'Provisioning profile belongs to another team');
  assert.ok(entitlements['com.apple.developer.team-identifier'] === team, 'Signature belongs to another team');
  const applicationId = entitlements['application-identifier'];
  assert.ok(typeof applicationId === 'string' && applicationId.endsWith('.' + expected.bundleId), 'Unexpected signing application identifier');
  assert.ok(applicationId === profile.Entitlements?.['application-identifier'], 'Signature and provisioning app identifiers differ');
  assert.equal(entitlements['com.apple.developer.healthkit'], true, 'Signed app is missing HealthKit');
  assert.equal(profile.Entitlements?.['com.apple.developer.healthkit'], true, 'Profile is missing HealthKit');
  const expiry = String(profile.ExpirationDate || '');
  assert.ok(Date.parse(/(?:Z|[+-]\d{2}:\d{2})$/.test(expiry) ? expiry : expiry + 'Z') > now, 'Provisioning profile has expired');
  if (distribution) {
    assert.notEqual(entitlements['get-task-allow'], true, 'Export still allows debugger attachment');
    assert.notEqual(profile.Entitlements?.['get-task-allow'], true, 'Export uses a development profile');
    assert.ok(!profile.ProvisionedDevices && !profile.ProvisionsAllDevices, 'Expected App Store distribution provisioning');
  }
}

export function manualSigningInputs(env = process.env) {
  const keys = ['ASC_SIGNING_IDENTITY', 'ASC_PROFILE_PATH', 'ASC_PROFILE_UUID', 'ASC_PROFILE_NAME'];
  if (!keys.some(key => env[key])) return null;
  assert.match(env.ASC_SIGNING_IDENTITY || '', /^[a-f0-9]{40}$/i, 'Set ASC_SIGNING_IDENTITY to the distribution certificate SHA-1 fingerprint');
  assert.ok(isAbsolute(env.ASC_PROFILE_PATH || ''), 'Set ASC_PROFILE_PATH to the absolute installed profile source');
  if (env.ASC_PROFILE_UUID) assert.match(env.ASC_PROFILE_UUID, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i, 'Invalid expected profile UUID');
  return { identity: env.ASC_SIGNING_IDENTITY.toUpperCase(), profilePath: env.ASC_PROFILE_PATH,
    profileUuid: env.ASC_PROFILE_UUID, profileName: env.ASC_PROFILE_NAME };
}

export function validateManualProfile(profile, signing, team, now = Date.now()) {
  validateProvisioning(profile, profile.Entitlements || {}, team, true, now);
  assert.equal(profile.Entitlements?.['get-task-allow'], false, 'Manual profile must disable debugger attachment');
  assert.ok(profile.ApplicationIdentifierPrefix?.some(prefix => profile.Entitlements['application-identifier'] === prefix + '.' + expected.bundleId), 'Unexpected manual profile application prefix');
  assert.match(profile.UUID || '', /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i, 'Profile UUID is missing');
  assert.equal(typeof profile.Name, 'string', 'Profile name is missing');
  if (signing.profileUuid) assert.equal(profile.UUID.toLowerCase(), signing.profileUuid.toLowerCase(), 'A different profile was supplied');
  if (signing.profileName) assert.equal(profile.Name, signing.profileName, 'A different profile name was supplied');
  const fingerprints = (profile.DeveloperCertificates || []).map(value => createHash('sha1').update(Buffer.from(value, 'base64')).digest('hex').toUpperCase());
  assert.ok(fingerprints.includes(signing.identity), 'The profile does not include the selected distribution certificate');
  return { ...signing, profileUuid: profile.UUID, profileName: profile.Name };
}

export function distributionIdentityMatches(output, team, identity) {
  const expression = new RegExp('\\b' + identity + '\\s+"(?:Apple|iPhone) Distribution:[^"\\n]*\\(' + team + '\\)"', 'i');
  return expression.test(output);
}

export function manualProject(source, signing, team) {
  let matched = 0;
  const result = source.replace(/([A-F0-9]{24} \/\* Release \*\/ = \{\r?\n)([\s\S]*?)(\r?\n\t\t\};)/g, (whole, start, body, end) => {
    if (!body.includes('PRODUCT_BUNDLE_IDENTIFIER = ' + expected.bundleId + ';')) return whole;
    assert.match(body, /isa = XCBuildConfiguration;/, 'Unexpected App configuration');
    matched++;
    const settings = { CODE_SIGN_STYLE: 'Manual', DEVELOPMENT_TEAM: team, CODE_SIGN_IDENTITY: signing.identity,
      PROVISIONING_PROFILE_SPECIFIER: signing.profileUuid };
    for (const [key, value] of Object.entries(settings)) {
      const expression = new RegExp('(^[\\t ]*)' + key + ' = [^;]*;', 'gm');
      const occurrences = [...body.matchAll(expression)];
      assert.ok(occurrences.length <= 1, 'Duplicate app signing setting');
      if (occurrences.length) body = body.replace(expression, (_match, indent) => indent + key + ' = ' + JSON.stringify(value) + ';');
      else body = body.replace('buildSettings = {', 'buildSettings = {\n\t\t\t\t' + key + ' = ' + JSON.stringify(value) + ';');
    }
    return start + body + end;
  });
  assert.equal(matched, 1, 'Expected exactly one App Release configuration for manual signing');
  return result;
}

export function prepareSigningProject(projectDirectory, signing, team) {
  const source = realpathSync(projectDirectory);
  assert.ok(source === resolve(projectDirectory) && lstatSync(source).isDirectory(), 'Unexpected source project directory');
  const projectFile = join(source, 'project.pbxproj');
  const original = readFileSync(projectFile);
  const configured = manualProject(original.toString('utf8'), signing, team);
  // Keep the same parent so SOURCE_ROOT, relative source references, local
  // Swift packages and checked-in workspace/scheme paths resolve unchanged.
  // The canonical project stays byte-identical for the archive's source gate.
  const directory = join(dirname(source), 'IronAtlasSigning-' + randomUUID() + '.xcodeproj');
  mkdirSync(directory, { mode: 0o700 });
  function copyDirectory(from, to) {
    for (const entry of readdirSync(from, { withFileTypes: true })) {
      const input = join(from, entry.name), output = join(to, entry.name);
      assert.ok(!entry.isSymbolicLink() && realpathSync(input) === input, 'Project input redirects');
      if (entry.isDirectory()) { mkdirSync(output, { mode: 0o700 }); copyDirectory(input, output); }
      else {
        assert.ok(entry.isFile(), 'Unexpected project input');
        if (entry.name.endsWith('.xcscheme')) {
          const scheme = readFileSync(input, 'utf8').replace(/(ReferencedContainer\s*=\s*)(["'])(.*?)\2/g,
            (whole, prefix, quote, value) => value === 'container:' + basename(source)
              ? prefix + quote + 'container:' + basename(directory) + quote : whole);
          writeFileSync(output, scheme);
        } else copyFileSync(input, output);
      }
    }
  }
  function removeGenerated() {
    assert.ok(dirname(directory) === dirname(source) && /^IronAtlasSigning-[a-f0-9-]+\.xcodeproj$/.test(basename(directory)), 'Unexpected generated project path');
    assert.ok(realpathSync(directory) === directory && !lstatSync(directory).isSymbolicLink(), 'Generated project path redirects');
    rmSync(directory, { recursive: true });
  }
  try {
    copyDirectory(source, directory);
    writeFileSync(join(directory, 'project.pbxproj'), configured);
  } catch (error) { removeGenerated(); throw error; }
  return { directory, original, originalSha256: hash(original), configuredSha256: hash(configured),
    cleanup() {
      try { assert.equal(hash(readFileSync(projectFile)), hash(original), 'Canonical source project changed during archive'); }
      finally { removeGenerated(); }
    } };
}

export function exportSettings(team, manual, destination = 'export') {
  return { method: 'app-store-connect', destination, teamID: team, signingStyle: manual ? 'manual' : 'automatic',
    manageAppVersionAndBuildNumber: false, testFlightInternalTestingOnly: false,
    ...(manual ? { signingCertificate: manual.identity, provisioningProfiles: { [expected.bundleId]: manual.profileUuid } } : {}) };
}

export function archiveArguments(config, archive, auth, nodeBinary = process.execPath) {
  return [
    '-project', config.archiveProject || 'ios/App/App.xcodeproj', '-scheme', 'App', '-configuration', 'Release',
    '-destination', 'generic/platform=iOS', '-archivePath', archive,
    '-derivedDataPath', join(config.output, 'DerivedData'), ...auth,
    // Manual signing is already set on App Release by manualProject(). Global
    // overrides also reach automatically signed Swift-package resource bundles.
    ...(config.manual ? [] : ['DEVELOPMENT_TEAM=' + config.team, 'CODE_SIGN_STYLE=Automatic']),
    'MARKETING_VERSION=' + expected.version, 'CURRENT_PROJECT_VERSION=' + expected.build,
    'GENERATE_INFOPLIST_FILE=YES', 'INFOPLIST_KEY_ITSAppUsesNonExemptEncryption=NO',
    'NODE_BINARY=' + nodeBinary, 'archive',
  ];
}

export function assetManifest(directory) {
  const result = {};
  function visit(folder) {
    for (const entry of readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(folder, entry.name);
      assert.ok(!entry.isSymbolicLink(), 'Web assets must be regular files');
      if (entry.isDirectory()) visit(path);
      else {
        assert.ok(entry.isFile(), 'Unexpected web asset type');
        result[relative(directory, path).split(sep).join('/')] = hash(readFileSync(path));
      }
    }
  }
  visit(directory);
  return result;
}

export function validateAssets(manifest, directory) {
  for (const [name, digest] of Object.entries(manifest)) {
    const path = join(directory, name);
    assert.ok(existsSync(path), 'Signed app is missing web asset ' + name);
    assert.equal(hash(readFileSync(path)), digest, 'Signed web asset differs from source ' + name);
  }
}

export function signingFailure(log) {
  if (/User interaction is not allowed|errSecInteractionNotAllowed|errSecInternalComponent/i.test(log)) {
    return 'codesign could not access the selected signing identity. Check that team’s keychain access on the Mac.';
  }
  if (/No signing certificate[^\n]*(?:Distribution|distribution)|No profiles for|requires a provisioning profile|Failed to create (?:a )?provisioning profile|not permitted[^\n]*(?:certificate|profile)|permission[^\n]*(?:certificate|profile)/i.test(log)) {
    return 'App Store signing assets are unavailable for the selected app/team. A Developer API key can use eligible existing assets. An Account Holder or Admin must create missing distribution certificates or App Store profiles.';
  }
  return null;
}

function hasDistributionIdentity(team) {
  const result = spawnSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' });
  if (result.error || result.status !== 0) throw Error('Could not inspect the Mac signing keychain.');
  const selected = new RegExp('"(?:Apple|iPhone) Distribution:[^"\\n]*\\(' + team + '\\)"');
  return selected.test(result.stdout);
}

function validateSource() {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const capacitor = JSON.parse(readFileSync(join(root, 'capacitor.config.json'), 'utf8'));
  assert.equal(pkg.version, expected.version, 'Source package version changed');
  assert.equal(capacitor.appId, expected.bundleId, 'Source Capacitor bundle changed');
  const project = readFileSync(join(root, 'ios/App/App.xcodeproj/project.pbxproj'), 'utf8');
  for (const [setting, value] of [['MARKETING_VERSION', expected.version], ['CURRENT_PROJECT_VERSION', expected.build], ['PRODUCT_BUNDLE_IDENTIFIER', expected.bundleId]]) {
    const values = [...project.matchAll(new RegExp('\\b' + setting + '\\s*=\\s*([^;]+);', 'g'))].map(match => match[1].trim().replaceAll('"', ''));
    assert.ok(values.length && values.every(item => item === value), 'Unexpected source setting ' + setting);
  }
}

function inputs(outputArgument, existing = false) {
  if (!outputArgument || !isAbsolute(outputArgument)) throw Error('Supply an absolute, new output directory outside the source tree.');
  for (const name of ['ASC_KEY_ID', 'ASC_ISSUER_ID', 'ASC_KEY_PATH', 'ASC_TEAM_ID']) {
    if (!process.env[name]) throw Error(name + ' is required in the environment.');
  }
  if (process.env.ASC_ENCRYPTION_EXEMPT !== 'true') throw Error('Set ASC_ENCRYPTION_EXEMPT=true only after confirming the app uses exempt encryption.');
  if (!/^[A-Z0-9]{10}$/.test(process.env.ASC_KEY_ID) || !/^[A-Z0-9]{10}$/.test(process.env.ASC_TEAM_ID) || !/^[a-f0-9-]{36}$/i.test(process.env.ASC_ISSUER_ID)) {
    throw Error('The App Store Connect or team identifiers have an unexpected format.');
  }
  if (process.env.ASC_APP_ID && process.env.ASC_APP_ID !== expected.appStoreId) throw Error('ASC_APP_ID targets another app.');
  const keyPath = process.env.ASC_KEY_PATH;
  if (!isAbsolute(keyPath)) throw Error('ASC_KEY_PATH must be an absolute regular file.');
  let key, keyStat;
  try {
    keyStat = lstatSync(keyPath); key = realpathSync(keyPath);
  } catch { throw Error('The ASC_KEY_PATH file could not be accessed.'); }
  if (keyStat.isSymbolicLink() || !keyStat.isFile()) throw Error('ASC_KEY_PATH must be an absolute regular file.');
  const output = join(realpathSync(dirname(outputArgument)), basename(outputArgument));
  if (contained(realpathSync(root), key) || contained(realpathSync(root), output) || synced(key) || synced(output)) {
    throw Error('Key and output paths must be outside the repository and cloud-synced folders.');
  }
  const mode = keyStat.mode;
  if ((mode & 0o077) || !(mode & 0o400)) throw Error('The API key needs owner-only read permissions, such as mode 600.');
  if (keyStat.uid !== process.getuid()) throw Error('The API key must belong to the current Mac user.');
  if (existing) {
    if (!existsSync(output) || !statSync(output).isDirectory() || (statSync(output).mode & 0o077)) throw Error('The resume directory must exist with owner-only permissions.');
  } else if (existsSync(output)) throw Error('The output directory already exists. Choose a new directory.');
  const manual = existing ? null : manualSigningInputs();
  if (manual) {
    const profileStat = lstatSync(manual.profilePath), profilePath = realpathSync(manual.profilePath);
    assert.ok(profileStat.isFile() && !profileStat.isSymbolicLink() && profileStat.uid === process.getuid() && !(profileStat.mode & 0o077), 'The manual profile must be an owner-only regular file');
    assert.ok(!contained(realpathSync(root), profilePath) && !synced(profilePath), 'The manual profile must be outside source and synced folders');
    manual.profilePath = profilePath;
  }
  return { key, output, keyId: process.env.ASC_KEY_ID, issuer: process.env.ASC_ISSUER_ID, team: process.env.ASC_TEAM_ID, manual };
}

function appStoreApi(config) {
  return async (method, path, body) => {
    assert.ok(path.startsWith('/v1/') && !path.includes('://'), 'Unexpected App Store Connect API path');
    const now = Math.floor(Date.now() / 1000);
    const encoded = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    const payload = encoded({ alg: 'ES256', kid: config.keyId, typ: 'JWT' }) + '.' + encoded({ iss: config.issuer, iat: now, exp: now + 600, aud: 'appstoreconnect-v1' });
    let signature;
    try { signature = sign('sha256', Buffer.from(payload), { key: readFileSync(config.key), dsaEncoding: 'ieee-p1363' }); }
    catch { throw Error('The App Store Connect private key could not sign the request.'); }
    let response;
    try {
      response = await fetch('https://api.appstoreconnect.apple.com' + path, {
        method, headers: { Authorization: 'Bearer ' + payload + '.' + signature.toString('base64url'), 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(30000),
      });
    } catch { throw Error('The App Store Connect request failed.'); }
    if (!response.ok) throw Object.assign(Error('App Store Connect returned HTTP ' + response.status + '.'), { status: response.status });
    const text = await response.text();
    return text ? JSON.parse(text) : {};
  };
}

async function verifyAppTarget(api) {
  const result = await api('GET', '/v1/apps/' + expected.appStoreId + '?fields[apps]=bundleId,name');
  assert.equal(result.data?.id, expected.appStoreId, 'App Store Connect returned another app');
  assert.equal(result.data?.attributes?.bundleId, expected.bundleId, 'App Store Connect bundle mapping differs');
}

export async function matchingBuilds(api) {
  const query = new URLSearchParams({ 'filter[app]': expected.appStoreId, 'filter[version]': expected.build, include: 'preReleaseVersion', sort: '-uploadedDate', limit: '200' });
  const response = await api('GET', '/v1/builds?' + query);
  assert.ok(Array.isArray(response.data), 'Unexpected App Store Connect build response');
  const versions = new Map((response.included || []).filter(item => item.type === 'preReleaseVersions').map(item => [item.id, item.attributes]));
  return response.data.filter(item => {
    const version = versions.get(item.relationships?.preReleaseVersion?.data?.id);
    assert.ok(version, 'Could not verify the marketing version of an existing build');
    return item.attributes?.version === expected.build && version?.version === expected.version && version.platform === 'IOS';
  });
}

export async function finishUpload(api, receipt, { persist, attempts = 90, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), locale = 'en-GB', notes } = {}) {
  notes ||= 'Test sign-in and recovery, optional cloud backup, two-device workout syncing, progress photos, backup withdrawal and re-enabling, trainer and plan sharing, account deletion, and store purchase restoration. Also test the OpenGym plate calculator, rep-max estimates, workout CSV export, and saving or sharing the bundled source archive.';
  assert.ok(notes.length <= 4000 && locale.length <= 12, 'Invalid TestFlight localization');
  let build;
  for (let attempt = 0; attempt < attempts; attempt++) {
    let matches;
    try { matches = await matchingBuilds(api); }
    catch (error) {
      if (attempt + 1 === attempts || !(error.status === 429 || error.status >= 500)) throw error;
      receipt.upload.processingState = 'API_RETRY'; persist(receipt); await sleep(20000); continue;
    }
    assert.ok(matches.length <= 1, 'Multiple matching App Store builds require review');
    build = matches[0];
    receipt.upload.buildId = build?.id || null;
    receipt.upload.processingState = build?.attributes?.processingState || 'AWAITING_DISCOVERY';
    persist(receipt);
    if (receipt.upload.processingState === 'VALID') break;
    if (['FAILED', 'INVALID'].includes(receipt.upload.processingState)) throw Error('Apple processing returned ' + receipt.upload.processingState + '.');
    if (attempt + 1 < attempts) await sleep(20000);
  }
  if (!build || receipt.upload.processingState !== 'VALID') throw Error('Apple processing is still pending. Use --resume-upload with this output directory.');
  const path = '/v1/builds/' + encodeURIComponent(build.id) + '/betaBuildLocalizations';
  const before = await api('GET', path);
  const existing = before.data?.find(item => item.attributes?.locale === locale);
  if (existing) {
    await api('PATCH', '/v1/betaBuildLocalizations/' + encodeURIComponent(existing.id), { data: { type: 'betaBuildLocalizations', id: existing.id, attributes: { whatsNew: notes } } });
  } else {
    await api('POST', '/v1/betaBuildLocalizations', { data: { type: 'betaBuildLocalizations', attributes: { locale, whatsNew: notes }, relationships: { build: { data: { type: 'builds', id: build.id } } } } });
  }
  const after = await api('GET', path);
  assert.ok(after.data?.some(item => item.attributes?.locale === locale && item.attributes.whatsNew === notes), 'What to Test did not match after saving');
  const detail = await api('GET', '/v1/builds/' + encodeURIComponent(build.id) + '/buildBetaDetail');
  receipt.upload.internalState = detail.data?.attributes?.internalBuildState || 'UNKNOWN';
  receipt.upload.externalState = detail.data?.attributes?.externalBuildState || 'UNKNOWN';
  receipt.upload.locale = locale;
  receipt.upload.whatToTestVerified = true;
  if ([receipt.upload.internalState, receipt.upload.externalState].includes('MISSING_EXPORT_COMPLIANCE')) {
    persist(receipt); throw Error('App Store Connect still requires export-compliance review.');
  }
  receipt.upload.status = 'verified'; receipt.upload.verifiedAt = new Date().toISOString(); persist(receipt);
  return receipt;
}

export async function build(outputArgument, upload = false) {
  if (process.platform !== 'darwin') throw Error('Run this workflow on the designated Mac with Xcode.');
  if (Number(process.versions.node.split('.')[0]) < 22) throw Error('Node 22 or newer is required.');
  process.umask(0o077);
  validateSource();
  const config = inputs(outputArgument);
  mkdirSync(config.output, { mode: 0o700 });
  const logs = join(config.output, 'logs'); mkdirSync(logs, { mode: 0o700 });
  function command(label, executable, args, stdoutPath) {
    const log = join(logs, label + '.log');
    const stdout = openSync(stdoutPath || log, 'wx', 0o600), stderr = stdoutPath ? openSync(log, 'wx', 0o600) : stdout;
    let result;
    try { result = spawnSync(executable, args, { cwd: root, env: process.env, stdio: ['ignore', stdout, stderr] }); }
    finally { closeSync(stdout); if (stderr !== stdout) closeSync(stderr); }
    let safeLog = readFileSync(log, 'utf8');
    for (const value of [config.key, config.keyId, config.issuer, config.team, config.manual?.identity,
      config.manual?.profilePath, config.manual?.profileUuid, config.manual?.profileName].filter(Boolean)) safeLog = safeLog.split(value).join('[redacted]');
    safeLog = safeLog.replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted]');
    writeFileSync(log, safeLog, { mode: 0o600 });
    if (result.error || result.status !== 0) {
      const reason = ['archive', 'export', 'upload'].includes(label) ? signingFailure(safeLog) : null;
      throw Error((reason || label + ' failed.') + ' Inspect its private log in the output directory.');
    }
    return stdoutPath || log;
  }
  function python(label, code, args, input) {
    const result = spawnSync('python3', ['-c', code, ...args], { encoding: 'utf8', input, maxBuffer: 8 * 1024 * 1024 });
    if (result.error || result.status !== 0) throw Error(label + ' failed. Check Python 3 and the generated plist.');
    return result.stdout;
  }
  const readPlist = path => JSON.parse(python('Read plist', 'import base64,datetime,json,plistlib,sys; print(json.dumps(plistlib.load(open(sys.argv[1],"rb")),default=lambda v:v.isoformat() if isinstance(v,datetime.datetime) else base64.b64encode(v).decode() if isinstance(v,bytes) else None))', [path]));
  const writePlist = (path, value) => python('Write plist', 'import json,plistlib,sys; plistlib.dump(json.load(sys.stdin),open(sys.argv[1],"wb"))', [path], JSON.stringify(value));

  console.log('Checking source, commercial configuration and tests.');
  command('xcode-version', 'xcodebuild', ['-version']);
  if (config.manual) {
    const profile = join(config.output, 'manual-profile.plist');
    command('manual-profile', 'security', ['cms', '-D', '-i', config.manual.profilePath], profile);
    config.manual = validateManualProfile(readPlist(profile), config.manual, config.team);
    const installed = join(homedir(), 'Library/Developer/Xcode/UserData/Provisioning Profiles', config.manual.profileUuid + '.mobileprovision');
    assert.ok(existsSync(installed) && hash(readFileSync(installed)) === hash(readFileSync(config.manual.profilePath)), 'Install this exact manual profile before building');
    const identities = spawnSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' });
    assert.ok(identities.status === 0 && distributionIdentityMatches(identities.stdout, config.team, config.manual.identity), 'The selected valid distribution identity is unavailable in the keychain');
  }
  command('store-config', process.execPath, ['scripts/check-store-config.mjs', 'ios']);
  command('npm-ci', 'npm', ['ci']);
  command('tests', 'npm', ['test']);
  command('capacitor-core', 'npm', ['run', 'core']);
  command('capacitor-sync', join(root, 'node_modules/.bin/cap'), ['sync', 'ios']);
  command('native-assets', process.execPath, ['scripts/verify-native-release.mjs', 'ios']);
  const manifest = assetManifest(join(root, 'www'));
  const api = appStoreApi(config);
  await verifyAppTarget(api);
  if (upload && (await matchingBuilds(api)).length) throw Error('This marketing version and build already exist. Resume verification of its existing output directory.');
  const localDistributionIdentity = hasDistributionIdentity(config.team);
  if (!localDistributionIdentity) console.log('No valid local distribution identity matches the selected team. Export requires eligible existing signing assets. Missing distribution certificates or App Store profiles need an Account Holder or Admin.');

  const archive = join(config.output, 'IronAtlas-1.2.0-1.xcarchive');
  const auth = [...(config.manual ? [] : ['-allowProvisioningUpdates']), '-authenticationKeyPath', config.key, '-authenticationKeyID', config.keyId, '-authenticationKeyIssuerID', config.issuer];
  const projectPath = join(root, 'ios/App/App.xcodeproj/project.pbxproj');
  let projectProof, signingProject;
  console.log('Archiving the signed iOS device app.');
  try {
    if (config.manual) {
      signingProject = prepareSigningProject(dirname(projectPath), config.manual, config.team);
      projectProof = { originalSha256: signingProject.originalSha256, configuredSha256: signingProject.configuredSha256 };
      writeFileSync(join(config.output, 'App-project-before-signing.pbxproj'), signingProject.original, { mode: 0o600, flag: 'wx' });
    }
    command('archive', 'xcodebuild', archiveArguments({ ...config, archiveProject: signingProject?.directory }, archive, auth));
  } finally {
    if (signingProject) {
      signingProject.cleanup();
      projectProof.sourceUnchanged = true;
      projectProof.generatedProjectRemoved = true;
    }
  }
  function verifyApplication(app, label, distribution) {
    validateInfo(readPlist(join(app, 'Info.plist')));
    validateAssets(manifest, join(app, 'public'));
    command(label + '-signature', 'codesign', ['--verify', '--deep', '--strict', app]);
    const entitlements = join(config.output, label + '-entitlements.plist');
    command(label + '-entitlements', 'codesign', ['-d', '--entitlements', ':-', app], entitlements);
    const profile = join(config.output, label + '-profile.plist');
    command(label + '-profile', 'security', ['cms', '-D', '-i', join(app, 'embedded.mobileprovision')], profile);
    const decodedProfile = readPlist(profile);
    validateProvisioning(decodedProfile, readPlist(entitlements), config.team, distribution || !!config.manual);
    if (config.manual) validateManualProfile(decodedProfile, config.manual, config.team);
  }
  verifyApplication(join(archive, 'Products/Applications/App.app'), 'archive', false);

  const exportOptions = join(config.output, 'ExportOptions.plist');
  writePlist(exportOptions, exportSettings(config.team, config.manual));
  const exported = join(config.output, 'export');
  console.log('Exporting and inspecting the App Store IPA.');
  command('export', 'xcodebuild', ['-exportArchive', '-archivePath', archive, '-exportPath', exported, '-exportOptionsPlist', exportOptions, ...auth]);
  const candidates = readdirSync(exported).filter(name => name.endsWith('.ipa'));
  assert.equal(candidates.length, 1, 'Expected one exported IPA');
  const ipa = join(exported, candidates[0]), unpacked = join(config.output, 'ipa-inspection');
  command('unpack-ipa', '/usr/bin/ditto', ['-x', '-k', ipa, unpacked]);
  const apps = readdirSync(join(unpacked, 'Payload')).filter(name => name.endsWith('.app'));
  assert.equal(apps.length, 1, 'Expected one exported app');
  verifyApplication(join(unpacked, 'Payload', apps[0]), 'export', true);
  assert.deepEqual(assetManifest(join(root, 'www')), manifest, 'Web source changed during the build');
  const receipt = {
    ...expected, createdAt: new Date().toISOString(), encryptionExempt: true,
    archive: basename(archive), ipa: relative(config.output, ipa), ipaSha256: hash(readFileSync(ipa)),
    sourceAssets: manifest, signingPreflight: { localDistributionIdentity, mode: config.manual ? 'manual' : 'automatic',
      ...(projectProof ? { project: projectProof, profileSha256: hash(readFileSync(config.manual.profilePath)) } : {}) },
    checks: { tests: true, publicConfig: true, appStoreMapping: true, archiveSignature: true, distributionProfile: true, archiveAndExportAssets: true },
  };
  const persist = value => writeReceipt(join(config.output, 'receipt.json'), value);
  persist(receipt);
  console.log('Verified signed export ' + ipa);
  console.log('SHA-256 ' + receipt.ipaSha256);
  console.log('Receipt ' + join(config.output, 'receipt.json'));
  if (upload) {
    if ((await matchingBuilds(api)).length) throw Error('This version/build appeared during the archive. Review it before uploading.');
    writePlist(exportOptions, exportSettings(config.team, config.manual, 'upload'));
    receipt.upload = { status: 'submission-started', startedAt: new Date().toISOString() }; persist(receipt);
    console.log('Uploading the verified archive to App Store Connect.');
    try {
      command('upload', 'xcodebuild', ['-exportArchive', '-archivePath', archive, '-exportPath', join(config.output, 'upload'), '-exportOptionsPlist', exportOptions, ...auth]);
      receipt.upload.status = 'submitted'; persist(receipt);
    } catch (error) {
      receipt.upload.status = 'submission-unknown'; persist(receipt);
      throw Error(error.message + ' Upload status is uncertain. Use --resume-upload to check Apple before resubmitting.');
    }
    await finishUpload(api, receipt, { persist, locale: process.env.ASC_TEST_LOCALE || 'en-GB', notes: process.env.ASC_WHAT_TO_TEST });
    console.log('Apple processing is VALID and TestFlight What to Test is verified.');
  }
  return receipt;
}

export async function resumeUpload(outputArgument) {
  if (process.platform !== 'darwin') throw Error('Resume from the designated Mac and its existing private output directory.');
  const config = inputs(outputArgument, true), path = join(config.output, 'receipt.json');
  const receipt = JSON.parse(readFileSync(path, 'utf8'));
  for (const [field, value] of Object.entries(expected)) assert.equal(receipt[field], value, 'Receipt identifies another build');
  assert.ok(receipt.upload?.startedAt, 'This output has no recorded upload attempt');
  const ipa = resolve(config.output, receipt.ipa);
  assert.ok(contained(config.output, ipa), 'Unexpected IPA path in receipt');
  assert.equal(hash(readFileSync(ipa)), receipt.ipaSha256, 'IPA differs from the verified export');
  const api = appStoreApi(config); await verifyAppTarget(api);
  const persist = value => writeReceipt(path, value);
  await finishUpload(api, receipt, { persist, locale: process.env.ASC_TEST_LOCALE || 'en-GB', notes: process.env.ASC_WHAT_TO_TEST });
  console.log('Apple processing is VALID and TestFlight What to Test is verified.');
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv[2] === '--help') {
    console.log('Usage: node scripts/mac-appstore-build.mjs /absolute/new-private-output-directory [--upload]');
    console.log('Resume Apple processing and metadata verification: use the existing output directory with --resume-upload.');
    console.log('Required environment: ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_PATH, ASC_TEAM_ID, ASC_ENCRYPTION_EXEMPT=true.');
    console.log('Optional manual signing: ASC_SIGNING_IDENTITY (certificate SHA-1), ASC_PROFILE_PATH, with optional ASC_PROFILE_UUID and ASC_PROFILE_NAME guards.');
    console.log('Builds Iron Atlas 1.2.0 (1) and exports a signed IPA for app 6829905071. The output directory must be new and outside the source tree.');
  } else if (process.argv.length < 3 || process.argv.length > 4 || (process.argv[3] && !['--upload', '--resume-upload'].includes(process.argv[3]))) {
    console.error('Supply one output directory and optionally --upload or --resume-upload, or use --help.'); process.exitCode = 2;
  } else (process.argv[3] === '--resume-upload' ? resumeUpload(process.argv[2]) : build(process.argv[2], process.argv[3] === '--upload'))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
