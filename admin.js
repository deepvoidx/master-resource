// CONFIG
// ═══════════════════════════════════════════════════════
var GH = { owner:'deepvoidx', repo:'master-resource', branch:'main' };
var SESSION_MS   = 30 * 60 * 1000; // 30 min idle timeout
var MAX_ATTEMPTS = 3;
var LOCK_MS      = 5 * 60 * 1000;  // 5 min lockout
var UNDO_MS      = 10000; // 10 seconds

// ═══════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════
var S = {
  token:null, ghUser:'', activeTab:'pending',
  toolsData:null, toolsSha:null,
  pendingData:null, pendingSha:null,
  sessionTimer:null,
  editToolIdx:-1,
  toolsSortMode:'default',
  bulkSelected:new Set(),
  undoTimer:null,
  undoProgressAnim:null
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
  S.sessionTimer = setTimeout(function(){
    toast('Session expired. Please sign in again.', '⚠️');
    setTimeout(logout, 1500);
  }, SESSION_MS);
}

function logout() {
  S.token = null; S.toolsData = null; S.pendingData = null;
  sessionStorage.removeItem('a_tok');
  sessionStorage.removeItem('a_usr');
  clearTimeout(S.sessionTimer);
  document.getElementById('admin-panel').style.display = 'none';
  document.getElementById('login-screen').style.display = 'flex';
  document.getElementById('pat-input').value = '';
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
    }).then(function(d){ if(d){ S.pendingData = d.content; S.pendingSha = d.sha; } })
  ]).then(function(){
    renderPending();
    renderTools();
    renderCategories();
    updateTabCounts();
    if (S.activeTab==='stats') renderStats();
    if (S.activeTab==='history') fetchHistory();
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
    // Elements missing — just run action immediately
    actionFn().then(onSuccess).catch(function(e){ toast('Error: '+e.message,'❌'); if(onRevert) onRevert(); });
    return;
  }
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
    actionFn().then(onSuccess).catch(function(e){
      toast('Error: '+e.message, '❌');
      if (onRevert) onRevert();
    });
  }, UNDO_MS);
}
function cancelUndo() {
  if (S.undoTimer) {
    clearTimeout(S.undoTimer); S.undoTimer = null;
    var el = document.getElementById('undo-toast');
    if (el) el.classList.remove('show');
  }
}
function wireUndoListeners() {
  var undoBtn  = document.getElementById('ut-undo');
  var closeBtn = document.getElementById('ut-close');
  if (undoBtn)  undoBtn.addEventListener('click', function(){ cancelUndo(); toast('Action cancelled', '↩️'); });
  if (closeBtn) closeBtn.addEventListener('click', function(){ cancelUndo(); toast('Action cancelled', '↩️'); });
}

