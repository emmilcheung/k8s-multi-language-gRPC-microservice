import { expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { SaveEventButton } from "@/app/tickets/[ticketId]/_components/save-event-button";
import * as actions from "@/app/actions/saved-events";

vi.mock("@/app/actions/saved-events");

it("shows Saved when the event is already saved", async () => {
  vi.mocked(actions.getSavedState).mockResolvedValue({ savedByMe: true });
  render(<SaveEventButton eventId="e1" />);
  await waitFor(() => expect(screen.getByText("Saved")).toBeInTheDocument());
});

it("shows Save event when not saved", async () => {
  vi.mocked(actions.getSavedState).mockResolvedValue({ savedByMe: false });
  render(<SaveEventButton eventId="e1" />);
  await waitFor(() => expect(screen.getByText("Save event")).toBeInTheDocument());
});
