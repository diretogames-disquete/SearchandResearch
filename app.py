#!/usr/bin/env python3
"""Web dashboard for the scraper.

Quick start (this opens the dashboard in your browser automatically):

  pip install -r requirements.txt
  playwright install chromium
  python app.py

Why a tiny backend instead of a plain .html file? A page opened from disk
(file://) is sandboxed by the browser: it cannot drive a headless browser or
write files into your repo. This local server does that work; the launcher
auto-opens the dashboard so it still feels like "just open it".

From the dashboard you can:
  * paste a URL and scrape it (screenshot, crawl depth, robots.txt options)
  * read clickable, collapsible instructions
  * save results into the repo's  collections/  folder (to commit yourself),
    or into any local folder you type in, and/or download them as a ZIP
  * each scrape also writes a standalone  report.html  you can double-click
    to study the scraped text, links, fields and screenshots offline
"""

from __future__ import annotations

import datetime as _dt
import html
import io
import json
import re
import threading
import uuid
import webbrowser
import zipfile
from pathlib import Path

from flask import Flask, jsonify, render_template, request, send_file

import scraper

REPO_ROOT = Path(__file__).resolve().parent
COLLECTIONS_DIR = REPO_ROOT / "collections"

app = Flask(__name__)

# Maps a run id -> the absolute directory that run wrote to. Lets the browser
# download a run's ZIP without ever passing a filesystem path (no traversal).
RUNS: dict[str, str] = {}


@app.route("/")
def index():
    return render_template("dashboard.html")


def _timestamped_dir(base: Path, url: str) -> Path:
    stamp = _dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    slug = scraper.slugify(url)
    return base / f"{stamp}-{slug}"


@app.post("/api/scrape")
def api_scrape():
    payload = request.get_json(silent=True) or {}
    url = (payload.get("url") or "").strip()
    if not url:
        return jsonify({"error": "Please provide a URL."}), 400
    if not url.startswith(("http://", "https://")):
        url = "https://" + url

    destination = payload.get("destination", "collections")
    if destination == "local":
        local_path = (payload.get("local_path") or "").strip()
        if not local_path:
            return jsonify({"error": "Enter a local folder path."}), 400
        base = Path(local_path).expanduser()
    else:
        base = COLLECTIONS_DIR

    run_dir = _timestamped_dir(base, url)
    try:
        run_dir.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        return jsonify({"error": f"Cannot create folder: {exc}"}), 400

    try:
        summary = scraper.scrape(
            [url],
            output_dir=str(run_dir),
            screenshot=bool(payload.get("screenshot")),
            crawl_depth=int(payload.get("crawl_depth", 0) or 0),
            respect_robots=bool(payload.get("respect_robots")),
            max_pages=int(payload.get("max_pages", 25) or 25),
            full_capture=bool(payload.get("full_capture")),
        )
    except Exception as exc:  # surface browser/setup errors to the UI
        return jsonify({"error": str(exc)}), 500

    report_path = build_report(run_dir, url, summary)

    run_id = uuid.uuid4().hex
    RUNS[run_id] = str(run_dir.resolve())
    summary["run_id"] = run_id
    summary["saved_to"] = str(run_dir.resolve())
    summary["report"] = str(report_path.resolve())
    summary["destination"] = destination
    return jsonify(summary)


