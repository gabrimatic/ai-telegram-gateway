import { InlineKeyboard } from "grammy";
import {
  getScheduleById,
  getSchedules,
  getRandomCheckinStatus,
  isRandomCheckinMasterSchedule,
  isRandomCheckinMessageSchedule,
  Schedule,
} from "./task-scheduler";

type ScheduleListKind = "active" | "inactive";

const TIMEZONE = "Europe/Berlin";
const PAGE_SIZE = 5;
const BUTTON_TITLE_MAX = 20;
const LINE_TITLE_MAX = 42;

export interface ScheduleView {
  text: string;
  keyboard: InlineKeyboard;
}

function truncate(text: string, max: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(max - 3, 1))}...`;
}

function formatBerlinDate(iso?: string): string {
  if (!iso) return "n/a";
  const value = new Date(iso);
  if (Number.isNaN(value.getTime())) return "n/a";
  return value.toLocaleString("en-GB", {
    timeZone: TIMEZONE,
    dateStyle: "short",
    timeStyle: "short",
  });
}

function getScheduleTitle(schedule: Schedule): string {
  if (schedule.name && schedule.name.trim().length > 0) {
    return schedule.name.trim();
  }
  if (isRandomCheckinMasterSchedule(schedule)) {
    return "Random check-ins daily planner";
  }
  if (isRandomCheckinMessageSchedule(schedule)) {
    return "Random check-in";
  }
  return schedule.task;
}

function getScheduleTimeSummary(schedule: Schedule): string {
  if (schedule.type === "cron") {
    return `cron ${schedule.cronExpression ?? "n/a"}`;
  }
  const at = schedule.nextRun ?? schedule.scheduledTime;
  return `at ${formatBerlinDate(at)}`;
}

function getScheduleIcon(schedule: Schedule): string {
  if (schedule.status === "active") return "🟢";
  if (schedule.status === "completed") return "✅";
  if (schedule.status === "cancelled") return "❌";
  return "🔴";
}

function buildPageNavigation(
  keyboard: InlineKeyboard,
  kind: ScheduleListKind | "remove",
  page: number,
  totalPages: number
): void {
  if (totalPages <= 1) return;
  if (page > 0) {
    const prev = page - 1;
    const callback = kind === "remove"
      ? `sched_remove_${prev}`
      : `sched_view_${kind}_${prev}`;
    keyboard.text("⬅️ Prev", callback);
  }
  if (page < totalPages - 1) {
    const next = page + 1;
    const callback = kind === "remove"
      ? `sched_remove_${next}`
      : `sched_view_${kind}_${next}`;
    keyboard.text("Next ➡️", callback);
  }
  keyboard.row();
}

function getPageBounds(total: number, requestedPage: number): { page: number; totalPages: number; start: number; end: number } {
  const totalPages = Math.max(Math.ceil(total / PAGE_SIZE), 1);
  const page = Math.min(Math.max(requestedPage, 0), totalPages - 1);
  const start = page * PAGE_SIZE;
  const end = Math.min(start + PAGE_SIZE, total);
  return { page, totalPages, start, end };
}

export function buildScheduleHomeView(userId: string, notice?: string): ScheduleView {
  const schedules = getSchedules(userId);
  const active = schedules.filter((schedule) => schedule.status === "active");
  const inactive = schedules.filter((schedule) => schedule.status !== "active");
  const randomStatus = getRandomCheckinStatus(userId);

  const lines: string[] = [];
  lines.push("📅 Schedule Manager");
  if (notice) {
    lines.push("");
    lines.push(notice);
  }
  lines.push("");
  lines.push(`Active schedules: ${active.length}`);
  lines.push(`Inactive schedules: ${inactive.length}`);
  lines.push(`Random check-ins: ${randomStatus.enabled ? `ON (${randomStatus.activeMessageCount} queued today)` : "OFF"}`);
  lines.push("");
  lines.push("Use the buttons to browse or remove schedules.");

  const keyboard = new InlineKeyboard()
    .text(`📋 Active (${active.length})`, "sched_view_active_0")
    .text(`🗃 Inactive (${inactive.length})`, "sched_view_inactive_0")
    .row()
    .text("🗑 Remove schedules", "sched_remove_0")
    .row();

  if (randomStatus.enabled) {
    keyboard
      .text("🛑 Disable random check-ins", "sched_checkin_disable")
      .row()
      .text("🎲 Regenerate today", "sched_checkin_regen")
      .row();
  } else {
    keyboard
      .text("🎲 Enable random check-ins", "sched_checkin_enable")
      .row();
  }

  keyboard.text("🔄 Refresh", "sched_home");
  return {
    text: lines.join("\n"),
    keyboard,
  };
}

export function buildScheduleListView(
  userId: string,
  kind: ScheduleListKind,
  requestedPage: number,
  notice?: string
): ScheduleView {
  const schedules = getSchedules(userId).filter((schedule) => kind === "active"
    ? schedule.status === "active"
    : schedule.status !== "active");
  const { page, totalPages, start, end } = getPageBounds(schedules.length, requestedPage);
  const pageItems = schedules.slice(start, end);

  const header = kind === "active" ? "📋 Active Schedules" : "🗃 Inactive Schedules";
  const lines: string[] = [header];
  if (notice) {
    lines.push("");
    lines.push(notice);
  }
  lines.push("");

  if (pageItems.length === 0) {
    lines.push(kind === "active" ? "No active schedules." : "No inactive schedules.");
  } else {
    lines.push(`Showing ${start + 1}-${end} of ${schedules.length}`);
    lines.push("");
    for (const schedule of pageItems) {
      lines.push(`${getScheduleIcon(schedule)} #${schedule.id} ${truncate(getScheduleTitle(schedule), LINE_TITLE_MAX)}`);
      lines.push(`   ${getScheduleTimeSummary(schedule)}`);
    }
  }

  const keyboard = new InlineKeyboard();
  buildPageNavigation(keyboard, kind, page, totalPages);
  if (kind === "active") {
    keyboard.text("🗑 Remove one", `sched_remove_${page}`).row();
  }
  keyboard.text("⬅️ Back", "sched_home");

  return {
    text: lines.join("\n"),
    keyboard,
  };
}

