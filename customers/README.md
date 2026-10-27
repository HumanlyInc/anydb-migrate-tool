# customers/

Local workspace for customer engagements. Everything in here is git-ignored except this file, so raw exports,
prepared data, plans and one-off scripts never reach the repo.

One folder per customer, laid out like an example so relative imports keep working:

    customers/<customer>/
      rawdata/        exports exactly as received
      data/           files prepared for import
      prepare.mjs     source -> flat CSVs
      plan*.yaml      migration plans
      scratch/        throw-away scripts, test plans, notes

Scripts here sit two levels below the repo root, same as `examples/<name>/`, so `../../src/...` imports and
`npx tsx src/cli.ts run customers/<customer>/plan.yaml` work unchanged.

Anything worth keeping as a reusable pattern should be cleaned of customer data and moved to `examples/`.
