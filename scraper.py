#!/usr/bin/env python3
"""Generic, configurable web scraper built on Playwright.

For each URL it visits (with a real headless browser, so JavaScript-rendered
pages work), it produces three outputs in an isolated per-page directory:

  1. page.html   - the fully rendered raw HTML
  2. data.json   - the page URL, title, all links, visible text, and any
                   custom fields extracted via CSS selectors from a config file
  3. screenshot.png (optional, with --screenshot)

Usage:
  python scraper.py https://example.com
  python scraper.py https://example.com --config fields.yaml --screenshot
  python scraper.py --urls-file urls.txt --output-dir out

See README.md for the config file format.
"""

from __future__ import annotations

import argparse
import datetime as _dt
import json
import re
import sys
from pathlib import Path
from urllib.parse import urljoin, urlparse

try:
    from playwright.sync_api import TimeoutError as PWTimeoutError
    from playwright.sync_api import sync_playwright
except ImportError:  # pragma: no cover - import guard for a friendlier error
    sys.exit(
        "Playwright is not installed. Run:\n"
        "  pip install -r requirements.txt\n"
        "  playwright install chromium"
    )

# PyYAML is optional - only needed when a YAML config is supplied.
try:
    import yaml
except ImportError:  # pragma: no cover
    yaml = None


def slugify(url: str) -> str:
    """Turn a URL into a filesystem-safe directory name."""
    parsed = urlparse(url)
    raw = (parsed.netloc + parsed.path).strip("/") or parsed.netloc or "page"
    slug = re.sub(r"[^A-Za-z0-9._-]+", "_", raw).strip("_")
    return slug[:120] or "page"


def load_config(path: str | None) -> dict:
    """Load a JSON or YAML config describing custom fields to extract."""
    if not path:
        return {}
    cfg_path = Path(path)
    if not cfg_path.is_file():
        sys.exit(f"Config file not found: {path}")
    text = cfg_path.read_text(encoding="utf-8")
    if cfg_path.suffix.lower() in (".yaml", ".yml"):
        if yaml is None:
            sys.exit("PyYAML is required for YAML configs. Run: pip install PyYAML")
        return yaml.safe_load(text) or {}
    return json.loads(text)


def normalize_fields(config: dict) -> dict:
    """Normalize the 'fields' section into a uniform spec dict.

    Each field maps to: {"selector", "multiple", "attr"}.
    Shorthand "name: selector" expands to a single-value text extraction.
    """
    fields = config.get("fields", {}) or {}
    normalized = {}
    for name, spec in fields.items():
        if isinstance(spec, str):
            normalized[name] = {"selector": spec, "multiple": False, "attr": "text"}
        elif isinstance(spec, dict):
            normalized[name] = {
                "selector": spec.get("selector", ""),
                "multiple": bool(spec.get("multiple", False)),
                "attr": spec.get("attr", "text"),
            }
    return normalized


def read_urls(args: argparse.Namespace) -> list[str]:
    urls: list[str] = []
    if args.url:
        urls.append(args.url)
    if args.urls_file:
        path = Path(args.urls_file)
        if not path.is_file():
            sys.exit(f"URLs file not found: {args.urls_file}")
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#"):
                urls.append(line)
    # De-duplicate while preserving order.
    seen: set[str] = set()
    deduped = []
    for u in urls:
        if u not in seen:
            seen.add(u)
            deduped.append(u)
    return deduped


def extract_element(handle, attr: str):
    """Pull a value off a Playwright element handle per the attr spec."""
    if attr == "text":
        return (handle.text_content() or "").strip()
    if attr == "html":
        return handle.inner_html()
    return handle.get_attribute(attr)


def extract_fields(page, fields: dict) -> dict:
    """Run each configured CSS selector against the page."""
    results: dict = {}
    for name, spec in fields.items():
        selector = spec["selector"]
        if not selector:
            results[name] = None
            continue
        try:
            handles = page.query_selector_all(selector)
            values = [extract_element(h, spec["attr"]) for h in handles]
            values = [v for v in values if v not in (None, "")]
            results[name] = values if spec["multiple"] else (values[0] if values else None)
        except Exception as exc:  # selectors are user-provided; never crash the run
            results[name] = None
            print(f"    ! field '{name}' selector failed: {exc}", file=sys.stderr)
    return results


