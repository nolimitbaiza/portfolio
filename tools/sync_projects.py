"""Copy each project's published files into projects/<name>/, laid out at their site addresses.

The projects are listed in projects.json; each project's repository lists its public files in its
publish.json. This replaces projects/<name>/ with exactly those files, so a file the project
stops publishing disappears from the site too, and records the commit it copied in
projects.lock.json. The "Sync projects" workflow runs it every hour and commits what changed,
which redeploys the site.

Usage:
    python tools/sync_projects.py                    fetch every project from GitHub
    python tools/sync_projects.py --local pitwall=../f1_constructor_performance_tracker
                                                     use a local checkout for that project
"""
import argparse
import json
import shutil
import subprocess
import tempfile
from pathlib import Path

import assemble

ROOT = assemble.ROOT
LOCK = ROOT / "projects.lock.json"


def git(*args, cwd=None):
    return subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--local", action="append", default=[], metavar="NAME=PATH",
                        help="use a local checkout instead of GitHub for this project")
    args = parser.parse_args()
    local = dict(item.split("=", 1) for item in args.local)
    lock = json.loads(LOCK.read_text()) if LOCK.exists() else {}

    with tempfile.TemporaryDirectory() as tmp:
        for project in assemble.projects():
            name = project["name"]
            if name in local:
                checkout = Path(local[name]).resolve()
                commit = git("rev-parse", "HEAD", cwd=checkout) + " (local checkout)"
            else:
                checkout = Path(tmp) / name
                url = f"https://github.com/{project['repo']}.git"
                git("clone", "--quiet", "--depth", "1", "--branch", project["ref"], url, str(checkout))
                commit = git("rev-parse", "HEAD", cwd=checkout)
            files = assemble.publish_map(checkout)
            target = ROOT / "projects" / name
            if target.exists():
                shutil.rmtree(target)
            for address, source in files.items():
                out = target / address
                out.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(source, out)
            lock[name] = {"repo": project["repo"], "ref": project["ref"], "commit": commit}
            print(f"{name}: {len(files)} files from {project['repo']} at {commit[:7]}")

    # Fails if two parts now publish the same address, before anything is committed.
    files, _ = assemble.site_files()
    LOCK.write_text(json.dumps(lock, indent=2) + "\n")
    print(f"Site: {len(files)} files in total")


if __name__ == "__main__":
    main()
