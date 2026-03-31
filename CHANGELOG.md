# seqmig

## 2.0.3

### Patch Changes

- Fixed model module loading to detect and select exports that extend `sequelize-typescript` `Model` instead of relying on the first export.
- Prevented crashes when model files export constants/enums/objects before the model class by skipping non-model exports during `sequelize.addModels(...)`.

## 2.0.2

### Patch Changes

- Improved `paranoid` model handling so generated `deletedAt` columns remain nullable by default.
- Updated foreign-key index generation to ensure FK indexes are consistently created unless an equivalent index already exists.
- Updated CLI help configuration to use `helpCommand(...)` (Commander v14-friendly, non-deprecated API).
- Expanded documentation with migration guidelines and pro tips for predictable generation.

## 2.0.1

### Patch Changes

- Minified the code with terser

## 2.0.0

### Major Changes

- **Breaking:** Removed DB-baseline/drift workflow and related CLI/API surface.
  - Removed `--from-db` option.
  - Removed `validate-db` and `pull-db` commands.
  - Removed DB-introspection service export and implementation.
- **Breaking:** Nullability defaults are now strict for model introspection.
  - If `allowNull` is not explicitly provided on a column, it defaults to `false`.
  - Generated migrations now always emit explicit `allowNull`.

### Minor Changes

- Added `DATEONLY` mapping support (`DataType.DATEONLY` -> `Sequelize.DATEONLY`).
- Excluded `DataType.VIRTUAL` columns from migration generation.
- Updated string handling: plain `DataType.STRING` emits `Sequelize.STRING`, explicit lengths are preserved.
- Added automatic foreign-key index generation when no covering index/unique/PK exists.
- Foreign keys now default `onDelete` and `onUpdate` to `CASCADE` when omitted.
- Added enum cleanup in `down` migrations via `DROP TYPE IF EXISTS ...`.
- Improved default value normalization for Sequelize token-like defaults.

## 1.2.2

### Patch Changes

- **Windows:** Fixed snapshot directory resolution so absolute paths from config are not joined again with `process.cwd()` (which caused invalid paths like `…\project\C:\…\.seqmig\snapshots` and broke `generate` / `saveSnapshot`).
- **Windows:** Model loading now uses `pathToFileURL` for dynamic `import()` of model files on disk.

## 1.2.0

### Minor Changes

- Upgraded schema diff + migration generator (less churn, more correctness)
- Added PostgreSQL baseline workflow (`--from-db`) + drift tooling
- Added commands: `scaffold` (blank), `validate-db`, `pull-db`, `debug`/`summary`
- Added support for table/column comments, safer enum changes (incl defaults), composite foreign keys, and `renameTable`

## 1.1.1

### Patch Changes

- Updated `README.md` with usage/docs improvements
- Minor wording/format fixes (no functional behavior change)

## 1.1.0

### Minor Changes

- Added `pg` dependency to support PostgreSQL connectivity (required by Sequelize when using Postgres)
- Improved installation experience for Postgres-based projects

## 1.0.0

### Major Changes

- Initial release of `seqmig` CLI
- Snapshot-based workflow: generate migrations by diffing stored schema snapshot vs Sequelize models
- Basic migration generation for tables/columns/indexes/foreign keys/uniques/checks and primary keys