def extract_links(page, base_url: str) -> list[dict]:
    """Collect every anchor's resolved href and link text."""
    raw = page.eval_on_selector_all(
        "a[href]",
        "els => els.map(e => ({href: e.getAttribute('href'), text: e.innerText.trim()}))",
    )
    links = []
    seen: set[str] = set()
    for item in raw:
        href = item.get("href")
        if not href:
            continue
        absolute = urljoin(base_url, href)
        if absolute in seen:
            continue
        seen.add(absolute)
        links.append({"url": absolute, "text": item.get("text", "")})
    return links


def scrape_url(page, url: str, fields: dict, out_dir: Path, screenshot: bool) -> dict:
    print(f"-> {url}")
    response = page.goto(url, wait_until="networkidle")
    status = response.status if response else None
    final_url = page.url

    page_dir = out_dir / slugify(final_url)
    page_dir.mkdir(parents=True, exist_ok=True)

    html = page.content()
    (page_dir / "page.html").write_text(html, encoding="utf-8")

    visible_text = page.inner_text("body") if page.query_selector("body") else ""
    links = extract_links(page, final_url)
    custom = extract_fields(page, fields)

    screenshot_path = None
    if screenshot:
        shot = page_dir / "screenshot.png"
        page.screenshot(path=str(shot), full_page=True)
        screenshot_path = str(shot)

    data = {
        "requested_url": url,
        "final_url": final_url,
        "status": status,
        "fetched_at": _dt.datetime.now(_dt.timezone.utc).isoformat(),
        "title": page.title(),
        "html_file": str(page_dir / "page.html"),
        "screenshot_file": screenshot_path,
        "text": visible_text,
        "links": links,
        "fields": custom,
    }
    (page_dir / "data.json").write_text(
        json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    print(f"   saved {len(links)} links, {len(visible_text)} chars of text -> {page_dir}/")
    return data


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Generic configurable web scraper (Playwright).",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument("url", nargs="?", help="A single URL to scrape.")
    parser.add_argument("--urls-file", help="File with one URL per line (# for comments).")
    parser.add_argument("--config", help="JSON/YAML config defining custom fields to extract.")
    parser.add_argument("--output-dir", default="output", help="Directory for results.")
    parser.add_argument("--screenshot", action="store_true", help="Also save a full-page PNG.")
    parser.add_argument("--headful", action="store_true", help="Run with a visible browser window.")
    parser.add_argument("--timeout", type=int, default=30000, help="Per-page timeout in ms.")
    parser.add_argument("--user-agent", help="Override the browser user agent.")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    urls = read_urls(args)
    if not urls:
        sys.exit("No URLs provided. Pass a URL or --urls-file. Use -h for help.")

    fields = normalize_fields(load_config(args.config))
    out_dir = Path(args.output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    results, failures = [], []
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=not args.headful)
        context = browser.new_context(
            user_agent=args.user_agent,
            ignore_https_errors=True,
        )
        context.set_default_timeout(args.timeout)
        page = context.new_page()

        for url in urls:
            try:
                results.append(scrape_url(page, url, fields, out_dir, args.screenshot))
            except PWTimeoutError:
                print(f"   ! timeout loading {url}", file=sys.stderr)
                failures.append({"url": url, "error": "timeout"})
            except Exception as exc:
                print(f"   ! failed {url}: {exc}", file=sys.stderr)
                failures.append({"url": url, "error": str(exc)})

        browser.close()

    # A run-level summary index for convenience.
    summary = {
        "scraped": len(results),
        "failed": len(failures),
        "pages": [
            {"url": r["final_url"], "title": r["title"], "links": len(r["links"])}
            for r in results
        ],
        "failures": failures,
    }
    (out_dir / "index.json").write_text(
        json.dumps(summary, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    print(f"\nDone: {len(results)} scraped, {len(failures)} failed. Index: {out_dir}/index.json")
    return 0 if not failures else 1


if __name__ == "__main__":
    raise SystemExit(main())
