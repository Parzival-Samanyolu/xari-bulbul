import type { CommandInfo } from './Composer.js'

/** Built-in slash commands. User commands from .harness/commands are added after these. */
export const BUILTIN_COMMANDS: CommandInfo[] = [
  { name: 'model', description: 'Switch model (free models first)', args: '[provider:model]' },
  { name: 'mode', description: 'Set the permission mode: ask, auto-edit, plan, full-auto', args: '[mode]' },
  { name: 'compact', description: 'Summarize older messages to free up context' },
  { name: 'clear', description: 'Start a new chat in this folder' },
  { name: 'resume', description: 'Reopen an earlier chat' },
  { name: 'status', description: 'Model, mode, context, usage, keys and settings at a glance' },
  { name: 'usage', description: 'Tokens and cost per model and per day; /usage csv exports', args: '[csv [file]]' },
  { name: 'memory', description: 'What Xarı Bülbül remembers about you and this project' },
  { name: 'mcp', description: 'MCP servers and their tools' },
  { name: 'init', description: 'Write an AGENTS.md describing this project' },
  { name: 'login', description: 'Save an API key (provider, brave or tavily) in the OS keychain and test it', args: '[provider]' },
  { name: 'help', description: 'Commands, keys and where to customize things' },
  { name: 'exit', description: 'Quit (the chat is saved; xb --continue resumes it)' },
]
