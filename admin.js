// CONFIG
// ═══════════════════════════════════════════════════════
var GH = { owner:'deepvoidx', repo:'master-resource', branch:'main' };
var MAX_ATTEMPTS = 3;
var LOCK_MS      = 5 * 60 * 1000;  // 5 min lockout
var UNDO_MS      = 10000; // 10 seconds

function getIdleTimeoutMs() {
  var saved = localStorage.getItem('a_idle_mins');
  var mins = saved !== null ? parseInt(saved, 10) : 30;
  if (isNaN(mins) || mins <= 0) return 0; // 0 = never
  return mins * 60 * 1000;
}
var SESSION_MS = getIdleTimeoutMs();

// ═══════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════
var S = {
  token:null, ghUser:'', activeTab:'home',
  toolsData:null, toolsSha:null,
  pendingData:null, pendingSha:null,
  settingsSha:null,
  sessionId:null,
  sessionTimer:null,
  editToolIdx:-1,
  toolsSortMode:'default',
  bulkSelected:new Set(),
  undoTimer:null,
  undoProgressAnim:null,
  _pendingAction:null
};

// ═══════════════════════════════════════════════════════
// SECURITY: rate-limit login attempts
// ═══════════════════════════════════════════════════════
function getLoginState() {
  try { return JSON.parse(sessionStorage.getItem('a_ls') || 'null'); } catch(e){return null;}
}
function setLoginState(s) { sessionStorage.setItem('a_ls', JSON.stringify(s)); }

function checkLockout() {
  var ls = getLoginState();
  if (!ls) return false;
  if (ls.locked && Date.now() < ls.lockedUntil) {
    var mins = Math.ceil((ls.lockedUntil - Date.now()) / 60000);
    document.getElementById('lockout-msg').style.display = 'block';
    document.getElementById('lockout-msg').textContent = 'Too many failed attempts. Try again in ' + mins + ' min.';
    document.getElementById('login-btn').disabled = true;
    var clrEl = document.getElementById('lockout-clear'); if(clrEl) clrEl.style.display='block';
    return true;
  }
  if (ls.locked && Date.now() >= ls.lockedUntil) {
    sessionStorage.removeItem('a_ls');
    document.getElementById('lockout-msg').style.display = 'none';
    document.getElementById('login-btn').disabled = false;
  }
  return false;
}

function recordFailedAttempt() {
  var ls = getLoginState() || { attempts:0 };
  ls.attempts = (ls.attempts || 0) + 1;
  if (ls.attempts >= MAX_ATTEMPTS) {
    ls.locked = true; ls.lockedUntil = Date.now() + LOCK_MS;
  }
  setLoginState(ls);
  checkLockout();
}

function clearLoginState() { sessionStorage.removeItem('a_ls'); }

// ═══════════════════════════════════════════════════════
// SESSION
// ═══════════════════════════════════════════════════════
function startSession(token, user) {
  S.token = token; S.ghUser = user;
  sessionStorage.setItem('a_tok', token);
  sessionStorage.setItem('a_usr', user);
  resetIdleTimer();
}

function resetIdleTimer() {
  clearTimeout(S.sessionTimer);
  SESSION_MS = getIdleTimeoutMs();
  if (!SESSION_MS) return; // never timeout
  S.sessionTimer = setTimeout(function(){
    toast('Session expired. Please sign in again.', '⚠️');
    setTimeout(logout, 1500);
  }, SESSION_MS);
}

function logout() {
  S.token = null; S.toolsData = null; S.pendingData = null;
  S.activeTab = 'home'; S.toolsSortMode = 'default';
  S.bulkSelected.clear();
  // Remove own session from settings on clean logout (best-effort)
  if (S.sessionId && S.settingsSha) {
    removeOwnSession().catch(function(){});
  }
  S.sessionId = null;
  sessionStorage.removeItem('a_tok');
  sessionStorage.removeItem('a_usr');
  sessionStorage.removeItem('a_sid');
  clearTimeout(S.sessionTimer);

  // Reset historyLoaded so it reloads fresh on next login
  historyLoaded = false;

  // Reset all rendered lists back to loading spinners
  var spinner = '<div class="flex center gap8" style="padding:20px;justify-content:center;"><div class="spinner"></div><span style="color:var(--mute);">Loading…</span></div>';
  ['pending-list','tools-list','cats-list','history-list'].forEach(function(id){
    var el = document.getElementById(id);
    if (el) { el.innerHTML = ''; el.classList.add('hidden'); }
  });
  ['pending-loading','tools-loading','cats-loading','history-loading'].forEach(function(id){
    var el = document.getElementById(id);
    if (el) { el.innerHTML = spinner; el.classList.remove('hidden'); }
  });
  var se = document.getElementById('stats-content');
  if (se) se.innerHTML = spinner;
  document.getElementById('pending-empty').classList.add('hidden');

  // Reset tabs UI back to Home
  document.querySelectorAll('.tab-btn').forEach(function(b){ b.classList.remove('active'); });
  document.querySelectorAll('.tab-content').forEach(function(c){ c.classList.remove('active'); });
  var homeBtn = document.querySelector('.tab-btn[data-tab="home"]');
  var homeTab = document.getElementById('tab-home');
  if (homeBtn) homeBtn.classList.add('active');
  if (homeTab) homeTab.classList.add('active');
  requestAnimationFrame(function(){
    var active = document.querySelector('.tab-btn.active');
    if (active) moveLiquidIndicator(active);
  });

  // Reset counts
  ['pending-count','tools-tab-count','cats-tab-count','tools-count','cats-count'].forEach(function(id){
    var el = document.getElementById(id); if (el) el.innerHTML = '';
  });

  document.getElementById('admin-panel').style.display = 'none';
  document.getElementById('login-screen').style.display = 'flex';
  document.getElementById('pat-input').value = '';
  var lb = document.getElementById('login-btn');
  if (lb) { lb.disabled = false; lb.textContent = 'Sign In'; }
  document.getElementById('login-err').textContent = '';
}

// reset timer on any interaction
document.addEventListener('click', function(){ if(S.token) resetIdleTimer(); });
document.addEventListener('keydown', function(){ if(S.token) resetIdleTimer(); });

// ═══════════════════════════════════════════════════════
// GITHUB API
// ═══════════════════════════════════════════════════════
function apiHeaders() {
  return { 'Authorization':'Bearer '+S.token, 'Accept':'application/vnd.github.v3+json', 'Content-Type':'application/json' };
}

function apiGet(path) {
  return fetch('https://api.github.com/repos/'+GH.owner+'/'+GH.repo+'/contents/'+path+'?ref='+GH.branch, {
    headers: apiHeaders()
  }).then(function(r){
    if (!r.ok) return r.text().then(function(t){ throw new Error(r.status+': '+t); });
    return r.json().then(function(d){
      var raw = d.content.replace(/\n/g,'');
      var content;
      try { content = JSON.parse(decodeURIComponent(escape(atob(raw)))); }
      catch(e){ content = JSON.parse(atob(raw)); }
      return { content:content, sha:d.sha };
    });
  });
}

function apiPut(path, content, sha, message) {
  var str = JSON.stringify(content, null, 2);
  var encoded = btoa(unescape(encodeURIComponent(str)));
  var body = { message:message, content:encoded, branch:GH.branch };
  if (sha) body.sha = sha;
  return fetch('https://api.github.com/repos/'+GH.owner+'/'+GH.repo+'/contents/'+path, {
    method:'PUT', headers:apiHeaders(), body:JSON.stringify(body)
  }).then(function(r){
    if (!r.ok) return r.text().then(function(t){ throw new Error(r.status+': '+t); });
    return r.json();
  });
}

function validateGHToken(token) {
  return fetch('https://api.github.com/repos/'+GH.owner+'/'+GH.repo, {
    headers:{ 'Authorization':'Bearer '+token, 'Accept':'application/vnd.github.v3+json' }
  }).then(function(r){ return r.ok; });
}

function getGHUser(token) {
  return fetch('https://api.github.com/user', {
    headers:{ 'Authorization':'Bearer '+token, 'Accept':'application/vnd.github.v3+json' }
  }).then(function(r){ return r.ok ? r.json() : null; });
}

// ═══════════════════════════════════════════════════════
// SECURITY HELPERS
// ═══════════════════════════════════════════════════════
function esc(str) {
  return String(str||'')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function safeHref(raw) {
  var url = String(raw||'').trim().replace(/^[\s\u0000-\u001F\u00AD]+/,'');
  if (!url || /^(javascript|data|vbscript|file|blob|about|\w+script):/i.test(url)) return '#blocked';
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  try {
    var p = new URL(url);
    return (['http:','https:'].includes(p.protocol)) ? p.href : '#blocked';
  } catch(e) { return '#blocked'; }
}

function sanitize(str, max) {
  return String(str||'').trim().slice(0, max||300).replace(/[\x00-\x1F\x7F]/g,'');
}

function validateURL(raw) {
  var url = String(raw||'').trim();
  if (!url) return { ok:false, msg:'URL required.' };
  if (/^(javascript|data|vbscript|file|blob|about):/i.test(url)) return { ok:false, msg:'Invalid URL protocol.' };
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  try {
    var p = new URL(url);
    if (!['http:','https:'].includes(p.protocol)) return { ok:false, msg:'Only http/https allowed.' };
    if (!p.hostname || !p.hostname.includes('.')) return { ok:false, msg:'Invalid hostname.' };
    return { ok:true, url:p.href };
  } catch(e){ return { ok:false, msg:'Invalid URL.' }; }
}

function safeColor(raw) {
  var c = String(raw||'').trim();
  return /^#[0-9a-fA-F]{6}$/.test(c) ? c : '#6c63ff';
}

// ═══════════════════════════════════════════════════════
// CRYPTO HELPERS
// ═══════════════════════════════════════════════════════
function sha256hex(message) {
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(message))
    .then(function(buf){
      return Array.from(new Uint8Array(buf)).map(function(b){ return b.toString(16).padStart(2,'0'); }).join('');
    });
}

function randomHex(bytes) {
  var arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr).map(function(b){ return b.toString(16).padStart(2,'0'); }).join('');
}

function getDeviceInfo() {
  var ua = navigator.userAgent;
  var browser = ua.includes('Firefox') ? 'Firefox'
    : ua.includes('Edg/') ? 'Edge'
    : ua.includes('Chrome') ? 'Chrome'
    : ua.includes('Safari') ? 'Safari' : 'Browser';
  var os = ua.includes('Windows') ? 'Windows'
    : ua.includes('Mac') ? 'macOS'
    : (ua.includes('iPhone')||ua.includes('iPad')) ? 'iOS'
    : ua.includes('Android') ? 'Android'
    : ua.includes('Linux') ? 'Linux' : 'Unknown';
  return browser + ' / ' + os;
}

// ═══════════════════════════════════════════════════════
// SESSION TRACKING
// ═══════════════════════════════════════════════════════
function registerSession(settingsData) {
  S.sessionId = randomHex(12);
  sessionStorage.setItem('a_sid', S.sessionId);
  if (!Array.isArray(settingsData.sessions)) settingsData.sessions = [];
  // Clean up expired temp-password sessions older than 7 days
  var cutoff = Date.now() - 7 * 24 * 3600 * 1000;
  settingsData.sessions = settingsData.sessions.filter(function(s){
    return !s.loginAt || new Date(s.loginAt).getTime() > cutoff;
  });
  settingsData.sessions.push({
    id: S.sessionId,
    device: getDeviceInfo(),
    loginAt: new Date().toISOString(),
    isTemp: !!S._loginedWithTemp
  });
  return settingsData;
}

function removeOwnSession() {
  return apiGet('settings.json').then(function(d){
    var data = d.content;
    S.settingsSha = d.sha;
    if (!Array.isArray(data.sessions)) return;
    data.sessions = data.sessions.filter(function(s){ return s.id !== S.sessionId; });
    return apiPut('settings.json', data, S.settingsSha, 'Session ended');
  });
}

function forceLogoutSession(sessionId) {
  return apiGet('settings.json').then(function(d){
    var data = d.content;
    S.settingsSha = d.sha;
    if (!Array.isArray(data.sessions)) return;
    data.sessions = data.sessions.filter(function(s){ return s.id !== sessionId; });
    return apiPut('settings.json', data, S.settingsSha, 'Force logout session').then(function(r){
      S.settingsSha = r.content.sha;
      toast('Device logged out', '✓');
      initHomeTab();
    });
  });
}

function checkOwnSessionValid(settingsData) {
  if (!S.sessionId) return true; // legacy session before tracking
  if (!Array.isArray(settingsData.sessions)) return true;
  return settingsData.sessions.some(function(s){ return s.id === S.sessionId; });
}

