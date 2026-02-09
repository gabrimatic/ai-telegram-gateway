import { exec, execSync } from "child_process";
import { promisify } from "util";
import * as os from "os";
import { getConfig } from "./config";
import { warn, error, debug } from "./logger";

const execAsync = promisify(exec);

export interface MemoryUsage {
  heapUsed: number;
  heapTotal: number;
  rss: number;
  percentUsed: number;
}

export interface DiskUsage {
  total: number;
  used: number;
  available: number;
  percentUsed: number;
}

export type ResourceStatus = "ok" | "warning" | "critical";

export interface ResourceWarning {
  resource: "memory" | "disk";
  status: ResourceStatus;
  message: string;
  percentUsed: number;
}

export interface ResourceCheckResult {
  status: ResourceStatus;
  memory: MemoryUsage;
  disk: DiskUsage | null;
  warnings: ResourceWarning[];
}

export function getMemoryUsage(): MemoryUsage {
  const memUsage = process.memoryUsage();
  const totalMem = os.totalmem();
  const darwinPercentUsed = getDarwinPercentUsed(totalMem);
  const usedMem = totalMem - os.freemem();
  const percentUsed =
    darwinPercentUsed !== null ? darwinPercentUsed : (usedMem / totalMem) * 100;

  return {
    heapUsed: memUsage.heapUsed,
    heapTotal: memUsage.heapTotal,
    rss: memUsage.rss,
    percentUsed,
  };
}

function getDarwinPercentUsed(totalMem: number): number | null {
  if (process.platform !== "darwin") return null;

  try {
    const pressureOutput = String(execSync("memory_pressure -Q"));
    const freeMatch = pressureOutput.match(/free percentage:\s*([0-9.]+)%/i);
    if (freeMatch) {
      const freePercent = parseFloat(freeMatch[1]);
      if (Number.isFinite(freePercent)) {
        return Math.min(100, Math.max(0, 100 - freePercent));
      }
    }
  } catch {
    // fall through to vm_stat parsing
  }

  try {
    const output = String(execSync("vm_stat"));
    const pageSizeMatch = output.match(/page size of (\d+) bytes/i);
    if (!pageSizeMatch) return null;
    const pageSize = parseInt(pageSizeMatch[1], 10);

    const stats = new Map<string, number>();
    for (const line of output.split("\n")) {
      const match = line.match(/^Pages (.+):\s+(\d+)\./);
      if (match) {
        stats.set(match[1].trim(), parseInt(match[2], 10));
      }
    }

    const free = stats.get("free") ?? 0;
    const inactive = stats.get("inactive") ?? 0;
    const speculative = stats.get("speculative") ?? 0;
    const purgeable = stats.get("purgeable") ?? 0;

    const availablePages = free + inactive + speculative + purgeable;
    const availableBytes = availablePages * pageSize;
    const usedBytes = Math.max(0, totalMem - availableBytes);
    const percentUsed = (usedBytes / totalMem) * 100;

    if (!Number.isFinite(percentUsed)) return null;
    return Math.min(100, Math.max(0, percentUsed));
  } catch {
    return null;
  }
}

export async function getDiskUsage(path: string): Promise<DiskUsage | null> {
  try {
    const { stdout } = await execAsync(`df -k "${path}"`);
    const lines = stdout.trim().split("\n");
    if (lines.length < 2) {
      error("resource-monitor", "df_parse_error", { reason: "insufficient_lines", path });
      return null;
    }

    // Parse df output (header: Filesystem 1K-blocks Used Available Use% Mounted on)
    const parts = lines[1].split(/\s+/);
    if (parts.length < 5) {
      error("resource-monitor", "df_parse_error", { reason: "insufficient_columns", path });
      return null;
    }

    // Values from df -k are in 1K blocks
    const total = parseInt(parts[1], 10) * 1024;
    const used = parseInt(parts[2], 10) * 1024;
    const available = parseInt(parts[3], 10) * 1024;
    const percentUsed = (used / total) * 100;

    return {
      total,
      used,
      available,
      percentUsed,
    };
  } catch (err) {
    error("resource-monitor", "disk_check_failed", {
      error: err instanceof Error ? err.message : String(err),
      path,
    });
    return null;
  }
}

