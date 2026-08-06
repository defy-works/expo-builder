import type { Profile } from "../args";
import { UsageError } from "../errors";

export function assertSubmittable(profile: Profile): void {
  if (profile === "development") {
    throw new UsageError(
      "Development builds use internal distribution (APK), which the stores reject.",
      "Use the preview or production profile instead.",
    );
  }
}
