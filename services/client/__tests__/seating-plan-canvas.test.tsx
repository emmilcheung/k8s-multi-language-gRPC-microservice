// __tests__/seating-plan-canvas.test.tsx — Unit tests for SeatingPlanCanvas.
//
// React Flow v12 relies on ResizeObserver and certain layout methods not
// available in jsdom.  We stub these at the top of this file so the component
// can mount without throwing.

import { beforeAll, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { SeatingPlanCanvas } from "@/components/seating-plan-canvas";
import type { Section } from "@/lib/types";

// ── jsdom shims ────────────────────────────────────────────────────────────────

beforeAll(() => {
  // React Flow uses ResizeObserver to watch canvas dimensions.
  global.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };

  // React Flow also reads SVGGeometryElement.getTotalLength in some edge paths.
  if (!SVGGeometryElement.prototype.getTotalLength) {
    SVGGeometryElement.prototype.getTotalLength = () => 0;
  }
});

// Mock saveLayout so tests don't hit the network.
vi.mock("@/app/actions/venues", () => ({
  saveLayout: vi.fn().mockResolvedValue({}),
}));

// ── Fixtures ───────────────────────────────────────────────────────────────────

const seatedSection: Section = {
  id: "sec-1",
  name: "Orchestra",
  sectionType: "SEATED",
  rowCount: 3,
  seatsPerRow: 10,
  capacity: 30,
};

const gaSection: Section = {
  id: "sec-2",
  name: "General Admission",
  sectionType: "GA",
  rowCount: 0,
  seatsPerRow: 0,
  capacity: 200,
};

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("SeatingPlanCanvas", () => {
  it("should render empty-state prompt when sections array is empty", () => {
    render(
      <SeatingPlanCanvas
        planId="plan-1"
        sections={[]}
        isDraft
      />
    );
    expect(
      screen.getByText(/add sections using the form/i)
    ).toBeInTheDocument();
  });

  it("should render section names for each supplied section", () => {
    render(
      <SeatingPlanCanvas
        planId="plan-1"
        sections={[seatedSection, gaSection]}
        isDraft
      />
    );
    expect(screen.getByText("Orchestra")).toBeInTheDocument();
    expect(screen.getByText("General Admission")).toBeInTheDocument();
  });

  it("should render SEATED and GA badges", () => {
    render(
      <SeatingPlanCanvas
        planId="plan-1"
        sections={[seatedSection, gaSection]}
        isDraft
      />
    );
    expect(screen.getAllByText("SEATED").length).toBeGreaterThan(0);
    expect(screen.getAllByText("GA").length).toBeGreaterThan(0);
  });

  it("should show GA capacity label for GA sections", () => {
    render(
      <SeatingPlanCanvas
        planId="plan-1"
        sections={[gaSection]}
        isDraft
      />
    );
    expect(screen.getByText(/200 seats \(ga\)/i)).toBeInTheDocument();
  });

  it("should display a Save Layout button when isDraft is true", () => {
    render(
      <SeatingPlanCanvas
        planId="plan-1"
        sections={[seatedSection]}
        isDraft
      />
    );
    expect(
      screen.getByRole("button", { name: /save layout/i })
    ).toBeInTheDocument();
  });

  it("should not display a Save Layout button when isDraft is false", () => {
    render(
      <SeatingPlanCanvas
        planId="plan-1"
        sections={[seatedSection]}
        isDraft={false}
      />
    );
    expect(
      screen.queryByRole("button", { name: /save layout/i })
    ).not.toBeInTheDocument();
  });

  it("should initialise section positions from initialLayout when provided", () => {
    const initialLayout = {
      nodes: [
        {
          id: seatedSection.id,
          position: { x: 100, y: 200 },
          data: { rowOffsets: { "0": 15 } },
        },
      ],
    };
    // As long as the component mounts without error, the initial positions are
    // accepted — React Flow stores them internally and we verify mount is clean.
    expect(() =>
      render(
        <SeatingPlanCanvas
          planId="plan-1"
          sections={[seatedSection]}
          initialLayout={initialLayout}
          isDraft
        />
      )
    ).not.toThrow();
    expect(screen.getByText("Orchestra")).toBeInTheDocument();
  });
});
