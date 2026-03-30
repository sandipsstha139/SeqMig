import type { ColumnSchema, ForeignKeySchema, IndexSchema } from "./schema-types";
import { fkRefQual } from "./qualified";

function normDbType(t: string): string {
  return t.replace(/\s+/g, "").toUpperCase();
}

function sortedEnum(v: string[] | undefined): string {
  if (!v || !v.length) return "";
  return [...v].sort().join("|");
}

export function normalizeDefaultFingerprint(v: unknown): string {
  if (v === undefined) return "__undef__";
  if (v === null) return "__null__";
  if (v === "NOW" || v === "UUID_FUNCTION") return String(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return String(v);
  if (typeof v === "object" && v !== null && "val" in (v as object))
    return normalizeDefaultFingerprint((v as { val: unknown }).val);
  return JSON.stringify(v);
}

export function columnsEqual(a: ColumnSchema, b: ColumnSchema): boolean {
  if (a.name !== b.name) return false;
  if (normDbType(a.dbType) !== normDbType(b.dbType)) return false;
  if (a.type !== b.type) return false;
  if (a.allowNull !== b.allowNull) return false;
  if (!!a.primaryKey !== !!b.primaryKey) return false;
  if (!!a.unique !== !!b.unique) return false;
  if (!!a.autoIncrement !== !!b.autoIncrement) return false;
  const ca = (a.comment ?? null) === (b.comment ?? null);
  if (!ca) return false;
  if (sortedEnum(a.enumValues) !== sortedEnum(b.enumValues)) return false;

  const ha =
    Object.prototype.hasOwnProperty.call(a, "defaultValue") &&
    a.defaultValue !== undefined;
  const hb =
    Object.prototype.hasOwnProperty.call(b, "defaultValue") &&
    b.defaultValue !== undefined;
  if (ha !== hb) return false;
  if (ha) {
    if (
      normalizeDefaultFingerprint(a.defaultValue) !==
      normalizeDefaultFingerprint(b.defaultValue)
    ) {
      return false;
    }
  }
  return true;
}

export function columnStructureEqual(
  a: ColumnSchema,
  b: ColumnSchema
): boolean {
  return columnsEqual(
    { ...a, name: "_", comment: null },
    { ...b, name: "_", comment: null }
  );
}

export function primaryKeysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

export function indexesEqual(a: IndexSchema, b: IndexSchema): boolean {
  if (a.name !== b.name) return false;
  if (!!a.unique !== !!b.unique) return false;
  if (a.columns.length !== b.columns.length) return false;
  if (!a.columns.every((c, i) => c === b.columns[i]!)) return false;
  if (JSON.stringify(a.where ?? null) !== JSON.stringify(b.where ?? null))
    return false;
  if ((a.type ?? null) !== (b.type ?? null)) return false;
  if ((a.using ?? null) !== (b.using ?? null)) return false;
  return true;
}

function normFkRule(r: string | null | undefined): string {
  return String(r ?? "NO ACTION").trim().toUpperCase().replace(/ /g, "_");
}

export function foreignKeysEqual(
  a: ForeignKeySchema,
  b: ForeignKeySchema
): boolean {
  if (a.columns.length !== b.columns.length) return false;
  if (!a.columns.every((c, i) => c === b.columns[i]!)) return false;
  if (a.referencedTable !== b.referencedTable) return false;
  if (a.referencedColumns.length !== b.referencedColumns.length) return false;
  if (
    !a.referencedColumns.every((c, i) => c === b.referencedColumns[i]!)
  )
    return false;
  if (normFkRule(a.onDelete) !== normFkRule(b.onDelete)) return false;
  if (normFkRule(a.onUpdate) !== normFkRule(b.onUpdate)) return false;
  const sa = a.referencedSchema?.trim() || "public";
  const sb = b.referencedSchema?.trim() || "public";
  return sa === sb;
}

export function findMatchingPrevFk(
  tableSchemaVal: string,
  tableName: string,
  fk: ForeignKeySchema,
  prevFks: ForeignKeySchema[]
): ForeignKeySchema | undefined {
  const byName = prevFks.find((p) => p.name === fk.name);
  if (byName && foreignKeysEqual(byName, fk)) return byName;

  return prevFks.find(
    (p) =>
      p.columns.length === fk.columns.length &&
      p.columns.every((c, i) => c === fk.columns[i]!) &&
      fkRefQual(p) === fkRefQual(fk) &&
      p.referencedColumns.length === fk.referencedColumns.length &&
      p.referencedColumns.every((c, i) => c === fk.referencedColumns[i]!)
  );
}

