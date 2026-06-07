# SearchandResearch — Generic Web Scraper

A configurable command-line web scraper built on
[Playwright](https://playwright.dev/python/). Because it drives a real headless
Chromium browser, it handles JavaScript-rendered / dynamic pages, not just
static HTML.

For every URL it visits it produces, in a per-page output directory:

1. **`page.html`** — the fully rendered raw HTML
2. **`data.json`** — URL, title, all links (resolved to absolute URLs), the
   visible page text, and any custom fields you define via CSS selectors
3. **`screenshot.png`** — a full-page screenshot (optional, with `--screenshot`)

A run-level **`index.json`** summarizes everything that was scraped.

It works two ways: as a **web dashboard** (paste a URL, read clickable
instructions, download results as a ZIP) and as a **command-line tool**. It can
also **crawl** — following same-domain links to a configurable depth — and
optionally honor each site's `robots.txt`.

## Install

```bash
pip install -r requirements.txt
playwright install chromium   # one-time: downloads the browser binary
```

## Dashboard

```bash
python app.py        # or double-click run.sh (macOS/Linux) / run.bat (Windows)
```

It starts a small local server and **opens the dashboard in your browser
automatically** (`http://127.0.0.1:5000`). A plain `.html` file opened from disk
can't drive a headless browser or write files, so this lightweight backend does
that part — from your side it's still "open and go".

The dashboard gives you:

- a **box to paste the URL** to scrape (plus screenshot / crawl-depth /
  robots.txt / max-pages options);
- a **destination choice** — save into the repo's `collections/` folder (for you
  to commit/push yourself; nothing is pushed automatically) **or** into any local
  folder you type in;
- **clickable, collapsible instructions** explaining how to set it up and use it;
- a **Download results (ZIP)** button that packages the run's folders and
  subfolders into one archive.

Every run lands in a timestamped folder containing each page's `page.html`,
`data.json`, optional `screenshot.png`, and a standalone **`report.html`** you
can double-click to study the scraped text, links, fields, and screenshots
offline.

## Command-line usage

Scrape a single URL:

```bash
python scraper.py https://example.com
```

Scrape many URLs (one per line, `#` for comments):

```bash
python scraper.py --urls-file urls.txt --output-dir output
```

Extract custom fields and grab a screenshot:

```bash
python scraper.py https://news.ycombinator.com \
  --config fields.example.yaml --screenshot
```

Crawl same-domain links one hop deep, politely, respecting `robots.txt`:

```bash
python scraper.py https://example.com --crawl-depth 1 --respect-robots --delay 1
```

### Options

| Flag | Description | Default |
|------|-------------|---------|
| `url` | A single URL to scrape (positional) | — |
| `--urls-file` | File with one URL per line | — |
| `--config` | JSON/YAML file defining custom fields | — |
| `--output-dir` | Where results are written | `output` |
| `--screenshot` | Also save a full-page PNG | off |
| `--crawl-depth` | Follow links up to this depth (0 = given URLs only) | `0` |
| `--max-pages` | Stop after scraping this many pages | `50` |
| `--all-domains` | When crawling, also follow links off the start domain | off |
| `--respect-robots` | Skip URLs disallowed by the site's `robots.txt` | off |
| `--delay` | Seconds to wait between page loads | `0` |
| `--headful` | Run with a visible browser window | off (headless) |
| `--timeout` | Per-page timeout, in milliseconds | `30000` |
| `--user-agent` | Override the browser user agent | browser default |

## Custom field extraction

Define fields in a YAML or JSON config. Each field maps an output key to a CSS
selector. Two forms are supported:

```yaml
fields:
  # Shorthand: first matching element's text.
  page_heading: "h1"

  # Full form with options.
  story_titles:
    selector: ".titleline > a"
    multiple: true       # return a list of all matches (default: false)
    attr: text           # text | html | any HTML attribute like href/src (default: text)
```

The extracted values land under `"fields"` in each page's `data.json`. See
[`fields.example.yaml`](fields.example.yaml).

## Output layout

```
output/
├── index.json                      # run summary
└── example.com/
    ├── page.html
    ├── data.json
    └── screenshot.png              # only if --screenshot
```

## Notes

- Scrape responsibly: respect each site's `robots.txt` and Terms of Service,
  and don't hammer servers with rapid requests.
- The `output/` directory is git-ignored by default.

## License

MIT — see [LICENSE](LICENSE).