export async function checkResources(diskPath?: string): Promise<ResourceCheckResult> {
  const config = getConfig();
  const warnings: ResourceWarning[] = [];
  let overallStatus: ResourceStatus = "ok";

  // Check memory
  const memory = getMemoryUsage();

  if (memory.percentUsed >= config.resources.memoryCriticalPercent) {
    warnings.push({
      resource: "memory",
      status: "critical",
      message: `Memory usage critical: ${memory.percentUsed.toFixed(1)}%`,
      percentUsed: memory.percentUsed,
    });
    overallStatus = "critical";
    warn("resource-monitor", "memory_critical", { percentUsed: memory.percentUsed });
  } else if (memory.percentUsed >= config.resources.memoryWarningPercent) {
    warnings.push({
      resource: "memory",
      status: "warning",
      message: `Memory usage high: ${memory.percentUsed.toFixed(1)}%`,
      percentUsed: memory.percentUsed,
    });
    if (overallStatus === "ok") overallStatus = "warning";
    warn("resource-monitor", "memory_warning", { percentUsed: memory.percentUsed });
  }

  // Check disk
  const pathToCheck = diskPath || config.resources.diskPath;
  const disk = await getDiskUsage(pathToCheck);

  if (disk) {
    // Disk critical threshold is 95%
    const diskCriticalPercent = 95;

    if (disk.percentUsed >= diskCriticalPercent) {
      warnings.push({
        resource: "disk",
        status: "critical",
        message: `Disk usage critical: ${disk.percentUsed.toFixed(1)}%`,
        percentUsed: disk.percentUsed,
      });
      overallStatus = "critical";
      warn("resource-monitor", "disk_critical", { percentUsed: disk.percentUsed, path: pathToCheck });
    } else if (disk.percentUsed >= config.resources.diskWarningPercent) {
      warnings.push({
        resource: "disk",
        status: "warning",
        message: `Disk usage high: ${disk.percentUsed.toFixed(1)}%`,
        percentUsed: disk.percentUsed,
      });
      if (overallStatus === "ok") overallStatus = "warning";
      warn("resource-monitor", "disk_warning", { percentUsed: disk.percentUsed, path: pathToCheck });
    }
  }

  debug("resource-monitor", "check_complete", {
    status: overallStatus,
    memoryPercent: memory.percentUsed,
    diskPercent: disk?.percentUsed ?? null,
  });

  return {
    status: overallStatus,
    memory,
    disk,
    warnings,
  };
}

export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }

  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

export function formatResourceStatus(result: ResourceCheckResult): string {
  const lines: string[] = [];

  lines.push(`Resource Status: ${result.status.toUpperCase()}`);
  lines.push("");
  lines.push("Memory:");
  lines.push(`  Heap Used: ${formatBytes(result.memory.heapUsed)}`);
  lines.push(`  Heap Total: ${formatBytes(result.memory.heapTotal)}`);
  lines.push(`  RSS: ${formatBytes(result.memory.rss)}`);
  lines.push(`  System Used: ${result.memory.percentUsed.toFixed(1)}%`);

  if (result.disk) {
    lines.push("");
    lines.push("Disk:");
    lines.push(`  Total: ${formatBytes(result.disk.total)}`);
    lines.push(`  Used: ${formatBytes(result.disk.used)}`);
    lines.push(`  Available: ${formatBytes(result.disk.available)}`);
    lines.push(`  Percent Used: ${result.disk.percentUsed.toFixed(1)}%`);
  }

  if (result.warnings.length > 0) {
    lines.push("");
    lines.push("Warnings:");
    for (const warning of result.warnings) {
      lines.push(`  [${warning.status.toUpperCase()}] ${warning.message}`);
    }
  }

  return lines.join("\n");
}
