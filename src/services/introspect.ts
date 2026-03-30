import "reflect-metadata";

import fs from "fs";
import path from "path";
import { pathToFileURL } from "node:url";
import { Model, ModelCtor, Sequelize } from "sequelize-typescript";

import {
  loadSeqmigConfig,
  loadSequelizeConfig,
} from "../loaders/config-loader";
import type {
  CheckConstraintSchema,
  ColumnSchema,
  DatabaseSchema,
  ForeignKeySchema,
  IndexSchema,
  UniqueConstraintSchema,
} from "./schema-types";

function registerRuntime() {
  try {
    require("tsx/esm");
  } catch {
    console.warn("tsx not found. Only JS will load.");
  }
}

function getAllModelFiles(dir: string): string[] {
  const files: string[] = [];
  if (!fs.existsSync(dir)) {
    throw new Error(`Models directory not found: ${dir}`);
  }
  for (const item of fs.readdirSync(dir)) {
    const fullPath = path.join(dir, item);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      files.push(...getAllModelFiles(fullPath));
    } else if (
      (item.endsWith(".ts") || item.endsWith(".js")) &&
      !item.endsWith(".d.ts") &&
      item !== "index.ts" &&
      item !== "index.js"
    ) {
      files.push(fullPath);
    }
  }
  return files;
}

/** Dynamic `import()` needs a file URL on Windows; bare `C:\...` paths fail. */
function importModelFile(absPath: string): Promise<any> {
  return import(pathToFileURL(absPath).href);
}

function toScalar(db: string): ColumnSchema["type"] {
  const t = db.toUpperCase();
  if (t.includes("ARRAY")) return "ARRAY";
  if (t.startsWith("ENUM") || t.includes("ENUM(")) return "ENUM";
  if (t.includes("UUID")) return "UUID";
  if (t.includes("TIMESTAMP") || t.includes("DATE")) return "DATE";
  if (t.includes("DOUBLE") || t.includes("DOUBLE PRECISION")) return "DOUBLE";
  if (t.includes("BIGINT")) return "BIGINT";
  if (t.includes("INT")) return "INTEGER";
  if (t.includes("TEXT")) return "TEXT";
  if (t.includes("SMALLINT")) return "SMALLINT";
  if (t.includes("CHAR") || t.includes("STRING")) return "STRING";
  if (t.includes("BOOLEAN")) return "BOOLEAN";
  if (t.includes("JSONB")) return "JSONB";
  if (t.includes("JSON")) return "JSON";
  if (t.includes("DECIMAL") || t.includes("NUMERIC")) return "DECIMAL";
  if (t.includes("FLOAT") || t.includes("REAL")) return "FLOAT";
  return "STRING";
}

function refineDbType(raw: string, attr: Record<string, unknown>): string {
  const typeObj = attr.type as
    | { key?: string; options?: Record<string, unknown> }
    | undefined;
  if (!typeObj?.key || !typeObj.options) return raw;

  const key = String(typeObj.key).toUpperCase();
  const opts = typeObj.options as Record<string, unknown>;
  if (key === "STRING" || key === "CHAR") {
    const len = opts.length;
    if (typeof len === "number") {
      return key === "CHAR" ? `CHAR(${len})` : `VARCHAR(${len})`;
    }
    return key === "CHAR" ? "CHAR" : "STRING";
  }
  if (key === "DECIMAL") {
    const precision = opts.precision;
    const scale = opts.scale;
    if (typeof precision === "number") {
      if (typeof scale === "number") return `DECIMAL(${precision}, ${scale})`;
      return `DECIMAL(${precision}, 0)`;
    }
  }

  return raw;
}

