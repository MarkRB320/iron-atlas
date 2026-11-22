import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { expected, validateInfo, validateProvisioning, assetManifest, validateAssets, matchingBuilds, finishUpload, signingFailure,
  manualSigningInputs, validateManualProfile, distributionIdentityMatches, manualProject, prepareSigningProject, exportSettings, archiveArguments } from '../scripts/mac-appstore-build.mjs';

test('signed iOS metadata must match the target, version, encryption and device SDK', () => {
  const info = { CFBundleIdentifier: expected.bundleId, CFBundleShortVersionString: expected.version, CFBundleVersion: expected.build,
    ITSAppUsesNonExemptEncryption: false, CFBundleSupportedPlatforms: ['iPhoneOS'], DTSDKName: 'iphoneos26.6' };
  validateInfo(info);
  for (const changed of [{ CFBundleVersion: '2' }, { CFBundleIdentifier: 'wrong.bundle' }, { ITSAppUsesNonExemptEncryption: true },
    { DTSDKName: 'iphonesimulator26.6' }, { DTSDKName: 'iphoneos25.0' }, { CFBundleSupportedPlatforms: ['iPhoneSimulator'] }]) {
    assert.throws(() => validateInfo({ ...info, ...changed }));
  }
});

test('App Store export requires a matching current distribution profile and HealthKit', () => {
  const team = 'ABCDE12345', entitlements = { 'com.apple.developer.team-identifier': team,
    'application-identifier': 'OLDPREFIX1.' + expected.bundleId, 'com.apple.developer.healthkit': true, 'get-task-allow': false };
  const profile = { TeamIdentifier: [team], Entitlements: { ...entitlements }, ExpirationDate: '2031-01-01T00:00:00' };
  validateProvisioning(profile, entitlements, team, true, Date.UTC(2030, 0, 1));
  assert.throws(() => validateProvisioning(profile, entitlements, 'OTHER12345', true));
  assert.throws(() => validateProvisioning({ ...profile, ExpirationDate: '2000-01-01T00:00:00' }, entitlements, team, true));
  assert.throws(() => validateProvisioning({ ...profile, ProvisionedDevices: ['synthetic'] }, entitlements, team, true));
  assert.throws(() => validateProvisioning(profile, { ...entitlements, 'get-task-allow': true }, team, true));
  assert.throws(() => validateProvisioning(profile, { ...entitlements, 'com.apple.developer.healthkit': false }, team, true));
});

test('signed web assets must exactly match the post-sync source', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'iron-atlas-signing-test-'));
  try {
    const source = join(temporary, 'source'), target = join(temporary, 'target'); mkdirSync(source); mkdirSync(target);
    writeFileSync(join(source, 'index.html'), 'synthetic fixture'); copyFileSync(join(source, 'index.html'), join(target, 'index.html'));
    const manifest = assetManifest(source); validateAssets(manifest, target);
    writeFileSync(join(target, 'index.html'), 'stale'); assert.throws(() => validateAssets(manifest, target), /differs/);
  } finally { rmSync(temporary, { recursive: true }); }
});

function builds(state, version = expected.version) {
  return { data: state ? [{ id: 'test-build', type: 'builds', attributes: { version: expected.build, processingState: state },
    relationships: { preReleaseVersion: { data: { id: 'release', type: 'preReleaseVersions' } } } }] : [],
  included: [{ id: 'release', type: 'preReleaseVersions', attributes: { version, platform: 'IOS' } }] };
}

test('build lookup distinguishes the marketing version and refuses unverified relationships', async () => {
  assert.equal((await matchingBuilds(async (_method, path) => {
    assert.ok(path.includes('filter%5Bapp%5D=6829905071')); return builds('VALID');
  })).length, 1);
  assert.equal((await matchingBuilds(async () => builds('VALID', '1.1.0'))).length, 0);
  await assert.rejects(matchingBuilds(async () => ({ data: builds('VALID').data })), /marketing version/);
});

