# HubSpot partner program migration

Moves a HubSpot partner program into the AnyDB partner model (Partner, Partner Info, Company, Contact, Deal, Deal Registration).

## Pieces

| File | Role |
|---|---|
| `prepare.mjs` | Reads the four raw HubSpot CRM exports by **header name**, follows the *Associated ... IDs* columns on the partner export, chooses each deal's customer company, derives statuses, and writes clean CSVs plus `prepare-report.txt`. |
| `plan.yaml` | The anydb-migrate plan: five steps that map those CSVs onto AnyDB, with strict stage and pipeline maps. |
| `scripts/backfill-registration-deal.js` | One server-side script for the one thing the API cannot write: the registration's locked **Deal** field. |

## Exports needed (CRM > Export > all records, XLSX)

The partner custom object (its file name must contain `records`), plus companies, contacts and deals. Put them in one folder.

## Runbook

```bash
# 1. clean data (customer data goes in the git-ignored data/ folder)
node examples/hubspot-partners/prepare.mjs <exports-dir> examples/hubspot-partners/data
#    read data/prepare-report.txt: companies it will create, contacts or deals linked to several partners, deals left out

# 2. check the plan against the live workspace
anydb-migrate validate examples/hubspot-partners/plan.yaml

# 3. try a few partners first
anydb-migrate run examples/hubspot-partners/plan.yaml --dry-run --where partner_hs=ID1,ID2,ID3
anydb-migrate run examples/hubspot-partners/plan.yaml --where partner_hs=ID1,ID2,ID3 --failures examples/hubspot-partners/data/failures.csv

# 4. prove it: this must report everything Unchanged
anydb-migrate run examples/hubspot-partners/plan.yaml --dry-run --where partner_hs=ID1,ID2,ID3

# 5. everything (re-run if anything failed; finished rows are skipped)
anydb-migrate run examples/hubspot-partners/plan.yaml --failures examples/hubspot-partners/data/failures.csv

# 6. leftovers from failed creates (read-only), then the locked-field backfill
anydb-migrate orphans examples/hubspot-partners/plan.yaml
#    run scripts/backfill-registration-deal.js inside AnyDB (simulate first)
```

Pick the trial partners to be awkward on purpose: one with no company in HubSpot, one with many contacts and several pipelines, one churned, one prospect with no deals, one whose customer company is not in the companies export.

## Decisions baked into `prepare.mjs` (change them here)

- A partner's **own company** is the one in *Partner's Company Record IDs*; failing that, the associated company whose domain matches a contact's email, then one with the same name. If none exists, a company is created from the partner name.
- A deal's **customer company** is its *Customer company name (Submitted by Partner)*, else *Company name*, matched to the partner's other companies and then to all companies; if unknown a company is created. Deals with neither use the partner's single other company, else its own.
- **Partner status** comes from *Active Status*; when blank it is derived from the pipeline stage (Signed/Enablement/Ongoing = Active, Offboarded = Churned, otherwise Prospect).
- **Level** comes from *Partner tier* and is left blank when HubSpot has none.
- A contact or deal linked to several partners is kept with the first partner and noted in the report. Contacts without a usable email are skipped (and noted).
- A **Deal Registration** is created for every deal in the Partners pipeline, with its status derived from the stage. Contacts are imported with Portal Access off.
- Deals in the export that no partner links to are left out (reported).

## Adapting it

The mapping lives in `plan.yaml`; the HubSpot-specific reading lives in `prepare.mjs`. For another customer or CRM, replace `prepare.mjs` with something that emits clean per-entity CSVs and edit the field names and maps in the plan.
