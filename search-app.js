// Frontend logic for Genie Search

(function () {
  const qInput = document.getElementById('searchInput');
  const form = document.getElementById('searchForm');
  const resultsEl = document.getElementById('results');
  const luckyBtn = document.getElementById('luckyBtn');
  const crawlForm = document.getElementById('crawlForm');
  const crawlStatusEl = document.getElementById('crawlStatus');
  const engineStatsEl = document.getElementById('engineStats');

  let pollTimer = null;

  function escapeHtml(str) {
    return (str || '').replace(/[&<>"']/g, s => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[s]);
  }

  function stripTags(s) {
    const div = document.createElement('div');
    div.innerHTML = s;
    return div.textContent || div.innerText || '';
  }

  function renderResults(data) {
    if (!data || !Array.isArray(data.results) || data.results.length === 0) {
      resultsEl.innerHTML = `
        <div class="results-empty">
          <div class="results-empty-title">No results</div>
          <div class="results-empty-subtitle">Try different keywords or index a site below.</div>
        </div>`;
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
  }

  async function doSearch(query) {
    if (!query || !query.trim()) return;
    resultsEl.innerHTML = '<div class="results-loading">Searching…</div>';
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(query)}&limit=10`);
      const data = await res.json();
      renderResults(data);
    } catch (e) {
      resultsEl.innerHTML = '<div class="results-error">Search failed. Please try again.</div>';
    }
  }

  async function fetchStatus() {
    try {
      const res = await fetch('/api/status');
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
        const data = await res.json();
        if (data.ok) {
          crawlStatusEl.textContent = 'Crawl started.';
          fetchStatus();
        } else {
          crawlStatusEl.textContent = data.message || 'Failed to start crawl.';
        }
      } catch {
        crawlStatusEl.textContent = 'Failed to start crawl.';
      }
    });
  }

  // Initial status load
  fetchStatus();
})();