import assert from "node:assert/strict";
import test from "node:test";
import { formatProfile } from "../src/profile-service.js";

test("profile names are trimmed", () => {
  assert.equal(formatProfile({ displayName: " Sample " }), "Sample");
});
