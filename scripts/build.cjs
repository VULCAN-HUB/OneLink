const { build, Platform, Arch } = require('electron-builder');
const config = require('../desktop/update-config.json');
const { validRepository } = require('../desktop/updates.cjs');
if ((config.owner || config.repo) && !validRepository(config)) throw new Error('Invalid GitHub release repository');
build({ targets: Platform.WINDOWS.createTarget(['nsis'], Arch.x64), publish: 'never',
  config: { publish: validRepository(config) ? [{ provider: 'github', owner: config.owner, repo: config.repo, private: false, releaseType: config.channel === 'beta' ? 'prerelease' : 'release' }] : null }
}).catch(error => { console.error(error); process.exitCode = 1; });
