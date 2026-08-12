// Resume-intent detection from the wrapped command's argv. Adapter-specific so an ordinary
// prompt or option value (e.g. a Claude prompt "resume") cannot be mistaken for a resume, and
// an explicit session id is carried through rather than collapsed to a boolean -- capture uses
// it to pick the requested transcript instead of the newest one in the project/cwd.
export type ResumeIntent = {
  // Any resume intent (continue, --last, the interactive picker, or an explicit id).
  resume: boolean;
  // The explicit session id from a resume selector (`--resume <id>` / `resume <id>`), else null.
  sessionId: string | null;
  // The resume targets the most-recent session (`--continue`, `resume --last`), so capture may
  // fall back to the newest transcript that predates launch. False for the interactive picker
  // (`--resume` with no id, bare `codex resume`): the chosen session is unknown up front, so
  // guessing the newest could surface a different conversation than the one picked.
  latest: boolean;
};

export const NO_RESUME: ResumeIntent = { resume: false, sessionId: null, latest: false };

// Options end at the first `--`; everything after it is prompt/positional data the child does
// not parse as flags, so it must not enable resume.
function optionsBefore(args: string[]): string[] {
  const end = args.indexOf("--");
  return end === -1 ? args : args.slice(0, end);
}

export function detectClaudeResume(args: string[]): ResumeIntent {
  // Claude resumes only via options, never a bare word, so a prompt "resume" is not a resume.
  const opts = optionsBefore(args);
  for (let index = 0; index < opts.length; index += 1) {
    const arg = opts[index];
    if (arg === undefined) continue;
    if (arg === "--continue" || arg === "-c")
      return { resume: true, sessionId: null, latest: true };
    if (arg === "--resume" || arg === "-r") {
      const next = opts[index + 1];
      // `--resume <id>` targets that session; `--resume` alone opens the interactive picker.
      const id = next && !next.startsWith("-") ? next : null;
      return { resume: true, sessionId: id, latest: false };
    }
    if (arg.startsWith("--resume=")) {
      const id = arg.slice("--resume=".length);
      return { resume: true, sessionId: id.length > 0 ? id : null, latest: false };
    }
  }
  return NO_RESUME;
}

export function detectCodexResume(args: string[]): ResumeIntent {
  // Conservative: `resume` counts only as the leading subcommand. We do not try to skip unknown
  // global options, whose values could be mistaken for the subcommand -- if the form is not
  // `resume ...`, resume is simply not detected (safe: capture uses the buffer rather than risk
  // another session's transcript).
  const opts = optionsBefore(args);
  if (opts[0] !== "resume") return NO_RESUME;
  const rest = opts.slice(1);
  const id = rest.find((arg) => !arg.startsWith("-"));
  if (id !== undefined) return { resume: true, sessionId: id, latest: false };
  // No id: `resume --last` targets the most recent; bare `resume` opens the picker.
  return { resume: true, sessionId: null, latest: rest.includes("--last") };
}
