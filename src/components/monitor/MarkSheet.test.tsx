import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { MarkSheet } from "./MarkSheet";

describe("MarkSheet", () => {
  it("marks a preset at the current case time", () => {
    const onMark = vi.fn();
    render(<MarkSheet elapsed={600} onMark={onMark} onDone={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Intubation" }));
    expect(onMark).toHaveBeenCalledWith("Intubation", 0);
  });

  it("back-dates the marker by the selected offset", () => {
    const onMark = vi.fn();
    const onDone = vi.fn();
    render(<MarkSheet elapsed={600} onMark={onMark} onDone={onDone} />);
    fireEvent.click(screen.getByRole("button", { name: "−60s" }));
    expect(screen.getByText(/marks at/)).toHaveTextContent("09:00");
    fireEvent.click(screen.getByRole("button", { name: "Intubation" }));
    expect(onMark).toHaveBeenCalledWith("Intubation", 60);
    expect(onDone).toHaveBeenCalled();
  });

  it("marks free text and closes the sheet", () => {
    const onMark = vi.fn();
    render(<MarkSheet elapsed={120} onMark={onMark} onDone={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText("Custom marker"), {
      target: { value: "Facial twitching noted" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Mark" }));
    expect(onMark).toHaveBeenCalledWith("Facial twitching noted", 0);
  });
});
