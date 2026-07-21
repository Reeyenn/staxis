import { isUuid } from '@/lib/api-validate';

export type CommsAttachmentKind = 'photo' | 'voice';

export interface ParsedCommsAttachmentPath {
  propertyId: string;
  conversationId: string;
  objectId: string;
  extension: string;
  kind: CommsAttachmentKind;
}

const PHOTO_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif']);
const VOICE_EXTENSIONS = new Set(['webm', 'm4a', 'mp3', 'mp4', 'ogg', 'wav', 'aac']);

/**
 * Validate the complete private-storage namespace emitted by presignAttachment.
 * The embedded property and conversation ids are authorization data, not just
 * naming conventions, so callers must compare the returned conversation id to
 * the conversation they have already authorized.
 */
export function parseCommsAttachmentPath(
  expectedPropertyId: string,
  path: unknown,
): ParsedCommsAttachmentPath | null {
  if (typeof path !== 'string' || path.length === 0 || path.length > 300) return null;
  const segments = path.split('/');
  if (segments.length !== 4) return null;
  const [propertyId, namespace, conversationId, filename] = segments;
  if (propertyId !== expectedPropertyId || namespace !== 'comms') return null;
  if (!isUuid(propertyId) || !isUuid(conversationId)) return null;

  const dot = filename.lastIndexOf('.');
  if (dot <= 0 || dot === filename.length - 1) return null;
  const objectId = filename.slice(0, dot);
  const extension = filename.slice(dot + 1).toLowerCase();
  if (!isUuid(objectId)) return null;

  const kind: CommsAttachmentKind | null = PHOTO_EXTENSIONS.has(extension)
    ? 'photo'
    : VOICE_EXTENSIONS.has(extension)
      ? 'voice'
      : null;
  if (!kind) return null;

  return { propertyId, conversationId, objectId, extension, kind };
}

export function attachmentBelongsToConversation(
  expectedPropertyId: string,
  expectedConversationId: string,
  path: unknown,
): ParsedCommsAttachmentPath | null {
  const parsed = parseCommsAttachmentPath(expectedPropertyId, path);
  return parsed?.conversationId === expectedConversationId ? parsed : null;
}
