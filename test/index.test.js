"use strict";
// Regression tests. Run with `npm test` (builds first, then runs against dist/).
process.env.BB_URL = "http://bb.invalid:1234";
process.env.BB_PASSWORD = "s3cret-pw";

const { test, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");

const bb = require("../dist/index.js");

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

/** Replace fetch with a stub that records calls and returns `respond(url, init)` (or {}). */
function stubFetch(respond = () => ({})) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    const body = respond(String(url), init);
    if (body instanceof Response) return body;
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  return calls;
}

test("send_attachment: filename cannot escape the temp dir or touch the filesystem", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-victim-"));
  const victim = path.join(dir, "victim.txt");
  fs.writeFileSync(victim, "original");
  // Old code wrote to path.join(tmpdir, `bb-attach-<rand>-${filename}`) and then unlinked it;
  // "x/../" makes the joined path normalize back out of the prefixed segment
  const traversal = "x/" + path.relative(path.join(os.tmpdir(), "x"), victim);
  const calls = stubFetch(() => ({ status: 200 }));

  await bb.handleSendAttachment({
    chat_guid: "iMessage;-;+15555550100",
    attachment: Buffer.from("payload").toString("base64"),
    filename: traversal,
    mimeType: "text/plain",
  });

  assert.equal(fs.readFileSync(victim, "utf-8"), "original");
  const form = calls[0].init.body;
  assert.equal(form.get("name"), "victim.txt");
  assert.equal(await form.get("attachment").text(), "payload");
  fs.rmSync(dir, { recursive: true });
});

test("get_attachment: downloadUrl returned to the client does not contain the password", async () => {
  const calls = stubFetch(() => ({ data: { totalBytes: 10_000_000, mimeType: "image/png", transferName: "a.png" } }));
  const out = JSON.parse(await bb.handleGetAttachment({ guid: "att-1" }));
  assert.ok(!JSON.stringify(out).includes("s3cret-pw"));
  assert.equal(out.downloadUrl, "http://bb.invalid:1234/api/v1/attachment/att-1/download");
  // The server-side request itself is still authenticated
  assert.match(calls[0].url, /password=s3cret-pw/);
});

test("get_attachment: small files are fetched with auth and inlined", async () => {
  const calls = stubFetch((url) => url.includes("/download")
    ? new Response(Buffer.from("hi"), { status: 200 })
    : { data: { totalBytes: 2, mimeType: "text/plain" } });
  const out = JSON.parse(await bb.handleGetAttachment({ guid: "att-2" }));
  assert.equal(out.data, Buffer.from("hi").toString("base64"));
  assert.match(calls[1].url, /\/download\?password=s3cret-pw$/);
  assert.ok(!JSON.stringify(out).includes("s3cret-pw"));
});

test("normalizeChatGuid: 10 bare digits get the +1 country code", () => {
  assert.equal(bb.normalizeChatGuid("2673479614"), "iMessage;-;+12673479614");
  assert.equal(bb.normalizeChatGuid("+12673479614"), "iMessage;-;+12673479614");
  assert.equal(bb.normalizeChatGuid("447700900123"), "iMessage;-;+447700900123");
  assert.equal(bb.normalizeChatGuid("iMessage;+;chat123"), "iMessage;+;chat123");
});

test("send_message: posts the normalized chat GUID", async () => {
  const calls = stubFetch();
  await bb.handleSendMessage({ chat_guid: "2673479614", message: "hi" });
  assert.equal(JSON.parse(calls[0].init.body).chatGuid, "iMessage;-;+12673479614");
});

test("handle_query: an email query only matches that email, not every handle", async () => {
  const handles = [
    { address: "+12673479614" },
    { address: "User@iCloud.com" },
    { address: "other@example.com" },
  ];
  stubFetch(() => ({ data: handles, metadata: { total: handles.length } }));
  const email = JSON.parse(await bb.handleHandleQuery({ addresses: ["user@icloud.com"] }));
  assert.deepEqual(email.data.map(h => h.address), ["User@iCloud.com"]);
  const phone = JSON.parse(await bb.handleHandleQuery({ addresses: ["(267) 347-9614"] }));
  assert.deepEqual(phone.data.map(h => h.address), ["+12673479614"]);
});

/** Send a raw HTTP request and resolve with the response text. */
function rawRequest(port, text) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, "127.0.0.1", () => sock.end(text));
    let buf = "";
    sock.on("data", d => { buf += d; });
    sock.on("end", () => resolve(buf));
    sock.on("error", reject);
  });
}

function listen(server) {
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

test("http: a malformed Host header does not crash the server", async () => {
  const server = bb.createHttpServer("");
  const port = await listen(server);
  try {
    await rawRequest(port, "GET /health HTTP/1.1\r\nHost: [\r\nConnection: close\r\n\r\n");
    const res = await realFetch(`http://127.0.0.1:${port}/health`);
    assert.equal(res.status, 200);
  } finally {
    server.close();
  }
});

test("http: MCP_AUTH_TOKEN gates /sse and /message but not /health", async () => {
  const server = bb.createHttpServer("tok");
  const port = await listen(server);
  const base = `http://127.0.0.1:${port}`;
  try {
    assert.equal((await realFetch(`${base}/health`)).status, 200);
    assert.equal((await realFetch(`${base}/sse`)).status, 401);
    assert.equal((await realFetch(`${base}/sse`, { headers: { Authorization: "Bearer nope" } })).status, 401);
    assert.equal((await realFetch(`${base}/message?sessionId=x`, { method: "POST" })).status, 401);
    // Authorized request reaches the router (unknown session → 400)
    const ok = await realFetch(`${base}/message?sessionId=x`, { method: "POST", headers: { Authorization: "Bearer tok" } });
    assert.equal(ok.status, 400);
  } finally {
    server.close();
  }
});
