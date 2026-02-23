import 'dotenv/config';
import { EventEmitter } from 'events';
import fs from 'fs';
import { GoogleGenerativeAI } from '@google/generative-ai';
import Call from './src/Call';
import { QUATTRO_AUTOBODY_CONFIG } from './src/types/index';

// ─── Configuration ────────────────────────────────────────────────────────────

const genAI            = new GoogleGenerativeAI(process.env.GEMINI_KEY ?? '');
const VALIDATION_MODEL = 'gemini-2.5-flash';

// ─── Test Cases ───────────────────────────────────────────────────────────────

const testCases = [
    {
        name: 'Happy Path (Linear Collection)',
        goal: 'Verify that the agent moves from "gathering_data" to "schedule_appointment" when fields are provided sequentially.',
        steps: [
            'Hi, I need to get a bumper repair estimate.',
            'Sure, it\'s John Doe.',
            '2018 Toyota Camry.',
            'john.doe@gmail.com',
            'I\'m paying out of pocket.',
            'Next Tuesday at 10am.',
            'Yes, that\'s all correct.',
        ]
    },
    {
        name: 'Strict Payment Mapping & Email Reconstruction',
        goal: 'Verify the system prompt instructions: mapping "Cash" -> "out-of-pocket" and formatting spoken emails correctly.',
        steps: [
            'I want to book an appointment.',
            'My name is Sarah Connor.',
            'It\'s a Jeep Wrangler.',
            'My email is sarah dot connor at skylink dot net',
            'I\'ll pay with cash.',
            'Monday at 2pm.'
        ]
    },
    {
        name: 'Availability Check Flow (Async Logic)',
        goal: 'Trigger the "check_availability" action. This tests if the canned response fires and if the system correctly ingests the "System Update" with slots.',
        steps: [
            'I need an estimate for a scratch.',
            'Michael Scott.',
            'Chrysler Sebring.',
            'michael@dunder.com',
            'Insurance.',
            'When are you guys free?',
            'Okay, let\'s do the first slot you mentioned.'
        ]
    },
    {
        name: 'Hallucination Guard - Premature Confirmation',
        goal: 'Force the AI to try to confirm details before they exist. Your code\'s "confirming_details" block should intercept this and force the AI to ask for the missing field.',
        steps: [
            'I\'d like to book an appointment for tomorrow at 8am.',
            'My name is Alice.',
            'Can you just book it now?',
            'It\'s a Honda Accord.',
            'alice@test.com',
            'Insurance.'
        ]
    },
    {
        name: 'Correction/Overwriting Data',
        goal: 'Verify that if a user changes their mind, the "extracted_data" updates the class state correctly.',
        steps: [
            'Book an appointment for John.',
            'For a 2020 BMW.',
            'Actually, sorry, it\'s for my other car, a 2015 Ford Fiesta.',
            'john@test.com',
            'Paying myself.',
            'Friday at 9am.'
        ]
    },
    {
        name: 'Context Switching (General Q -> Booking)',
        goal: 'Ensure the state machine correctly transitions from "answering_general_question" back to "gathering_data".',
        steps: [
            'Do you guys do paintless dent repair?',
            'Okay great. And where are you located?',
            'Cool, I\'d like to come in for that.',
            'Jim Halpert.',
            '2022 Rivian.',
            'jim@test.com',
            'Insurance.',
            'Thursday at 1pm.'
        ]
    },
    {
        name: 'Invalid Time & Slot Validation',
        goal: 'Trigger the "check_if_time_is_valid" logic where "isValid" returns false.',
        steps: [
            'I need an appointment.',
            'Test User.',
            'Test Car.',
            'test@test.com',
            'Cash.',
            'Can I come in on Sunday at 9pm?',
            'Okay, how about next Monday at 10am?'
        ]
    },
    {
        name: 'Transfer Trigger (Frustration/Loop)',
        goal: 'Verify that specific keywords trigger the "transfer" action immediately.',
        steps: [
            'I\'m having trouble understanding you.',
            'Can I just speak to a human please?',
        ]
    },
    {
        name: 'Doing Appointment Booking in a different order',
        goal: 'Verify that the AI can handle booking an appointment when the user provides information in a non-linear order.',
        steps: [
            'Hi, I want to book an appointment for my car with cash.',
            'It\'s a 2017 Ford Focus and my name is David Lee.',
            'My email is david.lee at example dot com.',
            'Can I get an appointment for next Wednesday at 2pm?',
            'Thanks again for your help!'
        ]
    },
];

// ─── Mocks ────────────────────────────────────────────────────────────────────

class MockWebSocket extends EventEmitter {
    send(_data: unknown): void { /* no-op */ }
}

class MockStream extends EventEmitter {
    name:    string;
    writable = true;
    destroyed = false;
    private onWrite?: (text: string) => void;

    constructor(name: string, onWrite?: (text: string) => void) {
        super();
        this.name    = name;
        this.onWrite = onWrite;
    }

    write(data: unknown): void {
        if (this.name === 'TTS') {
            const d = data as { input?: { text?: string } };
            if (d?.input?.text && this.onWrite) this.onWrite(d.input.text);
        }
    }

    end(): void    { this.emit('finish'); }
    destroy(): void { this.destroyed = true; this.emit('close'); }
}

// ─── Test Runner ──────────────────────────────────────────────────────────────

interface TestResult {
    name:            string;
    goal:            string;
    steps:           string[];
    transcript:      string[];
    allVariables:    Record<string, string | undefined>;
    validationResult: string;
    didPass:         boolean;
}

