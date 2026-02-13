/**
 * File handling utilities for Telegram Gateway
 * Downloads files from Telegram, formats metadata for the AI provider, and handles cleanup
 */

import * as https from "https";
import * as fs from "fs";
import * as path from "path";
import { tmpdir } from "os";
import { info, error as logError, debug } from "./logger";
import { getConfig } from "./config";
import { FILE_PROTOCOL, buildAttachedFileBlock } from "./file-protocol";

// Constants
export const FILE_BASE_DIR = "/tmp/tg-files";
export const MAX_DOWNLOAD_SIZE = 20 * 1024 * 1024; // 20MB (Telegram limit)
export const MAX_UPLOAD_SIZE = 50 * 1024 * 1024; // 50MB
export const FILE_CLEANUP_AGE_MS = 60 * 60 * 1000; // 1 hour
export const DEFAULT_MAX_FILES_STORAGE_MB = 500; // 500MB default
export const ORPHAN_SESSION_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

// File type to handler mapping
export type FileType =
  | "document"
  | "photo"
  | "video"
  | "audio"
  | "sticker"
  | "animation"
  | "video_note";

export interface FileMetadata {
  type: FileType;
  filename: string;
  mimeType: string;
  fileSize: number;
  localPath: string;
  caption?: string;
}

export interface FileSendRequest {
  path: string;
  caption?: string;
}

