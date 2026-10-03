const fs = require('node:fs');
const path = require('node:path');
const lock = require('../package-lock.json');
const sections = ['ONE LINK — Third-party notices\nFonts: see assets/fonts/*-OFL.txt.\nElectron and Chromium notices are included by the desktop packager.'];
for (const [location, info] of Object.entries(lock.packages)) {
  if (!location || info.dev || info.optional) continue;
  const folder = path.resolve(__dirname, '..', location);
  const meta = JSON.parse(fs.readFileSync(path.join(folder, 'package.json'), 'utf8'));
  const notices = fs.readdirSync(folder).filter(n => /^(licen[sc]e|copying|notice)(\.|$)/i.test(n) && fs.statSync(path.join(folder, n)).isFile());
  if (!notices.length && meta.name === 'lazy-val' && meta.license === 'MIT') {
    sections.push(fs.readFileSync(path.resolve(__dirname, '../assets/licenses/lazy-val.txt'), 'utf8')); continue;
  }
  if (!notices.length) throw new Error('Missing license: '+meta.name);
  sections.push(`${meta.name} ${meta.version}\nLicense: ${info.license || meta.license}\n` + notices.map(n => fs.readFileSync(path.join(folder,n),'utf8')).join('\n'));
}
fs.writeFileSync(path.resolve(__dirname, '../THIRD_PARTY_NOTICES.txt'), sections.join('\n\n========================================\n\n'));
console.log('Runtime dependency notices generated:', sections.length - 1);
