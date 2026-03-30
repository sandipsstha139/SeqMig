import { QueryTypes } from "sequelize";
import { Sequelize } from "sequelize-typescript";
import { loadSequelizeConfig } from "../loaders/config-loader";
import type {
  CheckConstraintSchema,
  ColumnSchema,
  DatabaseSchema,
  ForeignKeySchema,
  IndexSchema,
  ScalarType,
  TableSchema,
  UniqueConstraintSchema,
} from "./schema-types";
import { PUBLIC_SCHEMA } from "./qualified";

type Row = Record<string, unknown>;

let sequelize: any;

async function ensureSequelize() {
  if (sequelize) return sequelize;
  const cfg = loadSequelizeConfig();
  sequelize = new Sequelize({
    ...cfg,
    logging: false,
  });
  return sequelize;
}

function warn(warnings: string[], msg: string) {
  warnings.push(msg);
}

function mapPgTypeToScalar(
  desc: { type: string; special?: string[] }
): { scalar: ScalarType; dbType: string } {
  const t = String(desc.type || "").toLowerCase();
  const base = t.replace(/\s+/g, " ");
  if (base.includes("[]")) return { scalar: "ARRAY", dbType: base.toUpperCase() };
  if (base === "uuid") return { scalar: "UUID", dbType: "UUID" };
  if (base.includes("timestamp") || base === "date")
    return { scalar: "DATE", dbType: base.toUpperCase() };
  if (base === "boolean") return { scalar: "BOOLEAN", dbType: "BOOLEAN" };
  if (base === "text") return { scalar: "TEXT", dbType: "TEXT" };
  if (base === "smallint") return { scalar: "SMALLINT", dbType: "SMALLINT" };
  if (base === "integer" || base === "bigint" || base.includes("int")) {
    if (base === "bigint") return { scalar: "BIGINT", dbType: "BIGINT" };
    if (base === "smallint") return { scalar: "SMALLINT", dbType: "SMALLINT" };
    return { scalar: "INTEGER", dbType: "INTEGER" };
  }
  if (base.includes("double")) return { scalar: "DOUBLE", dbType: "DOUBLE PRECISION" };
  if (base === "real" || base === "double precision")
    return { scalar: "FLOAT", dbType: base.toUpperCase() };
  if (base.includes("numeric") || base.includes("decimal"))
    return { scalar: "DECIMAL", dbType: "DECIMAL" };
  if (base === "jsonb") return { scalar: "JSONB", dbType: "JSONB" };
  if (base === "json") return { scalar: "JSON", dbType: "JSON" };
  if (base.startsWith("varchar") || base.startsWith("character varying"))
    return { scalar: "STRING", dbType: base.toUpperCase() };
  if (base.startsWith("char")) return { scalar: "STRING", dbType: base.toUpperCase() };
  if (t === "enum" || t === "user-defined") return { scalar: "ENUM", dbType: "ENUM" };
  return { scalar: "STRING", dbType: base.toUpperCase() };
}

async function loadEnumValues(
  typeSchema: string,
  typeName: string
): Promise<string[]> {
  const rows = (await sequelize.query(
    `
    SELECT e.enumlabel AS v
    FROM pg_type t
    JOIN pg_enum e ON t.oid = e.enumtypid
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = :nsp AND t.typname = :tn
    ORDER BY e.enumsortorder
    `,
    {
      replacements: { nsp: typeSchema, tn: typeName },
      type: QueryTypes.SELECT,
    }
  )) as { v: string }[];
  return rows.map((r) => r.v);
}

