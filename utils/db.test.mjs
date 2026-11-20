import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { initMockDB } from "./db.js";

function enableMockTimeout(t) {
  try {
    t.mock.timers.enable({ apis: ["setTimeout"] });
  } catch {
    t.mock.timers.enable(["setTimeout"]);
  }
}

describe("initMockDB", () => {
  it("exports only getPage on the returned instance", () => {
    const db = initMockDB({ title: "Title", body: "Body" });
    assert.deepEqual(Object.keys(db), ["getPage"]);
    assert.equal(typeof db.getPage, "function");
    assert.equal("index" in db, false);
  });

  it("paginates entries using default count (100) and page size (10) after 1000ms", async (t) => {
    enableMockTimeout(t);

    const db = initMockDB({ title: "Hello", body: "World" });

    let resolved = false;
    const page0Promise = db.getPage(0).then((res) => {
      resolved = true;
      return res;
    });

    t.mock.timers.tick(999);
    await Promise.resolve();
    assert.equal(resolved, false, "getPage should not resolve before 1000ms");

    t.mock.timers.tick(1);
    const page0 = await page0Promise;
    assert.equal(resolved, true);
    assert.equal(page0.length, 10);
    assert.deepEqual(page0[0], {
      title: "[Entry 0] - Hello",
      body: "[Entry 0] - World",
    });
    assert.deepEqual(page0[9], {
      title: "[Entry 9] - Hello",
      body: "[Entry 9] - World",
    });

    const page9Promise = db.getPage(9);
    t.mock.timers.tick(1000);
    const page9 = await page9Promise;
    assert.equal(page9.length, 10);
    assert.deepEqual(page9[9], {
      title: "[Entry 99] - Hello",
      body: "[Entry 99] - World",
    });
  });

  it("supports custom count and page sizes including partial trailing pages", async (t) => {
    enableMockTimeout(t);

    const db = initMockDB({ label: "Item" }, 7, 3);

    const p0 = db.getPage(0);
    const p1 = db.getPage(1);
    const p2 = db.getPage(2);
    t.mock.timers.tick(1000);

    assert.deepEqual(await p0, [
      { label: "[Entry 0] - Item" },
      { label: "[Entry 1] - Item" },
      { label: "[Entry 2] - Item" },
    ]);
    assert.deepEqual(await p1, [
      { label: "[Entry 3] - Item" },
      { label: "[Entry 4] - Item" },
      { label: "[Entry 5] - Item" },
    ]);
    assert.deepEqual(await p2, [{ label: "[Entry 6] - Item" }]);
  });

  it("resolves out-of-bounds pointers to empty arrays without affecting subsequent lookups", async (t) => {
    enableMockTimeout(t);

    const db = initMockDB({ title: "Test" }, 10, 5);

    const negativePtr = db.getPage(-1);
    const pastEndPtr = db.getPage(2);
    const validPtr = db.getPage(1);
    t.mock.timers.tick(1000);

    assert.deepEqual(await negativePtr, []);
    assert.deepEqual(await pastEndPtr, []);
    const page1 = await validPtr;
    assert.equal(page1.length, 5);
    assert.equal(page1[0].title, "[Entry 5] - Test");
  });

  it("resolves concurrent and non-sequential page requests independently", async (t) => {
    enableMockTimeout(t);

    const db = initMockDB({ title: "Concurrent" }, 30, 10);

    const req2 = db.getPage(2);
    const req0 = db.getPage(0);
    const req1 = db.getPage(1);
    t.mock.timers.tick(1000);

    const [page2, page0, page1] = await Promise.all([req2, req0, req1]);
    assert.equal(page0[0].title, "[Entry 0] - Concurrent");
    assert.equal(page1[0].title, "[Entry 10] - Concurrent");
    assert.equal(page2[0].title, "[Entry 20] - Concurrent");
  });
});
