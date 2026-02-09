/**
 * System management module for deep host machine integration.
 * Provides process, Docker, PM2, Homebrew, Git, disk, and network operations.
 */

import { execSync } from "child_process";
import { homedir } from "os";
import { env } from "./env";
import { safeExec, validateShellArg } from "./utils";

/** Telegram message character limit */
const TG_MSG_LIMIT = 4096;

/** Longer timeout for slow operations (30s) */
const LONG_TIMEOUT = 30000;

/** Very long timeout for speed tests etc (60s) */
const VERY_LONG_TIMEOUT = 60000;

/**
 * Execute a command with a custom timeout (for long-running ops).
 * Returns trimmed stdout or an error string.
 */
function execLong(command: string, timeoutMs: number = LONG_TIMEOUT, maxOutput: number = 3500): string {
  try {
    const result = execSync(command, {
      encoding: "utf-8",
      timeout: timeoutMs,
      maxBuffer: 2 * 1024 * 1024,
    });
    if (result.length > maxOutput) {
      return result.substring(0, maxOutput) + "\n... (truncated)";
    }
    return result;
  } catch (err: unknown) {
    if (err && typeof err === "object" && "stderr" in err) {
      const execErr = err as { stderr?: string; stdout?: string; message?: string };
      // Some commands write useful output to stdout even on non-zero exit
      if (execErr.stdout && execErr.stdout.trim().length > 0) {
        const out = execErr.stdout;
        if (out.length > maxOutput) {
          return out.substring(0, maxOutput) + "\n... (truncated)";
        }
        return out;
      }
      return `Error: ${execErr.stderr || execErr.message || "Command failed"}`;
    }
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/**
 * Truncate text to fit within Telegram's message limit,
 * leaving room for surrounding formatting.
 */
function truncate(text: string, limit: number = TG_MSG_LIMIT - 200): string {
  if (text.length <= limit) return text;
  return text.substring(0, limit) + "\n... (truncated)";
}

// ============ PROCESS MANAGEMENT ============

export function listProcesses(filter?: string): string {
  if (filter) {
    const validation = validateShellArg(filter, "generic");
    if (!validation.ok) return `Error: Invalid process filter (${validation.reason}).`;
  }
  const cmd = filter
    ? `ps aux | head -1; ps aux | grep -i "${filter}" | grep -v grep | head -30`
    : `ps aux --sort=-%mem | head -25`;
  return truncate(safeExec(cmd));
}

export function processDetails(pid: string): string {
  return truncate(safeExec(`ps -p ${pid} -o pid,ppid,user,%cpu,%mem,stat,start,time,command 2>&1`));
}

export function killProcess(pid: string, signal: string = "TERM"): string {
  // Validate PID is numeric
  if (!/^\d+$/.test(pid)) {
    return "Error: PID must be a number.";
  }
  return safeExec(`kill -${signal} ${pid} 2>&1 && echo "Signal ${signal} sent to PID ${pid}"`);
}

// ============ DOCKER ============

export function dockerList(all: boolean = false): string {
  const flag = all ? "-a" : "";
  return truncate(safeExec(`docker ps ${flag} --format "table {{.ID}}\t{{.Names}}\t{{.Status}}\t{{.Ports}}" 2>&1`));
}

export function dockerStart(container: string): string {
  const validation = validateShellArg(container, "container");
  if (!validation.ok) return `Error: Invalid container name (${validation.reason}).`;
  return safeExec(`docker start "${container}" 2>&1`);
}

export function dockerStop(container: string): string {
  const validation = validateShellArg(container, "container");
  if (!validation.ok) return `Error: Invalid container name (${validation.reason}).`;
  return safeExec(`docker stop "${container}" 2>&1`);
}

export function dockerRestart(container: string): string {
  const validation = validateShellArg(container, "container");
  if (!validation.ok) return `Error: Invalid container name (${validation.reason}).`;
  return safeExec(`docker restart "${container}" 2>&1`);
}

export function dockerLogs(container: string, lines: number = 50): string {
  const validation = validateShellArg(container, "container");
  if (!validation.ok) return `Error: Invalid container name (${validation.reason}).`;
  return truncate(execLong(`docker logs --tail ${lines} "${container}" 2>&1`));
}

export function dockerStats(): string {
  return truncate(safeExec(`docker stats --no-stream --format "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.NetIO}}" 2>&1`));
}

export function dockerInfo(): string {
  return truncate(safeExec(`docker system df 2>&1`));
}

// ============ PM2 ============

export function pm2List(): string {
  return truncate(execLong(`pm2 jlist 2>/dev/null | python3 -c "
import sys, json
data = json.load(sys.stdin)
if not data:
    print('No PM2 processes running.')
    sys.exit(0)
lines = []
for p in data:
    name = p.get('name','?')
    pid = p.get('pid','?')
    status = p.get('pm2_env',{}).get('status','?')
    cpu = p.get('monit',{}).get('cpu','?')
    mem_bytes = p.get('monit',{}).get('memory',0)
    mem_mb = round(mem_bytes / 1024 / 1024, 1) if mem_bytes else 0
    uptime_ms = p.get('pm2_env',{}).get('pm_uptime',0)
    restarts = p.get('pm2_env',{}).get('restart_time',0)
    import datetime
    up_since = datetime.datetime.fromtimestamp(uptime_ms/1000).strftime('%Y-%m-%d %H:%M') if uptime_ms else '?'
    lines.append(f'{name}  pid={pid}  {status}  cpu={cpu}%  mem={mem_mb}MB  restarts={restarts}  up={up_since}')
print('\\n'.join(lines))
" 2>&1`));
}

export function pm2Restart(name: string): string {
  const validation = validateShellArg(name, "container");
  if (!validation.ok) return `Error: Invalid PM2 process name (${validation.reason}).`;
  return execLong(`pm2 restart "${name}" 2>&1`);
}

export function pm2Stop(name: string): string {
  const validation = validateShellArg(name, "container");
  if (!validation.ok) return `Error: Invalid PM2 process name (${validation.reason}).`;
  return execLong(`pm2 stop "${name}" 2>&1`);
}

export function pm2Start(name: string): string {
  const validation = validateShellArg(name, "container");
  if (!validation.ok) return `Error: Invalid PM2 process name (${validation.reason}).`;
  return execLong(`pm2 start "${name}" 2>&1`);
}

export function pm2Logs(name: string, lines: number = 30): string {
  const validation = validateShellArg(name, "container");
  if (!validation.ok) return `Error: Invalid PM2 process name (${validation.reason}).`;
  return truncate(execLong(`pm2 logs "${name}" --lines ${lines} --nostream 2>&1`));
}

export function pm2Flush(): string {
  return execLong(`pm2 flush 2>&1`);
}

// ============ HOMEBREW ============

export function brewList(): string {
  return truncate(execLong(`brew list --formula 2>&1`, LONG_TIMEOUT));
}

export function brewOutdated(): string {
  return truncate(execLong(`brew outdated 2>&1`, LONG_TIMEOUT));
}

export function brewUpdate(): string {
  return truncate(execLong(`brew update 2>&1`, VERY_LONG_TIMEOUT));
}

export function brewUpgrade(pkg?: string): string {
  const cmd = pkg ? `brew upgrade "${pkg}" 2>&1` : `brew upgrade 2>&1`;
  return truncate(execLong(cmd, VERY_LONG_TIMEOUT));
}

// ============ GIT ============

const DEFAULT_REPOS: Record<string, string> = {
  gateway: env.TG_PROJECT_DIR,
};

function resolveRepoPath(repo?: string): string | null {
  if (!repo) return DEFAULT_REPOS.gateway;
  const validation = validateShellArg(repo, "path");
  if (!validation.ok) return null;
  // Check if it's a known alias
  if (DEFAULT_REPOS[repo]) return DEFAULT_REPOS[repo];
  // Check if it looks like an absolute path
  if (repo.startsWith("/")) return repo;
  return null;
}

export function gitStatus(repo?: string): string {
  const path = resolveRepoPath(repo);
  if (!path) return `Error: Unknown repo "${repo}". Known repos: ${Object.keys(DEFAULT_REPOS).join(", ")}`;
  return truncate(safeExec(`cd "${path}" && git status --short 2>&1 && echo "---" && git log --oneline -5 2>&1`));
}

export function gitLog(repo?: string, count: number = 10): string {
  const path = resolveRepoPath(repo);
  if (!path) return `Error: Unknown repo "${repo}". Known repos: ${Object.keys(DEFAULT_REPOS).join(", ")}`;
  return truncate(safeExec(`cd "${path}" && git log --oneline --graph -${count} 2>&1`));
}

export function gitPull(repo?: string): string {
  const path = resolveRepoPath(repo);
  if (!path) return `Error: Unknown repo "${repo}". Known repos: ${Object.keys(DEFAULT_REPOS).join(", ")}`;
  return truncate(execLong(`cd "${path}" && git pull 2>&1`));
}

// ============ DISK ============

export function diskUsageDetailed(): string {
  const df = safeExec("df -h / /System/Volumes/Data 2>/dev/null || df -h /");
  const topDirs = safeExec(`du -sh "${homedir()}"/* 2>/dev/null | sort -rh | head -10`);
  return truncate(`${df}\nTop directories:\n${topDirs}`);
}

export function largestFiles(path: string = homedir()): string {
  const validation = validateShellArg(path, "path");
  if (!validation.ok) return `Error: Invalid path (${validation.reason}).`;
  return truncate(execLong(`find "${path}" -type f -not -path "*/Library/*" -not -path "*/.Trash/*" 2>/dev/null | xargs du -sh 2>/dev/null | sort -rh | head -20`));
}

export function cleanupSuggestions(): string {
  const parts: string[] = [];

  const dockerSize = safeExec("docker system df 2>/dev/null || echo 'Docker not running'");
  parts.push(`Docker:\n${dockerSize.trim()}`);

  const brewCache = safeExec("du -sh $(brew --cache) 2>/dev/null || echo 'N/A'");
  parts.push(`Brew cache: ${brewCache.trim()}`);

  const npmCache = safeExec("du -sh ~/.npm 2>/dev/null || echo 'N/A'");
  parts.push(`npm cache: ${npmCache.trim()}`);

  const trash = safeExec("du -sh ~/.Trash 2>/dev/null || echo 'N/A'");
  parts.push(`Trash: ${trash.trim()}`);

  const logFiles = safeExec("du -sh /var/log 2>/dev/null || echo 'N/A'");
  parts.push(`System logs: ${logFiles.trim()}`);

  return truncate(parts.join("\n\n"));
}

// ============ NETWORK ============

export function activeConnections(): string {
  return truncate(safeExec(`netstat -an | grep ESTABLISHED | head -30 2>&1`));
}

export function listeningPorts(): string {
  return truncate(safeExec(`lsof -iTCP -sTCP:LISTEN -nP 2>/dev/null | awk 'NR==1 || !/com\\.docker/' | head -30`));
}

export function speedTest(): string {
  // Try networkQuality (built into macOS)
  return truncate(execLong(`networkQuality -s 2>&1`, VERY_LONG_TIMEOUT));
}

export function externalIP(): string {
  return safeExec(`curl -s --connect-timeout 5 https://ifconfig.me 2>&1`);
}

export function dnsLookup(domain: string): string {
  const validation = validateShellArg(domain, "domain");
  if (!validation.ok) return `Error: Invalid domain (${validation.reason}).`;
  return truncate(safeExec(`dig +short "${domain}" 2>&1`));
}

// ============ SYSTEM INFO ============

export function systemOverview(): string {
  const parts: string[] = [];

  // Hardware
  const hw = safeExec("system_profiler SPHardwareDataType 2>/dev/null | grep -E '(Model|Chip|Memory|Serial)' | sed 's/^[ ]*//'");
  parts.push(`HARDWARE:\n${hw.trim()}`);

  // Uptime & load
  const uptime = safeExec("uptime");
  parts.push(`UPTIME: ${uptime.trim()}`);

  // Memory
  const memPressure = safeExec("memory_pressure 2>/dev/null | head -5 || echo 'N/A'");
  parts.push(`MEMORY:\n${memPressure.trim()}`);

  // Disk
  const disk = safeExec("df -h / | tail -1");
  parts.push(`DISK: ${disk.trim()}`);

  // Top processes by CPU
  const topCpu = safeExec("ps aux --sort=-%cpu | head -6 | awk '{printf \"%-12s %5s %5s %s\\n\", $1, $3, $4, $11}'");
  parts.push(`TOP CPU:\n${topCpu.trim()}`);

  // Top processes by memory
  const topMem = safeExec("ps aux --sort=-%mem | head -6 | awk '{printf \"%-12s %5s %5s %s\\n\", $1, $3, $4, $11}'");
  parts.push(`TOP MEM:\n${topMem.trim()}`);

  // Docker summary
  const dockerCount = safeExec("docker ps --format '{{.Names}}' 2>/dev/null | wc -l || echo 'N/A'");
  parts.push(`DOCKER: ${dockerCount.trim()} running containers`);

  // PM2 summary
  const pm2Count = safeExec("pm2 jlist 2>/dev/null | python3 -c \"import sys,json; d=json.load(sys.stdin); print(f'{len([p for p in d if p.get(\\\"pm2_env\\\",{}).get(\\\"status\\\")==\\\"online\\\"])} online, {len(d)} total')\" 2>/dev/null || echo 'N/A'");
  parts.push(`PM2: ${pm2Count.trim()}`);

  // Network
  const ip = safeExec("ipconfig getifaddr en0 2>/dev/null || echo 'N/A'");
  parts.push(`LOCAL IP: ${ip.trim()}`);

  return truncate(parts.join("\n\n"));
}

export function hardwareInfo(): string {
  return truncate(safeExec("system_profiler SPHardwareDataType 2>/dev/null"));
}

export function temperatures(): string {
  // Try osx-cpu-temp first, then fall back to powermetrics hint
  const temp = execLong("osx-cpu-temp 2>/dev/null || echo 'osx-cpu-temp not installed. Install with: brew install osx-cpu-temp'");
  return temp.trim();
}