async function loadColumnEnums(
  tableSchema: string,
  tableName: string
): Promise<Map<string, { typeSchema: string; typeName: string }>> {
  const rows = (await sequelize.query(
    `
    SELECT a.attname AS col, nt.nspname AS type_schema, tt.typname AS type_name
    FROM pg_attribute a
    JOIN pg_class c ON a.attrelid = c.oid
    JOIN pg_namespace cn ON c.relnamespace = cn.oid
    JOIN pg_type tt ON a.atttypid = tt.oid
    JOIN pg_namespace nt ON tt.typnamespace = nt.oid
    WHERE cn.nspname = :ts AND c.relname = :tn
      AND a.attnum > 0 AND NOT a.attisdropped
      AND tt.typtype = 'e'
    `,
    {
      replacements: { ts: tableSchema, tn: tableName },
      type: QueryTypes.SELECT,
    }
  )) as { col: string; type_schema: string; type_name: string }[];

  const m = new Map<string, { typeSchema: string; typeName: string }>();
  for (const r of rows) {
    m.set(r.col, { typeSchema: r.type_schema, typeName: r.type_name });
  }
  return m;
}

async function loadForeignKeys(
  tableSchema: string,
  tableName: string,
  warnings: string[]
): Promise<ForeignKeySchema[]> {
  const rows = (await sequelize.query(
    `
    SELECT
      tc.constraint_name,
      kcu.ordinal_position,
      kcu.column_name,
      ccu.table_schema AS fs,
      ccu.table_name AS ft,
      ccu.column_name AS fc,
      rc.update_rule,
      rc.delete_rule
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_schema = kcu.constraint_schema
     AND tc.constraint_name = kcu.constraint_name
     AND tc.table_schema = kcu.table_schema
     AND tc.table_name = kcu.table_name
    JOIN information_schema.constraint_column_usage ccu
      ON ccu.constraint_schema = tc.constraint_schema
     AND ccu.constraint_name = tc.constraint_name
    JOIN information_schema.referential_constraints rc
      ON rc.constraint_schema = tc.constraint_schema
     AND rc.constraint_name = tc.constraint_name
    WHERE tc.table_schema = :ts
      AND tc.table_name = :tn
      AND tc.constraint_type = 'FOREIGN KEY'
    ORDER BY tc.constraint_name, kcu.ordinal_position
    `,
    {
      replacements: { ts: tableSchema, tn: tableName },
      type: QueryTypes.SELECT,
    }
  )) as {
    constraint_name: string;
    ordinal_position: number;
    column_name: string;
    fs: string;
    ft: string;
    fc: string;
    update_rule: string;
    delete_rule: string;
  }[];

  const byCon = new Map<string, typeof rows>();
  for (const r of rows) {
    const arr = byCon.get(r.constraint_name) || [];
    arr.push(r);
    byCon.set(r.constraint_name, arr);
  }

  const out: ForeignKeySchema[] = [];
  for (const [name, cols] of byCon) {
    const ordered = [...cols].sort((a, b) => a.ordinal_position - b.ordinal_position);
    const r0 = ordered[0]!;
    out.push({
      name,
      columns: ordered.map((r) => r.column_name),
      referencedTable: r0.ft,
      referencedColumns: ordered.map((r) => r.fc),
      referencedSchema: r0.fs === PUBLIC_SCHEMA ? undefined : r0.fs,
      onUpdate: r0.update_rule,
      onDelete: r0.delete_rule,
    });
  }
  return out;
}

async function loadUniques(
  tableSchema: string,
  tableName: string
): Promise<UniqueConstraintSchema[]> {
  const rows = (await sequelize.query(
    `
    SELECT con.conname AS name,
           array_agg(a.attname ORDER BY u.ord) AS cols
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    JOIN unnest(con.conkey) WITH ORDINALITY AS u(attnum, ord) ON TRUE
    JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = u.attnum
    WHERE nsp.nspname = :ts AND rel.relname = :tn
      AND con.contype = 'u'
    GROUP BY con.conname
    `,
    {
      replacements: { ts: tableSchema, tn: tableName },
      type: QueryTypes.SELECT,
    }
  )) as { name: string; cols: string[] }[];

  return rows.map((r) => ({ name: r.name, columns: r.cols }));
}

