import { execa } from "execa";
import { diff } from "./diff";
import { generate, scaffoldEmptyMigrationFile } from "./generator";
import { introspectModels } from "./introspect";
import type { MigrationAction } from "./schema-types";
import { loadSnapshot, saveSnapshot } from "./state";

function summarizeActions(actions: MigrationAction[]): void {
  const byKind = new Map<string, number>();
  for (const a of actions) {
    byKind.set(a.kind, (byKind.get(a.kind) ?? 0) + 1);
  }
  console.log("Summary:");
  for (const [k, n] of [...byKind.entries()].sort(
    (a, b) => a[0].localeCompare(b[0])
  )) {
    console.log(`  ${k}: ${n}`);
  }
}

function printWarnings(label: string, warnings: string[]) {
  if (!warnings.length) return;
  console.log(`\n${label}:`);
  warnings.forEach((w) => console.log(`  - ${w}`));
}

function schemaStats(schema: ReturnType<typeof loadSnapshot>) {
  let tables = 0;
  let columns = 0;
  let indexes = 0;
  let foreignKeys = 0;
  let checks = 0;
  let uniques = 0;
  let compositeForeignKeys = 0;
  let enumColumns = 0;

  const enumKeys = new Set<string>();
  const comments = {
    tableComments: 0,
    columnComments: 0,
  };

  for (const t of schema.tables) {
    tables++;
    columns += t.columns.length;
    indexes += t.indexes.length;
    foreignKeys += t.foreignKeys.length;
    checks += t.checks.length;
    uniques += t.uniques.length;

    for (const c of t.columns) {
      if (c.type === "ENUM") {
        enumColumns++;
        const k =
          c.enumTypeName ||
          `${t.schema ?? "public"}.${t.name}.${c.name}.${c.dbType}`;
        enumKeys.add(k);
      }
      if (c.comment != null) comments.columnComments++;
    }

    if (t.tableComment != null) comments.tableComments++;

    for (const fk of t.foreignKeys) {
      if (fk.columns.length > 1) compositeForeignKeys++;
    }
  }

  return {
    tables,
    columns,
    indexes,
    foreignKeys,
    checks,
    uniques,
    compositeForeignKeys,
    enumColumns,
    enumTypes: enumKeys.size,
    comments,
  };
}

function addToMap(map: Map<string, number>, key: string, inc: number) {
  map.set(key, (map.get(key) ?? 0) + inc);
}

function enumChangeMode(
  action: Extract<MigrationAction, { kind: "alterEnum" }>
) {
  const beforeEnums = action.before.enumValues || [];
  const afterEnums = action.after.enumValues || [];

  const removed = beforeEnums.some((v) => !afterEnums.includes(v));

  const retainedInOrder = afterEnums.filter((v) => beforeEnums.includes(v));
  const isSameOrder =
      retainedInOrder.length === beforeEnums.length &&
      retainedInOrder.every((v, i) => v === beforeEnums[i]);

  return {
    beforeLen: beforeEnums.length,
    afterLen: afterEnums.length,
    mode: !removed && isSameOrder ? "add-only" : "recreate",
  };
}

export async function debugSummary() {
  const modeLabel = "schema-snapshot.json (before) vs models (after)";
  const before = loadSnapshot();

  const { schema: after, warnings: mw } = await introspectModels();

  const { actions, warnings: dw } = diff(before, after);

  const beforeStats = schemaStats(before);
  const afterStats = schemaStats(after);

  console.log("=== Debug Summary ===");
  console.log(`Mode: ${modeLabel}`);

  console.log("\nBefore stats:");
  console.log(beforeStats);

  console.log("\nAfter stats (models):");
  console.log(afterStats);

  console.log("\nDiff actions:");

  const byKind = new Map<string, number>();
  for (const a of actions) addToMap(byKind, a.kind, 1);
  const byKindSorted = [...byKind.entries()].sort((a, b) =>
    a[0].localeCompare(b[0])
  );
  for (const [k, n] of byKindSorted) console.log(`  ${k}: ${n}`);

  const impacted = new Map<string, number>();
  let renameTableCount = 0;
  let renameColumnCount = 0;
  let commentActionCount = 0;
  let addCompositeFkCount = 0;
  let dropCompositeFkCount = 0;
  let enumRecreateCount = 0;
  let enumAddOnlyCount = 0;

  for (const a of actions) {
    const pushQual = (schema: string | undefined, name: string) =>
      addToMap(impacted, `${schema?.trim() || "public"}.${name}`, 1);

    switch (a.kind) {
      case "createTable":
        pushQual(a.table.schema, a.table.name);
        break;
      case "dropTable":
        pushQual(a.backup.schema, a.tableName);
        break;
      case "renameTable":
        renameTableCount++;
        addToMap(impacted, `${a.fromSchema}.${a.fromName}`, 1);
        addToMap(impacted, `${a.toSchema}.${a.toName}`, 1);
        break;
      case "setTableComment":
        commentActionCount++;
        pushQual(a.tableSchema, a.tableName);
        break;
      case "setColumnComment":
        commentActionCount++;
        pushQual(a.tableSchema, a.tableName);
        break;
      case "renameColumn":
        renameColumnCount++;
        pushQual(a.tableSchema, a.tableName);
        break;
      case "alterEnum":
        pushQual(a.tableSchema, a.tableName);
        break;
      case "alterColumn":
      case "addColumn":
      case "dropColumn":
      case "addFK":
      case "dropFK":
      case "createIndex":
      case "dropIndex":
      case "addUnique":
      case "dropUnique":
      case "addCheck":
      case "dropCheck":
      case "changePrimaryKey":
        pushQual(a.tableSchema, a.tableName);
        break;
      default:
        break;
    }

    if (a.kind === "addFK" && a.fk.columns.length > 1) {
      addCompositeFkCount++;
    }
    if (a.kind === "dropFK" && a.backup.columns.length > 1) {
      dropCompositeFkCount++;
    }

    if (a.kind === "alterEnum") {
      const m = enumChangeMode(a);
      if (m.mode === "add-only") enumAddOnlyCount++;
      else enumRecreateCount++;
    }
  }

  const impactedSorted = [...impacted.entries()].sort((a, b) => b[1] - a[1]);
  console.log("\nHigh-signal counters:");
  console.log(`  renameTable: ${renameTableCount}`);
  console.log(`  renameColumn: ${renameColumnCount}`);
  console.log(`  comment actions: ${commentActionCount}`);
  console.log(
    `  composite FK actions: add=${addCompositeFkCount}, drop=${dropCompositeFkCount}`
  );
  console.log(
    `  enum changes: add-only=${enumAddOnlyCount}, recreate=${enumRecreateCount}`
  );

  if (impactedSorted.length) {
    console.log("\nTop impacted tables:");
    impactedSorted.slice(0, 10).forEach(([t, n]) => {
      console.log(`  ${t}: ${n}`);
    });
  }

  printWarnings("Model introspection", mw);
  printWarnings("Diff", dw);
}

