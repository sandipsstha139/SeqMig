import fs from "fs";
import path from "path";
import { loadSeqmigConfig } from "../loaders/config-loader";
import { PUBLIC_SCHEMA } from "./qualified";
import type {
  DatabaseSchema,
  SnapshotFileV2,
  TableSchema,
  ForeignKeySchema,
} from "./schema-types";

const GENERATOR_LABEL = "seqmig@2";

export function getSnapshotPaths() {
  const cfg = loadSeqmigConfig();

  const snapshotDir = cfg.snapshotDir || ".seqmig/snapshots";
  const migrationDir = cfg.migrationDir || "migrations";

  const SNAPSHOT_FILE = path.join(
    process.cwd(),
    snapshotDir,
    "schema-snapshot.json"
  );
  const SNAPSHOT_DB_FILE = path.join(
    process.cwd(),
    snapshotDir,
    "schema-snapshot-db.json"
  );
  const SNAPSHOT_BACKUP_DIR = path.join(process.cwd(), snapshotDir, "backups");

  return { SNAPSHOT_FILE, SNAPSHOT_DB_FILE, SNAPSHOT_BACKUP_DIR, migrationDir, snapshotDir };
}

function normalizeForeignKeyForCompare(fk: any): ForeignKeySchema {
  if (Array.isArray(fk.columns) && Array.isArray(fk.referencedColumns)) {
    return {
      ...fk,
      referencedSchema: fk.referencedSchema?.trim() || PUBLIC_SCHEMA,
    };
  }

  const column = fk.column;
  const referencedColumn = fk.referencedColumn;
  return {
    ...fk,
    columns: Array.isArray(fk.columns) ? fk.columns : [column].filter(Boolean),
    referencedColumns: Array.isArray(fk.referencedColumns)
      ? fk.referencedColumns
      : [referencedColumn].filter(Boolean),
    referencedSchema: fk.referencedSchema?.trim() || PUBLIC_SCHEMA,
  };
}

function normalizeIndexColumns(fields: unknown): string[] {
  if (!Array.isArray(fields)) return [];

  const normalizeField = (f: unknown): string | null => {
    if (f == null) return null;
    if (typeof f === "string") return f;
    if (typeof f === "number") return String(f);
    if (typeof f === "object") {
      const o = f as Record<string, unknown>;
      const v = o.name ?? o.attribute ?? o.field ?? o.column ?? o.property ?? null;
      if (typeof v === "string") return v;
      if (typeof v === "number") return String(v);
    }
    return null;
  };

  return fields.map((f) => normalizeField(f)).filter((x): x is string => x != null);
}

export function normalizeSchemaForCompare(schema: DatabaseSchema): DatabaseSchema {
  return {
    tables: schema.tables.map((t) => {
      const schemaVal = t.schema?.trim() || PUBLIC_SCHEMA;
      return {
        ...t,
        schema: schemaVal,
        tableComment: t.tableComment ?? null,
        foreignKeys: (t.foreignKeys as any[]).map((fk) =>
          normalizeForeignKeyForCompare(fk)
        ),
        columns: t.columns.map((c) => ({
          ...c,
          comment: c.comment ?? null,
        })),
        indexes: (t.indexes as any[]).map((idx) => ({
          ...idx,
          columns: normalizeIndexColumns(idx.columns),
        })),
        uniques: (t.uniques as any[]).map((u) => ({
          ...u,
          columns: normalizeIndexColumns(u.columns),
        })),
      };
    }),
  };
}

export function loadSnapshot(): DatabaseSchema {
  const { SNAPSHOT_FILE } = getSnapshotPaths();

  if (!fs.existsSync(SNAPSHOT_FILE)) {
    return { tables: [] };
  }

  const raw = fs.readFileSync(SNAPSHOT_FILE, "utf8");
  const parsed = JSON.parse(raw) as SnapshotFileV2 | DatabaseSchema | TableSchema[];

  let tables: TableSchema[];
  if (Array.isArray(parsed)) {
    tables = parsed;
  } else if (
    parsed &&
    typeof parsed === "object" &&
    "tables" in parsed &&
    Array.isArray((parsed as DatabaseSchema).tables)
  ) {
    tables = (parsed as DatabaseSchema).tables;
  } else {
    tables = [];
  }

  return normalizeSchemaForCompare({
    tables: tables.map((t) => ({
      ...t,
      schema: t.schema?.trim() || PUBLIC_SCHEMA,
    })),
  });
}

