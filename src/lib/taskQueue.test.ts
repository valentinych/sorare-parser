import assert from "node:assert/strict";
import test from "node:test";
import { createTaskQueue } from "./taskQueue.js";

test("task queue runs FIFO with concurrency 1", async () => {
  const q = createTaskQueue({ name: "t", concurrency: 1 });
  const order: number[] = [];
  const a = q.enqueue("a", async () => {
    order.push(1);
    await new Promise((r) => setTimeout(r, 20));
    order.push(2);
    return "a";
  });
  const b = q.enqueue("b", async () => {
    order.push(3);
    return "b";
  });
  assert.deepEqual(await Promise.all([a, b]), ["a", "b"]);
  assert.deepEqual(order, [1, 2, 3]);
});

test("task queue respects minStartGapMs", async () => {
  const q = createTaskQueue({ name: "gap", concurrency: 1, minStartGapMs: 40 });
  const starts: number[] = [];
  const t0 = Date.now();
  await Promise.all([
    q.enqueue("1", async () => {
      starts.push(Date.now() - t0);
    }),
    q.enqueue("2", async () => {
      starts.push(Date.now() - t0);
    }),
  ]);
  assert.ok(starts[1]! - starts[0]! >= 35, `gap was ${starts[1]! - starts[0]!}ms`);
});

test("concurrency > 1 overlaps runs while still spacing starts", async () => {
  const q = createTaskQueue({ name: "par", concurrency: 2, minStartGapMs: 30 });
  const events: string[] = [];
  const starts: number[] = [];
  const t0 = Date.now();
  const a = q.enqueue("a", async () => {
    starts.push(Date.now() - t0);
    events.push("a-start");
    await new Promise((r) => setTimeout(r, 60));
    events.push("a-end");
  });
  const b = q.enqueue("b", async () => {
    starts.push(Date.now() - t0);
    events.push("b-start");
    await new Promise((r) => setTimeout(r, 60));
    events.push("b-end");
  });
  await Promise.all([a, b]);
  assert.ok(starts[1]! - starts[0]! >= 25, `start gap was ${starts[1]! - starts[0]!}ms`);
  assert.ok(
    events.indexOf("b-start") < events.indexOf("a-end"),
    `expected overlap, got ${JSON.stringify(events)}`,
  );
});

test("failed task rejects without wedging the queue", async () => {
  const q = createTaskQueue({ name: "err", concurrency: 1 });
  const failed = q.enqueue("boom", async () => {
    throw new Error("nope");
  });
  await assert.rejects(failed, /nope/);
  assert.equal(await q.enqueue("ok", async () => "ok"), "ok");
  await q.idle();
  assert.equal(q.size(), 0);
  assert.equal(q.running(), 0);
});

test("idle resolves once pending work drains (no forever hang)", async () => {
  const q = createTaskQueue({ name: "idle", concurrency: 1 });
  let done = false;
  void q.enqueue("slow", async () => {
    await new Promise((r) => setTimeout(r, 40));
    done = true;
  });
  const t0 = Date.now();
  await q.idle();
  assert.equal(done, true);
  assert.ok(Date.now() - t0 < 2000, "idle waited too long");
});

test("size tracks pending while exclusive concurrency=1 holds the second job", async () => {
  const q = createTaskQueue({ name: "size", concurrency: 1 });
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const first = q.enqueue("hold", async () => {
    await gate;
    return 1;
  });
  const second = q.enqueue("wait", async () => 2);
  await new Promise((r) => setImmediate(r));
  assert.equal(q.running(), 1);
  assert.equal(q.size(), 1);
  release();
  assert.deepEqual(await Promise.all([first, second]), [1, 2]);
  assert.equal(q.size(), 0);
  assert.equal(q.running(), 0);
});
