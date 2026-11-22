[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Agan90/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Agan90/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

# mend

One patch tool for every AI edit format: unified diffs, SEARCH/REPLACE blocks,
V4A patches, and JSON edits — applied to a tree of text files, all or nothing,
to the specification in the kit's `SPEC.md`.

## Run

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

`PATCH` is read from standard input when absent or `-`. See `SPEC.md` for the
exact contract: exit codes, output lines, the three matching tiers, and the
all-or-nothing write rule.

## Files

- `main.ts` — the CLI (Node 22 standard library only).
- `runner.ts` — the kit's trial runner; kept as handed out.
- `LICENSE` — MIT.

## Local check

The kit's practice set (100 checks) scores 1000/1000 with the kit's checker:

```sh
node check.ts <kit>/program/generator/practice.json
```

A strict (tier-0-only) variant of the same code scores 750/1000 on the same
set, which is the house strict-applier baseline this entry has to beat.
