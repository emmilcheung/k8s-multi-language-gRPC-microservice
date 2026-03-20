// __tests__/ticket-form.test.tsx — Component tests for TicketForm.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { TicketForm } from "@/components/ticket-form";
import type { TicketState } from "@/app/actions/tickets";

let mockState: TicketState = {};
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

const noopAction = async (_prev: TicketState, _fd: FormData): Promise<TicketState> => ({});

describe("TicketForm", () => {
  beforeEach(() => {
    mockState = {};
    mockPending = false;
    mockFormAction.mockClear();
  });

  it("renders title and price inputs", () => {
    render(<TicketForm action={noopAction} />);
    expect(screen.getByLabelText(/title/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/price/i)).toBeInTheDocument();
  });

  it("renders with default submitLabel", () => {
    render(<TicketForm action={noopAction} />);
    expect(screen.getByRole("button", { name: /create ticket/i })).toBeInTheDocument();
  });

  it("renders custom submitLabel", () => {
    render(<TicketForm action={noopAction} submitLabel="Update Ticket" />);
    expect(screen.getByRole("button", { name: /update ticket/i })).toBeInTheDocument();
  });

  it("pre-fills defaultTitle and defaultPrice", () => {
    render(<TicketForm action={noopAction} defaultTitle="Rock Concert" defaultPrice={49.99} />);
    expect(screen.getByLabelText(/title/i)).toHaveValue("Rock Concert");
    expect(screen.getByLabelText(/price/i)).toHaveValue(49.99);
  });

  it("shows error alert when state.error is set", () => {
    mockState = { error: "Title is required." };
    render(<TicketForm action={noopAction} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Title is required.");
  });

  it("disables submit button while pending", () => {
    mockPending = true;
    render(<TicketForm action={noopAction} />);
    expect(screen.getByRole("button", { name: /saving/i })).toBeDisabled();
  });
});
