import type { ChatMessage, ModelImageInput, ProviderConfig } from './types.js';

export interface ChatProvider {
  complete(messages: ChatMessage[], signal?: AbortSignal): Promise<string>;
  stream(
    messages: ChatMessage[],
    onDelta: (text: string) => void,
    signal?: AbortSignal
  ): Promise<string>;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function imageBase64(image: ModelImageInput): string {
  const match = image.dataUrl.match(/^data:([^;,]+);base64,([A-Za-z0-9+/=\r\n]+)$/);
  if (!match?.[2]) {
    throw new Error(`Invalid image data for ${image.label}.`);
  }
  return match[2].replace(/\s+/g, '');
}

export function openAIMessagePayload(message: ChatMessage): Record<string, unknown> {
  if (!message.images?.length) {
    return { role: message.role, content: message.content };
  }
  return {
    role: message.role,
    content: [
      { type: 'text', text: message.content },
      ...message.images.map((image) => ({
        type: 'image_url',
        image_url: { url: image.dataUrl, detail: 'high' }
      }))
    ]
  };
}

export function anthropicMessagePayload(message: ChatMessage): Record<string, unknown> {
  if (!message.images?.length) {
    return { role: message.role, content: message.content };
  }
  return {
    role: message.role,
    content: [
      ...message.images.map((image) => ({
        type: 'image',
        source: {
          type: 'base64',
          media_type: image.mimeType,
          data: imageBase64(image)
        }
      })),
      { type: 'text', text: message.content }
    ]
  };
}

export function geminiMessagePayload(message: ChatMessage): Record<string, unknown> {
  return {
    role: message.role === 'assistant' ? 'model' : 'user',
    parts: [
      ...(message.images?.map((image) => ({
        inlineData: { mimeType: image.mimeType, data: imageBase64(image) }
      })) ?? []),
      { text: message.content }
    ]
  };
}

async function readError(response: Response): Promise<string> {
  const body = await response.text();
  return `${response.status} ${response.statusText}${body ? `: ${body.slice(0, 800)}` : ''}`;
}

function checkedPayload<T>(value: unknown): T {
  if (!value || typeof value !== 'object') {
    throw new Error('The provider returned an invalid response.');
  }
  const payload = value as { error?: unknown; type?: string };
  if (payload.error || payload.type === 'error') {
    const detail = payload.error;
    const message = typeof detail === 'string' ? detail
      : detail && typeof detail === 'object' && 'message' in detail && typeof detail.message === 'string'
        ? detail.message : 'The provider interrupted the response.';
    throw new Error(`Model API error: ${message.slice(0, 800)}`);
  }
  return value as T;
}

async function readSse(
  response: Response,
  onEvent: (data: string) => void | false
): Promise<void> {
  if (!response.body) {
    throw new Error('The provider returned an empty streaming response.');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let ended = false;
  const dispatch = (event: string): void | false => {
    const lines = event.split(/\r?\n/);
    const data = lines.filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart()).join('\n');
    if (!data) return;
    if (lines.some((line) => /^event:\s*error\s*$/.test(line))) {
      throw new Error(`Model stream error: ${data.slice(0, 800)}`);
    }
    return onEvent(data);
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop() ?? '';
      for (const event of events) {
        if (dispatch(event) === false) return;
      }
      if (done) {
        ended = true;
        break;
      }
    }
    dispatch(buffer);
  } finally {
    if (!ended) {
      // Cleanup must not mask the provider's original error or wait for a remote close.
      void reader.cancel().catch(() => {});
    }
    reader.releaseLock();
  }
}

class OpenAICompatibleProvider implements ChatProvider {
  public constructor(private readonly config: ProviderConfig) {}

  public async complete(messages: ChatMessage[], signal?: AbortSignal): Promise<string> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.config.apiKey) {
      headers.authorization = `Bearer ${this.config.apiKey}`;
    }
    const generationOptions =
      this.config.reasoningEffort === 'auto'
        ? { temperature: 0.2 }
        : { reasoning_effort: this.config.reasoningEffort };
    const response = await fetch(`${trimTrailingSlash(this.config.baseUrl)}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: this.config.model,
        messages: messages.map(openAIMessagePayload),
        stream: false,
        ...generationOptions
      }),
      signal
    });
    if (!response.ok) {
      throw new Error(await readError(response));
    }
    const data = checkedPayload<{
      choices?: Array<{ message?: { content?: string } }>;
    }>(await response.json());
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('The provider returned no assistant message.');
    }
    return content;
  }

  public async stream(
    messages: ChatMessage[],
    onDelta: (text: string) => void,
    signal?: AbortSignal
  ): Promise<string> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.config.apiKey) {
      headers.authorization = `Bearer ${this.config.apiKey}`;
    }
    const generationOptions =
      this.config.reasoningEffort === 'auto'
        ? { temperature: 0.2 }
        : { reasoning_effort: this.config.reasoningEffort };
    const response = await fetch(`${trimTrailingSlash(this.config.baseUrl)}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: this.config.model,
        messages: messages.map(openAIMessagePayload),
        stream: true,
        ...generationOptions
      }),
      signal
    });
    if (!response.ok) {
      throw new Error(await readError(response));
    }
    let result = '';
    await readSse(response, (data) => {
      if (data === '[DONE]') {
        return false;
      }
      const event = checkedPayload<{
        choices?: Array<{ delta?: { content?: string } }>;
      }>(JSON.parse(data));
      const delta = event.choices?.[0]?.delta?.content ?? '';
      if (delta) {
        result += delta;
        onDelta(delta);
      }
    });
    if (!result) {
      throw new Error('The provider returned no assistant message.');
    }
    return result;
  }
}