def _zip_dir(directory: Path) -> io.BytesIO:
    """Zip a directory recursively (all folders and subfolders) into memory."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for path in directory.rglob("*"):
            if path.is_file():
                zf.write(path, path.relative_to(directory.parent))
    buf.seek(0)
    return buf


@app.get("/api/download")
def api_download():
    """Download a finished run as a ZIP (folders and subfolders included)."""
    run_id = request.args.get("run", "")
    abs_path = RUNS.get(run_id)
    if not abs_path or not Path(abs_path).exists():
        return jsonify({"error": "Unknown or expired run."}), 404
    directory = Path(abs_path)
    return send_file(
        _zip_dir(directory),
        mimetype="application/zip",
        as_attachment=True,
        download_name=f"{directory.name}.zip",
    )


def _truncate(text: str, limit: int = 6000) -> str:
    text = text or ""
    return text if len(text) <= limit else text[:limit] + "\n… (truncated; see data.json)"


def build_report(run_dir: Path, source_url: str, summary: dict) -> Path:
    """Write a standalone report.html into run_dir summarizing each page.

    Uses only relative links, so opening the file from disk works offline.
    """
    esc = html.escape
    cards = []
    for page in summary.get("pages", []):
        page_dir = run_dir / page["dir"]
        data = {}
        data_file = page_dir / "data.json"
        if data_file.exists():
            try:
                data = json.loads(data_file.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                data = {}

        shot = page["dir"] + "/screenshot.png" if (page_dir / "screenshot.png").exists() else None
        # Links to the full-capture artifacts, when present.
        extra = []
        if (page_dir / "page.mhtml").exists():
            extra.append(f'<a href="{esc(page["dir"])}/page.mhtml">MHTML snapshot</a>')
        if (page_dir / "network.har").exists():
            extra.append(f'<a href="{esc(page["dir"])}/network.har">network.har</a>')
        if data.get("assets_count"):
            extra.append(f'<a href="{esc(page["dir"])}/assets/">assets/ ({data["assets_count"]})</a>')
        extra_html = (" · " + " · ".join(extra)) if extra else ""
        links = data.get("links", [])
        links_html = "".join(
            f'<li><a href="{esc(l["url"])}">{esc(l.get("text") or l["url"])}</a></li>'
            for l in links[:300]
        )
        fields = data.get("fields") or {}
        fields_html = "".join(
            f"<tr><td><code>{esc(k)}</code></td><td><pre>{esc(json.dumps(v, ensure_ascii=False, indent=2))}</pre></td></tr>"
            for k, v in fields.items()
        )

        cards.append(f"""
        <section class="card">
          <h2>{esc(data.get("title") or "(untitled)")}</h2>
          <p class="meta"><a href="{esc(page["url"])}">{esc(page["url"])}</a>
             · status {esc(str(data.get("status")))} · {page["links"]} links</p>
          <p class="files">
            <a href="{esc(page["dir"])}/page.html">Rendered HTML</a> ·
            <a href="{esc(page["dir"])}/data.json">data.json</a>
            {f'· <a href="{esc(shot)}">screenshot</a>' if shot else ''}{extra_html}
          </p>
          {f'<a href="{esc(shot)}"><img class="shot" src="{esc(shot)}" alt="screenshot"></a>' if shot else ''}
          {f'<details><summary>Custom fields</summary><table>{fields_html}</table></details>' if fields_html else ''}
          <details><summary>Visible text</summary><pre class="text">{esc(_truncate(data.get("text", "")))}</pre></details>
          <details><summary>Links ({len(links)})</summary><ul class="links">{links_html}</ul></details>
        </section>""")

    generated = _dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    doc = f"""<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Scrape report — {esc(source_url)}</title>
<style>
  body {{ font-family: system-ui, sans-serif; max-width: 900px; margin: 0 auto;
          padding: 24px; background: #0f1221; color: #e7e9f2; }}
  a {{ color: #6c8cff; }} h1 {{ font-size: 22px; }}
  .meta, .files {{ color: #9aa0bd; font-size: 13px; word-break: break-all; }}
  .card {{ background: #181c2f; border: 1px solid #2a3050; border-radius: 12px;
           padding: 18px; margin: 16px 0; }}
  summary {{ cursor: pointer; color: #46d3a3; margin: 8px 0; }}
  pre {{ background: #0c0f1d; padding: 12px; border-radius: 8px; overflow-x: auto;
         white-space: pre-wrap; font-size: 13px; }}
  .text {{ max-height: 360px; overflow-y: auto; }}
  .shot {{ max-width: 100%; border: 1px solid #2a3050; border-radius: 8px; margin: 8px 0; }}
  table {{ width: 100%; border-collapse: collapse; }}
  td {{ border-top: 1px solid #2a3050; padding: 6px; vertical-align: top; }}
  ul.links {{ max-height: 360px; overflow-y: auto; }}
</style></head>
<body>
  <h1>🔎 Scrape report</h1>
  <p class="meta">Source: <a href="{esc(source_url)}">{esc(source_url)}</a><br>
     Generated {generated} · {summary.get("scraped", 0)} page(s) scraped,
     {summary.get("failed", 0)} failed</p>
  {''.join(cards) or '<p>No pages scraped.</p>'}
</body></html>"""
    report = run_dir / "report.html"
    report.write_text(doc, encoding="utf-8")
    return report


def _open_browser():
    webbrowser.open("http://127.0.0.1:5000")


if __name__ == "__main__":
    COLLECTIONS_DIR.mkdir(parents=True, exist_ok=True)
    # Open the dashboard automatically a moment after the server starts.
    threading.Timer(1.0, _open_browser).start()
    app.run(host="127.0.0.1", port=5000, debug=False)
