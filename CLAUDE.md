# CLAUDE.md

Static Formula 1 side projects served as one Cloudflare Worker (static assets only, no build step). The repo root is the site root. See `README.md` for the layout and data pipelines. Each walkthrough lives in `walkthroughs/<city>/`, with build scripts in `tools/<city>/`.

## Deploys

Cloudflare Workers Builds (the Cloudflare GitHub app) does all deploys. There is no GitHub Actions workflow. Don't add one: it would deploy every merge twice.
- **Production:** every push to `main` deploys to https://f1.artgillespie.workers.dev. To confirm a production deploy, look for the `Workers Builds: f1` check on the merge commit. Then compare files on the live site with the merge commit (`curl` the file and `sha1sum` it against the repo copy). Fetch pages by their directory URL (`/walkthroughs/austin/`): `/…/index.html` redirects there with an empty body.
- **Previews:** every pushed branch that has a PR gets a build, and the preview URL is posted on the PR.
  - Preview builds need `"previews": {}` in `wrangler.jsonc`. Without it the build fails within a second (check run conclusion `failure`, started and completed at the same timestamp). Keep the block, and add it to any branch cut from a `main` that lacks it.
  - Nothing to install or run locally: push the branch, open the PR, and Cloudflare does the rest.

## Working with a preview deployment

1. **Push, then open the PR.** A build starts on each push to a branch with an open PR.
2. **Wait for the build. Don't guess.** Two signals, both through the GitHub MCP tools (`mcp__github__pull_request_read`):
   - `get_check_runs`: the check run is named **`Workers Builds: f1`**. It is `in_progress` while building, then `completed` with `success` or `failure`.
   - `get_comments`: the bot `cloudflare-workers-and-pages[bot]` posts one comment and edits it for every commit. When it's ready, it holds a "Preview URL" line and a table row per commit with Build/Deployment status, a per-commit deployment URL, and a "View logs" link to the Cloudflare dashboard. The dashboard needs a login we don't have, so read build failures from the check run and the comment.
   - Typical build-to-live time is under a minute. To wait, use `Monitor` with a bounded loop that exits on the first `200` from the preview URL (see below), rather than repeated manual checks.
3. **Preview URLs** (account subdomain `artgillespie`, worker `f1`):
   - Branch alias (stable across commits): `https://<branch>-f1.artgillespie.workers.dev`. The branch name is lower-cased and every `/` becomes `-`. For example, `claude/cota-austin-2026-page-fcslc0` becomes `https://claude-cota-austin-2026-page-fcslc0-f1.artgillespie.workers.dev`.
   - Per-commit: `https://<8-hex deployment id>-f1.artgillespie.workers.dev`, from the bot's table. Use it to check a specific commit.
   - Pages live under the same paths as production, e.g. `/walkthroughs/austin/`.
4. **Check that the deploy is the one you think it is.** `curl` the page and its data files, and look for 200s and the right sizes. Confirm that `tools/` and `*.md` return 404: `.assetsignore` keeps them out of the published assets.
5. **Verify in a real browser.** Static checks can't tell you whether a WebGL page renders.
   - **Cloud sessions:** use the pre-installed Playwright Chromium (`require('playwright')`; don't install another). Launch with `--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader --ignore-gpu-blocklist` so WebGL works without a GPU. SwiftShader renders the 3D pages at about 1 fps:
     - Wait 15–25 s after `load`.
     - Pass `timeout: 180000` to `page.screenshot`.
     - Element screenshots hang while the canvas animates ("waiting for element to be stable"). For the sections below the map, hide `#stage` (`display: none`) and take a `fullPage` screenshot.
     - Log `pageerror` and console errors. The only expected 404 is an optional data file that doesn't exist yet.
   - **Desktop app:** use the built-in browser pane, and read its skill (`anthropic-skills:built-in-browser`) first.
   - Check the 3D overview, a corner focus, lap playback in each camera mode, the sections below the map, and a phone-width viewport (390×844).
   - Walkthrough pages accept a `#debug` hash that exposes `window.__scene`. It provides `seek(t)`, `setRate(0)` and `snap()` (snap the follow camera instead of easing), plus `setTimeOfDay(h)` on Austin. Use these to screenshot playback at exact moments despite the low frame rate.
6. **Fix, push and re-check the same alias URL.** The bot updates its comment with a new row per commit.

## Network access in cloud sessions

The environment's allowed domains must include `*.workers.dev`, or previews can't be fetched. Data pipelines also need:
- `api.openf1.org`
- `api.multiviewer.app`
- `api.openstreetmap.org`
- `*.wikimedia.org`, `*.wikipedia.org`
- `s3.amazonaws.com` (terrain tiles)
- `fonts.googleapis.com`, `fonts.gstatic.com`, so screenshots use the real fonts

If a host is denied, report it; don't work around it.

## Local preview

`python3 -m http.server 8787` from the repo root, or `npm run dev` (Wrangler). Pages use import maps pointing at the vendored three.js in `/lib/three-0.170.0/`, so they must be served from the root, not opened as files.
