require('dotenv').config();
const Call = require('./Call');
const EventEmitter = require('events');
// const readline = require('readline');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const fs = require("fs");

// --- CONFIGURATION ---
const genAI = new GoogleGenerativeAI(process.env.GEMINI_KEY);
const VALIDATION_MODEL = "gemini-2.5-flash";

// --- TEST CASES ---
const testCases = [
    {
        name: "Happy Path (Linear Collection)",
        goal: "Verify that the agent moves from 'gathering_data' to 'schedule_appointment' when fields are provided sequentially.",
        steps: [
            "Hi, I need to get a bumper repair estimate.",
            "Sure, it's John Doe.",
            "2018 Toyota Camry.",
            "john.doe@gmail.com",
            "I'm paying out of pocket.",
            "Next Tuesday at 10am.",
            "Yes, that's all correct.",
        ]
    },
    {
        name: "Strict Payment Mapping & Email Reconstruction",
        goal: "Verify the system prompt instructions: mapping 'Cash' -> 'out-of-pocket' and formatting spoken emails correctly.",
        steps: [
            "I want to book an appointment.",
            "My name is Sarah Connor.",
            "It's a Jeep Wrangler.",
            "My email is sarah dot connor at skylink dot net", // STT format testing
            "I'll pay with cash.", // Must map to 'out-of-pocket'
            "Monday at 2pm."
        ]
    },
    {
        name: "Availability Check Flow (Async Logic)",
        goal: "Trigger the 'check_availability' action. This tests if the canned response fires and if the system correctly ingests the 'System Update' with slots.",
        steps: [
            "I need an estimate for a scratch.",
            "Michael Scott.",
            "Chrysler Sebring.",
            "michael@dunder.com",
            "Insurance.",
            "When are you guys free?", // Should trigger action: "check_availability"
            "Okay, let's do the first slot you mentioned." // Requires AI to remember the slots injected via system message
        ]
    },
    {
        name: "Hallucination Guard - Premature Confirmation",
        goal: "Force the AI to try to confirm details before they exist. Your code's 'confirming_details' block should intercept this and force the AI to ask for the missing field.",
        steps: [
            "I'd like to book an appointment for tomorrow at 8am.",
            "My name is Alice.",
            "Can you just book it now?", // Missing: Car, Email, Payment. 
            // Expected: AI should NOT say "Is this correct?". It should ask for the vehicle.
            "It's a Honda Accord.",
            "alice@test.com",
            "Insurance."
        ]
    },
    {
        name: "Correction/Overwriting Data",
        goal: "Verify that if a user changes their mind, the 'extracted_data' updates the class state correctly.",
        steps: [
            "Book an appointment for John.",
            "For a 2020 BMW.",
            "Actually, sorry, it's for my other car, a 2015 Ford Fiesta.", // Should overwrite vehicleModel
            "john@test.com",
            "Paying myself.",
            "Friday at 9am."
        ]
    },
    {
        name: "Context Switching (General Q -> Booking)",
        goal: "Ensure the state machine correctly transitions from 'answering_general_question' back to 'gathering_data'.",
        steps: [
            "Do you guys do paintless dent repair?", // State: answering_general_question
            "Okay great. And where are you located?", // State: answering_general_question
            "Cool, I'd like to come in for that.", // State transition -> gathering_data
            "Jim Halpert.",
            "2022 Rivian.",
            "jim@test.com",
            "Insurance.",
            "Thursday at 1pm."
        ]
    },
    {
        name: "Invalid Time & Slot Validation",
        goal: "Trigger the 'check_if_time_is_valid' logic where 'isValid' returns false.",
        steps: [
            "I need an appointment.",
            "Test User.",
            "Test Car.",
            "test@test.com",
            "Cash.",
            "Can I come in on Sunday at 9pm?", // Business is closed/Slot doesn't exist
            "Okay, how about next Monday at 10am?" // Valid retry
        ]
    },
    {
        name: "Transfer Trigger (Frustration/Loop)",
        goal: "Verify that specific keywords trigger the 'transfer' action immediately.",
        steps: [
            "I'm having trouble understanding you.",
            "Can I just speak to a human please?", // Should trigger action: "transfer"
        ]
    },
    {
        name: "Mistyping fields multiple times",
        goal: "Verify that if a user provides invalid data multiple times, the AI handles it gracefully.",
        steps: [
            "Heyy how's it going I was wondering what you guys offered?",
            "Hmm. okay i see. yeah i need to get a price over the phone right now",
            "It's umm my car is a uh 2019... I think it's a... Toyota? No wait... a Honda? Yeah a Honda.",
            "My email is... uh... john.. doe... at... gmail... dot... com",
            "I think I'll be paying with uh... insurance? No wait... cash.",
            "Can I get an appointment for like... next friday at 3pm?",
            "Actually, can we do saturday at 11am instead?",
            "Sorry, I meant sunday at 11am.",
            "Wait, is sunday even open?",
            "Umm nevermind, let's just do next monday at 10am.",
            "Okay, I'm ready to book now.",
            "Yes, that's all correct.",
            "Thanks again. Appreciate you",
        ]
    },
    {
        name: "Insurance company on the phone",
        goal: "Verify that the AI can handle a call where the user is calling on behalf of their insurance company.",
        steps: [
            "Hello, I'm calling from State Farm regarding a claim.",
            "Yes, it's regarding a customer named Emily Clark.",
            "I'm not trying to book, I need to talk to a human representative about the claim process.",
            "Thank you, I appreciate your help.",
        ]
    },
    {
        name: "Doing Appointment Booking in a different order", 
        goal: "Verify that the AI can handle booking an appointment when the user provides information in a non-linear order.",
        steps: [ 
            "Hi, I want to book an appointment for my car with cash.",
            "It's a 2017 Ford Focus and my name is David Lee.",
            "My email is david.lee at example dot com.",
            "Can I get an appointment for next Wednesday at 2pm?",
            "Thanks again for your help!"
        ]
    },
    {
        name: "Directions Hell",
        verify: "Verify that the AI can handle a user asking for directions and being confused multiple times.",
        steps: [
            "Hi, can you tell me where you're located?",
            "Okay, but I'm coming from downtown. How do I get there again?",
            "Alright, but what if I take the highway instead?",
            "Got it. Now, once I'm on Cornell Ave, where do I turn?",
            "Where can I park when I get there?",
            "Thanks, I think I've got it now."
        ]
    }

];

