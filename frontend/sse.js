/**
 * Minimal Server-Sent Events parser for a fetch() response body.
 * Works on POST streams, which EventSource cannot do.
 */

/** Parse one raw SSE block ("event: x\ndata: {...}") into {event, data}. */
export function parseEventBlock(raw) {
  let event = 'message';
  const data = [];
  for (const line of raw.split('\n')) {
    if (line.startsWith(':')) continue; // comment / heartbeat
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  }
  if (!data.length) return null;
  try {
    return { event, data: JSON.parse(data.join('\n')) };
  } catch {
    return null;
  }
}

/**
 * Reads an SSE stream and calls onEvent for each parsed event.
 * @param {ReadableStream<Uint8Array>} body
 * @param {(evt: {event: string, data: any}) => void} onEvent
 */
export async function readEventStream(body, onEvent) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index;
    while ((index = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const evt = parseEventBlock(block);
      if (evt) onEvent(evt);
    }
  }
  buffer += decoder.decode();
  const tail = parseEventBlock(buffer.trim());
  if (tail) onEvent(tail);
}
