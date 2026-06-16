/**
 * One-tap "tone" presets for the AI copy editor: each chip is a canned
 * `/ai/edit` instruction, so a user can refine the on-screen copy without
 * having to write a prompt. Shared by the Studio create page (edit mode) and
 * the project detail dialog so both surfaces offer the same quick actions.
 */
const QUICK_EDITS: ReadonlyArray<{ label: string; instruction: string }> = [
  { label: "Punchier", instruction: "Make it punchier and more energetic." },
  {
    label: "Shorter",
    instruction: "Make it shorter and tighter — cut filler words.",
  },
  {
    label: "More formal",
    instruction: "Make the tone more formal and professional.",
  },
  {
    label: "Add urgency",
    instruction: "Add urgency and strengthen the call to action.",
  },
  { label: "Simpler", instruction: "Use simpler, plainer language." },
];

export function AiQuickEdits({
  onPick,
  disabled,
}: {
  /** Called with the canned instruction for the picked preset. */
  onPick: (instruction: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {QUICK_EDITS.map((q) => (
        <button
          key={q.label}
          type="button"
          disabled={disabled}
          onClick={() => onPick(q.instruction)}
          className="rounded-full border px-2.5 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
        >
          {q.label}
        </button>
      ))}
    </div>
  );
}
