import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AuthForm } from "@/components/auth-form";
import type { AuthState } from "@/app/actions/auth";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode; [key: string]: unknown }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

describe("AuthForm", () => {
  it("submits signup form values via action", async () => {
    const user = userEvent.setup();
    const signupAction = vi.fn(async (prev: AuthState, formData: FormData): Promise<AuthState> => {
      void prev;
      void formData;
      return {};
    });

    render(<AuthForm mode="signup" action={signupAction} />);

    await user.type(screen.getByLabelText(/email/i), "user@example.com");
    await user.type(screen.getByLabelText(/password/i), "password123");
    await user.click(screen.getByRole("button", { name: /sign up/i }));

    await waitFor(() => expect(signupAction).toHaveBeenCalledTimes(1));
    const [, formData] = signupAction.mock.calls[0] as [AuthState, FormData];
    expect(formData.get("email")).toBe("user@example.com");
    expect(formData.get("password")).toBe("password123");
  });

  it("renders signin mode and submits credentials", async () => {
    const user = userEvent.setup();
    const signinAction = vi.fn(async (prev: AuthState, formData: FormData): Promise<AuthState> => {
      void prev;
      void formData;
      return {};
    });

    render(<AuthForm mode="signin" action={signinAction} />);

    expect(screen.getByRole("link", { name: /sign up/i })).toHaveAttribute("href", "/auth/signup");

    await user.type(screen.getByLabelText(/email/i), "user@example.com");
    await user.type(screen.getByLabelText(/password/i), "secret");
    await user.click(screen.getByRole("button", { name: /sign in/i }));

    await waitFor(() => expect(signinAction).toHaveBeenCalledTimes(1));
  });
});
