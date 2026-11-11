'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

test('corresponding-source package is complete, deterministic, non-recursive and rejects stale or unsafe input', () => {
  const candidates = [process.env.IRON_ATLAS_TEST_PYTHON,
    process.platform === 'win32' ? path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe') : null,
    'python3', 'python'].filter(Boolean);
  const python = candidates.find(candidate => spawnSync(candidate, ['--version'], { encoding: 'utf8' }).status === 0);
  assert.ok(python, 'Python 3 is required for source-release tests');
  const code = String.raw`
import io,json,os,pathlib,runpy,shutil,subprocess,sys,tempfile,unittest,zipfile
source=pathlib.Path(sys.argv[1]).resolve()
node=sys.argv[2]
m=runpy.run_path(str(source/'scripts/build-source-release.py'))
pack=runpy.run_path(str(source/'scripts/pack-mac.py'))

class SourceReleaseTests(unittest.TestCase):
 def setUp(self):
  self.temporary=tempfile.TemporaryDirectory(prefix='iron-atlas-source-fixture-')
  self.root=pathlib.Path(self.temporary.name).resolve()
  for groups in (pack['GROUPS'],m['ADDITIONAL_GROUPS']):
   for folder,names in groups.items():
    if folder=='www/source':continue
    for name in names:self.write((pathlib.Path(folder)/name).as_posix(),b'public synthetic fixture\n')
  for relative in ('scripts/pack-mac.py','scripts/build-source-release.py'):
   self.write(relative,(source/relative).read_bytes())
  config=b"supabaseUrl: '',\nsupabaseAnonKey: '',\nrevenuecatAppleKey: '',\nrevenuecatGoogleKey: '',\n"
  self.write('www/config.js',config);self.write('config.template.js',config)
  self.write('www/licenses/extra.html',b'<p>Public dependency notice</p>')
  self.write('tests/new-feature.test.cjs',b'// A new source test\n')
  self.write('android/app/src/main/res/values/strings.xml',b'<resources/>')
  self.write('android/app/src/main/res/mipmap-mdpi/icon.png',b'public synthetic image')
  self.write('scripts/mac-simulator-check.sh',b'#!/bin/bash\nexit 0\n')

 def tearDown(self):self.temporary.cleanup()

 def write(self,relative,data):
  destination=self.root/relative;destination.parent.mkdir(parents=True,exist_ok=True);destination.write_bytes(data)

 def test_allowlist_contains_sources_but_no_credentials_generated_assets_or_unrelated_files(self):
  excluded=['.env','AuthKey_example.p8','Marksman-VPN/private.txt','node_modules/example/index.js',
   'android/local.properties','android/app/build/generated/secret.txt','android/.gradle/cache',
   'android/app/src/main/assets/public/old-app.html','android/capacitor-cordova-android-plugins/build.gradle',
   'www/licenses/private.p8','www/licenses/nested/private.txt','www/source/old-source.zip','tests/output.log',
   'customer-support-source/POLICY-REVIEW.md','docs/store-submission.md','docs/store-public-copy.md',
   'qa/ios-simulator/CAPTURE-NOTE.md','docs/internal-notes/private-review.md',
   'customer-site/.openai/hosting.json',*pack['MACHINE_HELPER_FILES']]
  marker=b'excluded synthetic confidential payload'
  for relative in excluded:self.write(relative,marker)
  result=m['build_release'](self.root)
  archive=(self.root/m['ARCHIVE']).read_bytes()
  self.assertNotIn(marker,archive)
  with zipfile.ZipFile(io.BytesIO(archive)) as z:
   names=z.namelist()
   required=['LICENSE','NOTICE.md','SOURCE.md','www/opengym/training-tools.js','www/opengym/provenance.json',
    'www/licenses/extra.html','tests/new-feature.test.cjs','www/config.js','config.template.js',
    'supabase/functions/coach-access/handler.mjs','customer-support-source/worker-handler.mjs',
    'customer-site/scripts/build.mjs','scripts/build-customer-site.mjs','android/app/build.gradle',
    'android/gradle/wrapper/gradle-wrapper.jar','android/app/src/main/res/values/strings.xml']
   for relative in required:self.assertIn('IronAtlas/'+relative,names)
   for relative in excluded+[m['ARCHIVE'],m['MANIFEST']]:self.assertNotIn('IronAtlas/'+relative,names)
   self.assertEqual(names,sorted(names));self.assertEqual(len(names),len(set(names)))
   self.assertEqual(len(names),result['files'])
   for info in z.infolist():self.assertEqual(info.date_time,(1980,1,1,0,0,0))
  manifest=json.loads((self.root/m['MANIFEST']).read_bytes())
  self.assertEqual(manifest['archiveSha256'],m['digest'](archive))
  self.assertEqual(['IronAtlas/'+item for item in manifest['files']],names)

 def test_deterministic_across_rebuilds_and_mtime_changes(self):
  first=m['build_release'](self.root)
  before=[(self.root/item).read_bytes() for item in (m['ARCHIVE'],m['MANIFEST'])]
  os.utime(self.root/'README.md',(42,42))
  self.assertEqual(m['build_release'](self.root),first)
  self.assertEqual([(self.root/item).read_bytes() for item in (m['ARCHIVE'],m['MANIFEST'])],before)

 def test_source_edit_and_new_notice_invalidate_archive(self):
  m['build_release'](self.root)
  self.write('www/opengym/training-tools.js',b'// changed source\n')
  with self.assertRaisesRegex(SystemExit,'missing or stale'):m['check_release'](self.root)
  m['build_release'](self.root)
  self.write('www/licenses/new.txt',b'new notice')
  with self.assertRaisesRegex(SystemExit,'missing or stale'):m['check_release'](self.root)

 def test_tampered_output_and_missing_outputs_fail_closed(self):
  with self.assertRaisesRegex(SystemExit,'missing or stale'):m['check_release'](self.root)
  m['build_release'](self.root)
  self.write(m['ARCHIVE'],b'tampered zip')
  with self.assertRaisesRegex(SystemExit,'missing or stale'):m['check_release'](self.root)
  m['build_release'](self.root)
  self.write(m['MANIFEST'],b'{}')
  with self.assertRaisesRegex(SystemExit,'missing or stale'):m['check_release'](self.root)

 def test_allowed_text_with_secret_and_non_regular_file_are_rejected(self):
  self.write('README.md',('sb_'+'secret_'+'a'*32).encode())
  with self.assertRaisesRegex(SystemExit,'privileged credential'):m['build_release'](self.root)
  self.write('README.md',b'public')
  item=self.root/'www/licenses/directory.txt';item.mkdir()
  with self.assertRaisesRegex(SystemExit,'regular source file'):m['build_release'](self.root)

 def test_public_config_and_template_are_validated(self):
  self.write('www/config.js',b"supabaseUrl: '',\nsupabaseAnonKey: '',\nrevenuecatAppleKey: 'test_key',\nrevenuecatGoogleKey: '',\n")
  with self.assertRaisesRegex(SystemExit,'Only public'):m['build_release'](self.root)

 def test_node_native_gate_verifies_members_and_detects_source_or_allowlist_changes(self):
  verifier=(source/'scripts/verify-source-release.mjs').as_uri()
  script='import {verifySourceRelease} from '+json.dumps(verifier)+'; verifySourceRelease(process.argv[1]);'
  def node_check():return subprocess.run([node,'--input-type=module','-e',script,str(self.root)],capture_output=True,text=True)
  m['build_release'](self.root)
  initial=node_check();self.assertEqual(initial.returncode,0,initial.stderr)
  self.write('www/opengym/training-tools.js',b'// changed source')
  self.assertNotEqual(node_check().returncode,0)
  m['build_release'](self.root)
  self.write('www/licenses/another.txt',b'a new notice')
  self.assertIn('New corresponding source omitted',node_check().stderr)
  m['build_release'](self.root)
  manifest_path=self.root/m['MANIFEST'];manifest=json.loads(manifest_path.read_bytes())
  self.write('www/opengym/training-tools.js',b'// changed but stale archive')
  data=(self.root/'www/opengym/training-tools.js').read_bytes()
  manifest['files']['www/opengym/training-tools.js']=m['digest'](data)
  manifest['fileSizes']['www/opengym/training-tools.js']=len(data)
  manifest_path.write_text(json.dumps(manifest))
  self.assertIn('Source ZIP differs',node_check().stderr)

unittest.main(argv=['source-release-test'],verbosity=2)
`;
  const result = spawnSync(python, ['-c', code, path.join(__dirname, '..'), process.execPath],
    { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /Ran 7 tests/);
});
