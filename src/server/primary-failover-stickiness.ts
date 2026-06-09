import type {
  PrimaryRouteRequestContext,
  PrimaryRouteResult,
  PrimaryRouteSelection
} from "./primary-failover-types.js";
import {
  enforceMaxEntries,
  normalizeMaxEntries,
  rememberMapEntry
} from "./primary-failover-limits.js";
import { readResponseId } from "./primary-failover-result.js";

const SESSION_STICKY_TTL_MS = 30 * 60 * 1000;
const CONTINUATION_STICKY_TTL_MS = 2 * 60 * 60 * 1000;
const DEFAULT_MAX_STICKY_ENTRIES = 2_048;

interface StickyEntry {
  profileId: string;
  expiresAt: number;
}

export class PrimaryStickinessStore {
  private readonly sessionStickiness = new Map<string, StickyEntry>();

  private readonly continuationStickiness = new Map<string, StickyEntry>();

  private readonly compactionStateStickiness = new Map<string, StickyEntry>();

  private readonly maxEntries: number;

  constructor(maxEntries?: number) {
    this.maxEntries = normalizeMaxEntries(maxEntries, DEFAULT_MAX_STICKY_ENTRIES);
  }

  clear(): void {
    this.sessionStickiness.clear();
    this.continuationStickiness.clear();
    this.compactionStateStickiness.clear();
  }

  selectProfileId(
    context: Required<PrimaryRouteRequestContext>,
    isUsable: (profileId: string) => boolean
  ): string | null {
    const stickyProfileIds = [
      context.previousResponseId
        ? this.continuationStickiness.get(context.previousResponseId)?.profileId
        : null,
      context.compactionStateKey
        ? this.compactionStateStickiness.get(context.compactionStateKey)?.profileId
        : null,
      context.sessionKey
        ? this.sessionStickiness.get(context.sessionKey)?.profileId
        : null
    ];

    for (const profileId of stickyProfileIds) {
      if (profileId && isUsable(profileId)) {
        return profileId;
      }
    }

    return null;
  }

  rememberRequest(
    context: Required<PrimaryRouteRequestContext>,
    profileId: string,
    now: number
  ): void {
    if (context.sessionKey) {
      this.rememberStickyEntry(this.sessionStickiness, context.sessionKey, {
        profileId,
        expiresAt: now + SESSION_STICKY_TTL_MS
      });
    }
    if (context.previousResponseId) {
      this.rememberStickyEntry(this.continuationStickiness, context.previousResponseId, {
        profileId,
        expiresAt: now + CONTINUATION_STICKY_TTL_MS
      });
    }
  }

  rememberResponse(
    selection: PrimaryRouteSelection,
    result: PrimaryRouteResult,
    now: number
  ): void {
    if (!selection.profileId) {
      return;
    }

    const responseId = readResponseId(result);
    if (responseId) {
      this.rememberStickyEntry(this.continuationStickiness, responseId, {
        profileId: selection.profileId,
        expiresAt: now + CONTINUATION_STICKY_TTL_MS
      });
    }
    if (selection.context.sessionKey) {
      this.rememberStickyEntry(this.sessionStickiness, selection.context.sessionKey, {
        profileId: selection.profileId,
        expiresAt: now + SESSION_STICKY_TTL_MS
      });
    }
    if (selection.context.compactionStateKey) {
      this.rememberStickyEntry(this.compactionStateStickiness, selection.context.compactionStateKey, {
        profileId: selection.profileId,
        expiresAt: now + CONTINUATION_STICKY_TTL_MS
      });
    }
  }

  cleanup(now: number): void {
    cleanupStickyMap(this.sessionStickiness, now);
    cleanupStickyMap(this.continuationStickiness, now);
    cleanupStickyMap(this.compactionStateStickiness, now);
  }

  private rememberStickyEntry(
    map: Map<string, StickyEntry>,
    key: string,
    entry: StickyEntry
  ): void {
    rememberMapEntry(map, key, entry);
    enforceMaxEntries(map, this.maxEntries);
  }
}

function cleanupStickyMap(map: Map<string, StickyEntry>, now: number): void {
  for (const [key, entry] of map.entries()) {
    if (entry.expiresAt <= now) {
      map.delete(key);
    }
  }
}
