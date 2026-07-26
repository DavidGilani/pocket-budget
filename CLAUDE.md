# Pocket Ledger — project notes for Claude

## Git / push policy
- Always push directly to `main`. Never push to a feature branch unless the user explicitly requests it.
- Bump the SW cache version (`sw.js` — `pocket-ledger-vN`) on **every** push without exception.

## Security
- NEVER push `finance/migrate/migration-data.json` or `finance/migrate/extra-income-patch.json` — these contain personal financial data.
