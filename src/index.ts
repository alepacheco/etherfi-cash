/** Numeric strings are preserved so callers can choose their decimal precision. */
export type ApiNumber = number | string;

export interface Cashback {
  /** USDC micro-units (1 USDC = 1,000,000 units). */
  cashbackInUsdc: ApiNumber;
  reversedInUsdc: ApiNumber;
  [key: string]: unknown;
}

export interface CardTransaction {
  id: string;
  eventType: string;
  /** Open-ended: REFUND describes the row kind, not its settlement state. */
  status: string;
  userStatus?: string;
  detailedStatus?: string;
  isRefund?: boolean;
  timestamp: string;
  /** Billed currency units, not USDC micro-units. Preserves the upstream sign. */
  billAmount?: number;
  billCurrency?: string;
  merchantData?: {
    merchant_name?: string;
    merchant_city?: string;
    merchant_country?: string;
    mcc_code?: string;
    mcc_category?: string;
    [key: string]: unknown;
  };
  cashbacks?: Cashback[];
  [key: string]: unknown;
}

export interface AccountDetails {
  /** USD portfolio value, returned without rounding or truncation. */
  totalBalance: ApiNumber;
  [key: string]: unknown;
}

export interface TransactionPage {
  /** Only rain_transaction events; other event kinds are excluded. */
  data: CardTransaction[];
  meta: { nextPage: number | null; [key: string]: unknown };
}

export interface EtherfiCashOptions {
  safeId: string;
  /** Value of the Cookie request header from your own authenticated session. */
  cookie: string;
  /** Value of the x-active-user request header. */
  activeUser: string;
  /** Per-request timeout, including reading the body. Default: 30,000 ms. */
  timeoutMs?: number;
  /** Optional transport for tests or instrumenting requests. Receives credentials. */
  fetch?: typeof globalThis.fetch;
}

export interface RequestOptions { signal?: AbortSignal }
export interface PageOptions extends RequestOptions { page?: number; limit?: number }
export interface IterateOptions extends PageOptions {
  /** Safety cap. Throws if another page exists at the cap. Default: 100. */
  maxPages?: number;
}

export class EtherfiHttpError extends Error {
  constructor(public readonly status: number) {
    super(`Ether.fi Cash request failed (HTTP ${status}).`);
    this.name = "EtherfiHttpError";
  }
}

export class EtherfiAuthError extends EtherfiHttpError {
  constructor(status: number) {
    super(status);
    this.name = "EtherfiAuthError";
    this.message = `Ether.fi Cash rejected the session (HTTP ${status}). Sign in manually and supply a fresh session; a 403 can also indicate an access restriction.`;
  }
}

export class EtherfiResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EtherfiResponseError";
  }
}

export class EtherfiRequestError extends Error {
  constructor(public readonly reason: "timeout" | "aborted" | "network") {
    super(`Ether.fi Cash request failed: ${reason}.`);
    this.name = "EtherfiRequestError";
  }
}

const BASE = "https://www.ether.fi/app/cash/api";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function numeric(value: unknown): value is ApiNumber {
  return (typeof value === "number" || (typeof value === "string" && value.trim() !== ""))
    && Number.isFinite(Number(value));
}

function positiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive safe integer.`);
}

function validTransaction(value: Record<string, unknown>): boolean {
  if (!["id", "eventType", "status", "timestamp"].every(key => typeof value[key] === "string" && value[key] !== "")) return false;
  if (!Number.isFinite(Date.parse(value.timestamp as string))) return false;
  for (const key of ["userStatus", "detailedStatus", "billCurrency"]) {
    if (value[key] !== undefined && typeof value[key] !== "string") return false;
  }
  if (value.billAmount !== undefined && (typeof value.billAmount !== "number" || !Number.isFinite(value.billAmount))) return false;
  if (value.isRefund !== undefined && typeof value.isRefund !== "boolean") return false;
  if (value.merchantData !== undefined) {
    if (!record(value.merchantData)) return false;
    for (const key of ["merchant_name", "merchant_city", "merchant_country", "mcc_code", "mcc_category"]) {
      if (value.merchantData[key] !== undefined && typeof value.merchantData[key] !== "string") return false;
    }
  }
  if (value.cashbacks !== undefined && (!Array.isArray(value.cashbacks) || !value.cashbacks.every(
    item => record(item) && numeric(item.cashbackInUsdc) && numeric(item.reversedInUsdc),
  ))) return false;
  return true;
}

/** Read-only client for the Cash website API. Does not authenticate or renew sessions. */
export class EtherfiCash {
  // Private fields keep session values out of ordinary object inspection/JSON logs.
  #safeId: string;
  #cookie: string;
  #activeUser: string;
  #timeoutMs: number;
  #fetch: typeof globalThis.fetch | undefined;

  constructor(options: EtherfiCashOptions) {
    for (const key of ["safeId", "cookie", "activeUser"] as const) {
      const value = options[key];
      if (typeof value !== "string" || !value.trim() || /[\r\n]/.test(value)) {
        throw new TypeError(`${key} must be a non-empty single-line string.`);
      }
    }
    // Dot path segments can be normalized by URL parsers even when percent-encoded.
    if (options.safeId === "." || options.safeId === "..") throw new TypeError("Invalid safeId.");
    this.#safeId = encodeURIComponent(options.safeId);
    this.#cookie = options.cookie;
    this.#activeUser = options.activeUser;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    positiveInteger(this.#timeoutMs, "timeoutMs");
    if (this.#timeoutMs > 2_147_483_647) throw new RangeError("timeoutMs exceeds the timer limit.");
    this.#fetch = options.fetch;
  }

  async #get(path: string, options: RequestOptions): Promise<unknown> {
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort();
    if (options.signal?.aborted) throw new EtherfiRequestError("aborted");
    options.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.#timeoutMs);
    try {
      // Workers' global fetch must be called unbound, not as an instance method.
      const request = this.#fetch ?? globalThis.fetch;
      const response = await request(`${BASE}${path}`, {
        method: "GET",
        // Never forward the session to a redirect target.
        redirect: "manual",
        signal: controller.signal,
        headers: {
          accept: "application/json, text/plain, */*",
          referer: "https://www.ether.fi/app/cash/transaction-history",
          "user-agent": UA,
          "x-active-user": this.#activeUser,
          cookie: this.#cookie,
        },
      });
      if (response.status === 401 || response.status === 403) throw new EtherfiAuthError(response.status);
      if (!response.ok) throw new EtherfiHttpError(response.status);
      try {
        return await response.json();
      } catch {
        if (controller.signal.aborted) throw new EtherfiRequestError(timedOut ? "timeout" : "aborted");
        throw new EtherfiResponseError("Ether.fi Cash returned invalid JSON.");
      }
    } catch (error) {
      if (error instanceof EtherfiHttpError || error instanceof EtherfiResponseError || error instanceof EtherfiRequestError) throw error;
      // Fetch errors can contain full URLs or transport diagnostics. Do not expose them.
      throw new EtherfiRequestError(timedOut ? "timeout" : controller.signal.aborted ? "aborted" : "network");
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    }
  }

  /** Read one page, preserving source amounts, status strings, and extra fields. */
  async listCardTransactions(options: PageOptions = {}): Promise<TransactionPage> {
    const page = options.page ?? 1;
    const limit = options.limit ?? 25;
    positiveInteger(page, "page");
    positiveInteger(limit, "limit");
    const body = await this.#get(
      `/v3/account-safe/${this.#safeId}/transaction-history`
      + `?transactionHistoryEvents%5B%5D=CARD_TRANSACTIONS&page=${page}&limit=${limit}`
      + "&withGranularRefundStatus=true&withPendingCancellation=true", options,
    );
    if (!record(body) || !Array.isArray(body.data) || !record(body.meta)) {
      throw new EtherfiResponseError("Ether.fi Cash returned an invalid transaction page.");
    }
    const nextPage = body.meta.nextPage;
    if (nextPage !== null && (typeof nextPage !== "number" || !Number.isSafeInteger(nextPage) || nextPage <= page)) {
      throw new EtherfiResponseError("Ether.fi Cash returned invalid pagination metadata.");
    }
    const data: CardTransaction[] = [];
    for (const item of body.data) {
      if (!record(item) || typeof item.eventType !== "string") throw new EtherfiResponseError("Ether.fi Cash returned an invalid transaction event.");
      if (item.eventType !== "rain_transaction") continue;
      if (!validTransaction(item)) throw new EtherfiResponseError("Ether.fi Cash returned an invalid card transaction.");
      data.push(item as unknown as CardTransaction);
    }
    return { data, meta: { ...body.meta, nextPage: nextPage as number | null } };
  }

  /** Fetch lazily; stopping iteration stops requesting pages. No snapshot guarantee. */
  async *iterateCardTransactions(options: IterateOptions = {}): AsyncGenerator<CardTransaction> {
    const maxPages = options.maxPages ?? 100;
    positiveInteger(maxPages, "maxPages");
    let page = options.page ?? 1;
    for (let count = 0; count < maxPages; count++) {
      const result = await this.listCardTransactions({ ...options, page });
      yield* result.data;
      if (result.meta.nextPage === null) return;
      page = result.meta.nextPage;
    }
    throw new EtherfiResponseError("Transaction history exceeds maxPages; increase the cap or use listCardTransactions to resume explicitly.");
  }

  /** Read account details. Unknown fields are preserved; only totalBalance is typed. */
  async getAccountDetails(options: RequestOptions = {}): Promise<AccountDetails> {
    const body = await this.#get(`/v2/account-safe/${this.#safeId}/details`, options);
    if (!record(body) || !record(body.data) || !numeric(body.data.totalBalance) || Number(body.data.totalBalance) < 0) {
      throw new EtherfiResponseError("Ether.fi Cash returned invalid account details: expected non-negative totalBalance.");
    }
    return body.data as AccountDetails;
  }
}
