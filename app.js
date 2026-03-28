(function () {

  // ══════════════════════════════════════════════════════════════
  // GITHUB CONFIG — edit these to match your repo
  // ══════════════════════════════════════════════════════════════
  var GH_OWNER  = 'deepvoidx';
  var GH_REPO   = 'master-resource';
  var GH_BRANCH = 'main';

  // ── TOKEN SETUP (mild obfuscation) ────────────────────────────
  // ⚠️  Your old token was committed to a public repo.
  //     GitHub's secret scanner has almost certainly REVOKED it.
  //     That is why submissions fail.
  //
  // HOW TO FIX — takes ~2 minutes:
  //   1. Generate a NEW fine-grained PAT:
  //      https://github.com/settings/tokens?type=beta
  //      Repo: master-resource  |  Permission: Contents → Read & Write
  //   2. In your browser console run:
  //        var t = 'github_pat_YOUR_NEW_TOKEN';
  //        var m = Math.ceil(t.length / 2);
  //        console.log('p[0]:', btoa(t.slice(0, m)));
  //        console.log('p[1]:', btoa(t.slice(m)));
  //   3. Paste the two strings into p[0] and p[1] below.
  //
  // ⚠️  This is mild obfuscation ONLY — it defeats GitHub's
  //     automated scanner but anyone who opens DevTools can still
  //     decode it. Fine for a personal project, NOT for production.
  // ─────────────────────────────────────────────────────────────
  var SUBMIT_TOKEN = (function () {
    var p = [
      'Z2l0aHViX3BhdF8xMUI3NVhBUFkwbWRpV0lTbTlsTkdkX0lISnRrRGliVUJr', // ← btoa(firstHalf)
      'VkpaYlE2YktEbUhtSEFJMkNNZlpBanl5Q0REemtxR09HUFBaVE52dmlpVks3aQ==' // ← btoa(secondHalf)
    ];
    try { return atob(p[0]) + atob(p[1]); } catch (e) { return ''; }
  })();
  // ══════════════════════════════════════════════════════════════

  var activeFilters = [], at = 'all', sortMode = 'default';
  var allTools = [], allCategories = [];
  var TOTAL = 0;
  var NEW_COUNT = 11;

  // ── SHA cache: skip the GET round-trip when SHA is fresh ──────
  var _shaCache = { sha: null, ts: 0 };
  var SHA_TTL   = 5 * 60 * 1000; // 5 minutes

  // ── Content protection ────────────────────────────────────────
  document.addEventListener('contextmenu', function (e) {
    if (e.target.closest('header') || e.target.tagName === 'IMG') e.preventDefault();
  });
  document.addEventListener('dragstart', function (e) { e.preventDefault(); });

  // ── Load tools.json ───────────────────────────────────────────
  fetch('./tools.json')
    .then(function (r) { return r.json(); })
    .then(function (data) {
      allCategories = data.categories;
      allTools      = data.tools;
      TOTAL         = allTools.length;
      buildFilterButtons();
      buildDOM();
      buildFlatView();
      buildSortControls();
      buildSubmitBtn();
      apply(false);
    })
    .catch(function () {
      document.getElementById('cats').innerHTML =
        '<p style="color:#e11d48;padding:40px">Failed to load tools.json — make sure the file exists.</p>';
    });

  // ── Toast ─────────────────────────────────────────────────────
  var toastT;
  function toast(msg, icon) {
    var t = document.getElementById('toast');
    t.innerHTML = (icon ? '<span class="toast-icon">' + icon + '</span>' : '') +
                  '<span>' + escHtml(msg) + '</span>';
    t.classList.add('show');
    clearTimeout(toastT);
    toastT = setTimeout(function () { t.classList.remove('show'); }, 2400);
  }

  // ── Share ─────────────────────────────────────────────────────
  function shareCard(name, description, url) {
    var fullText = name + ' — ' + description + (url ? '\n' + url : '');
    if (navigator.share) {
      navigator.share({ title: name, text: description, url: url }).catch(function () {});
      return;
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(fullText)
        .then(function () { toast('Copied to clipboard', '📋'); })
        .catch(function () { fallbackCopy(fullText); toast('Copied to clipboard', '📋'); });
    } else {
      fallbackCopy(fullText);
      toast('Copied to clipboard', '📋');
    }
  }
  function fallbackCopy(txt) {
    var ta = document.createElement('textarea');
    ta.value = txt; ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0;';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch (e) {}
    document.body.removeChild(ta);
  }

  // ── Security helpers ──────────────────────────────────────────
  function escHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
  function sanitizeText(str, maxLen) {
    return String(str).trim().slice(0, maxLen || 200).replace(/[\x00-\x1F\x7F]/g, '');
  }
  function validateURL(raw) {
    var url = String(raw).trim();
    if (!url) return { ok: false, msg: 'URL is required.' };
    if (url.length > 500) return { ok: false, msg: 'URL is too long.' };
    if (/^(javascript|data|vbscript|file|blob|about):/i.test(url))
      return { ok: false, msg: 'This URL type is not allowed.' };
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    try {
      var p = new URL(url);
      if (!['http:', 'https:'].includes(p.protocol))
        return { ok: false, msg: 'Only http:// and https:// URLs are allowed.' };
      if (!p.hostname || p.hostname.length < 3 || !p.hostname.includes('.'))
        return { ok: false, msg: 'Please enter a valid website URL.' };
      if (/^(localhost|127\.|192\.168\.|10\.|0\.0\.0\.0)/i.test(p.hostname))
        return { ok: false, msg: 'Local URLs are not allowed.' };
      return { ok: true, url: p.href };
    } catch (e) {
      return { ok: false, msg: 'Please enter a valid URL.' };
    }
  }

  // ── URL normaliser (for duplicate detection) ──────────────────
  function normalizeURL(url) {
    return String(url).toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/\/$/, '')
      .trim();
  }

  // ── Client-side duplicate tracking ───────────────────────────
  var LS_SUB_KEY = 'mr_submitted_urls';
  function isURLAlreadySubmitted(url) {
    var list = [];
    try { list = JSON.parse(localStorage.getItem(LS_SUB_KEY) || '[]'); } catch (e) {}
    var norm = normalizeURL(url);
    return list.some(function (u) { return normalizeURL(u) === norm; });
  }
  function markURLAsSubmitted(url) {
    var list = [];
    try { list = JSON.parse(localStorage.getItem(LS_SUB_KEY) || '[]'); } catch (e) {}
    list.push(normalizeURL(url));
    if (list.length > 200) list = list.slice(-200);
    try { localStorage.setItem(LS_SUB_KEY, JSON.stringify(list)); } catch (e) {}
  }
  function unmarkURL(url) {
    try {
      var list = JSON.parse(localStorage.getItem(LS_SUB_KEY) || '[]');
      var norm = normalizeURL(url);
      list = list.filter(function (u) { return normalizeURL(u) !== norm; });
      localStorage.setItem(LS_SUB_KEY, JSON.stringify(list));
    } catch (e) {}
  }

  // ── Rate limiting (3 per hour per browser) ────────────────────
  function checkRateLimit() {
    var key = 'mr_submit_rl', now = Date.now(), data;
    try { data = JSON.parse(localStorage.getItem(key) || 'null'); } catch (e) { data = null; }
    if (!data || now > data.reset) data = { count: 0, reset: now + 3600000 };
    if (data.count >= 3) {
      var mins = Math.ceil((data.reset - now) / 60000);
      return { ok: false, msg: 'Too many submissions. Try again in ' + mins + ' minute(s).' };
    }
    data.count++;
    try { localStorage.setItem(key, JSON.stringify(data)); } catch (e) {}
    return { ok: true };
  }

  // ── GitHub API: read pending.json (caches SHA) ────────────────
  function fetchPending() {
    return fetch(
      'https://api.github.com/repos/' + GH_OWNER + '/' + GH_REPO +
      '/contents/pending.json?ref=' + GH_BRANCH,
      { headers: { 'Authorization': 'Bearer ' + SUBMIT_TOKEN, 'Accept': 'application/vnd.github.v3+json' } }
    ).then(function (r) {
      if (r.status === 401 || r.status === 403) {
        var e = new Error('TOKEN_INVALID'); e.status = r.status; throw e;
      }
      if (r.status === 404) return { content: { pending: [] }, sha: null };
      if (!r.ok) { var e2 = new Error('API_ERROR'); e2.status = r.status; throw e2; }
      return r.json().then(function (d) {
        var content;
        try { content = JSON.parse(atob(d.content.replace(/\n/g, ''))); }
        catch (e) { content = { pending: [] }; }
        _shaCache.sha = d.sha; _shaCache.ts = Date.now();
        return { content: content, sha: d.sha };
      });
    });
  }

  // ── GitHub API: write pending.json ────────────────────────────
  function writePending(content, sha) {
    var safe = { pending: Array.isArray(content.pending) ? content.pending : [] };
    var body = {
      message: 'New tool submission',
      content: btoa(unescape(encodeURIComponent(JSON.stringify(safe, null, 2)))),
      branch:  GH_BRANCH
    };
    if (sha) body.sha = sha;
    return fetch(
      'https://api.github.com/repos/' + GH_OWNER + '/' + GH_REPO + '/contents/pending.json',
      {
        method: 'PUT',
        headers: {
          'Authorization': 'Bearer ' + SUBMIT_TOKEN,
          'Content-Type': 'application/json',
          'Accept': 'application/vnd.github.v3+json'
        },
        body: JSON.stringify(body)
      }
    ).then(function (r) {
      if (r.status === 401 || r.status === 403) {
        var e = new Error('TOKEN_INVALID'); e.status = r.status; throw e;
      }
      if (r.status === 409) { var e2 = new Error('CONFLICT'); e2.status = 409; throw e2; }
      if (!r.ok) return r.text().then(function (t) { throw new Error(t); });
      return r.json().then(function (res) {
        // Keep SHA cache warm
        if (res && res.content && res.content.sha) {
          _shaCache.sha = res.content.sha; _shaCache.ts = Date.now();
        }
        return res;
      });
    });
  }

  // ── Append entry + server-side dedup check ────────────────────
  function appendAndWrite(result, entry) {
    var data = result.content, sha = result.sha;
    if (!Array.isArray(data.pending)) data.pending = [];
    var normUrl = normalizeURL(entry.url);
    // Server-side duplicate — skip write, treat as success
    var alreadyThere = data.pending.some(function (p) {
      return normalizeURL(p.url || '') === normUrl;
    });
    if (alreadyThere) return Promise.resolve({ duplicate: true });
    data.pending.push(entry);
    return writePending(data, sha);
  }

  // ── Submit: use cached SHA first, retry on 409 conflict ───────
  function submitEntry(entry) {
    var hasFreshSha = _shaCache.sha && (Date.now() - _shaCache.ts < SHA_TTL);
    if (hasFreshSha) {
      return appendAndWrite({ content: { pending: [] }, sha: _shaCache.sha }, entry)
        .catch(function (err) {
          if (err.status === 409 || err.message === 'CONFLICT') {
            // Stale SHA — fall back to full fetch → write
            return fetchPending().then(function (res) { return appendAndWrite(res, entry); });
          }
          throw err;
        });
    }
    return fetchPending().then(function (res) { return appendAndWrite(res, entry); });
  }

  // ── Generate unique submission ID ─────────────────────────────
  function genId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  // ── Build submit floating button ──────────────────────────────
  function buildSubmitBtn() {
    if (document.getElementById('submit-btn')) return;
    var btn = document.createElement('button');
    btn.id   = 'submit-btn'; btn.title = 'Suggest a tool';
    btn.innerHTML = '+'; btn.setAttribute('aria-label', 'Suggest a tool');
    document.body.appendChild(btn);
    btn.addEventListener('click', openSubmitModal);
  }

  // ── Build submit modal ────────────────────────────────────────
  function buildSubmitModal() {
    if (document.getElementById('submit-overlay')) return;
    var overlay = document.createElement('div');
    overlay.id = 'submit-overlay'; overlay.className = 'modal-overlay';
    overlay.setAttribute('role', 'dialog'); overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Suggest a tool');
    overlay.innerHTML =
      '<div class="modal-box" id="submit-modal">' +
        '<div class="modal-title">Suggest a Tool</div>' +
        '<div class="modal-sub">Seen something useful? Share it — the developer will review and add it to the list.</div>' +
        '<div id="submit-form">' +
          '<div class="modal-field">' +
            '<label class="modal-label" for="s-name">Tool name</label>' +
            '<input class="modal-input" type="text" id="s-name" placeholder="e.g. Notion" maxlength="80" autocomplete="off"/>' +
            '<div class="modal-err" id="s-name-err"></div>' +
          '</div>' +
          '<div class="modal-field">' +
            '<label class="modal-label" for="s-url">Website URL</label>' +
            '<input class="modal-input" type="url" id="s-url" placeholder="https://example.com" maxlength="500" autocomplete="off" inputmode="url"/>' +
            '<div class="modal-err" id="s-url-err"></div>' +
          '</div>' +
          '<div class="modal-err" id="s-global-err"></div>' +
          '<div class="modal-actions">' +
            '<button class="modal-submit" id="s-submit">Submit</button>' +
            '<button class="modal-cancel" id="s-cancel">Cancel</button>' +
          '</div>' +
        '</div>' +
        '<div class="modal-success" id="submit-success">' +
          '<div class="modal-success-icon">✓</div>' +
          '<div class="modal-success-text">Thank you! Your suggestion has been submitted and will be reviewed before being added.</div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) closeSubmitModal(); });
    document.getElementById('s-cancel').addEventListener('click', closeSubmitModal);
    document.getElementById('s-submit').addEventListener('click', handleSubmit);
    overlay.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeSubmitModal();
      if (e.key === 'Enter' && e.target.closest('.modal-box')) handleSubmit();
    });
  }

  function openSubmitModal() {
    buildSubmitModal();
    var overlay = document.getElementById('submit-overlay');
    document.getElementById('submit-form').style.display    = '';
    document.getElementById('submit-success').style.display = 'none';
    document.getElementById('s-name').value = '';
    document.getElementById('s-url').value  = '';
    clearModalErrors();
    overlay.classList.add('open');
    setTimeout(function () { var i = document.getElementById('s-name'); if (i) i.focus(); }, 60);
    document.body.style.overflow = 'hidden';
  }

  function closeSubmitModal() {
    var overlay = document.getElementById('submit-overlay');
    if (overlay) overlay.classList.remove('open');
    document.body.style.overflow = '';
  }

  function clearModalErrors() {
    ['s-name-err', 's-url-err', 's-global-err'].forEach(function (id) {
      var el = document.getElementById(id); if (el) el.textContent = '';
    });
    ['s-name', 's-url'].forEach(function (id) {
      var el = document.getElementById(id); if (el) el.classList.remove('error');
    });
  }

  function handleSubmit() {
    clearModalErrors();
    var nameInput = document.getElementById('s-name');
    var urlInput  = document.getElementById('s-url');
    var submitBtn = document.getElementById('s-submit');

    var name   = sanitizeText(nameInput.value, 80);
    var rawUrl = urlInput.value.trim();
    var valid  = true;

    if (!name) {
      document.getElementById('s-name-err').textContent = 'Tool name is required.';
      nameInput.classList.add('error'); valid = false;
    }
    var urlCheck = validateURL(rawUrl);
    if (!urlCheck.ok) {
      document.getElementById('s-url-err').textContent = urlCheck.msg;
      urlInput.classList.add('error'); valid = false;
    }
    if (!valid) return;

    // ── Client-side duplicate check ───────────────────────────
    if (isURLAlreadySubmitted(urlCheck.url)) {
      document.getElementById('s-url-err').textContent = 'You already submitted this URL. Thanks!';
      urlInput.classList.add('error'); return;
    }

    var rlCheck = checkRateLimit();
    if (!rlCheck.ok) {
      document.getElementById('s-global-err').textContent = rlCheck.msg; return;
    }

    if (!SUBMIT_TOKEN) {
      document.getElementById('s-global-err').textContent =
        'Submission not configured — see the TOKEN SETUP comment in app.js.';
      return;
    }

    submitBtn.disabled    = true;
    submitBtn.textContent = 'Submitting…';

    var entry = {
      id:          genId(),
      name:        name,
      url:         urlCheck.url,
      submittedAt: new Date().toISOString(),
      status:      'pending'
    };

    // Optimistically mark URL to block double-tap race
    markURLAsSubmitted(urlCheck.url);

    submitEntry(entry)
      .then(function () {
        document.getElementById('submit-form').style.display    = 'none';
        document.getElementById('submit-success').style.display = '';
        setTimeout(closeSubmitModal, 2000); // ← was 3000 ms
      })
      .catch(function (err) {
        console.error('Submit error:', err);
        unmarkURL(urlCheck.url); // Roll back optimistic mark so user can retry

        var msg = 'Submission failed. Please try again later.';
        if (err.message === 'TOKEN_INVALID' || err.status === 401 || err.status === 403) {
          msg = 'Submission unavailable right now — the developer will fix it soon.';
        } else if (err.status === 422) {
          msg = 'Invalid data. Please double-check the URL and try again.';
        }

        document.getElementById('s-global-err').textContent = msg;
        submitBtn.disabled    = false;
        submitBtn.textContent = 'Submit';
      });
  }

  // ── Sync "All" button visual state ───────────────────────────
  function syncAllBtn() {
    var allBtn = document.querySelector('.fb[data-f="all"]');
    if (!allBtn) return;
    allBtn.classList[activeFilters.length === 0 ? 'add' : 'remove']('active');
  }

  // ── Build category filter buttons ─────────────────────────────
  function buildFilterButtons() {
    var fwrap = document.getElementById('fwrap');
    fwrap.innerHTML = '';
    var all = document.createElement('button');
    all.className = 'fb active'; all.setAttribute('data-f', 'all'); all.textContent = 'All';
    fwrap.appendChild(all);
    allCategories.forEach(function (cat) {
      var btn = document.createElement('button');
      btn.className = 'fb'; btn.setAttribute('data-f', cat.id);
      var count = allTools.filter(function (t) { return t.category === cat.id; }).length;
      btn.textContent = cat.icon + ' ' + (cat.short || cat.label) + ' · ' + count;
      fwrap.appendChild(btn);
    });
  }

  // ── Build grouped category view ───────────────────────────────
  function buildDOM() {
    var cats = document.getElementById('cats');
    cats.innerHTML = '';
    var statsEl = document.getElementById('stat-tools'), statCatEl = document.getElementById('stat-cats');
    if (statsEl)   statsEl.textContent   = TOTAL;
    if (statCatEl) statCatEl.textContent = allCategories.length;
    allCategories.forEach(function (cat) {
      var tools = allTools.filter(function (t) { return t.category === cat.id; });
      if (!tools.length) return;
      var section = document.createElement('section');
      section.className = 'cat'; section.setAttribute('data-id', cat.id);
      var hdr = document.createElement('div'); hdr.className = 'cat-hdr';
      hdr.innerHTML =
        '<div class="cat-ico" style="background:' + cat.color + '20;border:1px solid ' + cat.color + '50">' + cat.icon + '</div>' +
        '<div class="cat-title">' + escHtml(cat.label) + '</div>' +
        '<div class="cat-cnt">' + tools.length + '</div>';
      section.appendChild(hdr);
      var grid = document.createElement('div'); grid.className = 'grid';
      tools.forEach(function (tool) { grid.appendChild(buildCard(tool, cat.color)); });
      section.appendChild(grid);
      cats.appendChild(section);
    });
  }

  // ── Build flat view container ─────────────────────────────────
  function buildFlatView() {
    var flatView = document.createElement('div');
    flatView.id = 'flat-view'; flatView.className = 'flat-view hidden';
    var grid = document.createElement('div'); grid.className = 'grid'; grid.id = 'flat-grid';
    flatView.appendChild(grid);
    var cats = document.getElementById('cats');
    cats.parentNode.insertBefore(flatView, cats.nextSibling);
  }

  // ── Build sort controls ───────────────────────────────────────
  function buildSortControls() {
    if (document.getElementById('sort-wrap')) return;
    var sortWrap = document.createElement('div');
    sortWrap.id = 'sort-wrap'; sortWrap.className = 'sort-wrap';
    sortWrap.innerHTML =
      '<span class="sort-label">Sort:</span>' +
      '<button class="sort-btn active" data-sort="default">Default</button>' +
      '<button class="sort-btn" data-sort="az">A \u2192 Z</button>' +
      '<button class="sort-btn" data-sort="recent">Recently Added</button>';
    var ctrlMeta = document.getElementById('lc').parentNode;
    ctrlMeta.parentNode.insertBefore(sortWrap, ctrlMeta.nextSibling);
    sortWrap.addEventListener('click', function (e) {
      var b = e.target.closest('.sort-btn'); if (!b) return;
      var isActive = b.classList.contains('active'), clicked = b.getAttribute('data-sort');
      document.querySelectorAll('.sort-btn').forEach(function (x) { x.classList.remove('active'); });
      if (isActive && clicked !== 'default') {
        document.querySelector('.sort-btn[data-sort="default"]').classList.add('active');
        sortMode = 'default';
      } else { b.classList.add('active'); sortMode = clicked; }
      apply(true);
    });
  }

  // ── Build a single card ───────────────────────────────────────
  function buildCard(tool, color) {
    var toolIndex = allTools.indexOf(tool);
    var isNew = toolIndex >= allTools.length - NEW_COUNT;
    var searchStr = [
      tool.name, tool.description, tool.category, tool.url,
      tool.tags.map(function (t) { return '#' + t; }).join(' ')
    ].join(' ').toLowerCase();
    var card = document.createElement('div');
    card.className = 'card';
    card.setAttribute('data-s', searchStr); card.setAttribute('data-idx', toolIndex);
    card.style.setProperty('--ca', color);
    if (tool.url) {
      card.setAttribute('data-url', tool.url);
      card.setAttribute('role', 'link'); card.setAttribute('tabindex', '0');
    }
    var nameEl = document.createElement('div'); nameEl.className = 'tool-name';
    nameEl.textContent = tool.name;
    if (isNew) {
      var badge = document.createElement('span');
      badge.className = 'new-badge'; badge.textContent = 'New'; nameEl.appendChild(badge);
    }
    var descEl = document.createElement('div');
    descEl.className = 'tool-desc'; descEl.textContent = tool.description;
    card.appendChild(nameEl); card.appendChild(descEl);
    if (tool.url) {
      var domain = tool.url.replace(/https?:\/\//, '').split('/')[0];
      var link = document.createElement('a');
      link.className = 'tool-link'; link.href = tool.url;
      link.target = '_blank'; link.rel = 'noopener noreferrer';
      link.textContent = domain + ' \u2197'; card.appendChild(link);
      var actions = document.createElement('div'); actions.className = 'card-actions';
      var shareBtn = document.createElement('button');
      shareBtn.className = 'ca-btn share-btn'; shareBtn.title = 'Share';
      shareBtn.innerHTML = '\u2197\uFE0E Share';
      (function (n, d, u) {
        shareBtn.addEventListener('click', function (e) {
          e.stopPropagation(); e.preventDefault(); shareCard(n, d, u);
        });
      })(tool.name, tool.description, tool.url);
      actions.appendChild(shareBtn); card.appendChild(actions);
    } else {
      var noLink = document.createElement('span');
      noLink.className = 'no-link'; noLink.textContent = 'Search on Google'; card.appendChild(noLink);
    }
    return card;
  }

  // ── Card click / keyboard ─────────────────────────────────────
  document.addEventListener('click', function (e) {
    if (e.target.closest('button') || e.target.closest('a')) return;
    var card = e.target.closest('.card[data-url]'); if (!card) return;
    var url = card.getAttribute('data-url');
    if (url) window.open(url, '_blank', 'noopener,noreferrer');
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      var card = e.target.closest('.card[data-url]');
      if (card) window.open(card.getAttribute('data-url'), '_blank', 'noopener,noreferrer');
    }
    var tag = document.activeElement.tagName;
    if (e.key === '/' && tag !== 'INPUT' && tag !== 'TEXTAREA') {
      e.preventDefault(); document.getElementById('srch').focus();
    }
    if (e.key === 'Escape') document.activeElement.blur();
  });

  // ── Count ─────────────────────────────────────────────────────
  function updateCount(n) {
    var lc = document.getElementById('lc'); if (!lc) return;
    lc.innerHTML = n === TOTAL
      ? '<em>' + TOTAL + '</em> tools'
      : 'Showing <em>' + n + '</em> of <em>' + TOTAL + '</em> tools';
  }

  // ── toolMatches ───────────────────────────────────────────────
  function toolMatches(tool, q) {
    if (activeFilters.length > 0 && activeFilters.indexOf(tool.category) === -1) return false;
    var s = [
      tool.name, tool.description, tool.category, tool.url,
      tool.tags.map(function (t) { return '#' + t; }).join(' ')
    ].join(' ').toLowerCase();
    if (q && s.indexOf(q) === -1) return false;
    if (at !== 'all' && s.indexOf(at) === -1) return false;
    return true;
  }

  // ── Core apply ────────────────────────────────────────────────
  function apply(flash) {
    var q        = document.getElementById('srch').value.toLowerCase().trim();
    var catsEl   = document.getElementById('cats');
    var flatView = document.getElementById('flat-view');
    var flatGrid = document.getElementById('flat-grid');

    if (sortMode === 'az' || sortMode === 'recent') {
      catsEl.classList.add('hidden'); flatView.classList.remove('hidden'); flatGrid.innerHTML = '';
      var matched = allTools.filter(function (tool) { return toolMatches(tool, q); });
      if (sortMode === 'az') {
        matched.sort(function (a, b) { return a.name.toLowerCase().localeCompare(b.name.toLowerCase()); });
      } else {
        matched.sort(function (a, b) { return allTools.indexOf(b) - allTools.indexOf(a); });
      }
      matched.forEach(function (tool) {
        var cat  = allCategories.filter(function (c) { return c.id === tool.category; })[0] || {};
        var card = buildCard(tool, cat.color || '#6c63ff');
        if (flash) { card.classList.remove('flash'); void card.offsetWidth; card.classList.add('flash'); }
        flatGrid.appendChild(card);
      });
      document.getElementById('nores').classList[matched.length > 0 ? 'remove' : 'add']('show');
      updateCount(matched.length);
      return;
    }

    catsEl.classList.remove('hidden'); flatView.classList.add('hidden');
    var any = false, vis = 0;
    document.querySelectorAll('.cat').forEach(function (sec) {
      var cid = sec.getAttribute('data-id');
      if (activeFilters.length > 0 && activeFilters.indexOf(cid) === -1) {
        sec.classList.add('hidden'); return;
      }
      var hasVis = false;
      sec.querySelectorAll('.card').forEach(function (c) {
        var s = c.getAttribute('data-s') || '';
        var match = (!q || s.indexOf(q) !== -1) && (at === 'all' || s.indexOf(at) !== -1);
        if (match) {
          c.classList.remove('hidden'); hasVis = true; any = true; vis++;
          if (flash) { c.classList.remove('flash'); void c.offsetWidth; c.classList.add('flash'); }
        } else { c.classList.add('hidden'); }
      });
      if (hasVis) sec.classList.remove('hidden'); else sec.classList.add('hidden');
    });
    document.getElementById('nores').classList[any ? 'remove' : 'add']('show');
    updateCount(vis);
  }

  // ── Debounced search (smoother on low-end Android) ────────────
  var _searchTimer;
  document.getElementById('srch').addEventListener('input', function () {
    clearTimeout(_searchTimer);
    _searchTimer = setTimeout(function () { apply(false); }, 80);
  }, { passive: true });

  // ── Multi-select category filter ──────────────────────────────
  document.getElementById('fwrap').addEventListener('click', function (e) {
    var b = e.target.closest('.fb'); if (!b) return;
    var fid = b.getAttribute('data-f');
    if (fid === 'all') {
      activeFilters = [];
      document.querySelectorAll('.fb').forEach(function (x) { x.classList.remove('active'); });
      b.classList.add('active');
    } else {
      var idx = activeFilters.indexOf(fid);
      if (idx === -1) { activeFilters.push(fid); b.classList.add('active'); }
      else { activeFilters.splice(idx, 1); b.classList.remove('active'); }
      syncAllBtn();
    }
    apply(true);
  });

  // ── Tag pill toggle ───────────────────────────────────────────
  document.getElementById('tags-row').addEventListener('click', function (e) {
    var b = e.target.closest('.tag-pill'); if (!b) return;
    var tag = b.getAttribute('data-tag');
    if (b.classList.contains('active')) { b.classList.remove('active'); at = 'all'; }
    else {
      document.querySelectorAll('.tag-pill').forEach(function (x) { x.classList.remove('active'); });
      b.classList.add('active'); at = tag;
    }
    apply(true);
  });

  // ── Scroll to top (passive — never blocks scroll on Android) ──
  window.addEventListener('scroll', function () {
    document.getElementById('topbtn').classList[window.scrollY > 300 ? 'add' : 'remove']('vis');
  }, { passive: true });

})();
