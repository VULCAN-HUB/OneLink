const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const https = require('node:https');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const selfsigned = require('selfsigned');
const { request, body, reply } = require('./transport.cjs');
const { CHUNK, uuid, sha, assert, fault, validId, safeRelative, under, atomicJson, readJson, hashFile, peerId, isTailIP, displayError } = require('./util.cjs');
const tailscale = require('./tailscale.cjs');

class Engine extends EventEmitter {
  constructor({ dir, receiveDir, name, test = false, protect, unprotect }) {
    super(); Object.assign(this, { dir, receiveDir, name, test, protect, unprotect });
    this.stateFile = path.join(dir, 'state.json'); this.pending = []; this.candidates = [];
    this.network = { state: 'Checking', peers: [] }; this.active = new Set(); this.locks = new Set();
    this.write = Promise.resolve(); this.closed = false; this.refreshing = false; this.seen = new Map();
  }
  async init() {
    await fs.mkdir(this.dir, { recursive: true });
    const keyFile = path.join(this.dir, 'identity.json');
    const saved = await readJson(keyFile, null);
    if (saved) {
      this.identity = { cert: saved.cert, private: saved.encrypted ? this.unprotect(saved.private) : saved.private };
    } else {
      const notAfterDate = new Date(); notAfterDate.setFullYear(notAfterDate.getFullYear() + 10);
      const pair = await selfsigned.generate([{ name: 'commonName', value: 'ONE LINK device' }], { keySize: 2048, algorithm: 'sha256', notAfterDate });
      this.identity = { cert: pair.cert, private: pair.private };
      assert(this.test || this.protect, '기기 키를 안전하게 저장할 수 없습니다.');
      await atomicJson(keyFile, { cert: pair.cert, private: this.protect ? this.protect(pair.private) : pair.private, encrypted: !!this.protect });
    }
    this.id = sha(new crypto.X509Certificate(this.identity.cert).raw);
    this.state = await readJson(this.stateFile, { version: 1, settings: { name: this.name || (process.platform === 'darwin' ? 'Mac' : 'Windows PC'), receiveDir: this.receiveDir }, peers: {}, shares: [], outgoing: [], incoming: [], preapproved: {} });
    assert(this.state.version === 1, '설정 버전을 지원하지 않습니다.');
    this.state.preapproved ||= {};
    await fs.mkdir(this.state.settings.receiveDir, { recursive: true });
    for (const job of this.state.outgoing) if (['sending', 'preparing'].includes(job.status)) job.status = 'waiting';
    await this.save();
    return this;
  }
  save() {
    const snapshot = JSON.parse(JSON.stringify(this.state));
    this.write = this.write.catch(() => {}).then(() => atomicJson(this.stateFile, snapshot));
    this.emit('change'); return this.write;
  }
  snapshot() {
    const peers = Object.values(this.state.peers).map(p => ({ ...p, online: Date.now() - (this.seen.get(p.id) || 0) < 20000 }));
    return { name: this.state.settings.name, id: this.id, port: this.port, network: this.network, candidates: this.candidates,
      peers, shares: this.state.shares, pending: this.pending.filter(p => p.expires > Date.now() && p.status === 'pending'),
      outgoing: this.state.outgoing.map(({ files, dirs, ...j }) => ({ ...j, fileCount: files.length })),
      incoming: this.state.incoming.map(({ files, dirs, roots, stage, committed, ...j }) => ({ ...j, fileCount: files.length })), settings: this.state.settings };
  }
  async listen(host, port = 47321) {
    assert(isTailIP(host) || (this.test && host === '127.0.0.1'), 'Tailscale 연결을 먼저 확인하세요.');
    if (this.server) await this.stopServer();
    const server = https.createServer({ key: this.identity.private, cert: this.identity.cert, requestCert: true, rejectUnauthorized: false, minVersion: 'TLSv1.3', maxHeaderSize: 8192 }, (req, res) => {
      this.route(req, res).catch(e => { if (!res.headersSent) reply(res, { error: displayError(e) }, e.status || 500); else res.destroy(); });
    });
    server.requestTimeout = 60000; server.headersTimeout = 10000; server.maxConnections = 32;
    server.on('tlsClientError', () => {});
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
    server.on('error', e => { this.network.message = displayError(e); this.emit('change'); });
    this.server = server; this.host = host; this.port = server.address().port;
  }
  async stopServer() { const s = this.server; this.server = null; if (s) await new Promise(r => { s.closeAllConnections(); s.close(r); }); }
  async close() { this.closed = true; clearInterval(this.timer); await this.stopServer(); while (this.active.size) await new Promise(r => setTimeout(r, 50)); await this.write; }
  async start() {
    await this.refresh();
    this.timer = setInterval(() => { this.refresh().catch(e => { this.network.message = displayError(e); this.emit('change'); }); this.pump(); }, 5000);
    this.pump();
  }
  async refresh() {
    if (this.refreshing || this.test || this.closed) return;
    this.refreshing = true;
    try {
      this.network = await tailscale.status();
      if (this.network.state !== 'Running' || !this.network.host) { await this.stopServer(); this.candidates = []; this.emit('change'); return; }
      if (!this.server || this.host !== this.network.host) {
        try { await this.listen(this.network.host); }
        catch (e) { this.network.message = e.code === 'EADDRINUSE' ? 'ONE LINK 연결 포트가 이미 사용 중입니다. 다른 실행 중인 ONE LINK를 확인하세요.' : displayError(e); this.emit('change'); return; }
      }
      const discovered = [];
      const queue = [...this.network.peers];
      for (const peer of Object.values(this.state.peers)) if (!queue.some(p => p.host === peer.host)) queue.push(peer);
      await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
        while (queue.length && !this.closed) {
          const p = queue.shift();
          try {
            const info = await this.call({ host: p.host, port: 47321 }, '/v1/hello', { timeout: 1800 });
            assert(info.app === 'ONE LINK' && info.version === 1 && info.id === info.fingerprint, '지원하지 않는 앱입니다.');
            discovered.push({ host: p.host, port: 47321, id: info.id, name: info.name, os: info.os, ready: true });
            if (this.state.peers[info.id]) Object.assign(this.state.peers[info.id], { host: p.host, port: 47321, name: info.name });
          } catch { discovered.push({ ...p, ready: false }); }
        }
      }));
      this.candidates = discovered; await this.save(); this.pump();
    } finally { this.refreshing = false; }
  }
  async call(peer, route, opts) {
    const result = await request(this.identity, peer, route, { test: this.test, ...opts });
    this.seen.set(result.fingerprint, Date.now()); return result;
  }
  async connect(endpoint) {
    const hello = await this.call(endpoint, '/v1/hello');
    assert(hello.app === 'ONE LINK' && hello.version === 1 && hello.id === hello.fingerprint && hello.id !== this.id, 'ONE LINK 상대 기기를 확인할 수 없습니다.');
    const target = { host: endpoint.host, port: endpoint.port, id: hello.id, name: hello.name, os: hello.os };
    const result = await this.call(target, '/v1/pair', { method: 'POST', data: { name: this.state.settings.name, os: process.platform, port: this.port } });
    const code = sha(result.requestId + [this.id, target.id].sort().join('')).slice(0, 16).toUpperCase();
    assert(code === result.code, '기기 확인 코드가 일치하지 않습니다.', 403);
    this.pairing = { ...target, requestId: result.requestId, code, expires: result.expires };
    return this.pairing;
  }
  async pollPair() {
    assert(this.pairing, '연결 요청이 없습니다.');
    const p = this.pairing;
    const result = await this.call(p, '/v1/pair/' + p.requestId);
    if (result.status === 'approved') { const { requestId, code, expires, ...peer } = p; this.state.peers[p.id] = { ...peer, autoReceive: false }; await this.save(); }
    return result;
  }
  async approvePair(id, allow) {
    const p = this.pending.find(p => p.requestId === id && p.expires > Date.now() && p.status === 'pending');
    assert(p, '연결 요청이 만료되었습니다.');
    p.status = allow ? 'approved' : 'rejected';
    if (allow) this.state.peers[p.id] = { id: p.id, name: p.name, os: p.os, host: p.host, port: p.port, autoReceive: false };
    await this.save();
  }
  async removePeer(id) {
    delete this.state.peers[id];
    for (const share of this.state.shares) share.peers = share.peers.filter(p => p !== id);
    for (const job of this.state.outgoing) if (job.peerId === id && job.status !== 'complete') job.status = 'cancelled';
    for (const job of this.state.incoming) if (job.peerId === id && job.status !== 'complete') job.status = 'rejected';
    this.pending = this.pending.filter(p => p.id !== id); await this.save();
  }
  async addShare(root, peerIds) {
    assert(Array.isArray(peerIds) && peerIds.every(id => this.state.peers[id]), '허용할 기기를 확인하세요.');
    const st = await fs.lstat(root); assert(st.isDirectory() && !st.isSymbolicLink(), '일반 폴더를 선택하세요.');
    const real = await fs.realpath(root);
    assert(!this.state.shares.some(s => s.root === real), '이미 공유 중인 폴더입니다.');
    const share = { id: uuid(), name: path.basename(real) || '공유 폴더', root: real, peers: peerIds };
    this.state.shares.push(share); await this.save(); return share;
  }
  async removeShare(id) {
    this.state.shares = this.state.shares.filter(s => s.id !== id);
    for (const j of this.state.outgoing) if (j.shareId === id && j.status !== 'complete') j.status = 'cancelled';
    await this.save();
  }
  async browse(peerIdValue, shareId = '', relative = '', offset = 0) {
    const peer = this.state.peers[peerIdValue]; assert(peer, '먼저 기기를 연결하세요.');
    return this.call(peer, shareId ? '/v1/list?' + new URLSearchParams({ share: shareId, path: relative, offset: String(offset) }) : '/v1/shares');
  }
  async pull(peerIdValue, shareId, relative) {
    const peer = this.state.peers[peerIdValue]; assert(peer, '먼저 기기를 연결하세요.');
    safeRelative(relative, true); const id = uuid();
    this.state.preapproved[id] = { peerId: peerIdValue, expires: Date.now() + 10 * 60 * 1000 };
    await this.save();
    await this.call(peer, '/v1/pull', { method: 'POST', data: { id, shareId, path: relative }, timeout: 120000 });
    return id;
  }
  async manifest(paths) {
    assert(Array.isArray(paths) && paths.length > 0 && paths.length <= 1000, '보낼 파일이나 폴더를 선택하세요.');
    const files = [], dirs = [], used = new Set(); let total = 0;
    const walk = async (source, relative) => {
      safeRelative(relative); assert(files.length + dirs.length < 10000, '한 번에 10,000개 이하의 항목을 전송하세요.');
      const st = await fs.lstat(source); assert(!st.isSymbolicLink(), '링크 파일은 전송하지 않습니다. 실제 파일을 선택하세요.');
      if (st.isDirectory()) { dirs.push(relative); for (const entry of await fs.readdir(source)) await walk(path.join(source, entry), relative + '/' + entry); }
      else {
        assert(st.isFile(), '일반 파일과 폴더만 전송할 수 있습니다.');
        const hash = await hashFile(source); const after = await fs.stat(source);
        assert(st.size === after.size && st.mtimeMs === after.mtimeMs, '준비 중 원본이 변경되었습니다. 다시 선택하세요.');
        files.push({ path: relative, source, size: st.size, mtime: st.mtimeMs, hash }); total += st.size;
      }
    };
    for (const source of paths) { const name = path.basename(source); assert(!used.has(name.toLowerCase()), '이름이 같은 최상위 항목은 나누어 보내세요.'); used.add(name.toLowerCase()); await walk(source, name); }
    return { files, dirs, total };
  }
  async enqueue(paths, peerIds, opts = {}) {
    assert(!this.closed, '종료를 준비하고 있습니다. 잠시 후 다시 시도하세요.');
    this.preparing = (this.preparing || 0) + 1;
    try {
    assert(peerIds.length > 0 && peerIds.every(id => this.state.peers[id]), '연결된 수신 기기를 선택하세요.');
    const manifest = await this.manifest(paths);
    const ids = [];
    for (const peerIdValue of peerIds) {
      const id = opts.id || uuid(); assert(!this.state.outgoing.some(j => j.id === id), '이미 요청한 전송입니다.', 409);
      const job = { id, peerId: peerIdValue, peerName: this.state.peers[peerIdValue].name, name: paths.length === 1 ? path.basename(paths[0]) : `${paths.length}개 항목`,
        ...manifest, status: 'waiting', done: 0, created: Date.now(), error: '', attempts: 0, shareId: opts.shareId };
      this.state.outgoing.push(job); ids.push(id);
    }
    await this.save(); this.pump(); return ids;
    } finally { this.preparing--; }
  }
  pump() {
    if (this.closed || !this.server) return;
    for (const job of this.state.outgoing) {
      if (this.active.size >= 2) break;
      if (!['waiting', 'approval', 'sending'].includes(job.status) || this.active.has(job.id) || (job.retryAt || 0) > Date.now()) continue;
      if ([...this.active].some(id => this.state.outgoing.find(j => j.id === id)?.peerId === job.peerId)) continue;
      this.active.add(job.id);
      this.sendJob(job).catch(async e => {
        if (['paused', 'cancelled'].includes(job.status) || this.closed) return;
        job.error = displayError(e); job.attempts++;
        job.status = e.status && e.status < 500 && e.status !== 409 ? 'failed' : 'waiting';
        job.retryAt = Date.now() + Math.min(60000, 2000 * 2 ** Math.min(job.attempts, 5)); await this.save();
      }).finally(() => { this.active.delete(job.id); if (!this.closed) setImmediate(() => this.pump()); });
    }
  }
  ensureActive(job) {
    assert(!this.closed && !['paused', 'cancelled'].includes(job.status), '전송이 일시정지되었습니다.', 409);
    assert(this.state.peers[job.peerId], '기기 연결이 해제되었습니다.', 403);
    if (job.shareId) assert(this.state.shares.some(s => s.id === job.shareId && s.peers.includes(job.peerId)), '폴더 공유 권한이 해제되었습니다.', 403);
  }
  async sendJob(job) {
    this.ensureActive(job); const peer = this.state.peers[job.peerId];
    const result = await this.call(peer, '/v1/offers', { method: 'POST', data: { id: job.id, name: job.name, dirs: job.dirs, files: job.files.map(({ source, mtime, ...f }) => f), total: job.total } });
    this.ensureActive(job);
    if (result.status === 'pending') { job.status = 'approval'; job.retryAt = Date.now() + 3000; await this.save(); return; }
    assert(result.status !== 'rejected', '상대 기기가 전송을 거절했습니다.', 403);
    if (result.status === 'complete') { job.status = 'complete'; job.done = job.total; job.completed = Date.now(); await this.save(); return; }
    job.status = 'sending'; job.error = ''; job.done = 0; await this.save();
    for (let i = 0; i < job.files.length; i++) {
      this.ensureActive(job); const file = job.files[i];
      if (job.shareId) { const share = this.state.shares.find(s => s.id === job.shareId); await under(share.root, path.relative(share.root, file.source).split(path.sep).join('/')); }
      const st = await fs.lstat(file.source);
      assert(st.isFile() && !st.isSymbolicLink() && st.size === file.size && st.mtimeMs === file.mtime, '원본 파일이 변경되었습니다. 새 전송으로 다시 보내세요.', 422);
      let offset = result.offsets?.[i] || 0;
      assert(Number.isSafeInteger(offset) && offset >= 0 && offset <= file.size, '잘못된 이어받기 위치입니다.', 422);
      job.done += offset;
      const handle = await fs.open(file.source, 'r');
      try {
        while (offset < file.size) {
          this.ensureActive(job);
          const size = Math.min(CHUNK, file.size - offset); const buffer = Buffer.alloc(size);
          const { bytesRead } = await handle.read(buffer, 0, size, offset);
          assert(bytesRead === size, '원본 파일이 변경되었습니다.', 422);
          await this.call(peer, `/v1/chunk/${job.id}/${i}?offset=${offset}&hash=${sha(buffer)}`, { method: 'PUT', data: buffer, binary: true });
          offset += size; job.done += size; await this.save();
        }
      } finally { await handle.close(); }
    }
    this.ensureActive(job); await this.call(peer, '/v1/finish/' + job.id, { method: 'POST', timeout: 120000 });
    job.status = 'complete'; job.done = job.total; job.completed = Date.now(); job.error = ''; await this.save(); this.emit('completed', job);
  }
  async control(id, action) {
    const job = this.state.outgoing.find(j => j.id === id); assert(job && job.status !== 'complete', '변경할 전송을 찾지 못했습니다.');
    assert(['pause', 'resume', 'cancel'].includes(action), '잘못된 작업입니다.');
    job.status = action === 'pause' ? 'paused' : action === 'cancel' ? 'cancelled' : 'waiting'; job.retryAt = 0;
    if (action === 'resume') job.error = '';
    await this.save(); if (action === 'cancel') this.call(this.state.peers[job.peerId], '/v1/cancel/' + id, { method: 'POST' }).catch(() => {}); this.pump();
  }
  validateOffer(o) {
    assert(validId(o.id) && typeof o.name === 'string' && o.name.length <= 300 && Array.isArray(o.files) && Array.isArray(o.dirs), '잘못된 전송 정보입니다.');
    assert(o.files.length + o.dirs.length <= 10000 && o.files.length + o.dirs.length > 0, '전송 항목 수가 잘못되었습니다.');
    const seen = new Set(); let total = 0;
    for (const d of o.dirs) { safeRelative(d); assert(!seen.has(d.toLowerCase()), '경로가 중복됩니다.'); seen.add(d.toLowerCase()); }
    for (const f of o.files) {
      safeRelative(f.path); assert(!seen.has(f.path.toLowerCase()), '경로가 중복됩니다.'); seen.add(f.path.toLowerCase());
      assert(Number.isSafeInteger(f.size) && f.size >= 0 && typeof f.hash === 'string' && /^[a-f0-9]{64}$/.test(f.hash), '잘못된 파일 정보입니다.'); total += f.size;
    }
    const filePaths = new Set(o.files.map(f => f.path.toLowerCase()));
    for (const name of seen) { const segments = name.split('/'); segments.pop(); while (segments.length) { assert(!filePaths.has(segments.join('/')), '파일과 폴더 경로가 충돌합니다.'); segments.pop(); } }
    assert(Number.isSafeInteger(total) && total === o.total, '전송 용량이 일치하지 않습니다.');
  }
  async accept(id, allow) {
    const job = this.state.incoming.find(j => j.id === id); assert(job && job.status === 'pending', '수신 요청을 찾지 못했습니다.');
    if (!allow) { job.status = 'rejected'; await this.save(); return; }
    const root = await fs.realpath(this.state.settings.receiveDir);
    const disk = await fs.statfs(root); assert(disk.bavail * disk.bsize >= job.total, '저장 공간이 부족합니다.', 507);
    const partial = path.join(root, '.one-link-partial'); await fs.mkdir(partial, { recursive: true }); await under(root, '.one-link-partial');
    job.receiveDir = root; job.stage = path.join(partial, id); await fs.mkdir(job.stage, { recursive: true }); await under(root, '.one-link-partial/' + id);
    for (let i = 0; i < job.files.length; i++) {
      const name = path.join(job.stage, String(i));
      try { const h = await fs.open(name, 'wx'); await h.close(); }
      catch (e) { if (e.code !== 'EEXIST') throw e; const st = await fs.lstat(name); assert(st.isFile() && !st.isSymbolicLink() && st.size === 0, '기존 임시 파일을 확인해야 합니다.'); }
    }
    job.status = 'receiving'; await this.save();
  }
  async offsets(job) {
    if (!job.stage) return [];
    await under(job.receiveDir, '.one-link-partial/' + job.id);
    const result = [];
    for (let i = 0; i < job.files.length; i++) {
      const file = path.join(job.stage, String(i)); const st = await fs.lstat(file);
      assert(st.isFile() && !st.isSymbolicLink(), '수신 임시 파일을 확인할 수 없습니다.');
      // Only journaled, flushed bytes are acknowledged after a crash.
      const offset = job.offsets?.[i] || 0; assert(st.size >= offset, '수신 임시 파일이 변경되었습니다.', 422);
      if (st.size > offset) await fs.truncate(file, offset); result.push(offset);
    }
    return result;
  }
  async finish(job) {
    const offsets = await this.offsets(job);
    for (let i = 0; i < job.files.length; i++) {
      assert(offsets[i] === job.files[i].size, '아직 받지 못한 파일 데이터가 있습니다.', 409);
      assert(await hashFile(path.join(job.stage, String(i))) === job.files[i].hash, '파일 검증에 실패했습니다. 새 전송이 필요합니다.', 422);
    }
    job.roots ||= {}; job.committed ||= {};
    const roots = new Set([...job.dirs, ...job.files.map(f => f.path)].map(p => p.split('/')[0]));
    for (const root of roots) {
      if (Object.hasOwn(job.roots, root)) continue;
      const directory = job.dirs.includes(root) || [...job.dirs, ...job.files.map(f => f.path)].some(p => p.startsWith(root + '/'));
      let n = 0;
      while (true) {
        const parsed = path.parse(root); const candidate = n ? (directory ? `${root} (${n})` : `${parsed.name} (${n})${parsed.ext}`) : root;
        const target = path.join(job.receiveDir, candidate);
        try { if (directory) await fs.mkdir(target); else { await fs.lstat(target); n++; continue; } }
        catch (e) { if (e.code === 'EEXIST') { n++; continue; } if (!(e.code === 'ENOENT' && !directory)) throw e; }
        Object.defineProperty(job.roots, root, { value: candidate, writable: true, enumerable: true, configurable: true }); await this.save(); break;
      }
    }
    const destination = relative => { const [root, ...rest] = relative.split('/'); return [job.roots[root], ...rest].join('/'); };
    for (const directory of [...job.dirs].sort((a, b) => a.length - b.length)) {
      const rel = destination(directory); await fs.mkdir(path.join(job.receiveDir, ...rel.split('/')), { recursive: true }); await under(job.receiveDir, rel);
    }
    for (let i = 0; i < job.files.length; i++) {
      const file = job.files[i], rel = destination(file.path), target = path.join(job.receiveDir, ...rel.split('/'));
      const parent = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
      await fs.mkdir(path.dirname(target), { recursive: true }); await under(job.receiveDir, parent);
      try { await fs.link(path.join(job.stage, String(i)), target); }
      catch (e) { if (e.code !== 'EEXIST') throw e; await under(job.receiveDir, rel); assert(await hashFile(target) === file.hash, '저장 중 같은 이름의 다른 파일이 생성되었습니다. 기존 파일을 보존했습니다.', 409); }
      job.committed[i] = true; await this.save();
    }
    job.status = 'complete'; job.done = job.total; job.completed = Date.now(); await this.save(); this.emit('completed', job);
    await this.cleanupStage(job).catch(() => {});
  }
  async cleanupStage(job) {
    if (!job.stage) return;
    const stage = await under(job.receiveDir, '.one-link-partial/' + job.id);
    assert(stage === job.stage, '임시 저장 경로가 변경되었습니다.');
    // Only this transfer's numbered temporary files are removed. Never recurse.
    for (let i = 0; i < job.files.length; i++) await fs.unlink(path.join(stage, String(i))).catch(e => { if (e.code !== 'ENOENT') throw e; });
    await fs.rmdir(stage); job.stage = null; await this.save();
  }
  async route(req, res) {
    const url = new URL(req.url, 'https://one-link.invalid'); const route = url.pathname;
    assert(!req.headers.origin, '브라우저에서 직접 접근할 수 없습니다.', 403);
    const id = peerId(req.socket); assert(id, '기기 인증서가 필요합니다.', 401);
    if (req.method === 'GET' && route === '/v1/hello') return reply(res, { app: 'ONE LINK', version: 1, id: this.id, name: this.state.settings.name, os: process.platform });
    if (req.method === 'POST' && route === '/v1/pair') {
      this.pending = this.pending.filter(p => p.expires > Date.now());
      assert(this.pending.length < 20, '연결 요청이 많습니다. 잠시 후 다시 시도하세요.', 429);
      const input = await body(req, 4096);
      assert(typeof input.name === 'string' && input.name.length > 0 && input.name.length <= 80 && Number.isInteger(input.port) && (this.test || input.port === 47321), '잘못된 기기 정보입니다.');
      assert(!this.pending.some(p => p.id === id && p.status === 'pending'), '이미 연결 승인을 기다리고 있습니다.', 409);
      const requestId = uuid(), code = sha(requestId + [id, this.id].sort().join('')).slice(0, 16).toUpperCase();
      const p = { requestId, id, code, name: input.name, os: String(input.os || '').slice(0, 20), host: req.socket.remoteAddress.replace(/^::ffff:/, ''), port: input.port, expires: Date.now() + 120000, status: 'pending' };
      this.pending.push(p); this.emit('change'); return reply(res, { requestId, code, expires: p.expires });
    }
    if (req.method === 'GET' && route.startsWith('/v1/pair/')) {
      const p = this.pending.find(p => p.id === id && p.requestId === route.split('/').pop() && p.expires > Date.now());
      assert(p, '연결 요청이 만료되었습니다.', 404); return reply(res, { status: p.status });
    }
    const peer = this.state.peers[id]; assert(peer, '연결을 승인한 기기만 접근할 수 있습니다.', 403);
    this.seen.set(id, Date.now());
    if (req.method === 'GET' && route === '/v1/shares') return reply(res, { shares: this.state.shares.filter(s => s.peers.includes(id)).map(({ id, name }) => ({ id, name })) });
    if (req.method === 'GET' && route === '/v1/list') {
      const share = this.state.shares.find(s => s.id === url.searchParams.get('share') && s.peers.includes(id)); assert(share, '공유 폴더 접근 권한이 없습니다.', 403);
      const relative = url.searchParams.get('path') || '', root = await under(share.root, relative);
      const st = await fs.stat(root); assert(st.isDirectory(), '폴더가 아닙니다.');
      const offset = Number(url.searchParams.get('offset') || 0); assert(Number.isSafeInteger(offset) && offset >= 0, '잘못된 목록 위치입니다.');
      const entries = (await fs.readdir(root, { withFileTypes: true })).filter(e => !e.isSymbolicLink() && (e.isFile() || e.isDirectory())).sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
      const items = [];
      for (const entry of entries.slice(offset, offset + 200)) { const s = await fs.lstat(path.join(root, entry.name)); items.push({ name: entry.name, directory: entry.isDirectory(), size: s.size, modified: s.mtimeMs }); }
      return reply(res, { items, total: entries.length, next: offset + items.length < entries.length ? offset + items.length : null });
    }
    if (req.method === 'POST' && route === '/v1/pull') {
      const input = await body(req, 4096); assert(validId(input.id), '잘못된 전송 ID입니다.');
      const share = this.state.shares.find(s => s.id === input.shareId && s.peers.includes(id)); assert(share, '공유 폴더 접근 권한이 없습니다.', 403);
      const target = await under(share.root, input.path); await this.enqueue([target], [id], { id: input.id, shareId: share.id }); return reply(res, { id: input.id });
    }
    if (req.method === 'POST' && route === '/v1/offers') {
      const input = await body(req); this.validateOffer(input);
      let job = this.state.incoming.find(j => j.id === input.id);
      if (job) assert(job.peerId === id && sha(JSON.stringify({ files: job.files, dirs: job.dirs })) === sha(JSON.stringify({ files: input.files, dirs: input.dirs })), '기존 전송 정보와 다릅니다.', 409);
      else {
        assert(this.state.incoming.filter(j => j.peerId === id && !['complete', 'rejected'].includes(j.status)).length < 100, '대기 중인 수신 작업이 너무 많습니다.', 429);
        job = { id: input.id, name: input.name, files: input.files.map(({ path, size, hash }) => ({ path, size, hash })), dirs: input.dirs, total: input.total, done: 0,
          peerId: id, peerName: peer.name, created: Date.now(), status: 'pending', offsets: [] };
        this.state.incoming.push(job); await this.save();
        const approval = this.state.preapproved[job.id];
        if (peer.autoReceive || (approval?.peerId === id && approval.expires > Date.now())) { await this.accept(job.id, true); delete this.state.preapproved[job.id]; await this.save(); }
      }
      return reply(res, { status: job.status, offsets: job.status === 'receiving' ? await this.offsets(job) : [] });
    }
    const match = route.match(/^\/v1\/(chunk|finish|cancel)\/([a-zA-Z0-9_-]+)(?:\/(\d+))?$/);
    if (match) {
      const [, operation, jobId, fileIndex] = match;
      const job = this.state.incoming.find(j => j.id === jobId && j.peerId === id); assert(job, '전송을 찾을 수 없습니다.', 404);
      assert(!this.locks.has(job.id), '이 전송의 다른 요청을 처리 중입니다.', 409); this.locks.add(job.id);
      try {
        if (operation === 'cancel' && req.method === 'POST') { if (job.status !== 'complete') job.status = 'rejected'; await this.save(); return reply(res, { ok: true }); }
        if (operation === 'finish' && req.method === 'POST') {
          if (job.status !== 'complete') { assert(job.status === 'receiving', '수신 승인이 필요합니다.', 403); await this.finish(job); } return reply(res, { ok: true });
        }
        assert(operation === 'chunk' && req.method === 'PUT' && job.status === 'receiving', '수신할 수 없는 상태입니다.', 403);
        const i = Number(fileIndex), offset = Number(url.searchParams.get('offset')); const file = job.files[i];
        assert(file && Number.isInteger(i) && Number.isSafeInteger(offset) && offset === (job.offsets[i] || 0), '이어받기 위치를 다시 확인해야 합니다.', 409);
        const bytes = await body(req, CHUNK, true); assert(bytes.length > 0 && offset + bytes.length <= file.size && sha(bytes) === url.searchParams.get('hash'), '전송 데이터 검증에 실패했습니다.', 422);
        await under(job.receiveDir, '.one-link-partial/' + job.id + '/' + i);
        const h = await fs.open(path.join(job.stage, String(i)), 'r+');
        try { await h.write(bytes, 0, bytes.length, offset); await h.sync(); } finally { await h.close(); }
        job.offsets[i] = offset + bytes.length; job.done = job.offsets.reduce((a, b) => a + b, 0); await this.save(); return reply(res, { offset: job.offsets[i] });
      } finally { this.locks.delete(job.id); }
    }
    throw fault('지원하지 않는 요청입니다.', 404);
  }
}
module.exports = { Engine };
