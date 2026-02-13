/**
 * Voice message transcription using local WhisperKit server
 */

import * as https from "https";
import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execSync, execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
import { WHISPERKIT_BASE_URL } from "./env";
import { info, error as logError, debug, warn } from "./logger";
import { isWhisperKitRunning, startWhisperKitServer } from "./service-manager";

// WhisperKit server configuration
const WHISPERKIT_URL = `${WHISPERKIT_BASE_URL}/v1/audio/transcriptions`;
const WHISPERKIT_MODEL = process.env.WHISPERKIT_MODEL || "large-v3-v20240930_turbo";
const WHISPERKIT_TIMEOUT = 120000; // 2 minutes

export interface TranscriptionResult {
  success: boolean;
  text?: string;
  error?: string;
  durationMs?: number;
}

/**
 * Download a file from a URL to a local path
 * Handles redirects (up to 5 hops) and cleans up on failure.
 */
async function downloadFile(url: string, destPath: string, maxRedirects: number = 5): Promise<void> {
  if (maxRedirects <= 0) {
    throw new Error("Too many redirects during file download");
  }

  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    let settled = false;

    const cleanup = () => {
      try {
        if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
      } catch {
        // Ignore cleanup errors
      }
    };

    const settle = (err?: Error) => {
      if (settled) return;
      settled = true;
      if (err) {
        file.close(() => cleanup());
        reject(err);
      } else {
        resolve();
      }
    };

    const req = https.get(url, { timeout: 30000 }, (response) => {
      // Handle redirects
      if (response.statusCode === 301 || response.statusCode === 302) {
        const redirectUrl = response.headers.location;
        if (redirectUrl) {
          response.resume();
          file.close(() => {
            cleanup();
            downloadFile(redirectUrl, destPath, maxRedirects - 1).then(resolve).catch(reject);
          });
          return;
        }
      }

      if (response.statusCode !== 200) {
        response.resume();
        settle(new Error(`Download failed with status ${response.statusCode}`));
        return;
      }

      response.pipe(file);
      file.on("finish", () => {
        file.close(() => settle());
      });
      file.on("error", (err) => settle(err));
      response.on("error", (err) => settle(err));
    });

    req.on("error", (err) => settle(err));
    req.on("timeout", () => {
      req.destroy();
      settle(new Error("Download timed out after 30 seconds"));
    });
  });
}

/**
 * Convert audio to 16kHz mono WAV format using ffmpeg (required by WhisperKit)
 */
async function convertToWav(inputPath: string, outputPath: string): Promise<void> {
  await execFileAsync("ffmpeg", ["-i", inputPath, "-ar", "16000", "-ac", "1", "-y", outputPath], {
    timeout: 30000,
  });
}

/**
 * Send audio file to WhisperKit server for transcription
 */
async function sendToWhisperKit(wavPath: string): Promise<{ text?: string; error?: string }> {
  return new Promise((resolve) => {
    const boundary = `----FormBoundary${Date.now()}`;
    const fileName = path.basename(wavPath);
    const fileSize = fs.statSync(wavPath).size;

    // Build multipart form parts (headers only, file streamed separately)
    const fileHeader = Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
      `Content-Type: audio/wav\r\n\r\n`
    );
    const fileSuffix = Buffer.from("\r\n");

    const modelPart = Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="model"\r\n\r\n` +
      `${WHISPERKIT_MODEL}\r\n`
    );

    const langPart = Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="language"\r\n\r\n` +
      `en\r\n`
    );

    const endBoundary = Buffer.from(`--${boundary}--\r\n`);

    // Calculate total content length without loading file into memory
    const totalLength = fileHeader.length + fileSize + fileSuffix.length +
      modelPart.length + langPart.length + endBoundary.length;

    const url = new URL(WHISPERKIT_URL);
    const options: http.RequestOptions = {
      hostname: url.hostname,
      port: url.port || 80,
      path: url.pathname,
      method: "POST",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": totalLength,
      },
      timeout: WHISPERKIT_TIMEOUT,
    };

    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        if (res.statusCode !== 200) {
          resolve({ error: `WhisperKit returned status ${res.statusCode}: ${data}` });
          return;
        }
        try {
          const json = JSON.parse(data);
          const text = (json.text || "").trim();
          resolve(text ? { text } : { error: "Empty transcription" });
        } catch (e) {
          resolve({ error: `Failed to parse response: ${data}` });
        }
      });
    });

    req.on("error", (e) => resolve({ error: `Request failed: ${e.message}` }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ error: "Request timeout" });
    });

    // Stream the multipart body: write header, pipe file, then write remaining parts
    req.write(fileHeader);
    const fileStream = fs.createReadStream(wavPath);
    fileStream.on("end", () => {
      req.write(fileSuffix);
      req.write(modelPart);
      req.write(langPart);
      req.write(endBoundary);
      req.end();
    });
    fileStream.on("error", (e) => {
      req.destroy();
      resolve({ error: `File read failed: ${e.message}` });
    });
    fileStream.pipe(req, { end: false });
  });
}

