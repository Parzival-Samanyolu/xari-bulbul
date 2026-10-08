import { bashOutputTool, bashTool, killJobTool } from './bash.js'
import { editFileTool } from './edit-file.js'
import { forgetTool, rememberTool } from './memory.js'
import { readFileTool } from './read-file.js'
import { globTool, grepTool, listDirTool } from './search.js'
import { taskTool } from './task.js'
import { todoTool } from './todo.js'
import type { Tool } from './types.js'
import { webFetchTool } from './web-fetch.js'
import { writeFileTool } from './write-file.js'

export function builtinTools(): Tool[] {
  return [readFileTool, writeFileTool, editFileTool, listDirTool, globTool, grepTool, bashTool, bashOutputTool, killJobTool, webFetchTool, todoTool, taskTool, rememberTool, forgetTool]
}

export * from './types.js'
export { makeDiff } from './diff.js'
export { defaultShell } from './bash.js'
export { JobRegistry, type Job } from './jobs.js'
export { TASK_TOOL } from './task.js'
export { FORGET_TOOL, REMEMBER_TOOL } from './memory.js'
