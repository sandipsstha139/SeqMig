import {
  columnStructureEqual,
  columnsEqual,
  findMatchingPrevFk,
  foreignKeysEqual,
  indexesEqual,
  primaryKeysEqual,
} from "./compare";
import { orderCreateTableActions } from "./order-create-tables";
import { parseQual, tableQual } from "./qualified";
import {
  columnRenameMap,
  loadRenameMap,
  tableRenameQualMap,
} from "./rename-map";
import type {
  DatabaseSchema,
  IndexSchema,
  MigrationAction,
  TableSchema,
  UniqueConstraintSchema,
} from "./schema-types";
import type { RenameMapFile } from "./rename-map";

export type { RenameMapFile } from "./rename-map";

function allowRenameHeuristic(): boolean {
  return process.env.MIGRATION_ALLOW_RENAME_HEURISTIC === "1";
}

function columnSimilarity(a: string, b: string): number {
  const normalize = (s: string) => s.toLowerCase().replace(/[_-]/g, "");
  const na = normalize(a);
  const nb = normalize(b);
  if (na === nb) return 1;
  const longer = na.length > nb.length ? na : nb;
  const shorter = na.length > nb.length ? nb : na;
  if (longer.includes(shorter)) return 0.8;
  let matches = 0;
  for (let i = 0; i < shorter.length; i++) {
    if (longer.includes(shorter[i]!)) matches++;
  }
  return matches / longer.length;
}

function detectRenames(
  beforeCols: { name: string }[],
  afterCols: { name: string }[],
  getName: (x: { name: string }) => string,
  explicit: Map<string, string>
): Map<string, string> {
  const renames = new Map<string, string>();
  explicit.forEach((to, from) => renames.set(from, to));
  if (!allowRenameHeuristic()) return renames;

  const droppedCols = beforeCols.filter(
    (b) => !afterCols.find((a) => getName(a) === getName(b))
  );
  const addedCols = afterCols.filter(
    (a) => !beforeCols.find((b) => getName(b) === getName(a))
  );

  for (const dropped of droppedCols) {
    if (renames.has(getName(dropped))) continue;
    let bestMatch: (typeof droppedCols)[0] | null = null;
    let bestScore = 0.92;
    for (const added of addedCols) {
      if (renames.has(getName(added))) continue;
      const score = columnSimilarity(getName(dropped), getName(added));
      if (score > bestScore) {
        bestScore = score;
        bestMatch = added;
      }
    }
    if (bestMatch) {
      renames.set(getName(dropped), getName(bestMatch));
    }
  }
  return renames;
}

function getUniqueColumns(uniques: { columns: string[] }[]): Set<string> {
  const uniqueCols = new Set<string>();
  uniques.forEach((u) => {
    if (u.columns.length === 1) {
      uniqueCols.add(u.columns[0]!);
    }
  });
  return uniqueCols;
}

function filterRedundantIndexes(
  indexes: IndexSchema[],
  uniques: UniqueConstraintSchema[]
): IndexSchema[] {
  const uniqueCols = getUniqueColumns(uniques);
  return indexes.filter((idx) => {
    if (idx.unique) return false;
    if (idx.columns.length === 1 && uniqueCols.has(idx.columns[0]!)) {
      return false;
    }
    return true;
  });
}

function sortByDependencies(actions: MigrationAction[]): MigrationAction[] {
  const createTables = actions.filter((a) => a.kind === "createTable");
  const renameTables = actions.filter((a) => a.kind === "renameTable");
  const dropFKs = actions.filter((a) => a.kind === "dropFK");
  const addFKs = actions.filter((a) => a.kind === "addFK");
  const dropTables = actions.filter((a) => a.kind === "dropTable");
  const rest = actions.filter(
    (a) =>
      a.kind !== "createTable" &&
      a.kind !== "renameTable" &&
      a.kind !== "dropFK" &&
      a.kind !== "addFK" &&
      a.kind !== "dropTable"
  );
  return [
    ...dropFKs,
    ...renameTables,
    ...createTables,
    ...rest,
    ...addFKs,
    ...dropTables,
  ];
}