async function loadChecks(
  tableSchema: string,
  tableName: string
): Promise<CheckConstraintSchema[]> {
  const rows = (await sequelize.query(
    `
    SELECT con.conname AS name, pg_get_constraintdef(con.oid, true) AS expr
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    WHERE nsp.nspname = :ts AND rel.relname = :tn AND con.contype = 'c'
    `,
    {
      replacements: { ts: tableSchema, tn: tableName },
      type: QueryTypes.SELECT,
    }
  )) as { name: string; expr: string }[];

  return rows.map((r) => ({
    name: r.name,
    expression: r.expr.replace(/^CHECK\s*\((.*)\)\s*$/i, "$1"),
  }));
}

async function loadTableComment(
  tableSchema: string,
  tableName: string
): Promise<string | null> {
  const rows = (await sequelize.query(
    `
    SELECT d.description AS c
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_description d ON d.objoid = c.oid AND d.objsubid = 0
    WHERE n.nspname = :ts AND c.relname = :tn
    `,
    { replacements: { ts: tableSchema, tn: tableName }, type: QueryTypes.SELECT }
  )) as { c: string | null }[];
  return rows[0]?.c ?? null;
}

async function loadColumnComment(
  tableSchema: string,
  tableName: string,
  columnName: string
): Promise<string | null> {
  const rows = (await sequelize.query(
    `
    SELECT col_description(c.oid, a.attnum) AS c
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid
    WHERE n.nspname = :ts AND c.relname = :tn AND a.attname = :cn AND a.attnum > 0
    `,
    {
      replacements: { ts: tableSchema, tn: tableName, cn: columnName },
      type: QueryTypes.SELECT,
    }
  )) as { c: string | null }[];
  return rows[0]?.c ?? null;
}

