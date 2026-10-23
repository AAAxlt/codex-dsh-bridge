/**
 * Prompt construction. The bridge sends the task as plain text; the model's report is the
 * only part of the exchange Codex reads as "the model's claim". Everything the bridge itself
 * observes is reported separately, so a claim is never presented as verified fact.
 */
import {BRIDGE_VERSION} from './config.js';

const HOST_CHECK_NOTICE = '## Host verification\nThe bridge runs a separate host check after this turn, and only after a normally completed turn. It is not a substitute for your own acceptance run: do not rely on it, and do not run or modify the host verifier. Run only task-local checks authorized by the goal.';

/**
 * The job is one complete delivery, not a first draft. This text deliberately does not cap tool
 * calls or wall-clock effort: the caller's bounded stage budget is the only limit. A failed check
 * is input to the next repair, not automatically a reason to hand the task back to Codex.
 */
function deliveryWorkflow(): string {
  return [
    '## Delivery workflow (do the whole unit, then hand back once)',
    '1. Implement: read the relevant files before editing them, then make the change in place.',
    '2. Run acceptance: execute the project\'s own real build/test/check commands yourself. Do not invent output or claim a check you did not run.',
    '3. Analyze failures: read the real error, identify the cause, and fix it. Do not stop at the first failure and do not report every intermediate failure to Codex.',
    '4. Re-run acceptance after each fix until it passes, or until you have a concrete, evidenced blocker.',
    '5. Self-review: re-read your diff, check edge cases, compatibility, and that no unrelated file was changed. Run the checks once more after the final edit.',
    '6. Deliver once: report what changed, exactly what you ran and observed, and only the genuinely unresolved items. A session that merely "completed" is not a product acceptance.',
    'You may keep a short, honest work log in the workspace (for example DSH_WORKLOG.md) if it helps a later stage; never write invented results into it. The bridge writes its own checkpoint.json and result files automatically — do not fabricate or edit those.',
  ].join('\n');
}

/** Compatibility for a still-connected parent using the previous prompt builder.
 * Only the exact Bridge-generated section is removed; user prompts are untouched.
 * This is prompt minimization, not an access-control boundary.
 */
export function redactLegacyHostVerification(text: string): string {
  if (!/^(?:You are executing one delegated stage of work, stage \d+, for task dsh-[^\n]+\.|Stage \d+ of task dsh-[^\n]+\. This continues the SAME session,)/.test(text)) return text;
  return text.replace(/## Verification command\nThe bridge will run this itself after you stop, in the workspace, and record the real exit code:\n    [\s\S]*?(?=\n\n## Boundaries\n)/g, HOST_CHECK_NOTICE);
}

export interface TaskBrief {
  taskId: string;
  stage: number;
  workspace: string;
  goal: string;
  context?: string | undefined;
  constraints?: string[] | undefined;
  acceptance?: string | undefined;
  verificationCommand?: string[] | undefined;
}

function bullets(items: readonly string[] | undefined): string {
  if (!items || items.length === 0) return '- (none supplied)';
  return items.map((item) => `- ${item}`).join('\n');
}

/**
 * Stated to the model exactly as it is: these are real, program-enforced bounds.
 * Anything not on this list is a request, not an enforced guarantee.
 */
function enforcedBounds(workspace: string): string {
  return [
    'The bridge enforces these bounds programmatically:',
    `- The execution sandbox root is ${workspace}; the SDK runs with sandbox mode "workspace-write".`,
    '- The bridge starts its own private SDK process for this task; it does not touch any other DSH session.',
    '- Only the base tools of this SDK runtime are loaded. Desktop plugins are NOT loaded.',
    '- Nothing outside the workspace is writable, and the bridge rejects any workspace outside its allowed roots.',
    'Anything else you are asked to respect is an instruction, not a boundary the bridge can verify.',
  ].join('\n');
}

export function firstStagePrompt(brief: TaskBrief): string {
  const parts: string[] = [];
  parts.push(`You are executing one delegated stage of work, stage ${brief.stage}, for task ${brief.taskId}.`);
  parts.push('Codex is the orchestrator. You execute this stage and stop.');
  parts.push('');
  parts.push('## Goal');
  parts.push(brief.goal.trim());
  if (brief.context && brief.context.trim().length > 0) {
    parts.push('');
    parts.push('## Context');
    parts.push(brief.context.trim());
  }
  parts.push('');
  parts.push('## Constraints');
  parts.push(bullets(brief.constraints));
  parts.push('');
  parts.push('## Acceptance');
  parts.push(brief.acceptance?.trim() ?? '(Codex did not supply an explicit acceptance check)');
  parts.push('');
  parts.push(deliveryWorkflow());
  if (brief.verificationCommand && brief.verificationCommand.length > 0) {
    parts.push('');
    parts.push(HOST_CHECK_NOTICE);
  }
  parts.push('');
  parts.push('## Boundaries');
  parts.push(enforcedBounds(brief.workspace));
  parts.push('');
  parts.push('## How to finish this stage');
  parts.push('1. Do the work with your own tools. Prefer running the real check over asserting it passes.');
  parts.push('2. Edit files in place; do not create a report-only deliverable.');
  parts.push('3. End your final message with exactly these three sections, in this order:');
  parts.push('   CHANGED: files you created or modified, one per line, with the path.');
  parts.push('   RAN: each command you executed and its observed outcome.');
  parts.push('   UNRESOLVED: anything you could not do, could not verify, or that you are unsure about.');
  parts.push('   If a section is empty, write "none" under it. Do not omit a section.');
  parts.push('4. Stop when this stage is done. Do not start work beyond the goal above.');
  parts.push('');
  parts.push(`bridge=${BRIDGE_VERSION}`);
  return parts.join('\n');
}

export function continuationPrompt(
  brief: TaskBrief,
  review: string,
  priorReport: string,
): string {
  const parts: string[] = [];
  parts.push(`Stage ${brief.stage} of task ${brief.taskId}. This continues the SAME session, so your earlier work is in context.`);
  parts.push('');
  parts.push('## Review of your previous stage');
  parts.push(review.trim());
  if (priorReport.trim().length > 0) {
    parts.push('');
    parts.push('## Your previous stage report (as recorded by the bridge)');
    parts.push(priorReport.trim());
  }
  parts.push('');
  parts.push('## What this stage must produce');
  parts.push(brief.goal.trim());
  if (brief.acceptance && brief.acceptance.trim().length > 0) {
    parts.push('');
    parts.push('## Acceptance for this stage');
    parts.push(brief.acceptance.trim());
  }
  parts.push('');
  parts.push(deliveryWorkflow());
  if (brief.constraints && brief.constraints.length > 0) {
    parts.push('');
    parts.push('## Constraints (unchanged)');
    parts.push(bullets(brief.constraints));
  }
  if (brief.verificationCommand && brief.verificationCommand.length > 0) {
    parts.push('');
    parts.push(HOST_CHECK_NOTICE);
  }
  parts.push('');
  parts.push('## Boundaries');
  parts.push(enforcedBounds(brief.workspace));
  parts.push('');
  parts.push('End your final message with CHANGED / RAN / UNRESOLVED sections, as before.');
  return parts.join('\n');
}