export function loadDatabaseSnapshot(): DatabaseSchema {
  const { SNAPSHOT_DB_FILE } = getSnapshotPaths();

  if (!fs.existsSync(SNAPSHOT_DB_FILE)) {
    return { tables: [] };
  }

  const raw = fs.readFileSync(SNAPSHOT_DB_FILE, "utf8");
  const parsed = JSON.parse(raw) as SnapshotFileV2 | DatabaseSchema | TableSchema[];

  let tables: TableSchema[];
  if (Array.isArray(parsed)) {
    tables = parsed;
  } else if (
    parsed &&
    typeof parsed === "object" &&
    "tables" in parsed &&
    Array.isArray((parsed as DatabaseSchema).tables)
  ) {
    tables = (parsed as DatabaseSchema).tables;
  } else {
    tables = [];
  }

  return normalizeSchemaForCompare({
    tables: tables.map((t) => ({
      ...t,
      schema: t.schema?.trim() || PUBLIC_SCHEMA,
    })),
  });
}

export function saveSnapshot(schema: DatabaseSchema) {
  const { SNAPSHOT_FILE, SNAPSHOT_BACKUP_DIR } = getSnapshotPaths();

  const dir = path.dirname(SNAPSHOT_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(SNAPSHOT_BACKUP_DIR))
    fs.mkdirSync(SNAPSHOT_BACKUP_DIR, { recursive: true });

  if (fs.existsSync(SNAPSHOT_FILE)) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupFile = path.join(
      SNAPSHOT_BACKUP_DIR,
      `snapshot-${timestamp}.json`
    );
    fs.copyFileSync(SNAPSHOT_FILE, backupFile);
    cleanOldBackups(SNAPSHOT_BACKUP_DIR, 20);
  }

  const tablesForFile: TableSchema[] = schema.tables.map((t) => {
    const sch = t.schema?.trim() || PUBLIC_SCHEMA;
    return {
      ...t,
      schema: sch === PUBLIC_SCHEMA ? undefined : sch,
      foreignKeys: t.foreignKeys.map((fk) => {
        const rs = fk.referencedSchema?.trim() || PUBLIC_SCHEMA;
        return {
          ...fk,
          referencedSchema: rs === PUBLIC_SCHEMA ? undefined : rs,
        };
      }),
    };
  });

  const payload: SnapshotFileV2 = {
    version: 2,
    meta: {
      generator: GENERATOR_LABEL,
      updatedAt: new Date().toISOString(),
    },
    tables: tablesForFile,
  };

  fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(payload, null, 2));
}

function cleanOldBackups(backupDir: string, keepCount: number) {
  const backups = fs
    .readdirSync(backupDir)
    .filter((f) => f.startsWith("snapshot-"))
    .sort()
    .reverse();

  if (backups.length > keepCount) {
    backups.slice(keepCount).forEach((file) => {
      fs.unlinkSync(path.join(backupDir, file));
    });
  }
}

export function listBackups(): string[] {
  const { SNAPSHOT_BACKUP_DIR } = getSnapshotPaths();
  if (!fs.existsSync(SNAPSHOT_BACKUP_DIR)) return [];
  return fs
    .readdirSync(SNAPSHOT_BACKUP_DIR)
    .filter((f) => f.startsWith("snapshot-"))
    .sort()
    .reverse();
}

export function restoreBackup(backupFile: string) {
  const { SNAPSHOT_FILE, SNAPSHOT_BACKUP_DIR } = getSnapshotPaths();
  const backupPath = path.join(SNAPSHOT_BACKUP_DIR, backupFile);

  if (!fs.existsSync(backupPath)) {
    throw new Error(`Backup file not found: ${backupFile}`);
  }

  fs.copyFileSync(backupPath, SNAPSHOT_FILE);
  console.log(`Restored snapshot from ${backupFile}`);
}

