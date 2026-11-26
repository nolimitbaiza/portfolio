"""What baizakisaev.com publishes, defined in one place.

The site is put together from two kinds of parts:
  - this repository: the home page, the posts and everything the pages share (styles, scripts,
    fonts, icons, the photo and the résumé), listed in OWN below;
  - the projects in projects.json, which publish their own pages from their own repositories.
    tools/sync_projects.py copies each one's files into projects/<name>/, laid out at their
    addresses on the site.

The Dockerfile (the live site), tools/serve.py (local preview) and tools/upgrade_check.py all
build the site with this module, so they always publish exactly the same files. Two parts may
never publish the same address: that stops the build.

Usage:
    python tools/assemble.py build <dir> [--stamp BUILD]   write the whole site into <dir>
    python tools/assemble.py list                          every address and which part publishes it
"""
import argparse
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# This repository's own published files; a folder ends in "/" and publishes everything in it.
OWN = [
    "index.html", "about.html", "404.html",
    "battery-wear-cost.html", "perfect-hindsight-benchmark.html",
    "robots.txt", "sitemap.xml", "manifest.webmanifest", "sw.js",
    "assets/style.css", "assets/home.css", "assets/home.js", "assets/site.js",
    "assets/fonts/", "assets/icons/",
    "assets/img/profile.jpg", "assets/img/profile-64.jpg",
    "assets/img/qr-linkedin.svg", "assets/img/qr-case-study.svg",
    "assets/Baizak-Isaev-Resume.pdf", "assets/og-card.png",
]

# Pages and scripts carry this placeholder; a deploy replaces it with the build number, so every
# release asks for new file addresses (style.css?v=…) and nothing old is served from a cache.
PLACEHOLDER = b"__BUILD__"


def projects(root=ROOT):
    return json.loads((root / "projects.json").read_text(encoding="utf-8"))["projects"]


def expand(base, entries):
    """{site address: file} for (from, to) pairs. A folder ("" or ending in /) takes all its files."""
    files = {}
    for source, target in entries:
        path = base / source
        if source == "" or source.endswith("/"):
            if not path.is_dir():
                raise SystemExit(f"Missing folder: {path}")
            for file in sorted(p for p in path.rglob("*") if p.is_file()):
                files[target + file.relative_to(path).as_posix()] = file
        else:
            if not path.is_file():
                raise SystemExit(f"Missing file: {path}")
            files[target] = path
    return files


def publish_map(checkout):
    """The files a project checkout publishes, read from its publish.json."""
    spec = json.loads((Path(checkout) / "publish.json").read_text(encoding="utf-8"))["publish"]
    return expand(Path(checkout), [(entry["from"], entry["to"]) for entry in spec])


def site_files(root=ROOT, local=None):
    """({address: file}, {address: owner}) for the whole site.

    Projects come from their synced copies in projects/<name>/, or from a local checkout of the
    project when `local` maps its name to a folder (to preview changes before they are pushed).
    """
    local = local or {}
    files, owners = {}, {}

    def add(owner, mapping):
        for address, path in mapping.items():
            if address in files:
                raise SystemExit(f"{address} is published by both {owners[address]} and {owner}")
            files[address], owners[address] = path, owner

    add("portfolio", expand(root, [(path, path) for path in OWN]))
    for project in projects(root):
        name = project["name"]
        if name in local:
            add(name, publish_map(local[name]))
        else:
            add(name, expand(root / "projects" / name, [("", "")]))
    return files, owners


def build(dest, stamp=None, root=ROOT, local=None):
    """Write the whole site into `dest`, replacing the build placeholder with `stamp` if given."""
    files, _ = site_files(root, local)
    dest = Path(dest)
    for address, path in files.items():
        data = path.read_bytes()
        if stamp and PLACEHOLDER in data:
            data = data.replace(PLACEHOLDER, stamp.encode())
        out = dest / address
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(data)
    return files


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)
    build_cmd = sub.add_parser("build", help="write the whole site into a folder")
    build_cmd.add_argument("dest", type=Path)
    build_cmd.add_argument("--stamp", help="build number to put in place of __BUILD__")
    sub.add_parser("list", help="every address and which part publishes it")
    args = parser.parse_args()
    if args.command == "build":
        files = build(args.dest, args.stamp)
        print(f"Wrote {len(files)} files to {args.dest}")
    else:
        files, owners = site_files()
        for address in sorted(files):
            print(f"{owners[address]:16} {address}")


if __name__ == "__main__":
    main()
