import type { ChatMessage, ModelImageInput, ProviderConfig, ReasoningEffort } from './types.js';

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

// Extended thinking counts against max_tokens, so high effort needs headroom for
// the visible answer after the thinking blocks.
function anthropicMaxTokens(effort: ReasoningEffort): number {
  if (effort === 'xhigh') return 32000;
  if (effort === 'high') return 16000;
  return 8000;
}

function anthropicEmptyTextError(stopReason: string, blockTypes: string[]): string {
  const facts = [
    stopReason ? `stop_reason=${stopReason}` : '',
    blockTypes.length ? `blocks=${blockTypes.join(',')}` : ''
  ].filter(Boolean);
  const hint =
    stopReason === 'max_tokens' || blockTypes.includes('thinking')
      ? '推理可能耗尽了输出预算：请降低推理强度或更换模型后重试。'
      : '网关接受了请求但没有返回文本：该模型在当前网关上可能不可用。';
  return `Anthropic returned no text content${facts.length ? ` (${facts.join(', ')})` : ''}. ${hint}`;
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
        max_tokens: anthropicMaxTokens(this.config.reasoningEffort),
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
      stop_reason?: string;
    }>(await response.json());
    const content = data.content
      ?.filter((item) => item.type === 'text')
      .map((item) => item.text ?? '')
      .join('\n');
    if (!content) {
      throw new Error(
        anthropicEmptyTextError(
          data.stop_reason ?? '',
          [...new Set((data.content ?? []).map((item) => item.type))]
        )
      );
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
        max_tokens: anthropicMaxTokens(this.config.reasoningEffort),
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
    const blockTypes = new Set<string>();
    let stopReason = '';
    await readSse(response, (data) => {
      const event = checkedPayload<{
        type?: string;
        delta?: { type?: string; text?: string; stop_reason?: string };
        content_block?: { type?: string };
      }>(JSON.parse(data));
      if (event.type === 'message_stop') return false;
      if (event.type === 'content_block_start' && event.content_block?.type) {
        blockTypes.add(event.content_block.type);
      }
      if (event.type === 'message_delta' && event.delta?.stop_reason) {
        stopReason = event.delta.stop_reason;
      }
      const delta = event.type === 'content_block_delta' ? event.delta?.text ?? '' : '';
      if (delta) {
        result += delta;
        onDelta(delta);
      }
    });
    if (!result) {
      throw new Error(anthropicEmptyTextError(stopReason, [...blockTypes]));
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

export interface ProviderModelInfo {
  id: string;
  displayName?: string;
}

export type ModelAccessVerdict = 'ok' | 'denied' | 'missing' | 'silent' | 'unknown';

export interface ModelAccess {
  verdict: ModelAccessVerdict;
  detail?: string;
}

function accessFromStatus(status: number, detail: string): ModelAccess {
  if (status === 404) return { verdict: 'missing', detail };
  if (status === 401 || status === 402 || status === 403) return { verdict: 'denied', detail };
  if (status === 400 || status === 422) {
    const modelProblem = /model/i.test(detail) && /not|unknown|invalid|unsupported|exist|available/i.test(detail);
    return { verdict: modelProblem ? 'missing' : 'denied', detail };
  }
  return { verdict: 'unknown', detail };
}

// A catalogue listing or an HTTP 200 does not prove the model can answer, so each
// candidate gets one minimal streaming request that must yield a real text delta.
export async function probeModelAccess(
  config: ProviderConfig,
  model: string
): Promise<ModelAccess> {
  const base = trimTrailingSlash(config.baseUrl);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  let url: string;
  let body: Record<string, unknown>;
  if (config.provider === 'gemini') {
    if (!config.apiKey) return { verdict: 'unknown' };
    url = `${base}/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(config.apiKey)}`;
    body = {
      contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
      generationConfig: { maxOutputTokens: 2048 }
    };
  } else if (config.provider === 'anthropic') {
    if (!config.apiKey) return { verdict: 'unknown' };
    url = `${base}/v1/messages`;
    headers['x-api-key'] = config.apiKey;
    headers.authorization = `Bearer ${config.apiKey}`;
    headers['anthropic-version'] = '2023-06-01';
    body = {
      model,
      max_tokens: 2048,
      stream: true,
      messages: [{ role: 'user', content: 'ping' }]
    };
  } else {
    url = `${base}/chat/completions`;
    if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
    body = {
      model,
      stream: true,
      messages: [{ role: 'user', content: 'ping' }]
    };
  }
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000)
    });
  } catch (error) {
    return {
      verdict: 'unknown',
      detail: error instanceof Error ? error.message.slice(0, 200) : undefined
    };
  }
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 300);
    return accessFromStatus(response.status, detail);
  }
  const reader = response.body?.getReader();
  if (!reader) return { verdict: 'unknown' };
  const decoder = new TextDecoder();
  let buffer = '';
  let sawText = false;
  let finished = false;
  try {
    while (!sawText && !finished) {
      const { done, value } = await reader.read();
      if (done) {
        finished = true;
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop() ?? '';
      for (const event of events) {
        const data = event
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (!data) continue;
        if (data === '[DONE]') {
          finished = true;
          break;
        }
        let payload: unknown;
        try {
          payload = JSON.parse(data);
        } catch {
          continue;
        }
        const problem = probeStreamError(payload);
        if (problem) return { verdict: 'unknown', detail: problem };
        if (probeHasText(config.provider, payload)) {
          sawText = true;
          break;
        }
      }
    }
  } catch {
    return { verdict: 'unknown' };
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  if (sawText) return { verdict: 'ok' };
  if (finished) {
    return {
      verdict: 'silent',
      detail: 'gateway accepted the request but the stream produced no text'
    };
  }
  return { verdict: 'unknown' };
}

function probeStreamError(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const record = payload as { error?: unknown; type?: string };
  if (!record.error && record.type !== 'error') return undefined;
  const detail = record.error;
  const message =
    typeof detail === 'string'
      ? detail
      : detail && typeof detail === 'object' && 'message' in detail && typeof detail.message === 'string'
        ? detail.message
        : 'provider error event';
  return message.slice(0, 300);
}

function probeHasText(provider: ProviderConfig['provider'], payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false;
  if (provider === 'anthropic') {
    const event = payload as { type?: string; delta?: { type?: string; text?: string } };
    return (
      event.type === 'content_block_delta' &&
      event.delta?.type === 'text_delta' &&
      Boolean(event.delta.text)
    );
  }
  if (provider === 'gemini') {
    const event = payload as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    return (event.candidates ?? []).some((candidate) =>
      (candidate.content?.parts ?? []).some((part) => Boolean(part.text))
    );
  }
  const event = payload as { choices?: Array<{ delta?: { content?: string } }> };
  return (event.choices ?? []).some((choice) => Boolean(choice.delta?.content));
}

export async function listProviderModels(config: ProviderConfig): Promise<ProviderModelInfo[]> {
  const base = trimTrailingSlash(config.baseUrl);
  const headers: Record<string, string> = {};
  let url: string;
  if (config.provider === 'gemini') {
    if (!config.apiKey) return [];
    url = `${base}/v1beta/models?key=${encodeURIComponent(config.apiKey)}`;
  } else if (config.provider === 'anthropic') {
    if (!config.apiKey) return [];
    url = `${base}/v1/models`;
    headers['x-api-key'] = config.apiKey;
    headers.authorization = `Bearer ${config.apiKey}`;
    headers['anthropic-version'] = '2023-06-01';
  } else {
    url = `${base}/models`;
    if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
  }
  try {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
    if (!response.ok) return [];
    const data = (await response.json()) as {
      data?: Array<{ id?: string; display_name?: string }>;
      models?: Array<{ name?: string; displayName?: string }>;
    };
    const infos =
      config.provider === 'gemini'
        ? (data.models ?? []).map((model) => ({
            id: (model.name ?? '').replace(/^models\//, ''),
            displayName: model.displayName
          }))
        : (data.data ?? []).map((model) => ({
            id: model.id ?? '',
            displayName: model.display_name
          }));
    const seen = new Set<string>();
    return infos.filter((info) => {
      if (!info.id.trim() || seen.has(info.id)) return false;
      seen.add(info.id);
      return true;
    });
  } catch {
    return [];
  }
}
