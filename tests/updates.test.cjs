const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Updates, validRepository, unfinished } = require('../desktop/updates.cjs');
function fixture(next = '0.2.0') {
  const updater = new EventEmitter(); let installs = 0, checks = 0, downloads = 0, recoveries = 0;
  updater.checkForUpdates = async () => { checks++; return { updateInfo: { version: next } }; };
  updater.downloadUpdate = async () => { downloads++; updater.emit('download-progress', { percent: 45 }); return ['verified-installer.exe']; };
  updater.quitAndInstall = () => { installs++; };
  const service = new Updates({ updater, version: '0.1.2', createToken: () => ({ cancelled: false, cancel() { this.cancelled = true; } }), prepareInstall: async () => {}, recoverInstall: async () => { recoveries++; } });
  return { updater, service, counts: () => ({ installs, checks, downloads, recoveries }) };
}
test('explicit check/download/apply only; duplicate operations coalesce', async () => {
  const { updater, service: s, counts } = fixture();
  assert.equal(updater.autoDownload, false); assert.equal(updater.autoInstallOnAppQuit, false);
  assert.equal(updater.allowDowngrade, false); assert.equal(updater.allowPrerelease, false);
  assert.equal(counts().checks, 0);
  s.check(); s.check(); await s.operation; assert.equal(counts().checks, 1); assert.equal(s.snapshot().phase, 'available');
  await s.install(); assert.equal(counts().installs, 0);
  s.download(); s.download(); await s.operation; assert.equal(counts().downloads, 1); assert.equal(s.snapshot().phase, 'ready');
  s.check(); assert.equal(s.snapshot().phase, 'ready');
  await s.install(); await s.install(); assert.equal(counts().installs, 1);
});
test('same and older versions never offered; invalid release is retryable', async () => {
  for (const next of ['0.1.2', '0.1.1']) { const { service: s } = fixture(next); s.check(); await s.operation; assert.equal(s.snapshot().phase, 'current'); }
  const { service: s } = fixture('<script>'); s.check(); await s.operation; assert.equal(s.snapshot().phase, 'error');
});
test('offline check and failed checksum cannot enable installation; retry succeeds', async () => {
  const { updater, service: s, counts } = fixture();
  updater.checkForUpdates = async () => { throw new Error('offline'); }; s.check(); await s.operation; assert.equal(s.snapshot().phase, 'error');
  updater.checkForUpdates = async () => ({ updateInfo: { version: '0.2.0' } }); s.check(); await s.operation;
  updater.downloadUpdate = async () => { updater.emit('error', new Error('checksum mismatch')); throw new Error('checksum mismatch'); };
  s.download(); await s.operation; await s.install(); assert.equal(counts().installs, 0); assert.equal(s.snapshot().phase, 'available');
  updater.downloadUpdate = async () => ['verified']; s.download(); await s.operation; assert.equal(s.snapshot().phase, 'ready');
});
test('cancelled downloads never become installable even when completion races cancellation', async () => {
  const { service: s } = fixture(); s.check(); await s.operation; s.download(); s.cancel(); await s.operation;
  assert.equal(s.snapshot().phase, 'available');
});
test('active transfers prevent apply and installer errors recover sharing', async () => {
  const { updater, service: s, counts } = fixture(); s.check(); await s.operation; s.download(); await s.operation;
  s.prepareInstall = async () => { throw new Error('전송 중'); }; await s.install(); assert.equal(counts().installs, 0); assert.equal(s.snapshot().phase, 'ready');
  s.prepareInstall = async () => {}; updater.quitAndInstall = () => updater.emit('error', new Error('launch failed')); await s.install();
  assert.equal(s.snapshot().phase, 'ready'); assert.equal(counts().recoveries, 2);
  for (const status of ['sending','receiving','waiting','approval','pending','preparing']) assert.equal(unfinished({ outgoing: [{ status }], incoming: [] }), true);
  assert.equal(unfinished({ outgoing: [{ status: 'paused' }], incoming: [{ status: 'complete' }] }), false);
});
test('unset repository is harmless; configuration rejects URLs and credentials', () => {
  const s = new Updates({ version: '0.1.2', unavailable: '미설정' }); assert.equal(s.check().phase, 'unavailable');
  assert.equal(validRepository({ owner: 'VULCAN-HUB', repo: 'ONE-LINK' }), true);
  for (const c of [{}, { owner:'x',repo:'../x' }, { owner:'https://example.com',repo:'x' }, { owner:'x',repo:'..' }]) assert.equal(validRepository(c), false);
});
test('beta builds explicitly opt into beta while stable builds exclude prereleases', () => {
  const updater = new EventEmitter();
  new Updates({ updater, version: '0.1.3-beta.1', channel: 'beta' });
  assert.equal(updater.channel, 'beta'); assert.equal(updater.allowPrerelease, true);
  assert.equal(updater.allowDowngrade, false);
});
