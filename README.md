# SeqMig

Snapshot-based auto-migration CLI for Sequelize / sequelize-typescript.

SeqMig introspects your models, diffs them against a local schema snapshot, and generates transactional Sequelize migrations.

## Installation

```bash
npm install seqmig
```

## Quick Start

```bash
seqmig init
seqmig rebuild
seqmig preview
seqmig generate -n add-users
seqmig run
```

## Commands

- `seqmig init` - Create default `.sequelizerc`.
- `seqmig preview` - Show diff actions (`snapshot -> models`) as JSON.
- `seqmig generate [-n, --name <slug>]` - Generate migration + update snapshot.
- `seqmig scaffold [-n, --name <slug>]` - Create blank migration (snapshot unchanged).
- `seqmig run` - Run pending migrations.
- `seqmig rollback` - Undo last migration.
- `seqmig rebuild` - Rebuild snapshot from current models.
- `seqmig validate` - Compare snapshot vs models and print drift summary.
- `seqmig debug` / `seqmig summary` - High-signal debug summary for snapshot vs models.
- `seqmig introspect` - Print model-introspected schema JSON.
- `seqmig backups` - List snapshot backups.
- `seqmig restore <backup>` - Restore a snapshot backup.
- `seqmig --help` / `seqmig -h` / `seqmig help [command]` - Show CLI help.

## Configuration

SeqMig reads paths from `.sequelizerc`:

```javascript
const path = require("path");

module.exports = {
  config: path.resolve("config/config.js"),
  "models-path": path.resolve("models"),
  "migrations-path": path.resolve("migrations"),
  "seeders-path": path.resolve("seeders"),
};
```

## Core Behavior

### Snapshot Workflow

1. Introspect models.
2. Compare against `schema-snapshot.json`.
3. Generate actions.
4. Write migration and update snapshot.

### Nullability Rules

SeqMig now uses strict nullability defaults for model introspection:

- If `allowNull` is explicitly set on `@Column`, that value is used.
- If `allowNull` is not set, SeqMig treats the column as `allowNull: false`.
- Generated migration columns always include explicit `allowNull: true|false`.

### Foreign Key Defaults

For generated FK constraints:

- If `onDelete` / `onUpdate` are explicitly set, those are used.
- If omitted, both default to `"CASCADE"`.

### Index Behavior

- FK indexes are auto-generated when a covering index/unique/PK does not already exist.
- Explicit indexes from model metadata are preserved.

### Type and Column Handling

- `DataType.DATEONLY` maps to `Sequelize.DATEONLY`.
- `DataType.VIRTUAL` fields are excluded from migrations.
- `DataType.STRING` emits `Sequelize.STRING` (no forced `(255)`).
- `DataType.STRING(n)` keeps explicit length.
- UUID default tokens emit as `Sequelize.UUIDV4`.

### ENUM Handling

- ENUM columns are generated with `Sequelize.ENUM(...)`.
- `down` cleanup drops generated enum types with `DROP TYPE IF EXISTS ...`.

## Guidelines for Predictable Migrations

Use these model-authoring rules if you want generated migrations to match your intent exactly:

- Always set `allowNull` explicitly on every `@Column` (`true` or `false`).
- Use explicit FK actions when needed:
  - `onDelete` / `onUpdate` on associations or references.
  - If omitted, SeqMig defaults both to `CASCADE`.
- Keep non-persistent fields as `DataType.VIRTUAL`; they are intentionally excluded from migrations.
- Use `DataType.DATEONLY` when you need date-only semantics; do not model it as `DATE`.
- For strings, use:
  - `DataType.STRING` for unrestricted default length.
  - `DataType.STRING(n)` when length must be enforced.
- Prefer explicit defaults in models (`defaultValue`) for stable migration output.
- Define explicit indexes with model metadata where performance matters; SeqMig auto-adds FK indexes, but domain/query indexes should still be declared by you.
- For enum stability, keep enum values and order intentional and review generated enum migrations before applying in production.

## Pro Tips

- Run `seqmig preview` before every `seqmig generate` to catch unintended changes early.
- Keep migrations small and focused; avoid mixing unrelated schema changes in one file.
- Review generated `down` blocks carefully, especially for enum and destructive operations.
- Commit migration files and snapshot updates together in the same git commit.
- For production releases, test `up` and `down` on a staging clone of real data.
- When changing defaults or nullability on large tables, consider phased deployments to avoid long locks.
- If you hand-edit a generated migration, keep snapshot consistency by running `seqmig validate` after changes.

## Supported Schema Elements

- Table create/drop/rename
- Column add/drop/rename/alter
- Primary keys
- Foreign keys (single/composite)
- Unique constraints
- Indexes
- Check constraints
- ENUM / ARRAY / JSON / JSONB / DATEONLY / DECIMAL precision
- Default values (including common Sequelize tokens)
- Table and column comments

## Example Migration Shape

Generated migrations are transaction-wrapped:

```javascript
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      // generated operations
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },
  async down(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      // reverse operations
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },
};
```

## Backups

Snapshot backups are created automatically.

```bash
seqmig backups
seqmig restore <backup-file>
```

## Limitations

- Designed primarily for PostgreSQL.
- Rename detection is heuristic-based.
- No views/procedures/triggers migration support.
- Snapshot conflicts can occur across long-lived branches if not managed.

## License

ISC
