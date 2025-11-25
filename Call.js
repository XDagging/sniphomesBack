require("dotenv").config();
const speech = require("@google-cloud/speech");
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require("@google/generative-ai");
const { Readable } = require("stream");
const WebSocket = require("ws");

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

        this.sendingAudio = false;
        this.twilioPlaying = false;
        this.playbackTimeout = null;
        this.interrupted = false;
        this.elevenLabsWs = null; // Track current ElevenLabs WebSocket

        this.aiDuration = 0;

        this.model = genAI.getGenerativeModel({
            model: "gemini-2.5-flash",
            generationConfig: {
                temperature: 0.2,
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
                            rating: 5,
                            hangUp: false
                        })
                    }]
                }
            ],
        });

        console.log(`[${this.callSid}] New call initialized.`);
        this.hangupTimer = setTimeout(() => this.hangup(), 180 * 1000);
    }

    buildSystemPrompt(personName, personOperating, personLook) {
        const personNumber = "3011233212";
        const formattedNumber = "three, zero, one, one, two, three, three, two, one, two";

        const buyBool = "Ask the person what budget their budget is and how many people they plan to move in with. Redirect them to the manager if they give one, but push for both answers. DO NOT ASK ANY OTHER QUESTIONS.";
        const sellBool = `Tell the person about ${personOperating} area and ask them if they are homeowners. If so, ask them for the following info: would they be willing to sell their house, and if so, for how much? How many people do you live with currently (if they ask why we are asking, it is to grasp how large the home)? If they answer at least 1 of those questions, redirect to mananger. DO NOT ASK ANY OTHER QUESTIONS.`;
        const promptBool = personLook.toLowerCase() === "sell" ? sellBool : buyBool;

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
        if (!this.noStart) {
            this.streamSid = streamSid;

            console.log(`[${this.callSid}] Twilio stream started (${this.streamSid}).`);
            this.startGoogleSpeechStream();
            this.startConversation();
            this.noStart = true;
        }

        this.ws.on("message", (message) => {
            const msg = JSON.parse(message);
            switch (msg.event) {
                case "connected":
                    console.log(`[${this.callSid}] Twilio stream connected.`);
                    break;
                case "media":
                    if (this.googleSpeechStream && this.googleSpeechStream.writable) {
                        this.googleSpeechStream.write(msg.media.payload);

                        this.userSpeaking = true;
                        if (this.speechTimeout) {
                            clearTimeout(this.speechTimeout);
                        }
                        this.speechTimeout = setTimeout(() => {
                            if (this.userSpeaking) {
                                console.log(`[${this.callSid}] Silence detected, ending user turn.`);
                                this.userSpeaking = false;
                                if (!this.sendingAudio) {
                                    this.stopGoogleSpeechStream();
                                }
                            }
                        }, 600);
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
                    interimResults: true,
                },
            })
            .on("error", (error) => {
                console.error(`[${this.callSid}] STT Error:`, error);
            })
            .on("data", (data) => {
                const result = data.results[0];
                if (result && result.alternatives[0]) {
                    const transcript = result.alternatives[0].transcript.trim();

                    if ((this.sendingAudio || this.twilioPlaying) && transcript.length > 0) {
                        console.log(`[${this.callSid}] User interrupting AI (STT): "${transcript}"`);
                        this.interrupted = true;
                        this.sendingAudio = false;
                        this.twilioPlaying = false;

                        if (this.playbackTimeout) {
                            clearTimeout(this.playbackTimeout);
                            this.playbackTimeout = null;
                        }

                        // Close the ElevenLabs WebSocket to stop audio generation
                        if (this.elevenLabsWs) {
                            this.elevenLabsWs.close();
                            this.elevenLabsWs = null;
                        }

                        this.sendClear();
                    }

                    if (result.isFinal) {
                        const transcript = result.alternatives[0].transcript.trim();
                        console.log(`[${this.callSid}] [${Date.now()}] STT Final: "${transcript}"`);

                        if (this.speechTimeout) {
                            clearTimeout(this.speechTimeout);
                            this.speechTimeout = null;
                        }
                        this.userSpeaking = false;

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
        this.aiTalking = true;
        const initialHistory = await this.chat.getHistory();
        const initialResponseJSON = initialHistory[1].parts[0].text;

        try {
            const parsed = JSON.parse(initialResponseJSON);

            this.elevenLabsWs = await this.setupElevenLabsWs();

            this.elevenLabsWs.send(JSON.stringify({
                text: parsed.response,
                try_trigger_generation: true,
            }));
            this.elevenLabsWs.send(JSON.stringify({ text: "" }));

            this.processResponse(initialResponseJSON);
        } catch (e) {
            console.error(`[${this.callSid}] Error processing initial greeting:`, e);
        }
    }

    async processLLM(transcript) {
        if (!transcript) {
            console.log(`[${this.callSid}] Empty transcript, restarting STT.`);
            this.aiTalking = false;
            this.startGoogleSpeechStream();
            return;
        }

        this.aiTalking = true;
        this.stopGoogleSpeechStream();

        this.transcript.push({
            sender: "Person on the phone",
            message: transcript,
            order: this.messageNumber++,
        });

        console.log(`[${this.callSid}] [${Date.now()}] Sending to Gemini: "${transcript}"`);

        this.elevenLabsWs = await this.setupElevenLabsWs();

        try {
            const result = await this.chat.sendMessageStream(transcript);
            const stream = result.stream;

            let jsonBuffer = "";
            let inJsonBlock = false;
            let firstToken = true;
            let lastSpeechText = "";

            for await (const chunk of stream) {
                if (firstToken) {
                    console.log(`[${this.callSid}] [${Date.now()}] Gemini First Token Received`);
                    firstToken = false;
                }

                const chunkText = chunk.text();

                if (!inJsonBlock && chunkText.includes('{')) {
                    inJsonBlock = true;
                }
                if (inJsonBlock) {
                    jsonBuffer += chunkText;

                    if (this.elevenLabsWs && this.elevenLabsWs.readyState === WebSocket.OPEN) {
                        const startMarker = '"response"';
                        const startIdx = jsonBuffer.indexOf(startMarker);
                        if (startIdx !== -1) {
                            const contentStart = jsonBuffer.indexOf('"', startIdx + startMarker.length);
                            if (contentStart !== -1) {
                                let contentEnd = -1;
                                for (let i = contentStart + 1; i < jsonBuffer.length; i++) {
                                    if (jsonBuffer[i] === '"' && jsonBuffer[i - 1] !== '\\') {
                                        contentEnd = i;
                                        break;
                                    }
                                }

                                let currentSpeechText;
                                if (contentEnd !== -1) {
                                    currentSpeechText = jsonBuffer.substring(contentStart + 1, contentEnd);
                                } else {
                                    currentSpeechText = jsonBuffer.substring(contentStart + 1);
                                }

                                try {
                                    currentSpeechText = currentSpeechText.replace(/\\"/g, '"').replace(/\\n/g, '\n');
                                } catch (e) { }

                                if (currentSpeechText.length > lastSpeechText.length) {
                                    const newText = currentSpeechText.substring(lastSpeechText.length);
                                    if (newText.length > 0) {
                                        this.elevenLabsWs.send(JSON.stringify({
                                            text: newText,
                                            try_trigger_generation: true,
                                        }));
                                        lastSpeechText = currentSpeechText;
                                    }
                                }
                            }
                        }
                    }

                    if (chunkText.includes('}')) {
                        inJsonBlock = false;
                        console.log(`[${this.callSid}] Gemini Raw JSON: ${jsonBuffer}`);

                        if (this.elevenLabsWs && this.elevenLabsWs.readyState === WebSocket.OPEN) {
                            this.elevenLabsWs.send(JSON.stringify({ text: "" }));
                        }

                        this.processResponse(jsonBuffer);
                        jsonBuffer = "";
                    }
                }
            }
        } catch (error) {
            console.error(`[${this.callSid}] Error streaming from Gemini:`, error);
            if (this.elevenLabsWs) {
                this.elevenLabsWs.close();
                this.elevenLabsWs = null;
            }
            this.aiTalking = false;
            this.startGoogleSpeechStream();
        }
    }

    calculatePlayback(audioDataLength, sampleRate) {
        return audioDataLength / sampleRate;
    }

    async processResponse(geminiResponse) {
        try {
            let fedToTwilio;
            try {
                const cleanJson = geminiResponse.replace(/```json\s*/g, "").replace(/```/g, "").trim();
                fedToTwilio = JSON.parse(cleanJson);
            } catch (e) {
                console.error(`[${this.callSid}] Failed to parse Gemini JSON:`, e);
                console.error(`[${this.callSid}] Raw response: ${geminiResponse}`);
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

            this.transcript.push({
                sender: "You",
                message: fedToTwilio.response,
                order: this.messageNumber++,
            });
            this.rating = fedToTwilio.rating;

            console.log(`[${this.callSid}] Metadata: rating=${fedToTwilio.rating}, hangUp=${fedToTwilio.hangUp}`);

            if (fedToTwilio.hangUp && !this.interrupted && !this.aiTalking) {
                setTimeout(() => {
                    if (!this.interrupted) {
                        console.log(`[${this.callSid}] Hanging up after AI response.`);
                        this.hangup();
                    }
                }, 2000);
            }

        } catch (e) {
            console.error(`[${this.callSid}] Error in processResponse:`, e);
            this.aiTalking = false;
            this.startGoogleSpeechStream();
        }
    }

    setupElevenLabsWs() {
        return new Promise((resolve, reject) => {
            const voiceId = "7EzWGsX10sAS4c9m9cPf";
            const model = "eleven_turbo_v2";
            const wsUrl = `wss://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream-input?model_id=${model}&output_format=ulaw_8000`;

            const ws = new WebSocket(wsUrl);

            ws.on("open", () => {
                console.log(`[${this.callSid}] [${Date.now()}] ElevenLabs WS Connected`);
                ws.send(JSON.stringify({
                    text: " ",
                    voice_settings: {
                        stability: 0.5,
                        similarity_boost: 0.75,
                    },
                    xi_api_key: process.env.ELEVENLABS_KEY,
                }));

                this.aiTalking = true;
                this.interrupted = false;
                this.sendingAudio = true;
                this.twilioPlaying = true;
                this.startGoogleSpeechStream();

                resolve(ws);
            });

            ws.on("message", (data) => {
                const message = JSON.parse(data);

                if (message.audio) {
                    console.log(`[${this.callSid}] Received audio chunk from ElevenLabs`);
                    if (this.interrupted) {
                        console.log(`[${this.callSid}] Interrupted, skipping WS audio chunk.`);
                        return;
                    }

                    const buffer = message.audio;
                    this.sendAudioChunk(buffer);

                    const audioBuffer = Buffer.from(buffer, 'base64');
                    const durationInSec = this.calculatePlayback(audioBuffer.length, 8000);
                    const durationInMs = durationInSec * 1000;

                    if (this.playbackTimeout) {
                        clearTimeout(this.playbackTimeout);
                    }
                    this.twilioPlaying = true;
                    this.playbackTimeout = setTimeout(() => {
                        this.twilioPlaying = false;
                        console.log(`[${this.callSid}] WS Playback finished (est).`);
                    }, durationInMs + 500);
                }

                if (message.isFinal) {
                    console.log(`[${this.callSid}] ElevenLabs WS stream finished.`);
                }
            });

            ws.on("error", (error) => {
                console.error(`[${this.callSid}] ElevenLabs WS Error:`, error);
                reject(error);
            });

            ws.on("close", () => {
                console.log(`[${this.callSid}] ElevenLabs WS Closed.`);
                this.sendingAudio = false;
            });
        });
    }

    sendAudioChunk(chunk) {
        if (this.interrupted) {
            console.log(`[${this.callSid}] Interrupted, skipping audio chunk.`);
            return;
        }
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
            console.log(`[${this.callSid}] Sending clear event to Twilio.`);
            this.ws.send(
                JSON.stringify({
                    event: "clear",
                    streamSid: this.streamSid,
                })
            );
        }
    }

    async hangup() {
        console.log(`[${this.callSid}] Hanging up call.`);
        if (this.hangupTimer) {
            clearTimeout(this.hangupTimer);
            this.hangupTimer = null;
        }

        if (this.playbackTimeout) {
            clearTimeout(this.playbackTimeout);
            this.playbackTimeout = null;
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
            console.log(`[${this.callSid}] Lead details:`, response);

        } catch (error) {
            console.error(`[${this.callSid}] Error generating summary:`, error);
        }
    }
}

module.exports = Call;