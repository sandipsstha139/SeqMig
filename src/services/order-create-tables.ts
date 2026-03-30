import type { MigrationAction } from "./schema-types";
import { tableQual } from "./qualified";

/** Topologically sort createTable actions so referenced tables are created first (same migration). */
export function orderCreateTableActions(actions: MigrationAction[]): MigrationAction[] {
  const creates = actions.filter(
    (a): a is Extract<MigrationAction, { kind: "createTable" }> =>
      a.kind === "createTable"
  );
  if (creates.length <= 1) return actions;

  const rest = actions.filter((a) => a.kind !== "createTable");
  const quals = new Set(creates.map((c) => tableQual(c.table)));
  const deps = new Map<string, Set<string>>();

  for (const c of creates) {
    const q = tableQual(c.table);
    const need = new Set<string>();
    for (const fk of c.table.foreignKeys) {
      const rs = fk.referencedSchema?.trim() || "public";
      const rq =
        rs === "public" ? fk.referencedTable : `${rs}.${fk.referencedTable}`;
      if (quals.has(rq)) need.add(rq);
    }
    deps.set(q, need);
  }

  const sorted: typeof creates = [];
  const visited = new Set<string>();
  const stack = new Set<string>();

  function visit(q: string) {
    if (visited.has(q)) return;
    if (stack.has(q)) return;
    stack.add(q);
    for (const n of deps.get(q) || []) {
      if (quals.has(n)) visit(n);
    }
    stack.delete(q);
    visited.add(q);
    const c = creates.find((x) => tableQual(x.table) === q);
    if (c) sorted.push(c);
  }

  for (const q of quals) visit(q);

  const firstCreate = actions.findIndex((a) => a.kind === "createTable");
  if (firstCreate === -1) return actions;
  const head = actions.slice(0, firstCreate);
  const tail = actions.slice(firstCreate).filter((a) => a.kind !== "createTable");
  return [...head, ...sorted, ...tail];
}

