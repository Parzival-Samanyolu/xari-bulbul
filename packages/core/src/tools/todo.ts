import { z } from 'zod'
import { defineTool } from './types.js'

export const todoTool = defineTool({
  name: 'todo_write',
  description: [
    'Keep a checklist the user can see while you work.',
    '- Use it for any task with three or more steps, or when the user gives several requests at once. Skip it for a single quick change.',
    '- Send the full list every time; it replaces the previous one.',
    '- Keep exactly one item in_progress. Mark an item completed as soon as it is done, not in batches at the end.',
    '- Only mark an item completed when it is really done: tests pass, the change is in place. If something blocks it, leave it open and add an item for the blocker.',
    '- Before you end your turn, every item is either completed or explained in your reply.',
  ].join('\n'),
  input: z.object({
    todos: z.array(
      z.object({
        content: z.string(),
        status: z.enum(['pending', 'in_progress', 'completed']),
      }),
    ),
  }),
  kind: 'other',
  readOnly: true,
  subject: (i) => `${i.todos.length} items`,
  async execute(input, ctx) {
    ctx.setTodos(input.todos)
    const done = input.todos.filter((t) => t.status === 'completed').length
    return { content: `Todo list updated (${done}/${input.todos.length} completed).` }
  },
})
