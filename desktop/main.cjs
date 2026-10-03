const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, Tray, Menu, nativeImage, Notification } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { Engine } = require('../core/engine.cjs');
const { assert, displayError } = require('../core/util.cjs');
const { Updates, validRepository, unfinished } = require('./updates.cjs');
const updateConfig = require('./update-config.json');
let engine, win, tray, updates, quitting = false, closeNotice = false, installingUpdate = false;
const selectedPaths = new Set();
if (process.env.ONE_LINK_TEST_PROFILE) app.setPath('userData', process.env.ONE_LINK_TEST_PROFILE);
if (!app.requestSingleInstanceLock()) { app.quit(); } else {
  app.on('second-instance', () => { if (win) { win.show(); win.focus(); } });
  app.whenReady().then(boot).catch(async e => { dialog.showErrorBox('ONE LINK 시작 오류', displayError(e)); app.exit(1); });
}
function icon() {
  return nativeImage.createFromPath(path.join(__dirname, '../assets/icon.png'));
}
async function boot() {
  assert(safeStorage.isEncryptionAvailable(), '이 OS에서 안전한 기기 키 저장소를 사용할 수 없습니다.');
  engine = await new Engine({ dir: path.join(app.getPath('userData'), 'profile'), receiveDir: path.join(app.getPath('downloads'), 'ONE LINK'),
    protect: value => safeStorage.encryptString(value).toString('base64'), unprotect: value => safeStorage.decryptString(Buffer.from(value, 'base64')) }).init();
  const page = path.join(__dirname, '../ui/index.html');
  win = new BrowserWindow({ width: 1200, height: 820, minWidth: 940, minHeight: 670, backgroundColor: '#f8f7f4', title: 'ONE LINK', icon: icon(),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } });
  win.setMenuBarVisibility(false);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  win.on('close', event => {
    if (quitting) return;
    event.preventDefault(); win.hide();
    if (!closeNotice && Notification.isSupported()) { closeNotice = true; new Notification({ title: 'ONE LINK는 계속 연결되어 있습니다', body: '트레이에서 다시 열거나 완전히 종료할 수 있습니다.' }).show(); }
  });
  tray = new Tray(icon().resize({ width: 24, height: 24 })); tray.setToolTip('ONE LINK · 파일 공유');
  tray.setContextMenu(Menu.buildFromTemplate([{ label: 'ONE LINK 열기', click: () => win.show() }, { type: 'separator' }, { label: '완전히 종료', click: () => app.quit() }]));
  tray.on('double-click', () => win.show());
  let updateTimer;
  engine.on('change', () => { clearTimeout(updateTimer); updateTimer = setTimeout(() => { if (!win.isDestroyed()) win.webContents.send('state', engine.snapshot()); }, 120); });
  engine.on('completed', job => { if (Notification.isSupported()) new Notification({ title: '전송 완료', body: `${job.name} · ${job.peerName}` }).show(); });
  const unavailable = !validRepository(updateConfig) ? '업데이트 배포 저장소가 아직 연결되지 않았습니다.' : process.platform !== 'win32' ? '이 플랫폼의 앱 내 업데이트는 준비 중입니다.' : !app.isPackaged || process.env.PORTABLE_EXECUTABLE_FILE ? '설치형 ONE LINK에서 앱 내 업데이트를 사용할 수 있습니다.' : '';
  const updater = unavailable ? null : require('electron-updater').autoUpdater;
  updates = new Updates({ updater, version: app.getVersion(), unavailable, channel: updateConfig.channel,
    createToken: () => new (require('builder-util-runtime').CancellationToken)(),
    prepareInstall: async () => {
      assert(!unfinished(engine.snapshot()) && !engine.active.size && !engine.preparing, '진행 중이거나 대기 중인 전송을 완료하거나 일시정지한 뒤 업데이트하세요.');
      installingUpdate = true;
      await engine.close();
      quitting = true;
    },
    recoverInstall: async () => { if (installingUpdate) { installingUpdate = false; quitting = false; engine.closed = false; await engine.start(); } }
  });
  updates.on('change', value => { if (!win.isDestroyed()) win.webContents.send('update-state', value); });
  ipcMain.handle('command', async (event, command, args = {}) => {
    try {
      assert(event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame, '허용되지 않은 요청입니다.');
      const value = await dispatch(command, args); return { ok: true, value };
    } catch (e) { return { ok: false, error: displayError(e) }; }
  });
  await win.loadFile(page); await engine.start();
}
async function choose(properties) {
  const result = await dialog.showOpenDialog(win, { properties });
  for (const p of result.filePaths) selectedPaths.add(p);
  return result.canceled ? [] : result.filePaths;
}
async function dispatch(command, a) {
  assert(!installingUpdate || ['updateState', 'appInfo', 'state'].includes(command), '업데이트 적용을 준비하고 있습니다.');
  switch (command) {
    case 'updateState': return updates.snapshot();
    case 'checkUpdate': return updates.check();
    case 'downloadUpdate': return updates.download();
    case 'cancelUpdate': return updates.cancel();
    case 'installUpdate': return updates.install();
    case 'appInfo': return { name: 'ONE LINK', version: app.getVersion(), author: 'Unknown', year: '2026', engine: 'Electron · Node.js',
      platform: process.platform === 'darwin' ? `macOS (${process.arch}) · 실기기 검증 전` : `Windows (${process.arch})`, youtube: 'https://www.youtube.com/@unknown8563' };
    case 'openBrandChannel': return shell.openExternal('https://www.youtube.com/@unknown8563');
    case 'fontLicenses': return { pretendard: await fs.readFile(path.join(__dirname, '../assets/fonts/Pretendard-OFL.txt'), 'utf8'), rajdhani: await fs.readFile(path.join(__dirname, '../assets/fonts/Rajdhani-OFL.txt'), 'utf8') };
    case 'state': return engine.snapshot();
    case 'refresh': await engine.refresh(); return engine.snapshot();
    case 'chooseFiles': return choose(['openFile', 'multiSelections']);
    case 'chooseFolders': return choose(['openDirectory', 'multiSelections']);
    case 'dropped': {
      assert(Array.isArray(a.paths) && a.paths.length <= 1000, '선택한 항목이 너무 많습니다.');
      for (const p of a.paths) { assert(typeof p === 'string' && path.isAbsolute(p), '잘못된 파일 경로입니다.'); await fs.lstat(p); selectedPaths.add(p); } return a.paths;
    }
    case 'send': assert(a.paths.every(p => selectedPaths.has(p)), '파일을 다시 선택하세요.'); return engine.enqueue(a.paths, a.peers);
    case 'connect': return engine.connect({ host: a.host, port: 47321 });
    case 'pollPair': return engine.pollPair();
    case 'approvePair': return engine.approvePair(a.id, !!a.allow);
    case 'removePeer': return engine.removePeer(a.id);
    case 'autoReceive': assert(engine.state.peers[a.id], '기기를 찾지 못했습니다.'); engine.state.peers[a.id].autoReceive = !!a.enabled; return engine.save();
    case 'addShare': { const paths = await choose(['openDirectory']); return paths.length ? engine.addShare(paths[0], a.peers) : null; }
    case 'removeShare': return engine.removeShare(a.id);
    case 'shareAccess': {
      const share = engine.state.shares.find(s => s.id === a.id); assert(share && Array.isArray(a.peers) && a.peers.every(id => engine.state.peers[id]), '공유 권한을 확인하세요.');
      share.peers = a.peers; return engine.save();
    }
    case 'browse': return engine.browse(a.peerId, a.shareId, a.path, a.offset);
    case 'pull': return engine.pull(a.peerId, a.shareId, a.path);
    case 'accept': return engine.accept(a.id, !!a.allow);
    case 'control': return engine.control(a.id, a.action);
    case 'openReceived': {
      const job = a.id ? engine.state.incoming.find(j => j.id === a.id && j.status === 'complete') : null;
      if (a.id) assert(job, '완료된 수신 항목만 열 수 있습니다.');
      const result = await shell.openPath(job?.receiveDir || engine.state.settings.receiveDir); assert(!result, result); return;
    }
    case 'settings': {
      if (a.name !== undefined) { assert(typeof a.name === 'string' && a.name.trim().length > 0 && a.name.length <= 80, '기기 이름은 1~80자로 입력하세요.'); engine.state.settings.name = a.name.trim(); }
      if (a.login !== undefined) { app.setLoginItemSettings({ openAtLogin: !!a.login, path: process.env.PORTABLE_EXECUTABLE_FILE || app.getPath('exe') }); engine.state.settings.login = !!a.login; }
      return engine.save();
    }
    case 'receiveFolder': { const paths = await choose(['openDirectory', 'createDirectory']); if (paths[0]) { engine.state.settings.receiveDir = paths[0]; await engine.save(); } return; }
    default: throw new Error('지원하지 않는 명령입니다.');
  }
}
app.on('activate', () => win?.show());
app.on('before-quit', event => {
  if (quitting) return;
  quitting = true; event.preventDefault();
  Promise.resolve(engine?.close()).finally(() => app.exit(0));
});