function isPathWithinRoot(targetPath: string, rootPath: string): boolean {
  const relative = path.relative(rootPath, targetPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function validateFileSendPath(requestedPath: string): {
  ok: boolean;
  resolvedPath?: string;
  reason?: string;
} {
  const normalizedPath = path.resolve(requestedPath);
  if (!fs.existsSync(normalizedPath)) {
    return { ok: false, reason: "file not found" };
  }
  const stats = fs.statSync(normalizedPath);
  if (!stats.isFile()) {
    return { ok: false, reason: "path is not a file" };
  }

  const resolvedPath = fs.realpathSync(normalizedPath);
  const allowedRoots = [FILE_BASE_DIR, tmpdir(), path.join(process.cwd(), "temp")]
    .map((root) => path.resolve(root))
    .map((root) => (fs.existsSync(root) ? fs.realpathSync(root) : root));

  const inAllowedRoot = allowedRoots.some((root) => isPathWithinRoot(resolvedPath, root));
  if (!inAllowedRoot) {
    return { ok: false, reason: "path outside allowed directories" };
  }

  return { ok: true, resolvedPath };
}

/**
 * Ensure the session directory exists
 */
function ensureSessionDir(sessionId: string): string {
  const sessionDir = path.join(FILE_BASE_DIR, sessionId);
  if (!fs.existsSync(FILE_BASE_DIR)) {
    fs.mkdirSync(FILE_BASE_DIR, { recursive: true });
  }
  if (!fs.existsSync(sessionDir)) {
    fs.mkdirSync(sessionDir, { recursive: true });
  }
  return sessionDir;
}

/**
 * Download a file from Telegram API to local temp directory.
 * Handles redirects, timeouts, and cleans up on failure.
 */
export async function downloadTelegramFile(
  botToken: string,
  filePath: string,
  sessionId: string,
  filename: string
): Promise<string> {
  const fileUrl = `https://api.telegram.org/file/bot${botToken}/${filePath}`;
  const sessionDir = ensureSessionDir(sessionId);

  // Sanitize filename - more aggressive: limit length too
  const safeFilename = filename
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .substring(0, 200);
  const uniquePrefix = Date.now().toString(36) + "_";
  const localPath = path.join(sessionDir, uniquePrefix + safeFilename);

  return downloadFileFromUrl(fileUrl, localPath);
}

/**
 * Helper to download from URL to local path with redirect support.
 */
async function downloadFileFromUrl(
  url: string,
  localPath: string,
  maxRedirects: number = 3
): Promise<string> {
  if (maxRedirects <= 0) {
    throw new Error("Too many redirects during Telegram file download");
  }

  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(localPath);
    let settled = false;

    const cleanup = () => {
      try {
        if (fs.existsSync(localPath)) fs.unlinkSync(localPath);
      } catch { /* ignore */ }
    };

    const settle = (err?: Error) => {
      if (settled) return;
      settled = true;
      if (err) {
        file.close(() => cleanup());
        reject(err);
      }
    };

    const req = https.get(url, { timeout: 60000 }, (response) => {
      // Handle redirects
      if (response.statusCode === 301 || response.statusCode === 302) {
        const redirectUrl = response.headers.location;
        if (redirectUrl) {
          response.resume();
          file.close(() => {
            cleanup();
            downloadFileFromUrl(redirectUrl, localPath, maxRedirects - 1)
              .then(resolve)
              .catch(reject);
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
        file.close(() => {
          if (!settled) {
            settled = true;
            resolve(localPath);
          }
        });
      });
      file.on("error", (err) => settle(err));
      response.on("error", (err) => settle(err));
    });

    req.on("error", (err) => settle(err));
    req.on("timeout", () => {
      req.destroy();
      settle(new Error("Telegram file download timed out after 60 seconds"));
    });
  });
}

/**
 * Format file metadata as structured block for the AI provider
 */
export function formatFileMetadata(metadata: FileMetadata): string {
  const lines = [
    `type: ${metadata.type}`,
    `filename: ${metadata.filename}`,
    `mime_type: ${metadata.mimeType}`,
    `file_size: ${metadata.fileSize}`,
    `local_path: ${metadata.localPath}`,
  ];

  if (metadata.caption) {
    lines.push(`caption: ${metadata.caption}`);
  }

  return buildAttachedFileBlock(lines);
}

/**
 * Parse <send-file> tags from the provider response
 * Format: <send-file path="/path/to/file" caption="optional caption" />
 */
export function parseFileSendRequest(response: string): FileSendRequest[] {
  const results: FileSendRequest[] = [];
  // Match self-closing tags: <send-file path="..." /> or <send-file path="..." caption="..." />
  const regex = new RegExp(
    `<${FILE_PROTOCOL.sendFileTag}\\s+path="([^"]+)"(?:\\s+caption="([^"]*)")?\\s*\\/>`,
    "g"
  );

  let match;
  while ((match = regex.exec(response)) !== null) {
    results.push({
      path: match[1],
      caption: match[2] || undefined,
    });
  }

  return results;
}

/**
 * Remove <send-file> tags from response text
 */
export function removeFileTags(response: string): string {
  return response
    .replace(
      new RegExp(
        `<${FILE_PROTOCOL.sendFileTag}\\s+path="[^"]+"\\s*(?:caption="[^"]*")?\\s*\\/>`,
        "g"
      ),
      ""
    )
    .trim();
}

/**
 * Cleanup files for a specific session
 */
export function cleanupSessionFiles(sessionId: string): void {
  const sessionDir = path.join(FILE_BASE_DIR, sessionId);
  if (!fs.existsSync(sessionDir)) {
    return;
  }

  try {
    const files = fs.readdirSync(sessionDir);
    for (const file of files) {
      const filePath = path.join(sessionDir, file);
      try {
        fs.unlinkSync(filePath);
        debug("files", "cleaned_up_file", { path: filePath });
      } catch {
        // Ignore individual file cleanup errors
      }
    }
    // Remove the directory
    fs.rmdirSync(sessionDir);
    debug("files", "cleaned_up_session_dir", { sessionId });
  } catch (err) {
    logError("files", "cleanup_session_failed", {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Cleanup all files older than the specified age
 */
export function cleanupOldFiles(): void {
  if (!fs.existsSync(FILE_BASE_DIR)) {
    return;
  }

  const now = Date.now();
  let cleanedCount = 0;

  try {
    const sessions = fs.readdirSync(FILE_BASE_DIR);

    for (const sessionId of sessions) {
      const sessionDir = path.join(FILE_BASE_DIR, sessionId);
      const stat = fs.statSync(sessionDir);

      if (!stat.isDirectory()) {
        continue;
      }

      // Check if session directory is old enough to clean
      const age = now - stat.mtimeMs;
      if (age > FILE_CLEANUP_AGE_MS) {
        try {
          const files = fs.readdirSync(sessionDir);
          for (const file of files) {
            fs.unlinkSync(path.join(sessionDir, file));
            cleanedCount++;
          }
          fs.rmdirSync(sessionDir);
        } catch {
          // Ignore individual session cleanup errors
        }
      }
    }

    if (cleanedCount > 0) {
      info("files", "cleanup_complete", { filesRemoved: cleanedCount });
    }
  } catch (err) {
    logError("files", "cleanup_old_files_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * MIME type lookup table (hoisted to module scope to avoid re-creation per call)
 */
const MIME_TYPES: Record<string, string> = {
    // Documents
    ".pdf": "application/pdf",
    ".doc": "application/msword",
    ".docx":
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls": "application/vnd.ms-excel",
    ".xlsx":
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".ppt": "application/vnd.ms-powerpoint",
    ".pptx":
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".txt": "text/plain",
    ".csv": "text/csv",
    ".json": "application/json",
    ".xml": "application/xml",
    ".zip": "application/zip",
    ".tar": "application/x-tar",
    ".gz": "application/gzip",
    // Images
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".bmp": "image/bmp",
    // Audio
    ".mp3": "audio/mpeg",
    ".ogg": "audio/ogg",
    ".wav": "audio/wav",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
    ".flac": "audio/flac",
    // Video
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".avi": "video/x-msvideo",
    ".mkv": "video/x-matroska",
    ".webm": "video/webm",
    ".m4v": "video/x-m4v",
    ".flv": "video/x-flv",
    ".3gp": "video/3gpp",
    // Archives
    ".7z": "application/x-7z-compressed",
    ".rar": "application/vnd.rar",
    ".bz2": "application/x-bzip2",
    // Documents
    ".rtf": "application/rtf",
    ".odt": "application/vnd.oasis.opendocument.text",
    ".ods": "application/vnd.oasis.opendocument.spreadsheet",
    ".epub": "application/epub+zip",
    // Code/Config
    ".yaml": "text/yaml",
    ".yml": "text/yaml",
    ".toml": "text/plain",
    ".sh": "text/x-shellscript",
    ".py": "text/x-python",
    ".js": "text/javascript",
    ".ts": "text/typescript",
    ".go": "text/plain",
    ".rs": "text/plain",
    ".rb": "text/x-ruby",
    ".java": "text/x-java",
    ".c": "text/x-c",
    ".cpp": "text/x-c++",
    ".h": "text/x-c",
    ".swift": "text/x-swift",
    ".kt": "text/plain",
    ".sql": "text/x-sql",
    ".md": "text/markdown",
    ".html": "text/html",
    ".css": "text/css",
    // More images
    ".heic": "image/heic",
    ".heif": "image/heif",
    ".tiff": "image/tiff",
    ".tif": "image/tiff",
    ".ico": "image/x-icon",
    // More audio
    ".opus": "audio/opus",
    ".weba": "audio/webm",
    // Fonts
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".otf": "font/otf",
};

/**
 * Get MIME type from filename extension
 */
export function getMimeTypeFromFilename(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  return MIME_TYPES[ext] || "application/octet-stream";
}

/**
 * Check if a file is an image based on MIME type
 */
export function isImageMimeType(mimeType: string): boolean {
  return mimeType.startsWith("image/");
}

/**
 * Check if a file is a video based on MIME type
 */
export function isVideoMimeType(mimeType: string): boolean {
  return mimeType.startsWith("video/");
}

/**
 * Check if a file is audio based on MIME type
 */
export function isAudioMimeType(mimeType: string): boolean {
  return mimeType.startsWith("audio/");
}

interface FileInfo {
  path: string;
  size: number;
  mtime: number;
}

/**
 * Get all files in the storage directory with their sizes and modification times
 */
function getAllStoredFiles(): FileInfo[] {
  const files: FileInfo[] = [];

  if (!fs.existsSync(FILE_BASE_DIR)) {
    return files;
  }

  try {
    const sessions = fs.readdirSync(FILE_BASE_DIR);

    for (const sessionId of sessions) {
      const sessionDir = path.join(FILE_BASE_DIR, sessionId);
      const sessionStat = fs.statSync(sessionDir);

      if (!sessionStat.isDirectory()) {
        continue;
      }

      const sessionFiles = fs.readdirSync(sessionDir);
      for (const file of sessionFiles) {
        const filePath = path.join(sessionDir, file);
        try {
          const stat = fs.statSync(filePath);
          if (stat.isFile()) {
            files.push({
              path: filePath,
              size: stat.size,
              mtime: stat.mtimeMs,
            });
          }
        } catch {
          // Skip files we can't stat
        }
      }
    }
  } catch (err) {
    logError("files", "get_all_stored_files_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return files;
}

/**
 * Get total storage used in bytes
 */
export function getTotalStorageBytes(): number {
  const files = getAllStoredFiles();
  return files.reduce((total, file) => total + file.size, 0);
}

/**
 * Enforce storage limit by deleting oldest files until at 80% of limit
 */
export function enforceStorageLimit(): void {
  const config = getConfig();
  const maxStorageMB = config.resources?.maxFilesStorageMB ?? DEFAULT_MAX_FILES_STORAGE_MB;
  const maxStorageBytes = maxStorageMB * 1024 * 1024;
  const targetBytes = maxStorageBytes * 0.8; // 80% of limit

  const files = getAllStoredFiles();
  let totalBytes = files.reduce((sum, f) => sum + f.size, 0);

  if (totalBytes <= maxStorageBytes) {
    return;
  }

  // Sort by mtime ascending (oldest first)
  files.sort((a, b) => a.mtime - b.mtime);

  let deletedCount = 0;
  let deletedBytes = 0;

  for (const file of files) {
    if (totalBytes <= targetBytes) {
      break;
    }

    try {
      fs.unlinkSync(file.path);
      totalBytes -= file.size;
      deletedBytes += file.size;
      deletedCount++;
      debug("files", "deleted_for_storage_limit", { path: file.path, size: file.size });

      // Try to remove empty parent directory
      const parentDir = path.dirname(file.path);
      try {
        const remaining = fs.readdirSync(parentDir);
        if (remaining.length === 0) {
          fs.rmdirSync(parentDir);
        }
      } catch {
        // Ignore directory cleanup errors
      }
    } catch {
      // Skip files we can't delete
    }
  }

  if (deletedCount > 0) {
    info("files", "storage_limit_enforced", {
      deletedFiles: deletedCount,
      freedMB: Math.round(deletedBytes / 1024 / 1024 * 100) / 100,
      remainingMB: Math.round(totalBytes / 1024 / 1024 * 100) / 100,
      limitMB: maxStorageMB,
    });
  }
}

/**
 * Clean orphaned session directories on startup
 * Orphaned = directories older than 24 hours (no active session should last that long)
 */
export function cleanOrphanedSessions(): void {
  if (!fs.existsSync(FILE_BASE_DIR)) {
    return;
  }

  const now = Date.now();
  let cleanedCount = 0;

  try {
    const sessions = fs.readdirSync(FILE_BASE_DIR);

    for (const sessionId of sessions) {
      const sessionDir = path.join(FILE_BASE_DIR, sessionId);

      try {
        const stat = fs.statSync(sessionDir);
        if (!stat.isDirectory()) {
          continue;
        }

        // Check if directory is older than threshold
        const age = now - stat.mtimeMs;
        if (age > ORPHAN_SESSION_AGE_MS) {
          // Remove all files in the session directory
          const files = fs.readdirSync(sessionDir);
          for (const file of files) {
            try {
              fs.unlinkSync(path.join(sessionDir, file));
            } catch {
              // Ignore individual file deletion errors
            }
          }

          // Remove the directory
          fs.rmdirSync(sessionDir);
          cleanedCount++;
          debug("files", "cleaned_orphaned_session", {
            sessionId,
            ageHours: Math.round(age / 1000 / 60 / 60 * 10) / 10,
          });
        }
      } catch {
        // Skip sessions we can't process
      }
    }

    if (cleanedCount > 0) {
      info("files", "orphaned_sessions_cleaned", { count: cleanedCount });
    }
  } catch (err) {
    logError("files", "clean_orphaned_sessions_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
