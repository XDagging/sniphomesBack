require("dotenv").config();
const speech = require("@google-cloud/speech");
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require("@google/generative-ai");
// const fetch = require('node-fetch'); // Make sure you have node-fetch installed: npm install node-fetch
const { Readable } = require("stream");

// --- Gemini Setup ---
const genAI = new GoogleGenerativeAI(process.env.GEMINI_KEY);
const safetySettings = [
    { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
    { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
    { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
    { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
];

// --- Twilio Setup ---
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const client = require("twilio")(accountSid, authToken);

class Call {
    constructor(callSid, phoneNumber, agentAction, agentLocation, agentName, uuid) {
        this.uuid = uuid;
        this.callSid = callSid;
        this.phoneNumber = phoneNumber;
        this.agentAction = agentAction;
        this.agentLocation = agentLocation;
        this.agentName = agentName;

        this.noStart = false;
        this.streamSid = "";
        this.ws = null;
        this.googleSpeechClient = new speech.SpeechClient();
        this.googleSpeechStream = null;

        this.transcript = [];
        this.messageNumber = 0;

        this.aiTalking = false;
        this.userSpeaking = false;
        this.speechTimeout = null;
        this.sendingAudio = false; // Track if we're actively sending audio to Twilio
        this.interrupted = false; // Track if user interrupted the AI

        this.aiDuration = 0;

        // --- Optimization 1: Use Gemini Chat History ---
        // We create the model and chat session ONCE, with the system prompt.
        // This avoids sending the massive prompt and full history every single turn.
        this.model = genAI.getGenerativeModel({
            model: "gemini-2.5-flash",
            generationConfig: {
                temperature: 0.2,
                // --- Optimization 2: Use JSON Mode ---
                // This guarantees valid JSON output, so we can remove all the
                // brittle string splitting and parsing logic in processResponse.
                responseMimeType: "application/json",
                responseSchema: {
                    type: "OBJECT",
                    properties: {
                        response: { type: "STRING" },
                        rating: { type: "NUMBER" },
                        hangUp: { type: "BOOLEAN" },
                    },
                    required: ["response", "rating", "hangUp"],
                },
            },
            safetySettings,
        });

        const systemPrompt = this.buildSystemPrompt(agentName, agentLocation, agentAction);
        this.chat = this.model.startChat({
            history: [
                { role: "user", parts: [{ text: systemPrompt }] },
                {
                    role: "model",
                    parts: [{
                        text: JSON.stringify({
                            response: `Hello, I am ${this.agentName}, a real estate agent. I was wondering if you were interested in ${this.agentAction}ing a house?`,
                            rating: 5, // Initial rating
                            hangUp: false
                        })
                    }]
                }
            ],
        });

        console.log(`[${this.callSid}] New call initialized.`);
        this.hangupTimer = setTimeout(() => this.hangup(), 180 * 1000); // 3-minute max call
    }

    buildSystemPrompt(personName, personOperating, personLook) {
        const personNumber = "3011233212"; // This should probably be an arg
        const formattedNumber = "three, zero, one, one, two, three, three, two, one, two";

        const buyBool = "Ask the person what budget their budget is and how many people they plan to move in with. Redirect them to the manager if they give one, but push for both answers. DO NOT ASK ANY OTHER QUESTIONS.";
        const sellBool = `Tell the person about ${personOperating} area and ask them if they are homeowners. If so, ask them for the following info: would they be willing to sell their house, and if so, for how much? How many people do you live with currently (if they ask why we are asking, it is to grasp how large the home)? If they answer at least 1 of those questions, redirect to mananger. DO NOT ASK ANY OTHER QUESTIONS.`;
        const promptBool = personLook.toLowerCase() === "sell" ? sellBool : buyBool;

        // This prompt is sent only ONCE.
        return `
            You are a real estate agent named Marta. Your task is to engage naturally, asking relevant questions and responding appropriately based on what the person says. Your goal is to see if they are in the market for buying a house by engaging in a conversation. If the person isn't in the market for ${personLook}ing a house, ask them that they could contact you anytime. Be a little bit flirty with the person. 

            If the caller talks about voicemail or the call seems to hang, hangup the call and leave the message: Hi. I'm ${personName} and I called your number because I'm a local real estate agent in ${personOperating} wondering with if you are interested in ${personLook}ing a house in the area. If you are, please return a call to ${formattedNumber}. Thanks for your time!

            Ensure that each response is contextually appropriate and advances the conversation toward assessing the person's interest. Always keep the conversation concise and avoid repeating yourself unnecessarily. Try to keep your responses short, but be friendly.

            If the person seems interested in ${personLook} a house, tell them the following:
            "Let me forward you to my manager ${personName}. He'll call you using the following number, ${formattedNumber}. Have a great day!" and then make the hangup boolean value true 

            Heres the manager's personal contact information:
            Phone Number: ${personNumber}
            Name: ${personName}

            If they ask for any other mean of communication tell them the following: "Sorry, he only operates via phone number."
            Remember, the real estate agent operates in ${personOperating} meaning that if they ask anything any details about the home, tell them that its located in ${personOperating}

            Add pauses when deemed appropiate. To add a pause, use insert the following syntax: <break time='0.5s' /> with the time= being the amount of time that you want it to pause for. For example, <break time="0.5s" /> will pause for 0.5 second. This should be in the response: field

            ${promptBool}

            Output your response in the specified JSON format.
            1. "response": The next statement or question you will say.
            2. "rating": A number from 1 to 100 indicating the likelihood that this person is a good lead.
            3. "hangUp": A boolean value indicating whether you should hangup.

            The conversation history will be provided. Start with your first greeting.
        `;
    }

    async setWebsocket(ws, streamSid) {
        this.ws = ws;
        // Once this has ran once, the start will never be run again;
        if (!this.noStart) {
            this.streamSid = streamSid;

            console.log(`[${this.callSid}] Twilio stream started (${this.streamSid}).`);
            // --- Optimization 3: Start Persistent STT Stream ---
            // We start the STT stream and it stays open, listening.
            this.startGoogleSpeechStream();
            // Start the conversation
            this.startConversation();
            this.noStart = true;
        }

        this.ws.on("message", (message) => {
            // console.log("we got a message inside the websocket")
            const msg = JSON.parse(message);
            switch (msg.event) {
                case "connected":
                    console.log(`[${this.callSid}] Twilio stream connected.`);
                    break;
                case "media":
                    // This is the raw audio data
                    // We write it to Google STT stream
                    if (this.googleSpeechStream && this.googleSpeechStream.writable) {
                        this.googleSpeechStream.write(msg.media.payload);

                        // --- Simple VAD (Voice Activity Detection) ---
                        // We reset a timer every time we get new audio.
                        // If the timer fires, it means the user stopped talking.
                        this.userSpeaking = true;
                        if (this.speechTimeout) {
                            clearTimeout(this.speechTimeout);
                        }
                        this.speechTimeout = setTimeout(() => {
                            if (this.userSpeaking) {
                                console.log(`[${this.callSid}] Silence detected, ending user turn.`);
                                this.userSpeaking = false;
                                if (!this.sendingAudio) {
                                    this.stopGoogleSpeechStream(); // Stop listening
                                    // The 'isFinal' result from STT will trigger the LLM
                                }
                            }
                        }, 600); // 0.6 seconds of silence
                    }
                    break;
                case "stop":
                    console.log(`[${this.callSid}] Twilio stream stopped.`);
                    this.hangup();
                    break;
            }
        });
    }

    startGoogleSpeechStream() {
        if (this.googleSpeechStream) {
            this.googleSpeechStream.destroy();
            this.googleSpeechStream = null;
        }

        console.log(`[${this.callSid}] Starting new Google STT stream.`);
        this.googleSpeechStream = this.googleSpeechClient
            .streamingRecognize({
                config: {
                    encoding: "MULAW",
                    sampleRateHertz: 8000,
                    languageCode: "en-US",
                    interimResults: true, // We need interim results for faster interruption
                },
            })
            .on("error", (error) => {
                console.error(`[${this.callSid}] STT Error:`, error);
            })
            .on("data", (data) => {
                const result = data.results[0];
                if (result && result.alternatives[0]) {
                    const transcript = result.alternatives[0].transcript.trim();

                    // --- Interruption Detection ---
                    if (this.sendingAudio && transcript.length > 0) {
                        console.log(`[${this.callSid}] User interrupting AI (STT): "${transcript}"`);
                        this.interrupted = true;
                        this.sendingAudio = false;
                        this.sendClear();
                    }

                    if (result.isFinal) {
                        const transcript = result.alternatives[0].transcript.trim();
                        console.log(`[${this.callSid}] STT Final: "${transcript}"`);

                        if (this.speechTimeout) {
                            clearTimeout(this.speechTimeout);
                            this.speechTimeout = null;
                        }
                        this.userSpeaking = false;

                        // --- This is the trigger ---
                        // We got a final transcript, now process it with the LLM.
                        this.processLLM(transcript);
                    }
                }
            });
    }

    stopGoogleSpeechStream() {
        if (this.googleSpeechStream) {
            console.log(`[${this.callSid}] Stopping Google STT stream.`);
            this.googleSpeechStream.end();
        }
    }

    async startConversation() {
        // This function sends the *initial* greeting from the chat history
        this.aiTalking = true;
        const initialHistory = await this.chat.getHistory();
        const initialResponse = initialHistory[1].parts[0].text;

        // The initial response is already in our JSON format
        // We use processResponse, which is built for this.
        this.processResponse(initialResponse);
    }

    async processLLM(transcript) {
        if (!transcript) {
            console.log(`[${this.callSid}] Empty transcript, restarting STT.`);
            this.aiTalking = false; // Allow user to speak again
            this.startGoogleSpeechStream(); // Start listening again
            return;
        }

        this.aiTalking = true; // AI is now "thinking" and will talk
        this.stopGoogleSpeechStream(); // Stop listening while we process and talk

        this.transcript.push({
            sender: "Person on the phone",
            message: transcript,
            order: this.messageNumber++,
        });

        console.log(`[${this.callSid}] Sending to Gemini: "${transcript}"`);

        try {
            // --- Optimization 4: LLM Streaming ---
            // We ask Gemini for a *stream* of text, not a single response.
            const result = await this.chat.sendMessageStream(transcript);
            const stream = result.stream;

            let sentenceBuffer = "";
            let jsonBuffer = "";
            let inJsonBlock = false;

            for await (const chunk of stream) {
                const chunkText = chunk.text();

                // --- Handle JSON streaming ---
                // The JSON response itself might be streamed.
                if (!inJsonBlock && chunkText.includes('{')) {
                    inJsonBlock = true;
                }
                if (inJsonBlock) {
                    jsonBuffer += chunkText;
                    if (chunkText.includes('}')) {
                        inJsonBlock = false;
                        // We have the full JSON, process it.
                        // We only expect ONE JSON object per turn.
                        console.log(`[${this.callSid}] Gemini Raw JSON: ${jsonBuffer} `);
                        this.processResponse(jsonBuffer);
                        jsonBuffer = ""; // Reset for next turn
                    }
                }
            }
        } catch (error) {
            console.error(`[${this.callSid}] Error streaming from Gemini: `, error);
            // In case of error, just go back to listening
            this.aiTalking = false;
            this.startGoogleSpeechStream();
        }
    }

    calculatePlayback(audioDataLength, sampleRate) {
        // ulaw is 8 bits (1 byte) per sample.
        // So byte length / sample rate = duration in seconds
        return audioDataLength / sampleRate;
    }

    async processResponse(geminiResponse) {
        try {
            let fedToTwilio;
            try {
                // Remove markdown backticks if present
                const cleanJson = geminiResponse.replace(/```json\s*/g, "").replace(/```/g, "").trim();
                fedToTwilio = JSON.parse(cleanJson);
            } catch (e) {
                console.error(`[${this.callSid}] Failed to parse Gemini JSON:`, e);
                console.error(`[${this.callSid}] Raw response: ${geminiResponse}`);
                // Simple retry/recovery: just listen again
                this.aiTalking = false;
                this.startGoogleSpeechStream();
                return;
            }

            if (!fedToTwilio.response || fedToTwilio.response.trim() === "") {
                console.log(`[${this.callSid}] Gemini gave empty response, listening again.`);
                this.aiTalking = false;
                this.startGoogleSpeechStream();
                return;
            }

            // We have a valid response to say.
            this.transcript.push({
                sender: "You",
                message: fedToTwilio.response,
                order: this.messageNumber++,
            });
            this.rating = fedToTwilio.rating; // Assuming this.rating exists

            // Generate audio and stream it to Twilio
            const audioStream = await this.generateAudio(fedToTwilio.response);
            console.log(`[${this.callSid}] Streaming TTS to Twilio.`);

            // --- LATENCY OPTIMIZATION ---
            // Start listening IMMEDIATELY, don't wait for audio to finish playing
            this.aiTalking = false;
            this.interrupted = false;
            this.sendingAudio = true;
            this.startGoogleSpeechStream();

            let totalAudioLength = 0;

            for await (const audioChunk of audioStream) {
                // --- INTERRUPTION HANDLING ---
                // Stop sending audio if user interrupted
                if (this.interrupted) {
                    console.log(`[${this.callSid}] Stopping audio send due to interruption.`);
                    break;
                }

                const buffer = Buffer.from(audioChunk).toString("base64");
                this.sendAudioChunk(buffer);
                totalAudioLength += audioChunk.length;
            }

            this.sendingAudio = false;

            const durationInSec = this.calculatePlayback(totalAudioLength, 8000);
            const durationInMs = durationInSec * 1000;

            if (this.interrupted) {
                console.log(`[${this.callSid}] Audio interrupted by user. Already listening.`);
            } else {
                console.log(`[${this.callSid}] TTS streaming finished.`);

                // Check if we should hang up after audio finishes
                if (fedToTwilio.hangUp) {
                    // Wait for audio to finish playing before hanging up
                    setTimeout(() => {
                        console.log(`[${this.callSid}] Hanging up after audio playback.`);
                        this.hangup();
                    }, durationInMs + 300);
                }
            }

        } catch (e) {
            console.error(`[${this.callSid}] Error in processResponse:`, e);
            this.aiTalking = false;
            this.startGoogleSpeechStream();
        }
    }

    sendAudioChunk(chunk) {
        if (this.ws) {
            this.ws.send(
                JSON.stringify({
                    event: "media",
                    streamSid: this.streamSid,
                    media: {
                        payload: chunk
                    },
                })
            );
        }
    }

    sendClear() {
        if (this.ws) {
            this.ws.send(
                JSON.stringify({
                    event: "clear",
                    streamSid: this.streamSid,
                })
            );
        }
    }

    async generateAudio(text) {
        // Your ElevenLabs function is already streaming-ready, which is perfect.
        // Just make sure you are using an async generator or returning the stream.

        // black woman 03vEurziQfq3V8WZhQvn

        const id = "7EzWGsX10sAS4c9m9cPf"


        const url = `https://api.elevenlabs.io/v1/text-to-speech/${id}?optimize_streaming_latency=4&output_format=ulaw_8000`;
        console.log(`[${this.callSid}] Generating audio for: "${text}"`);
        console.log(`[${this.callSid}] THIS IS THE URL: "${text}"`);
        const body = {
            model_id: "eleven_turbo_v2",
            text: text,
            voice_settings: {
                stability: 0.5,
                similarity_boost: 0.75,
                style: 0,
                use_speaker_boost: false,
            },
        };

        try {
            const response = await fetch(url, {
                method: "POST",
                headers: {
                    "xi-api-key": process.env.ELEVENLABS_KEY,
                    "Content-Type": "application/json",
                    "accept": "audio/ulaw",
                },
                body: JSON.stringify(body),
            });

            if (!response.ok) {
                throw new Error(`ElevenLabs API error: ${response.statusText}`);
            }

            // Return the body stream directly
            return response.body;
        } catch (error) {
            console.error(`[${this.callSid}] ElevenLabs error:`, error);
            return Readable.from([]); // Return an empty stream on error
        }
    }

    async hangup() {
        console.log(`[${this.callSid}] Hanging up call.`);
        if (this.hangupTimer) {
            clearTimeout(this.hangupTimer);
            this.hangupTimer = null;
        }

        this.stopGoogleSpeechStream();

        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }

        try {
            const call = await client.calls(this.callSid).fetch();
            if (call.status !== 'completed') {
                await client.calls(this.callSid).update({ status: "completed" });
            }
        } catch (error) {
            console.error(`[${this.callSid}] Error updating call status:`, error);
        }

        // --- Post-call summary logic ---
        if (this.uuid !== "demo" && this.rating > 75) {
            this.isLead = true;
            this.generateCallSummary();
        } else {
            console.log(`[${this.callSid}] Call ended. Not a lead (Rating: ${this.rating}).`);
        }
    }

    async generateCallSummary() {
        console.log(`[${this.callSid}] Generating call summary...`);
        let readableTranscript = this.transcript
            .map(msg => `${msg.sender}: ${msg.message}`)
            .join("\n\n");

        const prompt = `I'm providing a transcript of a conversation between a real estate agent and a client.
            
            Give a 150 character summary of the key points in the conversation that would be useful to a real estate agent.
            
            Here is the transcript: ${readableTranscript}
            `;

        try {
            // Use a *different* model for summarization, as the chat model's history is specific
            const summaryModel = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
            const result = await summaryModel.generateContent(prompt);
            const aiSummary = result.response.text();

            this.convoSummary = aiSummary;
            console.log(`[${this.callSid}] AI summary: ${aiSummary}`);

            const response = {
                uuid: this.uuid,
                phoneNumber: this.phoneNumber,
                agentAction: this.agentAction,
                location: this.agentLocation,
                message: this.convoSummary,
            };
            // TODO: Send this response somewhere (e.g., your database or API)
            console.log(`[${this.callSid}] Lead details:`, response);

        } catch (error) {
            console.error(`[${this.callSid}] Error generating summary:`, error);
        }
    }
}

module.exports = Call;