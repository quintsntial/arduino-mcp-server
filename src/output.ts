// Turn arduino-cli text output into structured fields: memory use, compiler diagnostics,
// serial lines and boot markers.

export interface MemoryUse {
  flashBytes: number;
  flashMaxBytes: number | null;
  flashPercent: number | null;
  ramBytes: number | null;
  ramMaxBytes: number | null;
  ramPercent: number | null;
}

/** Parse the AVR-style size lines that arduino-cli compile prints. Returns null when absent. */
export function parseMemoryUse(stdout: string): MemoryUse | null {
  const flash = stdout.match(
    /Sketch uses (\d+) bytes(?: \((\d+)%\))? of program storage space\.(?: Maximum is (\d+) bytes\.)?/
  );
  if (!flash) {
    return null;
  }
  const ram = stdout.match(
    /Global variables use (\d+) bytes(?: \((\d+)%\))? of dynamic memory(?:, leaving \d+ bytes for local variables)?\.(?: Maximum is (\d+) bytes\.)?/
  );
  const num = (value: string | undefined) => (value === undefined ? null : Number(value));
  return {
    flashBytes: Number(flash[1]),
    flashPercent: num(flash[2]),
    flashMaxBytes: num(flash[3]),
    ramBytes: num(ram?.[1]),
    ramPercent: num(ram?.[2]),
    ramMaxBytes: num(ram?.[3])
  };
}

export interface Diagnostic {
  file: string;
  line: number;
  column: number | null;
  severity: "error" | "warning" | "note";
  message: string;
}

/** Parse gcc-style "file:line:col: severity: message" lines (deduplicated, in order). */
export function parseDiagnostics(stderr: string): Diagnostic[] {
  const seen = new Set<string>();
  const result: Diagnostic[] = [];
  const pattern = /^(.+?):(\d+):(?:(\d+):)?\s+(fatal error|error|warning|note):\s+(.*)$/;
  for (const line of stderr.split(/\r?\n/)) {
    const match = line.match(pattern);
    if (!match) {
      continue;
    }
    const diagnostic: Diagnostic = {
      file: match[1],
      line: Number(match[2]),
      column: match[3] ? Number(match[3]) : null,
      severity: match[4] === "fatal error" ? "error" : (match[4] as Diagnostic["severity"]),
      message: match[5].trim()
    };
    const key = `${diagnostic.file}:${diagnostic.line}:${diagnostic.column}:${diagnostic.severity}:${diagnostic.message}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(diagnostic);
    }
  }
  return result;
}

/** Split serial text into non-empty lines; non-printable bytes (reset noise, wrong baud) become '?'. */
export function serialLines(text: string): string[] {
  return text
    .split(/\r?\n|\r/)
    .map((line) => line.replace(/[^\x09\x20-\x7E]/g, "?").trimEnd())
    .filter((line) => line.length > 0);
}

/** The last boot marker ("BOOT <name> v<version>") in the text, or null. */
export function findBootMarker(text: string): string | null {
  const matches = text.match(/BOOT\s+\S+\s+v[0-9][\w.\-]*/g);
  return matches ? matches[matches.length - 1] : null;
}

/** Keep the end of long text (tool output is read by a model; the tail holds the result). */
export function tail(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `…(${text.length - maxChars} chars omitted)…\n${text.slice(-maxChars)}`;
}
