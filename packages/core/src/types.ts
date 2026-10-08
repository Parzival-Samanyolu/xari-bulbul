// Shared types for the whole engine. The message format is OpenAI-shaped because
// every provider we talk to speaks the OpenAI-compatible chat API.

export interface ToolCall {
  id: string
  name: string
  /** Raw JSON string exactly as produced by the model. */
  arguments: string
}

export type ChatMessage =
  | { role: 'system'; content: string }
  | {
      role: 'user'
      content: string
      files?: FileAttachment[]
      images?: ImageAttachment[]
      /** Written by the engine, not the user (e.g. the end-of-turn review). Shown as a note. */
      synthetic?: 'review' | 'reminder'
    }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[]; reasoning?: string }
  | { role: 'tool'; toolCallId: string; name: string; content: string }

/** A text file the user attached; its contents go to the model after the message text. */
export interface FileAttachment {
  name: string
  /** Where it came from (absolute path), for display. */
  path?: string
  text: string
}

/** An image the user attached, sent to vision-capable models. */
export interface ImageAttachment {
  name: string
  mediaType: string
  /** Base64 without the data: prefix. */
  data: string
}

export interface ModelRef {
  providerId: string
  modelId: string
}

export interface ModelPricing {
  /** USD per prompt token */
  prompt: number
  /** USD per completion token */
  completion: number
}

export interface ModelInfo {
  id: string
  name: string
  providerId: string
  contextLength?: number
  pricing?: ModelPricing
  /** True when the provider reports zero prompt and completion price. */
  free: boolean
  /** Unix seconds, when the provider reports it (used to sort newest first). */
  created?: number
  supportsTools: boolean
  /** Whether the model accepts image input; undefined when the provider doesn't say. */
  supportsImages?: boolean
}

export interface Usage {
  promptTokens: number
  completionTokens: number
  cachedTokens?: number
  /** USD, when the provider reports it directly. */
  cost?: number
}

export interface JsonSchema {
  [key: string]: unknown
}

export interface ToolSchema {
  name: string
  description: string
  parameters: JsonSchema
}

export type TodoStatus = 'pending' | 'in_progress' | 'completed'
export interface TodoItem {
  content: string
  status: TodoStatus
}

export type PermissionMode = 'ask' | 'acceptEdits' | 'plan' | 'auto'
