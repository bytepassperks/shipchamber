import type { Session } from '@opencode-ai/sdk/v2';
import { getSessionMetadata, type SessionMetadataRecord } from '@/lib/sessionReviewMetadata';

/**
 * Session-metadata contract for the `/btw` flow, mirroring the review-session
 * link in `sessionReviewMetadata`:
 *
 * - The parent (the session `/btw` was typed into) carries
 *   `shipchamber.btwSessionID` pointing at its active btw fork. The panel is
 *   derived from this link, so it appears only in the parent session and
 *   survives reloads.
 * - The fork itself is marked `shipchamber.kind = 'btw'` with
 *   `originalSessionID` (its parent) and `btwBoundaryMessageID` — the id of
 *   the last message cloned from the parent. Messages with a greater id are
 *   the fork's own tail and are what the panel renders. Message ids are
 *   server-generated ascending identifiers, so the boundary is a plain string
 *   comparison and immune to client clock skew.
 */
type BtwMetadata = {
  kind?: string;
  originalSessionID?: string;
  btwSessionID?: string;
  btwBoundaryMessageID?: string;
  btwPromoted?: boolean;
};

const getShipChamberMetadata = (metadata: SessionMetadataRecord): BtwMetadata => {
  const value = metadata.shipchamber;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  // SAFETY: session metadata is persisted, externally writable data; this is
  // its parsing boundary. `BtwMetadata` only declares optional fields and
  // every reader re-validates the field it consumes in `nonEmpty`.
  return value as BtwMetadata;
};

const nonEmpty = (value: string | undefined): string | null =>
  typeof value === 'string' && value.trim().length > 0 ? value : null;

/** The parent's link to its active btw fork, or null. */
export const getBtwSessionID = (session: Session | null | undefined): string | null =>
  nonEmpty(getShipChamberMetadata(getSessionMetadata(session)).btwSessionID);

/**
 * The session was once a btw fork and was promoted to a normal session.
 *
 * Its transcript still contains the btw boundary instruction on every message
 * sent while it was a side conversation, and there is no API to remove a
 * message part after the fact. The flag lets the composer send a notice that
 * those constraints have been lifted, so they cannot keep steering a session
 * that is no longer a side conversation.
 */
export const wasPromotedBtwSession = (session: Session | null | undefined): boolean =>
  getShipChamberMetadata(getSessionMetadata(session)).btwPromoted === true;

export const isBtwSession = (session: Session | null | undefined): boolean =>
  getShipChamberMetadata(getSessionMetadata(session)).kind === 'btw'
  && Boolean(getBtwOriginalSessionID(session));

/** The fork's back-pointer to the session `/btw` was typed into. */
export const getBtwOriginalSessionID = (session: Session | null | undefined): string | null => {
  const shipchamber = getShipChamberMetadata(getSessionMetadata(session));
  return shipchamber.kind === 'btw' ? nonEmpty(shipchamber.originalSessionID) : null;
};

/**
 * The id of the last message the fork inherited from the parent. `null` means
 * the fork inherited nothing (empty parent) and every message is its own.
 */
export const getBtwBoundaryMessageID = (session: Session | null | undefined): string | null => {
  const shipchamber = getShipChamberMetadata(getSessionMetadata(session));
  return shipchamber.kind === 'btw' ? nonEmpty(shipchamber.btwBoundaryMessageID) : null;
};

export const withBtwSessionLink = (
  metadata: SessionMetadataRecord,
  btwSessionID: string,
): SessionMetadataRecord => ({
  ...metadata,
  shipchamber: {
    ...getShipChamberMetadata(metadata),
    btwSessionID,
  },
});

/**
 * Mark the fork as a btw session. The fork clones the parent's metadata
 * wholesale (including review links or a stale `btwSessionID`), so the
 * inherited `shipchamber` object is replaced, not merged.
 */
export const withBtwSessionMarker = (
  metadata: SessionMetadataRecord,
  originalSessionID: string,
  boundaryMessageID: string | null,
): SessionMetadataRecord => {
  const shipchamber: BtwMetadata = { kind: 'btw', originalSessionID };
  if (boundaryMessageID) shipchamber.btwBoundaryMessageID = boundaryMessageID;
  return { ...metadata, shipchamber };
};

/**
 * Remove the btw marker so a promoted fork becomes a plain session.
 *
 * `btwPromoted` replaces it rather than leaving nothing behind: the btw
 * boundary instructions stay in the transcript forever, so the session has to
 * remain distinguishable from one that was never a side conversation.
 */
export const withoutBtwSessionMarker = (metadata: SessionMetadataRecord): SessionMetadataRecord => {
  const shipchamber = getShipChamberMetadata(metadata);
  if (shipchamber.kind !== 'btw') return metadata;
  const rest: BtwMetadata = { ...shipchamber };
  delete rest.kind;
  delete rest.originalSessionID;
  delete rest.btwBoundaryMessageID;
  rest.btwPromoted = true;
  return { ...metadata, shipchamber: rest };
};

/** Unlink the parent, but only if it still points at this fork. */
export const withoutBtwSessionLink = (
  metadata: SessionMetadataRecord,
  btwSessionID: string,
): SessionMetadataRecord => {
  const shipchamber = getShipChamberMetadata(metadata);
  if (shipchamber.btwSessionID !== btwSessionID) return metadata;
  const rest: BtwMetadata = { ...shipchamber };
  delete rest.btwSessionID;
  const next: SessionMetadataRecord = { ...metadata };
  if (Object.keys(rest).length > 0) {
    next.shipchamber = rest;
  } else {
    delete next.shipchamber;
  }
  return next;
};
