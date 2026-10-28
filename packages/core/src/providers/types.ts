import type { ChatMessage, ModelInfo, ToolCall, ToolSchema, Usage } from '../types.js'

export interface ChatRequest {
  model: string
  messages: ChatMessage[]
  tools?: ToolSchema[]
  temperature?: number
  maxTokens?: number
  reasoningEffort?: 'none' | 'low' | 'medium' | 'high'
  /** Send stored reasoning back on the current tool loop's assistant messages. Default: on, except api.openai.com. */
  replayReasoning?: boolean
  signal?: AbortSignal
  /** Give up when no data arrives for this long (hosted OpenAI-compatible providers only). 0 or unset = wait. */
  stallMs?: number
}

export type StreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'reasoning'; delta: string }
  /** Emitted once per call, fully assembled, after the stream ends. */
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'usage'; usage: Usage }
  /** Provider data to store on the assistant message and send back with it. */
  | { type: 'extra'; extra: Record<string, unknown> }
  | { type: 'finish'; reason: string }

export interface Provider {
  readonly id: string
  readonly name: string
  listModels(signal?: AbortSignal): Promise<ModelInfo[]>
  chat(req: ChatRequest): AsyncIterable<StreamEvent>
  /** True for a listed model the provider answered 404 for; it's left out of model lists. */
  unavailable?(modelId: string): boolean
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
  ) {
    super(message)
    this.name = 'ProviderError'
  }
}
