import { formatClock } from "../shared/format.js";
import type { SaveState } from "./types.js";

export function saveLabel(state: SaveState, hasPendingChanges: boolean, savedAt?: string | null): string {
  if (state === "saving") {
    return "正在保存";
  }

  if (state === "saved") {
    return "刚刚保存";
  }

  if (state === "error") {
    return "保存失败";
  }

  if (hasPendingChanges) {
    return "有未保存更改";
  }

  return savedAt ? `已保存 ${formatClock(savedAt)}` : "使用默认配置";
}

export function saveButtonLabel(state: SaveState, hasPendingChanges: boolean): string {
  if (state === "saving") {
    return "正在应用配置...";
  }

  if (state === "saved") {
    return "已应用";
  }

  return hasPendingChanges ? "应用更改" : "重新应用配置";
}
