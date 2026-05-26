import { expect, type Page } from "@playwright/test";

export function installNoLegacyPaymentRestGuard(page: Page): () => void {
  const hits: string[] = [];
  const legacySubmitPath = ["/api", "submit-payment"].join("/");
  const legacyRegisterPath = ["/api", "payment-methods", "register"].join("/");
  const paymentPrefix = ["/api", "payments"].join("/");

  page.on("request", (request) => {
    try {
      const url = new URL(request.url());
      const path = url.pathname;
      const isForbidden =
        path === legacySubmitPath ||
        path === legacyRegisterPath ||
        (path.startsWith(paymentPrefix) && !path.includes("/webhook"));
      if (isForbidden) {
        hits.push(`${request.method()} ${path}`);
      }
    } catch {
      // ignore malformed URLs
    }
  });

  return () => {
    expect(
      hits,
      `Legacy payment REST paths were called:\n${hits.join("\n")}`
    ).toEqual([]);
  };
}
