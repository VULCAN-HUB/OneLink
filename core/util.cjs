const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const CHUNK = 1024 * 1024;
const uuid = () => crypto.randomUUID();
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
function fault(message, status = 400) { return Object.assign(new Error(message), { status }); }
function assert(ok, message, status = 400) { if (!ok) throw fault(message, status); }
function validId(id) { return typeof id === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id); }
function safeRelative(value, allowEmpty = false) {
  assert(typeof value === 'string' && value.length <= 1800, '잘못된 파일 경로입니다.');
  if (allowEmpty && value === '') return [];
  const parts = value.split('/');
  assert(parts.length <= 64 && parts.every(p => p && p !== '.' && p !== '..' && p.length <= 240 &&
    !/[\\<>:"|?*\x00-\x1f]/.test(p) && !/[. ]$/.test(p) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)),
    'Windows와 Mac에서 안전하게 사용할 수 없는 파일 이름입니다.');
  return parts;
}
async function under(root, relative = '') {
  const parts = safeRelative(relative, true);
  assert(!(await fs.lstat(root)).isSymbolicLink(), '공유 폴더가 링크로 변경되었습니다.', 403);
  const realRoot = await fs.realpath(root);
  let current = realRoot;
  for (const part of parts) {
    current = path.join(current, part);
    const st = await fs.lstat(current);
    assert(!st.isSymbolicLink(), '심볼릭 링크는 공유할 수 없습니다.', 403);
  }
  const real = await fs.realpath(current);
  const rel = path.relative(realRoot, real);
  assert(rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel)), '공유 범위를 벗어난 경로입니다.', 403);
  return real;
}
async function atomicJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = file + '.tmp-' + uuid();
  const handle = await fs.open(temp, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value, null, 2)); await handle.sync(); } finally { await handle.close(); }
  await fs.rename(temp, file);
}
async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw fault('저장된 설정을 읽을 수 없습니다. 원본을 보존한 채 복구가 필요합니다.'); }
}
async function hashFile(file) {
  const handle = await fs.open(file, 'r');
  try { const h = crypto.createHash('sha256'); for await (const data of handle.createReadStream({ autoClose: false })) h.update(data); return h.digest('hex'); }
  finally { await handle.close(); }
}
function peerId(socket) { const cert = socket.getPeerCertificate(); return cert?.raw ? sha(cert.raw) : null; }
function isTailIP(host) {
  if (typeof host !== 'string') return false;
  const m = host.match(/^100\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  return !!m && +m[1] >= 64 && +m[1] <= 127 && +m[2] <= 255 && +m[3] <= 255;
}
function displayError(e) {
  if (e.code === 'ENOSPC') return '저장 공간이 부족합니다. 공간을 확보한 뒤 다시 시도하세요.';
  if (['EACCES', 'EPERM'].includes(e.code)) return '파일 또는 폴더에 접근할 권한이 없습니다.';
  if (e.code === 'ENOENT') return '파일이나 폴더를 찾을 수 없습니다. 이동·삭제 여부를 확인하세요.';
  if (['ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE'].includes(e.code)) return '상대 기기의 연결을 기다리고 있습니다. ONE LINK와 Tailscale 실행 상태를 확인하세요.';
  return e.message || '작업을 완료하지 못했습니다.';
}
module.exports = { CHUNK, uuid, sha, assert, fault, validId, safeRelative, under, atomicJson, readJson, hashFile, peerId, isTailIP, displayError };
