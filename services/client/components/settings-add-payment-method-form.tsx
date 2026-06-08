"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  registerPaymentMethodFormAction,
  type PaymentMethodActionResult,
} from "@/app/actions/settings";
import type { SavedPaymentMethod } from "@/lib/types";

interface CardElement {
  mount(container: HTMLElement | string): void;
  unmount(): void;
  on?: (
    event: "change",
    handler: (event: { error?: { message?: string }; complete: boolean }) => void
  ) => void;
  off?: (
    event: "change",
    handler: (event: { error?: { message?: string }; complete: boolean }) => void
  ) => void;
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

const CARD_SAVE_CONSENT_VERSION = "settings-card-save-v1";

interface SettingsAddPaymentMethodFormProps {
  onSaved?: (paymentMethod: SavedPaymentMethod) => void;
}

export function SettingsAddPaymentMethodForm({ onSaved }: SettingsAddPaymentMethodFormProps) {
  void onSaved;
  const [serverState, formAction, actionPending] = useActionState<PaymentMethodActionResult, FormData>(
    registerPaymentMethodFormAction,
    {}
  );
  const [stripeScriptReady, setStripeScriptReady] = useState(false);
  const [stripeReady, setStripeReady] = useState(false);
  const [isCardComplete, setIsCardComplete] = useState(false);
  const [isPreparingSubmission, setIsPreparingSubmission] = useState(false);
  const [setAsDefault, setSetAsDefault] = useState(true);
  const [consentChecked, setConsentChecked] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [cardElementNode, setCardElementNode] = useState<HTMLDivElement | null>(null);

  const serverActionFormRef = useRef<HTMLFormElement | null>(null);
  const providerPaymentMethodIdRef = useRef<HTMLInputElement | null>(null);
  const setAsDefaultRef = useRef<HTMLInputElement | null>(null);
  const consentAcceptedRef = useRef<HTMLInputElement | null>(null);
  const consentVersionRef = useRef<HTMLInputElement | null>(null);
  const stripeInstanceRef = useRef<StripeInstance | null>(null);
  const cardElementInstanceRef = useRef<CardElement | null>(null);
  const stripeMountedRef = useRef(false);

  const publishableKey = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY?.trim();
  const validPublishableKey = Boolean(publishableKey && publishableKey.startsWith("pk_"));

  useEffect(() => {
    let disposed = false;

    const handleReady = () => {
      if (!disposed) {
        setStripeScriptReady(true);
      }
    };

    const handleError = () => {
      if (!disposed) {
        setErrorMessage("Failed to load Stripe. Please check your connection.");
      }
    };

    const stripeWindow = window as unknown as { Stripe?: StripeConstructor };
    if (stripeWindow.Stripe) {
      handleReady();
      return () => {
        disposed = true;
      };
    }

    const existingScript = document.querySelector<HTMLScriptElement>(
      'script[src="https://js.stripe.com/v3/"]'
    );
    const script = existingScript ?? document.createElement("script");

    script.addEventListener("load", handleReady);
    script.addEventListener("error", handleError);

    if (!existingScript) {
      script.src = "https://js.stripe.com/v3/";
      script.async = true;
      document.head.appendChild(script);
    }

    return () => {
      disposed = true;
      script.removeEventListener("load", handleReady);
      script.removeEventListener("error", handleError);
    };
  }, []);

  useEffect(() => {
    if (stripeMountedRef.current || !stripeScriptReady || !cardElementNode) {
      return;
    }

    if (!validPublishableKey || !publishableKey) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setErrorMessage(
        "Stripe publishable key is missing or invalid. Check NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY."
      );
      return;
    }

    const stripeWindow = window as unknown as { Stripe?: StripeConstructor };
    const stripe = stripeWindow.Stripe?.(publishableKey);
    if (!stripe) {
      setErrorMessage("Failed to initialize Stripe.");
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
            color: "#111827",
            "::placeholder": {
              color: "#6b7280",
            },
          },
          invalid: {
            color: "#ef4444",
          },
        },
      });

      const handleCardChange = (event: {
        error?: { message?: string };
        complete: boolean;
      }) => {
        setIsCardComplete(event.complete);
        if (event.error?.message) {
          setErrorMessage(event.error.message);
        } else if (event.complete) {
          setErrorMessage(null);
        }
      };

      cardElement.on?.("change", handleCardChange);
      cardElement.mount(cardElementNode);
      cardElementInstanceRef.current = cardElement;
      stripeMountedRef.current = true;
      setStripeReady(true);

      return () => {
        cardElement.off?.("change", handleCardChange);
      };
    } catch {
      setErrorMessage("Failed to initialize Stripe.");
    }
  }, [cardElementNode, stripeScriptReady, validPublishableKey, publishableKey]);

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

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();

    if (!consentChecked) {
      setErrorMessage("Please consent to saving your payment method for future use.");
      return;
    }

    if (!stripeInstanceRef.current || !cardElementInstanceRef.current) {
      setErrorMessage("Stripe is not ready. Please refresh and try again.");
      return;
    }

    setIsPreparingSubmission(true);
    setErrorMessage(null);

    try {
      const stripeResult = await stripeInstanceRef.current.createPaymentMethod({
        type: "card",
        card: cardElementInstanceRef.current,
      });

      if (stripeResult.error) {
        setErrorMessage(stripeResult.error.message || "Card validation failed.");
        setIsPreparingSubmission(false);
        return;
      }

      if (!stripeResult.paymentMethod?.id) {
        setErrorMessage("Failed to register card. Please try again.");
        setIsPreparingSubmission(false);
        return;
      }

      if (
        !providerPaymentMethodIdRef.current ||
        !setAsDefaultRef.current ||
        !consentAcceptedRef.current ||
        !consentVersionRef.current
      ) {
        setErrorMessage("Failed to prepare payment method submission.");
        setIsPreparingSubmission(false);
        return;
      }

      providerPaymentMethodIdRef.current.value = stripeResult.paymentMethod.id;
      setAsDefaultRef.current.value = String(setAsDefault);
      consentAcceptedRef.current.value = String(consentChecked);
      consentVersionRef.current.value = CARD_SAVE_CONSENT_VERSION;
      serverActionFormRef.current?.requestSubmit();
      setIsPreparingSubmission(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unexpected error occurred.";
      setErrorMessage(message);
      setIsPreparingSubmission(false);
    }
  };

  const isSubmitting = isPreparingSubmission || actionPending;
  const displayedError = errorMessage ?? serverState.error ?? null;

  return (
    <>
      <form onSubmit={handleSubmit} className="rounded border border-line p-3 space-y-3">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-mute">
          Add card
        </p>

        <div
          ref={setCardElementNode}
          className="rounded border border-line bg-subtle px-3 py-2 min-h-10"
        />

        <label
          htmlFor="settings-default-method-checkbox"
          className="flex items-center gap-2 text-sm text-mute"
        >
          <input
            id="settings-default-method-checkbox"
            type="checkbox"
            checked={setAsDefault}
            onChange={(event) => setSetAsDefault(event.target.checked)}
            className="size-4 rounded border-line bg-subtle"
          />
          Set as default payment method
        </label>

        <label
          htmlFor="settings-save-consent-checkbox"
          className="flex items-start gap-2 text-sm text-mute"
        >
          <input
            id="settings-save-consent-checkbox"
            type="checkbox"
            checked={consentChecked}
            onChange={(event) => setConsentChecked(event.target.checked)}
            className="size-4 rounded border-line bg-subtle mt-0.5"
          />
          <span>
            I consent to saving this payment method for future charges in accordance with the
            platform terms.
          </span>
        </label>

        {displayedError ? <p className="text-sm text-destructive">{displayedError}</p> : null}
        <Button
          type="submit"
          size="sm"
          disabled={!stripeReady || !isCardComplete || isSubmitting || !consentChecked}
        >
          {isSubmitting ? (
            <span className="inline-flex items-center gap-1.5">
              <Loader2 className="size-4 animate-spin" />
              Saving...
            </span>
          ) : (
            "Save payment method"
          )}
        </Button>
      </form>

      <form ref={serverActionFormRef} action={formAction} className="hidden" aria-hidden="true">
        <input ref={providerPaymentMethodIdRef} type="hidden" name="providerPaymentMethodId" defaultValue="" />
        <input ref={setAsDefaultRef} type="hidden" name="setAsDefault" defaultValue="false" />
        <input ref={consentAcceptedRef} type="hidden" name="consentAccepted" defaultValue="false" />
        <input ref={consentVersionRef} type="hidden" name="consentVersion" defaultValue="" />
      </form>
    </>
  );
}
