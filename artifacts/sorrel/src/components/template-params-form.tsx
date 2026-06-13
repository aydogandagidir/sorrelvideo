/**
 * Renders one control per typed composition variable (the engine's native
 * `data-composition-variables`, surfaced on `Template.variables`). Values are
 * strings — the `compositionVars` transport is `Record<string, string>` — so
 * each control reads/writes a string and the server re-validates the typed
 * shape (lib/typedVars) on save.
 */
import {
  CompositionVariableType,
  type CompositionVariable,
} from "@workspace/api-client-react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export interface TemplateParamsFormProps {
  variables: CompositionVariable[];
  /** Current values keyed by variable id (string transport). */
  values: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
  disabled?: boolean;
}

/** The string value for a variable: the saved override, else its default. */
function valueFor(
  v: CompositionVariable,
  values: Record<string, string>,
): string {
  return values[v.id] ?? String(v.default);
}

export function TemplateParamsForm({
  variables,
  values,
  onChange,
  disabled,
}: TemplateParamsFormProps) {
  const set = (id: string, value: string) =>
    onChange({ ...values, [id]: value });

  return (
    <div className="space-y-3">
      {variables.map((v) => {
        const current = valueFor(v, values);
        const id = `param-${v.id}`;
        return (
          <div key={v.id} className="space-y-1.5">
            <Label htmlFor={id} className="text-xs">
              {v.label}
            </Label>

            {v.type === CompositionVariableType.string &&
              ((v.maxLength ?? 0) > 120 ? (
                <Textarea
                  id={id}
                  value={current}
                  maxLength={v.maxLength}
                  placeholder={v.placeholder}
                  disabled={disabled}
                  onChange={(e) => set(v.id, e.target.value)}
                />
              ) : (
                <Input
                  id={id}
                  value={current}
                  maxLength={v.maxLength}
                  placeholder={v.placeholder}
                  disabled={disabled}
                  onChange={(e) => set(v.id, e.target.value)}
                />
              ))}

            {v.type === CompositionVariableType.number && (
              <div className="flex items-center gap-2">
                <Input
                  id={id}
                  type="number"
                  value={current}
                  min={v.min}
                  max={v.max}
                  step={v.step}
                  disabled={disabled}
                  onChange={(e) => set(v.id, e.target.value)}
                />
                {v.unit && (
                  <span className="text-xs text-muted-foreground">{v.unit}</span>
                )}
              </div>
            )}

            {v.type === CompositionVariableType.color && (
              <div className="flex items-center gap-2">
                <input
                  id={id}
                  type="color"
                  value={current}
                  disabled={disabled}
                  onChange={(e) => set(v.id, e.target.value)}
                  className="h-9 w-12 shrink-0 cursor-pointer rounded border bg-transparent"
                />
                <Input
                  aria-label={`${v.label} hex`}
                  value={current}
                  disabled={disabled}
                  onChange={(e) => set(v.id, e.target.value)}
                />
              </div>
            )}

            {v.type === CompositionVariableType.boolean && (
              <div className="flex items-center gap-2">
                <Switch
                  id={id}
                  checked={current === "true"}
                  disabled={disabled}
                  onCheckedChange={(c) => set(v.id, c ? "true" : "false")}
                />
              </div>
            )}

            {v.type === CompositionVariableType.enum && (
              <Select
                value={current}
                disabled={disabled}
                onValueChange={(val) => set(v.id, val)}
              >
                <SelectTrigger id={id}>
                  <SelectValue placeholder={v.label} />
                </SelectTrigger>
                <SelectContent>
                  {(v.options ?? []).map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}

            {v.description && (
              <p className="text-xs text-muted-foreground">{v.description}</p>
            )}
          </div>
        );
      })}
    </div>
  );
}
