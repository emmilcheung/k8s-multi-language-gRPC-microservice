import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ActivatePlanButton } from "@/components/activate-plan-button";
import { DeactivatePlanButton } from "@/components/deactivate-plan-button";

describe("plan action buttons", () => {
  it("posts to the activate route and reloads on success", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({}),
    });
    vi.stubGlobal("fetch", fetchMock);
    const reloadMock = vi.fn();
    vi.stubGlobal("location", { reload: reloadMock });

    const user = userEvent.setup();

    render(<ActivatePlanButton planId="plan-1" />);

    await user.click(screen.getByRole("button", { name: /activate plan/i }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/seating-plans/plan-1/activate",
        expect.objectContaining({ method: "POST" })
      )
    );
    await waitFor(() => expect(reloadMock).toHaveBeenCalledTimes(1));
  });

  it("renders route errors for deactivate", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      json: vi.fn().mockResolvedValue({ error: { message: "Failed to deactivate plan." } }),
    }));

    const user = userEvent.setup();

    render(<DeactivatePlanButton planId="plan-2" />);

    await user.click(screen.getByRole("button", { name: /deactivate plan/i }));

    await waitFor(() => expect(screen.getByText("Failed to deactivate plan.")).toBeVisible());
  });
});
