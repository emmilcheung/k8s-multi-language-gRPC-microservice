"use client";
// components/order-payment-form.tsx — Stripe Payment Element Client Component.
// Glass card with large amount display, lock icon security note, Stripe card input, and action buttons.

import { useEffect, useState, useRef } from "react";
import { Lock, AlertCircle, CreditCard, Loader2, X, Clock } from "lucide-react";
import { cancelOrder } from "@/app/actions/orders";
import type { OrderState } from "@/app/actions/orders";

interface CardElement {
  mount(container: HTMLElement | string): void;
  unmount(): void;
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

interface OrderPaymentFormProps {
  orderId: string;
  amount: number;
  expiresAt: string;
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

export function OrderPaymentForm({ orderId, amount, expiresAt }: OrderPaymentFormProps) {
  const [secondsRemaining, setSecondsRemaining] = useState<number | null>(null);
  const [paymentError, setPaymentError] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [stripeReady, setStripeReady] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const cardElementRef = useRef<HTMLDivElement>(null);
  const stripeInstanceRef = useRef<StripeInstance | null>(null);
  const cardElementInstanceRef = useRef<CardElement | null>(null);

  const isTimeRunningOut = secondsRemaining !== null && secondsRemaining < 60;
  const isPending = isProcessing || isCancelling;

  // Load Stripe.js and initialize Payment Element
  useEffect(() => {
    const initializeStripe = async () => {
      // Load Stripe.js from CDN
      const stripeWindow = window as unknown as { Stripe?: unknown };
      if (stripeWindow.Stripe) {
        initStripe();
        return;
      }

      const script = document.createElement("script");
      script.src = "https://js.stripe.com/v3/";
      script.async = true;
      script.onload = initStripe;
      script.onerror = () => {
        setPaymentError("Failed to load Stripe. Please check your internet connection.");
      };
      document.head.appendChild(script);
    };

    const initStripe = () => {
      const publishableKey = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
      if (!publishableKey) {
        setPaymentError("Stripe configuration is missing. Please contact support.");
        return;
      }

      const stripeWindow = window as unknown as { Stripe?: (key: string) => StripeInstance | null };
      const stripe = stripeWindow.Stripe?.(publishableKey);
      if (!stripe) {
        setPaymentError("Failed to initialize Stripe. Please try again.");
        return;
      }

      stripeInstanceRef.current = stripe;

      // Create card element
      if (cardElementRef.current) {
        const elements = stripe.elements();
        const cardElement = elements.create("card", {
          style: {
            base: {
              fontSize: "14px",
              color: "#e5e7eb",
              "::placeholder": {
                color: "#6b7280",
              },
              backgroundColor: "transparent",
            },
            invalid: {
              color: "#ef4444",
            },
          },
        });

        cardElement.mount(cardElementRef.current);
        cardElementInstanceRef.current = cardElement;
        setStripeReady(true);
      }
    };

    initializeStripe();

    return () => {
      // Cleanup: unmount card element on unmount
      if (cardElementInstanceRef.current) {
        cardElementInstanceRef.current.unmount();
      }
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

    updateCountdown(); // Set initial value immediately
    const interval = setInterval(updateCountdown, 1000);
    return () => clearInterval(interval);
  }, [expiresAt]);

  const handlePayment = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!stripeInstanceRef.current || !cardElementInstanceRef.current) {
      setPaymentError("Stripe is not ready. Please refresh the page.");
      return;
    }

    setIsProcessing(true);
    setPaymentError(null);

    try {
      // Create a PaymentMethod from the card details
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

      const paymentMethodId = result.paymentMethod.id;

      // Submit payment to backend via API route
      const res = await fetch("/api/submit-payment", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          orderId,
          paymentMethodId,
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setPaymentError(body?.error?.message ?? "Payment failed.");
        setIsProcessing(false);
        return;
      }

      // Success - redirect to order page
      window.location.href = `/orders/${orderId}`;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "An unexpected error occurred.";
      setPaymentError(errorMessage);
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
      const errorMessage = err instanceof Error ? err.message : "Failed to cancel order.";
      setPaymentError(errorMessage);
      setIsCancelling(false);
    }
  };

  return (
    <div className="glass rounded-2xl w-full p-8 flex flex-col gap-6">
      {/* Header */}
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2 text-muted-foreground text-sm">
          <CreditCard className="w-4 h-4" />
          Complete Payment
        </div>
        {/* Big amount */}
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

      {/* Card Element */}
      {stripeReady && (
        <div className="flex flex-col gap-2">
          <label htmlFor="card-element" className="text-sm font-medium text-foreground">
            Card Details
          </label>
          <div
            id="card-element"
            ref={cardElementRef}
            className="border border-white/10 rounded-lg px-4 py-3 bg-white/3 focus-within:bg-white/5 focus-within:border-primary/50 transition-colors"
          />
        </div>
      )}

      {/* Loading state while Stripe loads */}
      {!stripeReady && (
        <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground py-8">
          <Loader2 className="w-4 h-4 animate-spin" />
          Loading payment form...
        </div>
      )}

      {/* Security note */}
      <div className="flex items-center gap-2 text-xs text-muted-foreground bg-white/3 rounded-xl px-3 py-2.5 border border-white/6">
        <Lock className="w-3.5 h-3.5 text-primary/60 shrink-0" />
        Your payment is processed securely. We never store card details.
      </div>

      {/* Actions */}
      <div className="flex flex-col gap-2">
        <button
          onClick={handlePayment}
          disabled={isPending || !stripeReady}
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
