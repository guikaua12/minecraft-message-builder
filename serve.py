"""Tiny static file server for the Message Builder, with caching disabled.

Python's stock http.server sends no Cache-Control header, so browsers apply
heuristic caching and may serve a stale app.js after edits. This subclass forces
no-store on every response so a reload always fetches the latest files.
"""
import http.server

PORT = 5050


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()


if __name__ == "__main__":
    # ThreadingHTTPServer so the live-preview tab and a real browser can both connect
    # concurrently without blocking each other (the stock single-threaded server hangs).
    http.server.ThreadingHTTPServer.allow_reuse_address = True
    httpd = http.server.ThreadingHTTPServer(("", PORT), NoCacheHandler)
    print(f"Serving Message Builder on http://localhost:{PORT} (no-cache, threaded)")
    httpd.serve_forever()
