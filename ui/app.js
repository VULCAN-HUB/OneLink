/* All peer names and file names are untrusted; escape before HTML insertion. */
const api = window.oneLink;
const $ = selector => document.querySelector(selector);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const size = bytes => { if (!bytes) return '0 B'; const unit = Math.min(4, Math.floor(Math.log(bytes) / Math.log(1024))); return `${(bytes / 1024 ** unit).toFixed(unit ? 1 : 0)} ${['B', 'KB', 'MB', 'GB', 'TB'][unit]}`; };
const labels = { waiting: '연결 대기', approval: '수신 승인 대기', sending: '보내는 중', receiving: '받는 중', complete: '완료', paused: '일시정지', failed: '확인 필요', cancelled: '취소됨', pending: '수신 요청', rejected: '거절됨' };
const icons = {
  windows: '<svg viewBox="0 0 40 32" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="4" y="3" width="32" height="21" rx="3"/><path d="M15 29h10M20 24v5"/><path d="M17 9h3v3h-3zm5 0h3v3h-3zm-5 5h3v3h-3zm5 0h3v3h-3z" fill="currentColor" stroke="none"/></svg>',
  mac: '<svg viewBox="0 0 40 32" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="7" y="3" width="26" height="20" rx="3"/><path d="m7 23-4 5h34l-4-5M16 26h8"/></svg>'
};
let state, appInfo, updateState, page = 'devices', selected = new Set(), browser = null, pairingTimer, toastTimer, busy = false;
const osName = value => /darwin|mac/i.test(value) ? 'macOS' : /windows|win32/i.test(value) ? 'Windows' : value || '기기';
const button = (action, text, args = '', cls = 'secondary', disabled = false) => `<button class="${cls}" data-action="${action}" ${args} ${disabled ? 'disabled' : ''}>${text}</button>`;
function toast(message, error = false) { $('#toast').textContent = message; $('#toast').className = 'toast' + (error ? ' error' : ''); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').classList.add('hidden'), error ? 10000 : 4500); }
async function run(name, args) { try { return await api.command(name, args); } catch (e) { toast(e.message, true); throw e; } }
function modal(html, kind = '') { $('#modal').className = kind; $('#modal-body').innerHTML = html; if (!$('#modal').open) $('#modal').showModal(); }
function closeModal() { clearInterval(pairingTimer); pairingTimer = null; $('#modal').close(); }
const modalActions = html => `<div class="modal-actions">${button('closeModal', '닫기')}${html || ''}</div>`;
function heading(eyebrow, title, description, actions = '') { return `<div class="page-heading"><div><div class="eyebrow">${eyebrow}</div><h1>${title}</h1><p>${description}</p></div><div>${actions}</div></div>`; }
function empty(title, description, cls = '') { return `<div class="empty ${cls}"><div class="empty-icon">↔</div><strong>${title}</strong>${description}</div>`; }
function render() {
  if (!state) return;
  $('#local-name').textContent = state.name;
  $('#device-count').textContent = state.peers.length;
  $('#transfer-count').textContent = [...state.outgoing, ...state.incoming].filter(j => !['complete', 'cancelled', 'rejected', 'failed'].includes(j.status)).length;
  $('#connection-dot').className = state.network.state === 'Running' ? 'online' : '';
  $('#connection-label').innerHTML = `${state.network.state === 'Running' ? 'Tailscale 연결됨' : '연결 확인 필요'}<small>기존 Tailscale 네트워크</small>`;
  $('#network-notice').textContent = state.network.message || '';
  $('#network-notice').classList.toggle('hidden', !state.network.message);
  const pageLabels = { devices: '내 기기', transfers: '전송', shares: '내 공유 폴더', history: '기록', settings: '설정', browser: '공유 폴더 탐색' };
  $('#page-label').textContent = pageLabels[page];
  document.querySelectorAll('[data-nav]').forEach(b => b.classList.toggle('active', b.dataset.nav === page || (page === 'browser' && b.dataset.nav === 'devices')));
  if (page === 'settings' && $('#content').contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return;
  const pages = { devices: devicesPage, transfers: transfersPage, shares: sharesPage, history: historyPage, settings: settingsPage, browser: browserPage };
  $('#content').innerHTML = pages[page]();
}
function deviceCard(peer, paired) {
  const ready = paired ? peer.online : peer.ready;
  return `<article class="device-card ${selected.has(peer.id) ? 'selected' : ''}" data-drop-peer="${paired ? escape(peer.id) : ''}">
    <div class="device-top"><div class="device-icon">${/mac|darwin/i.test(peer.os) ? icons.mac : icons.windows}</div>
    ${paired ? `<input class="device-select" type="checkbox" data-select="${escape(peer.id)}" aria-label="${escape(peer.name)} 선택" ${selected.has(peer.id) ? 'checked' : ''}>` : '<span class="pill">새 기기</span>'}</div>
    <h3 title="${escape(peer.name)}">${escape(peer.name)}</h3><div class="device-meta">${escape(osName(peer.os))}<span>·</span><span class="status ${ready ? 'ready' : ''}">${ready ? '연결 가능' : '응답 대기'}</span></div>
    <div class="device-actions">${paired ? button('browse', '▱ 폴더 열기', `data-id="${escape(peer.id)}"`) + button('peerMenu', '•••', `data-id="${escape(peer.id)}"`) : button('connect', '＋ 연결하기', `data-host="${escape(peer.host)}"`, 'primary')}</div></article>`;
}
function requests() {
  return state.pending.map(p => `<div class="request-banner"><div><strong>${escape(p.name)}에서 연결을 요청했습니다</strong><p>두 화면의 확인 코드를 비교한 뒤 연결하세요.</p></div>${button('reviewPair', '확인하기', `data-id="${p.requestId}"`, 'primary')}</div>`).join('') +
    state.incoming.filter(j => j.status === 'pending').map(j => `<div class="request-banner"><div><strong>${escape(j.peerName)} → ${escape(j.name)}</strong><p>${j.fileCount}개 파일 · ${size(j.total)} · 수신 승인을 기다리고 있습니다.</p></div>${button('reject', '거절', `data-id="${j.id}"`)}${button('accept', '받기', `data-id="${j.id}"`, 'primary')}</div>`).join('');
}
function devicesPage() {
  const fresh = state.candidates.filter(c => c.ready && !state.peers.some(p => p.id === c.id));
  const unavailable = state.candidates.filter(c => !c.ready && !state.peers.some(p => p.host === c.host));
  const active = allJobs().filter(j => !['complete', 'cancelled', 'rejected', 'pending'].includes(j.status)).slice(-3).reverse();
  return heading('CONNECTED, SIMPLY.', '기기를 연결하고, 바로 공유하세요.', '파일을 놓으면 보내고, 기기를 열면 가져옵니다.', button('manual', '＋ 기기 연결')) + requests() +
    `<div class="section-title"><h2>내 기기 <span>${state.peers.length}</span></h2><span>등록한 기기는 자동으로 다시 연결됩니다</span></div><div class="device-grid">${state.peers.length ? state.peers.map(p => deviceCard(p, true)).join('') : empty('첫 번째 기기를 연결하세요', '다른 기기에도 ONE LINK를 실행하면 아래에 나타납니다.', 'empty-card')}</div>` +
    (fresh.length ? `<div class="section-title"><h2>연결할 수 있는 기기</h2><span>ONE LINK가 실행 중입니다</span></div><div class="device-grid">${fresh.map(p => deviceCard(p, false)).join('')}</div>` : '') +
    (unavailable.length ? `<p class="small muted spaced">Tailscale의 다른 기기 ${unavailable.length}대에서 ONE LINK 응답을 기다리고 있습니다.</p>` : '') +
    `<div class="dropzone" data-drop-zone><div><div class="drop-icon">↥</div><h3>${selected.size ? `${selected.size}대의 기기에 파일 보내기` : '여기에 파일이나 폴더를 놓으세요'}</h3><p>기기 카드에 바로 놓거나, 여러 기기를 선택해 한 번에 보낼 수 있습니다.</p>${button('chooseFiles', '파일 선택')}${button('chooseFolders', '폴더 선택')}</div></div>` +
    `<div class="section-title"><h2>현재 전송</h2>${button('goTransfers', '모두 보기 →', '', 'ghost')}</div><div class="transfer-list">${active.length ? active.map(transferRow).join('') : empty('모든 준비가 끝났습니다', '파일을 보내거나 공유 폴더에서 자료를 가져오세요.')}</div>`;
}
function allJobs() { return [...state.outgoing.map(j => ({ ...j, direction: 'out' })), ...state.incoming.map(j => ({ ...j, direction: 'in' }))].sort((a, b) => a.created - b.created); }
function transferRow(j) {
  const percent = j.total ? Math.min(100, Math.round(j.done / j.total * 100)) : j.status === 'complete' ? 100 : 0;
  let actions = '';
  if (j.direction === 'out' && !['complete', 'cancelled'].includes(j.status)) {
    actions = ['paused', 'failed'].includes(j.status) ? button('control', '재개', `data-id="${j.id}" data-control="resume"`) : button('control', '일시정지', `data-id="${j.id}" data-control="pause"`);
    actions += button('control', '취소', `data-id="${j.id}" data-control="cancel"`, 'ghost');
  }
  if (j.direction === 'in' && j.status === 'complete') actions = button('openReceived', '폴더 열기', `data-id="${j.id}"`);
  if (j.direction === 'in' && j.status === 'pending') actions = button('accept', '받기', `data-id="${j.id}"`, 'primary') + button('reject', '거절', `data-id="${j.id}"`);
  return `<div class="transfer"><div class="file-icon">${j.direction === 'out' ? '↗' : '↙'}</div><div class="transfer-info"><div class="transfer-name">${escape(j.name)}</div><div class="transfer-meta"><span>${j.direction === 'out' ? '→' : '←'} ${escape(j.peerName)}</span><span>${size(j.done)} / ${size(j.total)}</span><span>${labels[j.status] || escape(j.status)}</span></div>${!['complete', 'cancelled', 'rejected'].includes(j.status) ? `<progress class="progress" value="${percent}" max="100" aria-label="전송 진행률 ${percent}%"></progress>` : ''}${j.error ? `<p class="small">${escape(j.error)}</p>` : ''}</div><div class="transfer-controls">${actions}</div></div>`;
}
function transfersPage() {
  const jobs = allJobs().filter(j => !['complete', 'cancelled', 'rejected', 'pending'].includes(j.status)).reverse();
  return heading('IN MOTION.', '전송', '연결이 잠시 끊겨도, 작업은 여기에 남습니다.', button('chooseFiles', '＋ 파일 보내기', '', 'primary')) + requests() + `<div class="transfer-list">${jobs.length ? jobs.map(transferRow).join('') : empty('진행 중인 전송이 없습니다', '내 기기에서 파일을 보내거나 공유 폴더에서 가져오세요.')}</div>`;
}
function historyPage() {
  const jobs = allJobs().filter(j => ['complete', 'cancelled', 'rejected'].includes(j.status)).reverse();
  return heading('ALL IN PLACE.', '전송 기록', '기기별로 완료된 작업과 취소된 작업을 확인하세요.', button('openReceived', '받은 폴더 열기')) + `<div class="transfer-list">${jobs.length ? jobs.map(transferRow).join('') : empty('첫 번째 전송을 기다리고 있습니다', '완료된 파일은 검증을 거쳐 이곳에 표시됩니다.')}</div>`;
}
function sharesPage() {
  return heading('YOUR FILES, YOUR RULES.', '내 공유 폴더', '허용한 기기에서만 탐색하고 가져올 수 있습니다.', button('addShare', '＋ 폴더 공유', '', 'primary')) + `<div class="panel">${state.shares.length ? state.shares.map(s => `<div class="share-row"><div class="folder-icon">▰</div><div class="share-info"><h3>${escape(s.name)} <span class="pill">읽기 전용</span></h3><p>${escape(s.root)}</p><p>허용 기기 ${s.peers.length}대</p></div>${button('shareAccess', '접근 관리', `data-id="${s.id}"`)}${button('removeShare', '공유 해제', `data-id="${s.id}"`, 'ghost')}</div>`).join('') : empty('공유할 폴더를 선택하세요', '운영체제의 공유 설정 없이, ONE LINK 안에서 폴더를 공유합니다.')}</div><p class="small muted spaced">공유 해제는 이후 접근을 막습니다. 상대가 이미 받은 복사본은 남습니다.</p>`;
}
function settingsPage() {
  return heading('MAKE IT YOURS.', '설정', '한 번 정해두면, 다음부터는 그대로.') + `<div class="panel">
    <div class="settings-row"><div><h3>이 기기의 이름</h3><p>다른 기기의 ONE LINK에 표시됩니다.</p></div><div><input id="setting-name" type="text" maxlength="80" value="${escape(state.name)}" aria-label="기기 이름"> ${button('saveName', '저장')}</div></div>
    <div class="settings-row"><div><h3>받은 파일 저장 위치</h3><p>${escape(state.settings.receiveDir)}</p></div>${button('receiveFolder', '변경')}</div>
    <div class="settings-row"><div><h3>로그인할 때 자동 실행</h3><p>PC를 켜면 ONE LINK도 연결을 준비합니다.</p></div><input type="checkbox" id="setting-login" aria-label="로그인 시 자동 실행" ${state.settings.login ? 'checked' : ''}></div>
    <div class="settings-row"><div><h3>창을 닫아도 연결 유지</h3><p>트레이·메뉴 막대에서 계속 실행됩니다. 완전 종료는 트레이 메뉴를 이용하세요.</p></div><span class="pill">기본 동작</span></div>
    <div class="settings-row"><div><h3>연결 방식</h3><p>기존 Tailscale 네트워크 · 기기 인증 · 암호화 전송<br>ONE LINK 계정이나 운영 서버가 필요하지 않습니다.</p></div><span class="pill">직접 기기 연결</span></div>
    ${updatePanel()}
    <div class="settings-row"><div><h3>ONE LINK ${escape(appInfo?.version || '')} Preview</h3><p>제작 Unknown · © 2026 Unknown<br>Tailscale IPv4 연결과 일반 파일·폴더를 지원합니다.</p></div><span class="pill">정보는 상단 ?</span></div></div>`;
}
function updatePanel() {
  const u = updateState || { phase: 'idle', message: '업데이트 상태를 확인하고 있습니다.' };
  let controls = button('checkUpdate', u.phase === 'checking' ? '확인 중…' : '업데이트 확인', '', 'secondary', ['checking', 'unavailable', 'installing'].includes(u.phase));
  if (u.phase === 'available') controls = button('downloadUpdate', '업데이트 다운로드', '', 'primary');
  if (u.phase === 'downloading') controls = button('cancelUpdate', '다운로드 취소');
  if (u.phase === 'ready') controls = button('confirmUpdate', '재시작하여 업데이트', '', 'primary');
  return `<div class="settings-row update-row"><div><h3>앱 업데이트 <span class="pill">현재 ${escape(appInfo?.version)}</span></h3><p role="status" aria-live="polite">${escape(u.message)}</p>${u.phase === 'downloading' ? `<progress class="progress" value="${u.percent}" max="100" aria-label="업데이트 다운로드"></progress><p>${Math.floor(u.percent)}%</p>` : ''}<p>업데이트 확인은 파일 공유에 영향을 주지 않습니다.</p></div><div>${controls}</div></div>`;
}
function browserPage() {
  if (!browser) return empty('폴더를 여는 중입니다', '잠시만 기다려 주세요.');
  const peer = state.peers.find(p => p.id === browser.peerId);
  const title = escape(peer?.name || '공유 기기');
  const head = heading('OPEN & BRING.', title, '공유된 자료를 탐색하고 필요한 항목만 가져오세요.', button('backDevices', '← 내 기기'));
  if (browser.loading) return head + empty('공유 폴더를 확인하고 있습니다', '상대 기기의 응답을 기다리는 중입니다.');
  if (browser.error) return head + empty('폴더를 열 수 없습니다', escape(browser.error)) + button('retryBrowse', '다시 시도');
  if (!browser.shareId) return head + `<div class="panel">${browser.shares?.length ? browser.shares.map(s => `<div class="share-row"><div class="folder-icon">▰</div><div class="share-info"><h3>${escape(s.name)}</h3><p>읽기 전용 공유 폴더</p></div>${button('enterShare', '폴더 열기', `data-id="${escape(s.id)}" data-name="${escape(s.name)}"`)}${button('pull', '전체 가져오기', `data-share="${escape(s.id)}" data-path=""`, 'primary')}</div>`).join('') : empty('아직 공유된 폴더가 없습니다', '상대 기기에서 폴더를 공유하고 이 기기의 접근을 허용해야 합니다.')}</div>`;
  return head + `<div class="browser-path">${button('upFolder', '↑ 상위 폴더')}<span>${escape(browser.shareName)}${browser.path ? ' / ' + escape(browser.path) : ''}</span></div><div class="panel"><table class="browser-table"><thead><tr><th>이름</th><th>크기</th><th></th></tr></thead><tbody>${browser.items?.map(item => {
    const rel = browser.path ? browser.path + '/' + item.name : item.name;
    return `<tr><td>${item.directory ? `<button class="text-button" data-action="enterFolder" data-path="${escape(rel)}">📁 ${escape(item.name)}</button>` : `▤ ${escape(item.name)}`}</td><td class="muted">${item.directory ? '폴더' : size(item.size)}</td><td>${button('pull', '가져오기', `data-share="${escape(browser.shareId)}" data-path="${escape(rel)}"`)}</td></tr>`;
  }).join('') || '<tr><td colspan="3">빈 폴더입니다.</td></tr>'}</tbody></table></div>${browser.next != null ? button('moreFiles', '더 보기', '', 'ghost') : ''}`;
}
function peerChecks(chosen = [], allowEmpty = false) {
  return state.peers.length ? state.peers.map(p => `<label class="check-row"><input type="checkbox" name="peer" value="${escape(p.id)}" ${chosen.includes(p.id) ? 'checked' : ''}><span>${escape(p.name)}</span><span class="muted small">${escape(osName(p.os))}</span></label>`).join('') : `<p>${allowEmpty ? '아직 연결된 기기가 없습니다. 폴더를 추가한 뒤 나중에 접근을 허용할 수 있습니다.' : '먼저 기기를 연결하세요.'}</p>`;
}
function checkedPeers() { return [...$('#modal').querySelectorAll('input[name=peer]:checked')].map(el => el.value); }
let sendPaths = [], shareEditing;
function sendModal(paths, preferred) {
  sendPaths = paths;
  modal(`<h2>어느 기기로 보낼까요?</h2><p>${paths.length}개 항목을 복사해 보냅니다. 상대 기기에서 수신을 승인하면 시작됩니다.</p>${peerChecks(preferred || [...selected])}<p class="small">원본 파일은 이 기기에 그대로 남습니다.</p>${modalActions(button('confirmSend', '보내기', '', 'primary', !state.peers.length))}`);
}
async function startSend(paths, peers) {
  modal('<h2>파일을 준비하고 있습니다</h2><p><span class="spinner"></span>원본 파일의 무결성을 확인하는 중입니다. 큰 파일은 시간이 걸릴 수 있습니다.</p>');
  try { await run('send', { paths, peers }); closeModal(); page = 'transfers'; toast('전송 대기열에 추가했습니다.'); } catch (e) { closeModal(); } render();
}
async function openBrowser(peerId, shareId = '', relative = '', shareName = '', append = false) {
  const old = browser;
  browser = { peerId, shareId, path: relative, shareName, loading: true }; page = 'browser'; render();
  try { const result = await api.command('browse', { peerId, shareId, path: relative, offset: append ? old.next : 0 }); browser = { ...browser, ...result, loading: false }; if (append) browser.items = [...old.items, ...result.items]; }
  catch (e) { browser.loading = false; browser.error = e.message; } render();
}
async function connect(host) {
  modal(`<h2>기기를 확인하고 있습니다</h2><p>상대 기기에서 ONE LINK가 실행 중인지 확인하세요.</p>${modalActions()}`);
  const result = await run('connect', { host });
  modal(`<h2>${escape(result.name)} 연결</h2><p>상대 기기에도 아래 코드가 표시되는지 확인한 뒤, 상대 화면에서 연결을 승인하세요.</p><div class="pair-code">${result.code.slice(0, 8)}<br>${result.code.slice(8)}</div><p><span class="spinner"></span>상대 기기의 승인을 기다리고 있습니다. 요청은 2분 뒤 만료됩니다.</p>${modalActions()}`);
  pairingTimer = setInterval(async () => {
    try { const result = await api.command('pollPair'); if (result.status === 'approved') { closeModal(); toast('기기가 연결되었습니다. 다음부터 자동으로 연결됩니다.'); state = await api.command('state'); render(); } else if (result.status === 'rejected') { closeModal(); toast('상대 기기가 연결을 거절했습니다.', true); } }
    catch (e) { closeModal(); toast(e.message, true); }
  }, 1500);
}
const actions = {
  checkUpdate: async () => { updateState = await run('checkUpdate'); render(); },
  downloadUpdate: async () => { updateState = await run('downloadUpdate'); render(); },
  cancelUpdate: async () => { updateState = await run('cancelUpdate'); render(); },
  confirmUpdate: () => modal(`<h2>업데이트를 적용할까요?</h2><p>ONE LINK를 종료하고 ${escape(updateState?.next)} 버전을 설치한 뒤 다시 엽니다. 연결한 기기와 설정은 유지됩니다.<br>진행 중이거나 대기 중인 전송은 먼저 완료하거나 일시정지하세요.</p>${modalActions(button('installUpdate', '재시작하여 적용', '', 'primary'))}`),
  installUpdate: async () => { closeModal(); updateState = await run('installUpdate'); render(); },
  about: async () => {
    appInfo ||= await run('appInfo');
    modal(`<div class="about-banner"><img src="../assets/icon.png" alt=""><div><h2>ONE LINK</h2><p>Your devices. One connection.</p></div></div>
      <div class="about-details"><dl><dt>프로젝트</dt><dd class="brand-value">ONE LINK</dd><dt>제작</dt><dd class="brand-value">Unknown</dd><dt>연도</dt><dd>${escape(appInfo.year)}</dd><dt>버전</dt><dd>${escape(appInfo.version)} <span class="pill">PREVIEW</span></dd><dt>유튜브</dt><dd><button class="channel-link" data-action="openBrandChannel">▶ @unknown8563 ↗</button></dd><dt>엔진</dt><dd>${escape(appInfo.engine)}</dd><dt>플랫폼</dt><dd>${escape(appInfo.platform)}</dd></dl><p>이미 연결된 기기 사이에서, 파일 공유를 더 간편하게.</p></div>
      <div class="about-bottom">${button('fontLicenses', '글꼴 라이선스', '', 'ghost')}${button('closeModal', '확인', '', 'primary')}</div>`, 'about-dialog');
  },
  openBrandChannel: () => run('openBrandChannel'),
  fontLicenses: async () => { const licenses = await run('fontLicenses'); modal(`<h2>글꼴 라이선스</h2><p>Rajdhani와 Pretendard를 앱에 포함해 인터넷 없이 표시합니다.</p><details open><summary>Pretendard · SIL OFL 1.1</summary><pre class="license-text">${escape(licenses.pretendard)}</pre></details><details><summary>Rajdhani · SIL OFL 1.1</summary><pre class="license-text">${escape(licenses.rajdhani)}</pre></details>${modalActions(button('about', '앱 정보로 돌아가기', '', 'primary'))}`, 'license-dialog'); },
  closeModal,
  manual: () => modal(`<h2>기기 연결</h2><p>상대 기기가 자동으로 나타나지 않으면 Tailscale IPv4 주소로 확인할 수 있습니다. 상대 기기에서도 ONE LINK를 실행하세요.</p><label class="field">Tailscale 주소<input id="manual-host" type="text" placeholder="100.x.x.x"></label>${modalActions(button('manualConnect', '연결 확인', '', 'primary'))}`),
  manualConnect: () => connect($('#manual-host').value.trim()),
  connect: el => connect(el.dataset.host),
  reviewPair: el => {
    const p = state.pending.find(p => p.requestId === el.dataset.id); if (!p) return;
    modal(`<h2>${escape(p.name)} 연결 요청</h2><p>상대 화면의 코드가 아래와 정확히 같을 때만 승인하세요.</p><div class="pair-code">${p.code.slice(0, 8)}<br>${p.code.slice(8)}</div>${modalActions(button('denyPair', '거절', `data-id="${p.requestId}"`) + button('approvePair', '코드가 같아요 · 연결', `data-id="${p.requestId}"`, 'primary'))}`);
  },
  approvePair: async el => { await run('approvePair', { id: el.dataset.id, allow: true }); closeModal(); toast('기기를 연결했습니다.'); },
  denyPair: async el => { await run('approvePair', { id: el.dataset.id, allow: false }); closeModal(); },
  peerMenu: el => { const p = state.peers.find(p => p.id === el.dataset.id); modal(`<h2>${escape(p.name)}</h2><p>연결한 기기의 수신 설정을 관리합니다.</p><label class="check-row"><input id="auto-receive" type="checkbox" data-id="${p.id}" ${p.autoReceive ? 'checked' : ''}>이 기기에서 보낸 파일 자동 수신</label><p class="small">기본적으로 파일마다 수신 승인을 요청합니다.</p>${modalActions(button('removePeer', '연결 해제', `data-id="${p.id}"`, 'danger'))}`); },
  removePeer: async el => { if (!confirm('이 기기의 연결과 공유 폴더 접근 권한을 해제할까요?')) return; await run('removePeer', { id: el.dataset.id }); selected.delete(el.dataset.id); closeModal(); },
  chooseFiles: async () => { const paths = await run('chooseFiles'); if (paths.length) sendModal(paths); },
  chooseFolders: async () => { const paths = await run('chooseFolders'); if (paths.length) sendModal(paths); },
  confirmSend: async () => {
    const peers = checkedPeers(); if (!peers.length) return toast('받을 기기를 선택하세요.', true);
    await startSend(sendPaths, peers);
  },
  goTransfers: () => { page = 'transfers'; render(); },
  backDevices: () => { page = 'devices'; render(); },
  browse: el => openBrowser(el.dataset.id),
  enterShare: el => openBrowser(browser.peerId, el.dataset.id, '', el.dataset.name),
  enterFolder: el => openBrowser(browser.peerId, browser.shareId, el.dataset.path, browser.shareName),
  upFolder: () => browser.path ? openBrowser(browser.peerId, browser.shareId, browser.path.split('/').slice(0, -1).join('/'), browser.shareName) : openBrowser(browser.peerId),
  retryBrowse: () => openBrowser(browser.peerId, browser.shareId, browser.path, browser.shareName),
  moreFiles: () => openBrowser(browser.peerId, browser.shareId, browser.path, browser.shareName, true),
  pull: async el => { toast('가져올 파일을 준비하고 있습니다.'); await run('pull', { peerId: browser.peerId, shareId: el.dataset.share, path: el.dataset.path }); toast('가져오기를 요청했습니다. 전송 화면에서 진행 상황을 확인하세요.'); },
  addShare: () => { shareEditing = null; modal(`<h2>폴더 공유</h2><p>먼저 접근할 기기를 선택한 다음 공유할 폴더를 고르세요. 읽기 전용으로 공유합니다.</p>${peerChecks([], true)}${modalActions(button('confirmShare', '폴더 선택', '', 'primary'))}`); },
  shareAccess: el => { const s = state.shares.find(s => s.id === el.dataset.id); shareEditing = s.id; modal(`<h2>${escape(s.name)}</h2><p>이 폴더를 탐색하고 가져올 수 있는 기기를 선택하세요.</p>${peerChecks(s.peers, true)}${modalActions(button('confirmShare', '저장', '', 'primary'))}`); },
  confirmShare: async () => { const peers = checkedPeers(); if (shareEditing) await run('shareAccess', { id: shareEditing, peers }); else await run('addShare', { peers }); closeModal(); },
  removeShare: async el => { if (confirm('공유를 해제할까요? 원본 폴더는 그대로 유지됩니다.')) await run('removeShare', { id: el.dataset.id }); },
  accept: el => run('accept', { id: el.dataset.id, allow: true }),
  reject: el => run('accept', { id: el.dataset.id, allow: false }),
  control: el => run('control', { id: el.dataset.id, action: el.dataset.control }),
  openReceived: el => run('openReceived', { id: el.dataset.id }),
  saveName: async () => { await run('settings', { name: $('#setting-name').value }); document.activeElement.blur(); toast('기기 이름을 저장했습니다.'); state = await api.command('state'); render(); },
  receiveFolder: () => run('receiveFolder')
};
document.addEventListener('click', async event => {
  const nav = event.target.closest('[data-nav]'); if (nav) { page = nav.dataset.nav; render(); return; }
  const el = event.target.closest('[data-action]'); if (!el || el.disabled || busy) return;
  try { busy = true; await actions[el.dataset.action]?.(el); } catch {} finally { busy = false; }
});
document.addEventListener('change', async event => {
  const el = event.target;
  try {
    if (el.dataset.select) { if (el.checked) selected.add(el.dataset.select); else selected.delete(el.dataset.select); render(); }
    if (el.id === 'setting-login') await run('settings', { login: el.checked });
    if (el.id === 'auto-receive') await run('autoReceive', { id: el.dataset.id, enabled: el.checked });
  } catch {}
});
document.addEventListener('dragover', event => { event.preventDefault(); const target = event.target.closest('[data-drop-zone], [data-drop-peer]'); if (target) target.classList.add('dragover'); });
document.addEventListener('dragleave', event => { const target = event.target.closest('[data-drop-zone], [data-drop-peer]'); if (target && !target.contains(event.relatedTarget)) target.classList.remove('dragover'); });
document.addEventListener('drop', async event => {
  event.preventDefault(); document.querySelectorAll('.dragover').forEach(el => el.classList.remove('dragover'));
  if (busy || $('#modal').open) return;
  try { const paths = api.pathsForFiles([...event.dataTransfer.files]); if (!paths.length) return; await run('dropped', { paths }); const peer = event.target.closest('[data-drop-peer]')?.dataset.dropPeer; if (peer) await startSend(paths, [peer]); else sendModal(paths); } catch {}
});
$('#modal').addEventListener('cancel', () => { clearInterval(pairingTimer); pairingTimer = null; });
$('#refresh').addEventListener('click', async () => { try { $('#refresh').disabled = true; state = await run('refresh'); render(); } catch {} finally { $('#refresh').disabled = false; } });
api.onState(next => { state = next; selected = new Set([...selected].filter(id => state.peers.some(p => p.id === id))); render(); });
api.onUpdate(next => { updateState = next; if (page === 'settings') render(); });
Promise.all([api.command('state'), api.command('appInfo'), api.command('updateState')]).then(([next, info, update]) => { state = next; appInfo = info; updateState = update; $('#build-version').textContent = info.version + ' · PREVIEW'; render(); }).catch(e => toast(e.message, true));
