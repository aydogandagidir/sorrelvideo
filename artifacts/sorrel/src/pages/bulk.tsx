import React, { useMemo, useState } from "react";
import { Layout } from "@/components/layout";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Layers, AlertTriangle, Clapperboard, Info } from "lucide-react";

/**
 * Mirrors the `ModuleStatusBadge` in pages/modules.tsx. Replicated here (rather
 * than imported) because that component is not exported, and these scaffold
 * pages must not modify modules.tsx.
 */
function ModuleStatusBadge({ status }: { status: string }) {
  switch (status) {
    case "active":
      return (
        <Badge className="bg-primary text-primary-foreground">Active</Badge>
      );
    case "beta":
      return (
        <Badge className="bg-blue-500/10 text-blue-500 border-blue-500/20">
          Beta
        </Badge>
      );
    case "coming_soon":
      return (
        <Badge variant="outline" className="text-muted-foreground">
          Coming Soon
        </Badge>
      );
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}

type BulkRow = Record<string, string>;

interface ParseResult {
  columns: string[];
  rows: BulkRow[];
  error: string | null;
}

const EMPTY_RESULT: ParseResult = { columns: [], rows: [], error: null };

const PLACEHOLDER = `# Paste CSV (with a header row) or a JSON array of objects.

# CSV example:
headline,bodyText,ctaText
Summer Sale,Up to 50% off everything,Shop now
New Arrivals,Fresh styles just dropped,Explore

# — or JSON —
[
  { "headline": "Summer Sale", "bodyText": "Up to 50% off", "ctaText": "Shop now" },
  { "headline": "New Arrivals", "bodyText": "Fresh styles", "ctaText": "Explore" }
]`;

/** Splits a single CSV line, honoring double-quoted fields with embedded commas. */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

function parseCsv(input: string): ParseResult {
  const lines = input
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));

  if (lines.length < 2) {
    return {
      ...EMPTY_RESULT,
      error: "CSV needs a header row and at least one data row.",
    };
  }

  const headerLine = lines[0];
  if (headerLine === undefined) {
    return { ...EMPTY_RESULT, error: "Missing header row." };
  }
  const columns = splitCsvLine(headerLine).filter((c) => c.length > 0);
  if (columns.length === 0) {
    return { ...EMPTY_RESULT, error: "Header row has no columns." };
  }

  const rows: BulkRow[] = lines.slice(1).map((line) => {
    const cells = splitCsvLine(line);
    const row: BulkRow = {};
    columns.forEach((col, idx) => {
      row[col] = cells[idx] ?? "";
    });
    return row;
  });

  return { columns, rows, error: null };
}

function parseJson(input: string): ParseResult {
  let data: unknown;
  try {
    data = JSON.parse(input);
  } catch {
    return { ...EMPTY_RESULT, error: "Invalid JSON." };
  }
  if (!Array.isArray(data)) {
    return { ...EMPTY_RESULT, error: "JSON must be an array of objects." };
  }
  if (data.length === 0) {
    return { ...EMPTY_RESULT, error: "JSON array is empty." };
  }

  const columnSet = new Set<string>();
  const rows: BulkRow[] = [];
  for (const entry of data) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return {
        ...EMPTY_RESULT,
        error: "Every JSON array item must be a flat object.",
      };
    }
    const row: BulkRow = {};
    for (const [key, value] of Object.entries(entry as Record<string, unknown>)) {
      columnSet.add(key);
      row[key] =
        value == null
          ? ""
          : typeof value === "object"
            ? JSON.stringify(value)
            : String(value);
    }
    rows.push(row);
  }

  return { columns: Array.from(columnSet), rows, error: null };
}

function parseInput(raw: string): ParseResult {
  const trimmed = raw.trim();
  if (!trimmed) return EMPTY_RESULT;
  const looksLikeJson = trimmed.startsWith("[") || trimmed.startsWith("{");
  return looksLikeJson ? parseJson(trimmed) : parseCsv(trimmed);
}

