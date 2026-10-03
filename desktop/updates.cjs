const { EventEmitter } = require('node:events');
const { valid, gt } = require('semver');

function validRepository(config) {
  return !!config && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(config.owner || '') && /^[A-Za-z0-9_.-]{1,100}$/.test(config.repo || '') && !['.', '..'].includes(config.repo);
}
function unfinished(snapshot) {
  return [...snapshot.outgoing, ...snapshot.incoming].some(job => !['complete', 'cancelled', 'rejected', 'failed', 'paused'].includes(job.status));
}
class Updates extends EventEmitter {
  constructor({ updater, version, unavailable = '', channel = 'latest', createToken, prepareInstall, recoverInstall }) {
    super(); Object.assign(this, { updater, version, unavailable, createToken, prepareInstall, recoverInstall });
    this.state = { phase: unavailable ? 'unavailable' : 'idle', current: version, next: '', percent: 0, message: unavailable || '버튼을 눌러 새 버전을 확인하세요.' };
    this.operation = null;
    if (!updater) return;
    updater.autoDownload = false; updater.autoInstallOnAppQuit = false;
    updater.allowPrerelease = channel === 'beta'; updater.allowDowngrade = false;
    if (channel === 'beta') updater.channel = 'beta';
    updater.disableWebInstaller = true; updater.disableDifferentialDownload = true;
    updater.on('download-progress', p => { if (this.state.phase === 'downloading') this.set({ percent: Math.max(0, Math.min(100, Number(p.percent) || 0)) }); });
    // Error events are consumed here; check/download promises report their own errors.
    updater.on('error', () => { if (this.state.phase === 'installing') this.installFailed(); });
  }
  snapshot() { return { ...this.state }; }
  set(patch) { Object.assign(this.state, patch); this.emit('change', this.snapshot()); }
  check() {
    if (this.unavailable || this.operation || ['ready', 'installing'].includes(this.state.phase)) return this.snapshot();
    this.set({ phase: 'checking', next: '', percent: 0, message: '새 버전을 확인하고 있습니다…' });
    this.operation = Promise.resolve().then(() => this.updater.checkForUpdates()).then(result => {
      const next = result?.updateInfo?.version;
      if (!valid(next)) throw new Error('Invalid update version');
      if (gt(next, this.version)) this.set({ phase: 'available', next, message: `새 버전 ${next}을 다운로드할 수 있습니다.` });
      else this.set({ phase: 'current', message: '최신 버전을 사용하고 있습니다.' });
    }).catch(() => this.set({ phase: 'error', message: '업데이트를 확인하지 못했습니다. 인터넷 연결을 확인하고 다시 시도하세요. 파일 공유는 계속 사용할 수 있습니다.' })).finally(() => { this.operation = null; });
    return this.snapshot();
  }
  download() {
    if (this.operation || this.state.phase !== 'available') return this.snapshot();
    this.token = this.createToken();
    this.set({ phase: 'downloading', percent: 0, message: '업데이트를 다운로드하고 검증하고 있습니다…' });
    this.operation = Promise.resolve().then(() => this.updater.downloadUpdate(this.token)).then(files => {
      if (this.token.cancelled) { this.set({ phase: 'available', message: '다운로드를 취소했습니다. 다시 다운로드할 수 있습니다.' }); return; }
      if (!files?.length) throw new Error('No installer');
      this.set({ phase: 'ready', percent: 100, message: '업데이트가 준비되었습니다. 재시작하여 적용하세요.' });
    }).catch(() => this.set({ phase: 'available', percent: 0, message: this.token.cancelled ? '다운로드를 취소했습니다.' : '다운로드 또는 파일 검증에 실패했습니다. 다시 다운로드하세요.' })).finally(() => { this.operation = null; this.token = null; });
    return this.snapshot();
  }
  cancel() { if (this.state.phase === 'downloading') this.token?.cancel(); return this.snapshot(); }
  async install() {
    if (this.operation || this.state.phase !== 'ready') return this.snapshot();
    this.set({ phase: 'installing', message: '설치 프로그램을 시작하고 있습니다…' });
    try { await this.prepareInstall(); this.updater.quitAndInstall(false, true); }
    catch (error) { await this.installFailed(error.message); }
    return this.snapshot();
  }
  async installFailed(message) {
    if (this.state.phase !== 'installing') return;
    this.set({ phase: 'ready', message: message || '설치 프로그램을 시작하지 못했습니다. 다시 시도하세요.' });
    await this.recoverInstall();
  }
}
module.exports = { Updates, validRepository, unfinished };
