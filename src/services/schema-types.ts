export type ScalarType =
  | "STRING"
  | "TEXT"
  | "INTEGER"
  | "SMALLINT"
  | "BIGINT"
  | "BOOLEAN"
  | "DATE"
  | "FLOAT"
  | "DOUBLE"
  | "DECIMAL"
  | "JSON"
  | "JSONB"
  | "UUID"
  | "ENUM"
  | "ARRAY";

export type ColumnSchema = {
  name: string;
  type: ScalarType;
  dbType: string;
  allowNull: boolean;
  defaultValue?: unknown;
  primaryKey: boolean;
  unique: boolean;
  autoIncrement: boolean;
  comment?: string | null;
  enumValues?: string[];
  /** PostgreSQL enum type name (from DB introspection); improves ALTER TYPE codegen. */
  enumTypeName?: string;
};

export type IndexSchema = {
  name: string;
  columns: string[];
  unique: boolean;
  where?: unknown | null;
  type?: string | null;
  using?: string | null;
};

export type ForeignKeySchema = {
  name: string;
  columns: string[];
  referencedTable: string;
  referencedColumns: string[];
  referencedSchema?: string;
  onUpdate: string | null;
  onDelete: string | null;
};

export type UniqueConstraintSchema = {
  name: string;
  columns: string[];
};

export type CheckConstraintSchema = {
  name: string;
  expression: string;
};

export type TableSchema = {
  name: string;
  /** PostgreSQL schema; omit or "public" for default search_path. */
  schema?: string;
  /** Table-level comment (PostgreSQL COMMENT ON TABLE). */
  tableComment?: string | null;
  columns: ColumnSchema[];
  indexes: IndexSchema[];
  foreignKeys: ForeignKeySchema[];
  uniques: UniqueConstraintSchema[];
  checks: CheckConstraintSchema[];
  primaryKeys: string[];
};

export type DatabaseSchema = {
  tables: TableSchema[];
};

export type SnapshotFileV2 = {
  version: 2;
  meta?: {
    generator?: string;
    updatedAt?: string;
  };
  tables: TableSchema[];
};

export type MigrationAction =
  | { kind: "createTable"; table: TableSchema }
  | {
      kind: "dropTable";
      tableName: string;
      tableSchema?: string;
      backup: TableSchema;
    }
  | {
      kind: "renameTable";
      fromSchema: string;
      fromName: string;
      toSchema: string;
      toName: string;
    }
  | {
      kind: "addColumn";
      tableName: string;
      tableSchema?: string;
      column: ColumnSchema;
    }
  | {
      kind: "dropColumn";
      tableName: string;
      tableSchema?: string;
      columnName: string;
      backup: ColumnSchema;
    }
  | {
      kind: "renameColumn";
      tableName: string;
      tableSchema?: string;
      oldName: string;
      newName: string;
    }
  | {
      kind: "alterColumn";
      tableName: string;
      tableSchema?: string;
      before: ColumnSchema;
      after: ColumnSchema;
    }
  | {
      kind: "alterEnum";
      tableName: string;
      tableSchema?: string;
      columnName: string;
      before: ColumnSchema;
      after: ColumnSchema;
      /** When known (DB introspection), use for ALTER TYPE. */
      pgEnumTypeName?: string;
    }
  | {
      kind: "setColumnComment";
      tableSchema: string;
      tableName: string;
      columnName: string;
      comment: string | null;
      previous: string | null;
    }
  | {
      kind: "setTableComment";
      tableSchema: string;
      tableName: string;
      comment: string | null;
      previous: string | null;
    }
  | {
      kind: "createIndex";
      tableName: string;
      tableSchema?: string;
      index: IndexSchema;
    }
  | {
      kind: "dropIndex";
      tableName: string;
      tableSchema?: string;
      indexName: string;
      backup: IndexSchema;
    }
  | { kind: "addFK"; tableName: string; tableSchema?: string; fk: ForeignKeySchema }
  | {
      kind: "dropFK";
      tableName: string;
      tableSchema?: string;
      fkName: string;
      backup: ForeignKeySchema;
    }
  | {
      kind: "addUnique";
      tableName: string;
      tableSchema?: string;
      unique: UniqueConstraintSchema;
    }
  | {
      kind: "dropUnique";
      tableName: string;
      tableSchema?: string;
      uniqueName: string;
      backup: UniqueConstraintSchema;
    }
  | {
      kind: "addCheck";
      tableName: string;
      tableSchema?: string;
      check: CheckConstraintSchema;
    }
  | {
      kind: "dropCheck";
      tableName: string;
      tableSchema?: string;
      checkName: string;
      backup: CheckConstraintSchema;
    }
  | {
      kind: "changePrimaryKey";
      tableName: string;
      tableSchema?: string;
      before: string[];
      after: string[];
      /** When known (e.g. from DB), use for DROP CONSTRAINT. */
      constraintName?: string;
    };

