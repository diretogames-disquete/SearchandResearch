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

## Install

```bash
pip install -r requirements.txt
playwright install chromium   # one-time: downloads the browser binary
```

## Usage

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

### Options

| Flag | Description | Default |
|------|-------------|---------|
| `url` | A single URL to scrape (positional) | — |
| `--urls-file` | File with one URL per line | — |
| `--config` | JSON/YAML file defining custom fields | — |
| `--output-dir` | Where results are written | `output` |
| `--screenshot` | Also save a full-page PNG | off |
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