export function buildScheduleRemoveView(userId: string, requestedPage: number, notice?: string): ScheduleView {
  const activeSchedules = getSchedules(userId).filter((schedule) => schedule.status === "active");
  const { page, totalPages, start, end } = getPageBounds(activeSchedules.length, requestedPage);
  const pageItems = activeSchedules.slice(start, end);

  const lines: string[] = ["🗑 Remove Schedules"];
  if (notice) {
    lines.push("");
    lines.push(notice);
  }
  lines.push("");

  if (pageItems.length === 0) {
    lines.push("No active schedules to remove.");
  } else {
    lines.push(`Tap one to cancel it (${start + 1}-${end} of ${activeSchedules.length}):`);
  }

  const keyboard = new InlineKeyboard();
  for (const schedule of pageItems) {
    const buttonTitle = truncate(getScheduleTitle(schedule), BUTTON_TITLE_MAX);
    keyboard.text(`🗑 #${schedule.id} ${buttonTitle}`, `sched_rm_id_${schedule.id}_${page}`).row();
  }

  buildPageNavigation(keyboard, "remove", page, totalPages);
  keyboard.text("⬅️ Back", "sched_home");

  return {
    text: lines.join("\n"),
    keyboard,
  };
}

export function buildScheduleRemoveConfirmView(userId: string, scheduleId: number, page: number): ScheduleView {
  const schedule = getScheduleById(scheduleId, userId);

  if (!schedule || schedule.status !== "active") {
    return {
      text: `Schedule #${scheduleId} is not active or no longer exists.`,
      keyboard: new InlineKeyboard()
        .text("⬅️ Back to remove list", `sched_remove_${Math.max(page, 0)}`)
        .row()
        .text("🏠 Schedule home", "sched_home"),
    };
  }

  const lines: string[] = [];
  lines.push(`⚠️ Remove schedule #${schedule.id}?`);
  lines.push("");
  lines.push(truncate(getScheduleTitle(schedule), 80));
  lines.push(getScheduleTimeSummary(schedule));
  lines.push("");
  lines.push("This will cancel it immediately.");

  return {
    text: lines.join("\n"),
    keyboard: new InlineKeyboard()
      .text("✅ Yes, remove", `sched_rm_ok_${schedule.id}_${Math.max(page, 0)}`)
      .text("✋ Keep it", `sched_remove_${Math.max(page, 0)}`)
      .row()
      .text("🏠 Schedule home", "sched_home"),
  };
}
