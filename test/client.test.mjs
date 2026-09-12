import { test } from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import { EtherfiCash, EtherfiAuthError, EtherfiHttpError, EtherfiRequestError, EtherfiResponseError } from "../dist/index.js";

// Entirely synthetic: never capture real sessions or account responses here.
const auth = { safeId: "example-safe", cookie: "example-session=not-a-real-session", activeUser: "example-user" };
const transaction = (patch = {}) => ({
  id: "example-purchase", eventType: "rain_transaction", status: "CLEARED",
  timestamp: "2026-01-15T12:00:00Z", billAmount: 12.34, billCurrency: "USD",
  merchantData: { merchant_name: "Example Cafe", mcc_code: "5812" },
  cashbacks: [{ cashbackInUsdc: "370200", reversedInUsdc: "100000" }], ...patch,
});
const page = (data = [transaction()], nextPage = null) => ({ data, meta: { nextPage } });
const json = body => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
const client = body => new EtherfiCash({ ...auth, fetch: async () => json(body) });

test("GET uses the known endpoint and headers; credentials never enter the URL", async () => {
  const api = new EtherfiCash({ ...auth, fetch: async function (url, init) {
    assert.equal(this, undefined);
    const parsed = new URL(url);
    assert.equal(parsed.origin, "https://www.ether.fi");
    assert.equal(parsed.pathname, "/app/cash/api/v3/account-safe/example-safe/transaction-history");
    assert.equal(parsed.searchParams.get("transactionHistoryEvents[]"), "CARD_TRANSACTIONS");
    assert.equal(parsed.searchParams.get("page"), "2");
    assert.equal(parsed.searchParams.get("limit"), "10");
    assert.equal(parsed.searchParams.get("withGranularRefundStatus"), "true");
    assert.equal(parsed.searchParams.get("withPendingCancellation"), "true");
    assert.equal(init.method, "GET");
    assert.equal(init.redirect, "manual");
    assert.equal(init.headers.cookie, auth.cookie);
    assert.equal(init.headers["x-active-user"], auth.activeUser);
    assert.ok(init.signal instanceof AbortSignal);
    assert.ok(!url.includes(auth.cookie));
    return json(page());
  } });
  assert.equal((await api.listCardTransactions({ page: 2, limit: 10 })).data.length, 1);
});

test("refund kind, lifecycle, source amounts, micro-units and unknown fields survive unchanged", async () => {
  const row = transaction({ status: "REFUND", userStatus: "PENDING", isRefund: true, billAmount: -12.34, extra: { futureField: true } });
  assert.deepEqual((await client(page([row])).listCardTransactions()).data, [row]);
});

test("new status strings are preserved rather than guessed", async () => {
  const row = transaction({ status: "FUTURE_STATUS" });
  assert.deepEqual((await client(page([row])).listCardTransactions()).data, [row]);
});

test("follows the supplied nextPage, including a page with no matching card rows", async () => {
  const seen = [];
  const api = new EtherfiCash({ ...auth, fetch: async url => {
    const n = Number(new URL(url).searchParams.get("page")); seen.push(n);
    return json(n === 1 ? page([{ eventType: "liquid_deposit" }], 3) : page());
  } });
  const rows = [];
  for await (const row of api.iterateCardTransactions()) rows.push(row);
  assert.deepEqual(seen, [1, 3]);
  assert.deepEqual(rows, [transaction()]);
});

test("breaking iteration does not prefetch another page", async () => {
  let calls = 0;
  const api = new EtherfiCash({ ...auth, fetch: async () => { calls++; return json(page([transaction()], 2)); } });
  for await (const row of api.iterateCardTransactions()) { assert.ok(row.id); break; }
  assert.equal(calls, 1);
});

test("iterator fails explicitly at the page cap", async () => {
  const rows = [];
  await assert.rejects(async () => {
    for await (const row of client(page([transaction()], 2)).iterateCardTransactions({ maxPages: 1 })) rows.push(row);
  }, /exceeds maxPages/);
  assert.equal(rows.length, 1);
});

