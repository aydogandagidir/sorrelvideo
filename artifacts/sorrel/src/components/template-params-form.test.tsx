/**
 * TemplateParamsForm renders one control per typed composition variable and
 * emits an id-keyed `onChange`. These pin the control-per-type mapping + the
 * value/default seeding, which is the contract the projects-page parameters
 * section depends on.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { type CompositionVariable } from "@workspace/api-client-react";
import { TemplateParamsForm } from "./template-params-form";
import { renderWithProviders } from "@/test/test-utils";

const VARIABLES: CompositionVariable[] = [
  { id: "title", type: "string", label: "Title", default: "Hi" },
  { id: "max", type: "number", label: "Max", default: 25, min: 1, unit: "$K" },
  { id: "accent", type: "color", label: "Accent", default: "#a3e635" },
  { id: "loop", type: "boolean", label: "Loop", default: true },
  {
    id: "mode",
    type: "enum",
    label: "Mode",
    default: "a",
    options: [
      { value: "a", label: "Alpha" },
      { value: "b", label: "Beta" },
    ],
  },
];

describe("TemplateParamsForm", () => {
  it("renders one labeled control per variable", () => {
    renderWithProviders(
      <TemplateParamsForm
        variables={VARIABLES}
        values={{}}
        onChange={vi.fn()}
      />,
    );
    for (const v of VARIABLES) {
      expect(screen.getByText(v.label)).toBeInTheDocument();
    }
    // The number control carries its declared min + unit.
    const num = screen.getByLabelText("Max") as HTMLInputElement;
    expect(num.type).toBe("number");
    expect(num.min).toBe("1");
    expect(screen.getByText("$K")).toBeInTheDocument();
  });

  it("seeds each control from values[id] ?? default", () => {
    renderWithProviders(
      <TemplateParamsForm
        variables={VARIABLES}
        values={{ title: "Saved" }}
        onChange={vi.fn()}
      />,
    );
    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe(
      "Saved",
    );
    // Unset → its default.
    expect((screen.getByLabelText("Max") as HTMLInputElement).value).toBe("25");
  });

  it("emits an id-keyed onChange when a control changes", () => {
    const onChange = vi.fn();
    renderWithProviders(
      <TemplateParamsForm
        variables={VARIABLES}
        values={{}}
        onChange={onChange}
      />,
    );
    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "New" },
    });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ title: "New" }),
    );
  });
});
