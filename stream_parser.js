class StreamParser {
    constructor() {
        this.buffer = "";
        this.responseCursor = 0; // Tracks where we are in the text stream
        this.inString = false;
        this.depth = 0; // Tracks JSON bracket depth
    }

    /**
     * Ingests a new chunk and returns:
     * - newText: Any new speech found in the "response" field
     * - completeObject: The full JSON object ONLY if it's finished
     */
    process(chunk) {
        this.buffer += chunk;
        let newAudioText = "";
        let completeObject = null;

        // --- 1. Smart Text Extraction (For TTS) ---
        // We look for the specific pattern: "response": "..."
        // We only read characters that we haven't read yet (using responseCursor).
        const responseMatch = this.buffer.match(/"response"\s*:\s*"/);
        
        if (responseMatch) {
            const startOfValue = responseMatch.index + responseMatch[0].length;
            
            // If we are just starting to read the response field, move cursor there
            if (this.responseCursor === 0) this.responseCursor = startOfValue;

            // Scan from the cursor to the end of the buffer
            let endOfValue = -1;
            let isEscaped = false;

            // We look for the closing quote " 
            for (let i = this.responseCursor; i < this.buffer.length; i++) {
                const char = this.buffer[i];
                
                if (char === '\\') {
                    isEscaped = !isEscaped;
                    continue; // Skip the next char logic
                }
                
                // If we hit an unescaped quote, the string is over
                if (char === '"' && !isEscaped) {
                    endOfValue = i;
                    break;
                }
                isEscaped = false;
            }

            // Determine how much text we can safely grab
            const extractUntil = endOfValue !== -1 ? endOfValue : this.buffer.length;
            
            if (extractUntil > this.responseCursor) {
                const rawText = this.buffer.substring(this.responseCursor, extractUntil);
                // Clean up escaped JSON characters (e.g. \" becomes ")
                newAudioText = rawText.replace(/\\"/g, '"').replace(/\\n/g, '\n');
                this.responseCursor = extractUntil;
            }
        }

        // --- 2. Safe JSON Completion Check (For Actions) ---
        // We count brackets. If depth returns to 0, the object is likely complete.
        if (this.isObjectComplete(this.buffer)) {
            try {
                completeObject = JSON.parse(this.buffer);
            } catch (e) {
                console.log("we failed here but it doesn't matter since we have already returned")
                // If it fails (rare edge cases), we wait for next chunk
            }
        }

        return { newAudioText, completeObject };
    }

    isObjectComplete(text) {
        let depth = 0;
        let inString = false;
        let isEscaped = false;
        
        // Simple state machine to count brackets, ignoring those inside strings
        for (const char of text) {
            if (char === '\\') {
                isEscaped = !isEscaped;
                continue;
            }
            if (char === '"' && !isEscaped) {
                inString = !inString;
            }
            if (!inString) {
                if (char === '{') depth++;
                if (char === '}') depth--;
            }
            isEscaped = false;
        }
        // If we opened brackets and now have 0, we are closed.
        return depth === 0 && text.trim().length > 0;
    }
}

module.exports = StreamParser