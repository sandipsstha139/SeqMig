#!/usr/bin/env node

import { Command } from "commander";
import { version } from "../package.json";

export {
  loadSeqmigConfig,
  loadSequelizeConfig,
  initConfig,
  type SeqmigConfig,
} from "./loaders/config-loader";
export {
  introspect,
  introspectModels,
  type IntrospectModelsResult,
} from "./services/introspect";
export {
  debugSummary,
  preview,
  generateMigration,
  scaffoldMigration,
  runMigrations,
  rollbackLast,
  rebuildSnapshot,
  validateSnapshot,
  type GenerateMigrationOptions,
} from "./services/migrate";
export {
  getSnapshotPaths,
  loadSnapshot,
  saveSnapshot,
  loadDatabaseSnapshot,
  normalizeSchemaForCompare,
  listBackups,
  restoreBackup,
} from "./services/state";
export { diff, diffActionsOnly, type DiffResult } from "./services/diff";
export {
  generate,
  scaffoldEmptyMigrationFile,
  sanitizeMigrationName,
  type GenerateOptions,
} from "./services/generator";
export type { RenameMapFile } from "./services/rename-map";
export type {
  DatabaseSchema,
  MigrationAction,
  TableSchema,
  ColumnSchema,
  SnapshotFileV2,
} from "./services/schema-types";

import { initConfig } from "./loaders/config-loader";
import { introspect } from "./services/introspect";
import {
  debugSummary,
  generateMigration,
  preview,
  scaffoldMigration,
  rebuildSnapshot,
  rollbackLast,
  runMigrations,
  validateSnapshot,
} from "./services/migrate";
import { listBackups, restoreBackup } from "./services/state";

function wrap(fn: (...args: any[]) => Promise<any>) {
  return async (...args: any[]) => {
    try {
      await fn(...args);
    } catch (err) {
      console.error("Error:", err);
      process.exit(1);
    }
  };
}

export async function runCli() {
  const program = new Command();

  program
    .name("seqmig")
    .description("Sequelize auto-migration CLI")
    .version(version);

  program
    .command("init")
    .description("Initialize .seqmigrc configuration file")
    .action(() => {
      initConfig();
    });

  program
    .command("preview")
    .description("Preview schema diff")
    .action(wrap(preview));

  program
    .command("generate")
    .description("Generate migration file")
    .option(
      "-n, --name <slug>",
      "Slug after the timestamp, e.g. add-user-requires-password-setup"
    )
    .action(
      wrap((opts: { name?: string }) => generateMigration({ name: opts.name }))
    );

  program
    .command("scaffold")
    .alias("blank")
    .description("Create an empty migration boilerplate (snapshot unchanged)")
    .option(
      "-n, --name <slug>",
      "Slug after the timestamp, e.g. backfill-legacy-organization-ids"
    )
    .action(wrap((opts: { name?: string }) => scaffoldMigration({ name: opts.name })));

  program
    .command("run")
    .description("Run pending migrations")
    .action(wrap(runMigrations));

  program
    .command("rollback")
    .description("Rollback last migration")
    .action(wrap(rollbackLast));

  program
    .command("rebuild")
    .description("Rebuild snapshot")
    .action(wrap(rebuildSnapshot));

  program
    .command("validate")
    .description("Validate snapshot")
    .action(wrap(validateSnapshot));

  program
    .command("debug")
    .alias("summary")
    .description("Debug diff with extra high-signal stats")
    .action(wrap(debugSummary));

  program
    .command("backups")
    .description("List snapshot backups")
    .action(() => {
      const backups = listBackups();
      if (backups.length === 0) {
        console.log("No backups found.");
        return;
      }
      console.log("Available backups:");
      backups.forEach((b, i) => console.log(`${i + 1}. ${b}`));
    });

  program
    .command("restore <backup>")
    .description("Restore snapshot")
    .action((backup: string) => {
      restoreBackup(backup);
    });

  program
    .command("introspect")
    .description("Introspect DB schema")
    .action(
      wrap(async () => {
        const result = await introspect();
        console.log(JSON.stringify(result, null, 2));
      })
    );

  await program.parseAsync(process.argv);
}

if (require.main === module) {
  runCli();
}
