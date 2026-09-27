import { z } from 'zod'
import { defineTool } from './types.js'

export const TASK_TOOL = 'task'

/**
 * Hands a self-contained job to a subagent with a fresh context. The subagent's own tool calls
 * go through the normal permission checks; this tool only starts it, so it needs no approval.
 */
export const taskTool = defineTool({
  name: TASK_TOOL,
  description:
    'Delegate a self-contained task to a subagent that starts with an empty context and returns one report. ' +
    'Use it for broad searches or research that would flood your context ("find every place X is configured"), ' +
    'or for independent pieces of work. Several task calls in one response run in parallel. ' +
    'The subagent cannot see this conversation: put everything it needs (goal, relevant paths, what to report back) in the prompt. ' +
    'type "explore" (default) is read-only; "general" can also edit files and run commands.',
  input: z.object({
    description: z.string().describe('A short label for the task, 3 to 6 words'),
    prompt: z.string().describe('Complete instructions for the subagent, including what to report back'),
    type: z.enum(['explore', 'general']).default('explore'),
  }),
  kind: 'other',
  readOnly: true,
  subject: (i) => i.description,
  async execute(input, ctx) {
    if (!ctx.runSubagent) return { content: 'Subagents are not available here.', isError: true }
    return ctx.runSubagent(input)
  },
})
