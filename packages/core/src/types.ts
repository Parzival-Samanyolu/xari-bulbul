// Shared types for the whole engine. The message format is OpenAI-shaped because
// every provider we talk to speaks the OpenAI-compatible chat API.

export interface ToolCall {
  id: string
  name: string
  /** Raw JSON string exactly as produced by the model. */
  arguments: string
  /** Provider data that must be sent back with the call (Gemini's `extra_content.google.thought_signature`). */
  extra?: Record<string, unknown>
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
      /** Sent to the model after the text but not shown (e.g. "the user reverted these files"). */
      note?: string
    }
  | {
      role: 'assistant'
      content: string
      toolCalls?: ToolCall[]
      reasoning?: string
      /** Provider data replayed with this turn (Anthropic's content blocks with thinking signatures). */
      extra?: Record<string, unknown>
      /** Set when Mixture of Agents wrote this reply: what was combined. Display only, never sent to a model. */
      moa?: MixtureInfo
    }
  | {
      role: 'tool'
      toolCallId: string
      name: string
      content: string
      /** Images the tool returned (a browser screenshot); sent to the model with the result. */
      images?: ImageAttachment[]
    }

/** One answer that went into a mixed reply. */
export interface MixtureProposal {
  model: ModelRef
  /** The answer, when the model gave one. */
  content?: string
  /** Why it was left out (failed or empty). */
  error?: string
}

export interface MixtureInfo {
  /** The model that combined the answers into the reply. */
  aggregator: ModelRef
  proposals: MixtureProposal[]
  /** The chat model's own answer (it could use tools), also given to the aggregator. */
  draft?: { model: ModelRef; content: string }
}

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
  /** Multiplier on list prices when cost isn't reported (batch requests: 0.5). */
  priceFactor?: number
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