test('upload verification retries processing and writes only the exact requested TestFlight locale', async () => {
  const states = [null, 'PROCESSING', 'VALID'], saved = [], mutations = [];
  const localizations = [{ id: 'other-locale', attributes: { locale: 'en-US', whatsNew: 'Keep this' } }];
  const api = async (method, path, body) => {
    if (path.startsWith('/v1/builds?')) return builds(states.shift() || null);
    if (method === 'GET' && path.endsWith('/betaBuildLocalizations')) return { data: localizations };
    if (method === 'POST' && path === '/v1/betaBuildLocalizations') { mutations.push(body); localizations.push({ id: 'new-locale', attributes: body.data.attributes }); return {}; }
    if (path.endsWith('/buildBetaDetail')) return { data: { attributes: { internalBuildState: 'READY_FOR_BETA_TESTING', externalBuildState: 'READY_FOR_BETA_SUBMISSION' } } };
    throw Error('Unexpected API call');
  };
  const receipt = { upload: { status: 'submitted' } };
  await finishUpload(api, receipt, { attempts: 3, sleep: async () => {}, persist: value => saved.push(JSON.parse(JSON.stringify(value))), notes: 'Synthetic test notes' });
  assert.equal(receipt.upload.status, 'verified'); assert.equal(receipt.upload.processingState, 'VALID');
  assert.equal(mutations.length, 1); assert.equal(mutations[0].data.attributes.locale, 'en-GB');
  assert.equal(localizations[0].attributes.whatsNew, 'Keep this'); assert.ok(saved.some(value => value.upload.processingState === 'PROCESSING'));
});

test('failed or pending Apple processing never writes TestFlight notes and remains resumable', async () => {
  for (const state of ['INVALID', 'PROCESSING']) {
    const receipt = { upload: { status: 'submitted' } };
    await assert.rejects(finishUpload(async (method, path) => {
      assert.equal(method, 'GET'); assert.ok(path.startsWith('/v1/builds?')); return builds(state);
    }, receipt, { attempts: 1, persist() {} }), /processing|INVALID/);
    assert.equal(receipt.upload.processingState, state); assert.notEqual(receipt.upload.status, 'verified');
  }
});

test('default TestFlight notes include the new training tools and bundled source sharing', async () => {
  const localizations = [];
  const api = async (method, path, body) => {
    if (path.startsWith('/v1/builds?')) return builds('VALID');
    if (method === 'GET' && path.endsWith('/betaBuildLocalizations')) return { data: localizations };
    if (method === 'POST' && path === '/v1/betaBuildLocalizations') {
      localizations.push({ id: 'synthetic-locale', attributes: body.data.attributes }); return {};
    }
    if (path.endsWith('/buildBetaDetail')) return { data: { attributes: {} } };
    throw Error('Unexpected API call');
  };
  await finishUpload(api, { upload: {} }, { persist() {}, attempts: 1 });
  const notes = localizations[0].attributes.whatsNew;
  for (const feature of ['sign-in and recovery', 'store purchase restoration', 'OpenGym plate calculator',
    'rep-max estimates', 'workout CSV export', 'saving or sharing the bundled source archive']) assert.ok(notes.includes(feature));
});

test('signing failures distinguish missing distribution assets from keychain access and general failures', () => {
  assert.match(signingFailure('No signing certificate "Apple Distribution" found'), /Account Holder or Admin/);
  assert.match(signingFailure('No profiles for uk.co.insomniait.ironatlas were found'), /App Store profiles/);
  assert.match(signingFailure('codesign failed errSecInternalComponent'), /keychain access/);
  assert.equal(signingFailure('CompileSwift failed with a source error'), null);
});

