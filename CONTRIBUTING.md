# Contributing

Issues and pull requests are welcome. For a change larger than a small bug fix,
open an issue first so the intended behavior and interface can be discussed.

## Development

Use the Bun version in `.bun-version`, then install the locked dependencies and
run the full local quality gate:

```sh
bun install --frozen-lockfile
bun run lint
bun run typecheck
bun test
```

Please keep pull requests focused, add or update tests for behavior changes, and
update the relevant README or configuration documentation when the user-facing
interface changes.

## Reporting security issues

Do not open a public issue for a suspected vulnerability. Follow the process in
[`SECURITY.md`](SECURITY.md).
