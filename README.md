# tinyfish-pi-extension

Web search + page fetch tools for the [pi coding agent](https://pi.dev), powered by the [TinyFish](https://tinyfish.ai) Search and Fetch APIs.

Adds two tools:

| Tool | What it does |
|------|--------------|
| `tinyfish_search` | Structured web search: ranked results with titles, snippets, URLs. Supports news and research-paper search, geo/language targeting, domain include/exclude, date & recency windows, pagination. |
| `tinyfish_fetch` | Fetch up to 10 URLs in parallel and extract clean content (markdown by default). Renders JS-heavy pages, handles per-URL failures independently, supports CSS selector scoping and link/image extraction. |

## Install

Copy `tinyfish.ts` to your global pi extensions directory:

```bash
mkdir -p ~/.pi/agent/extensions
cp tinyfish.ts ~/.pi/agent/extensions/tinyfish.ts
```

Then run `/reload` in pi (or restart pi).

## API key

Get a key at [agent.tinyfish.ai/api-keys](https://agent.tinyfish.ai/api-keys) (Search and Fetch are free; credits are only used by Agent/Browser APIs).

Configure it one of two ways:

1. **In pi** (persists to `~/.pi/agent/tinyfish.json`):

   ```
   /tinyfish key <KEY>
   ```

2. **Environment variable**:

   ```bash
   export TINYFISH_API_KEY="your_key_here"
   ```

Check status with `/tinyfish`, remove the saved key with `/tinyfish clear`.

> ⚠️ **Never commit your API key.** The extension reads keys from your local config/env only — this repo contains no key and `.gitignore` excludes config files.

## Usage

In pi, just ask:

- *"Search the web for the latest news on X"*
- *"Fetch https://example.com and summarize it"*
- *"Find recent research papers on LLM agents from 2024"* (uses `domain_type: research_paper`)

### Examples (tool params)

```jsonc
// tinyfish_search
{
  "query": "web automation tools",
  "purpose": "Find an open-source library for parsing PDF invoices in Python",
  "domain_type": "news",            // web | news | research_paper
  "location": "US",                 // geo-targeted results
  "include_domains": "github.com,arxiv.org",
  "recency_minutes": 10080,         // last 7 days
  "page": 1
}

// tinyfish_fetch
{
  "urls": ["https://example.com", "https://example.org"],
  "purpose": "Compare pricing tiers across vendors",
  "format": "markdown",             // markdown | html | json
  "links": true,
  "include_selectors": ["article"], // scope extraction to <article>
  "exclude_selectors": [".comments"]
}
```

## API

- Search: `GET https://api.search.tinyfish.ai` — [docs](https://docs.tinyfish.ai/api-reference/search-the-web.md)
- Fetch: `POST https://api.fetch.tinyfish.ai` — [docs](https://docs.tinyfish.ai/api-reference/fetch-and-extract-content-from-urls.md)
- Auth: `X-API-Key` header

## License

MIT
