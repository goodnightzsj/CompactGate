import { useEffect, useRef, useState } from "react";
import type * as React from "react";
import type { ProfileDropPosition, PublicConfigProfile } from "./types.js";

export function useProfileDragReorder({
  canReorderProfiles,
  onReorderProfiles,
  profiles
}: {
  canReorderProfiles: boolean;
  onReorderProfiles: (profileIds: string[]) => void | Promise<void>;
  profiles: PublicConfigProfile[];
}) {
  const profileListRef = useRef<HTMLDivElement | null>(null);
  const profileAutoScrollRef = useRef<{ frame: number | null; speed: number }>({
    frame: null,
    speed: 0
  });
  const [draggedProfileId, setDraggedProfileId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ profileId: string; position: ProfileDropPosition } | null>(null);

  useEffect(() => () => stopProfileAutoScroll(), []);

  function nextProfileOrder(
    draggedId: string,
    targetId: string,
    position: ProfileDropPosition
  ): string[] | null {
    if (draggedId === targetId) {
      return null;
    }

    const currentIds = profiles.map((profile) => profile.id);
    if (!currentIds.includes(draggedId) || !currentIds.includes(targetId)) {
      return null;
    }

    const withoutDragged = currentIds.filter((profileId) => profileId !== draggedId);
    const targetIndex = withoutDragged.indexOf(targetId);
    if (targetIndex < 0) {
      return null;
    }

    const insertIndex = position === "after" ? targetIndex + 1 : targetIndex;
    const nextIds = [...withoutDragged];
    nextIds.splice(insertIndex, 0, draggedId);

    return nextIds.every((profileId, index) => profileId === currentIds[index]) ? null : nextIds;
  }

  function dropPositionForEvent(event: React.DragEvent<HTMLElement>): ProfileDropPosition {
    const bounds = event.currentTarget.getBoundingClientRect();
    return event.clientY > bounds.top + bounds.height / 2 ? "after" : "before";
  }

  function stopProfileAutoScroll() {
    const frame = profileAutoScrollRef.current.frame;
    if (frame !== null) {
      window.cancelAnimationFrame(frame);
      profileAutoScrollRef.current.frame = null;
    }
    profileAutoScrollRef.current.speed = 0;
  }

  function runProfileAutoScroll() {
    const list = profileListRef.current;
    const speed = profileAutoScrollRef.current.speed;
    if (!list || speed === 0) {
      stopProfileAutoScroll();
      return;
    }

    const previousScrollTop = list.scrollTop;
    list.scrollTop += speed;
    if (list.scrollTop === previousScrollTop) {
      stopProfileAutoScroll();
      return;
    }

    profileAutoScrollRef.current.frame = window.requestAnimationFrame(runProfileAutoScroll);
  }

  function startProfileAutoScroll(speed: number) {
    profileAutoScrollRef.current.speed = speed;
    if (profileAutoScrollRef.current.frame === null) {
      profileAutoScrollRef.current.frame = window.requestAnimationFrame(runProfileAutoScroll);
    }
  }

  function updateProfileAutoScroll(event: React.DragEvent<HTMLElement>) {
    const list = profileListRef.current;
    if (!list || list.scrollHeight <= list.clientHeight) {
      stopProfileAutoScroll();
      return;
    }

    const bounds = list.getBoundingClientRect();
    const edgeSize = Math.min(112, Math.max(56, bounds.height * 0.42));
    const distanceFromTop = event.clientY - bounds.top;
    const distanceFromBottom = bounds.bottom - event.clientY;
    const maxSpeed = 8;

    if (distanceFromTop < edgeSize) {
      const intensity = 1 - Math.max(0, distanceFromTop) / edgeSize;
      startProfileAutoScroll(-Math.max(2, Math.round(maxSpeed * intensity * intensity)));
      return;
    }

    if (distanceFromBottom < edgeSize) {
      const intensity = 1 - Math.max(0, distanceFromBottom) / edgeSize;
      startProfileAutoScroll(Math.max(2, Math.round(maxSpeed * intensity * intensity)));
      return;
    }

    stopProfileAutoScroll();
  }

  function resetDragState() {
    stopProfileAutoScroll();
    setDraggedProfileId(null);
    setDropTarget(null);
  }

  function handleProfileDragStart(event: React.DragEvent<HTMLElement>, profileId: string) {
    if (!canReorderProfiles) {
      event.preventDefault();
      return;
    }

    const card = event.currentTarget.closest(".profile-item") as HTMLElement | null;
    if (card) {
      const bounds = card.getBoundingClientRect();
      event.dataTransfer.setDragImage(card, event.clientX - bounds.left, event.clientY - bounds.top);
    }
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", profileId);
    setDraggedProfileId(profileId);
    setDropTarget(null);
  }

  function handleProfileListDragOver(event: React.DragEvent<HTMLDivElement>) {
    if (!draggedProfileId || !canReorderProfiles) {
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    updateProfileAutoScroll(event);
  }

  function handleProfileListDragLeave(event: React.DragEvent<HTMLDivElement>) {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
      return;
    }

    stopProfileAutoScroll();
  }

  function handleProfileDragOver(event: React.DragEvent<HTMLElement>, profileId: string) {
    if (!draggedProfileId || !canReorderProfiles) {
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    updateProfileAutoScroll(event);
    if (draggedProfileId === profileId) {
      setDropTarget(null);
      return;
    }

    setDropTarget({
      profileId,
      position: dropPositionForEvent(event)
    });
  }

  function handleProfileDragLeave(event: React.DragEvent<HTMLElement>, profileId: string) {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
      return;
    }

    setDropTarget((current) => current?.profileId === profileId ? null : current);
  }

  function handleProfileDrop(event: React.DragEvent<HTMLElement>, profileId: string) {
    event.preventDefault();

    const draggedId = draggedProfileId ?? event.dataTransfer.getData("text/plain");
    const position = dropTarget?.profileId === profileId
      ? dropTarget.position
      : dropPositionForEvent(event);
    const nextIds = nextProfileOrder(draggedId, profileId, position);

    resetDragState();
    if (nextIds) {
      void onReorderProfiles(nextIds);
    }
  }

  return {
    draggedProfileId,
    dropTarget,
    handleProfileDragLeave,
    handleProfileDragOver,
    handleProfileDragStart,
    handleProfileDrop,
    handleProfileListDragLeave,
    handleProfileListDragOver,
    profileListRef,
    resetDragState
  };
}
