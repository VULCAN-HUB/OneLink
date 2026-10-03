const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { Engine } = require('../core/engine.cjs');
const { sha, CHUNK, uuid, safeRelative } = require('../core/util.cjs');
const root = path.resolve(__dirname, '../../work/engine-tests');

async function fixture(t, count = 2) {
  await fs.mkdir(root, { recursive: true });
  const dir = await fs.mkdtemp(path.join(root, 'run-'));
  const nodes = [];
  for (let i = 0; i < count; i++) {
    const e = await new Engine({ dir: path.join(dir, `profile-${i}`), receiveDir: path.join(dir, `received-${i}`), name: `Device ${i}`, test: true }).init();
    await e.listen('127.0.0.1', 0); e.timer = setInterval(() => e.pump(), 60); nodes.push(e);
  }
  t.after(async () => {
    for (const e of nodes) await e.close();
    const resolved = path.resolve(dir); assert.ok(resolved.startsWith(root + path.sep));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  return { dir, nodes, a: nodes[0], b: nodes[1] };
}
async function pair(a, b) {
  const result = await a.connect({ host: '127.0.0.1', port: b.port });
  assert.equal(result.code, b.pending.at(-1).code);
  await b.approvePair(result.requestId, true);
  assert.equal((await a.pollPair()).status, 'approved');
}
async function waitFor(fn, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (fn()) return; await new Promise(r => setTimeout(r, 40)); }
  throw new Error('Timed out waiting for transfer state');
}
async function file(dir, name, content) { const p = path.join(dir, name); await fs.mkdir(path.dirname(p), { recursive: true }); await fs.writeFile(p, content); return p; }

test('TLS identities, first approval and access revocation', async t => {
  const { a, b } = await fixture(t);
  await assert.rejects(a.call({ host: '127.0.0.1', port: b.port }, '/v1/shares'), e => e.status === 403);
  await pair(a, b);
  assert.deepEqual((await a.browse(b.id)).shares, []);
  await assert.rejects(a.call({ id: '0'.repeat(64), host: '127.0.0.1', port: b.port }, '/v1/shares'), /인증 정보/);
  await b.removePeer(a.id);
  await assert.rejects(a.browse(b.id), e => e.status === 403);
});

test('folder transfer preserves Unicode, zero-byte files, empty dirs and existing names', async t => {
  const { a, b, dir } = await fixture(t); await pair(a, b);
  b.state.peers[a.id].autoReceive = true;
  const folder = path.join(dir, '작업 자료');
  await file(folder, '한글.txt', '안녕하세요 ONE LINK'); await file(folder, 'empty.bin', '');
  await fs.mkdir(path.join(folder, '빈 폴더'), { recursive: true });
  await fs.mkdir(path.join(b.receiveDir, '작업 자료')); await file(path.join(b.receiveDir, '작업 자료'), 'keep.txt', 'existing');
  const [id] = await a.enqueue([folder], [b.id]);
  await waitFor(() => a.state.outgoing.find(j => j.id === id)?.status === 'complete');
  assert.equal(await fs.readFile(path.join(b.receiveDir, '작업 자료 (1)', '한글.txt'), 'utf8'), '안녕하세요 ONE LINK');
  assert.equal((await fs.stat(path.join(b.receiveDir, '작업 자료 (1)', 'empty.bin'))).size, 0);
  assert.ok((await fs.stat(path.join(b.receiveDir, '작업 자료 (1)', '빈 폴더'))).isDirectory());
  assert.equal(await fs.readFile(path.join(b.receiveDir, '작업 자료', 'keep.txt'), 'utf8'), 'existing');
});

test('manual receiving approval sends no file content before approval', async t => {
  const { a, b, dir } = await fixture(t); await pair(a, b);
  const source = await file(dir, 'approval.txt', 'requires approval');
  const [id] = await a.enqueue([source], [b.id]);
  await waitFor(() => a.state.outgoing[0].status === 'approval');
  assert.equal(b.state.incoming[0].done, 0); assert.equal(b.state.incoming[0].stage, undefined);
  await b.accept(id, true); a.state.outgoing[0].retryAt = 0; a.pump();
  await waitFor(() => a.state.outgoing[0].status === 'complete');
  assert.equal(await fs.readFile(path.join(b.receiveDir, 'approval.txt'), 'utf8'), 'requires approval');
});

test('receiver restart resumes from flushed offset and verifies the whole file', async t => {
  const { a, b, dir, nodes } = await fixture(t); await pair(a, b); b.state.peers[a.id].autoReceive = true;
  const bytes = crypto.randomBytes(CHUNK * 3 + 111); const source = await file(dir, 'resume.bin', bytes);
  const original = a.call.bind(a); let paused = false;
  a.call = async (...args) => { const result = await original(...args); if (args[1].startsWith('/v1/chunk/') && !paused) { paused = true; await a.control(a.state.outgoing[0].id, 'pause'); } return result; };
  const [id] = await a.enqueue([source], [b.id]);
  await waitFor(() => paused && !a.active.size);
  assert.equal(b.state.incoming[0].offsets[0], CHUNK);
  const port = b.port; await b.close();
  const restarted = await new Engine({ dir: b.dir, receiveDir: b.receiveDir, name: 'Device 1', test: true }).init();
  await restarted.listen('127.0.0.1', port); nodes.push(restarted);
  assert.ok(restarted.state.peers[a.id]);
  a.call = original; await a.control(id, 'resume');
  await waitFor(() => a.state.outgoing[0].status === 'complete');
  assert.equal(sha(await fs.readFile(path.join(b.receiveDir, 'resume.bin'))), sha(bytes));
});

test('shared folders are explicit, read-only and support requested downloads', async t => {
  const { a, b, dir } = await fixture(t); await pair(a, b);
  const shared = path.join(dir, 'Shared'); await file(shared, 'download.txt', 'from a shared folder');
  const share = await b.addShare(shared, []);
  assert.equal((await a.browse(b.id)).shares.length, 0);
  await assert.rejects(a.browse(b.id, share.id), e => e.status === 403);
  share.peers = [a.id]; await b.save();
  assert.equal((await a.browse(b.id, share.id)).items[0].name, 'download.txt');
  await assert.rejects(a.browse(b.id, share.id, '../'), /경로|이름/);
  const id = await a.pull(b.id, share.id, 'download.txt');
  await waitFor(() => a.state.incoming.find(j => j.id === id)?.status === 'complete');
  assert.equal(await fs.readFile(path.join(a.receiveDir, 'download.txt'), 'utf8'), 'from a shared folder');
  await b.removeShare(share.id);
  await assert.rejects(a.browse(b.id, share.id), e => e.status === 403);
});

test('multi-target delivery continues when another target is offline', async t => {
  const { a, b, nodes, dir } = await fixture(t, 3); const c = nodes[2]; await pair(a, b); await pair(a, c);
  b.state.peers[a.id].autoReceive = true; await c.stopServer();
  const source = await file(dir, 'multi.txt', 'multi target'); await a.enqueue([source], [c.id, b.id]);
  await waitFor(() => a.state.outgoing.find(j => j.peerId === b.id)?.status === 'complete');
  assert.equal(a.state.outgoing.find(j => j.peerId === c.id).status, 'waiting');
});

test('invalid paths, colliding manifests and symlinks cannot escape shared roots', async t => {
  const { a, b, dir } = await fixture(t); await pair(a, b);
  for (const name of ['../bad', 'C:/bad', 'a\\b', 'CON.txt', 'file.', '/absolute']) assert.throws(() => safeRelative(name));
  const base = { id: uuid(), name: 'bad', total: 0, dirs: [], files: [{ path: '../bad', size: 0, hash: sha('') }] };
  await assert.rejects(a.call(a.state.peers[b.id], '/v1/offers', { method: 'POST', data: base }), /경로|이름/);
  base.files = [{ path: 'a', size: 0, hash: sha('') }, { path: 'a/b', size: 0, hash: sha('') }];
  await assert.rejects(a.call(a.state.peers[b.id], '/v1/offers', { method: 'POST', data: base }), /충돌/);
  const shared = path.join(dir, 'root'), outside = path.join(dir, 'outside'); await fs.mkdir(shared); await file(outside, 'secret.txt', 'private');
  await fs.symlink(outside, path.join(shared, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  const share = await b.addShare(shared, [a.id]);
  await assert.rejects(a.browse(b.id, share.id, 'escape'), /링크/);
});

test('tampered chunks and false final hashes never become completed files', async t => {
  const { a, b } = await fixture(t); await pair(a, b); b.state.peers[a.id].autoReceive = true;
  const id = uuid(), peer = a.state.peers[b.id];
  await a.call(peer, '/v1/offers', { method: 'POST', data: { id, name: 'bad.txt', total: 3, dirs: [], files: [{ path: 'bad.txt', size: 3, hash: sha('yes') }] } });
  await assert.rejects(a.call(peer, `/v1/chunk/${id}/0?offset=0&hash=${sha('yes')}`, { method: 'PUT', data: Buffer.from('bad'), binary: true }), e => e.status === 422);
  assert.equal(b.state.incoming[0].done, 0);
  await a.call(peer, `/v1/chunk/${id}/0?offset=0&hash=${sha('bad')}`, { method: 'PUT', data: Buffer.from('bad'), binary: true });
  await assert.rejects(a.call(peer, '/v1/finish/' + id, { method: 'POST' }), e => e.status === 422);
  assert.equal(b.state.incoming[0].status, 'receiving');
  await assert.rejects(fs.stat(path.join(b.receiveDir, 'bad.txt')), e => e.code === 'ENOENT');
});

test('mutated source is rejected rather than silently sending a different file', async t => {
  const { a, b, dir } = await fixture(t); await pair(a, b);
  const source = await file(dir, 'source.txt', 'original'); const [id] = await a.enqueue([source], [b.id]);
  await waitFor(() => a.state.outgoing[0].status === 'approval');
  await file(dir, 'source.txt', 'changed longer'); await b.accept(id, true); a.state.outgoing[0].retryAt = 0; a.pump();
  await waitFor(() => a.state.outgoing[0].status === 'failed'); assert.match(a.state.outgoing[0].error, /変更|변경/);
});

test('sender restart restores trust and queue without re-pairing or retransmitting acknowledged bytes', async t => {
  const { a, b, dir, nodes } = await fixture(t); await pair(a, b); b.state.peers[a.id].autoReceive = true;
  const content = crypto.randomBytes(CHUNK * 2 + 29); const source = await file(dir, 'sender-restart.bin', content);
  const original = a.call.bind(a); let stopped = false;
  a.call = async (...args) => { const result = await original(...args); if (args[1].startsWith('/v1/chunk/') && !stopped) { stopped = true; a.closed = true; } return result; };
  await a.enqueue([source], [b.id]); await waitFor(() => stopped && !a.active.size);
  const port = a.port; await a.close();
  const restarted = await new Engine({ dir: a.dir, receiveDir: a.receiveDir, test: true }).init(); nodes.push(restarted);
  await restarted.listen('127.0.0.1', port); restarted.timer = setInterval(() => restarted.pump(), 60);
  assert.equal(restarted.id, a.id); assert.ok(restarted.state.peers[b.id]);
  assert.equal(b.state.incoming[0].offsets[0], CHUNK);
  await waitFor(() => restarted.state.outgoing[0].status === 'complete');
  assert.deepEqual(await fs.readFile(path.join(b.receiveDir, 'sender-restart.bin')), content);
});

test('ordinary file names matching object property names remain safe', async t => {
  const { a, b, dir } = await fixture(t); await pair(a, b); b.state.peers[a.id].autoReceive = true;
  const first = await file(dir, '__proto__/text.txt', 'safe'), second = await file(dir, 'constructor', 'also safe');
  await a.enqueue([path.dirname(first), second], [b.id]);
  await waitFor(() => a.state.outgoing[0].status === 'complete');
  assert.equal(await fs.readFile(path.join(b.receiveDir, '__proto__', 'text.txt'), 'utf8'), 'safe');
  assert.equal(await fs.readFile(path.join(b.receiveDir, 'constructor'), 'utf8'), 'also safe');
  assert.equal({}.polluted, undefined);
});