/** Compare live PostgreSQL schema to Sequelize models (drift report). */
export async function introspectDatabase(): Promise<{
  schema: DatabaseSchema;
  warnings: string[];
}> {
  const warnings: string[] = [];
  sequelize = await ensureSequelize();

  await sequelize.authenticate();
  if (sequelize.getDialect() !== "postgres") {
    warn(warnings, "introspectDatabase only supports PostgreSQL");
    return { schema: { tables: [] }, warnings };
  }

  const qi = sequelize.getQueryInterface();

  const tableRows = (await sequelize.query(
    `
    SELECT table_schema, table_name
    FROM information_schema.tables
    WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
      AND table_type = 'BASE TABLE'
    ORDER BY table_schema, table_name
    `,
    { type: QueryTypes.SELECT }
  )) as { table_schema: string; table_name: string }[];

  const tables: TableSchema[] = [];

  for (const tr of tableRows) {
    const tableSchema = tr.table_schema;
    const tableName = tr.table_name;

    const describe = (await qi.describeTable({
      tableName,
      schema: tableSchema === PUBLIC_SCHEMA ? undefined : tableSchema,
    } as never)) as unknown as Record<string, Row>;

    const enumCols = await loadColumnEnums(tableSchema, tableName);
    const fkList = await loadForeignKeys(tableSchema, tableName, warnings);
    const uniquesRaw = await loadUniques(tableSchema, tableName);
    const checks = await loadChecks(tableSchema, tableName);
    const tableComment = await loadTableComment(tableSchema, tableName);

    const primaryKeys: string[] = [];
    const columns: ColumnSchema[] = [];

    for (const [colName, d] of Object.entries(describe)) {
      const allowNull = (d as any).allowNull !== false;
      const primaryKey = !!(d as any).primaryKey;
      if (primaryKey) primaryKeys.push(colName);

      const { scalar, dbType: dt0 } = mapPgTypeToScalar({
        type: String((d as any).type || "STRING"),
        special: Array.isArray((d as any).special)
          ? ((d as any).special as string[])
          : undefined,
      });

      let dbType = dt0;
      let enumValues: string[] | undefined;
      let enumTypeName: string | undefined;
      const en = enumCols.get(colName);
      if (en) {
        enumTypeName = `${en.typeSchema}.${en.typeName}`;
        enumValues = await loadEnumValues(en.typeSchema, en.typeName);
        dbType = `ENUM(${enumValues.map((v) => `'${v}'`).join(",")})`;
      }

      let defaultValue: unknown = (d as any).defaultValue ?? undefined;
      let hasDefault =
        defaultValue !== undefined && defaultValue !== null && `${defaultValue}` !== "";

      const defStr = String(defaultValue ?? "");
      if (defStr.toLowerCase().includes("now()")) {
        defaultValue = "NOW";
        hasDefault = true;
      } else if (
        defStr.includes("gen_random_uuid") ||
        defStr.includes("uuid_generate_v4")
      ) {
        defaultValue = "UUID_FUNCTION";
        hasDefault = true;
      } else if (!hasDefault) {
        defaultValue = undefined;
      }

      const colComments = await loadColumnComment(tableSchema, tableName, colName);

      const col: ColumnSchema = {
        name: colName,
        type: scalar === "ENUM" ? "ENUM" : scalar,
        dbType,
        allowNull,
        primaryKey,
        unique: !!(d as any).unique,
        autoIncrement: !!((d as any).autoIncrement || defStr.includes("nextval")),
        comment: colComments,
        enumValues,
        enumTypeName,
      };

      if (hasDefault && defaultValue !== undefined) {
        col.defaultValue = defaultValue;
      }

      columns.push(col);
    }

    const uniqueCols = new Set(
      uniquesRaw.flatMap((u) => (u.columns.length === 1 ? [u.columns[0]!] : []))
    );
    for (const c of columns) {
      if (uniqueCols.has(c.name)) c.unique = false;
    }

    const indexCols = (ix: Row): string[] => {
      const f = (ix as any).fields;
      if (!Array.isArray(f)) return [];
      return (f as unknown[])
        .map((x) => {
          if (typeof x === "string") return x;
          if (x && typeof x === "object") {
            const o = x as Record<string, unknown>;
            if (typeof o.attribute === "string") return o.attribute;
            if (typeof o.name === "string") return o.name;
            if (typeof o.column === "string") return o.column;
          }
          return "";
        })
        .filter(Boolean);
    };

    let indexList: IndexSchema[] = [];
    try {
      const rawIdx = await qi.showIndex({
        tableName,
        schema: tableSchema === PUBLIC_SCHEMA ? undefined : tableSchema,
      } as never);

      indexList = (rawIdx as Row[]).map((ix) => ({
        name: String((ix as any).name),
        columns: indexCols(ix),
        unique: !!(ix as any).unique,
        where: typeof (ix as any).where === "string" ? (ix as any).where : (ix as any).where ?? null,
        type: (ix as any).type ? String((ix as any).type) : null,
        using: (ix as any).using ? String((ix as any).using) : null,
      }));
    } catch {
      warn(
        warnings,
        `showIndex failed for ${tableSchema}.${tableName} — indexes may be incomplete`
      );
    }

    const uniqueColSets = new Set(
      uniquesRaw.map((u) => [...u.columns].sort().join("|"))
    );
    const indexes = indexList.filter((idx) => {
      if (idx.unique) return false;
      if (idx.columns.length === 1 && uniqueCols.has(idx.columns[0]!)) return false;
      const sig = [...idx.columns].sort().join("|");
      if (uniqueColSets.has(sig)) return false;
      return true;
    });

    tables.push({
      name: tableName,
      schema: tableSchema === PUBLIC_SCHEMA ? undefined : tableSchema,
      tableComment,
      columns,
      indexes,
      foreignKeys: fkList,
      uniques: uniquesRaw,
      checks,
      primaryKeys: primaryKeys.length
        ? primaryKeys
        : columns.filter((c) => c.primaryKey).map((c) => c.name),
    });
  }

  return {
    schema: {
      tables: tables.map((t) => ({
        ...t,
        schema: t.schema?.trim() || PUBLIC_SCHEMA,
        foreignKeys: t.foreignKeys.map((fk) => ({
          ...fk,
          referencedSchema: fk.referencedSchema?.trim() || PUBLIC_SCHEMA,
        })),
      })),
    },
    warnings,
  };
}

