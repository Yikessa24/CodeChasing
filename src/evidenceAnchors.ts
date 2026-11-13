import type { PaperChunk, PaperCitation, PaperRecord } from './types.js';

function normalize(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** Resolves both content-addressed citations and older ordinal IDs without silent drift. */
export function resolvePaperCitation(
  record: PaperRecord,
  citation: Pick<PaperCitation, 'chunkId' | 'page' | 'preview' | 'boxes'>
): PaperChunk | undefined {
  const preview = normalize(citation.preview ?? '');
  const needle = preview.slice(0, 80);
  let chunk = record.chunks.find((candidate) => candidate.id === citation.chunkId);
  if (chunk && /:c\d+$/.test(citation.chunkId) && !needle) {
    chunk = undefined;
  }
  if (chunk && needle && !normalize(chunk.text).includes(needle)) {
    chunk = undefined;
  }
  if (!chunk && needle) {
    chunk = record.chunks.find((candidate) => normalize(candidate.text).includes(needle));
  }
  if (!chunk && citation.page && citation.boxes?.length) {
    return {
      id: citation.chunkId,
      page: citation.page,
      text: citation.preview ?? '',
      boxes: citation.boxes
    };
  }
  return chunk;
}

export function stripTransientCitationMarkers(content: string): string {
  return content.replace(/\[(?:P|C)\d+\]/g, '[source from that earlier answer]');
}
