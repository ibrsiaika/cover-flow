# Genie Search (Full‑stack)

Production‑ready starter for a local search engine with a web crawler, inverted index, and a unique ranking formula. The frontend and backend are merged in one project for a one‑click start.

## Quick start

Requirements:
- Node.js 16+ (18+ recommended)
- npm

Steps:
1) Install dependencies
   npm install

2) Start the server
   npm start

3) Open your browser at
   http://localhost:3000

Then:
- Go to the “Search” section in the navbar.
- Optionally “Index your site”: enter a seed URL, choose max pages, and start the crawler.
- Search with the input box. Try “docs”, a domain‑specific term, or anything relevant to your seed.

## What’s included

- Node.js Express server that:
  - Serves the static site (index.html, css, js, images).
  - Exposes a REST API:
    - POST /api/crawl
      body: { seeds: string[], maxPages?: number, sameDomainOnly?: boolean }
    - GET  /api/status
      returns crawl + index stats
    - GET  /api/search?q=...&limit=10
      returns ranked results with snippets

- Crawler:
  - Follows links from your seed URL(s)
  - Extracts title, meta description, visible text
  - Builds an inverted index and a simple link graph

- Unique ranking formula (“BM25‑ish + signals”):
  score = base(tf‑idf with sqrt(tf)) × titleBoost × phraseBoost × recency × depth × authority

  - tf‑idf with a smooth tf: sqrt(tf)
  - titleBoost: boost docs with query hits in the title (capped)
  - phraseBoost: boost when the full query phrase appears in body text
  - recency: half‑life ~ 180 days (newer pages get a mild edge)
  - depth: mild penalty for deep URLs (shallower paths favored slightly)
  - authority: simple PageRank‑style score derived from the crawl graph and normalized to [0..1]

- Frontend:
  - Clean search UI with instant results
  - “I’m Feeling Lucky”
  - Crawler control panel + live status
  - Responsive layout consistent with the existing template

## Notes and limits

- This is a compact, educational search engine. It’s not meant to replace Google. It’s designed to be understandable, hackable, and deployable quickly.
- The crawler respects only basic constraints (no robots.txt parsing). Add production‑grade politeness, rate limiting, and robots handling if you plan to crawl broadly.
- The index is stored to disk under ./data/ and automatically loaded on restart.

## Deploying

- Any Node host works. Set the PORT env var if needed.
- Single command run:
   npm start

- To serve behind a reverse proxy (nginx, etc.), forward traffic to the PORT the app binds to (default 3000).

## Customizing

- Ranking: Update the factors in server.js (bm25ishScore) to tweak weights.
- Crawler scope: Change sameDomainOnly or add allow/deny rules.
- UI/UX: Edit the Search section in index.html and styles at the bottom of templatemo-3d-coverflow.css.

## API Examples

Start a crawl:
curl -X POST http://localhost:3000/api/crawl \
  -H "Content-Type: application/json" \
  -d '{"seeds": ["https://example.com"], "maxPages": 50, "sameDomainOnly": true}'

Check status:
curl http://localhost:3000/api/status

Run a search:
curl "http://localhost:3000/api/search?q=example&limit=5"

## License

MIT for the code in this repository. Original 3D Coverflow design remains attributed to TemplateMo (see index.html footer).
