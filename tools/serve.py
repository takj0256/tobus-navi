#!/usr/bin/env python3
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
import os

ROOT = Path(__file__).resolve().parent.parent
os.chdir(ROOT)
print("都バスナビを起動しました: http://127.0.0.1:8000")
print("終了: Ctrl+C")
ThreadingHTTPServer(("127.0.0.1", 8000), SimpleHTTPRequestHandler).serve_forever()
