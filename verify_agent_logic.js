const { GoogleGenerativeAI } = require("@google/generative-ai");
require("dotenv").config();

// MOCK CONSTANTS
const BUSINESS_NAME = "Quattro BodyShop";
const AGENT_LOCATION = "Bethesda, Maryland";
const AGENT_ACTION = "sell";

// Mock Call Class behavior
class MockCall {
    constructor() {
        this.customerName = null;
        this.vehicleModel = null;
        this.customerEmail = null;
        this.paymentMethod = null;
        this.appointmentTime = null;
        this.lastConversationState = null;
        this.stateRepetitionCount = 0;
    }

    async testPrompt(transcript) {
        const genAI = new GoogleGenerativeAI(process.env.GEMINI_KEY);
        const model = genAI.getGenerativeModel({
            model: "gemini-2.5-flash-lite",
            generationConfig: {
                temperature: 0.1,
                responseMimeType: "application/json",
                responseSchema: {
                    type: "OBJECT",
                    properties: {
                        thought: { type: "STRING", description: "Internal reasoning. ONE sentence." },
                        conversation_state: { type: "STRING", enum: ["answering_general_question", "gathering_data", "confirming_details"] },
                        extracted_data: {
                            type: "OBJECT",
                            properties: {
                                customerName: { type: "STRING" },
                                vehicleModel: { type: "STRING" },
                                customerEmail: { type: "STRING" },
                                paymentMethod: { type: "STRING", enum: ["insurance", "out-of-pocket"] },
                                appointmentTime: { type: "STRING" }
                            },
                        },
                        response: { type: "STRING" },
                        rating: { type: "NUMBER" },
                        hangup: { type: "BOOLEAN" },
                        action: { type: "STRING", enum: ["respond", "hangup", "transfer", "check_availability", "check_if_time_is_valid"] },
                    },
                    required: ["thought", "conversation_state", "response", "rating", "hangup"],
                },
            },
        });

        const systemPrompt = `
IDENTITY: You are the AI Receptionist for "${BUSINESS_NAME}" in ${AGENT_LOCATION}.
GOAL: Book estimates naturally. Sound 100% human.

[STATE MACHINE LOGIC]
1. STATE: "answering_general_question"
   - TRIGGER: User asks about price, services, location, hours, or "are you a robot?".
   - BEHAVIOR: Answer the question DIRECTLY. Do NOT ask for booking details.
2. STATE: "gathering_data"
   - TRIGGER: User wants to book.
   - ORDER: Time -> Name -> Vehicle -> Email -> Payment.
3. STATE: "confirming_details"
   - TRIGGER: All fields are known.

[HARDENED EXTRACTION RULES]
- extracted_data: ONLY include keys if 100% CERTAIN.
- NO GUESSING.
- MISSING DATA: Omit valid keys.

[INTERNAL STATE]
MISSING_FIELDS: ${this.getMissingFields()}
KNOWN_DATA: Name=${this.customerName}, Car=${this.vehicleModel}
`;

        const chat = model.startChat({
            history: [
                { role: "user", parts: [{ text: systemPrompt }] },
                { role: "model", parts: [{ text: JSON.stringify({ thought: "Init", conversation_state: "gathering_data", response: "Hi", rating: 5, hangup: false }) }] }
            ]
        });

        console.log(`\nUser says: "${transcript}"`);
        const result = await chat.sendMessage(transcript);
        const responseText = result.response.text();
        console.log("Model response:", responseText);

        try {
            const parsed = JSON.parse(responseText);
            this.updateState(parsed);
        } catch (e) {
            console.error("Failed to parse", e);
        }
    }

    getMissingFields() {
        const missing = [];
        if (!this.customerName) missing.push("customerName");
        if (!this.vehicleModel) missing.push("vehicleModel");
        return missing.join(", ");
    }

    updateState(parsed) {
        if (parsed.extracted_data) {
            if (parsed.extracted_data.customerName) this.customerName = parsed.extracted_data.customerName;
            if (parsed.extracted_data.vehicleModel) this.vehicleModel = parsed.extracted_data.vehicleModel;
        }
        console.log("Updated State:", { name: this.customerName, vehicle: this.vehicleModel });
    }
}

const fs = require('fs');

async function runTest() {
    let logBuffer = "";

    // Override console.log to capture output
    const originalConsoleLog = console.log;
    console.log = (...args) => {
        const msg = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg, null, 2) : arg).join(" ");
        originalConsoleLog(msg);
        logBuffer += msg + "\n";
    };

    const call = new MockCall();

    console.log("Test 1: General Question");
    await call.testPrompt("How much do you charge?");

    console.log("\nTest 2: Book appointment");
    await call.testPrompt("I want to book an appointment for Tuesday at 2pm.");

    console.log("\nTest 3: Give Name");
    await call.testPrompt("My name is John Doe.");

    fs.writeFileSync('verification.log', logBuffer);
}

runTest();
