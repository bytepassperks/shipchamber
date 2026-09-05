import type { Session } from '@opencode-ai/sdk/v2';

export type SessionMetadataRecord = Record<string, unknown>;

type ShipChamberMetadata = {
  kind?: 'review';
  originalSessionID?: string;
  reviewSessionID?: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));

export const getSessionMetadata = (session: Session | null | undefined): SessionMetadataRecord => {
  const metadata = (session as (Session & { metadata?: unknown }) | null | undefined)?.metadata;
  return isRecord(metadata) ? metadata : {};
};

const getShipChamberMetadata = (metadata: SessionMetadataRecord): ShipChamberMetadata => {
  const value = metadata.shipchamber;
  return isRecord(value) ? value as ShipChamberMetadata : {};
};

export const getReviewSessionID = (session: Session | null | undefined): string | null => {
  const value = getShipChamberMetadata(getSessionMetadata(session)).reviewSessionID;
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
};

export const getOriginalSessionID = (session: Session | null | undefined): string | null => {
  const value = getShipChamberMetadata(getSessionMetadata(session)).originalSessionID;
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
};

export const isReviewSession = (session: Session | null | undefined): boolean =>
  getShipChamberMetadata(getSessionMetadata(session)).kind === 'review' && Boolean(getOriginalSessionID(session));

export const withReviewSessionLink = (
  metadata: SessionMetadataRecord,
  reviewSessionID: string,
): SessionMetadataRecord => {
  const current = getShipChamberMetadata(metadata);
  return {
    ...metadata,
    shipchamber: {
      ...current,
      reviewSessionID,
    },
  };
};

export const withReviewSessionMarker = (
  metadata: SessionMetadataRecord,
  originalSessionID: string,
): SessionMetadataRecord => {
  const current = getShipChamberMetadata(metadata);
  return {
    ...metadata,
    shipchamber: {
      ...current,
      kind: 'review' as const,
      originalSessionID,
    },
  };
};

export const withoutReviewSessionLink = (
  metadata: SessionMetadataRecord,
  reviewSessionID: string,
): SessionMetadataRecord => {
  const current = getShipChamberMetadata(metadata);
  if (current.reviewSessionID !== reviewSessionID) return metadata;

  const restShipChamber = { ...current };
  delete restShipChamber.reviewSessionID;
  const next: SessionMetadataRecord = { ...metadata };
  if (Object.keys(restShipChamber).length > 0) {
    next.shipchamber = restShipChamber;
  } else {
    delete next.shipchamber;
  }
  return next;
};
