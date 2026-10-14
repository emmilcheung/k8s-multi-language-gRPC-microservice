import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
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

const getNavAccessMock = vi.fn();
vi.mock("@/app/actions/accounts", () => ({
  getNavAccess: () => getNavAccessMock(),
}));

function signIn() {
  document.cookie = "logged_in=1; path=/";
}

describe("NavBar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.cookie = "logged_in=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
  });

  it("does not show scanner navigation globally", () => {
    render(<NavBar />);

    expect(screen.queryByRole("link", { name: /scanner/i })).not.toBeInTheDocument();
  });

  it("shows the organizer console only to members of an organizer account", async () => {
    signIn();
    getNavAccessMock.mockResolvedValue({ organizer: true, admin: false });

    render(<NavBar />);

    await waitFor(() =>
      expect(screen.getAllByRole("link", { name: /organizer console/i }).length).toBeGreaterThan(0),
    );
    expect(screen.getAllByRole("link", { name: /^sell$/i }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("link", { name: /^venues$/i }).length).toBeGreaterThan(0);
    expect(screen.queryByRole("link", { name: /become an organizer/i })).not.toBeInTheDocument();
  });

  it("hides Sell, Venues and the console from a signed-in user who belongs to no account, and offers to create one", async () => {
    signIn();
    getNavAccessMock.mockResolvedValue({ organizer: false, admin: false });

    render(<NavBar />);

    await waitFor(() =>
      expect(screen.getAllByRole("link", { name: /become an organizer/i }).length).toBeGreaterThan(0),
    );
    expect(screen.queryByRole("link", { name: /^sell$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /^venues$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /organizer console/i })).not.toBeInTheDocument();
  });

  it("shows the admin area only to platform admins", async () => {
    signIn();
    getNavAccessMock.mockResolvedValue({ organizer: false, admin: true });

    render(<NavBar />);

    await waitFor(() =>
      expect(screen.getAllByRole("link", { name: /^admin$/i }).length).toBeGreaterThan(0),
    );
  });

  it("does not show the admin area to anyone else", async () => {
    signIn();
    getNavAccessMock.mockResolvedValue({ organizer: true, admin: false });

    render(<NavBar />);

    await waitFor(() => expect(getNavAccessMock).toHaveBeenCalled());
    expect(screen.queryByRole("link", { name: /^admin$/i })).not.toBeInTheDocument();
  });
});
