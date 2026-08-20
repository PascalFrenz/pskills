# Repository instructions

- Never edit a skill file fetched from another repository.
- Treat every target listed in `skills.config.json` as vendored and read-only. This applies to the target file itself and, for directory targets, every file below that directory.
- Update vendored skills only through `npm run fetch-skills` or by changing their upstream source. Do not patch fetched files locally, including frontmatter-only or compatibility changes.
- Skills not covered by `skills.config.json` are original to this repository and may be edited normally.
