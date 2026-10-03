// Test-only entry point. Excluded from every desktop build.
const path = require('node:path');
const { Engine } = require('../core/engine.cjs');
const initialize = Engine.prototype.init;
Engine.prototype.init = async function () { this.test = true; this.receiveDir = path.join(process.env.ONE_LINK_TEST_PROFILE, 'received'); return initialize.call(this); };
Engine.prototype.start = async function () {
  await this.listen('127.0.0.1', Number(process.env.ONE_LINK_HARNESS_PORT || 0));
  this.network = { state: 'Running', host: '127.0.0.1', peers: [], message: '' };
  this.timer = setInterval(() => this.pump(), 100); this.emit('change');
};
require('../desktop/main.cjs');