function writeTest(results: TestResult[]): void {
    let str = `Full Test Report (${new Date().toISOString()})\n\n`;

    for (const test of results) {
        str += `Test: ${test.name}\n`;
        str += `Goal: ${test.goal}\n`;
        str += '---------------------------------------------------\n';
        str += test.transcript.join('\n');
        str += '\n\nExtracted Variables:\n';
        str += JSON.stringify(test.allVariables, null, 2);
        str += '\n\n';
        str += test.didPass ? 'PASS' : 'FAIL';
        str += '\n\nReasoning: ' + test.validationResult;
        str += '\n\n';
    }

    fs.writeFileSync('test_report.txt', str);
}

async function runASingleTest(test: typeof testCases[number]): Promise<TestResult> {
    return new Promise(async (resolve) => {
        console.log(`\x1b[35mStarting Test: ${test.name}\x1b[0m`);

        const localTranscript: string[] = [];

        const mockWs = new MockWebSocket();
        const callId = `test-${Date.now() + Math.floor(Math.random() * 10000)}`;
        const call   = new Call(callId, '+15550001234', QUATTRO_AUTOBODY_CONFIG, 'test-uuid');

        // Mock audio methods
        (call as any).sendAudioChunk = function (_chunk: string) {};
        (call as any).sendClear      = function () {};

        // Override voice methods on the voices instance
        call.voices.startGoogleSpeechStream = function () {};
        call.voices.stopGoogleSpeechStream  = function () {};
        call.voices.setupGoogleTTSStream    = function () {
            const stream = new MockStream('TTS', (text: string) => {
                localTranscript.push(`AI: ${text}`);
            });
            this.ttsStream = stream as any;
            return stream as any;
        };

        await call.initializationPromise;
        await call.setWebsocket(mockWs as any, 'test-stream-sid');

        // Initial delay for greeting
        await new Promise(r => setTimeout(r, 1000));

        console.log('Full test object', test);
        console.log('These are the steps right now:', test.steps);

        for (const userStep of test.steps) {
            while (
                localTranscript.length > 0 &&
                (localTranscript[localTranscript.length - 1].startsWith('User:') ||
                    (localTranscript[localTranscript.length - 1].startsWith('AI:') &&
                        (localTranscript[localTranscript.length - 1].toLowerCase().includes('give me one second') ||
                            localTranscript[localTranscript.length - 1].toLowerCase().includes('let me see'))))
            ) {
                await new Promise(r => setTimeout(r, 200));
            }

            localTranscript.push(`User: ${userStep}`);

            try {
                await call.processLLM(userStep);
            } catch (e) {
                console.error(`Error during step in test '${test.name}':`, e);
            }
        }

        console.log(`\x1b[90mTest finished: ${test.name}. Validating...\x1b[0m`);

        // Build variables summary from collectedData
        const allVariables: Record<string, string | undefined> = {};
        for (const field of call.executor.getAllFields()) {
            allVariables[field.key] = call.collectedData[field.key];
        }

        const validationResult = await validateConversation(test.goal, localTranscript, allVariables);

        console.log(`\x1b[1mResult (${test.name}): ${validationResult.pass ? '\x1b[32mPASS' : '\x1b[31mFAIL'}\x1b[0m`);

        resolve({
            name:            test.name,
            goal:            test.goal,
            steps:           test.steps,
            transcript:      localTranscript,
            allVariables,
            validationResult: validationResult.reasoning,
            didPass:         validationResult.pass,
        });
    });
}

async function runTests(): Promise<void> {
    console.log('\x1b[33m--- Starting Parallel Automated Tests ---\x1b[0m\n');

    try {
        const results: TestResult[] = [];
        for (let i = 0; i < testCases.length; i++) {
            try {
                console.log('This is the initial test we are passing in', testCases[i]);
                const result = await runASingleTest(testCases[i]);
                results.push(result);
                await new Promise(r => setTimeout(r, 1000));
            } catch (e) {
                console.log('There was an error for some reason', e);
            }
        }

        console.log('\n\x1b[33m--- All Tests Completed ---\x1b[0m');
        writeTest(results);
        console.log('Report saved to test_report.txt');
    } catch (err) {
        console.error('Error running tests:', err);
    }
}

async function validateConversation(
    goal: string,
    transcript: string[],
    allVariables: Record<string, string | undefined>,
): Promise<{ pass: boolean; reasoning: string }> {
    const validationModel = genAI.getGenerativeModel({ model: VALIDATION_MODEL });
    const prompt = `
    You are a QA Tester for an AI Receptionist.

    GOAL: ${goal}

    Note: Make sure the responses make sense given the context of the conversation. Every single response should make sense given prior messages as well as helps in the overall flow of the conversation.

    TRANSCRIPT:
    ${transcript.join('\n')}

    EXTRACTED VARIABLES:
    ${JSON.stringify(allVariables, null, 2)}

    INSTRUCTIONS:
    1. Read the transcript.
    2. Determine if the AI met the GOAL.
    3. Return a JSON object: { "pass": boolean, "reasoning": "string" }
    `;

    try {
        const result   = await validationModel.generateContent(prompt);
        const response = result.response;
        let text       = response.text();
        text           = text.replace(/```json/g, '').replace(/```/g, '').trim();
        return JSON.parse(text) as { pass: boolean; reasoning: string };
    } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return { pass: false, reasoning: `Validation Error: ${msg}` };
    }
}

// ─── Entry Point ──────────────────────────────────────────────────────────────

if (process.argv.includes('--interactive')) {
    console.log('Interactive mode not implemented in this version. Run without arguments for tests.');
} else {
    runTests().catch(err => console.error(err));
}
