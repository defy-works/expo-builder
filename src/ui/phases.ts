import * as p from "@clack/prompts";

export const PHASE_START: Record<string, string> = {
  "clone-vm": "Cloning VM...",
  "boot-vm": "Booting VM...",
  "stage": "Staging source in VM...",
  "env-pull": "Pulling credentials from EAS...",
  "install": "Installing dependencies...",
  "build": "Building...",
  "version": "Updating version...",
  "submit": "Submitting to store...",
  "artifact": "Retrieving artifact...",
  "cleanup": "Cleaning up VM...",
};

export const PHASE_DONE: Record<string, string> = {
  "clone-vm": "VM cloned",
  "boot-vm": "VM booted",
  "stage": "Source staged",
  "env-pull": "Credentials ready",
  "install": "Dependencies installed",
  "build": "Build complete",
  "version": "Version updated",
  "submit": "Submitted to store",
  "artifact": "Artifact retrieved",
  "cleanup": "VM cleaned up",
};

/** Drives one spinner at a time, keyed on the current phase. */
export class PhaseTracker {
  private spinner: ReturnType<typeof p.spinner> | null = null;
  current = "";

  start(phase: string, label?: string): void {
    this.stop(true);
    this.current = phase;
    this.spinner = p.spinner();
    this.spinner.start(label ?? PHASE_START[phase] ?? phase);
  }

  message(text: string): void {
    this.spinner?.message(text);
  }

  stop(ok: boolean): void {
    if (!this.spinner || !this.current) return;
    this.spinner.stop(
      ok
        ? PHASE_DONE[this.current] ?? `${this.current} done`
        : `Failed during: ${PHASE_START[this.current] ?? this.current}`,
    );
    this.spinner = null;
  }
}
