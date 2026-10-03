// Local fixture verifies the real updater downloader and SHA-512 checks. Never executes downloaded bytes.
const { _electron: electron } = require('@playwright/test');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
async function main() {
  const root = await fs.mkdtemp(path.resolve(__dirname, '../../work/updater-'));
  const bytes = crypto.randomBytes(262144), digest = crypto.createHash('sha512').update(bytes).digest('base64');
  let tamper = false, downloads = 0;
  const server = http.createServer((req, res) => {
    console.log('Fixture request:', req.url.split('?')[0]);
    if (req.url.startsWith('/latest.yml')) res.end(`version: 0.1.3\nfiles:\n  - url: fixture.exe\n    sha512: ${digest}\n    size: ${bytes.length}\npath: fixture.exe\nsha512: ${digest}\nreleaseDate: '2026-10-02T00:00:00.000Z'\n`);
    else if (req.url.startsWith('/fixture.exe')) { downloads++; const body = Buffer.from(bytes); if (tamper) body[0] ^= 255; res.setHeader('Content-Length', body.length); res.end(body); }
    else { res.statusCode = 404; res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const application = await electron.launch({ args: [path.resolve(__dirname, 'updater-harness.cjs')], env: { ...process.env, ONE_LINK_TEST_PROFILE: path.join(root, 'profile') } });
  application.process().stdout.on('data', data => process.stdout.write(data));
  try {
    await application.firstWindow();
    console.log('Updater fixture app ready');
    for (const corrupt of [true, false]) {
      tamper = corrupt;
      const config = path.join(root, corrupt ? 'bad.yml' : 'good.yml');
      await fs.writeFile(config, `provider: generic\nurl: ${url}\nupdaterCacheDirName: one-link-test-${path.basename(root)}-${corrupt}\n`);
      const result = await Promise.race([application.evaluate((_electron, config) => global.runUpdateFixture(config), config), new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Updater fixture timed out')), 45000); timer.unref(); })]);
      if (corrupt) assert.match(result.code || result.message, /SHA512|checksum/i);
      else { assert.equal(result.version, '0.1.3'); assert.equal(result.hash, digest); }
    }
    assert.equal(downloads, 2);
    console.log('UPDATER DOWNLOAD PASS: real NSIS updater rejects tampered bytes and downloads/verifies valid release; no installer executed.');
  } finally { await application.close(); await new Promise(resolve => server.close(resolve)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
