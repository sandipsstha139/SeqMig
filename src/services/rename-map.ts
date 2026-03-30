import fs from "fs";
import path from "path";
import { loadSeqmigConfig } from "../loaders/config-loader";
import { parseQual, tableQual } from "./qualified";
import type { TableSchema } from "./schema-types";

/** Optional `rename-map.json` beside migrations (from .sequelizerc) or path from `MIGRATION_RENAME_MAP`. */
export type RenameMapFile = {
  renameTables?: {
    fromSchema?: string;
    fromName: string;
    toSchema?: string;
    toName: string;
  }[];
  renameColumns?: {
    schema?: string;
    table: string;
    fromName: string;
    toName: string;
  }[];
};

function defaultRenameMapPath(): string {
  const env = process.env.MIGRATION_RENAME_MAP?.trim();
  if (env) return path.isAbsolute(env) ? env : path.join(process.cwd(), env);
  const cfg = loadSeqmigConfig();
  return path.join(cfg.migrationDir, "rename-map.json");
}

export function loadRenameMap(): RenameMapFile {
  const p = defaultRenameMapPath();
  if (!fs.existsSync(p)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8")) as RenameMapFile;
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

/** Map before table qual -> after table qual (for tables that only renamed). */
export function tableRenameQualMap(map: RenameMapFile): Map<string, string> {
  const m = new Map<string, string>();
  for (const e of map.renameTables || []) {
    const fs = e.fromSchema?.trim() || "public";
    const ts = e.toSchema?.trim() || "public";
    const fromQ = tableQual({ schema: fs, name: e.fromName });
    const toQ = tableQual({ schema: ts, name: e.toName });
    m.set(fromQ, toQ);
  }
  return m;
}

/** Column renames keyed by "${schema}.${table}|fromName" -> toName */
export function columnRenameMap(map: RenameMapFile): Map<string, string> {
  const m = new Map<string, string>();
  for (const e of map.renameColumns || []) {
    const s = e.schema?.trim() || "public";
    const k = `${s}.${e.table}|${e.fromName}`;
    m.set(k, e.toName);
  }
  return m;
}

export function applyExplicitColumnRenames(
  prevCols: { name: string }[],
  colRename: Map<string, string>,
  tableSchemaVal: string,
  tableName: string,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const c of prevCols) {
    const key = `${tableSchemaVal}.${tableName}|${c.name}`;
    const to = colRename.get(key);
    if (to) out.set(c.name, to);
  }
  return out;
}

/** Adjust "before" snapshot tables as if renames already applied (for drop/create avoidance). */
export function rewriteBeforeTablesForRenames(
  beforeTables: TableSchema[],
  map: RenameMapFile,
): TableSchema[] {
  const tmap = tableRenameQualMap(map);
  if (tmap.size === 0) return beforeTables;

  return beforeTables.map((t) => {
    const q = tableQual(t);
    const toQ = tmap.get(q);
    if (!toQ) return t;
    const { schema, name } = parseQual(toQ);
    return {
      ...t,
      schema: schema === "public" ? undefined : schema,
      name,
    };
  });
}
