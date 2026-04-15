"use client";
// components/order-payment-form.tsx — Stripe Payment Element Client Component.
// Shows saved payment methods (default pre-selected) with a fallback to entering a new card.

import { useEffect, useState, useRef } from "react";
import { useRouter } from "next/navigation";
import { Lock, AlertCircle, CreditCard, Loader2, X, Clock, ChevronDown, Plus } from "lucide-react";
import { cancelOrder } from "@/app/actions/orders";
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
  const [isProcessing, setIsProcessing] = useState(false);
  const [stripeReady, setStripeReady] = useState(false);
  const [stripeScriptReady, setStripeScriptReady] = useState(false);
  const [isCardComplete, setIsCardComplete] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [cardElementNode, setCardElementNode] = useState<HTMLDivElement | null>(null);
  const stripeInstanceRef = useRef<StripeInstance | null>(null);
  const cardElementInstanceRef = useRef<CardElement | null>(null);
  const stripeMountedRef = useRef(false);

  const router = useRouter();
  const isTimeRunningOut = secondsRemaining !== null && secondsRemaining < 60;
  const isPending = isProcessing || isCancelling;
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

  const handlePayment = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsProcessing(true);
    setPaymentError(null);

    try {
      let body: Record<string, string>;

      if (!showNewCard && selectedMethodId) {
        // Pay with a saved payment method
        body = { orderId, savedPaymentMethodId: selectedMethodId };
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

        body = { orderId, paymentMethodId: result.paymentMethod.id };
      }

      const res = await fetch("/api/submit-payment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const resBody = await res.json().catch(() => ({}));
        setPaymentError(resBody?.error?.message ?? "Payment failed.");
        setIsProcessing(false);
        return;
      }

      router.refresh();
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
    <div className="glass rounded-2xl w-full p-8 flex flex-col gap-6">
      {/* Header */}
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2 text-muted-foreground text-sm">
          <CreditCard className="w-4 h-4" />
          Complete Payment
        </div>
        <p className="text-4xl font-bold tracking-tight gradient-text">
          ${amount.toFixed(2)}
        </p>
      </div>

      <div className="h-px bg-white/6" />

      {/* Expiry with countdown */}
      <div className="flex items-center gap-3 text-sm">
        <Clock
          className={`w-4 h-4 shrink-0 transition-colors ${
            isTimeRunningOut ? "text-red-400/70" : "text-amber-400/70"
          }`}
        />
        <div className="flex flex-col gap-1">
          <span className="text-muted-foreground">Order expires in:</span>
          {secondsRemaining !== null && (
            <span
              className={`font-mono font-bold text-base transition-colors ${
                isTimeRunningOut ? "text-red-400/90" : "text-amber-400/90"
              }`}
            >
              {formatTimeRemaining(secondsRemaining)}
            </span>
          )}
          <span className="text-xs text-muted-foreground">
            {formatUtcDateTime(expiresAt)}
          </span>
        </div>
      </div>

      {/* Error */}
      {paymentError && (
        <div
          role="alert"
          className="flex items-start gap-2.5 text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-xl px-3 py-2.5"
        >
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>{paymentError}</span>
        </div>
      )}

      {/* ── Saved payment methods ── */}
      {hasSavedMethods && !showNewCard && (
        <div className="flex flex-col gap-2">
          <label className="text-sm font-medium text-foreground">Payment Method</label>
          <div className="flex flex-col gap-2">
            {savedPaymentMethods.map((method) => (
              <button
                key={method.id}
                type="button"
                onClick={() => setSelectedMethodId(method.id)}
                className={`flex items-center gap-3 rounded-lg border px-4 py-3 text-left transition-colors ${
                  selectedMethodId === method.id
                    ? "border-primary/60 bg-primary/10 text-foreground"
                    : "border-white/10 bg-white/3 text-muted-foreground hover:border-white/20 hover:bg-white/5"
                }`}
              >
                {/* Brand badge */}
                <span className="inline-flex items-center justify-center rounded px-1.5 py-0.5 text-[10px] font-bold tracking-wide bg-white/10 text-foreground min-w-9">
                  {cardBrandIcon(method.brand)}
                </span>
                <span className="flex-1 text-sm font-medium">
                  {method.label ?? `•••• ${method.last4}`}
                </span>
                {method.isDefault && (
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-primary/80 bg-primary/10 rounded px-1.5 py-0.5">
                    Default
                  </span>
                )}
                <span className="text-xs text-muted-foreground">
                  {method.expMonth}/{method.expYear}
                </span>
                {/* Selected indicator */}
                <span
                  className={`w-4 h-4 rounded-full border-2 shrink-0 transition-colors ${
                    selectedMethodId === method.id
                      ? "border-primary bg-primary"
                      : "border-white/20 bg-transparent"
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
            }}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors mt-1 self-start"
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
            <label htmlFor="card-element" className="text-sm font-medium text-foreground">
              Card Details
            </label>
            {hasSavedMethods && (
              <button
                type="button"
                onClick={() => {
                  setShowNewCard(false);
                  setSelectedMethodId(defaultMethod?.id ?? savedPaymentMethods[0]?.id ?? null);
                }}
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
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
              className="border border-white/10 rounded-lg px-4 py-3 bg-white/3 focus-within:bg-white/5 focus-within:border-primary/50 transition-colors min-h-12"
            />
            {!stripeReady && (
              <div className="absolute inset-0 flex items-center justify-center gap-2 text-sm text-muted-foreground bg-card/80 rounded-lg">
                <Loader2 className="w-4 h-4 animate-spin" />
                Loading payment form...
              </div>
            )}
          </div>
          {stripeReady && !isCardComplete && !paymentError && (
            <p className="text-sm text-muted-foreground mt-2">
              Please complete your card details, including CVC, before paying.
            </p>
          )}
        </div>
      )}

      {/* Security note */}
      <div className="flex items-center gap-2 text-xs text-muted-foreground bg-white/3 rounded-xl px-3 py-2.5 border border-white/6">
        <Lock className="w-3.5 h-3.5 text-primary/60 shrink-0" />
        Your payment is processed securely. We never store raw card details.
      </div>

      {/* Actions */}
      <div className="flex flex-col gap-2">
        <button
          onClick={handlePayment}
          disabled={isPending || !canSubmit}
          className="w-full gap-2 bg-primary hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed text-primary-foreground rounded-lg px-4 py-2.5 font-medium flex items-center justify-center transition-colors"
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
          className="w-full gap-2 text-muted-foreground hover:text-destructive hover:bg-destructive/10 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg px-4 py-2.5 font-medium flex items-center justify-center transition-colors"
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
      </div>
    </div>
  );
}
