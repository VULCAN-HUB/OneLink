const { _electron: electron } = require('@playwright/test');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
async function main() {
  const executable = path.resolve(__dirname, '../../build/win-unpacked/ONE LINK.exe');
  const root = path.resolve(__dirname, '../../work/packaged-test'); await fs.mkdir(root, { recursive: true });
  const profile = await fs.mkdtemp(path.join(root, 'profile-'));
  const application = await electron.launch({ executablePath: executable, env: { ...process.env, ONE_LINK_TEST_PROFILE: profile } });
  try {
    const page = await application.firstWindow();
    await page.getByRole('heading', { name: '기기를 연결하고, 바로 공유하세요.' }).waitFor();
    const state = await page.evaluate(() => window.oneLink.command('state')); assert.equal(state.peers.length, 0);
    await page.locator('[data-nav="settings"]').click(); await page.getByRole('heading', { name: '설정', exact: true }).waitFor();
    const packaged = await application.evaluate(({ app }) => app.isPackaged); assert.equal(packaged, true);
    const content = await fs.readFile(path.join(profile, 'profile/identity.json'), 'utf8'); assert.equal(JSON.parse(content).encrypted, true); assert.equal(content.includes('PRIVATE KEY'), false);
    console.log('PACKAGED PASS: independent executable boots, renderer works, private key stored encrypted by OS.');
  } finally { await application.close(); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
