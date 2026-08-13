import type { Project } from "../project/types.ts";

/** One reversible editing action.
 *
 *  `apply` and `revert` are both pure project→project transforms, so the undo stack never has to
 *  know what any particular edit means — it only replays these in order. */
export interface Command {
  /** Shown in the UI ("Undo Split Clip") and in logs. */
  label: string;
  apply(project: Project): Project;
  revert(project: Project): Project;
}
