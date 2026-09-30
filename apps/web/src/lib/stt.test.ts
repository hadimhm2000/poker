// Speech to text client for voice rebuys: a fake fetch captures the request, so no network.
import { describe, expect, it } from "vitest";
import { createTranscriber, sttConfig } from "./stt";

describe("sttConfig", () => {
  it("is off unless both URL and model are set", () => {
    expect(sttConfig({})).toBeNull();
    expect(sttConfig({ STT_API_URL: "https://stt.test/v1" })).toBeNull();
    expect(sttConfig({ STT_MODEL: "whisper-1" })).toBeNull();
    expect(sttConfig({ STT_API_URL: " ", STT_MODEL: "whisper-1" })).toBeNull();
  });

  it("trims a trailing slash; the key is optional", () => {
    expect(sttConfig({ STT_API_URL: "https://stt.test/v1/", STT_MODEL: "whisper-1" })).toEqual({
      url: "https://stt.test/v1",
      key: undefined,
      model: "whisper-1",
    });
    expect(sttConfig({ STT_API_URL: "http://localhost:9000", STT_MODEL: "m", STT_API_KEY: "sk" })?.key).toBe("sk");
  });
});

describe("createTranscriber", () => {
  function fake(response: Response) {
    const seen: { url: string; init: RequestInit }[] = [];
    const f = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return response;
    }) as unknown as typeof fetch;
    return { f, seen };
  }

  it("posts multipart audio with model, language and bearer key", async () => {
    const { f, seen } = fake(Response.json({ text: "  علی ۲۰۰ ری‌بای  " }));
    const t = createTranscriber({ url: "https://stt.test/v1", key: "sk-1", model: "whisper-1" }, f);
    const text = await t(new Uint8Array([1, 2, 3]), { filename: "voice.ogg", mime: "audio/ogg", language: "fa" });
    expect(text).toBe("علی ۲۰۰ ری‌بای");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("https://stt.test/v1/audio/transcriptions");
    expect(seen[0]!.init.method).toBe("POST");
    expect(seen[0]!.init.headers).toEqual({ Authorization: "Bearer sk-1" });
    const form = seen[0]!.init.body as FormData;
    expect(form.get("model")).toBe("whisper-1");
    expect(form.get("language")).toBe("fa");
    expect(form.get("response_format")).toBe("json");
    const file = form.get("file") as File;
    expect(file.name).toBe("voice.ogg");
    expect(file.type).toBe("audio/ogg");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("sends no auth header without a key and no language when not given", async () => {
    const { f, seen } = fake(Response.json({ text: "ok" }));
    await createTranscriber({ url: "http://localhost:9000", model: "m" }, f)(new Uint8Array([0]), { filename: "a.ogg", mime: "audio/ogg" });
    expect(seen[0]!.init.headers).toEqual({});
    expect((seen[0]!.init.body as FormData).has("language")).toBe(false);
  });

  it("fails on an HTTP error or a body without text; long text is cut", async () => {
    const opts = { filename: "a.ogg", mime: "audio/ogg" };
    const cfg = { url: "https://stt.test", model: "m" };
    await expect(createTranscriber(cfg, fake(new Response("no", { status: 500 })).f)(new Uint8Array(), opts)).rejects.toThrow(/500/);
    await expect(createTranscriber(cfg, fake(Response.json({ nope: 1 })).f)(new Uint8Array(), opts)).rejects.toThrow(/no text/);
    const long = await createTranscriber(cfg, fake(Response.json({ text: "x".repeat(900) })).f)(new Uint8Array(), opts);
    expect(long).toHaveLength(500);
  });
});
