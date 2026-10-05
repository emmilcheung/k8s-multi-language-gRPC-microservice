// Which pages the waiting room guards. Pure, so the gate and its tests share it.

// Subpages of /tickets/<id> where a purchase starts: the event page itself holds
// the general-admission buy form, the others are the seat picker and plan pages.
// Everything else (admission pass, attendance, orders, checkout) stays open so a
// buyer whose pass lapsed mid-payment can still pay for an order they hold.
const PURCHASE_SUBPAGES = new Set(["seats", "plans"]);

/** True when `pathname` starts a purchase for the armed event `eventId`.
 *  Segments are URL-decoded and compared exactly; empty segments (trailing or
 *  doubled slashes) are ignored. Malformed encoding under /tickets fails closed. */
export function isGatedPath(pathname: string, eventId: string): boolean {
  let segs: string[];
  try {
    segs = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    return /^\/+(tickets|%74ickets)(\/|$)/i.test(pathname);
  }
  if (segs[0] !== "tickets" || segs[1] !== eventId) return false;
  return segs.length === 2 || PURCHASE_SUBPAGES.has(segs[2]);
}