function extractEnumValues(dbType: string): string[] | undefined {
  const upper = dbType.toUpperCase();
  if (!upper.startsWith("ENUM") && !upper.includes("ENUM(")) return undefined;

  const startIdx = dbType.indexOf("(");
  const endIdx = dbType.lastIndexOf(")");
  if (startIdx === -1 || endIdx === -1) return undefined;

  const inner = dbType.slice(startIdx + 1, endIdx);
  return inner.split(",").map((v) => v.trim().replace(/^["']+|["']+$/g, ""));
}

function collectDefaultProbes(
  value: unknown,
  probes: string[],
  seen: WeakSet<object>,
  depth = 0,
) {
  if (depth > 3 || value === null || value === undefined) return;

  const tryPush = (v: unknown) => {
    if (typeof v === "string" && v.trim().length > 0) probes.push(v);
  };

  if (typeof value === "string") {
    tryPush(value);
    return;
  }
  if (typeof value === "function") {
    tryPush(value.name);
    tryPush(value.toString());
    return;
  }
  if (typeof value !== "object") return;

  const obj = value as Record<string, unknown> & {
    toSql?: () => unknown;
    constructor?: { name?: string };
  };
  if (seen.has(obj)) return;
  seen.add(obj);

  tryPush(obj.constructor?.name);
  tryPush(obj.key);
  tryPush(obj.name);
  tryPush(obj.fn);
  tryPush(obj.val);

  try {
    if (typeof obj.toSql === "function") {
      collectDefaultProbes(obj.toSql(), probes, seen, depth + 1);
    }
  } catch {
    // Ignore opaque dialect-specific objects.
  }

  try {
    tryPush(String(value));
  } catch {
    // Ignore objects with non-stringifiable implementations.
  }

  for (const nested of Object.values(obj)) {
    collectDefaultProbes(nested, probes, seen, depth + 1);
  }
}

function detectSpecialDefaultToken(
  value: unknown,
): "NOW" | "UUID_FUNCTION" | undefined {
  if (value === null || value === undefined) return undefined;
  const probes: string[] = [];
  collectDefaultProbes(value, probes, new WeakSet<object>());
  const haystack = probes.join(" ").toLowerCase();
  if (
    haystack.includes("gen_random_uuid") ||
    haystack.includes("uuid_generate_v4") ||
    haystack.includes("uuidv4")
  ) {
    return "UUID_FUNCTION";
  }
  if (
    haystack.includes("now()") ||
    haystack.includes("sequelize.now") ||
    haystack.includes("current_timestamp")
  ) {
    return "NOW";
  }
  return undefined;
}

function normalizeModelDefault(
  columnName: string,
  rawUpperType: string,
  value: unknown,
): { hasDefault: boolean; defaultValue: unknown } {
  if (value === null || value === undefined) {
    return { hasDefault: false, defaultValue: null };
  }

  const special = detectSpecialDefaultToken(value);
  if (special) return { hasDefault: true, defaultValue: special };

  if (typeof value === "string") {
    if (value === "undefined") return { hasDefault: false, defaultValue: null };
    if (value.includes("::")) {
      const beforeTypeCast = value.split("::")[0].trim();
      if (beforeTypeCast.toUpperCase() === "NULL" || beforeTypeCast === "") {
        return { hasDefault: false, defaultValue: null };
      }
      return {
        hasDefault: true,
        defaultValue: beforeTypeCast.replace(/^'(.*)'$/, "$1"),
      };
    }
    return { hasDefault: true, defaultValue: value };
  }

  if (typeof value === "function") {
    if (
      (columnName === "createdAt" || columnName === "updatedAt") &&
      (rawUpperType.includes("DATE") || rawUpperType.includes("TIMESTAMP"))
    ) {
      return { hasDefault: true, defaultValue: "NOW" };
    }
    if (columnName === "id" && rawUpperType.includes("UUID")) {
      return { hasDefault: true, defaultValue: "UUID_FUNCTION" };
    }
    return { hasDefault: false, defaultValue: null };
  }

  if (typeof value === "object") {
    if (Array.isArray(value)) return { hasDefault: true, defaultValue: value };
    if (value instanceof Date) return { hasDefault: true, defaultValue: value };

    const proto = Object.getPrototypeOf(value);
    const isPlainObject = proto === Object.prototype || proto === null;
    if (
      isPlainObject &&
      Object.keys(value as Record<string, unknown>).length === 0
    ) {
      // Opaque sequelize tokens may serialize to empty objects; avoid emitting `{}` defaults.
      if (
        rawUpperType.includes("UUID") ||
        rawUpperType.includes("DATE") ||
        rawUpperType.includes("TIMESTAMP")
      ) {
        return { hasDefault: false, defaultValue: null };
      }
    }
    return { hasDefault: true, defaultValue: value };
  }

  return { hasDefault: true, defaultValue: value };
}

function isManyToManyJoinTable(
  foreignKeys: ForeignKeySchema[],
  indexes: IndexSchema[],
): boolean {
  if (foreignKeys.length < 2) return false;
  const fkColumns = foreignKeys.flatMap((fk) => fk.columns);
  return indexes.some((idx) => {
    if (!idx.unique) return false;
    const fkInIndex = idx.columns.filter((col) => fkColumns.includes(col));
    return fkInIndex.length >= 2;
  });
}

function getModelTableId(m: ModelCtor<Model>): {
  schema: string;
  name: string;
} {
  const raw = m.getTableName();
  if (typeof raw === "string") return { schema: "public", name: raw };
  const o = raw as { schema?: string; tableName?: string };
  return {
    schema: (o.schema?.trim() || "public") as string,
    name: String(o.tableName ?? raw),
  };
}

function resolveRefModel(
  modelRef: unknown,
  models: ModelCtor<Model>[],
): ModelCtor<Model> | undefined {
  if (typeof modelRef === "function") {
    const M = modelRef as ModelCtor<Model>;
    try {
      if (M?.prototype instanceof Model) return M;
    } catch {
      return undefined;
    }
  }
  if (typeof modelRef === "string") {
    return models.find(
      (mm) => mm.name === modelRef || getModelTableId(mm).name === modelRef,
    );
  }
  return undefined;
}

export type IntrospectModelsResult = {
  schema: DatabaseSchema;
  warnings: string[];
};

export async function introspectModels(): Promise<IntrospectModelsResult> {
  registerRuntime();

  const dbCfg = loadSequelizeConfig();
  const seqmig = loadSeqmigConfig();

  const sequelize = new Sequelize({
    ...dbCfg,
    logging: false,
  });

  (sequelize as any).import = (filePath: string) => {
    if (!filePath.endsWith(".ts") && !filePath.endsWith(".js")) {
      if (fs.existsSync(`${filePath}.ts`)) filePath = `${filePath}.ts`;
      else if (fs.existsSync(`${filePath}.js`)) filePath = `${filePath}.js`;
    }
    return importModelFile(path.resolve(filePath));
  };

  const modelsPath = seqmig.modelsPath;

  const modelFiles = getAllModelFiles(modelsPath);
  const modelClasses: any[] = [];
  for (const file of modelFiles) {
    const mod = await importModelFile(file);
    const modelClass = mod.default || Object.values(mod)[0];
    modelClasses.push(modelClass);
  }
  sequelize.addModels(modelClasses);

  await sequelize.authenticate();

  const schema: DatabaseSchema = { tables: [] };
  const warnings: string[] = [];
  const models = sequelize.modelManager.models as ModelCtor<Model>[];

  for (const m of models) {
    const tid = getModelTableId(m);
    const tableName = tid.name;
    const tableSchema = tid.schema;
    const attrs = m.getAttributes();

    const columns: ColumnSchema[] = Object.entries(attrs).map(([name, a]) => {
      const attr = a as unknown as Record<string, unknown>;
      let raw = refineDbType(
        String(
          (attr.type as { toString?: () => string })?.toString?.() ?? "STRING",
        ),
        attr,
      );

      const isArray =
        raw.toUpperCase().includes("ARRAY") ||
        (attr.type &&
          typeof attr.type === "object" &&
          (attr.type as { key?: string }).key === "ARRAY") ||
        (attr.type &&
          typeof attr.type === "object" &&
          (attr.type as { constructor?: { name?: string } }).constructor
            ?.name === "ARRAY");

      const isEnum =
        raw.toUpperCase().includes("ENUM") ||
        (attr.type &&
          typeof attr.type === "object" &&
          (attr.type as { key?: string }).key === "ENUM") ||
        (attr.type &&
          typeof attr.type === "object" &&
          (attr.type as { constructor?: { name?: string } }).constructor
            ?.name === "ENUM") ||
        (attr.type &&
          typeof attr.type === "object" &&
          Array.isArray((attr.type as { values?: unknown }).values));

      let enumValues: string[] | undefined;
      if (isEnum) {
        const tv = (attr.type as { values?: string[] })?.values;
        if (Array.isArray(tv)) enumValues = tv;
        else enumValues = extractEnumValues(raw);
      }

      let defaultValue: unknown = attr.defaultValue;
      let hasDefault = false;
      const rawUpper = raw.toUpperCase();

      if (defaultValue !== null && defaultValue !== undefined) {
        const normalized = normalizeModelDefault(name, rawUpper, defaultValue);
        hasDefault = normalized.hasDefault;
        defaultValue = normalized.defaultValue;
      }

      if (!hasDefault && (name === "createdAt" || name === "updatedAt")) {
        if (rawUpper.includes("DATE") || rawUpper.includes("TIMESTAMP")) {
          hasDefault = true;
          defaultValue = "NOW";
        }
      }

      if (
        !hasDefault &&
        attr.defaultValue !== undefined &&
        name === "id" &&
        rawUpper.includes("UUID")
      ) {
        hasDefault = true;
        defaultValue = "UUID_FUNCTION";
      }

      if (defaultValue === undefined) {
        defaultValue = null;
        hasDefault = false;
      }

      const primaryKey = !!attr.primaryKey;
      const allowNull = primaryKey ? false : attr.allowNull !== false;

      const column: ColumnSchema = {
        name,
        type: isArray ? "ARRAY" : isEnum ? "ENUM" : toScalar(raw),
        dbType: raw || "STRING",
        allowNull,
        primaryKey,
        unique:
          !!attr.unique ||
          attr.unique === true ||
          typeof attr.unique === "string",
        autoIncrement: !!attr.autoIncrement,
        comment: (attr.comment as string | null) || null,
        enumValues,
      };

      if (hasDefault) {
        column.defaultValue = defaultValue;
      }

      return column;
    });

    const primaryKeys = columns.filter((c) => c.primaryKey).map((c) => c.name);

    const normalizeIndexField = (f: unknown): string | null => {
      if (f == null) return null;
      if (typeof f === "string") return f;
      if (typeof f === "object") {
        const o = f as Record<string, unknown>;
        const v =
          o.name ?? o.attribute ?? o.field ?? o.column ?? o.property ?? null;
        if (typeof v === "string") return v;
        if (typeof v === "number") return String(v);
      }
      return typeof f === "number" ? String(f) : null;
    };

    const optsAny = m.options as unknown as {
      indexes?: Array<Record<string, unknown>>;
    };
    const rawIndexes: IndexSchema[] =
      (optsAny.indexes?.map((idx) => {
        const fields = Array.isArray((idx as any).fields)
          ? ((idx as any).fields as unknown[])
          : [];

        const indexCols = fields
          .map((f) => normalizeIndexField(f))
          .filter((x): x is string => x != null);

        return {
          name: idx.name as string,
          columns: indexCols,
          unique: !!idx.unique,
          where: (idx as any).where ?? null,
          type: ((idx as any).type as string) || null,
          using: ((idx as any).using as string) || null,
        } as IndexSchema;
      }) ??
        []) ||
      [];

    const uniques: UniqueConstraintSchema[] = [];
    const uniqueColumnNames = new Set<string>();
    const uniqueNameToColumns = new Map<string, string[]>();

    columns.forEach((col) => {
      if (col.unique && !col.primaryKey) {
        const uniqueValue = (
          attrs[col.name] as { unique?: unknown } | undefined
        )?.unique;

        let uniqueName: string;
        if (typeof uniqueValue === "string") {
          uniqueName = uniqueValue;
          if (!uniqueNameToColumns.has(uniqueName)) {
            uniqueNameToColumns.set(uniqueName, []);
          }
          uniqueNameToColumns.get(uniqueName)!.push(col.name);
        } else {
          uniqueName = `${tableName}_${col.name}_unique`;
          uniques.push({
            name: uniqueName,
            columns: [col.name],
          });
          uniqueColumnNames.add(col.name);
        }
      }
    });

    uniqueNameToColumns.forEach((cols, name) => {
      uniques.push({
        name,
        columns: cols,
      });
      cols.forEach((col) => uniqueColumnNames.add(col));
    });

    const uniqueKeys = (
      m.options as {
        uniqueKeys?: Record<string, { fields: unknown[] }>;
      }
    )?.uniqueKeys;
    if (uniqueKeys) {
      Object.entries(uniqueKeys).forEach(([name, cfg]) => {
        const cfgFields = Array.isArray(cfg.fields)
          ? cfg.fields
              .map((f) => normalizeIndexField(f))
              .filter((x): x is string => x != null)
          : [];
        const isDuplicate = uniques.some(
          (u) =>
            u.name === name ||
            JSON.stringify([...u.columns].sort()) ===
              JSON.stringify([...cfgFields].sort()),
        );

        if (!isDuplicate) {
          uniques.push({ name, columns: cfgFields });
          cfgFields.forEach((field) => uniqueColumnNames.add(field));
        }
      });
    }

    rawIndexes.forEach((idx) => {
      if (idx.unique) {
        const isDuplicate = uniques.some(
          (u) =>
            u.name === idx.name ||
            JSON.stringify([...u.columns].sort()) ===
              JSON.stringify([...idx.columns].sort()),
        );

        if (!isDuplicate) {
          uniques.push({
            name: idx.name,
            columns: idx.columns,
          });
          idx.columns.forEach((col) => uniqueColumnNames.add(col));
        }
      }
    });

    uniqueColumnNames.forEach((colName) => {
      const col = columns.find((c) => c.name === colName);
      if (col) {
        col.unique = false;
      }
    });

    const indexes = rawIndexes.filter((idx) => {
      if (idx.unique) return false;
      return true;
    });

    const checks: CheckConstraintSchema[] = [];
    const validate = (m.options as { validate?: Record<string, unknown> })
      ?.validate;
    if (validate) {
      Object.entries(validate).forEach(([name, expr]) => {
        if (typeof expr === "string") {
          checks.push({ name, expression: expr });
        }
      });
    }

    const foreignKeys: ForeignKeySchema[] = [];

    for (const [colName, rawAttr] of Object.entries(attrs)) {
      const rattr = rawAttr as unknown as {
        references?: { model?: unknown; key?: string };
        onDelete?: string;
        onUpdate?: string;
      };
      if (!rattr.references?.model) continue;
      const RM = resolveRefModel(rattr.references.model, models);
      if (!RM) {
        warnings.push(
          `${tableSchema}.${tableName}: column "${colName}" references unknown model (check references.model / @ForeignKey)`,
        );
        continue;
      }
      const refTid = getModelTableId(RM);
      const refCol =
        rattr.references.key != null
          ? String(rattr.references.key)
          : String(RM.primaryKeyAttribute);
      foreignKeys.push({
        name: `${tableName}_${colName}_fkey`,
        columns: [colName],
        referencedTable: refTid.name,
        referencedSchema:
          refTid.schema === "public" ? undefined : refTid.schema,
        referencedColumns: [refCol],
        onDelete: (rattr.onDelete as string | undefined) ?? "CASCADE",
        onUpdate: (rattr.onUpdate as string | undefined) ?? "CASCADE",
      });
    }

    Object.values(m.associations).forEach((assoc) => {
      const a = assoc as unknown as {
        associationType?: string;
        foreignKey?: string;
        target?: ModelCtor<Model>;
        options?: {
          constraintName?: string;
          onDelete?: string;
          onUpdate?: string;
        };
      };
      if (a.associationType === "BelongsTo") {
        const fk = a.foreignKey;
        if (!fk) return;
        const col = columns.find((c) => c.name === fk);
        if (col) col.unique = false;

        if (!a.target) return;
        const refTid = getModelTableId(a.target);
        const pkAttr = a.target.primaryKeyAttribute;
        if (!pkAttr) return;

        const existing = foreignKeys.find(
          (f) => f.columns.length === 1 && f.columns[0] === fk,
        );
        if (existing) {
          if (a.options?.constraintName)
            existing.name = a.options.constraintName;
          if (a.options?.onDelete != null)
            existing.onDelete = a.options.onDelete;
          if (a.options?.onUpdate != null)
            existing.onUpdate = a.options.onUpdate;
          return;
        }

        foreignKeys.push({
          name: a.options?.constraintName ?? `${tableName}_${fk}_fkey`,
          columns: [fk],
          referencedTable: refTid.name,
          referencedSchema:
            refTid.schema === "public" ? undefined : refTid.schema,
          referencedColumns: [String(pkAttr)],
          onDelete: a.options?.onDelete ?? "CASCADE",
          onUpdate: a.options?.onUpdate ?? "CASCADE",
        });
      }
    });

    const isJoinTable = isManyToManyJoinTable(foreignKeys, indexes);

    if (isJoinTable) {
      const fkColumns = foreignKeys.flatMap((fk) => fk.columns);
      const mainFKs = fkColumns.slice(0, 2);

      const hasUniqueConstraint = uniques.some((u) => {
        const sortedU = [...u.columns].sort();
        const sortedFK = [...mainFKs].sort();
        return (
          sortedU.length === sortedFK.length &&
          sortedU.every((col, i) => col === sortedFK[i])
        );
      });

      if (!hasUniqueConstraint) {
        const constraintName = `${tableName}_${mainFKs.join("_")}_uq`;
        uniques.push({
          name: constraintName,
          columns: mainFKs,
        });
      }

      fkColumns.forEach((fkCol) => {
        const col = columns.find((c) => c.name === fkCol);
        if (col) col.unique = false;
      });
    }

    schema.tables.push({
      name: tableName,
      schema: tableSchema,
      tableComment: (m.options as { comment?: string | null })?.comment ?? null,
      columns,
      indexes,
      foreignKeys,
      uniques,
      checks,
      primaryKeys,
    });
  }

  return { schema, warnings };
}

export async function introspect(): Promise<DatabaseSchema> {
  return (await introspectModels()).schema;
}
