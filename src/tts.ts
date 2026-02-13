/**
 * Text-to-Speech using OpenAI gpt-4o-mini-tts
 * Outputs OGG-OPUS format for Telegram voice messages
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execFileSync, execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
import OpenAI from "openai";
import { info, error as logError, debug } from "./logger";
import { getConfig } from "./config";

// Lazy singleton
let openaiClient: OpenAI | null = null;

function getOpenAIClient(): OpenAI | null {
  if (openaiClient) return openaiClient;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  openaiClient = new OpenAI({ apiKey });
  return openaiClient;
}

export interface TTSResult {
  success: boolean;
  audioPath?: string;
  error?: string;
  durationMs: number;
}

// TTS output state
let ttsOutputEnabled = false;

export function enableTTSOutput(): boolean {
  if (!process.env.OPENAI_API_KEY) {
    logError("tts", "openai_api_key_missing");
    return false;
  }
  ttsOutputEnabled = true;
  info("tts", "tts_output_enabled");
  return true;
}

export function disableTTSOutput(): void {
  ttsOutputEnabled = false;
  info("tts", "tts_output_disabled");
}

export function isTTSOutputEnabled(): boolean {
  return ttsOutputEnabled;
}

export function getTTSOutputStatus(): string {
  return ttsOutputEnabled ? "enabled" : "disabled";
}

/**
 * Convert MP3 to OGG-OPUS format for Telegram voice messages
 */
async function convertToOggOpus(inputPath: string, outputPath: string): Promise<void> {
  await execFileAsync("ffmpeg", [
    "-i", inputPath,
    "-c:a", "libopus",
    "-b:a", "128k",
    "-vbr", "on",
    "-compression_level", "10",
    "-y",
    outputPath,
  ]);
}

// Max text length for TTS to prevent excessive API costs and timeouts
const MAX_TTS_TEXT_LENGTH = 4096;

export async function generateAudio(text: string): Promise<TTSResult> {
  const startTime = Date.now();

  if (!text || text.trim().length === 0) {
    return { success: false, error: "Empty text provided", durationMs: Date.now() - startTime };
  }

  const client = getOpenAIClient();
  if (!client) {
    return { success: false, error: "OPENAI_API_KEY not set", durationMs: Date.now() - startTime };
  }

  // Truncate very long text to prevent excessive API usage
  if (text.length > MAX_TTS_TEXT_LENGTH) {
    text = text.substring(0, MAX_TTS_TEXT_LENGTH);
    debug("tts", "text_truncated_for_tts", { originalLength: text.length, maxLength: MAX_TTS_TEXT_LENGTH });
  }

  const config = getConfig();
  const tempDir = os.tmpdir();
  const audioId = `audio_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  const mp3Path = path.join(tempDir, `${audioId}.mp3`);
  const oggPath = path.join(tempDir, `${audioId}.ogg`);

  try {
    debug("tts", "generating_speech_openai", {
      textLength: text.length,
      voice: config.ttsVoice,
      hasInstructions: !!config.ttsInstructions,
    });

    // Generate audio with OpenAI TTS
    // Note: speed parameter doesn't work with gpt-4o-mini-tts
    const response = await client.audio.speech.create({
      model: "gpt-4o-mini-tts",
      voice: config.ttsVoice,
      input: text,
      response_format: "mp3",
      instructions: config.ttsInstructions,
    });

    const audioBuffer = Buffer.from(await response.arrayBuffer());

    if (audioBuffer.length === 0) {
      return { success: false, error: "Empty audio response", durationMs: Date.now() - startTime };
    }

    // Write MP3 to temp file
    fs.writeFileSync(mp3Path, audioBuffer);

    // Convert to OGG-OPUS for Telegram voice messages
    await convertToOggOpus(mp3Path, oggPath);

    // Clean up MP3
    fs.unlinkSync(mp3Path);

    const durationMs = Date.now() - startTime;
    info("tts", "audio_generation_complete", {
      textLength: text.length,
      audioSize: fs.statSync(oggPath).size,
      durationMs,
    });

    return { success: true, audioPath: oggPath, durationMs };
  } catch (err) {
    const durationMs = Date.now() - startTime;
    const errorMsg = err instanceof Error ? err.message : String(err);
    logError("tts", "audio_generation_failed", { error: errorMsg, durationMs });

    // Clean up temp files
    for (const p of [mp3Path, oggPath]) {
      if (fs.existsSync(p)) {
        try { fs.unlinkSync(p); } catch { /* ignore */ }
      }
    }

    return { success: false, error: `TTS generation failed: ${errorMsg}`, durationMs };
  }
}

// Cache ffmpeg availability for TTS (doesn't change during runtime)
let ttsFFmpegAvailable: boolean | null = null;

export async function isTTSAvailable(): Promise<boolean> {
  if (!process.env.OPENAI_API_KEY) return false;

  // Check FFmpeg is available (cached)
  if (ttsFFmpegAvailable !== null) return ttsFFmpegAvailable;
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "pipe" });
    ttsFFmpegAvailable = true;
  } catch {
    ttsFFmpegAvailable = false;
  }
  return ttsFFmpegAvailable;
}
