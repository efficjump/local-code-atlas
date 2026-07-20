import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeMigrationRisks,
  migrationRiskSemanticKey,
} from "../../src/analyzers/schema/migration-risk.js";

test("migration analysis classifies destructive, compatibility, and safe SQL operations", () => {
  const result = analyzeMigrationRisks([
    {
      path: "db/migrations/20260720_account_changes.sql",
      content: [
        "-- deployment migration",
        "CREATE TABLE audit.events (id UUID PRIMARY KEY);",
        "ALTER TABLE auth.users ADD COLUMN display_name VARCHAR(120);",
        "ALTER TABLE auth.users ADD COLUMN email VARCHAR(320) NOT NULL;",
        "ALTER TABLE auth.users DROP COLUMN legacy_name CASCADE;",
        "ALTER TABLE auth.users ALTER COLUMN display_name SET NOT NULL;",
        "ALTER TABLE auth.users ALTER COLUMN id TYPE BIGINT USING id::bigint;",
        "ALTER TABLE auth.users RENAME COLUMN display_name TO public_name;",
        "ALTER TABLE auth.users ADD CONSTRAINT users_team_fk FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE;",
        "ALTER TABLE auth.users DROP CONSTRAINT users_email_key;",
        "CREATE INDEX users_email_idx ON auth.users (email);",
        "UPDATE auth.users SET public_name = email;",
        "DROP TABLE IF EXISTS audit.legacy_events;",
      ].join("\n"),
    },
  ]);

  assert.equal(result.partial, false);
  assert.equal(result.summary.files, 1);
  assert.equal(result.summary.operations, 12);
  assert.ok(result.risks.some((risk) => risk.label === "create-table:audit.events"));
  assert.ok(
    result.risks.some(
      (risk) =>
        risk.label === "add-column:auth.users.display_name" &&
        risk.safe &&
        risk.severity === "low",
    ),
  );
  assert.ok(
    result.risks.some(
      (risk) =>
        risk.label === "add-column:auth.users.email" &&
        !risk.safe &&
        risk.severity === "high",
    ),
  );
  const drop = result.risks.find(
    (risk) => risk.label === "drop-column:auth.users.legacy_name",
  );
  assert.equal(drop?.destructive, true);
  assert.equal(drop?.severity, "critical");
  assert.equal(drop?.provenance.path, "db/migrations/20260720_account_changes.sql");
  assert.equal(drop?.provenance.range.start.line, 5);
  assert.ok(
    result.risks.some(
      (risk) =>
        risk.category === "rename" &&
        risk.column === "display_name" &&
        risk.nextName === "public_name",
    ),
  );
  assert.ok(
    result.risks.some(
      (risk) =>
        risk.category === "cascade-change" &&
        Array.isArray(risk.details.cascadeActions) &&
        risk.details.cascadeActions.includes("delete"),
    ),
  );
  assert.ok(result.risks.some((risk) => risk.category === "drop-constraint"));
  assert.ok(result.risks.some((risk) => risk.category === "data-change"));
  assert.ok(result.risks.some((risk) => risk.category === "drop-table"));
});

test("migration semantic keys include operation-specific type, cascade, and rename values", () => {
  const result = analyzeMigrationRisks([
    {
      path: "migrations/001.sql",
      content: [
        "ALTER TABLE accounts ALTER COLUMN balance TYPE BIGINT;",
        "ALTER TABLE accounts ALTER COLUMN balance TYPE NUMERIC(20, 2);",
        "ALTER TABLE accounts RENAME COLUMN owner TO owner_id;",
        "ALTER TABLE accounts RENAME COLUMN owner TO principal_id;",
        "ALTER TABLE accounts ADD CONSTRAINT owner_fk FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE;",
        "ALTER TABLE accounts ADD CONSTRAINT owner_fk FOREIGN KEY (owner_id) REFERENCES users(id) ON UPDATE CASCADE;",
      ].join("\n"),
    },
  ]);

  assert.equal(result.partial, false);
  assert.equal(new Set(result.risks.map((risk) => risk.semanticKey)).size, 6);
  assert.equal(
    migrationRiskSemanticKey(result.risks[0]),
    result.risks[0]?.semanticKey,
  );
});

test("MySQL ALTER TABLE index and foreign-key actions are not classified as columns", () => {
  const input = [
    {
      path: "db/migrations/20260720_order_indexes.sql",
      content: [
        "ALTER TABLE commerce.orders",
        "  ADD INDEX idx_created_at (created_at),",
        "  ADD KEY idx_customer (customer_id),",
        "  ADD UNIQUE KEY uq_reference (reference_code),",
        "  DROP INDEX idx_obsolete,",
        "  DROP KEY idx_redundant,",
        "  DROP FOREIGN KEY fk_orders_customer;",
      ].join("\n"),
    },
  ] as const;

  const result = analyzeMigrationRisks(input);
  const repeated = analyzeMigrationRisks(input);

  assert.equal(result.partial, false);
  assert.equal(result.summary.unsupportedStatements, 0);
  assert.equal(result.summary.operations, 6);
  assert.equal(result.risks.some((risk) => risk.category === "add-column"), false);
  assert.equal(result.risks.some((risk) => risk.category === "drop-column"), false);

  const added = result.risks.filter((risk) => risk.category === "add-index");
  assert.deepEqual(
    added.map((risk) => ({
      index: risk.details.index,
      kind: risk.details.indexKind,
      columns: risk.details.columns,
      table: risk.qualifiedTable,
    })),
    [
      {
        index: "idx_created_at",
        kind: "index",
        columns: ["created_at"],
        table: "commerce.orders",
      },
      {
        index: "idx_customer",
        kind: "key",
        columns: ["customer_id"],
        table: "commerce.orders",
      },
      {
        index: "uq_reference",
        kind: "unique-key",
        columns: ["reference_code"],
        table: "commerce.orders",
      },
    ],
  );

  const removed = result.risks.filter(
    (risk) => risk.category === "drop-constraint",
  );
  assert.deepEqual(
    removed.map((risk) => ({
      constraint: risk.details.constraint,
      kind: risk.details.constraintKind,
    })),
    [
      { constraint: "fk_orders_customer", kind: "foreign-key" },
      { constraint: "idx_obsolete", kind: "index" },
      { constraint: "idx_redundant", kind: "index" },
    ],
  );
  assert.deepEqual(
    result.risks.map((risk) => [risk.id, risk.semanticKey]),
    repeated.risks.map((risk) => [risk.id, risk.semanticKey]),
  );
});

test("unsupported migration statements fail closed without exposing SQL text", () => {
  const sensitiveLiteral = "sensitive-value-must-not-leak";
  const result = analyzeMigrationRisks([
    {
      path: "db/migrations/unsupported.sql",
      content: `ALTER VIEW account_view AS SELECT '${sensitiveLiteral}';\n`,
    },
  ]);

  assert.equal(result.partial, true);
  assert.equal(result.summary.unsupportedStatements, 1);
  assert.deepEqual(result.risks, []);
  assert.match(result.diagnostics[0] ?? "", /manual review/u);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(sensitiveLiteral, "u"));
});

test("migration analysis honors caller cancellation", () => {
  const controller = new AbortController();
  controller.abort(new Error("stop migration analysis"));
  assert.throws(
    () =>
      analyzeMigrationRisks(
        [{ path: "migrations/001.sql", content: "DROP TABLE users;" }],
        { signal: controller.signal },
      ),
    /stop migration analysis/u,
  );
});
