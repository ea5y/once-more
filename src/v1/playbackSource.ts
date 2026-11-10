import { hasLatestExtraction, type Conversation } from './model';

/** The library keeps source-relative timestamps; an exported clip starts at zero. */
export function playbackSource(item: Conversation, preferExtracted: boolean) {
  const clipPath = preferExtracted && hasLatestExtraction(item) ? item.clipPath : undefined;
  return { clipPath, start: clipPath ? 0 : item.start };
}
