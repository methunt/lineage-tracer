# Support

Bugs, questions and feature requests all go in
**[GitHub Issues](../../issues)**. That is the only channel.

Two checks first: [search the existing issues](../../issues?q=is%3Aissue), and
read [the Gotchas](README.md#-gotchas) — a parse-only manifest, an empty mapping
slot, or a browser without WebAssembly explain most "it produced nothing"
reports.

## Do not attach your project files

Lineage Tracer uploads nothing. Attaching a manifest or a PBIP folder to a public
issue undoes that — they carry your warehouse, schemas and column names.

Describe the shape instead, with invented names:

> A calculated table whose partition is declared `partition X = calculated`
> shows no upstream.

If you need a file to reproduce it, build a small synthetic one.
[`samples/`](samples/) is a working example to copy.

## What to include

- What you expected, and what you got
- Which part: a slot, the canvas, a panel, Diagnostics, the export
- Browser and version
- A screenshot with names blurred, and anything the console printed

If the tool gave a **wrong answer** rather than an error, say so — a missing link
and a bad count are found in different places.

## Security

Not in a public issue. [SECURITY.md](SECURITY.md) says where to send it.

## Pull requests

See [Contributing](README.md#-contributing). No real project, table, field or
report names anywhere in the repo, tests included — use invented ones.
