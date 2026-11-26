"""Local web server that behaves like the live site (see Caddyfile and tools/assemble.py): the
whole site, put together from this repository and the projects, with clean URLs (so / is the home
page and /ai-grid-trader serves ai-grid-trader.html), /pitwall redirected to /pitwall/, and
unknown addresses answered with 404.html. Files are looked up on every request, so edits show
up on reload.

Usage: python tools/serve.py [port] [--project NAME=PATH ...]     (default port 8600)
    --project previews a local checkout of a project instead of its copy in projects/, e.g.
    python tools/serve.py --project pitwall=../f1_constructor_performance_tracker
"""
import argparse
import http.server
import sys
import urllib.parse
from functools import partial
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import assemble  # noqa: E402

ROOT = assemble.ROOT
MISSING = str(ROOT / "__missing__")


class Handler(http.server.SimpleHTTPRequestHandler):
    local = {}

    def files(self):
        return assemble.site_files(local=self.local)[0]

    def address(self):
        return urllib.parse.unquote(urllib.parse.urlsplit(self.path).path).lstrip("/")

    def send_head(self):
        # Like Caddy: a folder address without its trailing slash is redirected to it.
        address, query = self.address(), urllib.parse.urlsplit(self.path).query
        if address and not address.endswith("/") and f"{address}/index.html" in self.files():
            self.send_response(301)
            self.send_header("Location", f"/{address}/" + (f"?{query}" if query else ""))
            self.end_headers()
            return None
        return super().send_head()

    def translate_path(self, path):
        address = urllib.parse.unquote(urllib.parse.urlsplit(path).path).lstrip("/")
        if address == "" or address.endswith("/"):
            address += "index.html"
        files = self.files()
        for candidate in (address, address + ".html"):  # clean URLs
            if candidate in files:
                return str(files[candidate])
        return MISSING

    def send_error(self, code, message=None, explain=None):
        page = self.files().get("404.html")
        if code != 404 or page is None:
            return super().send_error(code, message, explain)
        body = page.read_bytes()
        self.send_response(404)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("port", nargs="?", type=int, default=8600)
    parser.add_argument("--project", action="append", default=[], metavar="NAME=PATH")
    args = parser.parse_args()
    Handler.local = {name: Path(path).resolve() for name, path in (p.split("=", 1) for p in args.project)}
    assemble.site_files(local=Handler.local)  # fail now, not on the first request, if parts clash
    server = http.server.ThreadingHTTPServer(("", args.port), partial(Handler, directory=str(ROOT)))
    print(f"Serving baizakisaev.com from {ROOT} on http://localhost:{args.port}/", flush=True)
    server.serve_forever()
