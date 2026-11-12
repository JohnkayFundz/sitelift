// Backwards-compatible route alias. Redemption now issues a short-lived,
// report-bound session and never returns a signed storage URL.
import { createReportRedemptionHandler } from "./redeem.js";

export const createPaystackVerifyHandler = createReportRedemptionHandler;
export default createReportRedemptionHandler();
