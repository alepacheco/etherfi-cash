# etherfi-cash

[![CI](https://github.com/alepacheco/etherfi-cash/actions/workflows/ci.yml/badge.svg)](https://github.com/alepacheco/etherfi-cash/actions/workflows/ci.yml)

Read your Ether.fi Cash transactions and portfolio balance from TypeScript.
Zero runtime dependencies. Native `fetch`. Works in Node.js 22+, Bun, and Cloudflare Workers.

**Unofficial and unaffiliated with Ether.fi.** This wraps the Cash website's
undocumented API. It is not an official SDK, and endpoints can change without
notice. It uses your existing web session, **not an API key**.

## Install

Install the compiled package from the GitHub release:

```sh
npm install https://github.com/alepacheco/etherfi-cash/releases/download/v0.1.0/etherfi-cash-0.1.0.tgz
```

The package is ESM. No browser automation, database, wallet library, or hosted
proxy is required. Run it on a trusted server or your own machine; do not bundle
session credentials into a frontend application.

## Quick start

```ts
import { EtherfiCash } from "etherfi-cash";

const cash = new EtherfiCash({
  cookie: process.env.ETHERFI_COOKIE!,
  activeUser: process.env.ETHERFI_ACTIVE_USER!,
  safeId: process.env.ETHERFI_SAFE_ID!,
});

const details = await cash.getAccountDetails();
console.log(details.totalBalance); // USD, without rounding; number or numeric string

const page = await cash.listCardTransactions({ limit: 25 });
for (const transaction of page.data) {
  console.log(transaction.timestamp, transaction.merchantData?.merchant_name,
    transaction.billAmount, transaction.billCurrency, transaction.status);
}
console.log(page.meta.nextPage); // number or null
```

See [examples/read-account.mjs](examples/read-account.mjs) for a runnable version.

## Supply your own session

1. Sign in to [Ether.fi Cash](https://www.ether.fi/app/cash/transaction-history)
   yourself and open the browser's developer tools → Network.
2. Reload transaction history and select its request to
   `/app/cash/api/v3/account-safe/<safeId>/transaction-history`.
3. Copy the **Cookie** and **x-active-user** request-header values. The account
   identifier between `account-safe/` and `/transaction-history` is `safeId`.
4. Store these values in your local environment or deployment's secret store.
   Use values from the same account/session.

The client only sends GET requests, but the session itself may grant broader
account access. Treat it as a password: do not share it, commit it, paste it into
issues, or pass it to an untrusted custom transport.

The client does not log in, handle passwords or wallet keys, solve CAPTCHAs, or
refresh sessions. When authentication fails, sign in manually and replace the
session values. There is no guaranteed session lifetime or keepalive mechanism.

## API

### `new EtherfiCash(options)`

| Option | Required | Meaning |
| --- | --- | --- |
| `cookie` | Yes | Cookie request-header value |
| `activeUser` | Yes | `x-active-user` request-header value |
| `safeId` | Yes | Account-safe identifier from the request path |
| `timeoutMs` | No | Per-request timeout including response body, default `30000` |
| `fetch` | No | Compatible transport for testing or instrumentation; receives the session |

Requests use the fixed `https://www.ether.fi` origin and reject redirects.
There are no automatic retries. In particular, a rate limit or rejected session
does not trigger repeated requests.

### `listCardTransactions({ page = 1, limit = 25, signal? })`

Returns `{ data: CardTransaction[], meta: { nextPage: number | null, ... } }`.
Only `rain_transaction` events are included. Source fields and additional fields
are preserved; invalid known fields or pagination metadata cause an error.
Page and limit must be positive integers; acceptance of large limits is determined
by the upstream API.

### `iterateCardTransactions({ page = 1, limit = 25, maxPages = 100, signal? })`

An async iterator that follows the server's `nextPage`, requesting pages lazily:

```ts
for await (const transaction of cash.iterateCardTransactions({ maxPages: 20 })) {
  console.log(transaction.id, transaction.status);
  // break stops without fetching another page.
}
```

If another page exists after `maxPages`, iteration throws rather than silently
claiming a complete history. Rows already yielded remain yielded. Use the
single-page method when you deliberately want a limited window or explicit resume.

History can change while you paginate. This is not a snapshot or a reconciliation
engine: callers should use transaction IDs to handle overlaps and re-read recent
transactions to observe settlement changes.

### `getAccountDetails({ signal? })`

Returns the response's `data` object. `totalBalance` is validated as a finite,
non-negative number or numeric string. Other fields remain available as `unknown`.
The client does not round, truncate, convert currencies, or apply accounting rules.

### Errors

```ts
import { EtherfiAuthError, EtherfiHttpError } from "etherfi-cash";

try {
  await cash.getAccountDetails();
} catch (error) {
  if (error instanceof EtherfiAuthError) {
    // HTTP 401/403: inspect your session/access manually. No automated renewal.
  } else if (error instanceof EtherfiHttpError && error.status === 429) {
    // Stop polling and retry later according to your application's policy.
  } else {
    throw error;
  }
}
```

| Error | Meaning |
| --- | --- |
| `EtherfiAuthError` | HTTP 401/403; a 403 may also mean an access restriction |
| `EtherfiHttpError` | Other unsuccessful HTTP status, including redirects; exposes `status` |
| `EtherfiResponseError` | Invalid JSON, invalid known fields, pagination problems, or iterator cap |
| `EtherfiRequestError` | Exposes `reason`: `timeout`, `aborted`, or `network` |

Errors omit response bodies, credentials, and account URLs. Caller cancellation
uses an `AbortSignal` and produces `EtherfiRequestError` with `reason: "aborted"`.

## Amounts and lifecycle

- `billAmount` is in billed currency units, with the upstream sign preserved.
- `cashbacks[].cashbackInUsdc` and `reversedInUsdc` are USDC micro-units: divide
  their difference by `1_000_000` to express net cashback in USDC. Choose decimal
  precision and rounding in your application.
- `status: "REFUND"` identifies a refund row. `userStatus` or `detailedStatus`
  can describe its lifecycle. All status strings remain open-ended.
- Unknown fields survive intact. The published types cover the fields this
  client validates, not every field the website might return.

## Supported endpoints

| Method | Website endpoint |
| --- | --- |
| `listCardTransactions` / iterator | `GET /app/cash/api/v3/account-safe/{safeId}/transaction-history` with card-event and granular-status flags |
| `getAccountDetails` | `GET /app/cash/api/v2/account-safe/{safeId}/details` |

This release covers reads only. It has no transfers, card controls, transaction
mutations, authentication endpoints, or integrations with budgeting products.

## Development

```sh
npm ci
npm run check
npm pack
```

Tests use synthetic fixtures and an injected transport; they never contact a
real account. They cover request construction, pagination, refunds, malformed
responses, credential redaction, cancellation, and timeouts. Passing these tests
does not prove that the undocumented upstream API is currently reachable.

See [CONTRIBUTING.md](CONTRIBUTING.md) and the short
[design note](docs/design.md) for scope and implementation decisions.

MIT licensed. Built by [Alejandro Pacheco](https://github.com/alepacheco).
