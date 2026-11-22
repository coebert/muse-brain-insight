import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import blockade from "@/lib/eeg/research-blockade.json";

import { ResearchLearningPanel } from "./ResearchLearningPanel";

describe("ResearchLearningPanel", () => {
  it("states the one-in-six finding without presenting a clinical depth", () => {
    render(<ResearchLearningPanel />);
    expect(
      screen.getByText(
        new RegExp(
          `${blockade.falseSedated} of ${blockade.volunteers} awake, paralysed volunteers as sedated`,
          "i",
        ),
      ),
    ).toBeInTheDocument();
    expect(screen.getAllByText(/not a clinical depth measurement/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/Experimental research descriptor/i)).toBeInTheDocument();
  });

  it("distinguishes the three models", () => {
    render(<ResearchLearningPanel />);
    expect(screen.getByText(/frontal-alpha comparator/i)).toBeInTheDocument();
    expect(screen.getByText(/propofol protocol-state classifier/i)).toBeInTheDocument();
    expect(screen.getByText(/surgical EMG model/i)).toBeInTheDocument();
  });

  it("requires independent native-waveform validation", () => {
    render(<ResearchLearningPanel />);
    expect(
      screen.getByText(/native waveform EEG from a different cohort/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/No independent clinical validation is claimed/i)).toBeInTheDocument();
  });
});
