import { z } from 'zod'
import { defineTool } from './types.js'

export const ASK_USER_TOOL = 'ask_user'

export const askUserTool = defineTool({
  name: ASK_USER_TOOL,
  description: [
    'Ask the user a question and wait for the answer. They can pick one of your options or type their own.',
    '- Use it only when the answer changes what you do and you cannot find it in the code, the request or sensible defaults: two reasonable readings of the request, a choice between approaches with real trade-offs, missing information.',
    '- Do not use it to ask permission for tool calls (approvals are handled for you) or to confirm that you should continue.',
    '- Give 2 to 4 short, distinct options. Put the one you recommend first.',
  ].join('\n'),
  input: z.object({
    question: z.string().describe('The question, ending with a question mark'),
    options: z.array(z.string()).min(2).max(4).describe('2 to 4 short answers to choose from'),
    multiSelect: z.boolean().optional().describe('Let the user pick more than one option'),
  }),
  kind: 'other',
  readOnly: true,
  subject: (i) => i.question,
  async execute(input, ctx) {
    if (!ctx.askUser) return { content: 'Nobody can answer questions here. Decide yourself and say what you assumed.', isError: true }
    const answer = (await ctx.askUser(input)).trim()
    if (!answer) return { content: 'The user dismissed the question without answering. Decide yourself and say what you assumed.' }
    return { content: `The user answered: ${answer}` }
  },
})
