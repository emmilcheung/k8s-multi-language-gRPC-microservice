// __tests__/auth-form.test.tsx — Component tests for AuthForm.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AuthForm } from "@/components/auth-form";
import type { AuthState } from "@/app/actions/auth";

// Next.js Link uses the router; mock it as a plain anchor for jsdom.
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode; [key: string]: unknown }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

// useActionState: mock to return [state, formAction, pending].
// We expose a setter so individual tests can control state.
let mockState: AuthState = {};
let mockPending = false;
const mockFormAction = vi.fn();

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useActionState: (_action: unknown, _initialState: unknown) => [
      mockState,
      mockFormAction,
      mockPending,
    ],
  };
});

describe("AuthForm — signup mode", () => {
  const noopAction = async (_prev: AuthState, _fd: FormData): Promise<AuthState> => ({});

  beforeEach(() => {
    mockState = {};
    mockPending = false;
    mockFormAction.mockClear();
  });

  it("renders email and password fields", () => {
    render(<AuthForm mode="signup" action={noopAction} />);
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
  });

  it("renders the Sign Up submit button", () => {
    render(<AuthForm mode="signup" action={noopAction} />);
    expect(screen.getByRole("button", { name: /sign up/i })).toBeInTheDocument();
  });

  it("shows a link to sign in page", () => {
    render(<AuthForm mode="signup" action={noopAction} />);
    expect(screen.getByRole("link", { name: /sign in/i })).toHaveAttribute(
      "href",
      "/auth/signin"
    );
  });

  it("displays an error message when state.error is set", () => {
    mockState = { error: "Email already in use." };
    render(<AuthForm mode="signup" action={noopAction} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Email already in use.");
  });

  it("disables the submit button when pending is true", () => {
    mockPending = true;
    render(<AuthForm mode="signup" action={noopAction} />);
    expect(screen.getByRole("button", { name: /please wait/i })).toBeDisabled();
  });
});

describe("AuthForm — signin mode", () => {
  const noopAction = async (_prev: AuthState, _fd: FormData): Promise<AuthState> => ({});

  beforeEach(() => {
    mockState = {};
    mockPending = false;
  });

  it("renders the Sign In submit button", () => {
    render(<AuthForm mode="signin" action={noopAction} />);
    expect(screen.getByRole("button", { name: /sign in/i })).toBeInTheDocument();
  });

  it("shows a link to sign up page", () => {
    render(<AuthForm mode="signin" action={noopAction} />);
    expect(screen.getByRole("link", { name: /sign up/i })).toHaveAttribute(
      "href",
      "/auth/signup"
    );
  });

  it("does not render an alert when there is no error", () => {
    render(<AuthForm mode="signin" action={noopAction} />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