class AnthropicProvider implements ChatProvider {
  public constructor(private readonly config: ProviderConfig) {}

  public async complete(messages: ChatMessage[], signal?: AbortSignal): Promise<string> {
    if (!this.config.apiKey) {
      throw new Error('Anthropic requires an API key.');
    }
    const system = messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n\n');
    const response = await fetch(`${trimTrailingSlash(this.config.baseUrl)}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.config.apiKey,
        authorization: `Bearer ${this.config.apiKey}`,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: this.config.model,
        system,
        max_tokens: 8000,
        ...(this.config.reasoningEffort === 'auto'
          ? {}
          : {
              output_config: {
                effort:
                  this.config.reasoningEffort === 'minimal'
                    ? 'low'
                    : this.config.reasoningEffort
              }
            }),
        messages: messages
          .filter((message) => message.role !== 'system')
          .map(anthropicMessagePayload)
      }),
      signal
    });
    if (!response.ok) {
      throw new Error(await readError(response));
    }
    const data = checkedPayload<{
      content?: Array<{ type: string; text?: string }>;
    }>(await response.json());
    const content = data.content
      ?.filter((item) => item.type === 'text')
      .map((item) => item.text ?? '')
      .join('\n');
    if (!content) {
      throw new Error('Anthropic returned no text content.');
    }
    return content;
  }

  public async stream(
    messages: ChatMessage[],
    onDelta: (text: string) => void,
    signal?: AbortSignal
  ): Promise<string> {
    if (!this.config.apiKey) {
      throw new Error('Anthropic requires an API key.');
    }
    const system = messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n\n');
    const response = await fetch(`${trimTrailingSlash(this.config.baseUrl)}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.config.apiKey,
        authorization: `Bearer ${this.config.apiKey}`,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: this.config.model,
        system,
        max_tokens: 8000,
        stream: true,
        ...(this.config.reasoningEffort === 'auto'
          ? {}
          : {
              output_config: {
                effort:
                  this.config.reasoningEffort === 'minimal'
                    ? 'low'
                    : this.config.reasoningEffort
              }
            }),
        messages: messages
          .filter((message) => message.role !== 'system')
          .map(anthropicMessagePayload)
      }),
      signal
    });
    if (!response.ok) {
      throw new Error(await readError(response));
    }
    let result = '';
    await readSse(response, (data) => {
      const event = checkedPayload<{ type?: string; delta?: { type?: string; text?: string } }>(JSON.parse(data));
      if (event.type === 'message_stop') return false;
      const delta = event.type === 'content_block_delta' ? event.delta?.text ?? '' : '';
      if (delta) {
        result += delta;
        onDelta(delta);
      }
    });
    if (!result) {
      throw new Error('Anthropic returned no text content.');
    }
    return result;
  }
}

class GeminiProvider implements ChatProvider {
  public constructor(private readonly config: ProviderConfig) {}

  public async complete(messages: ChatMessage[], signal?: AbortSignal): Promise<string> {
    if (!this.config.apiKey) {
      throw new Error('Gemini requires an API key.');
    }
    const base = trimTrailingSlash(this.config.baseUrl);
    const url = `${base}/v1beta/models/${encodeURIComponent(this.config.model)}:generateContent?key=${encodeURIComponent(this.config.apiKey)}`;
    const system = messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n\n');
    const contents = messages
      .filter((message) => message.role !== 'system')
      .map(geminiMessagePayload);
    const geminiEffort =
      this.config.reasoningEffort === 'xhigh' ? 'high' : this.config.reasoningEffort;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents,
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 8000,
          ...(geminiEffort === 'auto'
            ? {}
            : { thinkingConfig: { thinkingLevel: geminiEffort } })
        }
      }),
      signal
    });
    if (!response.ok) {
      throw new Error(await readError(response));
    }
    const data = checkedPayload<{
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    }>(await response.json());
    const content = data.candidates?.[0]?.content?.parts
      ?.map((part) => part.text ?? '')
      .join('\n');
    if (!content) {
      throw new Error('Gemini returned no text content.');
    }
    return content;
  }

  public async stream(
    messages: ChatMessage[],
    onDelta: (text: string) => void,
    signal?: AbortSignal
  ): Promise<string> {
    if (!this.config.apiKey) {
      throw new Error('Gemini requires an API key.');
    }
    const base = trimTrailingSlash(this.config.baseUrl);
    const url = `${base}/v1beta/models/${encodeURIComponent(this.config.model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(this.config.apiKey)}`;
    const system = messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n\n');
    const contents = messages
      .filter((message) => message.role !== 'system')
      .map(geminiMessagePayload);
    const geminiEffort =
      this.config.reasoningEffort === 'xhigh' ? 'high' : this.config.reasoningEffort;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents,
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 8000,
          ...(geminiEffort === 'auto'
            ? {}
            : { thinkingConfig: { thinkingLevel: geminiEffort } })
        }
      }),
      signal
    });
    if (!response.ok) {
      throw new Error(await readError(response));
    }
    let result = '';
    await readSse(response, (data) => {
      const event = checkedPayload<{
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      }>(JSON.parse(data));
      const delta = event.candidates?.[0]?.content?.parts
        ?.map((part) => part.text ?? '')
        .join('') ?? '';
      if (delta) {
        result += delta;
        onDelta(delta);
      }
    });
    if (!result) {
      throw new Error('Gemini returned no text content.');
    }
    return result;
  }
}

export function createChatProvider(config: ProviderConfig): ChatProvider {
  switch (config.provider) {
    case 'anthropic':
      return new AnthropicProvider(config);
    case 'gemini':
      return new GeminiProvider(config);
    default:
      return new OpenAICompatibleProvider(config);
  }
}
