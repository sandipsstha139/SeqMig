import fs from "fs";
import path from "path";
import type {
  ColumnSchema,
  IndexSchema,
  MigrationAction,
  TableSchema,
} from "./schema-types";
import { getSnapshotPaths } from "./state";

function pgIdent(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}

/** Sequelize table descriptor: string (public) or { tableName, schema }. */
function qiTable(tableSchema: string | undefined, tableName: string): string {
  const s = (tableSchema ?? "").trim() || "public";
  if (s === "public") return JSON.stringify(tableName);
  return `{ tableName: ${JSON.stringify(tableName)}, schema: ${JSON.stringify(s)} }`;
}

function pgQualifiedType(enumTypeSql: string): string {
  if (!enumTypeSql.includes(".")) return pgIdent(enumTypeSql);
  const i = enumTypeSql.indexOf(".");
  const ns = enumTypeSql.slice(0, i);
  const rest = enumTypeSql.slice(i + 1);
  return `${pgIdent(ns)}.${pgIdent(rest)}`;
}

function fkRefOpts(fk: {
  referencedTable: string;
  referencedColumns: string[];
  referencedSchema?: string;
}): string {
  const rs = fk.referencedSchema?.trim() || "public";
  if (rs === "public") {
    return `references: { table: ${JSON.stringify(
      fk.referencedTable
    )}, field: ${JSON.stringify(fk.referencedColumns[0])} }`;
  }
  return `references: { table: ${JSON.stringify(
    fk.referencedTable
  )}, field: ${JSON.stringify(fk.referencedColumns[0])}, schema: ${JSON.stringify(
    rs
  )} }`;
}

function tableSqlIdent(tableSchema: string | undefined, tableName: string): string {
  const s = tableSchema?.trim() || "public";
  if (s === "public") return pgIdent(tableName);
  return `${pgIdent(s)}.${pgIdent(tableName)}`;
}

function commentIsClause(val: string | null): string {
  if (val == null) return "NULL";
  return `'${val.replace(/'/g, "''")}'`;
}

