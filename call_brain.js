const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require("@google/generative-ai");
const StreamParser = require("./stream_parser");
// const { getAvailability } = require("./calendly");
const { ToolCall } = require("./ToolCall")
class BrainService {
    constructor(parentCall) {
        this.call = parentCall;
        this.callSid = parentCall.callSid;
        this.genAI = new GoogleGenerativeAI(process.env.GEMINI_KEY);
        this.model = null;
        this.chat = null;

        this.safetySettings = [
            { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
            { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
            { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
            { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
        ];

        this.initModel();
    }

    initModel() {
        this.model = this.genAI.getGenerativeModel({
            model: "gemini-2.5-flash-lite",
            generationConfig: {
                temperature: 0.1,
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
                                appointmentTime: {
                                    type: "STRING",
                                    description: "The requested appointment time in 'YYYY-MM-DDTHH:MM:SS.00Z' 24-hour format, in the business's local time (EST). ONLY include if the user explicitly provided it this turn. Do NOT guess or infer."
                                }
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
            safetySettings: this.safetySettings,
        });
    }

    async init() {
        const systemPrompt = await this.buildSystemPrompt(this.call.agentName, this.call.agentLocation, this.call.agentAction);

        this.chat = this.model.startChat({
            history: [
                { role: "user", parts: [{ text: systemPrompt }] },
                {
                    role: "model",
                    parts: [{
                        text: JSON.stringify({
                            thought: "Initial greeting.",
                            conversation_state: "gathering_data",
                            response: `Hi this is ${this.call.businessName} how may we help you today?`,
                            rating: 5,
                            hangup: false,
                            action: "respond"
                        })
                    }]
                }
            ],
        });
    }

    async buildSystemPrompt() {
        return `
IDENTITY: You are the AI Receptionist for "Quattro Body Shop" in Bethesda, MD.
GOAL: Book estimates naturally. Sound 100% human.

[BUSINESS RULES]
- LOCATION: 4907 Elm St, Bethesda, MD 20814.
- Nearby Landmarks: Across from a Matchbox Restaurant, a public parking lot is in front of it, and under an Equinox Gym.
- HOURS: 8am-4pm, M-F.
- Current Date: ${new Date(Date.now()).toLocaleString()}
- SERVICES: Collision, paint, dents (PDR), frame work.
- PRICING: No phone quotes. "Come in for a free estimate."
- APPOINTMENTS: 30-min slots. Hour or half-hour only. 

[STATE MACHINE LOGIC]
1. STATE: "answering_general_question"
   - TRIGGER: User asks about price, services, location, hours, or "are you a robot?". 
2. STATE: "gathering_data"
   - TRIGGER: User wants to book or gives details.
   - ORDER: Time -> Name -> Vehicle -> Email -> Payment.
   - **RULE**: Ask for only ONE piece of information at a time. Do not overwhelm the user.
3. STATE: "confirming_details"
   - TRIGGER: All fields are known.
   - **CRITICAL RULE**: You MUST have checked availability (action: "check_availability" or "check_if_time_is_valid") before you can confirm a time. Never confirm a time you haven't recently verified.
4. State: "schedule_appointment"
   - TRIGGER: All data filled out and user confirmed.

[HARDENED EXTRACTION RULES]
- **extracted_data**: ONLY include keys if provided this turn.
- **NO GUESSING**.
- **MISSING DATA**: OMIT the key if unknown.

[CRITICAL INSTRUCTIONS]
1. NO HALLUCINATIONS.
2. NO REPETITION.
3. INTERRUPTIONS: STOP talking.
4. NO PLACEHOLDERS.
5. **ONE QUESTION PER TURN**: Never ask for Name and Email in the same turn. Break it up.

[STYLE]
- Concise. Friendly. Professional.
`;
    }

    async processLLM(transcript) {
        if (!transcript) {
            console.log(`[${this.callSid}] Empty transcript, restarting STT.`);
            this.call.aiTalking = false;
            this.call.voices.startGoogleSpeechStream();
            return;
        }

        if (this.call.currentlyCheckingAvailability) {
            console.log(`[${this.callSid}] Currently checking availability, skipping STT.`);
            return;
        }

        if (transcript.toLowerCase().includes("system update")) {
            console.log(`[${this.callSid}] System update detected, sending clear`);
            this.call.sendClear();
        }

        this.call.aiTalking = true;
        this.call.voices.stopGoogleSpeechStream();

        try {
            const missingFields = [];
            if (!this.call.customerName) missingFields.push("customerName");
            if (!this.call.vehicleModel) missingFields.push("vehicleModel");
            if (!this.call.customerEmail) missingFields.push("customerEmail");
            if (!this.call.paymentMethod) missingFields.push("paymentMethod");
            if (!this.call.appointmentTime) missingFields.push("appointmentTime");

            const systemContext = `
[INTERNAL STATE]
MISSING_FIELDS: ${missingFields.length > 0 ? missingFields.join(", ") : "NONE - Ready to Schedule"}
CURRENT_APPOINTMENT_TIME: ${this.call.appointmentTime || "UNKNOWN"}
KNOWN_DATA: Name=${this.call.customerName || "?"}, Car=${this.call.vehicleModel || "?"}, Email=${this.call.customerEmail || "?"}, Pay=${this.call.paymentMethod || "?"}

[PRIORITY DECISION LOGIC]
1. **CHECK AVAILABILITY**: If user asks about times, set 'action': "check_availability".
2. **BOOKING**: If MISSING_FIELDS is "NONE - Ready to Schedule" and confirmed, set 'action': "schedule_appointment".
3. **GATHERING**: If fields missing, ask for next.
4. **CONFIRMATION**: If MISSING_FIELDS is NONE, transition to "confirming_details".
`;

            const augmentedTranscript = `${systemContext} \n\nUser says: "${transcript}"`;
            console.log(`[${this.callSid}] Augmented Transcript: \n${augmentedTranscript}`);

            const result = await this.chat.sendMessageStream(augmentedTranscript);
            const stream = result.stream;
            const parser = new StreamParser();

            this.call.voices.ttsStream = this.call.voices.setupGoogleTTSStream();

            let firstToken = true;
            let shouldUseCannedResponse = false;
            let cannedMessage = "";

            for await (const chunk of stream) {
                if (firstToken) {
                    console.log(`[${this.callSid}][${Date.now()}] Gemini First Token Received`);
                    firstToken = false;
                    if (this.call.timeWhenUserHasFinishedSpeaking !== 0n) {
                        const newWaitTime = process.hrtime.bigint() - this.call.timeWhenUserHasFinishedSpeaking;
                        this.call.listOfWaitTimes.push(newWaitTime);
                        this.call.timeWhenUserHasFinishedSpeaking = 0n;
                    }
                }

                const chunkText = chunk.text();
                const { newAudioText, completeObject } = parser.process(chunkText);

                if (newAudioText.length > 0 && !shouldUseCannedResponse) {
                    console.log(`[${this.callSid}] Streaming TTS: "${newAudioText}"`);
                    this.call.voices.ttsStream.write({ input: { text: newAudioText } });
                    this.call.messageNumber += 1;
                }

                if (completeObject) {
                    await this.processBrainResponse(completeObject);
                }
            }

            // --- TTS CLOSURE FIX ---
            if (this.call.voices.ttsStream) {
                console.log(`[${this.callSid}] Response finished, ending TTS stream.`);
                this.call.voices.ttsStream.end();
                this.call.voices.ttsStream = null;
            }

        } catch (e) {
            console.error(`[${this.callSid}] Error in processLLM:`, e);
            this.call.aiTalking = false;
            this.call.voices.startGoogleSpeechStream();

            if (this.call.voices.ttsStream) {
                this.call.voices.ttsStream.destroy();
                this.call.voices.ttsStream = null;
            }
        }
    }


    resetStatus = (resetStatus) => {
        if (resetStatus) {
            this.call.confirmationStatus = "PENDING_USER_APPROVAL";
        }
    }

    async processBrainResponse(completeObject) {
        const parsed = completeObject;
        let shouldUseCannedResponse = false;
        let cannedMessage = "";

        if (parsed.extracted_data) {
            if (parsed.extracted_data.appointmentTime) {
                const { isValid, formattedTime } = this.call.tools.validateTimeSlot(parsed.extracted_data.appointmentTime, true);
                if (isValid) {
                    this.call.appointmentTime = formattedTime;
                    console.log(`[${this.callSid}] 🟢 Real-time Time Extraction: ${formattedTime}`);
                }
            }

            const shouldResetStatus = this.confirmationStatus !== "PENDING_USER_APPROVAL"
            if (parsed.extracted_data.customerName) {
                this.call.customerName = parsed.extracted_data.customerName;
                this.resetStatus(shouldResetStatus)
            }
            if (parsed.extracted_data.customerEmail) {
                this.call.customerEmail = parsed.extracted_data.customerEmail
                this.resetStatus(shouldResetStatus);
            }

            if (parsed.extracted_data.paymentMethod) {
                this.call.paymentMethod = parsed.extracted_data.paymentMethod
                this.resetStatus(shouldResetStatus)
            }

            if (parsed.extracted_data.vehicleModel) {
                this.call.vehicleModel = parsed.extracted_data.vehicleModel
                this.resetStatus(shouldResetStatus)
            }
        }




        // Hallucination Guards

        const missing = [];
        if (!this.call.appointmentTime) missing.push("time");
        if (!this.call.customerName) missing.push("name");
        if (!this.call.vehicleModel) missing.push("vehicle model");
        if (!this.call.customerEmail) missing.push("email");
        if (!this.call.paymentMethod) missing.push("payment method");
        if (parsed.conversation_state === "confirming_details") {


            if (missing.length > 0) {
                console.log(`[${this.callSid}] 🛑 HALLUCINATION GUARD: Missing ${missing.join(", ")}`);
                shouldUseCannedResponse = true;
                cannedMessage = `I apologize, I missed the ${missing[0]}. Could you please repeat it?`;
            } else {
                this.call.logAllMeaningfulStats();
            }
        }

        if (missing.length == 0) {
            // We should start confirming details anyway here:

            cannedMessage = `Okay, just to confirm, I have you set for an appointment on ${this.convertUtcToEst(this.call.appointmentTime)} for your ${this.call.vehicleModel}. ${this.customerName}'s email is ${formatEmail(this.call.customerEmail)} and I have you for ${this.call.paymentMethod}. Is this all correct?`

            shouldUseCannedResponse = true;
            this.call.confirmationStatus = "PENDING_USER_APPROVAL";

            this.updateAgentWithoutTriggeringResponse(`System: User has NOT confirmed yet. I asked them to confirm details. Wait for 'Yes'.`)


        }

        if (shouldUseCannedResponse) {
            if (this.call.voices.ttsStream && !this.call.voices.ttsStream.destroyed) {
                this.call.voices.ttsStream.destroy();
            }
            this.call.voices.ttsStream = null;
            this.call.sendClear();
            await this.updateAgentWithoutTriggeringResponse(cannedMessage);
            return;
        }

        // Action Handling
        await this.call.processResponse(JSON.stringify(parsed));
    }

    formatEmail(customerEmail) {
        let newEmail = "";


        for (let i = 0; i < customerEmail.length; i++) {

            newEmail += customerEmail[i]

            if (i == customerEmail.length - 1) {
                newEmail += " ";
            }

        }
        return newEmail;


    }

    convertUtcToEst(utcDateString) {
        if (utcDateString && utcDateString.length > 0) {
            const cleanIso = utcDateString.replace('Z', '');
            const utcDate = fromZonedTime(cleanIso, 'UTC');
            return utcDate.toISOString();
        } else {
            throw new Error("Empty date string provided to convertUtcToEst");
        }
    }


    async updateAgentWithoutTriggeringResponse(newMessage) {
        try {
            await this.chat.sendMessage(newMessage);
            console.log(`[${this.callSid}] History updated silently.`);
        } catch (e) {
            console.error(`[${this.callSid}] Failed to update history silently:`, e);
        }
    }
}

module.exports = BrainService;