const PREVIEW_LIMIT = 25;

export default function Bulk() {
  const [raw, setRaw] = useState("");

  const result = useMemo(() => parseInput(raw), [raw]);
  const rowCount = result.rows.length;
  const previewRows = result.rows.slice(0, PREVIEW_LIMIT);

  return (
    <Layout>
      <div className="flex items-start justify-between mb-8 gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <h1 className="text-3xl font-bold tracking-tight">Bulk Render</h1>
            <ModuleStatusBadge status="beta" />
          </div>
          <p className="text-muted-foreground">
            Paste many sets of composition variables and queue them as a batch
            of videos.
          </p>
        </div>
      </div>

      <Alert className="mb-8">
        <Info className="h-4 w-4" />
        <AlertTitle>Preview only</AlertTitle>
        <AlertDescription>
          Batch rendering is not wired up yet. You can paste and validate your
          data here today; the “Render” action will light up once the bulk
          pipeline ships.
        </AlertDescription>
      </Alert>

      <div className="grid gap-8 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Input</CardTitle>
            <CardDescription>
              CSV with a header row, or a JSON array of objects. Each row
              becomes one video.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Label htmlFor="bulk-input" className="sr-only">
              Composition variables
            </Label>
            <Textarea
              id="bulk-input"
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              placeholder={PLACEHOLDER}
              spellCheck={false}
              className="min-h-[320px] font-mono text-xs leading-relaxed"
            />
            {result.error && raw.trim() && (
              <div className="flex items-start gap-1.5 text-xs text-destructive">
                <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                <span>{result.error}</span>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="flex flex-col">
          <CardHeader>
            <div className="flex items-center justify-between gap-2">
              <CardTitle>Parsed preview</CardTitle>
              {rowCount > 0 && (
                <Badge variant="outline" className="text-muted-foreground">
                  {rowCount} {rowCount === 1 ? "row" : "rows"}
                </Badge>
              )}
            </div>
            <CardDescription>
              Confirm the columns and values look right before rendering.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex-1">
            {rowCount > 0 ? (
              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-10">#</TableHead>
                      {result.columns.map((col) => (
                        <TableHead key={col}>{col}</TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {previewRows.map((row, idx) => (
                      <TableRow key={idx}>
                        <TableCell className="text-muted-foreground tabular-nums">
                          {idx + 1}
                        </TableCell>
                        {result.columns.map((col) => (
                          <TableCell
                            key={col}
                            className="max-w-[16rem] truncate"
                            title={row[col] ?? ""}
                          >
                            {row[col] ?? ""}
                          </TableCell>
                        ))}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                {rowCount > PREVIEW_LIMIT && (
                  <p className="px-3 py-2 text-xs text-muted-foreground border-t">
                    Showing first {PREVIEW_LIMIT} of {rowCount} rows.
                  </p>
                )}
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center text-center h-full min-h-[280px] rounded-md border border-dashed">
                <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-muted mb-3">
                  <Layers className="h-6 w-6 text-muted-foreground" />
                </div>
                <p className="text-sm text-muted-foreground max-w-xs">
                  Paste CSV or JSON on the left to see a parsed preview of your
                  batch here.
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="mt-8 flex items-center justify-end gap-3">
        <span className="text-sm text-muted-foreground">
          {rowCount > 0
            ? `${rowCount} ${rowCount === 1 ? "video" : "videos"} ready to queue`
            : "Add rows to enable rendering"}
        </span>
        {/* Disabled until the bulk render pipeline lands. */}
        <Button disabled title="Bulk rendering is coming soon">
          <Clapperboard className="mr-2 h-4 w-4" />
          Render {rowCount > 0 ? rowCount : ""}{" "}
          {rowCount === 1 ? "video" : "videos"}
        </Button>
      </div>
    </Layout>
  );
}
