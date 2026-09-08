import { EtherfiCash } from "etherfi-cash";

for (const key of ["ETHERFI_COOKIE", "ETHERFI_ACTIVE_USER", "ETHERFI_SAFE_ID"]) {
  if (!process.env[key]) throw new Error(`Set ${key} in your environment first.`);
}

const cash = new EtherfiCash({
  cookie: process.env.ETHERFI_COOKIE,
  activeUser: process.env.ETHERFI_ACTIVE_USER,
  safeId: process.env.ETHERFI_SAFE_ID,
});

try {
  const details = await cash.getAccountDetails();
  const page = await cash.listCardTransactions();
  // Account data stays on your machine. This example prints only a summary.
  console.log({ totalBalance: details.totalBalance, transactions: page.data.length, nextPage: page.meta.nextPage });
} catch (error) {
  console.error(error instanceof Error ? error.message : "Request failed.");
  process.exitCode = 1;
}
