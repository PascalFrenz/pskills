# pskills

A collection of skills that I use on a day-to-day basis, packaged as both a
[GitHub Copilot plugin](https://docs.github.com/en/copilot/concepts/agents/about-plugins)
and an [OpenAI plugin for Codex](https://developers.openai.com/plugins/build/plugins).

Skills under `skills/` come from two places:

- **Original** — written here, edited here, the source of truth. Not listed in
  `skills.config.json`.
- **Vendored** — copied from upstream repositories and never edited in place.
  `skills.config.json` records where each one comes from, and
  `scripts/fetch-skills.mjs` re-fetches them.

| Skill                                                    | Origin                             |
|----------------------------------------------------------|------------------------------------|
| [`iterative-diagram`](skills/iterative-diagram/SKILL.md) | original                           |
| [`edd`](skills/edd/SKILL.md) | original; human-owned tests, agent implementation and review |
| everything else                                          | vendored, see `skills.config.json` |

Adding an original skill is just a new `skills/<name>/SKILL.md`; leave it out of
the config and the fetcher will not touch it. `npm test` fails if a config entry
ever grows to cover an original skill, because a vendored directory target
deletes anything it does not own.

## Installing with GitHub Copilot

```shell
copilot plugin marketplace add PascalFrenz/pskills
copilot plugin install pskills@pascalfrenz
```

Or declaratively, in `~/.copilot/settings.json` (user-level) or
`.github/copilot/settings.json` (repository-level, also used by the Copilot
cloud agent):

```json
{
  "extraKnownMarketplaces": {
    "pascalfrenz": {
      "source": {
        "source": "github",
        "repo": "PascalFrenz/pskills"
      }
    }
  },
  "enabledPlugins": {
    "pskills@pascalfrenz": true
  }
}
```

Update with `copilot plugin update pskills`, remove with
`copilot plugin uninstall pskills`.

> Install via the marketplace, not `copilot plugin install PascalFrenz/pskills`.
> Direct repo, URL, and local-path installs still work but the CLI reports them
> as deprecated: "Only plugin@marketplace installs will be supported in a future
> release."

## Installing with Claude Code

```shell
claude plugin marketplace add PascalFrenz/pskills
claude plugin install pskills@pascalfrenz
```

Update with `claude plugin marketplace update pascalfrenz` followed by
`claude plugin update pskills@pascalfrenz`, remove with
`claude plugin uninstall pskills@pascalfrenz`.

## Installing with Codex

Add this repository as a Codex marketplace, then install `pskills` from it:

```shell
codex plugin marketplace add PascalFrenz/pskills --ref master --sparse .agents/plugins
codex plugin add pskills@pascalfrenz
```

In the Codex app's **Add plugin marketplace** dialog, use:

| Field        | Value                                           |
|--------------|-------------------------------------------------|
| Source       | `https://github.com/PascalFrenz/pskills.git` |
| Git ref      | `master`                                        |
| Sparse paths | `.agents/plugins`                               |

The sparse path selects the Codex marketplace manifest. `plugins/codex` is not
a path in this repository.

### Plugin layout

| File                              | Purpose                                                                                             |
|-----------------------------------|-----------------------------------------------------------------------------------------------------|
| `plugin.json`                     | GitHub Copilot plugin manifest at the repo root; points `skills` at `skills/`                       |
| `.github/plugin/marketplace.json` | GitHub Copilot marketplace `pascalfrenz`, listing this repo (`source: "."`) as the `pskills` plugin |
| `.codex-plugin/plugin.json`       | OpenAI plugin manifest for Codex; reuses the same `skills/` directory                               |
| `.agents/plugins/marketplace.json` | Codex marketplace `pascalfrenz`; installs the plugin from this repository's root                   |
| `.claude-plugin/plugin.json`      | Claude Code plugin manifest; Claude Code discovers skills in `skills/` itself                      |
| `.claude-plugin/marketplace.json` | Claude Code marketplace `pascalfrenz`; lists this repo (`source: "./"`) as the `pskills` plugin, skills auto-discovered from `skills/` |

The repository is both the marketplace and the plugin, so one `marketplace add`
exposes it to each client.

### Releases

Every change goes through a pull request that is squash-merged, and the PR
title must follow [Conventional Commits](https://www.conventionalcommits.org/).
The title decides the release: `feat:` bumps the minor version, `fix:` and
`perf:` the patch, a `!` after the type (`feat!:`) the major, and `chore:`,
`ci:`, `docs:`, `refactor:`, `test:`, `build:`, `style:` and `revert:` release
nothing. Use `fix:` or `feat:` for a skill refresh that users should receive.

- `.github/workflows/version-bump.yml` runs on every PR update and title edit.
  It raises `master`'s version by the title's bump and commits it to the PR
  branch as `chore: set version to X.Y.Z`. Pull before pushing again.
- `.github/workflows/release.yml` runs on every push to `master`. If the
  manifests hold a version with no tag yet, it creates the `vX.Y.Z` tag and a
  GitHub release with generated notes. It changes no files.

`scripts/version.mjs` lists every manifest field that holds the version; do not
edit version numbers by hand. `npm test` fails if a manifest gains a version
field that the list misses, or if the manifests disagree.

If two open PRs get the same version, the one merged second fails the release
workflow because its tag exists. Requiring branches to be up to date before
merging avoids that: updating the branch re-runs the bump against the new
`master`.

## Updating the vendored skills

```bash
npm run fetch-skills             # fetch or update everything
npm run fetch-skills -- --dry-run
npm run fetch-skills -- --filter code-review
```

| Flag                | Effect                                               |
|---------------------|------------------------------------------------------|
| `--config <path>`   | config file, default `skills.config.json`            |
| `--filter <substr>` | only entries whose `sourceUrl` or `targetPath` match |
| `--dry-run`         | resolve and report without writing                   |
| `--verbose`         | also report entries with no changes                  |

Exit code is `1` if any entry failed. No dependencies; needs Node >= 20.

## Config

`skills.config.json` is a JSON array. Each entry has exactly two keys:

```json
[
  {
    "sourceUrl": "https://github.com/mattpocock/skills/tree/main/skills/engineering/code-review",
    "targetPath": "skills/code-review"
  },
  {
    "sourceUrl": "https://github.com/cursor/plugins/blob/main/pstack/skills/principle-prove-it-works/SKILL.md",
    "targetPath": "skills/principle-prove-it-works/SKILL.md"
  }
]
```

**`sourceUrl`**

| Form                                                            | Fetches                    |
|-----------------------------------------------------------------|----------------------------|
| `https://github.com/{owner}/{repo}/tree/{ref}/{path}`           | the directory, recursively |
| `https://github.com/{owner}/{repo}/blob/{ref}/{path}`           | one file                   |
| `https://raw.githubusercontent.com/{owner}/{repo}/{ref}/{path}` | one file                   |
| any other `https://` URL                                        | one file                   |

Directory expansion is GitHub-only. `{ref}` may contain slashes
(`release/1.0`) or be a full commit SHA; the ref is resolved against the remote
rather than guessed from the URL.

**`targetPath`** is relative to the repo root and always uses forward slashes.
The kind is derived from `sourceUrl` alone, never from a trailing slash:

- file source → `targetPath` is the destination file
- directory source → `targetPath` is the destination directory, and each
  upstream file lands at `targetPath/<path relative to the source directory>`

## Rules worth knowing

- **A directory target is owned exclusively by its entry.** Files that vanish
  upstream are deleted locally, so a vendored skill always reflects a single
  upstream commit instead of accumulating orphans that agents would still load.
  Do not hand-edit or add files inside a directory target.
- **Entries are all-or-nothing.** Every file of an entry is downloaded before
  any of them is written, so a network failure cannot leave half a skill updated.
- **Targets may not overlap**, including case-only differences, so a config
  written on Linux cannot collide on Windows.
- **Refs are frozen per run.** Each ref resolves to one commit SHA and every
  download uses it, so an upstream push mid-run cannot mix commits.
- **Review with `git diff`.** There is no lockfile: moving refs like `main` are
  the point, and the checked-in files are the record of what was fetched.

## Authentication

Public repositories need no token. To raise the GitHub API rate limit, set
`PSKILLS_GITHUB_TOKEN` (preferred) or `GITHUB_TOKEN`. `GH_TOKEN` is used only
when `GH_HOST` is unset or `github.com`, so a GitHub Enterprise token does not
leak into github.com requests. Tokens are sent to `api.github.com` only, never
to download hosts. A rejected token falls back to unauthenticated access.

## Licensing

Vendored skills keep their upstream licences. `mattpocock/skills` is MIT.
`cursor/plugins` has no repository-level licence; the pstack plugin ships its
own `pstack/LICENSE`. Check upstream before redistributing.

## Tests

```bash
npm test
```

Covers URL parsing, ref selection, target validation, and overlap detection.
No network access.