function findPrevTable(
  beforeTables: TableSchema[],
  afterTable: TableSchema,
  renameToFrom: Map<string, string>
): TableSchema | undefined {
  const q = tableQual(afterTable);
  const direct = beforeTables.find((t) => tableQual(t) === q);
  if (direct) return direct;
  const fromQ = renameToFrom.get(q);
  if (fromQ) {
    return beforeTables.find((t) => tableQual(t) === fromQ);
  }
  return undefined;
}

function tableSurvivesRename(
  beforeTable: TableSchema,
  afterTables: TableSchema[],
  renameForward: Map<string, string>
): boolean {
  const q = tableQual(beforeTable);
  if (afterTables.some((t) => tableQual(t) === q)) return true;
  const toQ = renameForward.get(q);
  if (toQ && afterTables.some((t) => tableQual(t) === toQ)) return true;
  return false;
}

export type DiffResult = {
  actions: MigrationAction[];
  /** Cross-schema table renames, composite FK skipped, etc. */
  warnings: string[];
};

export function diff(
  before: DatabaseSchema,
  after: DatabaseSchema,
  renameMapArg?: RenameMapFile
): DiffResult {
  const warnings: string[] = [];
  const renameMap = renameMapArg ?? loadRenameMap();
  const forward = tableRenameQualMap(renameMap);
  const renameToFrom = new Map<string, string>();

  for (const [fromQ, toQ] of forward) {
    const fp = parseQual(fromQ);
    const tp = parseQual(toQ);
    if (fromQ !== toQ) renameToFrom.set(toQ, fromQ);
  }

  const out: MigrationAction[] = [];
  const colRenamesExplicitGlobal = columnRenameMap(renameMap);

  for (const [fromQ, toQ] of forward) {
    if (fromQ === toQ) continue;
    const fp = parseQual(fromQ);
    const tp = parseQual(toQ);
    const bt = before.tables.find((t) => tableQual(t) === fromQ);
    const at = after.tables.find((t) => tableQual(t) === toQ);
    if (bt && at) {
      out.push({
        kind: "renameTable",
        fromSchema: fp.schema,
        fromName: fp.name,
        toSchema: tp.schema,
        toName: tp.name,
      });
    }
  }

  for (const at of after.tables) {
    const prev = findPrevTable(before.tables, at, renameToFrom);
    if (!prev) {
      out.push({ kind: "createTable", table: at });
    }
  }

  for (const bt of before.tables) {
    if (!tableSurvivesRename(bt, after.tables, forward)) {
      out.push({
        kind: "dropTable",
        tableName: bt.name,
        tableSchema: bt.schema,
        backup: bt,
      });
    }
  }

  for (const t of after.tables) {
    const prev = findPrevTable(before.tables, t, renameToFrom);
    if (!prev) continue;

    const explicitCols = new Map<string, string>();
    const tsch = t.schema ?? "public";
    for (const [k, v] of colRenamesExplicitGlobal) {
      const pipe = k.indexOf("|");
      if (pipe === -1) continue;
      const qt = k.slice(0, pipe);
      const fromName = k.slice(pipe + 1);
      if (qt === `${tsch}.${t.name}`) explicitCols.set(fromName, v);
    }

    const colRenames = detectRenames(
      prev.columns,
      t.columns,
      (c) => c.name,
      explicitCols
    );

    colRenames.forEach((newName, oldName) => {
      out.push({
        kind: "renameColumn",
        tableName: t.name,
        tableSchema: t.schema,
        oldName,
        newName,
      });
    });

    t.columns.forEach((c) => {
      const p = prev.columns.find((x) => x.name === c.name);
      const renamedFrom = Array.from(colRenames.entries()).find(
        ([_, newN]) => newN === c.name
      );

      if (renamedFrom) {
        const oldCol = prev.columns.find((x) => x.name === renamedFrom[0]);
        if (oldCol) {
          const commentPrev = oldCol.comment ?? null;
          const commentNext = c.comment ?? null;
          if (commentPrev !== commentNext) {
            out.push({
              kind: "setColumnComment",
              tableSchema: t.schema ?? "public",
              tableName: t.name,
              columnName: c.name,
              comment: commentNext,
              previous: commentPrev,
            });
          }
          if (!columnsEqual(oldCol, c)) {
            if (!columnStructureEqual(oldCol, c)) {
              const isEnumChange =
                oldCol.type === "ENUM" &&
                c.type === "ENUM" &&
                JSON.stringify(oldCol.enumValues || []) !==
                  JSON.stringify(c.enumValues || []);
              if (isEnumChange) {
                out.push({
                  kind: "alterEnum",
                  tableName: t.name,
                  tableSchema: t.schema,
                  columnName: c.name,
                  before: oldCol,
                  after: c,
                  pgEnumTypeName: c.enumTypeName || oldCol.enumTypeName,
                });
              } else {
                out.push({
                  kind: "alterColumn",
                  tableName: t.name,
                  tableSchema: t.schema,
                  before: oldCol,
                  after: c,
                });
              }
            }
          }
        }
      } else if (!p) {
        out.push({
          kind: "addColumn",
          tableName: t.name,
          tableSchema: t.schema,
          column: c,
        });
        const cc = c.comment ?? null;
        if (cc) {
          out.push({
            kind: "setColumnComment",
            tableSchema: t.schema ?? "public",
            tableName: t.name,
            columnName: c.name,
            comment: cc,
            previous: null,
          });
        }
      } else {
        const commentPrev = p.comment ?? null;
        const commentNext = c.comment ?? null;
        if (commentPrev !== commentNext) {
          out.push({
            kind: "setColumnComment",
            tableSchema: t.schema ?? "public",
            tableName: t.name,
            columnName: c.name,
            comment: commentNext,
            previous: commentPrev,
          });
        }

        if (!columnsEqual(p, c)) {
          const isEnumChange =
            p.type === "ENUM" &&
            c.type === "ENUM" &&
            JSON.stringify(p.enumValues || []) !==
              JSON.stringify(c.enumValues || []);
          if (isEnumChange) {
            out.push({
              kind: "alterEnum",
              tableName: t.name,
              tableSchema: t.schema,
              columnName: c.name,
              before: p,
              after: c,
              pgEnumTypeName: c.enumTypeName || p.enumTypeName,
            });
          } else if (!columnStructureEqual(p, c)) {
            out.push({
              kind: "alterColumn",
              tableName: t.name,
              tableSchema: t.schema,
              before: p,
              after: c,
            });
          }
        }
      }
    });

    prev.columns.forEach((c) => {
      const isRenamed = colRenames.has(c.name);
      if (!t.columns.find((x) => x.name === c.name) && !isRenamed) {
        out.push({
          kind: "dropColumn",
          tableName: t.name,
          tableSchema: t.schema,
          columnName: c.name,
          backup: c,
        });
      }
    });

    const tcommentPrev = prev.tableComment ?? null;
    const tcommentNext = t.tableComment ?? null;
    if (tcommentPrev !== tcommentNext) {
      out.push({
        kind: "setTableComment",
        tableSchema: t.schema ?? "public",
        tableName: t.name,
        comment: tcommentNext,
        previous: tcommentPrev,
      });
    }

    if (!primaryKeysEqual(prev.primaryKeys, t.primaryKeys)) {
      out.push({
        kind: "changePrimaryKey",
        tableName: t.name,
        tableSchema: t.schema,
        before: prev.primaryKeys,
        after: t.primaryKeys,
      });
    }

    const filteredPrevIndexes = filterRedundantIndexes(prev.indexes, prev.uniques);
    const filteredAfterIndexes = filterRedundantIndexes(t.indexes, t.uniques);

    filteredAfterIndexes.forEach((i) => {
      const p = filteredPrevIndexes.find((x) => x.name === i.name);
      if (!p)
        out.push({
          kind: "createIndex",
          tableName: t.name,
          tableSchema: t.schema,
          index: i,
        });
      else if (!indexesEqual(p, i)) {
        out.push({
          kind: "dropIndex",
          tableName: t.name,
          tableSchema: t.schema,
          indexName: i.name,
          backup: p,
        });
        out.push({
          kind: "createIndex",
          tableName: t.name,
          tableSchema: t.schema,
          index: i,
        });
      }
    });

    filteredPrevIndexes.forEach((i) => {
      if (!filteredAfterIndexes.find((x) => x.name === i.name)) {
        out.push({
          kind: "dropIndex",
          tableName: t.name,
          tableSchema: t.schema,
          indexName: i.name,
          backup: i,
        });
      }
    });

    t.foreignKeys.forEach((fk) => {
      const match = findMatchingPrevFk(
        t.schema ?? "public",
        t.name,
        fk,
        prev.foreignKeys
      );
      if (!match)
        out.push({
          kind: "addFK",
          tableName: t.name,
          tableSchema: t.schema,
          fk,
        });
      else if (!foreignKeysEqual(match, fk)) {
        out.push({
          kind: "dropFK",
          tableName: t.name,
          tableSchema: t.schema,
          fkName: match.name,
          backup: match,
        });
        out.push({
          kind: "addFK",
          tableName: t.name,
          tableSchema: t.schema,
          fk,
        });
      }
    });

    prev.foreignKeys.forEach((fk) => {
      const still = findMatchingPrevFk(
        t.schema ?? "public",
        t.name,
        fk,
        t.foreignKeys
      );
      if (!still) {
        out.push({
          kind: "dropFK",
          tableName: t.name,
          tableSchema: t.schema,
          fkName: fk.name,
          backup: fk,
        });
      }
    });

    const beforeUnique = prev.uniques || [];
    const afterUnique = t.uniques || [];

    afterUnique.forEach((u) => {
      const old = beforeUnique.find((x) => x.name === u.name);
      if (!old)
        out.push({
          kind: "addUnique",
          tableName: t.name,
          tableSchema: t.schema,
          unique: u,
        });
      else {
        const a = [...old.columns].sort();
        const b = [...u.columns].sort();
        const same = a.length === b.length && a.every((col, i) => col === b[i]!);
        if (!same) {
          out.push({
            kind: "dropUnique",
            tableName: t.name,
            tableSchema: t.schema,
            uniqueName: old.name,
            backup: old,
          });
          out.push({
            kind: "addUnique",
            tableName: t.name,
            tableSchema: t.schema,
            unique: u,
          });
        }
      }
    });

    beforeUnique.forEach((u) => {
      if (!afterUnique.find((x) => x.name === u.name)) {
        out.push({
          kind: "dropUnique",
          tableName: t.name,
          tableSchema: t.schema,
          uniqueName: u.name,
          backup: u,
        });
      }
    });

    const beforeChecks = prev.checks || [];
    const afterChecks = t.checks || [];

    afterChecks.forEach((ch) => {
      const old = beforeChecks.find((x) => x.name === ch.name);
      if (!old)
        out.push({
          kind: "addCheck",
          tableName: t.name,
          tableSchema: t.schema,
          check: ch,
        });
      else if (old.expression !== ch.expression) {
        out.push({
          kind: "dropCheck",
          tableName: t.name,
          tableSchema: t.schema,
          checkName: old.name,
          backup: old,
        });
        out.push({
          kind: "addCheck",
          tableName: t.name,
          tableSchema: t.schema,
          check: ch,
        });
      }
    });

    beforeChecks.forEach((ch) => {
      if (!afterChecks.find((x) => x.name === ch.name)) {
        out.push({
          kind: "dropCheck",
          tableName: t.name,
          tableSchema: t.schema,
          checkName: ch.name,
          backup: ch,
        });
      }
    });
  }

  let actions = sortByDependencies(out);
  actions = orderCreateTableActions(actions);
  return { actions, warnings };
}

/** @deprecated use diff().actions */
export function diffActionsOnly(
  before: DatabaseSchema,
  after: DatabaseSchema,
  renameMap?: RenameMapFile
): MigrationAction[] {
  return diff(before, after, renameMap).actions;
}