function mapType(dbType: string, enumValues?: string[]): string {
  const upper = dbType.toUpperCase();

  if (upper.includes("[]") || upper.includes("ARRAY")) {
    let innerType = "Sequelize.STRING";

    const bracketMatch = dbType.match(/^([A-Z]+)(?:\([^)]+\))?\[\]/i);
    const arrayMatch = dbType.match(/ARRAY\((.*?)\)/i);

    if (bracketMatch) {
      const baseType = bracketMatch[1]!.toUpperCase();
      if (baseType.includes("INT")) innerType = "Sequelize.INTEGER";
      else if (baseType.includes("BIGINT")) innerType = "Sequelize.BIGINT";
      else if (baseType.includes("TEXT")) innerType = "Sequelize.TEXT";
      else if (baseType.includes("BOOLEAN")) innerType = "Sequelize.BOOLEAN";
      else if (baseType.includes("DATE") || baseType.includes("TIMESTAMP"))
        innerType = "Sequelize.DATE";
      else if (baseType.includes("UUID")) innerType = "Sequelize.UUID";
      else if (baseType.includes("JSON")) innerType = "Sequelize.JSON";
      else if (baseType.includes("JSONB")) innerType = "Sequelize.JSONB";
      else if (baseType.includes("DECIMAL")) innerType = "Sequelize.DECIMAL";
      else if (baseType.includes("FLOAT") || baseType.includes("REAL"))
        innerType = "Sequelize.FLOAT";
      else innerType = "Sequelize.STRING";
    } else if (arrayMatch) {
      const baseType = arrayMatch[1]!.toUpperCase();
      if (baseType.includes("INT")) innerType = "Sequelize.INTEGER";
      else if (baseType.includes("BIGINT")) innerType = "Sequelize.BIGINT";
      else if (baseType.includes("TEXT")) innerType = "Sequelize.TEXT";
      else if (baseType.includes("BOOLEAN")) innerType = "Sequelize.BOOLEAN";
      else if (baseType.includes("DATE") || baseType.includes("TIMESTAMP"))
        innerType = "Sequelize.DATE";
      else if (baseType.includes("UUID")) innerType = "Sequelize.UUID";
      else if (baseType.includes("JSON")) innerType = "Sequelize.JSON";
      else if (baseType.includes("JSONB")) innerType = "Sequelize.JSONB";
      else if (baseType.includes("DECIMAL")) innerType = "Sequelize.DECIMAL";
      else if (baseType.includes("FLOAT") || baseType.includes("REAL"))
        innerType = "Sequelize.FLOAT";
      else innerType = "Sequelize.STRING";
    }

    return `Sequelize.ARRAY(${innerType})`;
  }

  if (upper.startsWith("ENUM") || upper.includes("ENUM(") || enumValues) {
    if (enumValues && enumValues.length > 0) {
      return `Sequelize.ENUM(${enumValues
        .map((v) => `"${String(v).replace(/"/g, '\\"')}"`)
        .join(", ")})`;
    }
    const startIdx = dbType.indexOf("(");
    const endIdx = dbType.lastIndexOf(")");
    if (startIdx !== -1 && endIdx !== -1) {
      const inner = dbType.slice(startIdx + 1, endIdx);
      const values = inner
        .split(",")
        .map((v) => v.trim().replace(/^["']+|["']+$/g, ""));
      return `Sequelize.ENUM(${values
        .map((v) => `"${String(v).replace(/"/g, '\\"')}"`)
        .join(", ")})`;
    }
  }

  const varchar = dbType.match(/VARCHAR\s*\(\s*(\d+)\s*\)/i);
  if (varchar) return `Sequelize.STRING(${varchar[1]})`;

  const char = dbType.match(/CHAR\s*\(\s*(\d+)\s*\)/i);
  if (char) return `Sequelize.CHAR(${char[1]})`;

  const dec = dbType.match(/DECIMAL\s*\(\s*(\d+)\s*,\s*(\d+)\s*\)/i);
  if (dec) return `Sequelize.DECIMAL(${dec[1]}, ${dec[2]})`;

  const decP = dbType.match(/DECIMAL\s*\(\s*(\d+)\s*\)/i);
  if (decP) return `Sequelize.DECIMAL(${decP[1]}, 0)`;

  if (upper.includes("TIMESTAMP") || upper.includes("DATE"))
    return "Sequelize.DATE";
  if (upper.includes("UUID")) return "Sequelize.UUID";
  if (upper.includes("BIGINT")) return "Sequelize.BIGINT";
  if (upper.includes("SMALLINT")) return "Sequelize.SMALLINT";
  if (upper.includes("INT")) return "Sequelize.INTEGER";
  if (upper.includes("TEXT")) return "Sequelize.TEXT";
  if (upper.includes("DOUBLE") || upper.includes("DOUBLE PRECISION"))
    return "Sequelize.DOUBLE";
  if (upper.includes("CHAR") || upper.includes("STRING"))
    return "Sequelize.STRING";
  if (upper.includes("BOOLEAN")) return "Sequelize.BOOLEAN";
  if (upper.includes("JSONB")) return "Sequelize.JSONB";
  if (upper.includes("JSON")) return "Sequelize.JSON";
  if (upper.includes("DECIMAL") || upper.includes("NUMERIC"))
    return "Sequelize.DECIMAL";
  if (upper.includes("FLOAT") || upper.includes("REAL"))
    return "Sequelize.FLOAT";

  return "Sequelize.STRING";
}

function col(c: ColumnSchema): string {
  const parts: string[] = [];

  parts.push(`type: ${mapType(c.dbType, c.enumValues)}`);
  parts.push(`allowNull: ${c.allowNull}`);
  parts.push(`primaryKey: ${c.primaryKey}`);
  parts.push(`unique: ${c.unique}`);
  if (c.autoIncrement) {
    parts.push(`autoIncrement: true`);
  }

  if (Object.prototype.hasOwnProperty.call(c, "defaultValue")) {
    let defaultValue = "null";

    if (c.defaultValue === "NOW") {
      defaultValue = 'Sequelize.fn("NOW")';
    } else if (c.defaultValue === "UUID_FUNCTION") {
      defaultValue = 'Sequelize.fn("gen_random_uuid")';
    } else if (c.defaultValue !== null && c.defaultValue !== undefined) {
      const defaultStr = String(c.defaultValue);

      if (
        typeof c.defaultValue === "function" ||
        defaultStr === "[Function]" ||
        defaultStr.includes("function")
      ) {
        if (
          c.name === "id" &&
          (c.type === "UUID" || c.dbType?.includes("UUID"))
        ) {
          defaultValue = 'Sequelize.fn("gen_random_uuid")';
        } else {
          defaultValue = "Sequelize.UUIDV4";
        }
      } else if (Array.isArray(c.defaultValue)) {
        defaultValue = JSON.stringify(c.defaultValue);
      } else {
        defaultValue = JSON.stringify(c.defaultValue);
      }
    } else if (
      c.name === "id" &&
      c.primaryKey &&
      (c.type === "UUID" || c.dbType?.includes("UUID"))
    ) {
      defaultValue = 'Sequelize.fn("gen_random_uuid")';
    }

    parts.push(`defaultValue: ${defaultValue}`);
  }

  return `{
    ${parts.join(",\n    ")}
  }`;
}

function indexOptionsCode(idx: IndexSchema, txVar: string): string {
  const parts = [
    `name: ${JSON.stringify(idx.name)}`,
    `unique: ${!!idx.unique}`,
    `transaction: ${txVar}`,
  ];
  if (idx.where != null) parts.push(`where: ${JSON.stringify(idx.where)}`);
  if (idx.type) parts.push(`type: ${JSON.stringify(idx.type)}`);
  if (idx.using) parts.push(`using: ${JSON.stringify(idx.using)}`);
  return `{ ${parts.join(", ")} }`;
}

function emitCreateTable(
  table: TableSchema,
  t: string
): { up: string[]; down: string[] } {
  const up: string[] = [];
  const down: string[] = [];

  const columns = table.columns
    .map((c) => `"${c.name}": ${col(c)}`)
    .join(",\n      ");

  const tbl = qiTable(table.schema, table.name);
  up.push(`await queryInterface.createTable(${tbl}, {
      ${columns}
    }, { transaction: ${t} });`);

  table.foreignKeys.forEach((fk) => {
    if (fk.columns.length === 1 && fk.referencedColumns.length === 1) {
      up.push(`await queryInterface.addConstraint(${tbl}, {
        type: "foreign key",
        fields: ["${fk.columns[0]}"],
        name: "${fk.name}",
        ${fkRefOpts(fk)},
        onDelete: ${fk.onDelete ? `"${fk.onDelete}"` : "null"},
        onUpdate: ${fk.onUpdate ? `"${fk.onUpdate}"` : "null"},
        transaction: ${t}
      });`);
    } else {
      const tblIdent = tableSqlIdent(table.schema, table.name);
      const refIdent = tableSqlIdent(fk.referencedSchema, fk.referencedTable);
      const colsSql = fk.columns.map((c) => pgIdent(c)).join(", ");
      const refColsSql = fk.referencedColumns.map((c) => pgIdent(c)).join(", ");
      const onDel = fk.onDelete ? ` ON DELETE "${fk.onDelete}"` : "";
      const onUpd = fk.onUpdate ? ` ON UPDATE "${fk.onUpdate}"` : "";
      up.push(
        `await queryInterface.sequelize.query(\`ALTER TABLE ${tblIdent} ADD CONSTRAINT ${pgIdent(
          fk.name
        )} FOREIGN KEY (${colsSql}) REFERENCES ${refIdent} (${refColsSql})${onDel}${onUpd}\`, { transaction: ${t} });`
      );
    }
    down.unshift(
      `await queryInterface.removeConstraint(${tbl}, "${fk.name}", { transaction: ${t} });`
    );
  });

  table.uniques.forEach((u) => {
    up.push(`await queryInterface.addConstraint(${tbl}, {
      type: "unique",
      name: "${u.name}",
      fields: ${JSON.stringify(u.columns)},
      transaction: ${t}
    });`);
    down.unshift(
      `await queryInterface.removeConstraint(${tbl}, "${u.name}", { transaction: ${t} });`
    );
  });

  table.indexes.forEach((idx) => {
    if (!idx.unique) {
      up.push(
        `await queryInterface.addIndex(${tbl}, ${JSON.stringify(idx.columns)}, ${indexOptionsCode(idx, t)});`
      );
      down.unshift(
        `await queryInterface.removeIndex(${tbl}, "${idx.name}", { transaction: ${t} });`
      );
    }
  });

  table.checks.forEach((ch) => {
    const expr = String(ch.expression).replace(/`/g, "\\`");
    const tSch = table.schema?.trim() || "public";
    const tblSql =
      tSch === "public"
        ? pgIdent(table.name)
        : `${pgIdent(tSch)}.${pgIdent(table.name)}`;
    up.push(
      `await queryInterface.sequelize.query(\`ALTER TABLE ${tblSql} ADD CONSTRAINT ${pgIdent(ch.name)} CHECK (${expr})\`, { transaction: ${t} });`
    );
    down.unshift(
      `await queryInterface.removeConstraint(${tbl}, "${ch.name}", { transaction: ${t} });`
    );
  });

  down.push(`await queryInterface.dropTable(${tbl}, { transaction: ${t} });`);

  return { up, down };
}

