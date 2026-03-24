(function () {
  // af is now a Set of selected category IDs. Empty = show all.
  var af = new Set(), at = 'all', sortMode = 'default';
  var allTools = [], allCategories = [];
  var TOTAL = 0;
  var NEW_COUNT = 11;

  // ── Logo / content protection ──────────────────────────────
  document.addEventListener('contextmenu', function (e) {
    if (e.target.closest('header') || e.target.tagName === 'IMG') e.preventDefault();
  });
  document.addEventListener('dragstart', function (e) { e.preventDefault(); });

  // ── Load data ──────────────────────────────────────────────
  fetch('./tools.json')
    .then(function (r) { return r.json(); })
    .then(function (data) {
      allCategories = data.categories;
      allTools = data.tools;
      TOTAL = allTools.length;
      buildFilterButtons();
      buildDOM();
      buildFlatView();
      buildSortControls();
      apply(false);
    })
    .catch(function () {
      document.getElementById('cats').innerHTML =
        '<p style="color:#e11d48;padding:40px">Failed to load tools.json — make sure the file is in the same folder as index.html.</p>';
    });

  // ── Toast ──────────────────────────────────────────────────
  var toastT;
  function toast(msg, icon) {
    var t = document.getElementById('toast');
    t.innerHTML = (icon ? '<span class="toast-icon">' + icon + '</span>' : '') + '<span>' + msg + '</span>';
    t.classList.add('show');
    clearTimeout(toastT);
    toastT = setTimeout(function () { t.classList.remove('show'); }, 2200);
  }

  function fallbackCopy(txt) {
    var ta = document.createElement('textarea');
    ta.value = txt; ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0;';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch (e) {}
    document.body.removeChild(ta);
  }

  // ── Share ──────────────────────────────────────────────────
  function shareCard(name, description, url) {
    var text = name + ' — ' + description;
    if (navigator.share) {
      navigator.share({ title: name, text: description, url: url }).catch(function () {});
      return;
    }
    var fullText = text + (url ? '\n' + url : '');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(fullText)
        .then(function () { toast('Copied to clipboard', '📋'); })
        .catch(function () { fallbackCopy(fullText); toast('Copied to clipboard', '📋'); });
    } else {
      fallbackCopy(fullText);
      toast('Copied to clipboard', '📋');
    }
  }

  // ── Build category filter buttons ─────────────────────────
  function buildFilterButtons() {
    var fwrap = document.getElementById('fwrap');
    fwrap.innerHTML = '';

    var all = document.createElement('button');
    all.className = 'fb active';
    all.setAttribute('data-f', 'all');
    all.textContent = 'All';
    fwrap.appendChild(all);

    allCategories.forEach(function (cat) {
      var btn = document.createElement('button');
      btn.className = 'fb';
      btn.setAttribute('data-f', cat.id);
      var count = allTools.filter(function (t) { return t.category === cat.id; }).length;
      btn.textContent = cat.icon + ' ' + (cat.short || cat.label) + ' · ' + count;
      fwrap.appendChild(btn);
    });
  }

  // ── Sync "All" button active state ────────────────────────
  function syncAllBtn() {
    var allBtn = document.querySelector('.fb[data-f="all"]');
    if (!allBtn) return;
    if (af.size === 0) {
      allBtn.classList.add('active');
    } else {
      allBtn.classList.remove('active');
    }
  }

  // ── Build grouped category view ────────────────────────────
  function buildDOM() {
    var cats = document.getElementById('cats');
    cats.innerHTML = '';
    var statsEl = document.getElementById('stat-tools');
    var statCatEl = document.getElementById('stat-cats');
    if (statsEl) statsEl.textContent = TOTAL;
    if (statCatEl) statCatEl.textContent = allCategories.length;

    allCategories.forEach(function (cat) {
      var tools = allTools.filter(function (t) { return t.category === cat.id; });
      if (!tools.length) return;

      var section = document.createElement('section');
      section.className = 'cat';
      section.setAttribute('data-id', cat.id);

      var hdr = document.createElement('div');
      hdr.className = 'cat-hdr';
      hdr.innerHTML =
        '<div class="cat-ico" style="background:' + cat.color + '22;border:1px solid ' + cat.color + '55">' + cat.icon + '</div>' +
        '<div class="cat-title">' + cat.label + '</div>' +
        '<div class="cat-cnt">' + tools.length + '</div>';
      section.appendChild(hdr);

      var grid = document.createElement('div');
      grid.className = 'grid';
      tools.forEach(function (tool) { grid.appendChild(buildCard(tool, cat.color)); });
      section.appendChild(grid);
      cats.appendChild(section);
    });
  }

  // ── Build flat view container ──────────────────────────────
  function buildFlatView() {
    var flatView = document.createElement('div');
    flatView.id = 'flat-view';
    flatView.className = 'flat-view hidden';
    var grid = document.createElement('div');
    grid.className = 'grid';
    grid.id = 'flat-grid';
    flatView.appendChild(grid);
    var cats = document.getElementById('cats');
    cats.parentNode.insertBefore(flatView, cats.nextSibling);
  }

  // ── Build sort controls ────────────────────────────────────
  function buildSortControls() {
    if (document.getElementById('sort-wrap')) return;
    var sortWrap = document.createElement('div');
    sortWrap.id = 'sort-wrap';
    sortWrap.className = 'sort-wrap';
    sortWrap.innerHTML =
      '<span class="sort-label">Sort:</span>' +
      '<button class="sort-btn active" data-sort="default">Default</button>' +
      '<button class="sort-btn" data-sort="az">A \u2192 Z</button>' +
      '<button class="sort-btn" data-sort="recent">Recently Added</button>';
    document.getElementById('lc').parentNode.appendChild(sortWrap);

    sortWrap.addEventListener('click', function (e) {
      var b = e.target.closest('.sort-btn'); if (!b) return;
      var isActive = b.classList.contains('active');
      var clicked = b.getAttribute('data-sort');
      document.querySelectorAll('.sort-btn').forEach(function (x) { x.classList.remove('active'); });
      if (isActive && clicked !== 'default') {
        document.querySelector('.sort-btn[data-sort="default"]').classList.add('active');
        sortMode = 'default';
      } else {
        b.classList.add('active');
        sortMode = clicked;
      }
      apply(true);
    });
  }

  // ── Build a single card ────────────────────────────────────
  function buildCard(tool, color) {
    var toolIndex = allTools.indexOf(tool);
    var isNew = toolIndex >= allTools.length - NEW_COUNT;

    var searchStr = [
      tool.name, tool.description, tool.category, tool.url,
      tool.tags.map(function (t) { return '#' + t; }).join(' ')
    ].join(' ').toLowerCase();

    var card = document.createElement('div');
    card.className = 'card';
    card.setAttribute('data-s', searchStr);
    card.setAttribute('data-idx', toolIndex);
    card.setAttribute('data-cat', tool.category);
    card.style.setProperty('--ca', color);

    if (tool.url) {
      card.setAttribute('data-url', tool.url);
      card.setAttribute('role', 'link');
      card.setAttribute('tabindex', '0');
    }

    var nameEl = document.createElement('div');
    nameEl.className = 'tool-name';
    nameEl.textContent = tool.name;

    if (isNew) {
      var badge = document.createElement('span');
      badge.className = 'new-badge';
      badge.textContent = 'New';
      nameEl.appendChild(badge);
    }

    var descEl = document.createElement('div');
    descEl.className = 'tool-desc';
    descEl.textContent = tool.description;

    card.appendChild(nameEl);
    card.appendChild(descEl);

    if (tool.url) {
      var domain = tool.url.replace(/https?:\/\//, '').split('/')[0];
      var link = document.createElement('a');
      link.className = 'tool-link';
      link.href = tool.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = domain + ' \u2197';
      card.appendChild(link);

      var actions = document.createElement('div');
      actions.className = 'card-actions';

      var shareBtn = document.createElement('button');
      shareBtn.className = 'ca-btn share-btn';
      shareBtn.title = 'Share';
      shareBtn.innerHTML = '\u2197\uFE0E Share';

      (function (n, d, u) {
        shareBtn.addEventListener('click', function (e) {
          e.stopPropagation();
          e.preventDefault();
          shareCard(n, d, u);
        });
      })(tool.name, tool.description, tool.url);

      actions.appendChild(shareBtn);
      card.appendChild(actions);
    } else {
      var noLink = document.createElement('span');
      noLink.className = 'no-link';
      noLink.textContent = 'Search on Google';
      card.appendChild(noLink);
    }

    return card;
  }

  // ── Card click to open URL ─────────────────────────────────
  document.addEventListener('click', function (e) {
    if (e.target.closest('button') || e.target.closest('a')) return;
    var card = e.target.closest('.card[data-url]');
    if (!card) return;
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

  // ── Count ──────────────────────────────────────────────────
  function updateCount(n) {
    var lc = document.getElementById('lc');
    if (!lc) return;
    lc.innerHTML = n === TOTAL
      ? '<em>' + TOTAL + '</em> tools'
      : 'Showing <em>' + n + '</em> of <em>' + TOTAL + '</em> tools';
  }

  // ── Helper: does this tool pass current filters? ───────────
  function toolMatches(tool, q) {
    if (af.size > 0 && !af.has(tool.category)) return false;
    var s = [
      tool.name, tool.description, tool.category, tool.url,
      tool.tags.map(function (t) { return '#' + t; }).join(' ')
    ].join(' ').toLowerCase();
    if (q && s.indexOf(q) === -1) return false;
    if (at !== 'all' && s.indexOf(at) === -1) return false;
    return true;
  }

  // ── Core apply ─────────────────────────────────────────────
  function apply(flash) {
    var q = document.getElementById('srch').value.toLowerCase().trim();
    var catsEl   = document.getElementById('cats');
    var flatView = document.getElementById('flat-view');
    var flatGrid = document.getElementById('flat-grid');

    // ── FLAT MODE: A-Z or Recently Added ──────────────────
    if (sortMode === 'az' || sortMode === 'recent') {
      catsEl.classList.add('hidden');
      flatView.classList.remove('hidden');
      flatGrid.innerHTML = '';

      var matched = allTools.filter(function (tool) { return toolMatches(tool, q); });

      if (sortMode === 'az') {
        matched.sort(function (a, b) {
          return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
        });
      } else {
        matched.sort(function (a, b) {
          return allTools.indexOf(b) - allTools.indexOf(a);
        });
      }

      matched.forEach(function (tool) {
        var cat = allCategories.filter(function (c) { return c.id === tool.category; })[0] || {};
        var card = buildCard(tool, cat.color || '#6c63ff');
        if (flash) { card.classList.remove('flash'); void card.offsetWidth; card.classList.add('flash'); }
        flatGrid.appendChild(card);
      });

      var hasAny = matched.length > 0;
      document.getElementById('nores').classList[hasAny ? 'remove' : 'add']('show');
      updateCount(matched.length);
      return;
    }

    // ── DEFAULT MODE: grouped by category ─────────────────
    catsEl.classList.remove('hidden');
    flatView.classList.add('hidden');

    var any = false, vis = 0;
    document.querySelectorAll('.cat').forEach(function (sec) {
      var cid = sec.getAttribute('data-id');
      // Hide section if it's not in the selected set (when set is non-empty)
      if (af.size > 0 && !af.has(cid)) { sec.classList.add('hidden'); return; }
      var hasVis = false;
      sec.querySelectorAll('.card').forEach(function (c) {
        var s = c.getAttribute('data-s') || '';
        var match = (!q || s.indexOf(q) !== -1) && (at === 'all' || s.indexOf(at) !== -1);
        if (match) {
          c.classList.remove('hidden'); hasVis = true; any = true; vis++;
          if (flash) { c.classList.remove('flash'); void c.offsetWidth; c.classList.add('flash'); }
        } else {
          c.classList.add('hidden');
        }
      });
      if (hasVis) sec.classList.remove('hidden'); else sec.classList.add('hidden');
    });
    document.getElementById('nores').classList[any ? 'remove' : 'add']('show');
    updateCount(vis);
  }

  document.getElementById('srch').addEventListener('input', function () { apply(false); });

  // ── Multi-select category filter ───────────────────────────
  document.getElementById('fwrap').addEventListener('click', function (e) {
    var b = e.target.closest('.fb'); if (!b) return;
    var fid = b.getAttribute('data-f');

    if (fid === 'all') {
      // All button: clear all selections
      af.clear();
      document.querySelectorAll('.fb').forEach(function (x) { x.classList.remove('active'); });
      b.classList.add('active');
    } else {
      // Toggle this category in/out of the set
      if (af.has(fid)) {
        af.delete(fid);
        b.classList.remove('active');
      } else {
        af.add(fid);
        b.classList.add('active');
      }
      syncAllBtn();
    }
    apply(true);
  });

  // ── Tag pill toggle ────────────────────────────────────────
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

  // ── Scroll to top ──────────────────────────────────────────
  window.addEventListener('scroll', function () {
    document.getElementById('topbtn').classList[window.scrollY > 300 ? 'add' : 'remove']('vis');
  }, { passive: true });

})();