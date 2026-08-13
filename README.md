# AnyDB Migrate

[AnyDB](https://www.anydb.com/) is an object-based platform for organizing business data and operations. It models real-world things—such as items, locations, vendors, and shipments so they are structured records that can be connected to one another.

AnyDB Migrate is a small local CLI for moving spreadsheet data into that connected model. Rather than importing every source row as one flat record, it can map a row into multiple AnyDB objects, look up or update existing records, create missing records, and link the results together. Objects are processed in YAML order, so each object can reference records resolved earlier for the same row.

## Supported formats

- **CSV (`.csv`)** as a source, with the first row used as column headers.
- **Excel (`.xlsx`)** as a source, with optional worksheet selection.
- **YAML (`.yaml` or `.yml`)** for describing how source columns map to AnyDB objects, fields, matches, and references.

## One record, multiple objects

For example, this spreadsheet row:

```text
SKU  | Name          | Location | Quantity
A100 | Safety Gloves | Austin   | 24
```

can become three connected AnyDB objects:

```text
Item
  SKU: A100
  Item Name: Safety Gloves

Location
  Location Name: Austin

Inventory Item
  Quantity On Hand: 24
  Item Ref: -> Item (A100)
  Location Ref: -> Location (Austin)
```

The `Item` can be created or updated, the `Location` can be looked up, and the `Inventory Item` can then reference both. The mapping and behavior for each object are declared in the migration's YAML configuration.

## Setup

Requires Node.js 20 or newer. From this directory:

```bash
npm install
npm run build
```

During development, run the TypeScript entry point directly:

```bash
npm run dev -- validate migration.yaml
npm run dev -- run migration.yaml --dry-run
```

After building:

```bash
node dist/cli.js validate migration.yaml
node dist/cli.js run migration.yaml
```

The CLI uses the SDK in the parent repository for now. The `file:..` package dependency can be changed to a published SDK version when this folder moves to its own repository.

## Credentials

Set these environment variables:

```text
ANYDB_API_KEY
ANYDB_USER_EMAIL
ANYDB_TEAM_ID
ANYDB_ADB_ID
ANYDB_BASE_URL        # optional; defaults to the SDK default
ANYDB_REQUESTS_PER_MINUTE  # optional; defaults to 100
```

For example, in PowerShell:

```powershell
$env:ANYDB_API_KEY="your-api-key"
$env:ANYDB_USER_EMAIL="you@example.com"
$env:ANYDB_TEAM_ID="your-team-id"
$env:ANYDB_ADB_ID="your-database-id"

# Optional when using a non-default AnyDB server:
$env:ANYDB_BASE_URL="https://your-anydb-server/api"
```

These values last for the current PowerShell session. After setting them, you can run:

```powershell
npm run dev -- validate migration.yaml
npm run dev -- run migration.yaml --dry-run
```

`teamId`, `databaseId`, and `baseUrl` may instead be placed under `anydb` in YAML. Keep the API key and user email in environment variables so secrets are not accidentally committed to Git.

## Configuration

See [`example.inventory.yaml`](./example.inventory.yaml) for a complete inventory migration. The source path is relative to the YAML file. XLSX sources may select a worksheet with `source.sheet`; CSV sources must omit it.

### Example configuration

Suppose the `Inventory` worksheet starts with these column headers:

```text
SKU | Name | Location | Quantity
```

A migration configuration could look like this:

```yaml
name: inventory-import

source:
  file: ./inventory.xlsx
  sheet: Inventory

objects:
  - name: item
    type: Item
    mode: upsert
    match:
      field: SKU
      column: SKU
    fields:
      SKU: SKU
      Item Name: Name

  - name: location
    type: Location
    mode: lookup
    match:
      field: Location Name
      column: Location

  - name: inventoryItem
    type: Inventory Item
    mode: upsert
    match:
      fields:
        Item Ref:
          object: item
        Location Ref:
          object: location
    fields:
      Quantity On Hand: Quantity
      Status:
        value: Active
    references:
      Item Ref:
        object: item
      Location Ref:
        object: location
```

The important parts are:

- `name` at the top names the migration for output and reporting.
- `source.file` is resolved relative to the YAML file. `source.sheet` selects an XLSX worksheet.
- Each entry under `objects` runs in the order shown.
- An object's local `name`, such as `item`, identifies its result so later objects can reference it.
- `type` is the exact AnyDB type name, such as `Item` or `Inventory Item`.
- `mode` controls behavior: `lookup` only finds, `upsert` finds then updates or creates, and `create` always creates.
- In a single-field `match`, `field` is the AnyDB field and `column` is the spreadsheet header. Therefore, `field: SKU` and `column: SKU` compare the AnyDB `SKU` field with the current row's `SKU` cell.
- Under `fields`, the left side is the AnyDB field and the right side is the spreadsheet header. For example, `Item Name: Name` copies the spreadsheet's `Name` value into AnyDB's `Item Name` field.
- `{ value: Active }` supplies a fixed literal instead of reading a spreadsheet column.
- `{ object: item }` uses the AnyDB record ID resolved for the earlier local object named `item` in the same source row.
- `references` writes those earlier record IDs into AnyDB reference fields. References must point to objects listed earlier in the YAML.

For each spreadsheet row, this example finds or writes an `Item`, looks up its `Location`, and then finds or writes the `Inventory Item` linking those two records.

Each object has a local `name`, an AnyDB template name in `type`, and one of three modes:

- `lookup`: find a record or fail the row; never writes.
- `upsert`: update a match or create a missing record.
- `create`: always create; no match is needed.

Fields map as `AnyDB field: Source column`. A `{ value: ... }` mapping supplies a literal. Matches can use one source column or a `fields` map. `{ object: item }` and `references` use the record ID resolved by an earlier object in the same row.

Before a run, the CLI uses the SDK's type APIs to confirm that every configured type and field exists. It also verifies that fields under `references` are AnyDB reference fields. The fetched type definition supplies real cell positions for writes, so validation and creation no longer depend on an existing record of that type. The optional `template` setting remains available as an explicit template ADOID override; otherwise creation uses the configured type name.

## Commands

Validate YAML, source existence, worksheet selection, modes, matches, unique names, reference order, source columns, and live AnyDB type definitions:

```bash
anydb-migrate validate migration.yaml
```

`validate` is authenticated and read-only, so the AnyDB credentials above must be available.

Run the import:

```bash
anydb-migrate run migration.yaml
anydb-migrate run migration.yaml --dry-run
anydb-migrate run migration.yaml --limit 10 --fail-fast --verbose
anydb-migrate run migration.yaml --requests-per-minute 100
```

Dry runs read the source and perform AnyDB lookups but never call create or update. Row failures are reported and processing continues unless `--fail-fast` is used.

All API calls share a rate limiter that defaults to 100 requests per minute, leaving headroom below AnyDB's typical 120-request limit. Override it with `--requests-per-minute` or `ANYDB_REQUESTS_PER_MINUTE`. If AnyDB still returns HTTP 429, the CLI honors `Retry-After` when available, waits, and retries up to five times. The wait is displayed in the console.

During `run` and `--dry-run`, the CLI prints progress after every 10 completed source rows and once more at completion, for example:

```text
Starting migration: 100 rows
Progress: 10/100 rows (10%)
Progress: 20/100 rows (20%)
...
Progress: 100/100 rows (100%)
```

The initial AnyDB cache load also reports record discovery and hydration progress for each configured type:

```text
Loading Item cache: discovering records...
Loading Item cache: discovered 655 records
Loading Item cache: 10/655 records (2%)
...
Loading Item cache: ready (655 records)
```
