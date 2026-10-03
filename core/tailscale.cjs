const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { isTailIP } = require('./util.cjs');
const run = promisify(execFile);
async function status() {
  const candidates = process.platform === 'win32' ? ['C:\\Program Files\\Tailscale\\tailscale.exe', 'tailscale'] :
    ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale', 'tailscale'];
  let last;
  for (const bin of candidates) {
    try {
      const { stdout } = await run(bin, ['status', '--json'], { timeout: 6000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
      const data = JSON.parse(stdout);
      return { state: data.BackendState, host: (data.TailscaleIPs || []).find(isTailIP),
        peers: Object.values(data.Peer || {}).map(p => ({ nodeId: p.ID, name: p.HostName || '기기', os: p.OS,
          online: !!p.Online, host: (p.TailscaleIPs || []).find(isTailIP) })).filter(p => p.host),
        message: data.BackendState === 'Running' ? '' : 'Tailscale 앱에서 연결 상태를 확인하세요.' };
    } catch (e) { last = e; if (e.code !== 'ENOENT') break; }
  }
  return { state: 'Unavailable', peers: [], message: last?.code === 'ENOENT' ? 'Tailscale을 찾지 못했습니다. 기존 Tailscale 앱을 설치·실행하세요.' : 'Tailscale 상태를 확인하지 못했습니다. Tailscale 앱이 연결되어 있는지 확인하세요.' };
}
module.exports = { status };