// --- MOCKS ---

class MockWebSocket extends EventEmitter {
    send(data) { }
}

class MockStream extends EventEmitter {
    constructor(name, onWrite) {
        super();
        this.name = name;
        this.writable = true;
        this.onWrite = onWrite;
    }
    write(data) {
        if (this.name === "TTS" && data && data.input && data.input.text) {
            const text = data.input.text;
            // console.log(`\x1b[36mAI (${this.name}): ${text}\x1b[0m`);
            if (this.onWrite) this.onWrite(text);
        }
    }
    end() { this.emit('finish'); }
    destroy() { this.emit('close'); }
}

// --- TEST RUNNER ---

function writeTest(results) {

    let string = `Full Test Report (${new Date().toISOString()})`;

    string += "\n\n";

    for (const test of results) {
        string += `Test: ${test.name}\n`;
        string += `Goal: ${test.goal}\n`;
        string += "---------------------------------------------------\n";
        string += test.transcript.join("\n");
        string += "\n\n";
        string += "Extracted Variables:\n";
        string += JSON.stringify(test.allVariables, null, 2);
        string += "\n\n";
        string += test.didPass ? "PASS" : "FAIL";
        string += '\n\n';
        string += "Reasoning: " + test.validationResult;
        string += "\n\n";
    }

    string += "\n\n";

    fs.writeFileSync("test_report.txt", string);
}

