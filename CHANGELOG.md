# seqmig

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