export async function preview() {
  const before = loadSnapshot();

  const { schema: after, warnings: mw } = await introspectModels();
  printWarnings("Model introspection", mw);

  const { actions, warnings: dw } = diff(before, after);
  printWarnings("Diff", dw);
  summarizeActions(actions);
  console.log("\nJSON:");
  console.log(JSON.stringify(actions, null, 2));
}

export type GenerateMigrationOptions = {
  name?: string;
};

export async function generateMigration(options?: GenerateMigrationOptions) {
  const { schema: after, warnings: mw } = await introspectModels();
  printWarnings("Model introspection", mw);

  const before = loadSnapshot();

  const { actions, warnings: dw } = diff(before, after);
  printWarnings("Diff", dw);

  if (!actions.length) {
    console.log("No schema changes detected. No migration generated.");
    return;
  }

  const file = generate(actions, { name: options?.name });
  if (!file) {
    console.log("No migration file written.");
    return;
  }
  saveSnapshot(after);
  console.log("Generated migration:", file);
}

export async function scaffoldMigration(options?: GenerateMigrationOptions) {
  const file = scaffoldEmptyMigrationFile({ name: options?.name });
  console.log("Scaffolded empty migration (snapshot unchanged):", file);
}

export async function runMigrations() {
  await execa("npx", ["sequelize-cli", "db:migrate"], {
    stdio: "inherit",
  });
}

export async function rollbackLast() {
  await execa("npx", ["sequelize-cli", "db:migrate:undo"], {
    stdio: "inherit",
  });
}

export async function rebuildSnapshot() {
  console.log(
    "⚠️  WARNING: This will overwrite your snapshot with current ORM model state (introspected)."
  );
  console.log(
    "Use only if the snapshot is wrong or out of sync with what models represent."
  );
  console.log("Press Ctrl+C to cancel, or wait 5 seconds to continue...");

  await new Promise((resolve) => setTimeout(resolve, 5000));

  const { schema: current, warnings } = await introspectModels();
  printWarnings("Model introspection", warnings);
  saveSnapshot(current);
  console.log("✓ Snapshot rebuilt from Sequelize models");
}

export async function validateSnapshot() {
  console.log("Validating snapshot against current model introspection...\n");

  const snapshot = loadSnapshot();
  const { schema: actual, warnings } = await introspectModels();
  printWarnings("Model introspection", warnings);

  const { actions, warnings: dw } = diff(snapshot, actual);
  printWarnings("Diff", dw);

  if (!actions.length) {
    console.log("✓ Snapshot matches introspected model schema");
    return;
  }

  console.log("⚠️  Snapshot differs from introspected models!");
  summarizeActions(actions);
  console.log(`\n(${actions.length} actions — run seqmig preview for JSON)\n`);

  console.log("Options:");
  console.log("  1. Run `seqmig generate` to emit a migration for the diff");
  console.log(
    "  2. Run `seqmig scaffold` for an empty boilerplate file (custom SQL / data fixes)"
  );
  console.log(
    "  3. Run `seqmig rebuild` to replace the snapshot (review first)"
  );
  console.log("  4. Run `seqmig restore <backup>` to restore a snapshot backup");
  console.log(
    "  Optional: `rename-map.json` next to migrations (from .sequelizerc) for explicit table/column renames."
  );
  console.log(
    "  Set MIGRATION_ALLOW_RENAME_HEURISTIC=1 for fuzzy column rename detection."
  );
}
