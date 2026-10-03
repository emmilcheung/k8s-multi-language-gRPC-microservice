// a click before hydration is lost (the handler is not attached yet) and
// reads as a dead button, so Allow/Deny must be disabled until the client has
// mounted. Server output is therefore disabled; it enables after mount.

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { ConsentActions } from "@/app/oauth/consent/ConsentActions";

describe("ConsentActions hydration gate", () => {
  it("the server render has both buttons disabled", () => {
    const html = renderToString(<ConsentActions requestId="r" />);
    const buttons = html.match(/<button\b[^>]*>/g) ?? [];
    expect(buttons).toHaveLength(2);
    for (const b of buttons) expect(b).toMatch(/\sdisabled(=""|\s|>)/);
  });

  it("both buttons are enabled once mounted, with unchanged accessible names", () => {
    render(<ConsentActions requestId="r" />);
    expect(screen.getByRole("button", { name: "Allow Access" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Deny" })).toBeEnabled();
  });
});
