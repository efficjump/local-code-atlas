import assert from "node:assert/strict";
import test from "node:test";
import { sessionExpiryFrom } from "../src/services/session-service.js";

test("sessions expire one hour after creation", () => {
  const now = new Date("2026-01-01T00:00:00.000Z");
  assert.equal(sessionExpiryFrom(now).toISOString(), "2026-01-01T01:00:00.000Z");
});
