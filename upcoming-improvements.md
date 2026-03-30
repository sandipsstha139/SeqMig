# Upcoming Improvements

Below are upcoming improvements and enhancements planned for the project:

- **Table Dependency Graph**
  - Visualize and manage table dependencies for better migration generation and ordering.

- **Enhanced Index Metadata**
  - Track and expose properties such as `unique`, `using`, and `where` clauses for indexes.

- **Normalized Default Values**
  - Consistently recognize database default functions (e.g., `NOW`, UUID generators) across dialects.

- **Foreign Key ↔ Index Link**
  - Explicitly link foreign keys with covering indexes; expose an `hasIndex` property in schema.

- **CHECK Constraints Support**
  - Add discoverable and translatable support for column/table `CHECK` constraints.

- **Global ENUM Registry**
  - Maintain a project-wide ENUM type registry to simplify enum management and code generation.

- **Schema & Engine Versioning**
  - Embed version information for schema snapshots and migration engine for reproducibility and CI compatibility.
