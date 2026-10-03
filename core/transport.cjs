const https = require('node:https');
const tls = require('node:tls');
const { sha, fault, assert, isTailIP } = require('./util.cjs');

async function request(identity, endpoint, route, { method = 'GET', data, binary = false, limit = 4 * 1024 * 1024, timeout = 15000, test = false } = {}) {
  assert(isTailIP(endpoint.host) || (test && endpoint.host === '127.0.0.1'), 'Tailscale 주소만 연결할 수 있습니다.');
  assert(Number.isInteger(endpoint.port) && endpoint.port > 0 && endpoint.port < 65536, '잘못된 연결 포트입니다.');
  const body = data == null ? null : Buffer.isBuffer(data) ? data : Buffer.from(JSON.stringify(data));
  const agent = new https.Agent({ keepAlive: false, maxCachedSessions: 0 });
  agent.createConnection = (options, cb) => {
    const socket = tls.connect({ host: endpoint.host, port: endpoint.port, key: identity.private, cert: identity.cert,
      rejectUnauthorized: false, minVersion: 'TLSv1.3' });
    let done = false;
    const finish = (e) => { if (done) return; done = true; if (e) socket.destroy(); cb(e, e ? undefined : socket); };
    socket.setTimeout(timeout, () => finish(Object.assign(new Error('연결 시간이 초과되었습니다.'), { code: 'ETIMEDOUT' })));
    socket.once('error', finish);
    socket.once('secureConnect', () => {
      const cert = socket.getPeerCertificate();
      if (!cert.raw || (endpoint.id && sha(cert.raw) !== endpoint.id)) return finish(fault('기기 인증 정보가 달라졌습니다. 기존 연결을 해제하고 다시 확인하세요.', 403));
      finish();
    });
  };
  return new Promise((resolve, reject) => {
    const req = https.request({ host: endpoint.host, port: endpoint.port, path: route, method, agent,
      headers: body ? { 'Content-Type': binary ? 'application/octet-stream' : 'application/json', 'Content-Length': body.length } : {} }, res => {
      const fingerprint = sha(res.socket.getPeerCertificate().raw);
      const chunks = []; let length = 0;
      res.on('data', chunk => { length += chunk.length; if (length > limit) res.destroy(fault('응답 크기가 제한을 초과했습니다.')); else chunks.push(chunk); });
      res.on('error', reject);
      res.on('end', () => {
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (res.statusCode >= 400) throw fault(value.error || '상대 기기가 요청을 거부했습니다.', res.statusCode);
          resolve({ ...value, fingerprint });
        } catch (e) { reject(e); }
      });
    });
    req.setTimeout(timeout, () => req.destroy(Object.assign(new Error('응답 시간이 초과되었습니다.'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    req.on('close', () => agent.destroy());
    req.end(body);
  });
}
async function body(req, limit = 2 * 1024 * 1024, binary = false) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; assert(size <= limit, '요청 크기가 너무 큽니다.', 413); chunks.push(chunk); }
  const data = Buffer.concat(chunks);
  if (binary) return data;
  try { return JSON.parse(data.toString('utf8')); } catch { throw fault('요청 형식이 올바르지 않습니다.'); }
}
function reply(res, value, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(value));
}
module.exports = { request, body, reply };
