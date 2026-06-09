import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { NavBar } from "@/components/nav-bar";

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
    [key: string]: unknown;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock("@/app/actions/auth", () => ({
  signout: vi.fn(),
}));

describe("NavBar", () => {
  it("does not show scanner navigation globally", () => {
    render(<NavBar />);

    expect(screen.queryByRole("link", { name: /scanner/i })).not.toBeInTheDocument();
  });
});
