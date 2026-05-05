/**
 * Voice message transcription using OpenAI Whisper API.
 * Converts Discord voice message audio (.ogg) to text.
 */

const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
const WHISPER_MODEL = Deno.env.get("WHISPER_MODEL") || "whisper-1";
const WHISPER_LANGUAGE = Deno.env.get("WHISPER_LANGUAGE") || "";

export function isVoiceTranscriptionEnabled(): boolean {
  return !!OPENAI_API_KEY;
}

export async function transcribeAudio(audioUrl: string): Promise<string> {
  if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not set — voice transcription unavailable");
  }

  const response = await fetch(audioUrl);
  if (!response.ok) {
    throw new Error(`Failed to download audio: ${response.status} ${response.statusText}`);
  }
  const audioBlob = await response.blob();

  const formData = new FormData();
  formData.append("file", new File([audioBlob], "voice.ogg", { type: "audio/ogg" }));
  formData.append("model", WHISPER_MODEL);
  if (WHISPER_LANGUAGE) {
    formData.append("language", WHISPER_LANGUAGE);
  }

  const transcriptionResponse = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
    },
    body: formData,
  });

  if (!transcriptionResponse.ok) {
    const errorText = await transcriptionResponse.text();
    throw new Error(`Whisper API error: ${transcriptionResponse.status} — ${errorText}`);
  }

  const result = await transcriptionResponse.json();
  return result.text;
}
