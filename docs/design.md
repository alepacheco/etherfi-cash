# A small client for an undocumented API

Ether.fi Cash's website API exposes card history with merchant details, refund
lifecycle fields, and cashback reversals. Reading smart-contract events alone
does not provide the same card-network details. This package makes those website
reads available through a small TypeScript interface.

## Separate the transport from the consumer

The client accepts a session, requests a page or account details, validates the
fields it promises, and returns data. It does not choose categories, reconcile
records, convert transaction signs, round money, or decide what is final. That
keeps it usable in scripts, exports, and applications with different policies.

## Authentication is an input

The API uses an existing website session. Calling it an API key would obscure
both its lifecycle and its authority. The client accepts that session explicitly,
keeps it in private fields, and sends it only to the fixed website origin. It
rejects redirects and never attempts login or renewal. Read-only methods do not
turn the session into a read-only credential.

## Distinguish empty data from broken data

A missing `data` array cannot safely mean an empty history. Invalid known fields
cause the page to fail before returning a partial result. Unknown fields and
new status strings remain available because an undocumented API can evolve.
Likewise, balances preserve numeric strings rather than silently reducing their
precision or replacing invalid values with zero.

## Pagination is explicit

The page method exposes the server's next-page number. The iterator follows it
lazily, including across pages whose non-card events have been filtered out.
It rejects non-forward pagination and reports reaching its safety cap. It does
not imply that a changing account history is a stable snapshot.

## Keep maintenance visible

Synthetic tests verify the client's behavior without accessing anyone's account.
They cannot certify upstream availability. A timeout, rejected session, or schema
change is returned to the caller rather than hidden behind automatic retries.
The endpoint table and this limitation are part of the public interface.
