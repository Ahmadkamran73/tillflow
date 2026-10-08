import "server-only";

/**
 * The only door from the till's routes to the privileged ops.* functions (this directory is on the
 * allowlist in scripts/check-privileged-imports.ts). Every one of these resolves the shop and the
 * till from the device token hash it is given, never from anything the till claims.
 */
export {
  deviceFeedMeta,
  deviceFeedTable,
  deviceFindSale,
  deviceRefundMeta,
  deviceRefundsKnown,
  deviceSaleCatalogAsOf,
  deviceSalesKnown,
  deviceSyncMeta,
  deviceTenderTypes,
  issueApproval,
  pairRegister,
  pinAttemptBegin,
  pinAttemptFinish,
  recordRegisterEvents,
  type FeedTable,
} from "@/lib/ops/db";
