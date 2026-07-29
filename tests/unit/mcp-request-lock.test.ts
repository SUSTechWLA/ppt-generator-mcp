import assert from "node:assert/strict";
import test from "node:test";

import {
  pendingGenerateDeckRequestLocks,
  withGenerateDeckRequestLock,
} from "../../src/mcp/request-lock.js";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

test("request lock releases after an exception and permits a clean retry", async () => {
  const scope = {};
  const entered = deferred();
  const release = deferred();
  const order: string[] = [];
  const first = withGenerateDeckRequestLock(scope, "shared-request", async () => {
    order.push("first-enter");
    entered.resolve();
    await release.promise;
    throw new Error("first failure");
  });
  await entered.promise;
  const second = withGenerateDeckRequestLock(scope, "shared-request", async () => {
    order.push("second-enter");
    return "retried";
  });
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  assert.deepEqual(order, ["first-enter"]);

  release.resolve();
  await assert.rejects(first, /first failure/);
  assert.equal(await second, "retried");
  assert.equal(await withGenerateDeckRequestLock(scope, "shared-request", async () => "later-retry"), "later-retry");
  assert.deepEqual(order, ["first-enter", "second-enter"]);
  assert.equal(pendingGenerateDeckRequestLocks(scope), 0);
});

test("different request identities are independent", async () => {
  const scope = {};
  const bothEntered = deferred();
  const release = deferred();
  let entered = 0;
  const operation = async () => {
    entered += 1;
    if (entered === 2) bothEntered.resolve();
    await release.promise;
    return entered;
  };
  const first = withGenerateDeckRequestLock(scope, "request-a", operation);
  const second = withGenerateDeckRequestLock(scope, "request-b", operation);
  await bothEntered.promise;
  assert.equal(entered, 2);
  release.resolve();
  await Promise.all([first, second]);
  assert.equal(pendingGenerateDeckRequestLocks(scope), 0);
});
