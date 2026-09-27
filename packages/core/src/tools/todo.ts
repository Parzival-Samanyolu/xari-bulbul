import { z } from 'zod'
import { defineTool } from './types.js'

export const todoTool = defineTool({
  name: 'todo_write',
  description:
    'Maintain a visible task checklist for multi-step work. Send the FULL list every time. ' +
    'Keep exactly one item in_progress while working; mark items completed as soon as they are done.',
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