function defaultPkConstraintName(tableName: string): string {
  return `${tableName}_pkey`;
}

/** Safe segment after the timestamp: kebab-case, no path chars. */
export function sanitizeMigrationName(raw: string): string {
  const s = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s.length > 0 ? s.slice(0, 120) : "auto-migration";
}

export type GenerateOptions = {
  /** Suffix between timestamp and `.cjs` (default: `auto-migration`). */
  name?: string;
};

const EMPTY_MIGRATION_BOILERPLATE = `
"use strict";
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      // Add migration steps here. Pass { transaction } to queryInterface / query calls.
      // Example:
      // await queryInterface.addColumn("my_table", "my_column", {
      //   type: Sequelize.STRING,
      //   allowNull: true,
      // }, { transaction });
      // await queryInterface.sequelize.query(\`YOUR SQL\`, { transaction });

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },
  async down(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      // Reverse the changes from up(), using the same transaction.

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },
};
`;

/** Write a timestamped empty migration for hand-written custom changes. Does not update the schema snapshot. */
export function scaffoldEmptyMigrationFile(options?: GenerateOptions): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const slug = options?.name ? sanitizeMigrationName(options.name) : "custom-migration";
  const filename = `${ts}-${slug}.cjs`;
  const { migrationDir } = getSnapshotPaths();
  const dir = migrationDir;
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, filename);
  fs.writeFileSync(file, EMPTY_MIGRATION_BOILERPLATE.trimStart() + "\n");
  return file;
}