// ═══════════════════════════════════════════════════════
// PREVIEW CARD
// ═══════════════════════════════════════════════════════
function buildPreviewCard(name, desc, url, catId) {
  var cat = (S.toolsData && S.toolsData.categories)
    ? (S.toolsData.categories.find(function(c){ return c.id===catId; })||{}) : {};
  var color = cat.color || '#6c63ff';
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
      '<div style="display:flex;align-items:flex-start;gap:10px;">' +
        '<input type="checkbox" class="bulk-cb" data-id="'+esc(item.id)+'" style="margin-top:4px;width:16px;height:16px;cursor:pointer;flex-shrink:0;"/>' +
        '<div style="flex:1;">' +
      '<div class="pend-header">' +
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
      '<div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap;">' +
        '<button class="btn btn-ghost btn-sm pf-preview-btn" style="font-size:.8rem;">👁 Preview</button>' +
        '<div class="pf-preview" style="margin-top:0;"></div>' +
        '<button class="btn btn-ok btn-sm pf-approve">✓ Approve</button>' +
        '<button class="btn btn-danger btn-sm pf-reject">✗ Reject</button>' +
      '</div>' +
      '<div class="pf-err" style="color:#f87171;font-size:.76rem;margin-top:6px;min-height:14px;"></div>' +
      '</div></div>';

    list.appendChild(card);

    // Wire category checkboxes — multi-select
    card.querySelectorAll('.cat-check').forEach(function(lbl){
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

  var tags = tagsRaw.split(',').map(function(t){ return t.trim().replace(/^#/,'').toLowerCase(); }).filter(Boolean);

  var btn = card.querySelector('.pf-approve');
  btn.disabled = true; btn.textContent = 'Saving…';
  errEl.textContent = '';

  // Store primary category + categories array for multi-cat support
  var toolEntry = { name:nameVal, description:desc, url:urlRes.url, category:cats[0], tags:tags };
  if (cats.length > 1) toolEntry.categories = cats;

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
      renderPending(); renderTools(); updateTabCounts();
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
    .then(function(){ toast('Submission rejected.', '🗑️'); renderPending(); })
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
      toast('Rejected '+ids.length+' submission(s)','🗑️'); S.bulkSelected.clear(); renderPending(); })
    .catch(function(e){ toast('Error: '+e.message,'❌'); S.pendingData=snap; });
});

// ═══════════════════════════════════════════════════════
// ── TOOLS EDITOR TAB ──
// ═══════════════════════════════════════════════════════
var toolsSearchQ = '';

function renderTools(q) {
  q = q || toolsSearchQ;
  toolsSearchQ = q;
  var loading = document.getElementById('tools-loading');
  var list = document.getElementById('tools-list');
  loading.classList.add('hidden');
  list.classList.remove('hidden');

  var tools = (S.toolsData && S.toolsData.tools) ? S.toolsData.tools : [];
  document.getElementById('tools-count').textContent = tools.length; updateTabCounts();

  var filtered = tools.filter(function(t){
    if (!q) return true;
    return (t.name+' '+(t.description||'')+' '+(t.category||'')+' '+(t.url||'')).toLowerCase().includes(q.toLowerCase());
  });
  // Sort
  filtered = filtered.slice();
  if (S.toolsSortMode === 'az') {
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
    var cat = S.toolsData.categories.find(function(c){ return c.id===tool.category; }) || {};
    var row = document.createElement('div');
    row.className = 'tool-row glass';
    row.innerHTML =
      '<div style="flex:1;min-width:0;">' +
        '<div class="tool-row-name">'+esc(tool.name)+'</div>' +
        '<div class="tool-row-meta">'+esc(cat.icon||'')+'&nbsp;'+esc(cat.short||cat.label||tool.category)+'&nbsp;·&nbsp;'+esc((tool.url||'').replace(/^https?:\/\//,'').split('/')[0])+'</div>' +
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
      var tags=tv.split(',').map(function(t){return t.trim().replace(/^#/,'').toLowerCase();}).filter(Boolean);
      var updated={name:nv,description:dv,url:ur.url,category:cats[0],tags:tags};
      if(cats.length>1) updated.categories=cats;
      var saveBtn=inlineEdit.querySelector('.ie-save');
      saveBtn.disabled=true; saveBtn.textContent='Saving…'; ee.textContent='';
      var original=S.toolsData.tools[idx];
      S.toolsData.tools[idx]=updated;
      apiPut('tools.json',S.toolsData,S.toolsSha,'Edit tool: '+nv)
        .then(function(res){S.toolsSha=res.content.sha;toast('Updated "'+nv+'"','✅');renderTools(toolsSearchQ);})
        .catch(function(e){S.toolsData.tools[idx]=original;saveBtn.disabled=false;saveBtn.textContent='Save';ee.textContent='Error: '+e.message;});
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
  var isNew = idx === -1;
  document.getElementById('tool-modal-title').textContent = isNew ? 'Add New Tool' : 'Edit Tool';
  document.getElementById('tm-err').textContent = '';

  var tool = isNew ? { name:'', url:'', description:'', category:'', tags:[] }
                   : S.toolsData.tools[idx];
  document.getElementById('tm-name').value = tool.name || '';
  document.getElementById('tm-url').value  = tool.url  || '';
  document.getElementById('tm-desc').value = tool.description || '';
  document.getElementById('tm-tags').value = (tool.tags||[]).join(', ');

  var catsEl = document.getElementById('tm-cats');
  catsEl.innerHTML = '';
  var categories = S.toolsData.categories || [];
  categories.forEach(function(cat){
    var lbl = document.createElement('label');
    // Multi-select: check if this cat is in tool.categories or tool.category
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

  document.getElementById('tool-modal').classList.remove('hidden');
}

function closeToolModal(){
  document.getElementById('tool-modal').classList.add('hidden');
  // Always reset save button so modal can be reused immediately
  var btn = document.getElementById('tm-save');
  if (btn) { btn.disabled=false; btn.textContent='Save Tool'; }
  document.getElementById('tm-err').textContent='';
}

document.getElementById('tm-cancel').addEventListener('click', closeToolModal);
document.getElementById('tool-modal').addEventListener('click', function(e){
  if(e.target===this) closeToolModal();
});

document.getElementById('tm-save').addEventListener('click', function(){
  var nameVal = sanitize(document.getElementById('tm-name').value, 100);
  var rawUrl  = document.getElementById('tm-url').value;
  var desc    = sanitize(document.getElementById('tm-desc').value, 200);
  var tagsRaw = document.getElementById('tm-tags').value;
  var errEl   = document.getElementById('tm-err');

  var urlRes = validateURL(rawUrl);
  if (!nameVal){ errEl.textContent='Name required.'; return; }
  if (!urlRes.ok){ errEl.textContent=urlRes.msg; return; }

  var catEls = document.querySelectorAll('#tm-cats .cat-check.checked input');
  if (!catEls.length){ errEl.textContent='Select at least one category.'; return; }
  var catIds = Array.from(catEls).map(function(el){ return el.value; });

  var tags = tagsRaw.split(',').map(function(t){ return t.trim().replace(/^#/,'').toLowerCase(); }).filter(Boolean);
  var tool = { name:nameVal, description:desc, url:urlRes.url, category:catIds[0], tags:tags };
  if (catIds.length > 1) tool.categories = catIds;

  var btn = document.getElementById('tm-save');
  btn.disabled=true; btn.textContent='Saving…'; errEl.textContent='';

  var tools = S.toolsData;
  var isNew = S.editToolIdx === -1;
  if (isNew) { tools.tools.push(tool); }
  else { tools.tools[S.editToolIdx] = tool; }

  apiPut('tools.json', tools, S.toolsSha, (isNew?'Add':'Edit')+' tool: '+nameVal)
    .then(function(res){
      S.toolsSha = res.content.sha;
      toast((isNew?'Added':'Updated')+' "'+nameVal+'"','✅');
      btn.disabled=false; btn.textContent='Save Tool';
      closeToolModal(); renderTools(); updateTabCounts();
    })
    .catch(function(e){
      btn.disabled=false; btn.textContent='Save Tool';
      errEl.textContent='Error: '+e.message;
    });
});

function deleteTool(idx) {
  var tool = S.toolsData.tools[idx];
  var snap = JSON.parse(JSON.stringify(S.toolsData));
  S.toolsData.tools.splice(idx,1);
  renderTools(toolsSearchQ); updateTabCounts();
  scheduleWithUndo(
    '"'+tool.name+'" will be deleted in 10s…',
    function(){ return apiPut('tools.json',S.toolsData,S.toolsSha,'Delete tool: '+tool.name).then(function(r){S.toolsSha=r.content.sha;}); },
    function(){ toast('Deleted "'+tool.name+'"','🗑️'); },
    function(){ S.toolsData=snap; renderTools(toolsSearchQ); updateTabCounts(); }
  );
}

document.getElementById('add-tool-btn').addEventListener('click', function(){ openToolModal(-1); });
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
    var toolCount = S.toolsData.tools.filter(function(t){ return t.category===cat.id; }).length;
    var row = document.createElement('div');
    row.className = 'cat-row glass';
    row.innerHTML =
      '<div class="cat-icon-preview" style="background:'+esc(cat.color)+'22;border:1px solid '+esc(cat.color)+'55">'+esc(cat.icon||'')+'</div>' +
      '<div style="flex:1;min-width:0;">' +
        '<div style="font-weight:600;color:#ddddf0;font-size:.88rem;">'+esc(cat.label)+'</div>' +
        '<div style="font-size:.72rem;color:var(--mute);">ID: '+esc(cat.id)+'&nbsp;·&nbsp;'+toolCount+' tools</div>' +
      '</div>' +
      '<div style="width:14px;height:14px;border-radius:50%;background:'+esc(cat.color)+';flex-shrink:0;"></div>' +
      '<button class="btn btn-ghost btn-sm" data-action="expand" style="font-size:.9rem;">⌄</button>' +
      '<button class="btn btn-ghost btn-sm" title="Edit">✎</button>' +
      '<button class="btn btn-danger btn-sm" title="Delete">🗑</button>';

    row.querySelector('[title=Edit]').addEventListener('click', function(){ openCatModal(idx); });
    row.querySelector('[title=Delete]').addEventListener('click', function(){
      if (toolCount>0 && !confirm(toolCount+' tools use this category. Still delete it?')) return;
      if (!confirm('Delete category "'+cat.label+'"?')) return;
      deleteCat(idx);
    });
    list.appendChild(row);
  });
}

function openCatModal(idx) {
  editCatIdx = idx;
  var isNew = idx === -1;
  document.getElementById('cat-modal-title').textContent = isNew ? 'Add Category' : 'Edit Category';
  document.getElementById('cm-err').textContent = '';
  var cat = isNew ? { id:'', label:'', short:'', icon:'📦', color:'#6c63ff' }
                  : S.toolsData.categories[idx];
  document.getElementById('cm-id').value = cat.id||'';
  document.getElementById('cm-id').disabled = !isNew; // can't change id after creation
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
      closeCatModal(); renderCategories();
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
  S.toolsData.categories.splice(idx,1); renderCategories();
  scheduleWithUndo(
    'Category "'+cat.label+'" will be deleted in 10s…',
    function(){ return apiPut('tools.json',S.toolsData,S.toolsSha,'Delete category: '+cat.label).then(function(r){S.toolsSha=r.content.sha;}); },
    function(){ toast('Deleted category','🗑️'); },
    function(){ S.toolsData=snap; renderCategories(); }
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
    if (tab === 'stats') renderStats();
    if (tab === 'history') fetchHistory();
    if (tab === 'preview') {
      var frame = document.getElementById('site-preview-frame');
      if (frame && !frame.getAttribute('data-loaded')) {
        frame.setAttribute('data-loaded','1');
      }
    }
  });
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
  tools.forEach(function(t){ if(catCounts[t.category]!==undefined) catCounts[t.category]++; });
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
      '<div class="bar-track"><div class="bar-fill" style="width:0%;background:'+esc(cat.color||'#6c63ff')+'" data-pct="'+pct+'"></div></div>'+
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

  Promise.race([validateGHToken(pat), timeoutP])
    .then(function(ok){ clearTimeout(timeoutId);
      if (!ok) {
        recordFailedAttempt();
        errEl.textContent='Incorrect password. Please try again.';
        btn.disabled=false; btn.textContent='Sign In';
        return;
      }
      return getGHUser(pat).then(function(user){
        clearLoginState();
        startSession(pat, user ? user.login : 'admin');
        document.getElementById('login-screen').style.display='none';
        document.getElementById('admin-panel').style.display='flex';
        document.getElementById('gh-user').textContent = 'Signed in as @'+(user?user.login:'admin');
        return loadData();
      });
    })
    .catch(function(e){ clearTimeout(timeoutId); recordFailedAttempt();
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
  historyLoaded=false; loadData().finally(function(){ btn.disabled=false; btn.textContent='↻ Refresh'; });
});

// ═══════════════════════════════════════════════════════
// INIT — restore session if tab still open
// ═══════════════════════════════════════════════════════
(function init(){
  wireUndoListeners();
  checkLockout();
  var tok = sessionStorage.getItem('a_tok');
  var usr = sessionStorage.getItem('a_usr');
  if (tok) {
    S.token=tok; S.ghUser=usr||'admin';
    document.getElementById('login-screen').style.display='none';
    document.getElementById('admin-panel').style.display='flex';
    document.getElementById('gh-user').textContent='Signed in as @'+S.ghUser;
    resetIdleTimer();
    loadData();
  }
})();
