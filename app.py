#!/usr/bin/env python3
"""Web dashboard for the scraper.

Run it:
  pip install -r requirements.txt
  playwright install chromium
  python app.py
  # then open http://127.0.0.1:5000

The dashboard lets you:
  * paste a URL and scrape it (with optional screenshot, crawl depth, robots.txt)
  * read clickable, collapsible instructions on how to set it up and use it
  * download the scraped results as a ZIP, preserving folders and subfolders
"""

from __future__ import annotations

import io
import zipfile
from pathlib import Path

from flask import (
    Flask,
    jsonify,
    render_template,
    request,
    send_file,
)

import scraper

OUTPUT_DIR = Path("output")

app = Flask(__name__)


@app.route("/")
def index():
    return render_template("dashboard.html")


@app.post("/api/scrape")
def api_scrape():
    payload = request.get_json(silent=True) or {}
    url = (payload.get("url") or "").strip()
    if not url:
        return jsonify({"error": "Please provide a URL."}), 400
    if not url.startswith(("http://", "https://")):
        url = "https://" + url

    try:
        summary = scraper.scrape(
            [url],
            output_dir=str(OUTPUT_DIR),
            screenshot=bool(payload.get("screenshot")),
            crawl_depth=int(payload.get("crawl_depth", 0) or 0),
            respect_robots=bool(payload.get("respect_robots")),
            max_pages=int(payload.get("max_pages", 25) or 25),
        )
    except Exception as exc:  # surface browser/setup errors to the UI
        return jsonify({"error": str(exc)}), 500

    return jsonify(summary)


def _safe_subdir(name: str) -> Path:
    """Resolve a requested subfolder, refusing any path-traversal attempts."""
    target = (OUTPUT_DIR / name).resolve()
    root = OUTPUT_DIR.resolve()
    if root not in target.parents and target != root:
        raise ValueError("Invalid path")
    return target


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
    """Download everything (or one result folder) as a ZIP, subfolders included."""
    subdir = request.args.get("dir")
    if subdir:
        try:
            directory = _safe_subdir(subdir)
        except ValueError:
            return jsonify({"error": "Invalid path"}), 400
        download_name = f"{subdir}.zip"
    else:
        directory = OUTPUT_DIR
        download_name = "scrape-results.zip"

    if not directory.exists():
        return jsonify({"error": "Nothing scraped yet."}), 404

    buf = _zip_dir(directory)
    return send_file(
        buf,
        mimetype="application/zip",
        as_attachment=True,
        download_name=download_name,
    )


if __name__ == "__main__":
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    app.run(host="127.0.0.1", port=5000, debug=True)
