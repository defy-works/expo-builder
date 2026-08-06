export type LineVerdict = "show" | "hide" | "duplicate";

const NOISE = /^(\s+at\s)|^npm (warn|notice)\b/;

/** Lines worth surfacing during each phase. Everything else goes to the log only. */
const SHOW_PATTERNS: Record<string, RegExp> = {
  "stage": /rsync|files/i,
  "env-pull": /pulled|downloaded|secret/i,
  "install": /installed|resolved|packages/i,
  "build": /^\[([A-Z][A-Z_]+)\]/,
  "version": /version|warning/i,
  "submit": /submitted|upload|error/i,
  "artifact": /app\.(ipa|aab)/i,
};

const TAIL_SIZE = 50;

export class OutputFilter {
  private previous = "";
  private tailBuffer: string[] = [];
  duplicateCount = 0;

  classify(line: string, phase: string): LineVerdict {
    if (NOISE.test(line)) return "hide";

    if (line === this.previous) {
      this.duplicateCount++;
      return "duplicate";
    }
    this.previous = line;
    this.duplicateCount = 0;

    const pattern = SHOW_PATTERNS[phase];
    return pattern?.test(line) ? "show" : "hide";
  }

  /** "[RUN_FASTLANE] ..." → "run fastlane" */
  easPhase(line: string): string | undefined {
    const match = line.match(/^\[([A-Z][A-Z_]+)\]/);
    return match ? match[1]!.toLowerCase().replace(/_/g, " ") : undefined;
  }

  record(line: string): void {
    this.tailBuffer.push(line);
    if (this.tailBuffer.length > TAIL_SIZE) this.tailBuffer.shift();
  }

  tail(): string[] {
    return [...this.tailBuffer];
  }
}

/** Render one line with the │ bar, truncated to the terminal width. */
export function showLine(text: string): void {
  const cols = process.stdout.columns || 80;
  const prefix = "│  ";
  const max = cols - prefix.length - 1;
  const display = text.length > max ? `${text.slice(0, max - 3)}...` : text;
  process.stdout.write(`\x1b[2K\r${prefix}${display}\n`);
}

export function showBar(): void {
  process.stdout.write("\x1b[2K\r│\n");
}
