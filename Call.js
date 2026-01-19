require("dotenv").config();
const speech = require("@google-cloud/speech");
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require("@google/generative-ai");
const { TextToSpeechClient } = require("@google-cloud/text-to-speech");
const { getAvailability, scheduleAppointment } = require("./calendly");
const { Readable } = require("stream");
const fs = require("fs");
const waveResampler = require('wave-resampler');


const { fromZonedTime } = require('date-fns-tz');
const { mulaw } = require('alawmulaw');
const { get } = require("http");
// const { RegulatoryComplianceListInstance } = require("twilio/lib/rest/numbers/v2/regulatoryCompliance");

// --- Google TTS Setup ---
let ttsClient = new TextToSpeechClient(process.env.GOOGLE_SPEECH_TO_TEXT_KEY);

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
        this.justCheckedAvailability = false;
        this.availableSlots = [];
        this.errorWhenScheduling = false;
        this.hasConfirmedDetails = false;

        this.currentlyCheckingAvailability = false;

        // Loop Prevention & State Tracking
        this.lastConversationState = null;
        this.shouldConfirmDetails = false;
        this.stateRepetitionCount = 0;

        this.businessName = "Quattro BodyShop";
        this.businessLocation = "Bethesda, Maryland";
        this.alreadySending = false;
        this.timeIntervalForSocket = null;
        this.noStart = false;
        this.streamSid = "";
        this.ws = null;
        this.googleSpeechClient = new speech.SpeechClient();
        this.googleSpeechStream = null;
        // this.transcript = [];
        this.messageNumber = 0;
        this.aiTalking = false;
        this.userSpeaking = false;
        this.speechTimeout = null;
        this.sendingAudio = false;
        this.twilioPlaying = false;
        this.playbackTimeout = null;
        this.interrupted = false;
        this.ttsStream = null;
        this.backgroundInterval = null;
        this.estimatedPlaybackEnd = 0;
        this.shouldHangup = false;
        this.aiDuration = 0;
        this.transferNumber = "301-272-7224";
        this.isTransferring = false;
        this.initializationPromise = null;
        // state variables

        this.hasScheduledAppointment = false;



        // State variables for appointment details
        this.customerName = null;
        this.vehicleModel = null;
        this.customerEmail = null;
        this.paymentMethod = null;
        this.appointmentTime = null;

        // Initialize model here, but don't start chat yet

        // gemini-3-pro-preview
        // gemini-2.5-flash-lite
        this.model = genAI.getGenerativeModel({
            model: "gemini-3-flash-preview",
            generationConfig: {
                temperature: 0.1, // Lower temperature for better extraction
                responseMimeType: "application/json",
                responseSchema: {
                    type: "OBJECT",
                    properties: {
                        thought: { type: "STRING", description: "Internal reasoning. ONE sentence. Decide what to do next based on missing fields or user intent. Do NOT say 'user said...' just reason." },
                        conversation_state: {
                            type: "STRING",
                            enum: ["answering_general_question", "gathering_data", "confirming_details"],
                            description: "Current state of the conversation."
                        },
                        extracted_data: {
                            type: "OBJECT",
                            description: "ONLY include fields if you are 100% CERTAIN. Omit if unknown.",
                            properties: {
                                customerName: { type: "STRING", description: "The customer's name." },
                                vehicleModel: { type: "STRING", description: "The vehicle year/make/model." },
                                customerEmail: {
                                    type: "STRING",
                                    description: "The customer's email. RECONSTRUCT spoken emails: 'john dot doe at gmail' -> 'john.doe@gmail.com'."
                                },
                                paymentMethod: {
                                    type: "STRING",
                                    enum: ["insurance", "out-of-pocket"],
                                    description: "Payment method. STRICT MAPPING: If 'cash', 'credit', 'debit', 'myself', 'private' -> use 'out-of-pocket'. If 'State Farm', 'Geico', 'claim', 'deductible', or anything that sounds like insurance -> use 'insurance'. If the user is confused, give them the option of insurance or paying out of pocket"
                                },
                                appointmentTime: { type: "STRING" }
                            },
                        },
                        response: { type: "STRING", description: "Text to speak to the user. Do NOT include actions here." },
                        rating: { type: "NUMBER" },
                        hangup: { type: "BOOLEAN" },
                        action: { type: "STRING", enum: ["respond", "hangup", "transfer", "check_availability", "check_if_time_is_valid", "schedule_appointment"] },
                    },
                    required: ["thought", "conversation_state", "response", "rating", "hangup"],
                },
            },
            safetySettings,
        });
    }

    // 2. Move async logic to a method
    init() {
        this.initializationPromise = (async () => {
            const systemPrompt = await this.buildSystemPrompt(this.agentName, this.agentLocation, this.agentAction);
            console.log("we are returning the system prompt", systemPrompt);

            this.chat = this.model.startChat({
                history: [
                    { role: "user", parts: [{ text: systemPrompt }] },
                    {
                        role: "model",
                        parts: [{
                            text: JSON.stringify({
                                thought: "Initial greeting.",
                                conversation_state: "gathering_data",
                                response: `Hi this is ${this.businessName} how may we help you today?`,
                                rating: 5,
                                hangup: false,
                                action: "respond"
                            })
                        }]
                    }
                ],
            });
        })();
    }

    // 3. Static Factory Method
    static async create(callSid, phoneNumber, agentAction, agentLocation, agentName, uuid) {
        const instance = new Call(callSid, phoneNumber, agentAction, agentLocation, agentName, uuid);
        instance.init(); // Start async work without awaiting
        return instance;       // Return the instance immediately
    }

    async buildSystemPrompt(personName, personOperating, personLook) {

        const fullPrompt = `
IDENTITY: You are the AI Receptionist for "Quattro Body Shop" in Bethesda, MD.
GOAL: Book estimates naturally. Sound 100% human.

[BUSINESS RULES]
- LOCATION: 4907 Elm St, Bethesda, MD 20814.
- Nearby Landmarks: Across from a Matchbox Restaurant, a public parking lot is in front of it, and under an Equinox Gym.
- HOURS: 8am-4pm, M-F.
- SERVICES: Collision, paint, dents (PDR), frame work.
- PRICING: No phone quotes. "Come in for a free estimate."
- APPOINTMENTS: 30-min slots. Hour or half-hour only. 

[STATE MACHINE LOGIC]
1. STATE: "answering_general_question"
   - TRIGGER: User asks about price, services, location, hours, or "are you a robot?".
   - BEHAVIOR: Answer the question DIRECTLY. Do NOT ask for booking details (Name, Car, Email) in this turn.
   - EXIT: Once answered, wait for user to signal they want to proceed.

2. STATE: "gathering_data"
   - TRIGGER: User wants to book or gives details.
   - BEHAVIOR: Ask for MISSING_FIELDS one by one.
   - ORDER: Time -> Name -> Vehicle -> Email -> Payment.

3. STATE: "confirming_details"
   - TRIGGER: All fields are known (internally tracked).
   - BEHAVIOR: Read back the details and ask to confirm.

4. State: "schedule_appointment"
   - TRIGGER: All the data has been already filled out (nothing more is needed), and, the user has confirmed that the data is correct.
   - BEHAVIOR: Warm regards and ask if they need help with anything else.

[HARDENED EXTRACTION RULES]
- **extracted_data**: ONLY include keys if the user explicitly provided them this turn or significantly clarified them.
- **NO GUESSING**: If user says "My name is John", extract "customerName": "John".
- **MISSING DATA**: If you don't know the email, OMIT the "customerEmail" key. Do NOT use "NOT_SET", "null", or placeholder strings.
- **Strictness**: It is better to have a missing key than a wrong one.

[RESPONSE & ACTION SEPARATION]
- **thought**: Analyze the gap. "I have time, but need name." or "User asked for price, I must answer."
- **response**: The text to speak. Keep it friendly and concise.
- **action**:
  - "check_availability": User asks for times.
  - "check_if_time_is_valid": User picked a specific time.
  - "transfer": User is frustrated, asks for human, or loop detected.
  - "hangup": User says goodbye or conversation ends.
  - "respond": Normal conversation.

[CRITICAL INSTRUCTIONS]
1. NO HALLUCINATIONS: Do NOT make up appointment times.
2. NO REPETITION: Do NOT repeat "Is there anything else?". Move forward.
3. INTERRUPTIONS: If user interrupts, STOP talking.

[TRANSFERS]
- TRIGGER: User asks for "manager", "human", "advisor".
- ACTION: Set "action": "transfer". Say: "Let me get you to a service advisor. One moment."

[STYLE]
- Concise. Friendly. Professional.
- NO "I hope you are doing well".
- NO "I am an AI". (Unless asked directly).
- If asked "Are you real?": "Haha, I'm the new AI assistant, but I can get you scheduled just fine."
`;

        return fullPrompt
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
                        const timeBeforePersonHasStopped = 500;

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
                        }, timeBeforePersonHasStopped);
                    }
                    break;
                case "stop":
                    console.log(`[${this.callSid}] Twilio stream stopped.`);
                    this.hangup();
                    break;
            }
        });
    }

    stopBackgroundAudio() {

        if (this.backgroundInterval) {
            clearInterval(this.backgroundInterval);
            this.backgroundInterval = null;

        }
        this.sendingAudio = false;
        this.alreadySending = false;
        // Optional: Send a clear here if you want to ensure the buffer is empty
        // this.sendClear(); 
    }

    startGoogleSpeechStream() {
        if (this.googleSpeechStream) {
            this.googleSpeechStream.destroy();
            this.googleSpeechStream = null;
        }

        console.log(`[${this.callSid}] Starting new Google STT stream.`);
        // if (!this.interrupted && !this.sendingAudio && !this.alreadySending && !this.shouldHangup) {
        //     this.sendBackgroundAudio();
        // } else {
        //     console.log("We are not sending background audio because", !this.interrupted, !this.sendingAudio, !this.alreadySending);
        // }
        this.googleSpeechStream = this.googleSpeechClient
            .streamingRecognize({
                config: {
                    encoding: "MULAW",
                    sampleRateHertz: 8000,
                    languageCode: "en-US",
                },
                interimResults: true,
            })
            .on("error", (error) => {
                console.error(`[${this.callSid}] STT Error:`, error);
            })
            .on("data", (data) => {
                const result = data.results[0];
                console.log("this is the data", result);


                if (result && result.isFinal && result.alternatives[0]) {
                    const transcript = result.alternatives[0].transcript.trim();


                    if ((this.sendingAudio || this.twilioPlaying) && transcript.length > 0) {

                        if (this.shouldHangup) {
                            console.log(`[${this.callSid}] Hangup pending. Ignoring interruption: "${transcript}"`);
                            return;
                        }
                        console.log(`[${this.callSid}] User interrupting AI (STT): "${transcript}"`);
                        this.interrupted = true;
                        this.sendingAudio = false;
                        this.twilioPlaying = false;

                        // we are doing this because this means that we should stfu and start responding.
                        this.stopBackgroundAudio();

                        if (this.playbackTimeout) {
                            clearTimeout(this.playbackTimeout);
                            this.playbackTimeout = null;
                        }

                        if (this.ttsStream) {
                            this.ttsStream.destroy();
                            this.ttsStream = null;
                        }

                        this.estimatedPlaybackEnd = 0;
                        this.shouldHangup = false;

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
                        this.messageNumber += 1;
                        this.processLLM(transcript);
                    }
                } else if (result && !result.isFinal && result.alternatives[0].transcript.length > 2) {

                    // we should probably stop talking and start listening:
                    if ((this.sendingAudio || this.twilioPlaying)) {
                        console.log("we are interrupting because of interim results")
                        // console.log(`[${this.callSid}] User interrupting AI (STT): "${transcript}"`);
                        this.interrupted = true;
                        this.sendingAudio = false;
                        this.twilioPlaying = false;
                        // this.stopBackgroundAudio();

                        if (this.playbackTimeout) {
                            clearTimeout(this.playbackTimeout);
                            this.playbackTimeout = null;
                        }

                        if (this.ttsStream) {
                            this.ttsStream.destroy();
                            this.ttsStream = null;
                        }

                        this.estimatedPlaybackEnd = 0;
                        this.shouldHangup = false;

                        this.sendClear();
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
        // const initialHistory = await this.chat.getHistory();
        const initialResponseJSON = {
            thought: "Initial greeting.",
            conversation_state: "gathering_data",
            response: `Hi this is ${this.businessName} how may we help you today?`,
            rating: 5,
            hangup: false,
            action: "respond"
        }

        try {
            const parsed = initialResponseJSON;

            this.ttsStream = this.setupGoogleTTSStream();
            this.timeIntervalForSocket = setInterval(() => {

                if (this.ttsStream && !this.ttsStream.closed && !this.ttsStream.destroyed) {
                    // console.log("we are writing to keep alive.");
                    this.ttsStream.write({
                        input: { text: "" }
                    });
                } else {
                    console.log("We cleared the interval");
                    clearInterval(this.timeIntervalForSocket);
                    this.timeIntervalForSocket = null;
                }
            }, 1000);
            // sent an interval that sends a message once  second to the ttsStream

            if (this.ttsStream) {
                this.ttsStream.write({
                    input: { text: parsed.response }
                });
                this.ttsStream.end();
            }

            this.processResponse(JSON.stringify(initialResponseJSON));
        } catch (e) {
            console.error(`[${this.callSid}] Error processing initial greeting:`, e);
        }
    }


    async sendBackgroundAudio() {
        console.log("WE ARE SENDING BACKGROUND AUDIO")
        // Prevent multiple intervals running
        this.alreadySending = true;
        if (this.backgroundInterval) {
            clearInterval(this.backgroundInterval);
        }

        // Logic check: Don't start if interrupted or AI is talking
        // if (this.) {
        //     return;
        // }

        try {
            this.backgroundAudio = fs.readFileSync("ulawOfficeAmbience.wav");
        } catch (e) {
            console.error("Could not load background audio file.");
            return;
        }

        const sampleRate = 8000;
        const packetDuration = 20;
        const chunkSize = Math.ceil(sampleRate * (packetDuration / 1000));
        let offset = 44;

        this.sendingAudio = true;
        this.sendingBackgroundAudio = true;

        // Store interval ID in the class instance
        this.backgroundInterval = setInterval(() => {
            // Safety check inside the loop
            if (this.twilioPlaying) {
                console.log("for some reason, this was clicked.")
                this.stopBackgroundAudio();

                // this.sendClear();

                console.log(`[${this.callSid}] Background audio stopped (flag check).`);
                return;
            }

            if (offset >= this.backgroundAudio.length) {
                // Loop the audio
                offset = 44;
            }

            const end = Math.min(offset + chunkSize, this.backgroundAudio.length);
            const chunk = this.backgroundAudio.slice(offset, end);
            const audioChunk = chunk.toString("base64");

            this.sendAudioChunk(audioChunk);
            offset += chunkSize;

        }, packetDuration);
    }

    logAllMeaningfulStats() {
        console.log("This is the customerName", this.customerName);
        console.log("This is the customerEmail", this.customerEmail);
        console.log("this is the payment method", this.paymentMethod);
        console.log("This is the scheduleTime", this.appointmentTime);
        console.log("This is another thing", this.vehicleModel);


    }

    async processLLM(transcript) {
        if (!transcript) {
            console.log(`[${this.callSid}] Empty transcript, restarting STT.`);
            this.aiTalking = false;
            this.startGoogleSpeechStream();
            return;
        } else if (this.currentlyCheckingAvailability) {
            console.log(`[${this.callSid}] Currently checking availability, skipping STT.`);
            return;
        }
        // for system responses
        if (transcript.toLowerCase().includes("system update")) {
            console.log(`[${this.callSid}] System update detected, sending clear`);
            this.sendClear();
        }

        this.aiTalking = true;
        this.stopGoogleSpeechStream();

        // Ensure the model is initialized before proceeding
        try {
            await this.initializationPromise;
        } catch (e) {
            console.error(`[${this.callSid}] Initialization failed:`, e);
            // Fallback logic could go here, but for now we log error
        }

        // this.transcript.push({
        //     sender: "Person on the phone",
        //     message: transcript,
        //     order: this.messageNumber++,
        // });

        console.log(`[${this.callSid}] [${Date.now()}] Sending to Gemini: "${transcript}"`);

        this.ttsStream = this.setupGoogleTTSStream();

        try {
            // --- SYSTEM CONTEXT INJECTION ---
            const missingFields = [];
            if (!this.customerName) missingFields.push("customerName");
            if (!this.vehicleModel) missingFields.push("vehicleModel");
            if (!this.customerEmail) missingFields.push("customerEmail");
            if (!this.paymentMethod) missingFields.push("paymentMethod");
            if (!this.appointmentTime) missingFields.push("appointmentTime");

            const systemContext = `
[INTERNAL STATE]
MISSING_FIELDS: ${missingFields.length > 0 ? missingFields.join(", ") : "NONE - Ready to Schedule"}
CURRENT_APPOINTMENT_TIME: ${this.appointmentTime || "UNKNOWN"}
KNOWN_DATA: Name=${this.customerName || "?"}, Car=${this.vehicleModel || "?"}, Email=${this.customerEmail || "?"}, Pay=${this.paymentMethod || "?"}

[DECISION LOGIC]
1. Review MISSING_FIELDS.
2. In 'thought', explicitly state what you need to ask for next.
3. In 'response', ask for that item naturally.
4. If action is "check_availability", 'response' should be "Let me check the schedule...".
`;

            const augmentedTranscript = `${systemContext} \n\nUser says: "${transcript}"`;
            console.log(`[${this.callSid}] Augmented Transcript with System Context: \n${augmentedTranscript} `);


            const result = await this.chat.sendMessageStream(augmentedTranscript);
            // console.log("This is the result of gemini", result);
            const stream = result.stream;

            let jsonBuffer = "";
            let inJsonBlock = false;
            let firstToken = true;
            let lastSpeechText = "";
            let shouldUseCannedResponse = false;
            let cannedMessage = "";

            for await (const chunk of stream) {
                if (firstToken) {
                    console.log(`[${this.callSid}][${Date.now()}] Gemini First Token Received`);
                    firstToken = false;
                }

                const chunkText = chunk.text();

                if (!inJsonBlock && chunkText.includes('{')) {
                    inJsonBlock = true;
                }
                if (inJsonBlock) {
                    jsonBuffer += chunkText;

                    // Check if we have enough of the JSON to determine the action or extracted data
                    if (!shouldUseCannedResponse && (jsonBuffer.includes('"action"') || jsonBuffer.includes('"extracted_data"') || jsonBuffer.includes('"conversation_state"'))) {
                        try {
                            // Try to parse what we have so far (might be incomplete)
                            let partialJsonStr = jsonBuffer;
                            // Attempt to close the JSON if it's incomplete
                            if (!partialJsonStr.trim().endsWith('}')) {
                                partialJsonStr += '}';
                            }

                            // A more robust incomplete parser might be needed, but for now specific field extraction 
                            // via Regex might be safer for stream chunks if JSON.parse fails frequently on partials.
                            // But let's try JSON.parse first.
                            const parsed = JSON.parse(partialJsonStr);

                            // --- REAL-TIME EXTRACTION ---
                            if (parsed.extracted_data) {
                                if (parsed.extracted_data.appointmentTime) {
                                    // Validate immediately
                                    const { isValid, formattedTime } = this.validateTimeSlot(parsed.extracted_data.appointmentTime, true);
                                    if (isValid) {
                                        this.appointmentTime = formattedTime;
                                        console.log(`[${this.callSid}] 🟢 Real-time Time Extraction: ${formattedTime}`);
                                    }
                                }
                                if (parsed.extracted_data.customerName) this.customerName = parsed.extracted_data.customerName;
                                // ... (other fields can be updated here if critical, but time is the big one)
                            }

                            // --- HALLUCINATION GUARD ---
                            // If state is 'confirming_details' but we don't have the time, blocking the AI
                            if (parsed.conversation_state === "confirming_details") {
                                if (!this.appointmentTime) {
                                    console.log(`[${this.callSid}] 🛑 HALLUCINATION GUARD: AI trying to confirm without appointmentTime!`);
                                    shouldUseCannedResponse = true;
                                    cannedMessage = "I apologize, I missed the time you wanted. Could you please repeat the day and time?";
                                    this.ttsStream.destroy();
                                    this.ttsStream = null;
                                    this.sendClear();
                                    this.updateAgentWithoutTriggeringResponse(cannedMessage);
                                } else if (!this.customerName) {
                                    console.log(`[${this.callSid}] 🛑 HALLUCINATION GUARD: AI trying to confirm without customerName!`);
                                    shouldUseCannedResponse = true;
                                    cannedMessage = "I apologize, I missed the name you wanted. Could you please repeat the name?";
                                    this.ttsStream.destroy();
                                    this.ttsStream = null;
                                    this.sendClear();
                                    this.updateAgentWithoutTriggeringResponse(cannedMessage);
                                } else if (!this.vehicleModel) {
                                    console.log(`[${this.callSid}] 🛑 HALLUCINATION GUARD: AI trying to confirm without vehicleModel!`);
                                    shouldUseCannedResponse = true;
                                    cannedMessage = "I apologize, I missed the vehicle model you wanted. Could you please repeat the vehicle model?";
                                    this.ttsStream.destroy();
                                    this.ttsStream = null;
                                    this.sendClear();
                                    this.updateAgentWithoutTriggeringResponse(cannedMessage);
                                } else if (!this.customerEmail) {
                                    console.log(`[${this.callSid}] 🛑 HALLUCINATION GUARD: AI trying to confirm without customerEmail!`);
                                    shouldUseCannedResponse = true;
                                    cannedMessage = "I apologize, I missed the email you wanted. Could you please repeat the email?";
                                    this.ttsStream.destroy();
                                    this.ttsStream = null;
                                    this.sendClear();
                                    this.updateAgentWithoutTriggeringResponse(cannedMessage);
                                } else if (!this.paymentMethod) {
                                    console.log(`[${this.callSid}] 🛑 HALLUCINATION GUARD: AI trying to confirm without paymentMethod!`);
                                    shouldUseCannedResponse = true;
                                    cannedMessage = "I apologize, I missed the payment method you wanted. Could you please repeat the payment method?";
                                    this.ttsStream.destroy();
                                    this.ttsStream = null;
                                    this.sendClear();
                                    this.updateAgentWithoutTriggeringResponse(cannedMessage);
                                } else {
                                    this.logAllMeaningfulStats();
                                    this.shouldConfirmDetails = true
                                }

                            }


                            if (this.messageNumber % 2 === 0 && !this.hasConfirmedDetails) {
                                this.shouldConfirmDetails = false;   
                            }


                            // Check if action is check_availability
                            if (parsed.action === "check_availability") {
                                shouldUseCannedResponse = true;
                                cannedMessage = "Give me one second to check the calendar for you.";
                                // this.sendClear();
                                this.ttsStream.destroy();
                                this.ttsStream = null;
                                this.sendClear();
                                console.log(`[${this.callSid}] 🎯 Detected check_availability - using canned response`);
                            } else if (parsed.action === "check_if_time_is_valid") {

                                shouldUseCannedResponse = true;
                                cannedMessage = "Let me see if that time is open for you.";
                                // this.sendClear();
                                this.ttsStream.destroy();
                                this.ttsStream = null;
                                this.sendClear();
                                console.log(`[${this.callSid}] 🎯 Detected check_if_time_is_valid - using canned response`);
                            } else if (( (!this.shouldConfirmDetails && !this.hasConfirmedDetails)  ) && this.customerName && this.vehicleModel && this.customerEmail && this.paymentMethod && this.appointmentTime) {
                                shouldUseCannedResponse = true;
                                cannedMessage = "Just to confirm, you're name is " + this.customerName + ", your vehicle is a " + this.vehicleModel + ", your email is " + this.customerEmail + ", your payment method is " + this.paymentMethod + ", and your appointment time is " + this.appointmentTime + ". Is this correct?";

                                this.ttsStream.destroy();
                                this.ttsStream = null;
                                this.sendClear();
                                console.log(`[${this.callSid}] 🎯 Detected hasConfirmedDetails - using canned response`);
                                this.shouldConfirmDetails = true;
                                console.log("we have now set confirmed details to the following", this.hasConfirmedDetails);
                                // this.hasConfirmedDetails = true;
                            }
                            // Check if all appointment details are filled
                            // else if (this.customerName && this.vehicleModel && this.customerEmail &&
                            //     this.paymentMethod && this.appointmentTime && !this.hasScheduledAppointment
                            //     && !this.errorWhenScheduling && this.hasConfirmedDetails
                            // ) {
                            //     shouldUseCannedResponse = true;
                            //     cannedMessage = "Perfect! Let me get that scheduled for you right away.";
                            //     this.ttsStream.destroy();
                            //     this.ttsStream = null;
                            //     this.sendClear();
                            //     console.log(`[${this.callSid}] 🎯 All appointment details filled - using canned response`);
                            //     this.updateAgentWithoutTriggeringResponse(cannedMessage);
                            // }
                            
                            else if (parsed.action === "schedule_appointment") {

                                if (this.shouldConfirmDetails && this.appointmentTime && this.customerName && this.vehicleModel && this.customerEmail && this.paymentMethod) {
                                    this.hasConfirmedDetails = true;

                                    cannedResponse = "Give me one second to try to schedule the appointment for you.";
                                    shouldUseCannedResponse = true;
                                    this.ttsStream.destroy();
                                    this.ttsStream = null;
                                    this.sendClear();
                                    console.log(`[${this.callSid}] 🎯 All appointment details filled - using canned response`);
                                    this.updateAgentWithoutTriggeringResponse(cannedMessage);
                                } else {
                                    this.logAllMeaningfulStats();
                                }




                                // lets first check if everything is a okay!



                            }


                            // This in theory should prevent the audio from continuously streaming when we should be using canned.

                        } catch (e) {

                            // JSON not complete yet, continue streaming
                        }
                    }

                    // clear everything said previously because we never really know when the action will come in.
                    // this.sendClear();

                    // Only stream to TTS if we're NOT using a canned response
                    if (!shouldUseCannedResponse && this.ttsStream && !this.ttsStream.destroyed) {
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
                                        this.messageNumber += 1;
                                        console.log("We are writing right now to the TTS stream: ", newText);
                                        this.ttsStream.write({
                                            input: { text: newText }
                                        });
                                        lastSpeechText = currentSpeechText;
                                    }
                                }
                            }
                        }
                    }

                    if (chunkText.includes('}')) {
                        inJsonBlock = false;
                        console.log(`[${this.callSid}] Gemini Raw JSON: ${jsonBuffer} `);

                        // If we should use a canned response, override the response field
                        if (shouldUseCannedResponse) {
                            this.ttsStream = this.setupGoogleTTSStream();
                            try {
                                const parsedJson = JSON.parse(jsonBuffer);
                                parsedJson.response = cannedMessage;


                                jsonBuffer = JSON.stringify(parsedJson);
                                console.log(`[${this.callSid}] Overriding response with: "${cannedMessage}"`);

                                // Now speak the canned message
                                if (this.ttsStream && !this.ttsStream.destroyed) {
                                    this.messageNumber += 1;
                                    this.ttsStream.write({
                                        input: { text: cannedMessage }
                                    });
                                }
                            } catch (e) {
                                console.error(`[${this.callSid}] Error overriding response: `, e);
                            }
                        }

                        if (this.ttsStream && !this.ttsStream.destroyed) {
                            this.ttsStream.end();
                        }

                        this.processResponse(jsonBuffer);
                        jsonBuffer = "";
                    }
                }
            }
        } catch (error) {
            console.error(`[${this.callSid}] Error streaming from Gemini: `, error);
            if (this.ttsStream) {
                this.ttsStream.destroy();
                this.ttsStream = null;
            }
            this.aiTalking = false;
            this.startGoogleSpeechStream();
        }
    }

    calculatePlayback(audioDataLength, sampleRate) {
        return audioDataLength / sampleRate;
    }
    convertEstToRealUtc(estDateString) {

        if (estDateString.length > 0) {
            const cleanIso = estDateString.replace('Z', '');

            // 2. Tell the library: "This time is in New York. Give me the UTC equivalent."
            const utcDate = fromZonedTime(cleanIso, 'America/New_York');

            return utcDate.toISOString();

        }
        return "";
        // estDateString input: "2025-12-12T13:00:00.000Z" (The 'Fake UTC' string)

        // 1. Strip the 'Z' so it is treated as "Floating Local Time" (just "1:00 PM")

        // Output: "2025-12-12T18:00:00.000Z" (Correctly added 5 hours)
    }

    // lets add a function to check if it is even possible

    async checkValid(fedToTwilio) {
        try {
            console.log(`[${this.callSid}] --- checkValid ---`);
            console.log(`[${this.callSid}] Input: ${fedToTwilio.appointmentTime}`);

            // 1. Direct Match Check (Priority)
            // The availableSlots are in "Fake UTC" (EST wall time + Z).
            // If the AI gives us exactly that string, it is VALID.
            const isDirectMatch = this.availableSlots.some(slot => {
                return slot === fedToTwilio.appointmentTime ||
                    new Date(slot).getTime() === new Date(fedToTwilio.appointmentTime).getTime();
            });

            if (isDirectMatch) {
                console.log(`[${this.callSid}] ✅ Direct match found (Fake UTC preserved). Valid.`);
                return true;
            }

            // 2. Fallback: Try conversion (Legacy check)
            console.log(`[${this.callSid}] No direct match, trying conversion...`);
            const rawTime = this.convertEstToRealUtc(fedToTwilio.appointmentTime);
            // Convert the rawTime string to a numeric timestamp for comparison
            const targetTimestamp = new Date(rawTime).getTime();

            const isValidSlot = this.availableSlots.some(slot => {
                // Convert the slot string to a timestamp as well
                const slotTimestamp = new Date(slot).getTime();

                // console.log("slot", slot);
                // console.log("rawTime", rawTime);

                // Compare the numbers (milliseconds since epoch)
                // accurate within 1000ms to handle potential second-rounding issues if needed,
                // but exact match usually works best for slots.
                const isMatch = slotTimestamp === targetTimestamp;

                // console.log("passed", isMatch);
                return isMatch;
            });

            if (isValidSlot) {
                console.log(`[${this.callSid}] ✅ Conversion match found.`);
                return true;
            } else {
                console.log(`[${this.callSid}] ❌ No match found (Direct or Converted).`);
                return false
            }
        } catch (e) {
            console.error(`[${this.callSid}] Error in checkValid:`, e);
            return false;
        }


    }

    validateTimeSlot(inputTime, fromAction = false) {
        // 1. Check if we even have slots to compare against
        if (!this.availableSlots || this.availableSlots.length === 0) {
            console.error(`[${this.callSid}] Validation Failed: NO AVAILABLE SLOTS loaded. Did check_availability run?`);
            return { isValid: false, formattedTime: null };
        }

        try {
            // 2. Direct Match Check (Priority)
            const inputDate = new Date(inputTime);
            const inputTimestamp = inputDate.getTime();

            // Check if input matches any slot directly (string or timestamp)
            const directMatch = this.availableSlots.find(slot => {
                return slot === inputTime || new Date(slot).getTime() === inputTimestamp;
            });

            if (directMatch) {
                console.log(`[${this.callSid}] ✅ Direct match found in validateTimeSlot: ${directMatch}`);
                return { isValid: true, formattedTime: directMatch };
            }

            // 3. Fallback: Convert the AI's time (The "Target")
            console.log(`[${this.callSid}] No direct match, validating via conversion...`);
            const formattedTime = !fromAction ? this.convertEstToRealUtc(inputTime) : inputTime;
            const targetDate = new Date(formattedTime);
            const targetTimestamp = targetDate.getTime();

            console.log(`[${this.callSid}] --- VALIDATING TIME ---`);
            console.log(`[${this.callSid}] AI Input: ${inputTime}`);
            console.log(`[${this.callSid}] Converted Target (UTC): ${formattedTime} (${targetTimestamp})`);

            // 4. Find a match with "Fuzzy" Logic
            const match = this.availableSlots.find(slot => {
                const slotDate = new Date(slot);
                const slotTimestamp = slotDate.getTime();

                // Absolute difference in milliseconds
                const diff = Math.abs(slotTimestamp - targetTimestamp);

                // Allow a 60-second buffer (60000ms) to handle seconds/milliseconds mismatches
                // e.g., 14:00:00.000 vs 14:00:00
                const isMatch = diff < 60000;

                // DEBUG: Log close calls to see if we are off by hours (timezone issue)
                // Only log if it's NOT a match but reasonably close (within 6 hours)
                if (!isMatch && diff < 21600000) {
                    console.log(`[${this.callSid}] Mismatch: Slot ${slot} vs Target ${formattedTime} | Diff: ${diff / 1000 / 60} minutes`);
                }

                return isMatch;
            });

            if (match) {
                console.log(`[${this.callSid}] ✅ MATCH FOUND: ${match}`);
                // Return the SLOT time (the official one), not the converted AI time, to ensure consistency
                return { isValid: true, formattedTime: match };
            } else {
                console.log(`[${this.callSid}] ❌ NO MATCH FOUND in ${this.availableSlots.length} slots.`);
                return { isValid: false, formattedTime: formattedTime };
            }

        } catch (e) {
            console.error(`[${this.callSid}] Validation Error:`, e);
            return { isValid: false, formattedTime: null };
        }
    }

    async updateAgentWithoutTriggeringResponse(newMessage) {
        try {
            const history = await this.chat.getHistory();
            const newHistory = [...history, {


                role: "user",
                parts: [{ text: newMessage }]
            }];
            this.chat = this.model.startChat({
                history: newHistory,
            });
            console.log(`[${this.callSid}] History updated silently with new message.`);

        } catch (e) {
            console.error(`[${this.callSid}] Failed to update history silently:`, e);
        }
    }




    async processResponse(geminiResponse) {
        try {
            let fedToTwilio;
            try {
                const cleanJson = geminiResponse.replace(/```json\\s * /g, "").replace(/```/g, "").trim();
                fedToTwilio = JSON.parse(cleanJson);
            } catch (e) {
                console.error(`[${this.callSid}] Failed to parse Gemini JSON: `, e);
                console.error(`[${this.callSid}] Raw response: ${geminiResponse} `);
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

            // this.transcript.push({
            //     sender: "You",
            //     message: fedToTwilio.response,
            //     order: this.messageNumber++,
            // });




            this.rating = fedToTwilio.rating;

            console.log(`[${this.callSid}]Metadata: rating = ${fedToTwilio.rating}, hangUp = ${fedToTwilio.hangup} `);
            console.log("this is what we fed to twilio", fedToTwilio);

            // 1. Loop Prevention & State Tracking
            const currentState = fedToTwilio.conversation_state;
            if (currentState === this.lastConversationState && this.currentState !== "gathering_data") {
                this.stateRepetitionCount++;
                console.log(`[${this.callSid}] State '${currentState}' repeated ${this.stateRepetitionCount} times.`);
            } else {
                this.lastConversationState = currentState;
                this.stateRepetitionCount = 0;
            }

            // Trigger transfer if stuck in same state for too long (e.g., 4 turns)
            if (this.stateRepetitionCount >= 15 && this.currentState !== "gathering_data") {
                console.log(`[${this.callSid}] Loop detected (State: ${currentState}). Initiating transfer.`);
                this.isTransferring = true;
                // Force a transfer action
                fedToTwilio.action = "transfer";
            }


            // 2. Update Internal State from 'extracted_data'
            const extracted = fedToTwilio.extracted_data || {};

            if (extracted.customerName) this.customerName = extracted.customerName;
            if (extracted.vehicleModel) this.vehicleModel = extracted.vehicleModel;
            if (extracted.customerEmail) this.customerEmail = extracted.customerEmail;
            if (extracted.paymentMethod) this.paymentMethod = extracted.paymentMethod;

            // Special handling for appointmentTime validation
            if (extracted.appointmentTime) {
                // REUSE the exact same validation logic
                const { isValid, formattedTime } = this.validateTimeSlot(extracted.appointmentTime, true);
                if (isValid) {
                    this.appointmentTime = formattedTime;
                } else {
                    console.log(`[${this.callSid}] Implicit Set Failed: Time INVALID (${formattedTime})`);
                }
            }


            if (fedToTwilio.action === "transfer") {
                this.isTransferring = true;
                // this.transferCall(); // Trigger it immediately
                return;
            }

            if (fedToTwilio.action === "check_availability" && !this.justCheckedAvailability) {
                console.log(`[${this.callSid}] Action: check_availability triggered`);
                try {
                    this.currentlyCheckingAvailability = true;
                    this.justCheckedAvailability = true;

                    // Give immediate audio feedback to fill the silence
                    if (this.ttsStream && !this.ttsStream.destroyed) {
                        console.log(`[${this.callSid}] Speaking 'checking schedule' filler.`);
                        // this.ttsStream.write({
                        //     input: { text: "  Hold on, let me just check the schedule for you..." }
                        // });
                    }

                    // Generate 4 sequential weekly dates starting from NOW
                    const today = new Date();

                    const week0 = new Date(today.getTime() + 30 * 60000); // Add 30 minutes buffer

                    const week1 = new Date(today);
                    week1.setDate(today.getDate() + 7);

                    const week2 = new Date(today);
                    week2.setDate(today.getDate() + 14);

                    const week3 = new Date(today);
                    week3.setDate(today.getDate() + 21);

                    // Fetch 4 weeks of availability in parallel using specific start dates
                    const [res0, res1, res2, res3] = await Promise.all([
                        await getAvailability(week0),
                        await getAvailability(week1),
                        await getAvailability(week2),
                        await getAvailability(week3)
                    ]);

                    const availabilityData = [res0.collection.map((x) => x.start_time), res1.collection.map((x) => x.start_time), res2.collection.map((x) => x.start_time), res3.collection.map((x) => x.start_time)];

                    const localData = availabilityData.flat();
                    this.availableSlots = localData;


                    const systemMessage = `System Update: Here are the available slots for the next month: ${JSON.stringify(availabilityData)}. Please offer 2 - 3 of these times to the user.IMPORTANT: DO NOT set 'action' to 'check_availability' again.Offer the times immediately.`;
                    this.currentlyCheckingAvailability = false;
                    await this.processLLM(systemMessage);

                    return;
                } catch (error) {
                    console.error(`[${this.callSid}] Error checking availability: `, error);
                    await this.processLLM(`System Update: Failed to fetch availability. Tell the user there was a technical glitch checking the calendar.`);
                    this.currentlyCheckingAvailability = false;
                    return;
                }
            } else if (fedToTwilio.action === "check_if_time_is_valid") {

                // Use the extracted time if the explicit action parameter is missing (fallback)
                const timeToCheck = fedToTwilio.appointmentTime || extracted.appointmentTime;

                const { isValid, formattedTime } = this.validateTimeSlot(timeToCheck, false);

                if (isValid) {
                    console.log(`[${this.callSid}] Tool Check: Time valid.`);
                    this.appointmentTime = formattedTime; // Set state

                    // Update system prompts to keep LLM in sync
                    this.updateAgentWithoutTriggeringResponse("System Prompt: The selected appointment time is valid.");
                    this.processLLM("Response: The selected appointment time is valid. Continue with Conversation");
                    this.sendClear();
                } else {
                    console.log(`[${this.callSid}] Tool Check: Time INVALID.`);

                    this.updateAgentWithoutTriggeringResponse("System Prompt: The selected appointment time is invalid/taken. Ask user for another time.");

                    this.processLLM("Response: The selected appointment time is invalid. Please ask the user to select another time from the available slots.");
                    this.sendClear();
                }
                return; // Stop here, wait for next LLM turn
            }
            else {
                this.justCheckedAvailability = false;
            }

            // If we have all appointment details and payment method is NOT unknown, attempt to schedule
            // Check against instance variables instead of the ephemeral response
            console.log(`[${this.callSid}] Attempting to schedule appointment:`);
            if (this.customerName && this.vehicleModel && this.customerEmail && this.paymentMethod &&
                this.customerName !== "NOT_SET" && this.customerEmail !== "NOT_SET" &&
                this.vehicleModel !== "NOT_SET" && this.paymentMethod !== "unknown" &&
                this.appointmentTime && this.appointmentTime !== "NOT_SET" && this.paymentMethod !== "NOT_SET") {

                const currentAttempt = JSON.stringify({
                    n: this.customerName,
                    v: this.vehicleModel,
                    e: this.customerEmail,
                    p: this.paymentMethod,
                    t: this.appointmentTime
                });

                if (this.lastAttemptedDetails === currentAttempt || (this.hasScheduledAppointment || !this.hasConfirmedDetails)) {
                    console.log(`[${this.callSid}] Skipping scheduling - details unchanged from last failure or success. First Boolean: ${this.lastAttemptedDetails===currentAttempt}, Second Boolean: ${this.hasScheduledAppointment}, Third Boolean: ${this.hasConfirmedDetails}`);
                } else {

                    // Remember, we need to add a check to make sure the AI isn't confirming when we really havent scheduled the appointment yet


                    this.lastAttemptedDetails = currentAttempt;

                    // Create a details object from our state
                    const appointmentDetails = {
                        customerName: this.customerName,
                        vehicleModel: this.vehicleModel,
                        customerEmail: this.customerEmail,
                        paymentMethod: this.paymentMethod,
                        appointmentTime: this.appointmentTime,
                        rating: fedToTwilio.rating, // Keep these from current response
                        hangup: fedToTwilio.hangup
                    };

                    const scheduleMsg = await this.handleAppointment(appointmentDetails);
                    console.log(`[${this.callSid}] Appointment result: ${scheduleMsg} `);

                    if (scheduleMsg.toLowerCase().includes("success")) {
                        this.hasScheduledAppointment = true;
                        this.errorWhenScheduling = false;
                    } else {
                        this.errorWhenScheduling = true;
                    }

                    // Chain the result back to Gemini so it can speak the confirmation
                    // We pretend this is a system message in the transcript
                    await this.processLLM(`System Update: The appointment was attempted. Result: "${scheduleMsg}".Please inform the user.`);
                    return; // Return early, processLLM will handle the flow
                }
            } else {
                console.log(`[${this.callSid}] No action taken.`);
                console.log("Person name is:", this.customerName);
                console.log("Vehicle model is:", this.vehicleModel);
                console.log("Customer email is:", this.customerEmail);
                console.log("Payment method is:", this.paymentMethod);
                console.log("Appointment time is:", this.appointmentTime);
            }

            if (fedToTwilio.hangUp || fedToTwilio.hangup) {
                console.log(`[${this.callSid}] Hangup requested.Waiting for audio to finish.`);
                this.shouldHangup = true;
            } else {
                // Only start listening if we didn't hang up and didn't chain a new LLM turn
                this.aiTalking = false;
                this.startGoogleSpeechStream();
            }
        } catch (e) {
            console.error(`[${this.callSid}]Error in processResponse: `, e);
            this.aiTalking = false;
            this.startGoogleSpeechStream();
        }
    }
    async transferCall() {
        console.log(`[${this.callSid}] Transferring call to ${this.transferNumber} `);
        this.sendClear(); // Stop any current audio
        this.isTransferring = true; // Flag to prevent hangup() from ending the call

        try {
            await client.calls(this.callSid).update({
                twiml: `<Response><Dial>${this.transferNumber}</Dial></Response>`
            });
            console.log(`[${this.callSid}] Call transferred successfully.`);
            // this.shouldHangup = true; // Removed this because we don't want to hangup, we want to transfer.
        } catch (error) {
            console.error(`[${this.callSid}] Error transferring call: `, error);
            this.isTransferring = false; // Reset flag on error so we can hangup if needed
        }
    }

    async handleAppointment(details) {
        console.log(`[${this.callSid}] handleAppointment called with: `, JSON.stringify(details, null, 2));
        try {
            // 2. Convert time to UTC ISO string
            let appointmentTime = details.appointmentTime;
            try {
                if (appointmentTime) {
                    // WE MUST CONVERT 'FAKE UTC' to 'REAL UTC' HERE for Calendly
                    // Input: "2025-12-12T13:00:00Z" (1 PM EST, but flagged as Z)
                    // Output: "2025-12-12T18:00:00Z" (6 PM UTC / 1 PM EST)
                    console.log(`[${this.callSid}] Converting Appointment Time for Booking: ${appointmentTime}`);

                    // Use our trusted converter
                    appointmentTime = this.convertEstToRealUtc(appointmentTime);
                    console.log(`[${this.callSid}] Resulting UTC Time: ${appointmentTime}`);

                } else {
                    return "STATUS: FAILED: You must send an appointment time before continuing.";
                }
            } catch (err) {
                console.error(`[${this.callSid}] Date conversion error: `, err);
            }

            // 2. Construct Payload
            const payload = {
                email: details.customerEmail,
                name: details.customerName,
                phone: this.phoneNumber,
                model: details.vehicleModel || "N/A",
                make: "N/A",
                insuranceClaim: details.paymentMethod || "unknown",
                appointmentTime: appointmentTime
            };

            console.log(`[${this.callSid}] Sending payload to scheduleAppointment: `, JSON.stringify(payload, null, 2));

            const result = await scheduleAppointment(payload);
            console.log(`[${this.callSid}] scheduleAppointment result: `, JSON.stringify(result, null, 2));

            if (result && result.resource && result.resource.uri) {
                return `STATUS: SUCCESS.URI: ${result.resource.uri} `;
            }

            // Extract specific error if available
            let errorReason = "Unable to schedule.";
            if (result && result.error) {
                errorReason = `Error from Calendly: ${result.error} `;
            }

            this.sendClear();
            return `STATUS: FAILED.Reason: ${errorReason} Offer transfer to ${this.transferNumber} or new time.`;
        } catch (e) {
            console.error(`[${this.callSid}] Scheduling error in handleAppointment: `, e);
            this.sendClear();
            return `STATUS: FAILED.Reason: Error scheduling(${e.message}).Offer transfer to ${this.transferNumber} or new time.`;
        }
    }

    setupGoogleTTSStream() {
        const stream = ttsClient.streamingSynthesize();


        stream.on('data', (response) => {
            this.aiTalking = false;
            this.interrupted = false;
            this.sendingAudio = true;
            this.twilioPlaying = true;
            const { audioContent } = response;
            if (audioContent) {
                console.log(`[${this.callSid}] Received audio chunk from Google TTS`, audioContent.length);
                if (this.interrupted) {
                    console.log(`[${this.callSid}]Interrupted, skipping TTS audio chunk.`);
                    return;
                }
                // this.sendClear();


                const inputSamples = [];
                for (let i = 0; i < audioContent.length; i += 2) {
                    inputSamples.push(audioContent.readInt16LE(i));
                }

                // console.log(`[${ this.callSid }] Input samples: ${ inputSamples.length } (from ${ audioContent.length } bytes)`);

                const resampledData = waveResampler.resample(inputSamples, 24000, 8000, {
                    method: "sinc",
                    LPF: true,
                    bitDepth: 16
                });

                // console.log(`[${ this.callSid }] Resampled output length: ${ resampledData.length } `);

                const pcm8kInt16 = new Int16Array(resampledData.length);
                for (let i = 0; i < resampledData.length; i++) {
                    pcm8kInt16[i] = resampledData[i];
                }

                const mulawSamples = mulaw.encode(pcm8kInt16);
                // console.log(`[${ this.callSid }]Sizes: PCM 8k = ${ pcm8kInt16.length } samples -> MULAW=${ mulawSamples.length } samples`);

                const mulawBuffer = Buffer.from(mulawSamples);
                const audioChunk = mulawBuffer.toString("base64");
                this.sendAudioChunk(audioChunk);

                const durationInSec = this.calculatePlayback(mulawBuffer.length, 8000);
                const durationInMs = durationInSec * 1000;

                const now = Date.now();
                this.estimatedPlaybackEnd = Math.max(this.estimatedPlaybackEnd, now) + durationInMs;

                if (this.playbackTimeout) {
                    clearTimeout(this.playbackTimeout);
                }
                this.twilioPlaying = true;

                const timeUntilEnd = this.estimatedPlaybackEnd - now;

                this.playbackTimeout = setTimeout(() => {


                    if (!this.interrupted) {
                        this.sendBackgroundAudio();
                    }
                    this.twilioPlaying = false;
                    this.sendingAudio = false;
                    // console.log(`[${ this.callSid }] TTS Playback finished(est).`);


                    if (this.shouldHangup) {
                        console.log(`[${this.callSid}] Audio finished, executing delayed hangup.`);
                        this.hangup();
                    } else if (this.isTransferring) {
                        console.log(`[${this.callSid}] Audio finished, executing delayed transfer.`);
                        this.transferCall();
                    }
                }, timeUntilEnd + 500);
            }
        });

        stream.on('error', (err) => {
            // console.error(`[${ this.callSid }] Google TTS Stream Error: `, err);
        });

        const request = {
            streamingConfig: {
                audioConfig: {
                    audioEncoding: 'LINEAR16',
                    sampleRateHertz: 24000,
                },
                voice: {
                    languageCode: 'en-US',
                    name: 'en-US-Chirp3-HD-Puck',
                },
            },
        };
        stream.write(request);


        this.startGoogleSpeechStream();

        return stream;
    }

    sendAudioChunk(chunk) {
        if (this.interrupted) {
            console.log(`[${this.callSid}]Interrupted, skipping audio chunk.`);
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

            // lets just put all the variable management in here;

            // this.aiTalking = false;
            // this.sendingAudio = false;
            // this.twilioPlaying = false;



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

        if (this.ttsStream) {
            this.ttsStream.destroy();
            this.ttsStream = null;
        }

        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }

        // If we are transferring, DO NOT end the call via Twilio API.
        if (this.isTransferring) {
            console.log(`[${this.callSid}]Transfer in progress.Skipping Twilio call termination.`);
            return;
        }

        try {
            const call = await client.calls(this.callSid).fetch();
            if (call.status !== 'completed') {
                await client.calls(this.callSid).update({ status: "completed" });
            }
        } catch (error) {
            console.error(`[${this.callSid}] Error updating call status: `, error);
        }

        // if (this.uuid !== "demo" && this.rating > 75) {
        //     this.isLead = true;
        //     this.generateCallSummary();
        // } else {
        //     console.log(`[${this.callSid}] Call ended.Not a lead(Rating: ${this.rating}).`);
        // }
    }

    // async generateCallSummary() {
    //     console.log(`[${this.callSid}] Generating call summary...`);
    //     let readableTranscript = this.transcript
    //         .map(msg => `${msg.sender}: ${msg.message} `)
    //         .join("\n\n");

    //     const prompt = `I'm providing a transcript of a conversation between a real estate agent and a client.
                
    //             Give a 150 character summary of the key points in the conversation that would be useful to a real estate agent.
                
    //             Here is the transcript: ${readableTranscript}
    //         `;

    //     try {
    //         const summaryModel = genAI.getGenerativeModel({ model: "gemini-2.5-flash-lite" });
    //         const result = await summaryModel.generateContent(prompt);
    //         const aiSummary = result.response.text();

    //         this.convoSummary = aiSummary;
    //         console.log(`[${this.callSid}] AI summary: ${aiSummary} `);

    //         const response = {
    //             uuid: this.uuid,
    //             phoneNumber: this.phoneNumber,
    //             agentAction: this.agentAction,
    //             location: this.agentLocation,
    //             message: this.convoSummary,
    //         };
    //         console.log(`[${this.callSid}] Lead details: `, response);

    //     } catch (error) {
    //         console.error(`[${this.callSid}] Error generating summary: `, error);
    //     }
    // }
}

module.exports = Call;