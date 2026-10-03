const { app, BrowserWindow } = require('electron');
const { NsisUpdater } = require('electron-updater');
app.setPath('userData', process.env.ONE_LINK_TEST_PROFILE);
app.whenReady().then(() => new BrowserWindow({ show: false }).loadURL('about:blank'));
global.runUpdateFixture = async config => {
  const updater = new NsisUpdater(); updater.updateConfigPath = config;
  updater.currentVersion = new updater.currentVersion.constructor('0.1.2');
  updater.forceDevUpdateConfig = true; updater.autoDownload = false; updater.autoInstallOnAppQuit = false;
  updater.disableDifferentialDownload = true; updater.disableWebInstaller = true; updater.logger = null;
  updater.on('error', () => {});
  const info = await updater.checkForUpdates();
  try {
    const files = await updater.downloadUpdate();
    const data = await require('node:fs/promises').readFile(files[0]);
    return { version: info.updateInfo.version, hash: require('node:crypto').createHash('sha512').update(data).digest('base64') };
  } catch (error) { return { code: error.code, message: error.message }; }
};
