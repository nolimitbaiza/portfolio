# baizakisaev.com

The website of Baizak Isaev: the home page, posts, and two projects, each of which lives in its own repository.

| Address | What | Repository |
| --- | --- | --- |
| [/](https://baizakisaev.com/) | Home page (about me, projects, writing, contact) | this one |
| [/battery-wear-cost](https://baizakisaev.com/battery-wear-cost), [/perfect-hindsight-benchmark](https://baizakisaev.com/perfect-hindsight-benchmark) | Posts | this one |
| [/ai-grid-trader](https://baizakisaev.com/ai-grid-trader), [/ai-grid-trader-case-study](https://baizakisaev.com/ai-grid-trader-case-study) | AI Grid Trader demo and case study | [ai-grid-trader](https://github.com/nolimitbaiza/ai-grid-trader) |
| [/pitwall/](https://baizakisaev.com/pitwall/), [/pitwall-case-study](https://baizakisaev.com/pitwall-case-study) | Pitwall dashboard and case study | [f1_constructor_performance_tracker](https://github.com/nolimitbaiza/f1_constructor_performance_tracker) |

## How the site is put together

- **This repository** holds the home page, the posts, and everything the pages share: styles (`assets/style.css`, `assets/home.css`), scripts (`assets/site.js`, `assets/home.js`), fonts, icons, the photo, the résumé, the offline worker (`sw.js`), the sitemap and the server setup (`Dockerfile`, `Caddyfile`). `OWN` in `tools/assemble.py` lists exactly what it publishes.
- **Each project** lists its public files in a `publish.json` in its own repository. `projects.json` here names the projects; `tools/sync_projects.py` copies each one's files into `projects/<name>/`, laid out at their addresses on the site. Don't edit `projects/` by hand: change the project's repository instead.
- **`tools/assemble.py`** puts the two together. The Dockerfile, the local server and the release-upgrade check all use it, so they publish exactly the same files, and the build stops if two parts ever claim the same address.

## Deployment

The site runs on [Railway](https://railway.com) from this repository: every push to `main` builds the `Dockerfile` (the site is assembled and stamped with a build number, then served by [Caddy](https://caddyserver.com)) and deploys it. Cloudflare sits in front.

The **Sync projects** workflow (`.github/workflows/sync-projects.yml`) checks the projects every hour. When one has changed its published files, for example after Pitwall loads a new race weekend, it builds the production image, runs the smoke test (`tools/smoke_test.sh`) and only then commits the new copy, which redeploys the site. Run it by hand from the Actions tab to publish a project change straight away.

## Run it locally

```bash
python tools/serve.py            # the whole site on http://localhost:8600/
```

To preview a project change before pushing it, point the server at your local checkout of that project:

```bash
python tools/serve.py --project pitwall=../f1_constructor_performance_tracker
python tools/serve.py --project ai-grid-trader=../ai-grid-trader
```

`python tools/sync_projects.py` refreshes `projects/` from GitHub (add `--local NAME=PATH` to copy from a checkout instead), and `python tools/assemble.py list` shows every address and which part publishes it.

## Tests

Every push and pull request runs `.github/workflows/test.yml`:

- **test**: JavaScript and Python syntax, and that the site assembles.
- **browsers**: every page in Firefox, Chromium, WebKit, on an iPad and offline (`tools/browser_check.py`), and the release-upgrade check (`tools/upgrade_check.py`: returning visitors get a new release, not cached files).
- **container**: builds the production image and runs `tools/smoke_test.sh` against it.

## Adding a project

1. In the project's repository, add a `publish.json` listing its public files and their addresses (see the two existing projects).
2. Add the project to `projects.json` here, run `python tools/sync_projects.py`, and link it from the home page and `sitemap.xml`.
3. If its address is a folder (like `/pitwall/`), add a redirect for the address without the slash to the `Caddyfile`, and a check to `tools/smoke_test.sh`.

## License

[PolyForm Noncommercial 1.0.0](LICENSE.md). The projects keep their own licences.
