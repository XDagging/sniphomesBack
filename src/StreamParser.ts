export interface ParseResult {
  newAudioText: string;
  completeObject: Record<string, unknown> | null;
}

export class StreamParser {
  private buffer        = '';
  private responseCursor = 0;

  process(chunk: string): ParseResult {
    this.buffer += chunk;
    let newAudioText = '';
    let completeObject: Record<string, unknown> | null = null;

    // Extract text from "response": "..." field for streaming TTS
    const responseMatch = this.buffer.match(/"response"\s*:\s*"/);
    if (responseMatch && responseMatch.index !== undefined) {
      const startOfValue = responseMatch.index + responseMatch[0].length;
      if (this.responseCursor === 0) this.responseCursor = startOfValue;

      let endOfValue = -1;
      let isEscaped = false;

      for (let i = this.responseCursor; i < this.buffer.length; i++) {
        const char = this.buffer[i];
        if (char === '\\') {
          isEscaped = !isEscaped;
          continue;
        }
        if (char === '"' && !isEscaped) {
          endOfValue = i;
          break;
        }
        isEscaped = false;
      }

      const extractUntil = endOfValue !== -1 ? endOfValue : this.buffer.length;
      if (extractUntil > this.responseCursor) {
        const rawText = this.buffer.substring(this.responseCursor, extractUntil);
        newAudioText = rawText.replace(/\\"/g, '"').replace(/\\n/g, '\n');
        this.responseCursor = extractUntil;
      }
    }

    // Detect complete JSON object
    if (this.isObjectComplete(this.buffer)) {
      try {
        completeObject = JSON.parse(this.buffer) as Record<string, unknown>;
      } catch (_) {
        // wait for next chunk
      }
    }

    return { newAudioText, completeObject };
  }

  private isObjectComplete(text: string): boolean {
    let depth = 0;
    let inString = false;
    let isEscaped = false;

    for (const char of text) {
      if (char === '\\') {
        isEscaped = !isEscaped;
        continue;
      }
      if (char === '"' && !isEscaped) inString = !inString;
      if (!inString) {
        if (char === '{') depth++;
        if (char === '}') depth--;
      }
      isEscaped = false;
    }
    return depth === 0 && text.trim().length > 0;
  }
}

export default StreamParser;
