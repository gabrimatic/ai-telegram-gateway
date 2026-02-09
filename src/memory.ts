import { existsSync, readFileSync, writeFileSync, appendFileSync, renameSync } from "fs";
import { dirname, join } from "path";
import { getConfig } from "./config";
import { getProviderDisplayName } from "./provider";
import { info, error, debug } from "./logger";
import { runAI } from "./ai";
import { FailureCategory } from "./failure-classifier";

const SECTION_HEADER = "## Telegram Session Log";
const FAILURE_SECTION_HEADER = "## Telegram Failure Log";

function atomicWriteFileSync(filePath: string, content: string): void {
  const tempPath = join(dirname(filePath), `.${Date.now()}.tmp`);
  writeFileSync(tempPath, content);
  renameSync(tempPath, filePath);
}

function getDateTimeString(): string {
  const now = new Date();
  return now.toISOString().replace("T", " ").substring(0, 16);
}

function ensureMemoryFile(): void {
  const config = getConfig();
  if (!existsSync(config.memoryPath)) {
    writeFileSync(config.memoryPath, `# ${getProviderDisplayName()} Memory\n\n`);
  }
}

function ensureSectionExists(): void {
  const config = getConfig();
  ensureMemoryFile();

  const content = readFileSync(config.memoryPath, "utf-8");
  if (!content.includes(SECTION_HEADER)) {
    appendFileSync(config.memoryPath, `\n${SECTION_HEADER}\n\n`);
  }
}

export async function saveSessionSummary(): Promise<boolean> {
  const config = getConfig();

  info("memory", "session_summary_starting");

  try {
    // Ask the AI provider to summarize the session
    const response = await runAI(config.sessionSummaryPrompt);

    if (!response.success || !response.response) {
      error("memory", "session_summary_failed", {
        error: response.error || "Empty response",
      });
      return false;
    }

    const summary = response.response.trim();
    debug("memory", "session_summary_received", { length: summary.length });

    // Append to memory file
    ensureSectionExists();

    const entry = `\n### ${getDateTimeString()}\n${summary}\n`;
    const content = readFileSync(config.memoryPath, "utf-8");

    // Find the section and append after it (using atomic write)
    const sectionIndex = content.indexOf(SECTION_HEADER);
    if (sectionIndex === -1) {
      atomicWriteFileSync(config.memoryPath, content + entry);
    } else {
      // Insert after the section header
      const beforeSection = content.substring(0, sectionIndex + SECTION_HEADER.length);
      const afterSection = content.substring(sectionIndex + SECTION_HEADER.length);
      atomicWriteFileSync(config.memoryPath, beforeSection + "\n" + entry + afterSection);
    }

    info("memory", "session_summary_saved", { path: config.memoryPath });
    return true;
  } catch (err) {
    error("memory", "session_summary_error", {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

export function appendToMemory(text: string): void {
  const config = getConfig();
  ensureSectionExists();

  const entry = `\n### ${getDateTimeString()}\n${text}\n`;
  const content = readFileSync(config.memoryPath, "utf-8");

  const sectionIndex = content.indexOf(SECTION_HEADER);
  if (sectionIndex === -1) {
    atomicWriteFileSync(config.memoryPath, content + entry);
  } else {
    const beforeSection = content.substring(0, sectionIndex + SECTION_HEADER.length);
    const afterSection = content.substring(sectionIndex + SECTION_HEADER.length);
    atomicWriteFileSync(config.memoryPath, beforeSection + "\n" + entry + afterSection);
  }
}

export function recordFailure(
  category: FailureCategory,
  message: string,
  errorMsg: string,
  resolution: string
): void {
  try {
    const config = getConfig();
    ensureMemoryFile();

    let content = readFileSync(config.memoryPath, "utf-8");

    // Ensure failure section exists (in-memory, single read)
    if (!content.includes(FAILURE_SECTION_HEADER)) {
      content += `\n${FAILURE_SECTION_HEADER}\n\n`;
    }

    const entry = [
      `\n### ${getDateTimeString()}`,
      `- Category: ${category}`,
      `- Message: "${message.substring(0, 100)}${message.length > 100 ? '...' : ''}"`,
      `- Error: ${errorMsg.substring(0, 200)}`,
      `- Resolution: ${resolution}`,
      "",
    ].join("\n");

    const failureIndex = content.indexOf(FAILURE_SECTION_HEADER);

    if (failureIndex === -1) {
      atomicWriteFileSync(config.memoryPath, content + entry);
    } else {
      const beforeSection = content.substring(0, failureIndex + FAILURE_SECTION_HEADER.length);
      const afterSection = content.substring(failureIndex + FAILURE_SECTION_HEADER.length);
      atomicWriteFileSync(config.memoryPath, beforeSection + entry + afterSection);
    }

    debug("memory", "failure_recorded", { category, resolution });
  } catch (err) {
    error("memory", "record_failure_error", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export function loadMemoryContext(): string | undefined {
  const config = getConfig();

  if (!existsSync(config.memoryPath)) {
    return undefined;
  }

  try {
    const content = readFileSync(config.memoryPath, "utf-8");

    // Extract the most recent session log entry (first 200 chars)
    const sessionIndex = content.indexOf(SECTION_HEADER);
    if (sessionIndex === -1) {
      return undefined;
    }

    const afterHeader = content.substring(sessionIndex + SECTION_HEADER.length);
    const firstEntry = afterHeader.match(/###[^#]+/);

    if (firstEntry) {
      const entry = firstEntry[0].trim();
      return entry.length > 200 ? entry.substring(0, 200) + "..." : entry;
    }

    return undefined;
  } catch (err) {
    debug("memory", "load_context_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}
