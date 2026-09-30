// Speech to text for voice rebuys: any OpenAI-compatible POST {STT_API_URL}/audio/transcriptions
// (multipart: file, model, optional language; answer {"text": "..."}). Configured by
//   STT_API_URL    base URL, e.g. https://api.openai.com/v1 or a self-hosted Whisper server
//   STT_API_KEY    bearer token (optional for a local server)
//   STT_MODEL      model name, e.g. whisper-1
// Voice is off when STT_API_URL or STT_MODEL is unset.

export interface SttConfig {
  url: string;
  key?: string;
  model: string;
}

export function sttConfig(env: Record<string, string | undefined> = process.env): SttConfig | null {
  const url = env.STT_API_URL?.trim().replace(/\/+$/, "");
  const model = env.STT_MODEL?.trim();
  if (!url || !model) return null;
  return { url, key: env.STT_API_KEY?.trim() || undefined, model };
}

export type Transcribe = (audio: Uint8Array, opts: { filename: string; mime: string; language?: string }) => Promise<string>;

/** A transcriber for the given settings. `fetchImpl` is injectable so tests never touch the network. */
export function createTranscriber(cfg: SttConfig, fetchImpl: typeof fetch = fetch): Transcribe {
  return async (audio, opts) => {
    const form = new FormData();
    form.set("file", new Blob([audio as Uint8Array<ArrayBuffer>], { type: opts.mime }), opts.filename);
    form.set("model", cfg.model);
    form.set("response_format", "json");
    if (opts.language) form.set("language", opts.language);
    const res = await fetchImpl(`${cfg.url}/audio/transcriptions`, {
      method: "POST",
      headers: cfg.key ? { Authorization: `Bearer ${cfg.key}` } : {},
      body: form,
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`transcription failed: ${res.status}`);
    const body = (await res.json()) as { text?: unknown };
    if (typeof body.text !== "string") throw new Error("transcription failed: no text");
    return body.text.trim().slice(0, 500);
  };
}
