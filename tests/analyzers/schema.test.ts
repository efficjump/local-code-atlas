import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  analyzeSchema,
  type AnalysisFile,
} from "../../src/analyzers";

const fixtureRoot = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "schema",
);

test("SQL DDL and migrations retain tables, keys, relationships, and source locations", async () => {
  const result = await analyzeSchema(await fixtureFiles(["schema.sql"]));

  assert.equal(result.tables.length, 3);
  const users = result.tables.find(
    (table) => table.namespace === "app" && table.name === "users",
  );
  assert.deepEqual(users?.primaryKey, ["id"]);
  assert.equal(users?.columns.find((column) => column.name === "email")?.unique, true);
  assert.equal(users?.provenance[0].range.start.line, 1);

  const sessionRelation = result.relationships.find(
    (relationship) => relationship.from.table === "sessions",
  );
  assert.equal(sessionRelation?.declaration, "declared");
  assert.deepEqual(sessionRelation?.from.columns, ["user_id"]);
  assert.deepEqual(sessionRelation?.to.columns, ["id"]);
  assert.equal(sessionRelation?.onDelete, "CASCADE");
  assert.equal(sessionRelation?.provenance.path, "fixtures/schema/schema.sql");

  const auditRelation = result.relationships.find(
    (relationship) => relationship.from.table === "audit_events",
  );
  assert.equal(auditRelation?.onDelete, "SET NULL");
  assert.ok((auditRelation?.provenance.range.start.line ?? 0) > 20);
});

test("Prisma mappings resolve logical relation fields to physical ERD names", async () => {
  const result = await analyzeSchema(await fixtureFiles(["schema.prisma"]));

  const session = result.tables.find((table) => table.name === "sessions");
  assert.equal(session?.logicalName, "Session");
  assert.equal(session?.namespace, "app");
  assert.ok(session?.columns.some((column) => column.name === "user_id"));
  assert.equal(
    session?.columns.some((column) => column.logicalName === "user"),
    false,
  );

  const relation = result.relationships.find(
    (candidate) =>
      candidate.from.table === "sessions" && candidate.to.table === "users",
  );
  assert.equal(relation?.declaration, "declared");
  assert.deepEqual(relation?.from.columns, ["user_id"]);
  assert.deepEqual(relation?.to.columns, ["id"]);
  assert.equal(relation?.onDelete, "Cascade");

  const optionalRelation = result.relationships.find(
    (candidate) => candidate.from.table === "members",
  );
  assert.equal(optionalRelation?.cardinality, "many-to-one");
  assert.equal(optionalRelation?.confidence.level, "high");
});

test("naming-convention relationships are clearly separated from declarations", async () => {
  const result = await analyzeSchema([
    {
      path: "schema.sql",
      content: [
        "CREATE TABLE accounts (id UUID PRIMARY KEY);",
        "CREATE TABLE notes (id UUID PRIMARY KEY, account_id UUID);",
      ].join("\n"),
    },
  ]);

  const inferred = result.relationships.find(
    (relationship) => relationship.declaration === "inferred",
  );
  assert.equal(inferred?.from.table, "notes");
  assert.equal(inferred?.to.table, "accounts");
  assert.equal(inferred?.confidence.level, "medium");

  const disabled = await analyzeSchema(
    [
      {
        path: "schema.sql",
        content:
          "CREATE TABLE accounts (id UUID PRIMARY KEY); CREATE TABLE notes (id UUID PRIMARY KEY, account_id UUID);",
      },
    ],
    { inferRelationships: false },
  );
  assert.equal(disabled.relationships.length, 0);
});

test("TypeORM annotations preserve declared table and join-column names", async () => {
  const result = await analyzeSchema([
    {
      path: "entities.ts",
      content: `
@Entity("users")
export class User {
  @PrimaryGeneratedColumn("uuid")
  id!: string;
}

@Entity({ name: "sessions" })
export class Session {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "user_id", type: "uuid" })
  userId!: string;

  @ManyToOne(() => User, { onDelete: "CASCADE" })
  @JoinColumn({ name: "user_id", referencedColumnName: "id" })
  user!: User;
}
`,
    },
  ]);

  assert.deepEqual(
    result.tables.map((table) => table.name),
    ["sessions", "users"],
  );
  const relation = result.relationships.find(
    (candidate) => candidate.from.table === "sessions",
  );
  assert.deepEqual(relation?.from.columns, ["user_id"]);
  assert.equal(relation?.to.table, "users");
  assert.deepEqual(relation?.to.columns, ["id"]);
  assert.equal(relation?.declaration, "declared");
});

test("JPA annotations distinguish Java field types from relation targets", async () => {
  const result = await analyzeSchema([
    {
      path: "Entities.java",
      content: `
@Entity
@Table(name = "users", schema = "app")
public class User {
  @Id
  @Column(name = "id", nullable = false)
  private UUID id;
}

@Entity
@Table(name = "orders", schema = "app")
public class Order {
  @Id
  private UUID id;

  @ManyToOne
  @JoinColumn(name = "user_id", referencedColumnName = "id")
  private User user;
}
`,
    },
  ]);

  const relation = result.relationships.find(
    (candidate) => candidate.from.table === "orders",
  );
  assert.equal(relation?.to.table, "users");
  assert.deepEqual(relation?.from.columns, ["user_id"]);
  assert.deepEqual(relation?.to.columns, ["id"]);
});

async function fixtureFiles(names: readonly string[]): Promise<AnalysisFile[]> {
  return Promise.all(
    names.map(async (name) => ({
      path: `fixtures/schema/${name}`,
      content: await readFile(path.join(fixtureRoot, name), "utf8"),
    })),
  );
}