// ═══════════════════════════════════════════════════════
// TEMPORARY PASSWORD
// ═══════════════════════════════════════════════════════
var WORKER_URL = 'https://winter-art-8e2b.anshtripathi872.workers.dev';

function createTempPassword(password, expiryMins) {
  var salt = randomHex(16);
  return sha256hex(salt + password).then(function(hash){
    var expiry = expiryMins > 0 ? Date.now() + expiryMins * 60000
               : expiryMins === 0 ? 0  // never
               : -1;                   // -1 = until deleted
    return apiGet('settings.json').then(function(d){
      var data = d.content;
      S.settingsSha = d.sha;
      data.tempPasswordHash = hash;
      data.tempPasswordSalt = salt;
      data.tempPasswordExpiry = expiry;
      return apiPut('settings.json', data, S.settingsSha, 'Create temporary password').then(function(r){
        S.settingsSha = r.content.sha;
      });
    });
  });
}

function deleteTempPassword() {
  return apiGet('settings.json').then(function(d){
    var data = d.content;
    S.settingsSha = d.sha;
    delete data.tempPasswordHash;
    delete data.tempPasswordSalt;
    delete data.tempPasswordExpiry;
    return apiPut('settings.json', data, S.settingsSha, 'Delete temporary password').then(function(r){
      S.settingsSha = r.content.sha;
    });
  });
}

// Verify temp password via worker (worker holds the real GH token)
function verifyTempPassword(password) {
  return fetch(WORKER_URL + '/verify-temp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: password })
  }).then(function(r){ return r.json(); });
}

// ═══════════════════════════════════════════════════════
// TAB COUNTS
// ═══════════════════════════════════════════════════════
function updateTabCounts() {
  var tc = S.toolsData ? S.toolsData.tools.length : 0;
  var cc = S.toolsData ? S.toolsData.categories.length : 0;
  var el1 = document.getElementById('tools-tab-count');
  var el2 = document.getElementById('cats-tab-count');
  if (el1) el1.innerHTML = tc ? '<span class="badge-count">'+tc+'</span>' : '';
  if (el2) el2.innerHTML = cc ? '<span class="badge-count">'+cc+'</span>' : '';
}

// ── Call after any data mutation to keep stats current ──
function maybeRefreshStats() {
  if (S.activeTab === 'stats') renderStats();
}

// ═══════════════════════════════════════════════════════
// TOAST
// ═══════════════════════════════════════════════════════
var toastT;
function toast(msg, icon) {
  var t = document.getElementById('a-toast');
  if (!t) return;
  t.innerHTML = (icon?'<span>'+esc(icon)+'</span>':'') + '<span>'+esc(msg)+'</span>';
  t.classList.add('show');
  clearTimeout(toastT);
  toastT = setTimeout(function(){ t.classList.remove('show'); }, 3000);
}

// ═══════════════════════════════════════════════════════
// LOAD DATA
// ═══════════════════════════════════════════════════════
function loadData() {
  return Promise.all([
    apiGet('tools.json').then(function(d){ S.toolsData = d.content; S.toolsSha = d.sha; }),
    apiGet('pending.json').catch(function(){
      // pending.json might not exist yet
      S.pendingData = { pending:[] }; S.pendingSha = null;
    }).then(function(d){ if(d){ S.pendingData = d.content; S.pendingSha = d.sha; } }),
    // Fetch settings.json for cross-device sync
    apiGet('settings.json').then(function(d){
      S.settingsSha = d.sha;
      var cfg = d.content || {};
      // Sync auto-logout
      var mins = cfg.autoLogoutMins !== undefined ? String(cfg.autoLogoutMins) : '30';
      localStorage.setItem('a_idle_mins', mins);
      SESSION_MS = getIdleTimeoutMs();
      resetIdleTimer();
      // Check if our own session was force-revoked
      if (S.sessionId && !checkOwnSessionValid(cfg)) {
        toast('Your session was revoked from another device.', '⚠️');
        setTimeout(logout, 1800);
        return;
      }
    }).catch(function(){ /* settings.json may not exist yet */ })
  ]).then(function(){
    renderPending();
    renderTools();
    renderCategories();
    updateTabCounts();
    if (S.activeTab==='stats') renderStats();
    if (S.activeTab==='history') fetchHistory();
    if (S.activeTab==='home') initHomeTab();
  }).catch(function(e){
    toast('Failed to load data: ' + e.message, '❌');
  });
}

// ═══════════════════════════════════════════════════════
// UNDO SYSTEM
// ═══════════════════════════════════════════════════════
function scheduleWithUndo(msg, actionFn, onSuccess, onRevert) {
  cancelUndo();
  var el   = document.getElementById('undo-toast');
  var prog = document.getElementById('ut-progress');
  var msgEl = document.getElementById('ut-msg');
  if (!el || !prog || !msgEl) {
    actionFn().then(onSuccess).catch(function(e){ toast('Error: '+e.message,'❌'); if(onRevert) onRevert(); });
    return;
  }
  // Store so commitNow() can fire immediately if user taps ✕
  S._pendingAction = { actionFn: actionFn, onSuccess: onSuccess, onRevert: onRevert };
  msgEl.textContent = msg;
  el.classList.add('show');
  prog.style.transition = 'none';
  prog.style.width = '100%';
  requestAnimationFrame(function(){ requestAnimationFrame(function(){
    prog.style.transition = 'width '+UNDO_MS+'ms linear';
    prog.style.width = '0%';
  }); });
  S.undoTimer = setTimeout(function(){
    el.classList.remove('show'); S.undoTimer = null;
    S._pendingAction = null;
    actionFn().then(onSuccess).catch(function(e){
      toast('Error: '+e.message, '❌');
      if (onRevert) onRevert();
    });
  }, UNDO_MS);
}
function cancelUndo() {
  if (S.undoTimer) {
    clearTimeout(S.undoTimer); S.undoTimer = null;
    S._pendingAction = null;
    var el = document.getElementById('undo-toast');
    if (el) el.classList.remove('show');
  }
}

// Dismiss without undoing — fires the pending action immediately
function commitNow() {
  if (S.undoTimer) {
    clearTimeout(S.undoTimer); S.undoTimer = null;
    var el = document.getElementById('undo-toast');
    if (el) el.classList.remove('show');
    // Fire the queued action right away
    if (S._pendingAction) {
      var pa = S._pendingAction;
      S._pendingAction = null;
      pa.actionFn().then(pa.onSuccess).catch(function(e){
        toast('Error: '+e.message,'❌');
        if (pa.onRevert) pa.onRevert();
      });
    }
  }
}

function wireUndoListeners() {
  var undoBtn  = document.getElementById('ut-undo');
  var closeBtn = document.getElementById('ut-close');
  if (undoBtn)  undoBtn.addEventListener('click', function(){ cancelUndo(); toast('Action undone','↩️'); });
  if (closeBtn) closeBtn.addEventListener('click', function(){ commitNow(); });
}

