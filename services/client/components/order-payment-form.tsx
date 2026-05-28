"use client";
// components/order-payment-form.tsx — Stripe Payment Element Client Component.
// Shows saved payment methods (default pre-selected) with a fallback to entering a new card.

import { useEffect, useState, useRef } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Lock, AlertCircle, CreditCard, Loader2, X, ChevronDown, Plus } from "lucide-react";
import { cancelOrder, submitPayment } from "@/app/actions/orders";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { OrderState } from "@/app/actions/orders";
import type { SavedPaymentMethod } from "@/lib/types";

interface CardElement {
  mount(container: HTMLElement | string): void;
  unmount(): void;
  on?: (event: "change", handler: (event: { error?: { message?: string }; complete: boolean }) => void) => void;
  off?: (event: "change", handler: (event: { error?: { message?: string }; complete: boolean }) => void) => void;
}

interface CreatePaymentMethodResult {
  paymentMethod?: { id: string };
  error?: {
    message: string;
  };
}

interface StripeInstance {
  elements(): {
    create(type: "card", options?: Record<string, unknown>): CardElement;
  };
  createPaymentMethod(options: {
    type: string;
    card: CardElement;
  }): Promise<CreatePaymentMethodResult>;
}

interface StripeConstructor {
  (key: string): StripeInstance | null;
}

interface OrderPaymentFormProps {
  orderId: string;
  amount: number;
  expiresAt: string;
  savedPaymentMethods?: SavedPaymentMethod[];
}

const initialState: OrderState = {};

