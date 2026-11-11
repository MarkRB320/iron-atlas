import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { checkConfig } from '../scripts/check-store-config.mjs';

test('retail configuration requires the exact privacy URL accepted by backup consent', () => {
  const context = { window: {} };
  runInNewContext(readFileSync(new URL('../www/account/cloud-backup.js', import.meta.url), 'utf8'), context);
  const privacyUrl = context.window.IronAtlasBackup.privacyUrl;
  const config = {
    supabaseUrl: 'https://synthetic-project.supabase.co',
    supabaseAnonKey: 'sb_publishable_synthetic_public_fixture',
    passwordResetUrl: 'https://ironatlas.insomnia-it.co.uk/account/',
    privacyUrl,
    termsUrl: 'https://ironatlas.insomnia-it.co.uk/terms/',
    revenuecatAppleKey: 'appl_syntheticfixture',
    revenuecatGoogleKey: 'goog_syntheticfixture',
  };
  for (const platform of ['ios', 'android']) {
    assert.deepEqual(checkConfig(config, platform), []);
    for (const replacement of ['', 'https://unrelated-provider.co.uk/privacy/', privacyUrl.slice(0, -1), privacyUrl + '?source=app']) {
      const errors = checkConfig({ ...config, privacyUrl: replacement }, platform);
      assert.ok(errors.some(message => message.startsWith('privacyUrl')), replacement || 'blank URL');
      assert.equal(context.window.IronAtlasBackup.privacyReady(replacement), false);
    }
  }
});

test('signup presents the16+ Terms acknowledgment separately from optional backup', () => {
  const html = readFileSync(new URL('../www/index.html', import.meta.url), 'utf8');
  const from = html.indexOf('    account(d) {'), to = html.indexOf('    measure(d) {', from);
  const config = {};
  const render = runInNewContext('({' + html.slice(from, to) + '}).account', {
    Cloud: { kind: 'device', emailAvailable: () => true }, S: { name: '' }, Native: { CFG: config },
    avatarHtml: () => '', syncLabel: () => '', settingsHtml: () => '', esc: value => value,
    backupChoice: () => '<input type="checkbox" id="signupBackup">', hasOwnData: () => false, persisted: () => ({}), ICON: {},
  });
  const plain = render({ mode: 'signup' });
  assert.match(plain, /confirm you are 16 or over and agree to the Terms of Use/);
  assert.match(plain, /<input type="checkbox" id="signupBackup">/);
  assert.doesNotMatch(plain, /type="submit" disabled/);
  Object.assign(config, { termsUrl: 'https://ironatlas.insomnia-it.co.uk/terms/', privacyUrl: 'https://ironatlas.insomnia-it.co.uk/privacy/' });
  const linked = render({ mode: 'signup' });
  assert.match(linked, /href="https:\/\/ironatlas\.insomnia-it\.co\.uk\/terms\/"/);
  assert.match(linked, /href="https:\/\/ironatlas\.insomnia-it\.co\.uk\/privacy\/"/);
  assert.doesNotMatch(render({ mode: 'signin' }), /confirm you are 16 or over/);
});