// ═══════════════════════════════════════════════════════
// PREVIEW CARD
// ═══════════════════════════════════════════════════════
function buildPreviewCard(name, desc, url, catId) {
  var cat = (S.toolsData && S.toolsData.categories)
    ? (S.toolsData.categories.find(function(c){ return c.id===catId; })||{}) : {};
  var color = safeColor(cat.color || '#6c63ff');
  var domain = '';
  try { domain = new URL(/^https?:\/\//.test(url)?url:'https://'+url).hostname; } catch(e){ domain=url; }
  var div = document.createElement('div');
  div.className = 'preview-wrap';
  div.innerHTML =
    '<div class="preview-label">Preview — how it will look on the site</div>' +
    '<div class="preview-card">' +
      '<div class="preview-card-accent" style="background:'+esc(color)+';box-shadow:0 0 8px '+esc(color)+';"></div>' +
      '<div class="preview-card-shine"></div>' +
      (cat.label ? '<span class="preview-cat-badge" style="background:'+esc(color)+'22;border-color:'+esc(color)+'55;color:'+esc(color)+';">'+esc(cat.icon||'')+'&nbsp;'+esc(cat.short||cat.label)+'</span>' : '') +
      '<div class="preview-tool-name">'+esc(name||'Tool name…')+'</div>' +
      '<div class="preview-tool-desc">'+esc(desc||'Description will appear here…')+'</div>' +
      (domain ? '<div class="preview-tool-link">'+esc(domain)+' ↗</div>' : '') +
    '</div>';
  return div;
}

// ═══════════════════════════════════════════════════════
// BULK SELECT
// ═══════════════════════════════════════════════════════
function updateBulkBar() {
  var n = S.bulkSelected.size;
  var totalCbs = document.querySelectorAll('.bulk-cb').length;
  document.getElementById('bulk-count').textContent = n + ' selected';
  var allCb = document.getElementById('bulk-all');
  if (allCb) { allCb.checked = n > 0 && n === totalCbs; allCb.indeterminate = n > 0 && n < totalCbs; }
}

// ═══════════════════════════════════════════════════════
// ── PENDING TAB ──
// ═══════════════════════════════════════════════════════
function renderPending() {
  var list = document.getElementById('pending-list');
  var empty = document.getElementById('pending-empty');
  var loading = document.getElementById('pending-loading');
  loading.classList.add('hidden');

  var items = (S.pendingData && S.pendingData.pending) ? S.pendingData.pending : [];
  var pending = items.filter(function(i){ return i.status === 'pending'; });

  document.getElementById('pending-count').innerHTML = pending.length ? '<span class="badge-count">'+pending.length+'</span>' : '';

  if (!pending.length) {
    list.classList.add('hidden'); empty.classList.remove('hidden'); return;
  }
  empty.classList.add('hidden'); list.classList.remove('hidden');
  S.bulkSelected.clear(); updateBulkBar();
  list.innerHTML = '';

  pending.forEach(function(item, idx) {
    var card = document.createElement('div');
    card.className = 'pend-card glass';
    var date = '';
    try { date = new Date(item.submittedAt).toLocaleDateString(); } catch(e){}

    // Build category checkboxes
    var cats = S.toolsData ? S.toolsData.categories : [];
    var catChecks = cats.map(function(c){
      return '<label class="cat-check" data-cid="'+esc(c.id)+'">' +
        '<input type="checkbox" value="'+esc(c.id)+'"/>'+esc(c.icon)+' '+esc(c.short||c.label)+
        '</label>';
    }).join('');

    card.innerHTML =
      '<div class="pend-header">' +
        '<input type="checkbox" class="bulk-cb" data-id="'+esc(item.id)+'" style="margin-top:2px;width:16px;height:16px;cursor:pointer;flex-shrink:0;-webkit-tap-highlight-color:transparent;"/>' +
        '<div style="flex:1;">' +
          '<div class="pend-name">'+esc(item.name)+'</div>' +
          '<div class="pend-url"><a href="'+safeHref(item.url)+'" target="_blank" rel="noopener noreferrer">'+esc(item.url)+'</a></div>' +
          '<div class="pend-meta">Submitted: '+esc(date)+' &nbsp;·&nbsp; ID: '+esc(item.id)+'</div>' +
        '</div>' +
        '<span class="badge badge-pending">Pending</span>' +
      '</div>' +
      '<div class="pend-fields">' +
        '<div><label>Edit Name</label><input class="pf-name" type="text" value="'+esc(item.name)+'" maxlength="100"/></div>' +
        '<div><label>Edit URL</label><input class="pf-url" type="url" value="'+esc(item.url)+'" maxlength="500"/></div>' +
        '<div style="grid-column:1/-1"><label>Description</label><input class="pf-desc" type="text" maxlength="200" placeholder="Short description…"/></div>' +
        '<div style="grid-column:1/-1"><label>Tags (comma separated)</label><input class="pf-tags" type="text" placeholder="ai, free, creative"/></div>' +
      '</div>' +
      '<div><label>Categories</label><div class="pend-cats pf-cats">'+catChecks+'</div></div>' +
      '<div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap;align-items:center;">' +
        '<button class="btn btn-ghost btn-sm pf-preview-btn" style="font-size:.8rem;">👁 Preview</button>' +
        '<button class="btn btn-ok btn-sm pf-approve">✓ Approve</button>' +
        '<button class="btn btn-danger btn-sm pf-reject">✗ Reject</button>' +
      '</div>' +
      '<div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;align-items:center;">' +
        '<label class="cat-check pf-new-lbl" style="flex-shrink:0;"><input type="checkbox" class="pf-new-check"/> Mark as New</label>' +
        '<select class="pf-new-expires" style="font-size:.74rem;padding:3px 6px;border-radius:7px;background:rgba(255,255,255,.04);border:1px solid var(--g-bdr);color:var(--txt);">' +
          '<option value="7">1 week</option>' +
          '<option value="30" selected>1 month</option>' +
          '<option value="90">3 months</option>' +
          '<option value="99999">Forever</option>' +
        '</select>' +
      '</div>' +
      '<div class="pf-preview" style="margin-top:8px;"></div>' +
      '<div class="pf-err" style="color:#f87171;font-size:.76rem;margin-top:6px;min-height:14px;"></div>';

    list.appendChild(card);

    // Wire category checkboxes — multi-select (exclude new-tag label)
    card.querySelectorAll('.pf-cats .cat-check').forEach(function(lbl){
      lbl.addEventListener('click', function(e){
        if (e.target.tagName === 'INPUT') {
          lbl.classList.toggle('checked', e.target.checked);
          return;
        }
        e.preventDefault();
        var cb = lbl.querySelector('input');
        cb.checked = !cb.checked;
        lbl.classList.toggle('checked', cb.checked);
      });
    });

    // Wire new-tag checkbox separately
    var pfNewLbl = card.querySelector('.pf-new-lbl');
    pfNewLbl.addEventListener('click', function(e){
      if (e.target.tagName === 'INPUT') { pfNewLbl.classList.toggle('checked', e.target.checked); return; }
      e.preventDefault();
      var cb = pfNewLbl.querySelector('input'); cb.checked = !cb.checked;
      pfNewLbl.classList.toggle('checked', cb.checked);
    });

    // Bulk checkbox
    card.querySelector('.bulk-cb').addEventListener('change', function(){
      var id = this.getAttribute('data-id');
      if (this.checked) S.bulkSelected.add(id); else S.bulkSelected.delete(id);
      card.classList.toggle('sel', this.checked);
      updateBulkBar();
    });

    // Preview button — toggle open/close
    card.querySelector('.pf-preview-btn').addEventListener('click', function(){
      var prev = card.querySelector('.pf-preview');
      var btn  = this;
      // If preview is visible, hide it (toggle off)
      if (prev.children.length > 0) {
        prev.innerHTML = '';
        btn.textContent = '👁 Preview';
        btn.classList.remove('active');
        return;
      }
      // Show preview
      var name  = sanitize(card.querySelector('.pf-name').value, 100);
      var desc  = sanitize(card.querySelector('.pf-desc').value, 200);
      var url   = card.querySelector('.pf-url').value;
      var catEl = card.querySelector('.cat-check.checked input');
      var catId = catEl ? catEl.value : '';
      prev.appendChild(buildPreviewCard(name, desc, url, catId));
      btn.textContent = '👁 Hide Preview';
      btn.classList.add('active');
    });
    // Approve
    card.querySelector('.pf-approve').addEventListener('click', function(){
      approvePending(item, card);
    });

    // Reject
    card.querySelector('.pf-reject').addEventListener('click', function(){
      if (!confirm('Reject and remove this submission?')) return;
      rejectPending(item, card);
    });
  });
}

function approvePending(item, card) {
  var nameVal = sanitize(card.querySelector('.pf-name').value, 100);
  var rawUrl  = card.querySelector('.pf-url').value;
  var desc    = sanitize(card.querySelector('.pf-desc').value, 200);
  var tagsRaw = card.querySelector('.pf-tags').value;
  var errEl   = card.querySelector('.pf-err');

  var urlRes = validateURL(rawUrl);
  if (!nameVal) { errEl.textContent='Name is required.'; return; }
  if (!urlRes.ok) { errEl.textContent=urlRes.msg; return; }

  var cats = [];
  card.querySelectorAll('.cat-check.checked input').forEach(function(inp){ cats.push(inp.value); });
  if (!cats.length) { errEl.textContent='Select at least one category.'; return; }

  var tags = tagsRaw.split(',').map(function(t){ return t.trim().replace(/^#/,'').toLowerCase().slice(0,30); }).filter(Boolean).slice(0,15);

  var btn = card.querySelector('.pf-approve');
  btn.disabled = true; btn.textContent = 'Saving…';
  errEl.textContent = '';

  // Store primary category + categories array for multi-cat support
  var toolEntry = { name:nameVal, description:desc, url:urlRes.url, category:cats[0], tags:tags };
  if (cats.length > 1) toolEntry.categories = cats;
  var pfNewChk = card.querySelector('.pf-new-check');
  var pfNewExp = card.querySelector('.pf-new-expires');
  if (pfNewChk && pfNewChk.checked && pfNewExp) {
    var pfDays = parseInt(pfNewExp.value, 10) || 30;
    toolEntry.newUntil = pfDays >= 99999 ? '9999-12-31T23:59:59.000Z' : new Date(Date.now() + pfDays*86400000).toISOString();
  }

  // Add to tools.json
  var tools = S.toolsData;
  tools.tools.push(toolEntry);

  apiPut('tools.json', tools, S.toolsSha, 'Approve tool: '+nameVal)
    .then(function(res){
      S.toolsSha = res.content.sha;
      // Remove from pending
      return removePendingItem(item.id);
    })
    .then(function(){
      toast('✓ "'+nameVal+'" added to the site!', '✅');
      btn.disabled=false; btn.textContent='✓ Approve';
      renderPending(); renderTools(); updateTabCounts(); maybeRefreshStats();
    })
    .catch(function(e){
      btn.disabled=false; btn.textContent='✓ Approve';
      errEl.textContent='Error: '+e.message;
    });
}

function rejectPending(item, card) {
  var btn = card.querySelector('.pf-reject');
  btn.disabled=true; btn.textContent='Removing…';
  removePendingItem(item.id)
    .then(function(){ toast('Submission rejected.', '🗑️'); renderPending(); maybeRefreshStats(); })
    .catch(function(e){ btn.disabled=false; btn.textContent='✗ Reject'; toast('Error: '+e.message,'❌'); });
}

function removePendingItem(id) {
  var data = S.pendingData || { pending:[] };
  data.pending = data.pending.filter(function(i){ return i.id !== id; });
  return apiPut('pending.json', data, S.pendingSha, 'Remove pending item: '+id)
    .then(function(res){ S.pendingSha = res.content.sha; S.pendingData = data; });
}

// Bulk-all checkbox
document.getElementById('bulk-all').addEventListener('change', function(){
  document.querySelectorAll('.bulk-cb').forEach(function(cb){
    cb.checked = document.getElementById('bulk-all').checked;
    var id = cb.getAttribute('data-id');
    if(cb.checked) S.bulkSelected.add(id); else S.bulkSelected.delete(id);
    cb.closest('.pend-card').classList.toggle('sel', cb.checked);
  });
  updateBulkBar();
});
document.getElementById('bulk-approve-btn').addEventListener('click', function(){
  if (!S.bulkSelected.size) return;
  toast('Use individual Approve to set categories per tool before approving.', 'ℹ️');
});
document.getElementById('bulk-reject-btn').addEventListener('click', function(){
  var ids = Array.from(S.bulkSelected);
  if (!ids.length) return;
  if (!confirm('Reject '+ids.length+' submission(s)? This removes them from the queue.')) return;
  var data = S.pendingData || { pending:[] };
  var snap = JSON.parse(JSON.stringify(data));
  data.pending = data.pending.filter(function(i){ return !ids.includes(i.id); });
  apiPut('pending.json', data, S.pendingSha, 'Bulk reject '+ids.length+' submissions')
    .then(function(res){ S.pendingSha=res.content.sha; S.pendingData=data;
      toast('Rejected '+ids.length+' submission(s)','🗑️'); S.bulkSelected.clear(); renderPending(); maybeRefreshStats(); })
    .catch(function(e){ toast('Error: '+e.message,'❌'); S.pendingData=snap; });
});

// ═══════════════════════════════════════════════════════
// ── TOOLS EDITOR TAB ──
// ═══════════════════════════════════════════════════════
var toolsSearchQ = '';

function renderTools(q) {
  q = (q !== undefined) ? q : toolsSearchQ;
  toolsSearchQ = q;
  var loading = document.getElementById('tools-loading');
  var list = document.getElementById('tools-list');
  loading.classList.add('hidden');
  list.classList.remove('hidden');

  var tools = (S.toolsData && S.toolsData.tools) ? S.toolsData.tools : [];
  document.getElementById('tools-count').textContent = tools.length; updateTabCounts();

  var filtered = tools.filter(function(t){
    if (!q) return true;
    var allCatIds = Array.isArray(t.categories)&&t.categories.length ? t.categories : (t.category?[t.category]:[]);
    return (t.name+' '+(t.description||'')+' '+allCatIds.join(' ')+' '+(t.url||'')).toLowerCase().includes(q.toLowerCase());
  });
  // Sort / Filter
  filtered = filtered.slice();
  if (S.toolsSortMode === 'new') {
    var now = new Date();
    filtered = filtered.filter(function(t){ return !!(t.newUntil && new Date(t.newUntil) > now); });
  } else if (S.toolsSortMode === 'az') {
    filtered.sort(function(a,b){ return a.name.toLowerCase().localeCompare(b.name.toLowerCase()); });
  } else if (S.toolsSortMode === 'category') {
    filtered.sort(function(a,b){ return (a.category||'').localeCompare(b.category||''); });
  } else if (S.toolsSortMode === 'recent') {
    filtered.reverse();
  }

  list.innerHTML = '';
  if (!filtered.length) {
    list.innerHTML = '<div class="empty-state"><div class="empty-icon">🔍</div><div>No tools found</div></div>';
    return;
  }

  filtered.forEach(function(tool){
    var idx = S.toolsData.tools.indexOf(tool);
    var selCatIds = Array.isArray(tool.categories)&&tool.categories.length ? tool.categories : (tool.category?[tool.category]:[]);
    var catMetaStr = selCatIds.map(function(cid){
      var c = S.toolsData.categories.find(function(x){ return x.id===cid; })||{};
      return (c.icon||'')+'\u00a0'+(c.short||c.label||cid);
    }).join(' · ');
    var row = document.createElement('div');
    row.className = 'tool-row glass';
    var isToolNew = !!(tool.newUntil && new Date(tool.newUntil) > new Date());
    var newDaysLeft = '';
    if (isToolNew) {
      var daysLeft = Math.ceil((new Date(tool.newUntil) - new Date()) / 86400000);
      newDaysLeft = daysLeft <= 1 ? '· expires today' : '· '+daysLeft+'d left';
    }
    row.innerHTML =
      '<div style="flex:1;min-width:0;">' +
        '<div class="tool-row-name">'+esc(tool.name)+(isToolNew?'<span class="tool-row-new">NEW</span><span class="tool-row-new-days">'+esc(newDaysLeft)+'</span>':'')+'</div>' +
        '<div class="tool-row-meta">'+esc(catMetaStr)+'&nbsp;·&nbsp;'+esc((tool.url||'').replace(/^https?:\/\//,'').split('/')[0])+'</div>' +
      '</div>' +
      '<div class="tool-row-badge">'+esc(tool.tags&&tool.tags.length?'#'+tool.tags.slice(0,2).join(' #'):'–')+'</div>' +
      '<button class="btn btn-ghost btn-sm" data-action="expand" style="font-size:.9rem;">⌄</button>' +
      '<button class="btn btn-ghost btn-sm" title="Edit">✎</button>' +
      '<button class="btn btn-danger btn-sm" title="Delete">🗑</button>';

    // Wrap in container for inline-edit
    var wrapper = document.createElement('div');
    wrapper.style.marginBottom = '8px';

    // Inline edit panel
    var inlineEdit = document.createElement('div');
    inlineEdit.className = 'inline-edit';
    var selCats = Array.isArray(tool.categories)&&tool.categories.length ? tool.categories : (tool.category?[tool.category]:[]);
    var catOpts = (S.toolsData.categories||[]).map(function(c){
      var chk = selCats.indexOf(c.id)!==-1;
      return '<label class="cat-check'+(chk?' checked':'')+'"><input type="checkbox" value="'+esc(c.id)+'"'+(chk?' checked':'')+'/>'+esc(c.icon)+' '+esc(c.short||c.label)+'</label>';
    }).join('');
    inlineEdit.innerHTML =
      '<div class="ie-grid">' +
        '<div><label>Name</label><input class="ie-name" type="text" value="'+esc(tool.name)+'" maxlength="100"/></div>' +
        '<div><label>URL</label><input class="ie-url" type="url" value="'+esc(tool.url||'')+'" maxlength="500"/></div>' +
        '<div style="grid-column:1/-1"><label>Description</label><input class="ie-desc" type="text" value="'+esc(tool.description||'')+'" maxlength="200"/></div>' +
        '<div style="grid-column:1/-1"><label>Tags</label><input class="ie-tags" type="text" value="'+esc((tool.tags||[]).join(', '))+'"/></div>' +
        '<div style="grid-column:1/-1"><label>Categories</label><div class="pend-cats ie-cats">'+catOpts+'</div></div>' +
      '</div>' +
      '<div class="ie-err" style="color:#f87171;font-size:.76rem;min-height:14px;margin-bottom:6px;"></div>' +
      '<div class="ie-actions"><button class="btn btn-ghost btn-sm ie-cancel">Cancel</button><button class="btn btn-primary btn-sm ie-save">Save</button></div>';

    // inline cat checkboxes
    inlineEdit.querySelectorAll('.cat-check').forEach(function(lbl){
      lbl.addEventListener('click', function(e){
        if(e.target.tagName==='INPUT'){lbl.classList.toggle('checked',e.target.checked);return;}
        e.preventDefault(); var cb=lbl.querySelector('input'); cb.checked=!cb.checked; lbl.classList.toggle('checked',cb.checked);
      });
    });

    wrapper.appendChild(row);
    wrapper.appendChild(inlineEdit);
    list.appendChild(wrapper);

    // Expand/collapse
    row.querySelector('[data-action=expand]').addEventListener('click', function(e){
      e.stopPropagation();
      var open = inlineEdit.classList.toggle('open');
      this.textContent = open ? '⌃' : '⌄';
    });

    // Inline save
    inlineEdit.querySelector('.ie-save').addEventListener('click', function(){
      var nv = sanitize(inlineEdit.querySelector('.ie-name').value,100);
      var ru = inlineEdit.querySelector('.ie-url').value;
      var dv = sanitize(inlineEdit.querySelector('.ie-desc').value,200);
      var tv = inlineEdit.querySelector('.ie-tags').value;
      var ee = inlineEdit.querySelector('.ie-err');
      var ur = validateURL(ru);
      if(!nv){ee.textContent='Name required.';return;}
      if(!ur.ok){ee.textContent=ur.msg;return;}
      var cats=[];
      inlineEdit.querySelectorAll('.cat-check.checked input').forEach(function(i){cats.push(i.value);});
      if(!cats.length){ee.textContent='Select a category.';return;}
      var tags=tv.split(',').map(function(t){return t.trim().replace(/^#/,'').toLowerCase().slice(0,30);}).filter(Boolean).slice(0,15);
      var updated={name:nv,description:dv,url:ur.url,category:cats[0],tags:tags};
      if(cats.length>1) updated.categories=cats;
      if(S.toolsData.tools[idx]&&S.toolsData.tools[idx].newUntil) updated.newUntil=S.toolsData.tools[idx].newUntil;
      ee.textContent='';
      var original=JSON.parse(JSON.stringify(S.toolsData.tools[idx]));
      S.toolsData.tools[idx]=updated;
      inlineEdit.classList.remove('open');
      row.querySelector('[data-action=expand]').textContent='⌄';
      renderTools(toolsSearchQ); maybeRefreshStats();
      scheduleWithUndo(
        'Edit to "'+nv+'" saved — undo?',
        function(){ return apiPut('tools.json',S.toolsData,S.toolsSha,'Edit tool: '+nv).then(function(res){S.toolsSha=res.content.sha;}); },
        function(){ toast('Updated "'+nv+'"','✅'); maybeRefreshStats(); },
        function(){ S.toolsData.tools[idx]=original; renderTools(toolsSearchQ); maybeRefreshStats(); }
      );
    });
    inlineEdit.querySelector('.ie-cancel').addEventListener('click', function(){
      inlineEdit.classList.remove('open');
      row.querySelector('[data-action=expand]').textContent='⌄';
    });

    row.querySelector('[title=Edit]').addEventListener('click', function(e){
      e.stopPropagation(); openToolModal(idx);
    });
    row.querySelector('[title=Delete]').addEventListener('click', function(e){
      e.stopPropagation();
      if (!confirm('Delete "'+tool.name+'"?')) return;
      deleteTool(idx);
    });
  });
}

function openToolModal(idx) {
  S.editToolIdx = idx;
  var isNewTool = idx === -1;
  document.getElementById('tool-modal-title').textContent = isNewTool ? 'Add Tool' : 'Edit Tool';
  document.getElementById('tm-err').textContent = '';
  document.getElementById('tm-save').textContent = isNewTool ? 'Save Tool(s)' : 'Save Changes';

  var singleMode = document.getElementById('tm-single-mode');
  var multiMode  = document.getElementById('tm-multi-mode');

  if (isNewTool) {
    // Multi-add mode
    singleMode.style.display = 'none';
    multiMode.classList.remove('hidden');
    document.getElementById('tm-rows').innerHTML = '';
    tmRowCount = 0;
    tmAddRow(); // start with one blank row
    document.getElementById('tm-add-another').onclick = function(){ tmAddRow(); };
  } else {
    // Single edit mode
    singleMode.style.display = '';
    multiMode.classList.add('hidden');

    var tool = S.toolsData.tools[idx];
    document.getElementById('tm-name').value = tool.name || '';
    document.getElementById('tm-url').value  = tool.url  || '';
    document.getElementById('tm-desc').value = tool.description || '';
    document.getElementById('tm-tags').value = (tool.tags||[]).join(', ');

    // New tag
    var newChk = document.getElementById('tm-new-check');
    var newLbl = document.getElementById('tm-new-lbl');
    if (newChk) {
      var isCurrentlyNew = !!(tool.newUntil && new Date(tool.newUntil) > new Date());
      newChk.checked = isCurrentlyNew;
      if (newLbl) newLbl.classList.toggle('checked', isCurrentlyNew);
    }

    var catsEl = document.getElementById('tm-cats');
    catsEl.innerHTML = '';
    var categories = S.toolsData.categories || [];
    categories.forEach(function(cat){
      var lbl = document.createElement('label');
      var selCats = Array.isArray(tool.categories) && tool.categories.length
        ? tool.categories : (tool.category ? [tool.category] : []);
      var isChk = selCats.indexOf(cat.id) !== -1;
      lbl.className = 'cat-check' + (isChk ? ' checked' : '');
      lbl.dataset.cid = cat.id;
      lbl.innerHTML = '<input type="checkbox" value="'+esc(cat.id)+'"'+(isChk?' checked':'')+'/>'+esc(cat.icon)+' '+esc(cat.short||cat.label);
      lbl.addEventListener('click', function(e){
        if (e.target.tagName === 'INPUT') { lbl.classList.toggle('checked', e.target.checked); return; }
        e.preventDefault();
        var cb = lbl.querySelector('input'); cb.checked = !cb.checked;
        lbl.classList.toggle('checked', cb.checked);
      });
      catsEl.appendChild(lbl);
    });

    // Snapshot for change detection — include expiry value so period changes are detected
    var currentExpiry = (tool.newUntil && new Date(tool.newUntil) > new Date())
      ? Math.round((new Date(tool.newUntil) - Date.now()) / 86400000)
      : 0;
    S._editSnap = JSON.stringify({
      name: tool.name||'', url: tool.url||'', desc: tool.description||'',
      tags: (tool.tags||[]).join(', '),
      cats: (Array.isArray(tool.categories)&&tool.categories.length ? tool.categories : (tool.category?[tool.category]:[])).slice().sort().join(','),
      newUntil: !!(tool.newUntil && new Date(tool.newUntil) > new Date()),
      expiryDays: currentExpiry
    });
  }
  document.getElementById('tool-modal').classList.remove('hidden');
}

function closeToolModal(){
  document.getElementById('tool-modal').classList.add('hidden');
  // Always reset save button so modal can be reused immediately
  var btn = document.getElementById('tm-save');
  if (btn) { btn.disabled=false; btn.textContent='Save Tool'; }
  document.getElementById('tm-err').textContent='';
}

var tmRowCount = 0;
function tmAddRow() {
  tmRowCount++;
  var rowEl = document.createElement('div');
  rowEl.className = 'bm-tool-row';
  rowEl.style.marginBottom = '12px';
  var hdr = document.createElement('div');
  hdr.className = 'bm-tool-row-hdr';
  hdr.innerHTML = '<span class="bm-tool-num" style="font-weight:600;font-size:.82rem;color:#c0c0d8;">Tool '+tmRowCount+'</span>' +
    '<button class="btn btn-danger btn-sm bm-remove-btn" type="button" style="margin-left:auto;">🗑 Remove</button>';
  hdr.querySelector('.bm-remove-btn').addEventListener('click', function(){
    rowEl.remove();
    document.querySelectorAll('#tm-rows .bm-tool-row').forEach(function(r,i){
      var n=r.querySelector('.bm-tool-num'); if(n) n.textContent='Tool '+(i+1);
    });
  });
  rowEl.appendChild(hdr);
  var grid = document.createElement('div');
  grid.className = 'bm-tool-grid';
  grid.innerHTML =
    '<div><label>Name *</label><input class="bm-name" type="text" maxlength="100" placeholder="Tool name"/></div>' +
    '<div><label>URL *</label><input class="bm-url" type="url" maxlength="500" placeholder="https://example.com"/></div>' +
    '<div class="bm-full"><label>Description</label><input class="bm-desc" type="text" maxlength="200" placeholder="Short description…"/></div>' +
    '<div class="bm-full"><label>Tags (comma separated, no #)</label><input class="bm-tags" type="text" placeholder="ai, free, creative"/></div>' +
    '<div class="bm-full" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:4px;">' +
      '<label class="cat-check bm-new-lbl"><input type="checkbox" class="bm-new-check"/> Mark as New</label>' +
      '<select class="bm-new-expires" style="font-size:.74rem;padding:3px 6px;border-radius:7px;background:rgba(255,255,255,.04);border:1px solid var(--g-bdr);color:var(--txt);">' +
        '<option value="7">1 week</option><option value="30" selected>1 month</option><option value="90">3 months</option><option value="99999">Forever</option>' +
      '</select>' +
    '</div>';
  grid.querySelectorAll('.bm-new-lbl').forEach(function(lbl){
    lbl.addEventListener('click', function(e){
      if (e.target.tagName==='INPUT'){ lbl.classList.toggle('checked',e.target.checked); return; }
      e.preventDefault(); var cb=lbl.querySelector('input'); cb.checked=!cb.checked; lbl.classList.toggle('checked',cb.checked);
    });
  });
  rowEl.appendChild(grid);
  var catLabel = document.createElement('div');
  catLabel.style.cssText = 'font-size:.76rem;color:var(--mute);margin:8px 0 4px;';
  catLabel.textContent = 'Categories *';
  rowEl.appendChild(catLabel);
  var catWrap = document.createElement('div');
  catWrap.className = 'bm-tool-cats pend-cats';
  bmBuildCatChecks(catWrap);
  rowEl.appendChild(catWrap);
  var errEl = document.createElement('div');
  errEl.className = 'bm-row-err';
  errEl.style.cssText = 'color:#f87171;font-size:.76rem;min-height:14px;margin-top:4px;';
  rowEl.appendChild(errEl);
  document.getElementById('tm-rows').appendChild(rowEl);
}

document.getElementById('tm-cancel').addEventListener('click', closeToolModal);
document.getElementById('tm-close-x').addEventListener('click', closeToolModal);
document.getElementById('tool-modal').addEventListener('click', function(e){ if(e.target===this) closeToolModal(); });

document.getElementById('tm-save').addEventListener('click', function(){
  var errEl = document.getElementById('tm-err');
  errEl.textContent = '';
  var isNewTool = S.editToolIdx === -1;

  // ── MULTI-ADD MODE ──
  if (isNewTool) {
    var rows = document.querySelectorAll('#tm-rows .bm-tool-row');
    if (!rows.length) { errEl.textContent='Add at least one tool.'; return; }
    var tools = [], hasError = false;
    rows.forEach(function(row){
      var nv=sanitize(row.querySelector('.bm-name').value,100);
      var ru=row.querySelector('.bm-url').value;
      var dv=sanitize(row.querySelector('.bm-desc').value,200);
      var tv=row.querySelector('.bm-tags').value;
      var re=row.querySelector('.bm-row-err');
      var cats=[];
      row.querySelectorAll('.bm-tool-cats .cat-check.checked input').forEach(function(i){cats.push(i.value);});
      var ur=validateURL(ru);
      if(!nv){re.textContent='Name required.';hasError=true;return;}
      if(!ur.ok){re.textContent=ur.msg;hasError=true;return;}
      if(!cats.length){re.textContent='Select a category.';hasError=true;return;}
      var tags=tv.split(',').map(function(t){return t.trim().replace(/^#/,'').toLowerCase().slice(0,30);}).filter(Boolean).slice(0,15);
      var tool={name:nv,description:dv,url:ur.url,category:cats[0],tags:tags};
      if(cats.length>1) tool.categories=cats;
      var nc=row.querySelector('.bm-new-check'),ne=row.querySelector('.bm-new-expires');
      if(nc&&nc.checked&&ne){var d=parseInt(ne.value,10)||30;tool.newUntil=d>=99999?'9999-12-31T23:59:59.000Z':new Date(Date.now()+d*86400000).toISOString();}
      tools.push(tool);
    });
    if(hasError){errEl.textContent='Fix the errors above before saving.';return;}
    var snapLen=S.toolsData.tools.length;
    tools.forEach(function(t){S.toolsData.tools.push(t);});
    closeToolModal(); renderTools(); updateTabCounts(); maybeRefreshStats();
    scheduleWithUndo(
      tools.length+' tool(s) will be added — undo?',
      function(){return apiPut('tools.json',S.toolsData,S.toolsSha,'Add '+tools.length+' tool(s)').then(function(r){S.toolsSha=r.content.sha;});},
      function(){toast('Added '+tools.length+' tool(s)!','✅');maybeRefreshStats();},
      function(){S.toolsData.tools.splice(snapLen,tools.length);renderTools();updateTabCounts();maybeRefreshStats();}
    );
    return;
  }

  // ── SINGLE EDIT MODE — change detection ──
  var nameVal=sanitize(document.getElementById('tm-name').value,100);
  var rawUrl=document.getElementById('tm-url').value;
  var desc=sanitize(document.getElementById('tm-desc').value,200);
  var tagsRaw=document.getElementById('tm-tags').value;
  var urlRes=validateURL(rawUrl);
  if(!nameVal){errEl.textContent='Name required.';return;}
  if(!urlRes.ok){errEl.textContent=urlRes.msg;return;}
  var catEls=document.querySelectorAll('#tm-cats .cat-check.checked input');
  if(!catEls.length){errEl.textContent='Select at least one category.';return;}
  var catIds=Array.from(catEls).map(function(el){return el.value;});
  var tags=tagsRaw.split(',').map(function(t){return t.trim().replace(/^#/,'').toLowerCase().slice(0,30);}).filter(Boolean).slice(0,15);
  var newChk=document.getElementById('tm-new-check');
  var nowNew=!!(newChk&&newChk.checked);

  // Change detection
  var newExp=document.getElementById('tm-new-expires');
  var selectedDays = (newChk&&newChk.checked&&newExp) ? (parseInt(newExp.value,10)||30) : 0;
  var nowSnap=JSON.stringify({
    name:nameVal,url:urlRes.url,desc:desc,tags:tags.join(', '),
    cats:catIds.slice().sort().join(','),
    newUntil:nowNew,
    expiryDays:selectedDays
  });
  if(nowSnap===S._editSnap){errEl.textContent='No changes to save.';return;}

  var tool={name:nameVal,description:desc,url:urlRes.url,category:catIds[0],tags:tags};
  if(catIds.length>1) tool.categories=catIds;
  if(newChk&&newChk.checked&&newExp){
    var days=parseInt(newExp.value,10)||30;
    tool.newUntil=days>=99999?'9999-12-31T23:59:59.000Z':new Date(Date.now()+days*86400000).toISOString();
  }
  var snapTools=JSON.parse(JSON.stringify(S.toolsData.tools));
  S.toolsData.tools[S.editToolIdx]=tool;
  closeToolModal(); renderTools(); updateTabCounts(); maybeRefreshStats();
  scheduleWithUndo(
    '"'+nameVal+'" changes saved — undo?',
    function(){return apiPut('tools.json',S.toolsData,S.toolsSha,'Edit tool: '+nameVal).then(function(r){S.toolsSha=r.content.sha;});},
    function(){toast('Updated "'+nameVal+'"','✅');maybeRefreshStats();},
    function(){S.toolsData.tools=snapTools;renderTools();updateTabCounts();maybeRefreshStats();}
  );
});

function deleteTool(idx) {
  var tool = S.toolsData.tools[idx];
  var snap = JSON.parse(JSON.stringify(S.toolsData));
  S.toolsData.tools.splice(idx,1);
  renderTools(toolsSearchQ); updateTabCounts(); maybeRefreshStats();
  scheduleWithUndo(
    '"'+tool.name+'" will be deleted in 10s…',
    function(){ return apiPut('tools.json',S.toolsData,S.toolsSha,'Delete tool: '+tool.name).then(function(r){S.toolsSha=r.content.sha;}); },
    function(){ toast('Deleted "'+tool.name+'"','🗑️'); maybeRefreshStats(); },
    function(){ S.toolsData=snap; renderTools(toolsSearchQ); updateTabCounts(); maybeRefreshStats(); }
  );
}

// add-tool is handled by the FAB (#add-tool-fab)

function bmBuildCatChecks(container) {
  container.innerHTML = '';
  (S.toolsData.categories || []).forEach(function(cat) {
    var lbl = document.createElement('label');
    lbl.className = 'cat-check';
    lbl.dataset.cid = cat.id;
    lbl.innerHTML = '<input type="checkbox" value="' + esc(cat.id) + '"/>' + esc(cat.icon) + ' ' + esc(cat.short || cat.label);
    lbl.addEventListener('click', function(e) {
      if (e.target.tagName === 'INPUT') { lbl.classList.toggle('checked', e.target.checked); return; }
      e.preventDefault();
      var cb = lbl.querySelector('input'); cb.checked = !cb.checked;
      lbl.classList.toggle('checked', cb.checked);
    });
    container.appendChild(lbl);
  });
}

function bmAddRow() {
  bmRowCount++;
  var rowEl = document.createElement('div');
  rowEl.className = 'bm-tool-row';

  var hdr = document.createElement('div');
  hdr.className = 'bm-tool-row-hdr';
  hdr.innerHTML =
    '<span class="bm-tool-num">Tool ' + bmRowCount + '</span>' +
    '<button class="bm-remove-btn" type="button">🗑 Remove</button>';
  hdr.querySelector('.bm-remove-btn').addEventListener('click', function() {
    rowEl.remove(); renumberRows();
  });
  rowEl.appendChild(hdr);

  var grid = document.createElement('div');
  grid.className = 'bm-tool-grid';
  grid.innerHTML =
    '<div><label>Name *</label><input class="bm-name" type="text" maxlength="100" placeholder="Tool name"/></div>' +
    '<div><label>URL *</label><input class="bm-url" type="url" maxlength="500" placeholder="https://example.com"/></div>' +
    '<div class="bm-full"><label>Description</label><input class="bm-desc" type="text" maxlength="200" placeholder="Short description…"/></div>' +
    '<div class="bm-full"><label>Tags (comma separated, no #)</label><input class="bm-tags" type="text" placeholder="ai, free, creative"/></div>' +
    '<div class="bm-full" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:4px;">' +
      '<label class="cat-check bm-new-lbl"><input type="checkbox" class="bm-new-check"/> Mark as New</label>' +
      '<select class="bm-new-expires" style="font-size:.74rem;padding:3px 6px;border-radius:7px;background:rgba(255,255,255,.04);border:1px solid var(--g-bdr);color:var(--txt);">' +
        '<option value="7">1 week</option>' +
        '<option value="30" selected>1 month</option>' +
        '<option value="90">3 months</option>' +
        '<option value="99999">Forever</option>' +
      '</select>' +
    '</div>';
  // Wire new-tag checkbox in bulk add row
  grid.querySelectorAll('.bm-new-lbl').forEach(function(lbl){
    lbl.addEventListener('click', function(e){
      if (e.target.tagName === 'INPUT') { lbl.classList.toggle('checked', e.target.checked); return; }
      e.preventDefault();
      var cb = lbl.querySelector('input'); cb.checked = !cb.checked;
      lbl.classList.toggle('checked', cb.checked);
    });
  });
  rowEl.appendChild(grid);

  var catLabel = document.createElement('div');
  catLabel.className = 'bm-cat-label';
  catLabel.textContent = 'Categories *';
  rowEl.appendChild(catLabel);

  var catWrap = document.createElement('div');
  catWrap.className = 'bm-tool-cats pend-cats';
  bmBuildCatChecks(catWrap);
  rowEl.appendChild(catWrap);

  var errEl = document.createElement('div');
  errEl.className = 'bm-row-err';
  rowEl.appendChild(errEl);

  document.getElementById('bm-rows').appendChild(rowEl);
}

function renumberRows() {
  document.querySelectorAll('#bm-rows .bm-tool-row').forEach(function(row, i) {
    var n = row.querySelector('.bm-tool-num');
    if (n) n.textContent = 'Tool ' + (i + 1);
  });
}

function closeBulkModal() {
  document.getElementById('bulk-modal').classList.add('hidden');
}

function openBulkModal() {
  bmRowCount = 0;
  document.getElementById('bm-rows').innerHTML = '';
  document.getElementById('bm-err').textContent = '';
  bmBuildCatChecks(document.getElementById('bm-global-cats'));
  bmAddRow();
  document.getElementById('bulk-modal').classList.remove('hidden');
}

document.getElementById('bm-apply-all').addEventListener('click', function() {
  var globalIds = [];
  document.querySelectorAll('#bm-global-cats .cat-check.checked input').forEach(function(i) { globalIds.push(i.value); });
  if (!globalIds.length) { document.getElementById('bm-err').textContent = 'Select at least one category in the "Apply to all" strip first.'; return; }
  document.getElementById('bm-err').textContent = '';
  document.querySelectorAll('#bm-rows .bm-tool-row').forEach(function(row) {
    row.querySelectorAll('.bm-tool-cats .cat-check').forEach(function(lbl) {
      var cb = lbl.querySelector('input');
      if (globalIds.indexOf(cb.value) !== -1) { cb.checked = true; lbl.classList.add('checked'); }
    });
  });
});

document.getElementById('bm-add-row').addEventListener('click', function() { bmAddRow(); });

document.getElementById('bm-save').addEventListener('click', function() {
  var errEl = document.getElementById('bm-err');
  errEl.textContent = '';
  document.querySelectorAll('#bm-rows .bm-row-err').forEach(function(e) { e.textContent = ''; });

  var rows = document.querySelectorAll('#bm-rows .bm-tool-row');
  if (!rows.length) { errEl.textContent = 'Add at least one tool.'; return; }

  var tools = [], hasError = false;
  rows.forEach(function(row) {
    var nameVal = sanitize(row.querySelector('.bm-name').value, 100);
    var rawUrl  = row.querySelector('.bm-url').value;
    var desc    = sanitize(row.querySelector('.bm-desc').value, 200);
    var tagsRaw = row.querySelector('.bm-tags').value;
    var rowErr  = row.querySelector('.bm-row-err');
    var cats = [];
    row.querySelectorAll('.bm-tool-cats .cat-check.checked input').forEach(function(cb) { cats.push(cb.value); });
    var urlRes = validateURL(rawUrl);
    if (!nameVal)     { rowErr.textContent = 'Name is required.';             hasError = true; return; }
    if (!urlRes.ok)   { rowErr.textContent = urlRes.msg;                      hasError = true; return; }
    if (!cats.length) { rowErr.textContent = 'Select at least one category.'; hasError = true; return; }
    var tags = tagsRaw.split(',').map(function(t) { return t.trim().replace(/^#/, '').toLowerCase().slice(0,30); }).filter(Boolean).slice(0,15);
    var tool = { name: nameVal, description: desc, url: urlRes.url, category: cats[0], tags: tags };
    if (cats.length > 1) tool.categories = cats;
    var bmNewChk = row.querySelector('.bm-new-check');
    var bmNewExp = row.querySelector('.bm-new-expires');
    if (bmNewChk && bmNewChk.checked && bmNewExp) {
      var bmDays = parseInt(bmNewExp.value, 10) || 30;
      tool.newUntil = bmDays >= 99999 ? '9999-12-31T23:59:59.000Z' : new Date(Date.now() + bmDays*86400000).toISOString();
    }
    tools.push(tool);
  });

  if (hasError) { errEl.textContent = 'Fix the errors above before saving.'; return; }

  var snapLen = S.toolsData.tools.length;
  tools.forEach(function(t) { S.toolsData.tools.push(t); });
  closeBulkModal();
  renderTools(); updateTabCounts(); maybeRefreshStats();

  scheduleWithUndo(
    tools.length + ' tool(s) will be added — undo?',
    function(){ return apiPut('tools.json', S.toolsData, S.toolsSha, 'Bulk add '+tools.length+' tool(s)').then(function(res){ S.toolsSha=res.content.sha; }); },
    function(){ toast('Added '+tools.length+' tool(s)!','✅'); maybeRefreshStats(); },
    function(){ S.toolsData.tools.splice(snapLen, tools.length); renderTools(); updateTabCounts(); maybeRefreshStats(); }
  );
});

document.getElementById('bm-cancel').addEventListener('click', closeBulkModal);
document.getElementById('bm-close').addEventListener('click', closeBulkModal);
document.getElementById('bulk-modal').addEventListener('click', function(e) { if (e.target === this) closeBulkModal(); });

// ── Bulk New Tag ──────────────────────────────────────────────
var bnSelected = new Set();

function openBulkNewModal() {
  bnSelected.clear();
  document.getElementById('bn-search').value = '';
  document.getElementById('bn-err').textContent = '';
  document.getElementById('bulk-new-modal').classList.remove('hidden');
  renderBnList('');
}
function closeBulkNewModal() {
  document.getElementById('bulk-new-modal').classList.add('hidden');
}
var bnSortMode = 'default';
function renderBnList(q) {
  var list = document.getElementById('bn-tool-list');
  var tools = (S.toolsData && S.toolsData.tools) ? S.toolsData.tools : [];
  var filtered = q ? tools.filter(function(t){
    return (t.name+' '+(t.description||'')).toLowerCase().includes(q.toLowerCase());
  }) : tools.slice();
  if (bnSortMode === 'az') {
    filtered = filtered.slice().sort(function(a,b){ return a.name.toLowerCase().localeCompare(b.name.toLowerCase()); });
  } else if (bnSortMode === 'recent') {
    filtered = filtered.slice().reverse();
  }
  list.innerHTML = '';
  filtered.forEach(function(tool) {
    var idx = tools.indexOf(tool);
    var isNew = !!(tool.newUntil && new Date(tool.newUntil) > new Date());
    var daysLeft = isNew ? Math.ceil((new Date(tool.newUntil)-new Date())/86400000) : 0;
    var row = document.createElement('label');
    row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:7px 10px;border-radius:7px;cursor:pointer;-webkit-tap-highlight-color:transparent;';
    if (bnSelected.has(idx)) row.classList.add('bn-selected');
    var cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.setAttribute('data-idx', idx);
    cb.checked = bnSelected.has(idx);
    cb.style.cssText = 'width:16px;height:16px;flex-shrink:0;cursor:pointer;accent-color:#6c63ff;';
    var nameSpan = document.createElement('span');
    nameSpan.style.cssText = 'flex:1;font-size:.82rem;color:#ddddf0;';
    nameSpan.textContent = tool.name;
    row.appendChild(cb);
    row.appendChild(nameSpan);
    if (isNew) {
      var badge = document.createElement('span');
      badge.style.cssText = 'font-size:.66rem;color:#6ee7b7;border:1px solid rgba(16,185,129,.4);border-radius:4px;padding:1px 5px;flex-shrink:0;';
      badge.textContent = 'NEW·'+daysLeft+'d';
      row.appendChild(badge);
    }
    cb.addEventListener('change', function(){
      if (this.checked) { bnSelected.add(idx); row.classList.add('bn-selected'); }
      else { bnSelected.delete(idx); row.classList.remove('bn-selected'); }
      document.getElementById('bn-selected-count').textContent = bnSelected.size + ' selected';
    });
    list.appendChild(row);
  });
  document.getElementById('bn-selected-count').textContent = bnSelected.size + ' selected';
}

document.getElementById('bn-search').addEventListener('input', function(){ renderBnList(this.value); });
document.querySelectorAll('.bn-sort-btn').forEach(function(btn){
  btn.addEventListener('click', function(){
    var wasActive = btn.classList.contains('active');
    var clicked = btn.getAttribute('data-bnsort');
    document.querySelectorAll('.bn-sort-btn').forEach(function(b){ b.classList.remove('active'); });
    // Toggle: clicking active non-default sort reverts to default
    if (wasActive && clicked !== 'default') {
      document.querySelector('.bn-sort-btn[data-bnsort="default"]').classList.add('active');
      bnSortMode = 'default';
    } else {
      btn.classList.add('active');
      bnSortMode = clicked;
    }
    renderBnList(document.getElementById('bn-search').value);
  });
});
document.getElementById('bn-select-all').addEventListener('click', function(){
  var tools = (S.toolsData && S.toolsData.tools) ? S.toolsData.tools : [];
  var q = document.getElementById('bn-search').value;
  var filtered = q ? tools.filter(function(t){
    return (t.name+' '+(t.description||'')).toLowerCase().includes(q.toLowerCase());
  }) : tools;
  var allSelected = filtered.every(function(t){ return bnSelected.has(tools.indexOf(t)); });
  if (allSelected) {
    // Deselect all visible
    filtered.forEach(function(t){ bnSelected.delete(tools.indexOf(t)); });
    document.getElementById('bn-select-all').textContent = 'Select All Visible';
  } else {
    filtered.forEach(function(t){ bnSelected.add(tools.indexOf(t)); });
    document.getElementById('bn-select-all').textContent = 'Deselect All';
  }
  renderBnList(q);
});
document.getElementById('bn-cancel').addEventListener('click', closeBulkNewModal);
document.getElementById('bulk-new-modal').addEventListener('click', function(e){ if(e.target===this) closeBulkNewModal(); });
document.getElementById('bulk-new-btn').addEventListener('click', openBulkNewModal);
document.getElementById('bn-save').addEventListener('click', function(){
  var errEl = document.getElementById('bn-err');
  if (!bnSelected.size) { errEl.textContent = 'Select at least one tool.'; return; }
  var days = parseInt(document.getElementById('bn-expires').value, 10) || 30;
  var until = new Date(Date.now() + days * 86400000).toISOString();
  var snap = JSON.parse(JSON.stringify(S.toolsData.tools));
  bnSelected.forEach(function(idx){
    if (S.toolsData.tools[idx]) S.toolsData.tools[idx].newUntil = until;
  });
  var count = bnSelected.size;
  closeBulkNewModal();
  renderTools(toolsSearchQ);
  scheduleWithUndo(
    count+' tool(s) marked as New — undo?',
    function(){ return apiPut('tools.json', S.toolsData, S.toolsSha, 'Bulk new tag: '+count+' tools').then(function(r){ S.toolsSha=r.content.sha; }); },
    function(){ toast(count+' tool(s) marked as New!','🆕'); },
    function(){ S.toolsData.tools=snap; renderTools(toolsSearchQ); }
  );
});
document.querySelectorAll('.sort-btn-sm').forEach(function(btn){
  btn.addEventListener('click', function(){
    var isActive  = btn.classList.contains('active');
    var clicked   = btn.getAttribute('data-sort');
    document.querySelectorAll('.sort-btn-sm').forEach(function(b){ b.classList.remove('active'); });
    // Toggle: clicking the active non-default sort resets to Default
    if (isActive && clicked !== 'default') {
      document.querySelector('.sort-btn-sm[data-sort="default"]').classList.add('active');
      S.toolsSortMode = 'default';
    } else {
      btn.classList.add('active');
      S.toolsSortMode = clicked;
    }
    renderTools(toolsSearchQ);
  });
});
document.getElementById('tools-search').addEventListener('input', function(){ renderTools(this.value); });

// ═══════════════════════════════════════════════════════
// ── CATEGORIES TAB ──
// ═══════════════════════════════════════════════════════
var editCatIdx = -1;

function renderCategories() {
  var loading = document.getElementById('cats-loading');
  var list = document.getElementById('cats-list');
  loading.classList.add('hidden');
  list.classList.remove('hidden');

  var cats = (S.toolsData && S.toolsData.categories) ? S.toolsData.categories : [];
  document.getElementById('cats-count').textContent = cats.length; updateTabCounts();
  list.innerHTML = '';

  cats.forEach(function(cat, idx){
    var toolCount = S.toolsData.tools.filter(function(t){
      if (Array.isArray(t.categories) && t.categories.length) return t.categories.indexOf(cat.id)!==-1;
      return t.category===cat.id;
    }).length;
    var sc = safeColor(cat.color);
    var isFirst = idx === 0;
    var isLast  = idx === cats.length - 1;
    var row = document.createElement('div');
    row.className = 'cat-row glass';
    row.innerHTML =
      '<div class="cat-icon-preview" style="background:'+sc+'22;border:1px solid '+sc+'55">'+esc(cat.icon||'')+'</div>' +
      '<div style="flex:1;min-width:0;">' +
        '<div style="font-weight:600;color:#ddddf0;font-size:.88rem;">'+esc(cat.label)+'</div>' +
        '<div style="font-size:.72rem;color:var(--mute);">ID: '+esc(cat.id)+'&nbsp;·&nbsp;'+toolCount+' tools</div>' +
      '</div>' +
      '<div style="width:14px;height:14px;border-radius:50%;background:'+sc+';flex-shrink:0;"></div>' +
      '<div class="cat-move-btns">' +
        '<button class="btn btn-ghost btn-sm cat-move-up" title="Move up"'+(isFirst?' disabled':'')+' style="padding:4px 7px;font-size:.8rem;">▲</button>' +
        '<button class="btn btn-ghost btn-sm cat-move-dn" title="Move down"'+(isLast?' disabled':'')+' style="padding:4px 7px;font-size:.8rem;">▼</button>' +
      '</div>' +
      '<button class="btn btn-ghost btn-sm" title="Edit">✎</button>' +
      '<button class="btn btn-danger btn-sm" title="Delete">🗑</button>';

    row.querySelector('.cat-move-up').addEventListener('click', function(){ if(!isFirst) moveCat(idx, idx-1); });
    row.querySelector('.cat-move-dn').addEventListener('click', function(){ if(!isLast)  moveCat(idx, idx+1); });
    row.querySelector('[title=Edit]').addEventListener('click', function(){ openCatModal(idx); });
    row.querySelector('[title=Delete]').addEventListener('click', function(){
      if (toolCount>0 && !confirm(toolCount+' tools use this category. Still delete it?')) return;
      if (!confirm('Delete category "'+cat.label+'"?')) return;
      deleteCat(idx);
    });
    list.appendChild(row);
  });
}

function moveCat(fromIdx, toIdx) {
  var snap = JSON.parse(JSON.stringify(S.toolsData));
  var cats = S.toolsData.categories;
  var tmp = cats[fromIdx]; cats[fromIdx] = cats[toIdx]; cats[toIdx] = tmp;
  renderCategories();
  apiPut('tools.json', S.toolsData, S.toolsSha, 'Reorder categories')
    .then(function(res){ S.toolsSha = res.content.sha; toast('Category order saved', '✅'); })
    .catch(function(e){ toast('Error: '+e.message, '❌'); S.toolsData = snap; renderCategories(); });
}

function openCatModal(idx) {
  editCatIdx = idx;
  var isNew = idx === -1;
  document.getElementById('cat-modal-title').textContent = isNew ? 'Add Category' : 'Edit Category';
  document.getElementById('cm-err').textContent = '';
  var cat = isNew ? { id:'', label:'', short:'', icon:'📦', color:'#6c63ff' }
                  : S.toolsData.categories[idx];
  // Show ID field only when creating — it's a permanent slug that can't change
  var idRow = document.getElementById('cm-id-row');
  if (idRow) idRow.style.display = isNew ? '' : 'none';
  document.getElementById('cm-id').value = cat.id||'';
  document.getElementById('cm-id').disabled = !isNew;
  document.getElementById('cm-label').value = cat.label||'';
  document.getElementById('cm-short').value = cat.short||'';
  document.getElementById('cm-icon').value = cat.icon||'';
  document.getElementById('cm-color').value = cat.color||'#6c63ff';
  document.getElementById('cm-color-text').value = cat.color||'#6c63ff';
  document.getElementById('cat-modal').classList.remove('hidden');
}

function closeCatModal(){
  document.getElementById('cat-modal').classList.add('hidden');
  var btn = document.getElementById('cm-save');
  if (btn) { btn.disabled=false; btn.textContent='Save Category'; }
  document.getElementById('cm-err').textContent='';
}

document.getElementById('cm-cancel').addEventListener('click', closeCatModal);
document.getElementById('cat-modal').addEventListener('click', function(e){ if(e.target===this) closeCatModal(); });

// Sync color picker and text
document.getElementById('cm-color').addEventListener('input', function(){
  document.getElementById('cm-color-text').value = this.value;
});
document.getElementById('cm-color-text').addEventListener('input', function(){
  if (/^#[0-9a-fA-F]{6}$/.test(this.value)) document.getElementById('cm-color').value = this.value;
});

document.getElementById('cm-save').addEventListener('click', function(){
  var id    = sanitize(document.getElementById('cm-id').value,40).replace(/\s+/g,'-').toLowerCase();
  var label = sanitize(document.getElementById('cm-label').value,60);
  var short = sanitize(document.getElementById('cm-short').value,20);
  var icon  = sanitize(document.getElementById('cm-icon').value,4);
  var color = document.getElementById('cm-color').value;
  var errEl = document.getElementById('cm-err');

  if (!id)    { errEl.textContent='ID required.'; return; }
  if (!label) { errEl.textContent='Label required.'; return; }
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) { errEl.textContent='Invalid colour (use #rrggbb).'; return; }

  // Check duplicate ID for new category
  if (editCatIdx===-1 && S.toolsData.categories.find(function(c){ return c.id===id; })) {
    errEl.textContent='ID "'+id+'" already exists.'; return;
  }

  var cat = { id:id, label:label, short:short||label, icon:icon||'📦', color:color };
  var btn = document.getElementById('cm-save');
  btn.disabled=true; btn.textContent='Saving…'; errEl.textContent='';

  var isNew = editCatIdx===-1;
  if (isNew) { S.toolsData.categories.push(cat); }
  else { S.toolsData.categories[editCatIdx] = Object.assign(S.toolsData.categories[editCatIdx], cat); }

  apiPut('tools.json', S.toolsData, S.toolsSha, (isNew?'Add':'Edit')+' category: '+label)
    .then(function(res){
      S.toolsSha=res.content.sha;
      toast((isNew?'Added':'Updated')+' category "'+label+'"','✅');
      btn.disabled=false; btn.textContent='Save Category';
      closeCatModal(); renderCategories(); maybeRefreshStats();
    })
    .catch(function(e){
      btn.disabled=false; btn.textContent='Save Category';
      errEl.textContent='Error: '+e.message;
      if(isNew) S.toolsData.categories.pop();
    });
});

function deleteCat(idx) {
  var cat = S.toolsData.categories[idx];
  var snap = JSON.parse(JSON.stringify(S.toolsData));
  S.toolsData.categories.splice(idx,1); renderCategories(); maybeRefreshStats();
  scheduleWithUndo(
    'Category "'+cat.label+'" will be deleted in 10s…',
    function(){ return apiPut('tools.json',S.toolsData,S.toolsSha,'Delete category: '+cat.label).then(function(r){S.toolsSha=r.content.sha;}); },
    function(){ toast('Deleted category','🗑️'); maybeRefreshStats(); },
    function(){ S.toolsData=snap; renderCategories(); maybeRefreshStats(); }
  );
}

document.getElementById('add-cat-btn').addEventListener('click', function(){ openCatModal(-1); });

// ═══════════════════════════════════════════════════════
// TABS
// ═══════════════════════════════════════════════════════
document.querySelectorAll('.tab-btn').forEach(function(btn){
  btn.addEventListener('click', function(){
    document.querySelectorAll('.tab-btn').forEach(function(b){ b.classList.remove('active'); });
    document.querySelectorAll('.tab-content').forEach(function(c){ c.classList.remove('active'); });
    btn.classList.add('active');
    var tab = btn.getAttribute('data-tab');
    document.getElementById('tab-'+tab).classList.add('active');
    S.activeTab = tab;
    window.scrollTo(0, 0);
    // Move liquid glass indicator
    moveLiquidIndicator(btn);
    // Show FAB only on tools tab
    var fab = document.getElementById('add-tool-fab');
    if (fab) fab.classList.toggle('visible', tab === 'tools');
    if (tab === 'stats') renderStats();
    if (tab === 'history') fetchHistory();
    if (tab === 'analytics') initAnalyticsTab();
    if (tab === 'home') initHomeTab();
    if (tab === 'preview') {
      requestAnimationFrame(function(){
        var activeBtn = document.querySelector('.device-btn.active');
        var device = activeBtn ? activeBtn.getAttribute('data-device') : 'desktop';
        applyPreviewDevice(device);
      });
    }
  });
});

// ── Liquid glass tab indicator ────────────────────────────────
function moveLiquidIndicator(activeBtn) {
  var ind = document.getElementById('tab-indicator');
  var bar = document.querySelector('.tabs-bar');
  if (!ind || !bar || !activeBtn) return;
  var barRect = bar.getBoundingClientRect();
  var btnRect = activeBtn.getBoundingClientRect();
  var left = btnRect.left - barRect.left + bar.scrollLeft;
  ind.style.left = left + 'px';
  ind.style.width = btnRect.width + 'px';
}
// Set initial position after DOM ready
requestAnimationFrame(function(){
  var active = document.querySelector('.tab-btn.active');
  if (active) moveLiquidIndicator(active);
});

// ── Home Tab ──────────────────────────────────────────────────
function initHomeTab() {
  // Sync user info
  var homeGhUser = document.getElementById('home-gh-user');
  if (homeGhUser) homeGhUser.textContent = S.ghUser ? '@'+S.ghUser : '—';

  // Segmented auto-logout selector
  var saved = localStorage.getItem('a_idle_mins') || '30';
  document.querySelectorAll('.tseg-btn').forEach(function(btn){
    btn.classList.toggle('active', btn.getAttribute('data-val') === saved);
  });

  // Load sessions + temp-pass status from settings.json
  apiGet('settings.json').then(function(d){
    S.settingsSha = d.sha;
    renderSessions(d.content);
    renderTempPassStatus(d.content);
  }).catch(function(){ renderSessions({}); renderTempPassStatus({}); });
}

function renderSessions(cfg) {
  var list = document.getElementById('sessions-list');
  if (!list) return;
  var sessions = Array.isArray(cfg.sessions) ? cfg.sessions : [];
  if (!sessions.length) {
    list.innerHTML = '<div class="home-empty-msg">No sessions recorded yet.</div>';
    return;
  }
  list.innerHTML = sessions.map(function(s){
    var isCurrent = s.id === S.sessionId;
    var loginTime = s.loginAt ? new Date(s.loginAt).toLocaleString() : '—';
    return '<div class="session-card'+(isCurrent?' current':'')+'">'
      +'<div style="flex:1;">'
        +'<div class="session-device">'+esc(s.device||'Unknown device')+'</div>'
        +'<div class="session-meta">Logged in: '+esc(loginTime)+'</div>'
      +'</div>'
      +(s.isTemp ? '<span class="session-badge temp">Temp</span>' : '')
      +(isCurrent
        ? '<span class="session-badge">This device</span>'
        : '<button class="btn btn-danger btn-sm" onclick="doForceLogout(\''+esc(s.id)+'\')">Logout</button>'
      )
    +'</div>';
  }).join('');
}

function renderTempPassStatus(cfg) {
  var banner = document.getElementById('temp-status-banner');
  var deleteBtn = document.getElementById('temp-delete-btn');
  if (!banner) return;

  var hasHash = !!cfg.tempPasswordHash;
  var expiry = cfg.tempPasswordExpiry;
  var isExpired = hasHash && expiry > 0 && Date.now() > expiry;
  var isNeverExpires = hasHash && (expiry === 0 || expiry === -1);
  var isUntilDeleted = hasHash && expiry === -1;

  banner.className = 'temp-status';
  if (!hasHash) {
    banner.classList.add('hidden');
    if (deleteBtn) deleteBtn.classList.add('hidden');
  } else if (isExpired) {
    banner.textContent = '⚠ Temporary password has expired and is no longer valid.';
    banner.classList.add('expired-temp');
    if (deleteBtn) deleteBtn.classList.remove('hidden');
  } else {
    var expiryStr = isNeverExpires ? 'Never expires' : isUntilDeleted ? 'Until deleted' : 'Expires: '+new Date(expiry).toLocaleString();
    banner.textContent = '✓ Temporary password is active. '+expiryStr+'.';
    banner.classList.add('active-temp');
    if (deleteBtn) deleteBtn.classList.remove('hidden');
  }
}

function doForceLogout(sessionId) {
  if (!confirm('Force logout this device?')) return;
  forceLogoutSession(sessionId).then(function(){ initHomeTab(); }).catch(function(e){ toast('Error: '+e.message,'❌'); });
}

// Segmented selector click
document.getElementById('timeout-seg').addEventListener('click', function(e){
  var btn = e.target.closest('.tseg-btn');
  if (!btn) return;
  document.querySelectorAll('.tseg-btn').forEach(function(b){ b.classList.remove('active'); });
  btn.classList.add('active');
});

// Save auto-logout
document.getElementById('save-timeout-btn').addEventListener('click', function(){
  var active = document.querySelector('.tseg-btn.active');
  if (!active) return;
  var minsVal = active.getAttribute('data-val');
  var labelMap = {'1':'1 min','10':'10 min','30':'30 min','60':'1 hour','0':'Never'};
  var label = labelMap[minsVal] || minsVal+' min';
  var btn = document.getElementById('save-timeout-btn');
  var msg = document.getElementById('timeout-saved-msg');

  localStorage.setItem('a_idle_mins', minsVal);
  SESSION_MS = getIdleTimeoutMs();
  resetIdleTimer();

  btn.disabled = true; btn.textContent = 'Saving…';
  apiGet('settings.json').then(function(d){
    S.settingsSha = d.sha;
    var data = d.content;
    data.autoLogoutMins = parseInt(minsVal, 10);
    return apiPut('settings.json', data, S.settingsSha, 'Update auto-logout setting');
  }).then(function(res){
    S.settingsSha = res.content.sha;
    msg.textContent = '✓ Saved — '+label;
    msg.style.opacity = '1';
    setTimeout(function(){ msg.style.opacity = '0'; }, 2500);
    toast('Auto-logout: '+label, '⏱');
  }).catch(function(e){
    msg.textContent = '⚠ Local only';
    msg.style.opacity = '1';
    setTimeout(function(){ msg.style.opacity = '0'; }, 2500);
    toast('Local save only — '+e.message, '⚠️');
  }).finally(function(){ btn.disabled=false; btn.textContent='Save'; });
});

// Create temp password
document.getElementById('temp-create-btn').addEventListener('click', function(){
  var pw = document.getElementById('temp-pass-input').value;
  var expiry = document.getElementById('temp-expiry-sel').value;
  var errEl = document.getElementById('temp-pass-err');
  var savingEl = document.getElementById('temp-saving-msg');
  errEl.textContent = '';
  if (!pw || pw.length < 6) { errEl.textContent = 'Password must be at least 6 characters.'; return; }

  var btn = document.getElementById('temp-create-btn');
  btn.disabled = true; btn.textContent = 'Creating…';
  savingEl.textContent = 'Hashing and saving…';

  createTempPassword(pw, parseInt(expiry, 10))
    .then(function(){
      document.getElementById('temp-pass-input').value = '';
      savingEl.textContent = '';
      toast('Temporary password created', '🔑');
      initHomeTab();
    })
    .catch(function(e){
      savingEl.textContent = '';
      errEl.textContent = 'Error: '+e.message;
    })
    .finally(function(){ btn.disabled=false; btn.textContent='Create Temp Password'; });
});

// Delete temp password
document.getElementById('temp-delete-btn').addEventListener('click', function(){
  if (!confirm('Delete the temporary password? It will immediately stop working.')) return;
  var btn = document.getElementById('temp-delete-btn');
  btn.disabled = true; btn.textContent = 'Deleting…';
  deleteTempPassword()
    .then(function(){
      toast('Temporary password deleted', '🗑️');
      initHomeTab();
    })
    .catch(function(e){ toast('Error: '+e.message,'❌'); })
    .finally(function(){ btn.disabled=false; btn.textContent='🗑 Delete Temp Password'; });
});

// ── FAB: Add Tool floating button ─────────────────────────────
(function(){
  var fab = document.getElementById('add-tool-fab');
  if (!fab) return;
  fab.addEventListener('click', function(){
    fab.classList.remove('water-pop');
    void fab.offsetWidth; // reflow to restart animation
    fab.classList.add('water-pop');
    fab.addEventListener('animationend', function onEnd(){
      fab.classList.remove('water-pop');
      fab.removeEventListener('animationend', onEnd);
    });
    openToolModal(-1);
  });
})();

// ── Device toggle for site preview ────────────────────────────
function applyPreviewDevice(device) {
  var wrap  = document.getElementById('preview-wrap');
  var frame = document.getElementById('site-preview-frame');
  if (!wrap || !frame) return;

  // Measure container BEFORE any style changes to avoid feedback loop
  var containerW = wrap.getBoundingClientRect().width || 1280;
  var containerH = wrap.getBoundingClientRect().height ||
                   (window.innerHeight - 160);

  // Reset all transforms and sizing first
  frame.style.transform       = '';
  frame.style.transformOrigin = '';
  frame.style.width           = '';
  frame.style.borderRadius    = '';
  wrap.style.height           = '';
  wrap.className = 'preview-wrap ' + device;

  var DEVICE_W = device === 'mobile' ? 390
               : device === 'tablet' ? 768
               : 1280;

  frame.style.width        = DEVICE_W + 'px';
  frame.style.borderRadius = device === 'mobile' ? '20px'
                           : device === 'tablet' ? '14px' : '12px';

  // Scale to fit container for all device modes
  var scale = Math.min(1, containerW / DEVICE_W);
  frame.style.transform       = 'scale(' + scale + ')';
  frame.style.transformOrigin = 'top left';

  // Set wrap height so content below doesn't overlap
  var frameH = Math.max(containerH, 400);
  wrap.style.height = Math.round(frameH * scale) + 'px';
  wrap.style.overflow = 'hidden';
}

document.querySelectorAll('.device-btn').forEach(function(btn){
  btn.addEventListener('click', function(){
    document.querySelectorAll('.device-btn').forEach(function(b){ b.classList.remove('active'); });
    btn.classList.add('active');
    applyPreviewDevice(btn.getAttribute('data-device'));
  });
});

// ── Analytics tab ─────────────────────────────────────────────
function initAnalyticsTab() {
  var savedUrl = localStorage.getItem('mr_analytics_url') || '';
  var inp = document.getElementById('analytics-url');
  if (inp && savedUrl && !inp.value) inp.value = savedUrl;
  if (savedUrl) loadAnalyticsFrame(savedUrl);
}

function loadAnalyticsFrame(url) {
  var frame    = document.getElementById('analytics-frame');
  var wrap     = document.getElementById('analytics-frame-wrap');
  var setup    = document.getElementById('analytics-setup');
  if (!frame || !url) return;
  // Clean URL
  url = url.trim().replace(/\/+$/, '');
  frame.src = url;
  wrap.classList.remove('hidden');
  setup.style.display = 'none';
  localStorage.setItem('mr_analytics_url', url);
}

document.getElementById('analytics-load-btn').addEventListener('click', function(){
  var url = (document.getElementById('analytics-url').value || '').trim();
  if (!url) { toast('Enter your GoatCounter URL first', '⚠️'); return; }
  if (!/^https?:\/\//.test(url)) url = 'https://' + url;
  loadAnalyticsFrame(url);
});

document.getElementById('analytics-url').addEventListener('keydown', function(e){
  if (e.key === 'Enter') document.getElementById('analytics-load-btn').click();
});

// ═══════════════════════════════════════════════════════
// ── HISTORY TAB ──
// ═══════════════════════════════════════════════════════
var historyLoaded = false;

function apiGetCommits() {
  return fetch('https://api.github.com/repos/'+GH.owner+'/'+GH.repo+'/commits?path=tools.json&per_page=15',{
    headers:apiHeaders()
  }).then(function(r){ if(!r.ok) throw new Error(r.status); return r.json(); });
}

function fetchHistory() {
  if (historyLoaded) return; // already loaded this session
  var loading = document.getElementById('history-loading');
  var list    = document.getElementById('history-list');
  loading.classList.remove('hidden'); list.classList.add('hidden');
  if (!S.token) { list.innerHTML='<div class="empty-state"><div>Sign in first.</div></div>'; loading.classList.add('hidden'); list.classList.remove('hidden'); return; }
  apiGetCommits()
    .then(function(commits){
      historyLoaded = true;
      loading.classList.add('hidden'); list.classList.remove('hidden'); list.innerHTML = '';
      if (!commits.length) { list.innerHTML='<div class="empty-state"><div class="empty-icon">📋</div><div>No commits found</div></div>'; return; }
      commits.forEach(function(c){
        var item = document.createElement('div');
        item.className = 'history-item glass';
        var sha   = (c.sha||'').slice(0,7);
        var msg   = c.commit&&c.commit.message ? c.commit.message.split('\n')[0] : '';
        var author= c.commit&&c.commit.author ? c.commit.author.name : '';
        var date  = ''; try{ date=new Date(c.commit.author.date).toLocaleString(); }catch(e){}
        item.innerHTML =
          '<a href="'+safeHref(c.html_url||'#')+'" target="_blank" rel="noopener noreferrer" class="history-sha">'+esc(sha)+'</a>' +
          '<div style="flex:1;"><div class="history-msg">'+esc(msg)+'</div>' +
          '<div class="history-meta"><span class="history-author">'+esc(author)+'</span>&nbsp;·&nbsp;'+esc(date)+'</div></div>';
        list.appendChild(item);
      });
    })
    .catch(function(e){
      loading.classList.add('hidden'); list.classList.remove('hidden');
      list.innerHTML='<div class="empty-state"><div class="empty-icon">⚠️</div><div>Failed: '+esc(e.message)+'</div></div>';
    });
}

// ═══════════════════════════════════════════════════════
// ── STATS TAB ──
// ═══════════════════════════════════════════════════════
function renderStats() {
  var el = document.getElementById('stats-content');
  if (!S.toolsData) {
    el.innerHTML='<div class="empty-state"><div class="empty-icon">⏳</div><div>Loading data…</div></div>';
    loadData().then(function(){ renderStats(); });
    return;
  }
  var tools = S.toolsData.tools || [];
  var cats  = S.toolsData.categories || [];
  var pending = (S.pendingData&&S.pendingData.pending) ? S.pendingData.pending.filter(function(i){return i.status==='pending';}).length : 0;
  var catCounts = {};
  cats.forEach(function(c){ catCounts[c.id]=0; });
  tools.forEach(function(t){
    // Use full categories array if present, else fall back to primary category
    var tCats = Array.isArray(t.categories) && t.categories.length ? t.categories : (t.category ? [t.category] : []);
    tCats.forEach(function(cid){ if(catCounts[cid]!==undefined) catCounts[cid]++; });
  });
  var maxC = Math.max.apply(null, cats.map(function(c){return catCounts[c.id]||0;})) || 1;
  var sorted = cats.slice().sort(function(a,b){return (catCounts[b.id]||0)-(catCounts[a.id]||0);});
  var recent = tools.slice(-6).reverse();

  var html =
    '<div class="stats-grid">' +
      '<div class="stat-card"><div class="stat-card-num">'+tools.length+'</div><div class="stat-card-label">Total Tools</div></div>' +
      '<div class="stat-card"><div class="stat-card-num">'+cats.length+'</div><div class="stat-card-label">Categories</div></div>' +
      '<div class="stat-card"><div class="stat-card-num">'+pending+'</div><div class="stat-card-label">Pending</div></div>' +
      '<div class="stat-card"><div class="stat-card-num">'+recent.length+'</div><div class="stat-card-label">Recently Added</div></div>' +
    '</div>' +
    '<h2 style="margin-bottom:12px;font-size:.88rem;color:#c0c0d8;">Tools per Category</h2>' +
    '<div class="bar-chart">';

  sorted.forEach(function(cat){
    var count=catCounts[cat.id]||0;
    var pct=Math.round((count/maxC)*100);
    html+='<div class="bar-row"><div class="bar-label" title="'+esc(cat.label)+'">'+esc(cat.icon||'')+'&nbsp;'+esc(cat.short||cat.label)+'</div>'+
      '<div class="bar-track"><div class="bar-fill" style="width:0%;background:'+safeColor(cat.color||'#6c63ff')+'" data-pct="'+pct+'"></div></div>'+
      '<div class="bar-count">'+count+'</div></div>';
  });

  html+='</div><h2 style="margin:20px 0 12px;font-size:.88rem;color:#c0c0d8;">Recently Added</h2><div class="recent-tools-grid">';
  recent.forEach(function(t){
    var cat=(cats.find(function(c){return c.id===t.category;})||{});
    html+='<div class="recent-tool-card glass"><div class="recent-tool-name">'+esc(t.name)+'</div>'+
      '<div class="recent-tool-cat">'+esc(cat.icon||'')+'&nbsp;'+esc(cat.short||cat.label||t.category||'–')+'</div></div>';
  });
  html+='</div>';
  el.innerHTML=html;
  requestAnimationFrame(function(){ requestAnimationFrame(function(){
    el.querySelectorAll('.bar-fill').forEach(function(b){
      b.style.transition='width .8s cubic-bezier(.22,.68,0,1.2)'; b.style.width=b.getAttribute('data-pct')+'%';
    });
  }); });
}

// ═══════════════════════════════════════════════════════
// LOGIN
// ═══════════════════════════════════════════════════════
function doLogin() {
  if (checkLockout()) return;
  var pat = document.getElementById('pat-input').value.trim();
  var errEl = document.getElementById('login-err');
  var btn = document.getElementById('login-btn');

  pat = pat.replace(/[\x00-\x1F\x7F]/g,'');
  if (!pat) { errEl.textContent='Password is required.'; return; }
  btn.disabled=true; btn.textContent='Verifying…'; errEl.textContent='';

  var timeoutId;
  var timeoutP = new Promise(function(_,reject){ timeoutId=setTimeout(function(){ reject(new Error('Connection timed out.')); },10000); });

  function onLoginSuccess(token, user, isTemp) {
    clearTimeout(timeoutId);
    clearLoginState();
    S._loginedWithTemp = !!isTemp;
    startSession(token, user ? user.login || user : 'admin');
    document.getElementById('login-screen').style.display='none';
    document.getElementById('admin-panel').style.display='flex';
    document.getElementById('gh-user').textContent = 'Signed in as @'+(user ? user.login||user : 'admin');
    // Register this session in settings.json after data loads
    return loadData().then(function(){
      return apiGet('settings.json').then(function(d){
        S.settingsSha = d.sha;
        var data = registerSession(d.content);
        return apiPut('settings.json', data, S.settingsSha, 'New session: '+getDeviceInfo())
          .then(function(r){ S.settingsSha = r.content.sha; })
          .catch(function(){}); // non-critical
      }).catch(function(){});
    });
  }

  // First try: GitHub PAT
  Promise.race([validateGHToken(pat), timeoutP])
    .then(function(ok){
      if (ok) {
        // Valid GH token
        return getGHUser(pat).then(function(user){
          return onLoginSuccess(pat, user, false);
        });
      }
      // Not a GH token — try temp password via worker
      btn.textContent = 'Checking temp password…';
      return fetch(WORKER_URL+'/verify-temp', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({password:pat})
      }).then(function(r){ return r.json(); }).then(function(res){
        clearTimeout(timeoutId);
        if (res.error) {
          recordFailedAttempt();
          errEl.textContent = res.error === 'invalid' ? 'Incorrect password. Please try again.'
            : res.error === 'expired' ? 'Temporary password has expired.'
            : res.error === 'none' ? 'Incorrect password. Please try again.'
            : res.error;
          btn.disabled=false; btn.textContent='Sign In';
          return;
        }
        if (res.token) {
          return getGHUser(res.token).then(function(user){
            return onLoginSuccess(res.token, user, true);
          });
        }
        recordFailedAttempt();
        errEl.textContent='Incorrect password. Please try again.';
        btn.disabled=false; btn.textContent='Sign In';
      });
    })
    .catch(function(e){
      clearTimeout(timeoutId); recordFailedAttempt();
      errEl.textContent=e.message||'Connection failed. Try again.';
      btn.disabled=false; btn.textContent='Sign In';
    });
}

document.getElementById('login-btn').addEventListener('click', doLogin);
document.getElementById('pat-input').addEventListener('keydown', function(e){
  if (e.key==='Enter') doLogin();
});

document.getElementById('logout-btn').addEventListener('click', function(){
  if (confirm('Sign out?')) logout();
});
document.getElementById('pat-input').addEventListener('input', function(){
  this.value = this.value.replace(/[\x00-\x1F\x7F]/g,'');
});
document.getElementById('clear-lockout-btn').addEventListener('click', function(){
  sessionStorage.removeItem('a_ls');
  document.getElementById('lockout-msg').style.display='none';
  document.getElementById('lockout-clear').style.display='none';
  document.getElementById('login-btn').disabled=false;
  document.getElementById('login-err').textContent='';
});

document.getElementById('refresh-btn').addEventListener('click', function(){
  var btn = document.getElementById('refresh-btn');
  btn.disabled=true; btn.textContent='↻ Loading…';
  historyLoaded=false;
  loadData().then(function(){
    if (S.activeTab==='stats') renderStats();
    if (S.activeTab==='history') { historyLoaded=false; fetchHistory(); }
    if (S.activeTab==='home') initHomeTab();
    toast('Data refreshed', '✅');
  }).catch(function(e){
    toast('Refresh failed: '+e.message, '❌');
  }).finally(function(){
    btn.disabled=false; btn.textContent='↻ Refresh';
  });
});

// ═══════════════════════════════════════════════════════
// INIT — restore session if tab still open
// ═══════════════════════════════════════════════════════
(function init(){
  wireUndoListeners();
  checkLockout();
  var tok = sessionStorage.getItem('a_tok');
  var usr = sessionStorage.getItem('a_usr');
  var sid = sessionStorage.getItem('a_sid');
  if (tok) {
    S.token=tok; S.ghUser=usr||'admin'; S.sessionId=sid||null;
    document.getElementById('login-screen').style.display='none';
    document.getElementById('admin-panel').style.display='flex';
    document.getElementById('gh-user').textContent='Signed in as @'+S.ghUser;
    resetIdleTimer();
    loadData();
    // Ensure home tab is active visually on init
    requestAnimationFrame(function(){
      var active = document.querySelector('.tab-btn.active');
      if (active) moveLiquidIndicator(active);
    });
  }
})();
