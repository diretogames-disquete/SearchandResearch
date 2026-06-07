#!/usr/bin/env bash
# Double-click (or run) to launch the scraper dashboard.
# It opens the dashboard in your browser automatically.
set -e
cd "$(dirname "$0")"
python3 app.py
