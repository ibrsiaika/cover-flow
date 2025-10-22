// Frontend logic for Genie Search

(function () {
  const qInput = document.getElementById('searchInput');
  const form = document.getElementById('searchForm');
  const resultsEl = document.getElementById('results');
  const paginationEl = document.getElementById('pagination');
  const suggestionsEl = document.getElementById('suggestions');
  const luckyBtn = document.getElementById('luckyBtn');
  const crawlForm = document.getElementById('crawlForm');
  const crawlStatusEl = document.getElementById('crawlStatus');
  const engineStatsEl = document.getElementById('engineStats');
  const stopCrawlBtn = document.getElementById('stopCrawlBtn');
  const clearIndexBtn = document.getElementById('clearIndexBtn');

  let pollTimer = null;
  let lastQuery = '';
  let totalCount = 0;
  const pageSize = 10;
  let currentOffset = 0;

  function escapeHtml(str) {
    return (str || '').replace(/[&<>"']/g, s => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[s]);
  }

  function renderResults(data) {
    totalCount = data && typeof data.count === 'number' ? data.count : 0;
    if (!data || !Array.isArray(data.results) || data.results.length === 0) {
      resultsEl.innerHTML = `
        <div class="results-empty">
          <div class="results-empty-title">No results</div>
          <div class="results-empty-subtitle">Try different keywords or index a site below.</div>
        </div>`;
      paginationEl.innerHTML = '';
      return;
    }

    const parts = [];
    for (const r of data.results) {
      const title = escapeHtml(r.title || r.url);
      const url = escapeHtml(r.url);
      const snippet = r.snippet || '';
      parts.push(`
        <a class="result-item" href="${url}" target="_blank" rel="noopener noreferrer">
          <div class="result-title">${title}</div>
          <div class="result-url">${url}</div>
          <div class="result-snippet">${snippet}</div>
        </a>
      `);
    }
    resultsEl.innerHTML = parts.join('');
    renderPagination();
  }

  function renderPagination() {
    const prevDisabled = currentOffset <= 0;
    const nextDisabled = currentOffset + pageSize >= totalCount;
    const start = totalCount === 0 ? 0 : currentOffset + 1;
    const end = Math.min(totalCount, currentOffset + pageSize);

    paginationEl.innerHTML = `
      <div class="pager">
        <button class="pager-btn" ${prevDisabled ? 'disabled' : ''} id="prevPage">Prev</button>
        <div class="pager-status">${start}-${end} of ${totalCount}</div>
        <button class="pager-btn" ${nextDisabled ? 'disabled' : ''} id="nextPage">Next</button>
      </div>
    `;

    const prev = document.getElementById('prevPage');
    const next = document.getElementById('nextPage');
    if (prev) prev.addEventListener('click', () => {
      if (currentOffset >= pageSize) {
        currentOffset -= pageSize;
        doSearch(lastQuery, currentOffset);
      }
    });
    if (next) next.addEventListener('click', () => {
      if (currentOffset + pageSize < totalCount) {
        currentOffset += pageSize;
        doSearch(lastQuery, currentOffset);
      }
    });
  }

  async function doSearch(query, offset = 0) {
    if (!query || !query.trim()) return;
    lastQuery = query;
    currentOffset = offset;
    resultsEl.innerHTML = '<div class="results-loading">Searching…</div>';
    paginationEl.innerHTML = '';

    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(query)}&limit=${pageSize}&offset=${offset}`);
      if (!res.ok) {
        const tx = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} ${res.statusText} ${tx}`);
      }
      const data = await res.json();
      renderResults(data);
    } catch (e) {
      resultsEl.innerHTML = '<div class="results-error">Search failed. Please try again.</div>';
    }
  }

  async function fetchStatus() {
    try {
      const res = await fetch('/api/status');
      if (!res.ok) throw new Error('status failed');
      const data = await res.json();
      const { crawl, index } = data;

      engineStatsEl.innerHTML = `
        <div class="stat-card">
          <div class="stat-value">${index.documents || 0}</div>
          <div class="stat-label">Documents</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">${index.terms || 0}</div>
          <div class="stat-label">Terms</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">${crawl.running ? 'Running' : 'Idle'}</div>
          <div class="stat-label">Crawler</div>
        </div>
      `;

      const statusText = crawl.running
        ? `Crawling… visited ${crawl.visitedCount} pages, queue ${crawl.queueLength}. Started ${new Date(crawl.startedAt).toLocaleString()}`
        : `Idle. ${crawl.finishedAt ? `Last finished ${new Date(crawl.finishedAt).toLocaleString()}.` : ''}`;

      crawlStatusEl.textContent = statusText;

      if (crawl.running && !pollTimer) {
        pollTimer = setInterval(fetchStatus, 3000);
      } else if (!crawl.running && pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    } catch {
      // ignore
    }
  }

  async function fetchSuggestions(prefix) {
    try {
      const res = await fetch(`/api/suggest?q=${encodeURIComponent(prefix)}`);
      if (!res.ok) return [];
      const data = await res.json();
      return Array.isArray(data.suggestions) ? data.suggestions : [];
    } catch {
      return [];
    }
  }

  function renderSuggestions(items) {
    if (!items || items.length === 0) {
      suggestionsEl.innerHTML = '';
      suggestionsEl.style.display = 'none';
      return;
    }
    suggestionsEl.innerHTML = items.map(t => `<button type="button" class="suggestion-item">${escapeHtml(t)}</button>`).join('');
    suggestionsEl.style.display = 'block';
    suggestionsEl.querySelectorAll('.suggestion-item').forEach(btn => {
      btn.addEventListener('click', () => {
        const term = btn.textContent || '';
        const base = qInput.value.trim();
        const space = base && !base.endsWith(' ') ? ' ' : '';
        qInput.value = base + space + term;
        suggestionsEl.style.display = 'none';
        qInput.focus();
        doSearch(qInput.value);
      });
    });
  }

  if (qInput) {
    let suggestTimer = null;
    qInput.addEventListener('input', () => {
      const val = qInput.value.trim();
      if (suggestTimer) clearTimeout(suggestTimer);
      if (val.length < 2) {
        suggestionsEl.style.display = 'none';
        suggestionsEl.innerHTML = '';
        return;
      }
      suggestTimer = setTimeout(async () => {
        const items = await fetchSuggestions(val.split(/\s+/).pop());
        renderSuggestions(items);
      }, 200);
    });

    qInput.addEventListener('blur', () => {
      setTimeout(() => {
        suggestionsEl.style.display = 'none';
      }, 150);
    });
  }

  if (form) {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      doSearch(qInput.value);
    });
  }

  if (luckyBtn) {
    luckyBtn.addEventListener('click', async () => {
      const q = qInput.value.trim();
      if (!q) return;
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}&limit=1`);
        if (!res.ok) return;
        const data = await res.json();
        const first = data.results && data.results[0];
        if (first && first.url) {
          window.open(first.url, '_blank', 'noopener,noreferrer');
        }
      } catch {
        // ignore
      }
    });
  }

  if (crawlForm) {
    crawlForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const seedUrl = document.getElementById('seedUrl').value.trim();
      const maxPages = parseInt(document.getElementById('maxPages').value, 10) || 50;
      const sameDomain = document.getElementById('sameDomain').checked;

      crawlStatusEl.textContent = 'Starting crawl…';
      try {
        const res = await fetch('/api/crawl', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            seeds: [seedUrl],
            maxPages,
            sameDomainOnly: sameDomain
          })
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.ok) {
          crawlStatusEl.textContent = 'Crawl started.';
          fetchStatus();
        } else {
          crawlStatusEl.textContent = (data && data.message) || 'Failed to start crawl.';
        }
      } catch {
        crawlStatusEl.textContent = 'Failed to start crawl.';
      }
    });
  }

  if (stopCrawlBtn) {
    stopCrawlBtn.addEventListener('click', async () => {
      try {
        await fetch('/api/crawl/stop', { method: 'POST' });
        fetchStatus();
      } catch {}
    });
  }

  if (clearIndexBtn) {
    clearIndexBtn.addEventListener('click', async () => {
      if (!confirm('Clear all indexed data?')) return;
      try {
        const res = await fetch('/api/index/clear', { method: 'POST' });
        const data = await res.json().catch(() => ({}));
        crawlStatusEl.textContent = (data && data.message) || 'Cleared.';
        fetchStatus();
        resultsEl.innerHTML = '';
        paginationEl.innerHTML = '';
      } catch {}
    });
  }

  // Initial status load
  fetchStatus();
})();