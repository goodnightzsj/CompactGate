import { formatClock } from "../shared/format.js";
import type { SaveState } from "./types.js";

export function saveLabel(state: SaveState, hasPendingChanges: boolean, savedAt?: string | null): string {
  if (state === "saving") {
    return "正在保存";
  }

  if (state === "saved") {
    return "刚刚保存";
  }

  // Pending changes outrank a past failure, matching `saveButtonLabel`, which has
  // no error branch at all and already reads "保存到当前档案并应用" here. The two
  // used to contradict each other for as long as the draft stayed dirty, and the
  // reason for the failure is on the error banner either way.
  if (hasPendingChanges) {
    return "有未保存更改";
  }

  if (state === "error") {
    return "保存失败";
  }

  return savedAt ? `已保存 ${formatClock(savedAt)}` : "使用默认配置";
}

export function saveButtonLabel(
  state: SaveState,
  hasPendingChanges: boolean,
  savesActiveProfiles = false
): string {
  if (state === "saving") {
    return savesActiveProfiles ? "正在保存并应用..." : "正在应用配置...";
  }

  if (state === "saved") {
    return savesActiveProfiles ? "已保存并应用" : "已应用";
  }

  if (hasPendingChanges) {
    return savesActiveProfiles ? "保存到当前档案并应用" : "应用更改";
  }

  return savesActiveProfiles ? "重新保存并应用" : "重新应用配置";
}
