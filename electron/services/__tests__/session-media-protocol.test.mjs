import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const modulePath = path.resolve(__dirname, "../../../dist-electron/electron/services/session-media-protocol.js");
const { createSessionMediaHandler } = await import(pathToFileURL(modulePath).href);

const CONTEXT_ID = "11111111-1111-4111-8111-111111111111";
const ATTACHMENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]);

test("session media serves opaque context and attachment namespaces with exact safe headers", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fluely-media-"));
  try {
    const contextPath = path.join(root, "context.png");
    const attachmentPath = path.join(root, "attachment.png");
    await writeFile(contextPath, PNG_BYTES);
    await writeFile(attachmentPath, PNG_BYTES);
    const handler = createSessionMediaHandler({
      context: { getManagedPaths: (ids) => ids.includes(CONTEXT_ID) ? [contextPath] : [] },
      attachments: { getPath: (id) => id === ATTACHMENT_ID ? attachmentPath : undefined },
    });

    const contextResponse = await handler(new Request(`fluely-media://context/${CONTEXT_ID}`));
    const attachmentResponse = await handler(new Request(`fluely-media://attachment/${ATTACHMENT_ID}`));

    assert.equal(contextResponse.status, 200);
    assert.equal(attachmentResponse.status, 200);
    for (const response of [contextResponse, attachmentResponse]) {
      assert.equal(response.headers.get("Content-Type"), "image/png");
      assert.equal(response.headers.get("Content-Length"), String(PNG_BYTES.byteLength));
      assert.equal(response.headers.get("Cache-Control"), "no-store");
      assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
      assert.deepEqual(new Uint8Array(await response.arrayBuffer()), PNG_BYTES);
    }
    assert.deepEqual(new Uint8Array(await readFile(contextPath)), PNG_BYTES);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("session media rejects malformed IDs, traversal, namespace mismatch, and non-GET requests", async () => {
  const handler = createSessionMediaHandler({
    context: { getManagedPaths: () => ["/private/context.png"] },
    attachments: { getPath: () => "/private/attachment.png" },
  });

  for (const request of [
    new Request(`fluely-media://context/${CONTEXT_ID}/extra`),
    new Request("fluely-media://context/..%2Fsettings.json"),
    new Request(`fluely-media://attachment/${CONTEXT_ID}`),
    new Request(`fluely-media://context/${CONTEXT_ID}?token=secret`),
    new Request(`fluely-media://other/${CONTEXT_ID}`),
    new Request(`fluely-media://context/${CONTEXT_ID}`, { method: "POST" }),
  ]) {
    const response = await handler(request);
    assert.equal(response.status, 404);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
  }
});