export function generate(
  actions: MigrationAction[],
  options?: GenerateOptions
): string | null {
  if (!actions.length) return null;

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const slug = options?.name ? sanitizeMigrationName(options.name) : "auto-migration";
  const filename = `${ts}-${slug}.cjs`;
  const { migrationDir } = getSnapshotPaths();
  const dir = migrationDir;
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const t = "transaction";

  const createTables: string[] = [];
  const dropConstraintsFromCreate: string[] = [];
  const dropTablesFromCreate: string[] = [];

  const otherUp: string[] = [];
  const otherDown: string[] = [];

  const processedEnumTypes = new Set<string>();
  const resolveEnumRawType = (a: any): string => {
    return (
      a.pgEnumTypeName ||
      a.after?.enumTypeName ||
      a.before?.enumTypeName ||
      `enum_${a.tableName}_${a.columnName}`
    );
  };
  const resolveEnumTypeParts = (raw: string): { schema: string; typeName: string } => {
    const i = raw.indexOf(".");
    if (i === -1) return { schema: "public", typeName: raw };
    return { schema: raw.slice(0, i), typeName: raw.slice(i + 1) };
  };

  actions.forEach((a) => {
    if (a.kind === "createTable") {
      const block = emitCreateTable(a.table, t);
      createTables.push(...block.up);
      dropConstraintsFromCreate.unshift(...block.down.slice(0, -1));
      dropTablesFromCreate.unshift(block.down[block.down.length - 1]!);
    }

    if (a.kind === "renameTable") {
      const fromTbl = tableSqlIdent(a.fromSchema, a.fromName);
      const toTbl = tableSqlIdent(a.fromSchema, a.toName);

      otherUp.push(
        `await queryInterface.sequelize.query(\`ALTER TABLE ${fromTbl} RENAME TO ${pgIdent(a.toName)}\`, { transaction: ${t} });`
      );

      if (a.fromSchema !== a.toSchema) {
        otherUp.push(
          `await queryInterface.sequelize.query(\`ALTER TABLE ${toTbl} SET SCHEMA ${pgIdent(
            a.toSchema
          )}\`, { transaction: ${t} });`
        );
      }

      const downFromTbl =
        a.fromSchema === a.toSchema
          ? tableSqlIdent(a.fromSchema, a.toName)
          : tableSqlIdent(a.toSchema, a.toName);

      if (a.fromSchema !== a.toSchema) {
        otherDown.unshift(
          `await queryInterface.sequelize.query(\`ALTER TABLE ${downFromTbl} SET SCHEMA ${pgIdent(
            a.fromSchema
          )}\`, { transaction: ${t} });`
        );
      }

      otherDown.unshift(
        `await queryInterface.sequelize.query(\`ALTER TABLE ${tableSqlIdent(
          a.fromSchema,
          a.toName
        )} RENAME TO ${pgIdent(a.fromName)}\`, { transaction: ${t} });`
      );
    }

    if (a.kind === "dropTable") {
      const tbl = qiTable(a.backup.schema, a.backup.name);
      otherUp.push(`await queryInterface.dropTable(${tbl}, { transaction: ${t} });`);
      const rec = emitCreateTable(a.backup, t);
      otherDown.splice(0, 0, ...rec.up);
    }

    if (a.kind === "addColumn") {
      const tbl = qiTable(a.tableSchema, a.tableName);
      otherUp.push(
        `await queryInterface.addColumn(${tbl}, "${a.column.name}", ${col(a.column)}, { transaction: ${t} });`
      );
      otherDown.unshift(
        `await queryInterface.removeColumn(${tbl}, "${a.column.name}", { transaction: ${t} });`
      );
    }

    if (a.kind === "dropColumn") {
      const tbl = qiTable(a.tableSchema, a.tableName);
      otherUp.push(
        `await queryInterface.removeColumn(${tbl}, "${a.columnName}", { transaction: ${t} });`
      );
      otherDown.unshift(
        `await queryInterface.addColumn(${tbl}, "${a.backup.name}", ${col(a.backup)}, { transaction: ${t} });`
      );
    }

    if (a.kind === "renameColumn") {
      const tbl = qiTable(a.tableSchema, a.tableName);
      otherUp.push(
        `await queryInterface.renameColumn(${tbl}, "${a.oldName}", "${a.newName}", { transaction: ${t} });`
      );
      otherDown.unshift(
        `await queryInterface.renameColumn(${tbl}, "${a.newName}", "${a.oldName}", { transaction: ${t} });`
      );
    }

    if (a.kind === "alterColumn") {
      const tbl = qiTable(a.tableSchema, a.tableName);
      otherUp.push(
        `await queryInterface.changeColumn(${tbl}, "${a.after.name}", ${col(a.after)}, { transaction: ${t} });`
      );
      otherDown.unshift(
        `await queryInterface.changeColumn(${tbl}, "${a.before.name}", ${col(a.before)}, { transaction: ${t} });`
      );
    }

    if (a.kind === "alterEnum") {
      const rawType = resolveEnumRawType(a);
      if (processedEnumTypes.has(rawType)) return;
      processedEnumTypes.add(rawType);

      const group = actions.filter(
        (x): x is Extract<MigrationAction, { kind: "alterEnum" }> =>
          x.kind === "alterEnum" && resolveEnumRawType(x as any) === rawType
      );

      const beforeEnums = a.before.enumValues || [];
      const afterEnums = a.after.enumValues || [];

      const removedEnums = beforeEnums.filter((v) => !afterEnums.includes(v));
      const retainedInOrder = afterEnums.filter((v) => beforeEnums.includes(v));
      const isSameOrder =
        retainedInOrder.length === beforeEnums.length &&
        retainedInOrder.every((v, i) => v === beforeEnums[i]);

      const { schema: enumSchema, typeName: enumTypeName } = resolveEnumTypeParts(rawType);

      const oldEnumIdent = `${pgIdent(enumSchema)}.${pgIdent(enumTypeName)}`;
      const tempEnumName = `${enumTypeName}_tmp_${ts.replace(/[^a-zA-Z0-9_]/g, "_")}`;
      const tempEnumIdent = `${pgIdent(enumSchema)}.${pgIdent(tempEnumName)}`;
      const enumValueSql = (vals: string[]) =>
        vals
          .map((v) => `'${String(v).replace(/'/g, "''")}'`)
          .join(", ");

      const enumDefaultExpr = (
        defaultValue: unknown,
        castToEnumIdent: string
      ): string | null => {
        if (defaultValue == null) return null;
        if (typeof defaultValue !== "string") return null;
        const escaped = String(defaultValue).replace(/'/g, "''");
        return `CAST('${escaped}' AS ${castToEnumIdent})`;
      };

      if (removedEnums.length === 0 && isSameOrder) {
        const addedEnums = afterEnums.filter((v) => !beforeEnums.includes(v));
        if (addedEnums.length) {
          const sql = addedEnums
            .map((v) => {
              const escaped = String(v).replace(/'/g, "''");
              return `ALTER TYPE ${oldEnumIdent} ADD VALUE IF NOT EXISTS '${escaped}';`;
            })
            .join(" ");
          otherUp.push(
            `await queryInterface.sequelize.query(\`${sql.replace(/`/g, "\\`")}\`, { transaction: ${t} });`
          );
          const downSqlParts: string[] = [];
          downSqlParts.push(`CREATE TYPE ${tempEnumIdent} AS ENUM (${enumValueSql(beforeEnums)});`);
          for (const g of group) {
            const tbl = tableSqlIdent(g.tableSchema, g.tableName);
            downSqlParts.push(
              `ALTER TABLE ${tbl} ALTER COLUMN ${pgIdent(
                g.columnName
              )} DROP DEFAULT;`
            );
            downSqlParts.push(
              `ALTER TABLE ${tbl} ALTER COLUMN ${pgIdent(
                g.columnName
              )} TYPE ${tempEnumIdent} USING ${pgIdent(
                g.columnName
              )}::text::${tempEnumIdent};`
            );
            const defExpr = enumDefaultExpr(g.before.defaultValue, tempEnumIdent);
            if (defExpr) {
              downSqlParts.push(
                `ALTER TABLE ${tbl} ALTER COLUMN ${pgIdent(
                  g.columnName
                )} SET DEFAULT ${defExpr};`
              );
            }
          }
          downSqlParts.push(`DROP TYPE ${oldEnumIdent};`);
          downSqlParts.push(`ALTER TYPE ${tempEnumIdent} RENAME TO ${pgIdent(enumTypeName)};`);
          otherDown.unshift(
            `await queryInterface.sequelize.query(\`${downSqlParts.join(" ").replace(/`/g, "\\`")}\`, { transaction: ${t} });`
          );
        }
      } else {
        const upParts: string[] = [];
        upParts.push(`CREATE TYPE ${tempEnumIdent} AS ENUM (${enumValueSql(afterEnums)});`);
        for (const g of group) {
          const tbl = tableSqlIdent(g.tableSchema, g.tableName);
          upParts.push(
            `ALTER TABLE ${tbl} ALTER COLUMN ${pgIdent(g.columnName)} DROP DEFAULT;`
          );
          upParts.push(
            `ALTER TABLE ${tbl} ALTER COLUMN ${pgIdent(
              g.columnName
            )} TYPE ${tempEnumIdent} USING ${pgIdent(g.columnName)}::text::${tempEnumIdent};`
          );
          const defExpr = enumDefaultExpr(g.after.defaultValue, tempEnumIdent);
          if (defExpr) {
            upParts.push(
              `ALTER TABLE ${tbl} ALTER COLUMN ${pgIdent(g.columnName)} SET DEFAULT ${defExpr};`
            );
          }
        }
        upParts.push(`DROP TYPE ${oldEnumIdent};`);
        upParts.push(`ALTER TYPE ${tempEnumIdent} RENAME TO ${pgIdent(enumTypeName)};`);
        otherUp.push(
          `await queryInterface.sequelize.query(\`${upParts.join(" ").replace(/`/g, "\\`")}\`, { transaction: ${t} });`
        );

        const downParts: string[] = [];
        downParts.push(`CREATE TYPE ${tempEnumIdent} AS ENUM (${enumValueSql(beforeEnums)});`);
        for (const g of group) {
          const tbl = tableSqlIdent(g.tableSchema, g.tableName);
          downParts.push(
            `ALTER TABLE ${tbl} ALTER COLUMN ${pgIdent(g.columnName)} DROP DEFAULT;`
          );
          downParts.push(
            `ALTER TABLE ${tbl} ALTER COLUMN ${pgIdent(
              g.columnName
            )} TYPE ${tempEnumIdent} USING ${pgIdent(g.columnName)}::text::${tempEnumIdent};`
          );
          const defExpr = enumDefaultExpr(g.before.defaultValue, tempEnumIdent);
          if (defExpr) {
            downParts.push(
              `ALTER TABLE ${tbl} ALTER COLUMN ${pgIdent(g.columnName)} SET DEFAULT ${defExpr};`
            );
          }
        }
        downParts.push(`DROP TYPE ${oldEnumIdent};`);
        downParts.push(`ALTER TYPE ${tempEnumIdent} RENAME TO ${pgIdent(enumTypeName)};`);
        otherDown.unshift(
          `await queryInterface.sequelize.query(\`${downParts.join(" ").replace(/`/g, "\\`")}\`, { transaction: ${t} });`
        );
      }
    }

    if (a.kind === "setColumnComment") {
      const tblRef = tableSqlIdent(a.tableSchema, a.tableName);
      otherUp.push(
        `await queryInterface.sequelize.query(\`COMMENT ON COLUMN ${tblRef}.${pgIdent(a.columnName)} IS ${commentIsClause(a.comment)}\`, { transaction: ${t} });`
      );
      otherDown.unshift(
        `await queryInterface.sequelize.query(\`COMMENT ON COLUMN ${tblRef}.${pgIdent(a.columnName)} IS ${commentIsClause(a.previous)}\`, { transaction: ${t} });`
      );
    }

    if (a.kind === "setTableComment") {
      const tblRef = tableSqlIdent(a.tableSchema, a.tableName);
      otherUp.push(
        `await queryInterface.sequelize.query(\`COMMENT ON TABLE ${tblRef} IS ${commentIsClause(a.comment)}\`, { transaction: ${t} });`
      );
      otherDown.unshift(
        `await queryInterface.sequelize.query(\`COMMENT ON TABLE ${tblRef} IS ${commentIsClause(a.previous)}\`, { transaction: ${t} });`
      );
    }

    if (a.kind === "createIndex") {
      const tbl = qiTable(a.tableSchema, a.tableName);
      otherUp.push(
        `await queryInterface.addIndex(${tbl}, ${JSON.stringify(a.index.columns)}, ${indexOptionsCode(a.index, t)});`
      );
    }

    if (a.kind === "dropIndex") {
      const tbl = qiTable(a.tableSchema, a.tableName);
      otherUp.push(
        `await queryInterface.removeIndex(${tbl}, "${a.indexName}", { transaction: ${t} });`
      );
      otherDown.unshift(
        `await queryInterface.addIndex(${tbl}, ${JSON.stringify(a.backup.columns)}, ${indexOptionsCode(a.backup, t)});`
      );
    }

    if (a.kind === "addFK") {
      const tbl = qiTable(a.tableSchema, a.tableName);
      if (a.fk.columns.length === 1 && a.fk.referencedColumns.length === 1) {
        otherUp.push(`await queryInterface.addConstraint(${tbl}, {
  type: "foreign key",
  fields: ["${a.fk.columns[0]}"],
  name: "${a.fk.name}",
  ${fkRefOpts(a.fk)},
  onDelete: ${a.fk.onDelete ? `"${a.fk.onDelete}"` : "null"},
  onUpdate: ${a.fk.onUpdate ? `"${a.fk.onUpdate}"` : "null"},
  transaction: ${t}
});`);
      } else {
        const tblIdent = tableSqlIdent(a.tableSchema, a.tableName);
        const refIdent = tableSqlIdent(a.fk.referencedSchema, a.fk.referencedTable);
        const colsSql = a.fk.columns.map((c) => pgIdent(c)).join(", ");
        const refColsSql = a.fk.referencedColumns.map((c) => pgIdent(c)).join(", ");
        const onDel = a.fk.onDelete ? ` ON DELETE "${a.fk.onDelete}"` : "";
        const onUpd = a.fk.onUpdate ? ` ON UPDATE "${a.fk.onUpdate}"` : "";
        otherUp.push(
          `await queryInterface.sequelize.query(\`ALTER TABLE ${tblIdent} ADD CONSTRAINT ${pgIdent(
            a.fk.name
          )} FOREIGN KEY (${colsSql}) REFERENCES ${refIdent} (${refColsSql})${onDel}${onUpd}\`, { transaction: ${t} });`
        );
      }
      otherDown.unshift(
        `await queryInterface.removeConstraint(${tbl}, "${a.fk.name}", { transaction: ${t} });`
      );
    }

    if (a.kind === "dropFK") {
      const tbl = qiTable(a.tableSchema, a.tableName);
      otherUp.push(
        `await queryInterface.removeConstraint(${tbl}, "${a.fkName}", { transaction: ${t} });`
      );

      if (a.backup.columns.length === 1 && a.backup.referencedColumns.length === 1) {
        otherDown.unshift(`await queryInterface.addConstraint(${tbl}, {
  type: "foreign key",
  fields: ["${a.backup.columns[0]}"],
  name: "${a.backup.name}",
  ${fkRefOpts(a.backup)},
  onDelete: ${a.backup.onDelete ? `"${a.backup.onDelete}"` : "null"},
  onUpdate: ${a.backup.onUpdate ? `"${a.backup.onUpdate}"` : "null"},
  transaction: ${t}
});`);
      } else {
        const tblIdent = tableSqlIdent(a.tableSchema, a.tableName);
        const refIdent = tableSqlIdent(a.backup.referencedSchema, a.backup.referencedTable);
        const colsSql = a.backup.columns.map((c) => pgIdent(c)).join(", ");
        const refColsSql = a.backup.referencedColumns.map((c) => pgIdent(c)).join(", ");
        const onDel = a.backup.onDelete ? ` ON DELETE "${a.backup.onDelete}"` : "";
        const onUpd = a.backup.onUpdate ? ` ON UPDATE "${a.backup.onUpdate}"` : "";
        otherDown.unshift(
          `await queryInterface.sequelize.query(\`ALTER TABLE ${tblIdent} ADD CONSTRAINT ${pgIdent(
            a.backup.name
          )} FOREIGN KEY (${colsSql}) REFERENCES ${refIdent} (${refColsSql})${onDel}${onUpd}\`, { transaction: ${t} });`
        );
      }
    }

    if (a.kind === "addUnique") {
      const tbl = qiTable(a.tableSchema, a.tableName);
      otherUp.push(`await queryInterface.addConstraint(${tbl}, {
  type: "unique",
  name: "${a.unique.name}",
  fields: ${JSON.stringify(a.unique.columns)},
  transaction: ${t}
});`);
      otherDown.unshift(
        `await queryInterface.removeConstraint(${tbl}, "${a.unique.name}", { transaction: ${t} });`
      );
    }

    if (a.kind === "dropUnique") {
      const tbl = qiTable(a.tableSchema, a.tableName);
      otherUp.push(
        `await queryInterface.removeConstraint(${tbl}, "${a.uniqueName}", { transaction: ${t} });`
      );
      otherDown.unshift(`await queryInterface.addConstraint(${tbl}, {
  type: "unique",
  name: "${a.backup.name}",
  fields: ${JSON.stringify(a.backup.columns)},
  transaction: ${t}
});`);
    }

    if (a.kind === "addCheck") {
      const tblSql = tableSqlIdent(a.tableSchema, a.tableName);
      const expr = String(a.check.expression).replace(/`/g, "\\`");
      otherUp.push(
        `await queryInterface.sequelize.query(\`ALTER TABLE ${tblSql} ADD CONSTRAINT ${pgIdent(a.check.name)} CHECK (${expr})\`, { transaction: ${t} });`
      );
      const tbl = qiTable(a.tableSchema, a.tableName);
      otherDown.unshift(
        `await queryInterface.removeConstraint(${tbl}, "${a.check.name}", { transaction: ${t} });`
      );
    }

    if (a.kind === "dropCheck") {
      const tbl = qiTable(a.tableSchema, a.tableName);
      otherUp.push(
        `await queryInterface.removeConstraint(${tbl}, "${a.checkName}", { transaction: ${t} });`
      );
      const tblSql = tableSqlIdent(a.tableSchema, a.tableName);
      const ex = String(a.backup.expression).replace(/`/g, "\\`");
      otherDown.unshift(
        `await queryInterface.sequelize.query(\`ALTER TABLE ${tblSql} ADD CONSTRAINT ${pgIdent(a.backup.name)} CHECK (${ex})\`, { transaction: ${t} });`
      );
    }

    if (a.kind === "changePrimaryKey") {
      const tbl = qiTable(a.tableSchema, a.tableName);
      const cname =
        a.constraintName ?? defaultPkConstraintName(a.tableName);
      otherUp.push(
        `await queryInterface.removeConstraint(${tbl}, "${cname}", { transaction: ${t} });`
      );
      otherUp.push(`await queryInterface.addConstraint(${tbl}, {
  type: "primary key",
  name: "${cname}",
  fields: ${JSON.stringify(a.after)},
  transaction: ${t}
});`);
      otherDown.unshift(`await queryInterface.addConstraint(${tbl}, {
  type: "primary key",
  name: "${cname}",
  fields: ${JSON.stringify(a.before)},
  transaction: ${t}
});`);
      otherDown.unshift(
        `await queryInterface.removeConstraint(${tbl}, "${cname}", { transaction: ${t} });`
      );
    }
  });

  const up = [...createTables, ...otherUp].filter(Boolean);

  const down = [
    ...dropConstraintsFromCreate,
    ...dropTablesFromCreate,
    ...otherDown,
  ].filter(Boolean);

  const content = `
"use strict";
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      ${up.length ? up.join("\n      ") : "// no-op"}
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },
  async down(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      ${down.length ? down.join("\n      ") : "// no-op"}
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },
};
`;

  const file = path.join(dir, filename);
  fs.writeFileSync(file, content);
  return file;
}