test("terminal empty page is a valid complete history", async () => {
  const rows = [];
  for await (const row of client(page([])).iterateCardTransactions()) rows.push(row);
  assert.deepEqual(rows, []);
});

test("missing or invalid page data cannot masquerade as empty history", async () => {
  for (const body of [{}, { data: null, meta: { nextPage: null } }, { data: [] }, { data: [], meta: {} }]) {
    await assert.rejects(client(body).listCardTransactions(), EtherfiResponseError);
  }
});

test("backward, repeated, fractional, string, and zero next-page values fail", async () => {
  for (const nextPage of [0, 1, -1, 2.5, "2"]) {
    await assert.rejects(client(page([], nextPage)).listCardTransactions(), EtherfiResponseError);
  }
});

test("malformed transactions fail the page instead of returning partial data", async () => {
  for (const bad of [null, {}, transaction({ timestamp: "invalid" }), transaction({ billAmount: "12.34" }),
    transaction({ status: null }), transaction({ merchantData: { mcc_code: 123 } }),
    transaction({ cashbacks: [{ cashbackInUsdc: "oops", reversedInUsdc: 0 }] })]) {
    await assert.rejects(client(page([transaction(), bad])).listCardTransactions(), EtherfiResponseError);
  }
});

test("account details keep numeric strings and unknown data without rounding", async () => {
  const data = { totalBalance: "123.456789", additional: { anything: true } };
  const api = new EtherfiCash({ ...auth, fetch: async url => {
    assert.equal(new URL(url).pathname, "/app/cash/api/v2/account-safe/example-safe/details");
    return json({ data });
  } });
  assert.deepEqual(await api.getAccountDetails(), data);
  assert.deepEqual(await client({ data: { totalBalance: 0 } }).getAccountDetails(), { totalBalance: 0 });
});

test("invalid balances fail instead of silently becoming zero", async () => {
  for (const totalBalance of [undefined, null, "", "  ", -1, "NaN", "Infinity", true, []]) {
    await assert.rejects(client({ data: { totalBalance } }).getAccountDetails(), EtherfiResponseError);
  }
});

for (const status of [401, 403, 429, 500, 302]) {
  test(`HTTP ${status} is typed, does not expose response text, and is not retried`, async () => {
    let calls = 0;
    const api = new EtherfiCash({ ...auth, fetch: async () => { calls++; return new Response(auth.cookie, { status }); } });
    await assert.rejects(api.getAccountDetails(), error => {
      assert.ok(error instanceof (status === 401 || status === 403 ? EtherfiAuthError : EtherfiHttpError));
      assert.equal(error.status, status);
      assert.ok(!error.message.includes(auth.cookie));
      return true;
    });
    assert.equal(calls, 1);
  });
}

test("HTML or broken JSON raises a response error without leaking the body", async () => {
  const api = new EtherfiCash({ ...auth, fetch: async () => new Response(`<html>${auth.cookie}</html>`) });
  await assert.rejects(api.getAccountDetails(), error => error instanceof EtherfiResponseError && !error.message.includes(auth.cookie));
});

test("transport errors are sanitized", async () => {
  const api = new EtherfiCash({ ...auth, fetch: async () => { throw new Error(auth.cookie); } });
  await assert.rejects(api.getAccountDetails(), error => error instanceof EtherfiRequestError && error.reason === "network" && !inspect(error).includes(auth.cookie));
});

const waitForAbort = async (_url, init) => new Promise((_resolve, reject) => {
  init.signal.addEventListener("abort", () => reject(new Error("transport aborted")), { once: true });
});

test("request times out and aborts its transport", async () => {
  const api = new EtherfiCash({ ...auth, timeoutMs: 10, fetch: waitForAbort });
  await assert.rejects(api.getAccountDetails(), error => error instanceof EtherfiRequestError && error.reason === "timeout");
});

