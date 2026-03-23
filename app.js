(function () {
  var af = 'all', at = 'all', sortMode = 'default';
  var allTools = [], allCategories = [];
  var TOTAL = 0;

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

  // ── Share — native sheet on mobile, clipboard on desktop ───
  function shareCard(name, description, url) {
    var text = name + ' — ' + description;

    // Try native Web Share API first (mobile browsers)
    if (navigator.share) {
      navigator.share({ title: name, text: description, url: url })
        .catch(function () {
          // User cancelled or error — silently ignore
        });
      return;
    }

    // Desktop: copy to clipboard with a nicer confirmation
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

  // ── Build category sections and cards ─────────────────────
  function buildDOM() {
    var cats = document.getElementById('cats');
    cats.innerHTML = '';
    var statsEl = document.getElementById('stat-tools');
    var statCatEl = document.getElementById('stat-cats');
    if (statsEl) statsEl.textContent = TOTAL;
    if (statCatEl) statCatEl.textContent = allCategories.length;

    // ── Inject sort controls ───────────────────────────────
    var existingSort = document.getElementById('sort-wrap');
    if (!existingSort) {
      var sortWrap = document.createElement('div');
      sortWrap.id = 'sort-wrap';
      sortWrap.className = 'sort-wrap';
      sortWrap.innerHTML =
        '<span class="sort-label">Sort:</span>' +
        '<button class="sort-btn active" data-sort="default">Default</button>' +
        '<button class="sort-btn" data-sort="az">A → Z</button>' +
        '<button class="sort-btn" data-sort="recent">Recently Added</button>';
      var ctrlMeta = document.getElementById('lc').parentNode;
      ctrlMeta.appendChild(sortWrap);

      sortWrap.addEventListener('click', function (e) {
        var b = e.target.closest('.sort-btn'); if (!b) return;
        document.querySelectorAll('.sort-btn').forEach(function (x) { x.classList.remove('active'); });
        b.classList.add('active');
        sortMode = b.getAttribute('data-sort');
        apply(true);
      });
    }

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

  // ── Build a single card ────────────────────────────────────
  function buildCard(tool, color) {
    var toolIndex = allTools.indexOf(tool);
    var isNew = toolIndex >= allTools.length - 11;

    var searchStr = [
      tool.name, tool.description, tool.category, tool.url,
      tool.tags.map(function (t) { return '#' + t; }).join(' ')
    ].join(' ').toLowerCase();

    var card = document.createElement('div');
    card.className = 'card';
    card.setAttribute('data-s', searchStr);
    card.setAttribute('data-idx', toolIndex);
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

      // Capture tool data in closure
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
  // Single click handler only — CSS touch-action:manipulation removes
  // the 300ms iOS delay without needing touchend hacks.
  // This also fixes the iOS double-tab bug (touchend + click firing twice).
  document.addEventListener('click', function (e) {
    // Don't trigger if clicking a button or link inside the card
    if (e.target.closest('button') || e.target.closest('a')) return;
    var card = e.target.closest('.card[data-url]');
    if (!card) return;
    var url = card.getAttribute('data-url');
    if (url) window.open(url, '_blank', 'noopener,noreferrer');
  });

  // Keyboard: Enter on focused card opens URL
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

  // ── Filter / search ────────────────────────────────────────
  function updateCount(n) {
    var lc = document.getElementById('lc');
    if (!lc) return;
    lc.innerHTML = n === TOTAL
      ? '<em>' + TOTAL + '</em> tools'
      : 'Showing <em>' + n + '</em> of <em>' + TOTAL + '</em> tools';
  }

  function apply(flash) {
    var q = document.getElementById('srch').value.toLowerCase().trim();
    var any = false, vis = 0;
    document.querySelectorAll('.cat').forEach(function (sec) {
      var cid = sec.getAttribute('data-id');
      if (af !== 'all' && af !== cid) { sec.classList.add('hidden'); return; }
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

    // ── Sort cards within each visible grid ────────────────
    if (sortMode !== 'default') {
      document.querySelectorAll('.cat:not(.hidden) .grid').forEach(function (grid) {
        var cards = Array.from(grid.querySelectorAll('.card'));
        cards.sort(function (a, b) {
          if (sortMode === 'az') {
            var na = a.querySelector('.tool-name').textContent.trim().toLowerCase();
            var nb = b.querySelector('.tool-name').textContent.trim().toLowerCase();
            return na.localeCompare(nb);
          }
          if (sortMode === 'recent') {
            return parseInt(b.getAttribute('data-idx')) - parseInt(a.getAttribute('data-idx'));
          }
          return 0;
        });
        cards.forEach(function (c) { grid.appendChild(c); });
      });
    }
  }

  document.getElementById('srch').addEventListener('input', function () { apply(false); });

  document.getElementById('fwrap').addEventListener('click', function (e) {
    var b = e.target.closest('.fb'); if (!b) return;
    var isActive = b.classList.contains('active');
    document.querySelectorAll('.fb').forEach(function (x) { x.classList.remove('active'); });
    if (isActive && b.getAttribute('data-f') !== 'all') {
      document.querySelector('.fb[data-f="all"]').classList.add('active');
      af = 'all';
    } else {
      b.classList.add('active'); af = b.getAttribute('data-f');
    }
    apply(true);
  });

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