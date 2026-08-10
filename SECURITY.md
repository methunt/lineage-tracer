# Security

Read this before pointing the tool at anything sensitive.

## How it handles your files

The app is a static page. Your dbt manifest, catalog, mapping workbook and PBIP
folder are read **inside your browser** and never sent anywhere — there is no
server, no API, no upload path, no telemetry and no account. Nothing persists
after you close the tab unless you explicitly export a file to disk.

A page-level Content-Security-Policy backs that up rather than just claiming it:
the hosted app declares `default-src 'none'` with a single allowed connection
target, and an exported viewer declares `connect-src 'none'`, so an export you
mail to somebody cannot phone home.

## What it does not protect against

| | Limit | What it means for you |
|---|---|---|
| 🌐 | **A third-party runtime is fetched at load** | The Python/WebAssembly runtime comes from the jsDelivr CDN at an exact pinned version. It runs in the page's own origin, and there is no integrity hash available for it. Using the tool means trusting that CDN. |
| 📗 | **`.xlsx` parsing uses a library with open advisories** | A crafted workbook can hang the tab. Inputs over 16 MB are refused up front to bound it. **Only open mapping workbooks you trust** — or use the `.csv` path, which is read by a small parser in this repository and never touches that library. |
| 🧪 | **The parsers have not been fuzzed** | Malformed dbt, PBIP, M, DAX or TMDL input can produce a parser error or incorrect lineage rather than a clean refusal. |
| 🖼️ | **The page can be framed by any origin** | Static hosting cannot set response headers, so there is no `X-Frame-Options` and no `frame-ancestors`. There is also no HSTS, `X-Content-Type-Options` or `Referrer-Policy`. |
| ⚙️ | **The background worker sits outside the page policy** | A worker loaded from a network URL does not inherit the document's CSP, so the policy's guarantee is about the *document*. |
| 🔓 | **No authentication** | Anyone with the URL can use it. There is nothing to log in to and nothing to protect, because there is no stored data. |

## Using it safely

- Prefer `.csv` for the mapping workbook if it came from somewhere you do not control.
- Treat an exported `.html` file like the schema it contains — it carries your
  table, column and measure names, so share it the way you would share those.
- If your warehouse schemas are highly sensitive, weigh your own browser
  extensions and network trust before use, the same as any other browser tool.

## Reporting a problem

Found something? Open an issue with enough detail to reproduce it. Please do not
include real schema names or customer data in the report.
