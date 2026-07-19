import assert from "node:assert/strict";
import test from "node:test";
import {
  modelEndpointHost,
  modelEndpointOrigin,
  modelIsConfigured,
  synthesizeWithModel,
} from "../src/ai/synthesis.js";

const evidence = {
  project: { name: "sample", languages: ["TypeScript"], frameworks: [] },
  question: "What changes?",
  impact: [],
  security: [],
  dataModel: [],
};

test("model synthesis is disabled without runtime configuration", async () => {
  assert.equal(modelIsConfigured({ NODE_ENV: "test" }), false);
  assert.deepEqual(await synthesizeWithModel(evidence, { enabled: false }), {
    enabled: false,
  });
});

test("requested synthesis reports missing configuration without network access", async () => {
  const result = await synthesizeWithModel(evidence, {
    enabled: true,
    environment: { NODE_ENV: "test" },
  });
  assert.equal(result.enabled, false);
  assert.equal(result.requestAttempted, undefined);
  assert.match(result.diagnostic ?? "", /no chat-completions endpoint/i);
});

test("configured synthesis records an attempted external request even when it fails", async () => {
  let requestedUrl = "";
  const result = await synthesizeWithModel(evidence, {
    enabled: true,
    environment: {
      NODE_ENV: "test",
      ATLAS_LLM_BASE_URL: "https://models.example.test/v1",
      ATLAS_LLM_MODEL: "runtime-selected",
    },
    fetchImplementation: async (input) => {
      requestedUrl = String(input);
      return new Response(null, { status: 503 });
    },
  });

  assert.equal(requestedUrl, "https://models.example.test/v1/chat/completions");
  assert.equal(result.enabled, false);
  assert.equal(result.requestAttempted, true);
  assert.match(result.diagnostic ?? "", /HTTP 503/u);
});

test("an already-cancelled synthesis never constructs or sends a model request", async () => {
  const controller = new AbortController();
  controller.abort(new DOMException("Cancelled by caller", "AbortError"));
  let requestCount = 0;

  const result = await synthesizeWithModel(evidence, {
    enabled: true,
    environment: {
      NODE_ENV: "test",
      ATLAS_LLM_BASE_URL: "https://models.example.test/v1",
      ATLAS_LLM_MODEL: "runtime-selected",
    },
    signal: controller.signal,
    fetchImplementation: async () => {
      requestCount += 1;
      return Response.json({});
    },
  });

  assert.equal(requestCount, 0);
  assert.equal(result.enabled, false);
  assert.equal(result.requestAttempted, false);
  assert.match(result.diagnostic ?? "", /cancelled before the request started/iu);
});

test("public model configuration exposes only a validated endpoint origin", () => {
  assert.equal(
    modelEndpointOrigin({
      NODE_ENV: "test",
      ATLAS_LLM_BASE_URL:
        "https://user:password@models.example.test/private/v1?token=secret",
      ATLAS_LLM_API_KEY: "must-not-leak",
    }),
    "https://models.example.test",
  );
  assert.equal(
    modelEndpointHost({ NODE_ENV: "test", ATLAS_LLM_BASE_URL: "not a URL" }),
    undefined,
  );
  assert.equal(
    modelIsConfigured({
      NODE_ENV: "test",
      ATLAS_LLM_BASE_URL: "not a URL",
      ATLAS_LLM_MODEL: "runtime-selected",
    }),
    false,
  );
});

test("insecure non-loopback model endpoints are rejected before fetch", async () => {
  const environment = {
    NODE_ENV: "test",
    ATLAS_LLM_BASE_URL: "http://models.example.test/v1",
    ATLAS_LLM_MODEL: "runtime-selected",
  } satisfies NodeJS.ProcessEnv;
  let requestCount = 0;
  const result = await synthesizeWithModel(evidence, {
    enabled: true,
    environment,
    fetchImplementation: async () => {
      requestCount += 1;
      return Response.json({});
    },
  });

  assert.equal(modelIsConfigured(environment), false);
  assert.equal(modelEndpointOrigin(environment), undefined);
  assert.equal(requestCount, 0);
  assert.equal(result.requestAttempted, undefined);
  assert.match(result.diagnostic ?? "", /no chat-completions endpoint/iu);
});

test("loopback HTTP is allowed and model requests reject redirects", async () => {
  let requestedUrl = "";
  let redirect: RequestRedirect | undefined;
  const environment = {
    NODE_ENV: "test",
    ATLAS_LLM_BASE_URL: "http://127.0.0.1:11434/v1?discard=this",
    ATLAS_LLM_MODEL: "runtime-selected",
  } satisfies NodeJS.ProcessEnv;
  const result = await synthesizeWithModel(evidence, {
    enabled: true,
    environment,
    fetchImplementation: async (input, init) => {
      requestedUrl = String(input);
      redirect = init?.redirect;
      return new Response(null, {
        status: 302,
        headers: { Location: "https://redirect.example.test/collect" },
      });
    },
  });

  assert.equal(modelEndpointOrigin(environment), "http://127.0.0.1:11434");
  assert.equal(requestedUrl, "http://127.0.0.1:11434/v1/chat/completions");
  assert.equal(redirect, "error");
  assert.equal(result.requestAttempted, true);
  assert.match(result.diagnostic ?? "", /HTTP 302/u);
});
