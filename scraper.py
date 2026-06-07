#!/usr/bin/env python3
"""Generic, configurable web scraper built on Playwright.

For each URL it visits (with a real headless browser, so JavaScript-rendered
pages work), it produces three outputs in an isolated per-page directory:

  1. page.html   - the fully rendered raw HTML
  2. data.json   - the page URL, title, all links, visible text, and any
                   custom fields extracted via CSS selectors from a config file
  3. screenshot.png (optional, with --screenshot)

It can also crawl: follow same-domain links up to a given depth, and optionally
respect each site's robots.txt.

Usage:
  python scraper.py https://example.com
  python scraper.py https://example.com --config fields.yaml --screenshot
  python scraper.py https://example.com --crawl-depth 1 --respect-robots
  python scraper.py --urls-file urls.txt --output-dir out

See README.md for the config file format.
"""

from __future__ import annotations

import argparse
import base64
import datetime as _dt
import json
import re
import shutil
import sys
import tempfile
import time
from collections import deque
from pathlib import Path
from urllib import robotparser
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


class RobotsCache:
    """Per-domain robots.txt lookups, cached for the duration of a run."""

    def __init__(self, user_agent: str | None):
        self.ua = user_agent or "*"
        self._cache: dict[str, robotparser.RobotFileParser | None] = {}

    def allowed(self, url: str) -> bool:
        parsed = urlparse(url)
        base = f"{parsed.scheme}://{parsed.netloc}"
        if base not in self._cache:
            rp = robotparser.RobotFileParser()
            rp.set_url(urljoin(base, "/robots.txt"))
            try:
                rp.read()
            except Exception:
                rp = None  # no robots.txt reachable -> allow
            self._cache[base] = rp
        rp = self._cache[base]
        if rp is None:
            return True
        return rp.can_fetch(self.ua, url)


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


def _asset_path(assets_dir: Path, url: str) -> Path | None:
    """Map a resource URL to a safe path under assets_dir (no traversal)."""
    p = urlparse(url)
    if p.scheme not in ("http", "https"):
        return None
    path = p.path or "/"
    if path.endswith("/"):
        path += "index.html"
    rel = re.sub(r"[^A-Za-z0-9._/-]+", "_", p.netloc + path).lstrip("/")
    if p.query:
        rel += "_" + re.sub(r"[^A-Za-z0-9._-]+", "_", p.query)[:40]
    target = (assets_dir / rel).resolve()
    if assets_dir.resolve() not in target.parents:
        return None
    return target


def extract_har_assets(har_path: Path, assets_dir: Path) -> int:
    """Pull every response body out of a HAR file into an assets/ tree."""
    try:
        har = json.loads(har_path.read_text(encoding="utf-8", errors="replace"))
    except (OSError, json.JSONDecodeError):
        return 0
    count = 0
    for entry in har.get("log", {}).get("entries", []):
        content = entry.get("response", {}).get("content", {})
        text = content.get("text")
        if text is None:
            continue
        url = entry.get("request", {}).get("url", "")
        target = _asset_path(assets_dir, url)
        if target is None:
            continue
        try:
            blob = base64.b64decode(text) if content.get("encoding") == "base64" \
                else text.encode("utf-8", "replace")
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(blob)
            count += 1
        except (OSError, ValueError):
            continue
    return count


