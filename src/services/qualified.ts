import type { ForeignKeySchema, TableSchema } from "./schema-types";

export const PUBLIC_SCHEMA = "public";

export function tableSchema(t: { schema?: string }): string {
  return t.schema?.trim() || PUBLIC_SCHEMA;
}

export function tableQual(t: { schema?: string; name: string }): string {
  const s = tableSchema(t);
  return s === PUBLIC_SCHEMA ? t.name : `${s}.${t.name}`;
}

export function parseQual(qual: string): { schema: string; name: string } {
  const i = qual.indexOf(".");
  if (i === -1) return { schema: PUBLIC_SCHEMA, name: qual };
  return {
    schema: qual.slice(0, i),
    name: qual.slice(i + 1),
  };
}

export function fkRefQual(fk: ForeignKeySchema): string {
  const s = fk.referencedSchema?.trim() || PUBLIC_SCHEMA;
  return s === PUBLIC_SCHEMA
    ? fk.referencedTable
    : `${s}.${fk.referencedTable}`;
}

export function fkSignature(
  tableSchemaVal: string,
  tableName: string,
  fk: ForeignKeySchema,
): string {
  const rs = fk.referencedSchema?.trim() || PUBLIC_SCHEMA;
  return `${tableSchemaVal}/${tableName}.${fk.columns.join(
    ",",
  )}→${rs}/${fk.referencedTable}.${fk.referencedColumns.join(",")}`;
}