test("timeout covers reading the response body too", async () => {
  const api = new EtherfiCash({ ...auth, timeoutMs: 10, fetch: async (_url, init) => ({
    status: 200, ok: true, json: () => waitForAbort(_url, init),
  }) });
  await assert.rejects(api.getAccountDetails(), error => error.reason === "timeout");
});

test("caller cancellation aborts the request", async () => {
  const controller = new AbortController();
  const api = new EtherfiCash({ ...auth, fetch: waitForAbort });
  const pending = api.getAccountDetails({ signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, error => error instanceof EtherfiRequestError && error.reason === "aborted");
});

test("already-aborted calls never reach the transport", async () => {
  let calls = 0;
  const api = new EtherfiCash({ ...auth, fetch: async () => { calls++; return json({}); } });
  await assert.rejects(api.getAccountDetails({ signal: AbortSignal.abort() }), error => error.reason === "aborted");
  assert.equal(calls, 0);
});

test("credentials stay out of object inspection and validation errors", () => {
  const api = new EtherfiCash(auth);
  assert.equal(JSON.stringify(api), "{}");
  assert.ok(!inspect(api).includes(auth.cookie));
  assert.throws(() => new EtherfiCash({ ...auth, cookie: `${auth.cookie}\r\nextra` }), error => !error.message.includes(auth.cookie));
});

test("invalid options fail before sending a request", async () => {
  for (const key of ["safeId", "cookie", "activeUser"]) assert.throws(() => new EtherfiCash({ ...auth, [key]: "" }), TypeError);
  for (const safeId of [".", ".."]) assert.throws(() => new EtherfiCash({ ...auth, safeId }), TypeError);
  for (const timeoutMs of [0, -1, Infinity, 2 ** 31]) assert.throws(() => new EtherfiCash({ ...auth, timeoutMs }), RangeError);
  for (const n of [0, -1, 1.2, Infinity]) {
    await assert.rejects(client(page()).listCardTransactions({ page: n }), RangeError);
    await assert.rejects(client(page()).listCardTransactions({ limit: n }), RangeError);
  }
});

test("safe ID is encoded as a single path component", async () => {
  const api = new EtherfiCash({ ...auth, safeId: "example/safe?x=y", fetch: async url => {
    assert.ok(url.includes("example%2Fsafe%3Fx%3Dy/details"));
    return json({ data: { totalBalance: 1 } });
  } });
  await api.getAccountDetails();
});


test("unpaid claim-based accruals omit reversals without becoming paid zero-reversal rows", async () => {
  for (const cashbackInUsdc of [370200, "370200"]) {
    const accrual = { cashbackInUsdc, cashbackInToken: "0", paid: false, recipientType: "vault" };
    const rows = [transaction(), transaction({ id: "example-unpaid", status: "PENDING", cashbacks: [accrual] })];
    const result = await client(page(rows)).listCardTransactions();
    assert.deepEqual(result.data, rows);
    assert.equal(Object.hasOwn(result.data[1].cashbacks[0], "reversedInUsdc"), false);
  }
});

test("missing reversals require explicit unpaid state and malformed values still fail the whole page", async () => {
  for (const cashback of [
    { cashbackInUsdc: "370200" },
    { cashbackInUsdc: "370200", paid: true },
    { cashbackInUsdc: "370200", paid: "false" },
    { cashbackInUsdc: "370200", paid: null, reversedInUsdc: 0 },
    { cashbackInUsdc: "bad", paid: false },
    ...[null, "bad", "", false].map(reversedInUsdc => ({ cashbackInUsdc: "370200", paid: false, reversedInUsdc })),
  ]) {
    await assert.rejects(client(page([transaction(), transaction({ cashbacks: [cashback] })])).listCardTransactions(), EtherfiResponseError);
  }
});

test("paid entries retain exact reversal values", async () => {
  const row = transaction({ cashbacks: [{ cashbackInUsdc: "370200", reversedInUsdc: "100000", paid: true }] });
  assert.deepEqual((await client(page([row])).listCardTransactions()).data, [row]);
});