def scrape_url_full(browser, url: str, fields: dict, out_dir: Path, screenshot: bool,
                    user_agent: str | None, timeout: int) -> dict:
    """Capture everything DevTools shows: rendered DOM, MHTML, HAR, and assets/.

    Uses a fresh context per page so each gets its own network recording.
    """
    print(f"-> {url}  (full capture)")
    har_tmp = Path(tempfile.mkdtemp()) / "network.har"
    context = browser.new_context(
        user_agent=user_agent,
        ignore_https_errors=True,
        record_har_path=str(har_tmp),
        record_har_content="embed",
    )
    context.set_default_timeout(timeout)
    page = context.new_page()
    try:
        response = page.goto(url, wait_until="networkidle")
        status = response.status if response else None
        final_url = page.url

        page_dir = out_dir / slugify(final_url)
        page_dir.mkdir(parents=True, exist_ok=True)

        html = page.content()
        (page_dir / "page.html").write_text(html, encoding="utf-8")
        page_title = page.title()
        visible_text = page.inner_text("body") if page.query_selector("body") else ""
        links = extract_links(page, final_url)
        custom = extract_fields(page, fields)

        screenshot_path = None
        if screenshot:
            shot = page_dir / "screenshot.png"
            page.screenshot(path=str(shot), full_page=True)
            screenshot_path = str(shot)

        # MHTML — a single self-contained snapshot, via Chrome DevTools Protocol.
        mhtml_path = None
        try:
            client = context.new_cdp_session(page)
            snap = client.send("Page.captureSnapshot", {"format": "mhtml"})
            mhtml_path = page_dir / "page.mhtml"
            mhtml_path.write_text(snap["data"], encoding="utf-8")
        except Exception as exc:  # pragma: no cover - CDP edge cases
            print(f"    ! MHTML capture failed: {exc}", file=sys.stderr)
    finally:
        context.close()  # finalizes the HAR file

    # Move the HAR next to the page and unpack its bodies into assets/.
    har_path = page_dir / "network.har"
    try:
        shutil.move(str(har_tmp), str(har_path))
    except OSError:
        har_path = None
    assets_count = extract_har_assets(har_path, page_dir / "assets") if har_path else 0
    shutil.rmtree(har_tmp.parent, ignore_errors=True)

    data = {
        "requested_url": url,
        "final_url": final_url,
        "status": status,
        "fetched_at": _dt.datetime.now(_dt.timezone.utc).isoformat(),
        "title": page_title,
        "html_file": str(page_dir / "page.html"),
        "mhtml_file": str(mhtml_path) if mhtml_path else None,
        "har_file": str(har_path) if har_path else None,
        "assets_dir": str(page_dir / "assets") if assets_count else None,
        "assets_count": assets_count,
        "screenshot_file": screenshot_path,
        "text": visible_text,
        "links": links,
        "fields": custom,
    }
    (page_dir / "data.json").write_text(
        json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    print(f"   saved DOM + MHTML + HAR + {assets_count} asset(s) -> {page_dir}/")
    return data


def scrape(
    urls: list[str],
    output_dir: str = "output",
    fields: dict | None = None,
    screenshot: bool = False,
    crawl_depth: int = 0,
    same_domain_only: bool = True,
    max_pages: int = 50,
    respect_robots: bool = False,
    timeout: int = 30000,
    user_agent: str | None = None,
    headful: bool = False,
    delay: float = 0.0,
    full_capture: bool = False,
) -> dict:
    """Scrape (and optionally crawl) the given URLs. Returns a run summary.

    This is the reusable entry point the dashboard imports. When full_capture is
    set, each page also yields an MHTML snapshot, a HAR of all network traffic,
    and an assets/ folder of every downloaded resource.
    """
    fields = fields or {}
    out_dir = Path(output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    robots = RobotsCache(user_agent) if respect_robots else None
    start_domains = {urlparse(u).netloc for u in urls}

    results: list[dict] = []
    failures: list[dict] = []

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=not headful)
        # Full capture uses a fresh context per page (own HAR), so we only spin
        # up a shared context/page for the lightweight default mode.
        page = None
        if not full_capture:
            context = browser.new_context(user_agent=user_agent, ignore_https_errors=True)
            context.set_default_timeout(timeout)
            page = context.new_page()

        queue: deque[tuple[str, int]] = deque((u, 0) for u in urls)
        visited: set[str] = set()

        while queue and len(results) < max_pages:
            url, depth = queue.popleft()
            if url in visited:
                continue
            visited.add(url)

            if robots and not robots.allowed(url):
                print(f"   ! blocked by robots.txt: {url}", file=sys.stderr)
                failures.append({"url": url, "error": "blocked by robots.txt"})
                continue

            try:
                if full_capture:
                    data = scrape_url_full(browser, url, fields, out_dir, screenshot,
                                           user_agent, timeout)
                else:
                    data = scrape_url(page, url, fields, out_dir, screenshot)
                results.append(data)
            except PWTimeoutError:
                print(f"   ! timeout loading {url}", file=sys.stderr)
                failures.append({"url": url, "error": "timeout"})
                continue
            except Exception as exc:
                print(f"   ! failed {url}: {exc}", file=sys.stderr)
                failures.append({"url": url, "error": str(exc)})
                continue

            # Enqueue further links if we still have crawl depth to spend.
            if depth < crawl_depth:
                for link in data["links"]:
                    lu = link["url"]
                    if lu in visited:
                        continue
                    parsed = urlparse(lu)
                    if parsed.scheme not in ("http", "https"):
                        continue
                    if same_domain_only and parsed.netloc not in start_domains:
                        continue
                    queue.append((lu, depth + 1))

            if delay:
                time.sleep(delay)

        browser.close()

    summary = {
        "scraped": len(results),
        "failed": len(failures),
        "output_dir": str(out_dir),
        "pages": [
            {
                "url": r["final_url"],
                "title": r["title"],
                "links": len(r["links"]),
                "dir": slugify(r["final_url"]),
            }
            for r in results
        ],
        "failures": failures,
    }
    (out_dir / "index.json").write_text(
        json.dumps(summary, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    return summary


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
    parser.add_argument("--crawl-depth", type=int, default=0,
                        help="Follow links up to this depth (0 = only the given URLs).")
    parser.add_argument("--max-pages", type=int, default=50,
                        help="Stop after scraping this many pages.")
    parser.add_argument("--all-domains", action="store_true",
                        help="When crawling, follow links off the starting domain(s) too.")
    parser.add_argument("--respect-robots", action="store_true",
                        help="Skip URLs disallowed by the site's robots.txt.")
    parser.add_argument("--delay", type=float, default=0.0,
                        help="Seconds to wait between page loads (be polite).")
    parser.add_argument("--full-capture", action="store_true",
                        help="Also save MHTML snapshot, HAR, and an assets/ folder per page.")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    urls = read_urls(args)
    if not urls:
        sys.exit("No URLs provided. Pass a URL or --urls-file. Use -h for help.")

    fields = normalize_fields(load_config(args.config))
    summary = scrape(
        urls,
        output_dir=args.output_dir,
        fields=fields,
        screenshot=args.screenshot,
        crawl_depth=args.crawl_depth,
        same_domain_only=not args.all_domains,
        max_pages=args.max_pages,
        respect_robots=args.respect_robots,
        timeout=args.timeout,
        user_agent=args.user_agent,
        headful=args.headful,
        delay=args.delay,
        full_capture=args.full_capture,
    )
    print(
        f"\nDone: {summary['scraped']} scraped, {summary['failed']} failed. "
        f"Index: {summary['output_dir']}/index.json"
    )
    return 0 if not summary["failures"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
