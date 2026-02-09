import { getProviderDisplayName } from "./provider";
import { ValidationReason } from "./validator";

export type FailureCategory =
  | 'timeout'
  | 'process_crash'
  | 'confusion'
  | 'mcp_tool_failure'
  | 'invalid_response'
  | 'unknown';

const TIMEOUT_PATTERNS = [
  /timed?\s*out/i,
  /timeout/i,
  /deadline exceeded/i,
];

const CRASH_PATTERNS = [
  /process exited/i,
  /SIGKILL|SIGTERM|SIGSEGV/,
  /killed/i,
  /crashed/i,
  /unexpected exit/i,
];

const MCP_PATTERNS = [
  /mcp/i,
  /tool.*fail/i,
  /connection refused/i,
  /ECONNREFUSED/,
  /could not connect/i,
  /server.*unavailable/i,
  /gmail_|calendar_|google-services/i,
];

export function classifyFailure(
  error?: string,
  validationReason?: ValidationReason
): FailureCategory {
  // If we have a validation reason, map it
  if (validationReason) {
    switch (validationReason) {
      case 'confusion':
        return 'confusion';
      case 'empty':
      case 'truncated':
      case 'error_leak':
      case 'loop':
        return 'invalid_response';
    }
  }

  // If no error string, return unknown
  if (!error) {
    return 'unknown';
  }

  // Check for timeout
  for (const pattern of TIMEOUT_PATTERNS) {
    if (pattern.test(error)) {
      return 'timeout';
    }
  }

  // Check for crash
  for (const pattern of CRASH_PATTERNS) {
    if (pattern.test(error)) {
      return 'process_crash';
    }
  }

  // Check for MCP/tool failures
  for (const pattern of MCP_PATTERNS) {
    if (pattern.test(error)) {
      return 'mcp_tool_failure';
    }
  }

  return 'unknown';
}

export function getFailureDescription(category: FailureCategory): string {
  const providerName = getProviderDisplayName();
  switch (category) {
    case 'timeout':
      return 'Request timed out';
    case 'process_crash':
      return `${providerName} process crashed`;
    case 'confusion':
      return `${providerName} was confused by the request`;
    case 'mcp_tool_failure':
      return 'An external tool failed';
    case 'invalid_response':
      return 'Response was invalid or incomplete';
    case 'unknown':
      return 'Unknown error';
  }
}
