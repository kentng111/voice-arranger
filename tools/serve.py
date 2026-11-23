"""Minimal static server for local development.

    python tools/serve.py [port]

Then open http://localhost:8000 in Chrome or Edge.
(.js is forced to text/javascript because Windows sometimes maps it to text/plain,
which stops the app's modules from loading.)
"""
import functools
import http.server
import mimetypes
import os
import sys

mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("text/javascript", ".mjs")
mimetypes.add_type("text/css", ".css")

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=root)
print(f"Voice Arranger: http://localhost:{port}/  (Ctrl+C to stop)")
http.server.ThreadingHTTPServer(("127.0.0.1", port), handler).serve_forever()
