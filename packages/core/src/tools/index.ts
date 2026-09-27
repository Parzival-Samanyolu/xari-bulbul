import { bashTool } from './bash.js'
import { editFileTool } from './edit-file.js'
import { readFileTool } from './read-file.js'
import { globTool, grepTool, listDirTool } from './search.js'
import { taskTool } from './task.js'
import { todoTool } from './todo.js'
import type { Tool } from './types.js'
import { webFetchTool } from './web-fetch.js'
import { writeFileTool } from './write-file.js'

export function builtinTools(): Tool[] {
  return [readFileTool, writeFileTool, editFileTool, listDirTool, globTool, grepTool, bashTool, webFetchTool, todoTool, taskTool]
}

export * from './types.js'
export { makeDiff } from './diff.js'
export { defaultShell } from './bash.js'
export { TASK_TOOL } from './task.js'