test('manual signing is opt-in and needs an exact certificate plus a profile source', () => {
  assert.equal(manualSigningInputs({}), null);
  assert.throws(() => manualSigningInputs({ ASC_PROFILE_UUID: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa' }));
  const profilePath = join(tmpdir(), 'synthetic.mobileprovision');
  const signing = manualSigningInputs({ ASC_SIGNING_IDENTITY: 'a'.repeat(40), ASC_PROFILE_PATH: profilePath });
  assert.equal(signing.identity, 'A'.repeat(40));
  assert.equal(signing.profilePath, profilePath);
  assert.throws(() => manualSigningInputs({ ASC_SIGNING_IDENTITY: 'Apple Distribution', ASC_PROFILE_PATH: profilePath }));
});

test('manual profile validation binds the exact certificate, UUID, app, team and distribution capabilities', () => {
  const bytes = Buffer.from('synthetic public certificate bytes');
  const identity = createHash('sha1').update(bytes).digest('hex').toUpperCase();
  const team = 'ABCDE12345', profileUuid = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
  const profile = { UUID: profileUuid, Name: 'Synthetic release profile', TeamIdentifier: [team],
    ApplicationIdentifierPrefix: ['OLDPREFIX1'], DeveloperCertificates: [bytes.toString('base64')],
    ExpirationDate: '2031-01-01T00:00:00', Entitlements: { 'com.apple.developer.team-identifier': team,
      'application-identifier': 'OLDPREFIX1.' + expected.bundleId, 'com.apple.developer.healthkit': true, 'get-task-allow': false } };
  const signing = { identity, profileUuid, profileName: profile.Name };
  assert.equal(validateManualProfile(profile, signing, team, Date.UTC(2030, 0, 1)).profileUuid, profileUuid);
  for (const changed of [{ UUID: 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb' }, { Name: 'Another profile' },
    { DeveloperCertificates: [] }, { ApplicationIdentifierPrefix: ['WRONG'] }, { ProvisionedDevices: ['device'] }]) {
    assert.throws(() => validateManualProfile({ ...profile, ...changed }, signing, team, Date.UTC(2030, 0, 1)));
  }
  assert.ok(distributionIdentityMatches(`1) ${identity} "Apple Distribution: Example (${team})"`, team, identity));
  assert.equal(distributionIdentityMatches(`1) ${identity} "Apple Development: Example (${team})"`, team, identity), false);
  assert.equal(distributionIdentityMatches(`1) ${'0'.repeat(40)} "Apple Distribution: Example (${team})"`, team, identity), false);
});

test('manual signing settings touch App Release only and export pins the matching profile', () => {
  const source = readFileSync(new URL('../ios/App/App.xcodeproj/project.pbxproj', import.meta.url), 'utf8');
  const signing = { identity: 'A'.repeat(40), profileUuid: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa' };
  const configured = manualProject(source, signing, 'ABCDE12345');
  assert.equal((configured.match(/CODE_SIGN_STYLE = "Manual";/g) || []).length, 1);
  assert.equal((configured.match(/PROVISIONING_PROFILE_SPECIFIER = /g) || []).length, 1);
  const debug = text => text.match(/504EC3171FED79650016851F \/\* Debug \*\/ = \{[\s\S]*?\n\t\t\};/)[0];
  assert.equal(debug(configured), debug(source));
  assert.throws(() => manualProject(source.replaceAll(expected.bundleId, 'other.app'), signing, 'ABCDE12345'));
  assert.deepEqual(exportSettings('ABCDE12345', null), { method: 'app-store-connect', destination: 'export', teamID: 'ABCDE12345',
    signingStyle: 'automatic', manageAppVersionAndBuildNumber: false, testFlightInternalTestingOnly: false });
  assert.deepEqual(exportSettings('ABCDE12345', signing, 'upload').provisioningProfiles, { [expected.bundleId]: signing.profileUuid });
  assert.equal(exportSettings('ABCDE12345', signing).signingCertificate, signing.identity);
});

test('manual archive signs App Release without overriding automatic Swift-package resource targets', () => {
  const app = readFileSync(new URL('../ios/App/App.xcodeproj/project.pbxproj', import.meta.url), 'utf8');
  const dependency = '\n\t\tAAAAAAAAAAAAAAAAAAAAAAAA /* Release */ = {\n' +
    '\t\t\tisa = XCBuildConfiguration;\n\t\t\tbuildSettings = {\n' +
    '\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = RevenueCat.resources;\n' +
    '\t\t\t\tCODE_SIGN_STYLE = Automatic;\n\t\t\t};\n\t\t};';
  const team = 'ABCDE12345';
  const manual = { identity: 'A'.repeat(40), profileUuid: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa' };
  const configured = manualProject(app + dependency, manual, team);
  assert.ok(configured.endsWith(dependency), 'the dependency keeps its original automatic signing settings');
  assert.equal((configured.match(/CODE_SIGN_IDENTITY = "A{40}";/g) || []).length, 1);
  assert.equal((configured.match(/PROVISIONING_PROFILE_SPECIFIER = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";/g) || []).length, 1);
  assert.equal((configured.match(/DEVELOPMENT_TEAM = "ABCDE12345";/g) || []).length, 1);
  const config = { team, manual, output: join(tmpdir(), 'synthetic-output') };
  const args = archiveArguments(config, join(config.output, 'app.xcarchive'), [], 'synthetic-node');
  assert.equal(args.some(value => /^(?:CODE_SIGN|PROVISIONING_PROFILE|DEVELOPMENT_TEAM)/.test(value)), false,
    'xcodebuild command-line settings would override every dependency target');
  assert.equal(args.at(-1), 'archive');
  const automatic = archiveArguments({ ...config, manual: null }, 'synthetic.xcarchive', []);
  assert.ok(automatic.includes('DEVELOPMENT_TEAM=' + team));
  assert.ok(automatic.includes('CODE_SIGN_STYLE=Automatic'));
});

test('manual archive keeps canonical source unchanged and preserves sibling project paths and schemes', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'iron-atlas-project-copy-'));
  let generated;
  try {
    const project = join(temporary, 'App.xcodeproj');
    const scheme = 'xcshareddata/xcschemes/App.xcscheme';
    mkdirSync(join(project, 'xcshareddata/xcschemes'), { recursive: true });
    const original = readFileSync(new URL('../ios/App/App.xcodeproj/project.pbxproj', import.meta.url));
    writeFileSync(join(project, 'project.pbxproj'), original);
    const schemeSource = '<Scheme><BuildableReference ReferencedContainer="container:App.xcodeproj"/></Scheme>';
    writeFileSync(join(project, scheme), schemeSource);
    const manual = { identity: 'A'.repeat(40), profileUuid: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa' };
    generated = prepareSigningProject(project, manual, 'ABCDE12345');
    assert.deepEqual(readFileSync(join(project, 'project.pbxproj')), original, 'strict corresponding-source hash remains valid during archive');
    assert.equal(dirname(generated.directory), realpathSync(dirname(project)));
    assert.equal(resolve(dirname(generated.directory), 'CapApp-SPM'), resolve(realpathSync(dirname(project)), 'CapApp-SPM'));
    assert.equal(readFileSync(join(generated.directory, scheme), 'utf8'), schemeSource.replace('container:App.xcodeproj', 'container:' + basename(generated.directory)));
    assert.equal(readFileSync(join(project, scheme), 'utf8'), schemeSource);
    assert.match(readFileSync(join(generated.directory, 'project.pbxproj'), 'utf8'), /CODE_SIGN_IDENTITY = "A{40}";/);
    const args = archiveArguments({ archiveProject: generated.directory, manual, output: temporary }, 'synthetic.xcarchive', []);
    assert.equal(args[args.indexOf('-project') + 1], generated.directory);
    const generatedPath = generated.directory;
    generated.cleanup(); generated = null;
    assert.equal(existsSync(generatedPath), false);
    assert.deepEqual(readFileSync(join(project, 'project.pbxproj')), original);
  } finally {
    if (generated) generated.cleanup();
    rmSync(temporary, { recursive: true });
  }
});

test('generated signing project cleans up while reporting unexpected canonical source edits', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'iron-atlas-project-cleanup-'));
  try {
    const project = join(temporary, 'App.xcodeproj'); mkdirSync(project);
    writeFileSync(join(project, 'project.pbxproj'), readFileSync(new URL('../ios/App/App.xcodeproj/project.pbxproj', import.meta.url)));
    const generated = prepareSigningProject(project, { identity: 'A'.repeat(40), profileUuid: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa' }, 'ABCDE12345');
    writeFileSync(join(project, 'project.pbxproj'), 'unexpected edit');
    assert.throws(() => generated.cleanup(), /Canonical source project changed/);
    assert.equal(existsSync(generated.directory), false);
    assert.equal(readFileSync(join(project, 'project.pbxproj'), 'utf8'), 'unexpected edit', 'cleanup never overwrites the canonical project');
  } finally { rmSync(temporary, { recursive: true }); }
});

test('manual signing still rejects a linked project directory after canonicalizing parent aliases', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'iron-atlas-project-link-'));
  try {
    const project = join(temporary, 'App.xcodeproj'), linked = join(temporary, 'Linked.xcodeproj');
    mkdirSync(project);
    symlinkSync(project, linked, 'junction');
    assert.throws(() => prepareSigningProject(linked, {}, 'ABCDE12345'), /Unexpected source project directory/);
  } finally { rmSync(temporary, { recursive: true }); }
});
