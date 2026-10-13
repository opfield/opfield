import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** An ISO string, epoch milliseconds or a Date; missing values format as "—". */
export type DateInput = string | number | Date | null | undefined;

const MISSING_DATE = "—";

// Fixed English abbreviations: ICU's en-GB data spells September "Sept",
// which breaks the three-letter rhythm of date columns.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The Date for a value, or null when it is missing or not a valid moment. */
export function parseDate(date: DateInput): Date | null {
  if (date === null || date === undefined || date === "") return null;
  const value = date instanceof Date ? date : new Date(date);
  return Number.isNaN(value.getTime()) ? null : value;
}

const twoDigits = (value: number) => String(value).padStart(2, "0");
const dayMonth = (value: Date) => `${twoDigits(value.getDate())} ${MONTHS[value.getMonth()]}`;
const clockTime = (value: Date) =>
  `${twoDigits(value.getHours())}:${twoDigits(value.getMinutes())}`;

/** A calendar date without time, "26 Feb 2026": expiry, validity windows. */
export function formatDate(date: DateInput) {
  const value = parseDate(date);
  return value ? `${dayMonth(value)} ${value.getFullYear()}` : MISSING_DATE;
}

/** The exact moment, "26 Sep 2026, 07:47": tooltips, deadlines and future times. */
export function formatDateTime(date: DateInput) {
  const value = parseDate(date);
  return value ? `${dayMonth(value)} ${value.getFullYear()}, ${clockTime(value)}` : MISSING_DATE;
}

/**
 * The one format for past events: "Just now", "14m ago", "3h ago", "2d ago"
 * within a week, then "16 Oct 15:32" this year and "16 Oct 2025" before.
 * Render it through `RelativeTime` to carry the exact moment in a tooltip.
 */
export function formatRelativeDate(date: DateInput, now: Date = new Date()) {
  const value = parseDate(date);
  if (!value) return MISSING_DATE;
  const diffInSeconds = Math.floor((now.getTime() - value.getTime()) / 1000);

  if (diffInSeconds < 60) return "Just now";
  if (diffInSeconds < 3600) return `${Math.floor(diffInSeconds / 60)}m ago`;
  if (diffInSeconds < 86400) return `${Math.floor(diffInSeconds / 3600)}h ago`;
  if (diffInSeconds < 604800) return `${Math.floor(diffInSeconds / 86400)}d ago`;
  if (value.getFullYear() === now.getFullYear()) return `${dayMonth(value)} ${clockTime(value)}`;
  return formatDate(value);
}

export function daysUntil(date: string | Date): number {
  const now = new Date();
  const then = new Date(date);
  const diff = (then.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
  if (diff <= 0) return 0;
  return Math.floor(diff);
}

export function hoursUntil(date: string | Date): number {
  const now = new Date();
  const then = new Date(date);
  const diff = (then.getTime() - now.getTime()) / (1000 * 60 * 60);
  if (diff <= 0) return 0;
  return Math.floor(diff);
}

/** Human-friendly "Xd left" / "Xh left" / "Expires today" */
export function formatTimeLeft(date: string | Date): string {
  const days = daysUntil(date);
  if (days > 0) return `${days}d left`;
  const hours = hoursUntil(date);
  if (hours > 0) return `${hours}h left`;
  return "Expires today";
}

export function getInitials(name: string) {
  return name
    .split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

export function formatSerialNumber(serial: string): string {
  return serial
    .replace(/(.{2})/g, "$1:")
    .slice(0, -1)
    .toUpperCase();
}

export function truncate(str: string, length: number): string {
  if (str.length <= length) return str;
  return `${str.slice(0, length)}...`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.max(0, Math.min(sizes.length - 1, Math.floor(Math.log(bytes) / Math.log(k))));
  return `${(bytes / k ** i).toFixed(1)} ${sizes[i]}`;
}

/**
 * A file descriptor limit as the node reports it. An unlimited one arrives as RLIM_INFINITY (2^64 - 1, or 2^63 - 1
 * once read as a signed number); no host has a real limit anywhere near 2^62.
 */
export function formatFileDescriptorLimit(limit: number): string {
  if (!Number.isFinite(limit) || limit >= 2 ** 62) return "Unlimited";
  return limit.toLocaleString();
}

export function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h ${mins}m`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}