/**
 * Transcribe audio using local WhisperKit server
 */
async function transcribeWithWhisperKit(audioPath: string): Promise<TranscriptionResult> {
  const startTime = Date.now();
  const tempDir = os.tmpdir();
  const baseName = path.basename(audioPath, path.extname(audioPath));
  const wavPath = path.join(tempDir, `${baseName}.wav`);

  try {
    // Check if WhisperKit server is running, try to start if not
    let running = await isWhisperKitRunning();
    if (!running) {
      warn("voice", "whisperkit_not_running_attempting_start");
      const started = await startWhisperKitServer();
      if (started) {
        running = true;
        info("voice", "whisperkit_started_on_demand");
      }
    }
    if (!running) {
      return {
        success: false,
        error: "WhisperKit server not running and failed to start",
        durationMs: Date.now() - startTime,
      };
    }

    // Convert OGG to 16kHz mono WAV
    debug("voice", "converting_to_wav", { audioPath, wavPath });
    await convertToWav(audioPath, wavPath);

    // Send to WhisperKit server
    debug("voice", "sending_to_whisperkit", { model: WHISPERKIT_MODEL, wavPath });
    const result = await sendToWhisperKit(wavPath);

    // Clean up
    if (fs.existsSync(wavPath)) fs.unlinkSync(wavPath);

    const durationMs = Date.now() - startTime;

    if (result.error) {
      return {
        success: false,
        error: result.error,
        durationMs,
      };
    }

    debug("voice", "transcription_complete", {
      textLength: result.text?.length,
      durationMs,
    });

    return {
      success: true,
      text: result.text,
      durationMs,
    };
  } catch (err) {
    const durationMs = Date.now() - startTime;
    const errorMsg = err instanceof Error ? err.message : String(err);
    logError("voice", "whisperkit_transcription_failed", { error: errorMsg });

    // Clean up on error
    if (fs.existsSync(wavPath)) fs.unlinkSync(wavPath);

    return {
      success: false,
      error: `WhisperKit transcription failed: ${errorMsg}`,
      durationMs,
    };
  }
}

/**
 * Download voice file from Telegram and transcribe it
 */
export async function transcribeVoiceMessage(
  fileUrl: string,
  fileId: string
): Promise<TranscriptionResult> {
  const tempDir = os.tmpdir();
  const tempPath = path.join(tempDir, `voice_${fileId}.ogg`);

  try {
    debug("voice", "downloading_voice_file", { fileId });
    await downloadFile(fileUrl, tempPath);

    debug("voice", "transcribing_voice_file", { fileId, path: tempPath });
    const result = await transcribeWithWhisperKit(tempPath);

    // Clean up temp file
    if (fs.existsSync(tempPath)) {
      fs.unlinkSync(tempPath);
    }

    if (result.success) {
      info("voice", "transcription_success", {
        fileId,
        textLength: result.text?.length,
        durationMs: result.durationMs,
      });
    } else {
      logError("voice", "transcription_failed", {
        fileId,
        error: result.error,
      });
    }

    return result;
  } catch (err) {
    // Clean up temp file on error
    if (fs.existsSync(tempPath)) {
      fs.unlinkSync(tempPath);
    }

    const errorMsg = err instanceof Error ? err.message : String(err);
    logError("voice", "voice_processing_error", { fileId, error: errorMsg });

    return {
      success: false,
      error: errorMsg,
    };
  }
}

// Cache ffmpeg availability check (doesn't change during runtime)
let ffmpegAvailable: boolean | null = null;

function isFfmpegAvailable(): boolean {
  if (ffmpegAvailable !== null) return ffmpegAvailable;
  try {
    execSync("which ffmpeg", { stdio: "ignore" });
    ffmpegAvailable = true;
  } catch {
    ffmpegAvailable = false;
  }
  return ffmpegAvailable;
}

/**
 * Check if voice transcription is available (WhisperKit server running + ffmpeg installed)
 */
export async function isVoiceTranscriptionAvailable(): Promise<boolean> {
  if (!isFfmpegAvailable()) return false;
  return await isWhisperKitRunning();
}