function formatUtcDateTime(value: string): string {
  const d = new Date(value);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const min = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${min}:${ss} UTC`;
}

function formatTimeRemaining(seconds: number): string {
  if (seconds <= 0) return "0:00";
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

function cardBrandIcon(brand?: string): string {
  switch (brand?.toLowerCase()) {
    case "visa": return "VISA";
    case "mastercard": return "MC";
    case "amex": return "AMEX";
    case "discover": return "DISC";
    default: return brand?.toUpperCase().slice(0, 4) ?? "CARD";
  }
}

export function OrderPaymentForm({
  orderId,
  amount,
  expiresAt,
  savedPaymentMethods = [],
}: OrderPaymentFormProps) {
  // Determine the initial selection: prefer the default method, else first saved, else null (new card)
  const defaultMethod = savedPaymentMethods.find((m) => m.isDefault) ?? savedPaymentMethods[0] ?? null;
  const hasSavedMethods = savedPaymentMethods.length > 0;

  const [selectedMethodId, setSelectedMethodId] = useState<string | null>(
    defaultMethod?.id ?? null
  );
  const [showNewCard, setShowNewCard] = useState(!hasSavedMethods);

  const [secondsRemaining, setSecondsRemaining] = useState<number | null>(null);
  const [paymentError, setPaymentError] = useState<string | null>(null);
  const [paymentFailure, setPaymentFailure] = useState<string | null>(null);
  const [pollingNotice, setPollingNotice] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [stripeReady, setStripeReady] = useState(false);
  const [stripeScriptReady, setStripeScriptReady] = useState(false);
  const [isCardComplete, setIsCardComplete] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [lastFailedMethodId, setLastFailedMethodId] = useState<string | null>(null);
  const [cardElementNode, setCardElementNode] = useState<HTMLDivElement | null>(null);
  const stripeInstanceRef = useRef<StripeInstance | null>(null);
  const cardElementInstanceRef = useRef<CardElement | null>(null);
  const stripeMountedRef = useRef(false);

  const router = useRouter();
  const isTimeRunningOut = secondsRemaining !== null && secondsRemaining < 60;
  const isPending = isProcessing || isCancelling;
  const showPaymentRecovery = Boolean(paymentFailure && hasSavedMethods);
  const publishableKey = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY?.trim();
  const validPublishableKey = Boolean(publishableKey && publishableKey.startsWith("pk_"));

  // Stripe is only needed when entering a new card
  const needsStripe = showNewCard;

  // Load Stripe.js once and track when the constructor is ready.
  useEffect(() => {
    if (!needsStripe) return;

    let disposed = false;

    const handleStripeReady = () => {
      if (!disposed) setStripeScriptReady(true);
    };

    const handleStripeError = () => {
      if (!disposed) {
        setPaymentError("Failed to load Stripe. Please check your internet connection.");
      }
    };

    const stripeWindow = window as unknown as { Stripe?: StripeConstructor };
    if (stripeWindow.Stripe) {
      handleStripeReady();
      return () => { disposed = true; };
    }

    const existingScript = document.querySelector<HTMLScriptElement>(
      'script[src="https://js.stripe.com/v3/"]'
    );
    const script = existingScript ?? document.createElement("script");

    script.addEventListener("load", handleStripeReady);
    script.addEventListener("error", handleStripeError);

    if (!existingScript) {
      script.src = "https://js.stripe.com/v3/";
      script.async = true;
      document.head.appendChild(script);
    }

    return () => {
      disposed = true;
      script.removeEventListener("load", handleStripeReady);
      script.removeEventListener("error", handleStripeError);
    };
  }, [needsStripe]);

  // Mount the card element only after both the Stripe constructor and the DOM node are ready.
  useEffect(() => {
    if (!needsStripe) return;
    if (stripeMountedRef.current || !stripeScriptReady || !cardElementNode) return;

    if (!validPublishableKey || !publishableKey) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPaymentError(
        "Stripe publishable key is missing or invalid. Check NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY in your client .env."
      );
      setStripeReady(false);
      return;
    }

    const stripeWindow = window as unknown as { Stripe?: StripeConstructor };
    const stripe = stripeWindow.Stripe?.(publishableKey);
    if (!stripe) {
      setPaymentError("Failed to initialize Stripe. Please try again.");
      setStripeReady(false);
      return;
    }

    try {
      stripeInstanceRef.current = stripe;

      const elements = stripe.elements();
      const cardElement = elements.create("card", {
        hidePostalCode: true,
        style: {
          base: {
            fontSize: "14px",
            color: "#e5e7eb",
            "::placeholder": { color: "#6b7280" },
            backgroundColor: "transparent",
          },
          invalid: { color: "#ef4444" },
        },
      });

      const handleCardChange = (event: { error?: { message?: string }; complete: boolean }) => {
        setIsCardComplete(event.complete);
        if (event.error?.message) {
          setPaymentError(event.error.message);
        } else if (event.complete) {
          setPaymentError(null);
        }
      };

      cardElement.on?.("change", handleCardChange);
      cardElement.mount(cardElementNode);
      cardElementInstanceRef.current = cardElement;
      stripeMountedRef.current = true;
      setPaymentError(null);
      setStripeReady(true);

      return () => {
        cardElement.off?.("change", handleCardChange);
      };
    } catch {
      setPaymentError("Failed to initialize Stripe. Please try again.");
      setStripeReady(false);
    }
  }, [cardElementNode, publishableKey, stripeScriptReady, validPublishableKey, needsStripe]);

  useEffect(() => {
    return () => {
      if (cardElementInstanceRef.current) {
        cardElementInstanceRef.current.unmount();
      }
      cardElementInstanceRef.current = null;
      stripeInstanceRef.current = null;
      stripeMountedRef.current = false;
    };
  }, []);

  // Calculate remaining time on mount and update every second
  useEffect(() => {
    const updateCountdown = () => {
      const now = new Date().getTime();
      const expiresAtTime = new Date(expiresAt).getTime();
      const remaining = Math.ceil((expiresAtTime - now) / 1000);
      setSecondsRemaining(Math.max(0, remaining));
    };

    updateCountdown();
    const interval = setInterval(updateCountdown, 1000);
    return () => clearInterval(interval);
  }, [expiresAt]);

  // Poll order status up to a reasonable timeout to confirm payment completion.
  // If order reaches "complete" or "cancelled", we consider confirmation successful.
  // If timeout is hit, we stop polling and show a clear message to the user.
  const pollOrderStatus = async (maxWaitMs: number = 30000): Promise<boolean> => {
    const pollIntervalMs = 1000;
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitMs) {
      try {
        const res = await fetch(`/api/orders/${orderId}/status`);
        if (!res.ok) {
          // If fetch fails, continue polling (backend may be busy)
          await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
          continue;
        }

        const { order } = await res.json() as { order?: { status: string } };
        if (!order) {
          await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
          continue;
        }

        // If order reached a terminal state, confirm success
        if (order.status === "complete" || order.status === "cancelled") {
          return true;
        }

        // Still processing, wait and retry
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      } catch {
        // Network error, continue polling
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      }
    }

    return false; // Timeout reached
  };

  const handlePayment = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsProcessing(true);
    setPaymentError(null);
    setPaymentFailure(null);
    setPollingNotice(null);
    setLastFailedMethodId(null);

    try {
      const formData = new FormData();
      const attemptedSavedMethodId = !showNewCard && selectedMethodId ? selectedMethodId : null;

      if (!showNewCard && selectedMethodId) {
        // Pay with a saved payment method
        formData.set("savedPaymentMethodId", selectedMethodId);
      } else {
        // Pay with a new card via Stripe
        if (!stripeInstanceRef.current || !cardElementInstanceRef.current) {
          setPaymentError("Stripe is not ready. Please refresh the page.");
          setIsProcessing(false);
          return;
        }

        const result = await stripeInstanceRef.current.createPaymentMethod({
          type: "card",
          card: cardElementInstanceRef.current,
        });

        if (result.error) {
          setPaymentError(result.error.message || "Card validation failed.");
          setIsProcessing(false);
          return;
        }

        if (!result.paymentMethod?.id) {
          setPaymentError("Failed to process card. Please try again.");
          setIsProcessing(false);
          return;
        }

        formData.set("paymentMethodId", result.paymentMethod.id);
      }

      const submitResult = await submitPayment(orderId, initialState, formData);
      if (submitResult.error) {
        setPaymentError(submitResult.error);
        setPaymentFailure(submitResult.error);
        setLastFailedMethodId(attemptedSavedMethodId);
        setIsProcessing(false);
        return;
      }

      // Payment was accepted by the backend. Now poll order status
      // to confirm order completion before refreshing the page.
      const confirmed = await pollOrderStatus();

      if (confirmed) {
        // Order reached terminal state, refresh page to show updated state
        router.refresh();
      } else {
        // Polling timed out, but payment was submitted successfully.
        // Show a clear informational notice and let user know the page can be refreshed shortly.
        setPollingNotice(
          "Payment submitted successfully! The order is being processed. Please refresh the page in a moment to see the updated status."
        );
        setIsProcessing(false);
      }
    } catch (err) {
      setPaymentError(err instanceof Error ? err.message : "An unexpected error occurred.");
      setIsProcessing(false);
    }
  };

  const handleCancel = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsCancelling(true);

    try {
      const formData = new FormData();
      await cancelOrder(orderId, initialState, formData);
    } catch (err) {
      setPaymentError(err instanceof Error ? err.message : "Failed to cancel order.");
      setIsCancelling(false);
    }
  };

  // Whether the Pay button should be enabled
  const canSubmit = showNewCard ? stripeReady && isCardComplete : Boolean(selectedMethodId);

  return (
    <Card>
      <CardContent className="flex flex-col gap-6 pt-4">
        {/* Header */}
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2 text-mute text-sm">
            <CreditCard className="w-4 h-4" />
            Complete Payment
          </div>
          <p className="text-3xl font-semibold tracking-tight text-ink font-mono tabular-nums">
            ${amount.toFixed(2)}
          </p>
        </div>

        {/* Expiry with countdown */}
        <div className="flex items-center gap-3 text-sm">
          <div className="flex flex-col gap-1 flex-1">
            <span className="text-mute">Order expires in:</span>
            {secondsRemaining !== null && (
              <span
                className={`font-mono font-medium text-base transition-colors tabular-nums ${
                  isTimeRunningOut ? "text-bad" : "text-warn"
                }`}
              >
                {formatTimeRemaining(secondsRemaining)}
              </span>
            )}
            <span className="text-xs text-mute">
              {formatUtcDateTime(expiresAt)}
            </span>
          </div>
        </div>

        {/* Error */}
        {paymentError && !showPaymentRecovery && (
          <div
            role="alert"
            className="flex items-start gap-2.5 text-sm text-bad bg-bad-soft rounded px-3 py-2.5"
          >
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{paymentError}</span>
          </div>
        )}

        {/* Polling notice (informational, not an error) */}
        {pollingNotice && (
          <div
            role="status"
            className="flex items-start gap-2.5 text-sm text-warn bg-warn-soft rounded px-3 py-2.5"
          >
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{pollingNotice}</span>
          </div>
        )}

        {showPaymentRecovery && (
          <div className="overflow-hidden rounded-md border border-line bg-card">
            <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-4">
              <span className="flex size-11 items-center justify-center rounded-full border border-bad/20 bg-bad-soft text-bad">
                <AlertCircle className="size-5" />
              </span>
              <div className="space-y-1">
                <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-mute">
                  Card declined
                </p>
                <p className="text-lg font-semibold tracking-tight text-ink">
                  We couldn&apos;t charge your card
                </p>
              </div>
              {secondsRemaining !== null && (
                <span className="ml-auto inline-flex items-center gap-1 rounded-full border border-warn/25 bg-warn-soft px-3 py-1 text-xs font-mono font-semibold text-warn">
                  <AlertCircle className="size-3.5" />
                  {formatTimeRemaining(secondsRemaining)} hold
                </span>
              )}
            </div>

            <div className="space-y-4 px-4 py-4">
              <p className="text-sm leading-6 text-ink">
                Your bank declined the charge. Your seats are still held, so try a different card
                before the timer runs out.
              </p>
              <p className="font-mono text-xs text-mute">{paymentFailure}</p>

              <div className="overflow-hidden rounded-md border border-line">
                {savedPaymentMethods.map((method, index) => {
                  const isFailedMethod = lastFailedMethodId === method.id;
                  return (
                    <div
                      key={method.id}
                      className={`flex items-center gap-3 px-4 py-3 ${
                        isFailedMethod ? "bg-bad-soft" : "bg-card"
                      } ${index < savedPaymentMethods.length - 1 ? "border-b border-line" : ""}`}
                    >
                      <span className="inline-flex min-w-9 items-center justify-center rounded bg-subtle px-1.5 py-0.5 text-[10px] font-bold tracking-wide text-ink">
                        {cardBrandIcon(method.brand)}
                      </span>
                      <div className="flex-1">
                        <p className="text-sm font-medium text-ink">
                          {method.label ?? `•••• ${method.last4}`}
                        </p>
                        {method.expMonth && method.expYear && (
                          <p className="font-mono text-xs text-mute">
                            Exp {method.expMonth}/{method.expYear}
                          </p>
                        )}
                      </div>
                      {isFailedMethod ? (
                        <Badge tone="bad" dot>
                          declined
                        </Badge>
                      ) : (
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedMethodId(method.id);
                            setShowNewCard(false);
                            setPaymentError(null);
                            setPaymentFailure(null);
                            setLastFailedMethodId(null);
                            setPollingNotice(null);
                          }}
                          className="rounded-md bg-accent px-3 py-2 text-xs font-medium text-on-accent transition-colors hover:bg-accent/90"
                        >
                          Try this one
                        </button>
                      )}
                    </div>
                  );
                })}

                <button
                  type="button"
                  onClick={() => {
                    setShowNewCard(true);
                    setSelectedMethodId(null);
                    setPaymentError(null);
                    setPaymentFailure(null);
                    setLastFailedMethodId(null);
                    setPollingNotice(null);
                  }}
                  className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm text-ink transition-colors hover:bg-subtle"
                >
                  <Plus className="size-4 text-mute" />
                  Add a new card
                </button>
              </div>

              <p className="text-xs text-mute">
                If this keeps failing, call your bank — most blocks clear within minutes.
              </p>
            </div>
          </div>
        )}

        {/* ── Saved payment methods ── */}
        {hasSavedMethods && !showNewCard && !showPaymentRecovery && (
          <div className="flex flex-col gap-2">
            <label className="text-sm font-medium text-ink">Payment Method</label>
            <div className="flex flex-col gap-2">
              {savedPaymentMethods.map((method) => (
                <button
                  key={method.id}
                  type="button"
                  onClick={() => {
                    setSelectedMethodId(method.id);
                    setPaymentError(null);
                    setPaymentFailure(null);
                    setLastFailedMethodId(null);
                  }}
                  className={`flex items-center gap-3 rounded border px-4 py-3 text-left transition-colors ${
                    selectedMethodId === method.id
                      ? "border-accent bg-accent/10 text-ink"
                      : "border-line bg-subtle text-mute hover:border-accent/50"
                  }`}
                >
                  {/* Brand badge */}
                  <span className="inline-flex items-center justify-center rounded px-1.5 py-0.5 text-[10px] font-bold tracking-wide bg-subtle text-ink min-w-9">
                    {cardBrandIcon(method.brand)}
                  </span>
                  <span className="flex-1 text-sm font-medium">
                    {method.label ?? `•••• ${method.last4}`}
                  </span>
                  {method.isDefault && (
                    <span className="text-[10px] font-semibold uppercase tracking-wide text-accent bg-accent/10 rounded px-1.5 py-0.5">
                      Default
                    </span>
                  )}
                  <span className="text-xs text-mute font-mono tabular-nums">
                    {method.expMonth}/{method.expYear}
                  </span>
                  {/* Selected indicator */}
                  <span
                    className={`w-4 h-4 rounded-full border-2 shrink-0 transition-colors ${
                      selectedMethodId === method.id
                        ? "border-accent bg-accent"
                        : "border-line bg-transparent"
                    }`}
                  />
                </button>
              ))}
            </div>

            {/* Use a new card instead */}
            <button
              type="button"
              onClick={() => {
                setShowNewCard(true);
                setSelectedMethodId(null);
                setPaymentError(null);
                setPaymentFailure(null);
                setLastFailedMethodId(null);
                setPollingNotice(null);
              }}
              className="flex items-center gap-1.5 text-xs text-mute hover:text-ink transition-colors mt-1 self-start"
            >
              <Plus className="w-3 h-3" />
              Use a new card instead
            </button>
          </div>
        )}

        {/* ── New card entry (Stripe element) ── */}
        {showNewCard && (
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <label htmlFor="card-element" className="text-sm font-medium text-ink">
                Card Details
              </label>
              {hasSavedMethods && (
                <button
                  type="button"
                  onClick={() => {
                    setShowNewCard(false);
                    setSelectedMethodId(defaultMethod?.id ?? savedPaymentMethods[0]?.id ?? null);
                    setPaymentError(null);
                    setPaymentFailure(null);
                    setLastFailedMethodId(null);
                    setPollingNotice(null);
                  }}
                  className="flex items-center gap-1 text-xs text-mute hover:text-ink transition-colors"
                >
                  <ChevronDown className="w-3 h-3" />
                  Use saved card
                </button>
              )}
            </div>
            <div className="relative">
              <div
                id="card-element"
                ref={(node) => setCardElementNode(node)}
                className="border border-line rounded px-4 py-3 bg-subtle focus-within:bg-card focus-within:border-accent transition-colors min-h-12"
              />
              {!stripeReady && (
                <div className="absolute inset-0 flex items-center justify-center gap-2 text-sm text-mute bg-card/80 rounded">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Loading payment form...
                </div>
              )}
            </div>
            {stripeReady && !isCardComplete && !paymentError && (
              <p className="text-sm text-mute mt-2">
                Please complete your card details, including CVC, before paying.
              </p>
            )}
          </div>
        )}

        {/* Security note */}
        <div className="flex items-center gap-2 text-xs text-mute bg-subtle rounded px-3 py-2.5 border border-line">
          <Lock className="w-3.5 h-3.5 text-accent shrink-0" />
          Your payment is processed securely. We never store raw card details.
        </div>

        {/* Actions */}
        <div className="flex flex-col gap-2">
          <button
            onClick={handlePayment}
            disabled={isPending || !canSubmit}
            className="w-full gap-2 bg-accent hover:bg-accent/90 disabled:opacity-50 disabled:cursor-not-allowed text-on-accent rounded px-4 py-2.5 font-medium flex items-center justify-center transition-colors"
          >
            {isProcessing ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Processing…
              </>
            ) : (
              <>
                <CreditCard className="w-4 h-4" />
                Pay Now
              </>
            )}
          </button>

          <button
            onClick={handleCancel}
            disabled={isPending}
            className="w-full gap-2 text-mute hover:text-bad hover:bg-bad-soft disabled:opacity-50 disabled:cursor-not-allowed rounded px-4 py-2.5 font-medium flex items-center justify-center transition-colors"
          >
            {isCancelling ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Cancelling…
              </>
            ) : (
              <>
                <X className="w-4 h-4" />
                Cancel Order
              </>
            )}
          </button>
          <Link
            href={`/orders/${orderId}/transfer`}
            className="w-full text-center text-xs text-mute underline-offset-2 hover:underline"
          >
            Send to friend instead
          </Link>
          <Link
            href={`/orders/${orderId}/refund`}
            className="w-full text-center text-xs text-mute underline-offset-2 hover:underline"
          >
            Request refund
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}
