import assert from "node:assert/strict";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: builtHandler } = await import(workerUrl.href);
  const request = new Request("http://localhost/", {
    headers: { accept: "text/html", host: "localhost" },
  });

  if (typeof builtHandler === "function") {
    return builtHandler(request);
  }
  if (typeof builtHandler?.fetch === "function") {
    return builtHandler.fetch(request, {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    }, {
      waitUntil() {},
      passThroughOnException() {},
    });
  }
  throw new TypeError("The built server entry does not expose a request handler.");
}

test("server-renders the finished Local Code Atlas workbench", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Local Code Atlas<\/title>/i);
  assert.match(html, /Map the blast radius/i);
  assert.match(html, /Check known dependency advisories with OSV/i);
  assert.match(html, /http:\/\/localhost\/og\.png/i);
  assert.doesNotMatch(html, /react-loading-skeleton|Starter Project/i);
});
