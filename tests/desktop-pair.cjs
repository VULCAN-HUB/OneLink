const { _electron: electron } = require('@playwright/test');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const base = path.resolve(__dirname, '../../work/desktop-pair');
async function waitState(page, check) {
  for (let i = 0; i < 300; i++) { const snapshot = await page.evaluate(() => window.oneLink.command('state')); if (check(snapshot)) return snapshot; await new Promise(r => setTimeout(r, 100)); }
  throw new Error('Desktop state did not reach expected condition');
}
async function main() {
  await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'run-'));
  const apps = [];
  try {
    for (const [name, port] of [['sender', 0], ['receiver', 47321]]) {
      const application = await electron.launch({ args: [path.join(__dirname, 'desktop-harness.cjs')], env: { ...process.env, ONE_LINK_TEST_PROFILE: path.join(root, name), ONE_LINK_HARNESS_PORT: String(port) } });
      apps.push(application);
    }
    const [a, b] = await Promise.all(apps.map(app => app.firstWindow()));
    await a.getByRole('heading', { name: '기기를 연결하고, 바로 공유하세요.' }).waitFor();
    await b.getByRole('heading', { name: '기기를 연결하고, 바로 공유하세요.' }).waitFor();
    await b.evaluate(() => window.oneLink.command('settings', { name: 'Studio Windows' }));
    await a.getByRole('button', { name: '＋ 기기 연결', exact: true }).click();
    await a.locator('#manual-host').fill('127.0.0.1');
    await a.getByRole('button', { name: '연결 확인', exact: true }).click();
    await b.getByRole('button', { name: '확인하기', exact: true }).click();
    await a.locator('.pair-code').waitFor(); await b.locator('.pair-code').waitFor();
    assert.equal(await a.locator('.pair-code').innerText(), await b.locator('.pair-code').innerText());
    await b.getByRole('button', { name: '코드가 같아요 · 연결', exact: true }).click();
    await waitState(a, s => s.peers.length === 1);
    await a.waitForFunction(() => !document.querySelector('#modal').open);
    const content = crypto.randomBytes(2 * 1024 * 1024 + 7), source = path.join(root, '실제 전송.bin'); await fs.writeFile(source, content);
    await a.evaluate(async source => { const s = await window.oneLink.command('state'); await window.oneLink.command('dropped', { paths: [source] }); await window.oneLink.command('send', { paths: [source], peers: [s.peers[0].id] }); }, source);
    await b.locator('#content').getByRole('button', { name: '받기', exact: true }).click();
    await waitState(b, s => s.incoming.some(j => j.status === 'complete'));
    const received = await fs.readFile(path.join(root, 'receiver', 'received', '실제 전송.bin')); assert.deepEqual(received, content);
    const shared = path.join(root, '공유 자료'); await fs.mkdir(shared); await fs.writeFile(path.join(shared, 'readme.txt'), 'shared folder test');
    await apps[1].evaluate(({ dialog }, shared) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [shared] }); }, shared);
    await b.locator('[data-nav="shares"]').click(); await b.getByRole('button', { name: '＋ 폴더 공유' }).click();
    await b.locator('input[name="peer"]').check(); await b.getByRole('button', { name: '폴더 선택', exact: true }).click();
    await a.locator('[data-action="browse"]').click();
    await a.getByRole('button', { name: '폴더 열기', exact: true }).click();
    await a.getByText('readme.txt', { exact: false }).waitFor();
    await a.getByRole('button', { name: '가져오기', exact: true }).click();
    await waitState(a, s => s.incoming.some(j => j.status === 'complete'));
    assert.equal(await fs.readFile(path.join(root, 'sender', 'received', 'readme.txt'), 'utf8'), 'shared folder test');
    await a.locator('[data-nav="devices"]').click();
    await a.evaluate(() => document.querySelector('#toast').classList.add('hidden'));
    await a.screenshot({ path: path.resolve(__dirname, '../../ONE-LINK-connected-preview.png'), fullPage: true });
    console.log('DESKTOP PASS: two independent apps, matching pairing codes, UI approval, actual binary transfer, share authorization, remote folder browse and download.');
  } finally { for (const application of apps.reverse()) await application.close(); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