async function runASingleTest(test) {
    return new Promise(async (resolve) => {
        console.log(`\x1b[35mStarting Test: ${test.name}\x1b[0m`);

        const localTranscript = []; // Local transcript for this test instance

        const mockWs = new MockWebSocket();
        const callId = `test-${Date.now() + Math.floor(Math.random() * 10000)}`;
        const call = new Call(callId, '+15550001234', 'inbound', 'Bethesda, MD', 'Quattro AI', 'test-uuid');

        // Instance-specific overrides to avoid global pollution
        call.sendAudioChunk = function (chunk) { };
        call.sendBackgroundAudio = function () { };
        call.stopBackgroundAudio = function () { };

        call.startGoogleSpeechStream = function () {
            this.googleSpeechStream = new MockStream("STT");
        };

        call.setupGoogleTTSStream = function () {
            this.ttsStream = new MockStream("TTS", (text) => {
                localTranscript.push(`AI: ${text}`);
            });
            return this.ttsStream;
        };

        call.init();
        await call.setWebsocket(mockWs, 'test-stream-sid');

        // Initial delay for greeting
        await new Promise(r => setTimeout(r, 1000));
        console.log("Full test object",test);
        console.log("These are the steps right now:", test.steps);
        for (const userStep of test.steps) {
            // console.log(`\x1b[33mYou: ${userStep}\x1b[0m`);
            while (localTranscript.length > 0 && (localTranscript[localTranscript.length - 1].startsWith("User:") || (localTranscript[localTranscript.length - 1].startsWith("AI:") && 
            (localTranscript[localTranscript.length - 1].toLowerCase().includes("give me one second") ||localTranscript[localTranscript.length - 1].toLowerCase().includes("let me see") ) ))) {
                // Wait for AI to finish speaking
                await new Promise(r => setTimeout(r, 200));
            }
            localTranscript.push(`User: ${userStep}`);

            try {
                // Pass the user input to the LLM
                await call.processLLM(userStep);

                // Wait a bit for the AI to "speak"
                // await new Promise(r => setTimeout(r, 500));
            } catch (e) {
                console.error(`Error during step in test '${test.name}':`, e);
            }
        }

        console.log(`\x1b[90mTest finished: ${test.name}. Validating...\x1b[0m`);
        const allVariables = {
                customerName: call.customerName,
                model: call.vehicleModel,
                email: call.customerEmail,
                paymentMethod: call.paymentMethod,
                appointmentTime: call.appointmentTime,
        }
        // Validate
        const validationResult = await validateConversation(test.goal, localTranscript, allVariables);

        console.log(`\x1b[1mResult (${test.name}): ${validationResult.pass ? "\x1b[32mPASS" : "\x1b[31mFAIL"}\x1b[0m`);

        resolve({
            name: test.name,
            goal: test.goal,
            steps: test.steps,
            transcript: localTranscript,
            allVariables: allVariables,
            validationResult: validationResult.reasoning,
            didPass: validationResult.pass
        });

    })
}

async function runTests() {
    console.log("\x1b[33m--- Starting Parallel Automated Tests ---\x1b[0m\n");

    try {
        const results = []
        for (let i=0; i<testCases.length; i++) {
            try {
                console.log("This is the initial test we are passing in", testCases[i])
                const result = await runASingleTest(testCases[i]);
                results.push(result);

                await new Promise(r => setTimeout(r, 1000));
            } catch(e) {
                console.log("There was an error for some reason", e);

            }

        }
        // const results = await Promise.all(testCases.map(test => runASingleTest(test)));

        console.log("\n\x1b[33m--- All Tests Completed ---\x1b[0m");
        writeTest(results);
        console.log("Report saved to test_report.txt");

    } catch (err) {
        console.error("Error running parallel tests:", err);
    }
}


async function validateConversation(goal, transcript, allVariables) {
    const model = genAI.getGenerativeModel({ model: VALIDATION_MODEL });
    const prompt = `
    You are a QA Tester for an AI Receptionist.
    
    GOAL: ${goal}

    Note: Make sure the responses make sense given the context of the conversation. Every single response should make sense given prior messages as well as helps in the overall flow of the conversation.
    
    TRANSCRIPT:
    ${transcript.join("\n")}

    EXTRACTED VARIABLES:
    ${JSON.stringify(allVariables, null, 2)}
    
    INSTRUCTIONS:
    1. Read the transcript.
    2. Determine if the AI met the GOAL.
    3. Return a JSON object: { "pass": boolean, "reasoning": "string" }
    `;

    try {
        const result = await model.generateContent(prompt);
        const response = result.response;
        let text = response.text();

        // Cleanup JSON markdown if present
        text = text.replace(/```json/g, "").replace(/```/g, "").trim();
        return JSON.parse(text);
    } catch (e) {
        return { pass: false, reasoning: `Validation Error: ${e.message}` };
    }
}

// --- ENTRY POINT ---

if (process.argv.includes('--interactive')) {
    // ... (Keep the interactive code here if needed, or separate file)
    console.log("Interactive mode not implemented in this version. Run without arguments for tests.");
} else {
    runTests().catch(err => console.error(err));
}
