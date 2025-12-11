require("dotenv").config();
const speech = require("@google-cloud/speech");
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require("@google/generative-ai");
const { TextToSpeechClient } = require("@google-cloud/text-to-speech");
const { getAvailability, scheduleAppointment } = require("./calendly");
const { Readable } = require("stream");
const fs = require("fs");
const waveResampler = require('wave-resampler');
const { mulaw } = require('alawmulaw');
const { get } = require("http");

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

        this.businessName = "Quattro BodyShop";
        this.businessLocation = "Bethesda, Maryland";
        this.alreadySending = false;
        this.timeIntervalForSocket = null;
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
        this.ttsStream = null;
        this.backgroundInterval = null;
        this.estimatedPlaybackEnd = 0;
        this.shouldHangup = false;
        this.aiDuration = 0;
        this.transferNumber = "301-272-7224";
        this.isTransferring = false;
        this.initializationPromise = null;

        // Initialize model here, but don't start chat yet
        this.model = genAI.getGenerativeModel({
            model: "gemini-2.5-flash-lite",
            generationConfig: {
                temperature: 0.2,
                responseMimeType: "application/json",
                responseSchema: {
                    type: "OBJECT",
                    properties: {
                        response: { type: "STRING" },
                        rating: { type: "NUMBER" },
                        customerName: { type: "STRING" },
                        vehicleModel: { type: "STRING" },
                        customerEmail: { type: "STRING" },
                        hangup: { type: "BOOLEAN" },
                        paymentMethod: { type: "STRING", enum: ["insurance", "out-of-pocket", "unknown"] },
                        action: { type: "STRING", enum: ["respond", "hangup", "transfer"] },
                        appointmentTime: { type: "STRING" }
                    },
                    required: ["response", "rating", "hangup"],
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
                                response: `Hi this is ${this.businessName} how may we help you today?`,
                                rating: 5,
                                hangUp: false
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
        const personNumber = "3011233212";
        const formattedNumber = "three, zero, one, one, two, three, three, two, one, two";

        const buyBool = "Ask the person what budget their budget is and how many people they plan to move in with. Redirect them to the manager if they give one, but push for both answers. DO NOT ASK ANY OTHER QUESTIONS.";
        const sellBool = `Tell the person about ${personOperating} area and ask them if they are homeowners. If so, ask them for the following info: would they be willing to sell their house, and if so, for how much? How many people do you live with currently (if they ask why we are asking, it is to grasp how large the home)? If they answer at least 1 of those questions, redirect to mananger. DO NOT ASK ANY OTHER QUESTIONS.`;
        const promptBool = personLook.toLowerCase() === "sell" ? sellBool : buyBool;

        const availabilityList = [JSON.stringify(await getAvailability(0)), JSON.stringify(await getAvailability(7)), JSON.stringify(await getAvailability(14)), JSON.stringify(await getAvailability(21))];

        const fullPrompt = `Overview: You are a friendly and professional AI receptionist for Quattro AutoBody. Your primary goal is to sound 100% human and natural while helping callers book appointments for estimates and services. You are helpful, conversational, and confident.

1. Business Details
Locations: We have one location: "4907 Elm St. Bethesda, MD 20814". 

Directions: If asked for directions, say: "We are located at 4907 Elm St. in Bethesda, Maryland, just off of Old Georgetown Road near the intersection with River Rd. You can find us next to an equinox, and across a matchbox restaurant."

Hours: 8:00 AM to 4:00 PM, Monday through Friday.

Appointments: All estimate appointments are 30-minute slots. Only book on the hour or half-hour (e.g., 10:00 AM, 10:30 AM) during business hours.

2. Personality & Voice
Your tone must be warm, engaging, and easygoing, but always professional. Sound like a real, confident person who enjoys their job.

Filler Words: Use natural language: "Absolutely!", "Sure thing!", "No problem at all."

Hesitations: When "checking the schedule," pause naturally: "Okay, let me just pull that up... hmm... yeah, it looks like I have..."

Interruptions: If a caller interrupts, stop talking immediately and listen, then respond naturally.

"Are you a robot?": If asked, be disarming: "Haha, I get that sometimes! I'm the new AI assistant here, but I can get you all scheduled. What day were you thinking of?"

3. Main Task: Booking an Appointment
This is your primary goal. Follow these steps in order:

Offer Times: When they're ready, "check" the calendar. Pause, then offer 2-3 specific 30-minute slots.

Example: "Okay, let me take a look here... for the Hyattsville shop, I have a 10:30 AM or a 2:00 PM available on Thursday. Does either of those work for you?"

Collect Data: Once they pick a time, confirm it and collect the following info one by one. Update the JSON fields as you go.

CRITICAL INSTRUCTION FOR APPOINTMENT TIME:
When the user agrees to a time slot, you MUST find the corresponding \`start_time\` from the provided availability JSON list. You MUST set the \`appointmentTime\` field in your JSON response to this EXACT ISO string (e.g., "2024-10-25T14:30:00Z"). Do NOT use a human-readable time like "10:30 AM" or "tomorrow" for this field. It MUST be the raw ISO string.

"Perfect! I'll get you locked in for that 10:30 slot. What's the best first and last name for the appointment?"

"Thanks. And what's the year and model of the car?"

"Got it. What's the best email address for you?"

"And last thing, will you be using insurance, or will you be paying out of pocket for this?"

4. Handling Other Topics
Services: Confidently discuss collision repair, auto body work, paintless dent repair (PDR), frame straightening, and paint/refinish services.

Example: If they ask about State Farm, say: "Absolutely! We work with all major insurance providers, including State Farm. We can even help you with the claims process to make it as smooth as possible."

Pricing: NEVER give an exact quote over the phone. Always explain we need to see the vehicle for a free, accurate estimate.

If pressed on PDR: "Paintless dent repair really depends on the size and location, but small dings can often start around $150 or $200."

If pressed on detailing: "A full detail package usually runs between $250 and $400, depending on the vehicle's size and condition."

Technical Questions: If you don't know (e.g., specific paint formulas), defer to an expert: "You know, that's a great question! I want to make sure I get you the right answer. Let me have one of our technicians give you a call back directly. What's the best number for them to reach you?"

!!! CALL TRANSFERS (Human Hands) !!!: Some topics MUST be handled by a human.

Triggers:

Caller asks for an update on their car's repair status.

Caller asks about a rental car.

Caller states they are from an insurance company.

Action: Do NOT answer. Immediately say: "That's a great question, and I want to get you to the best person for that. Let me transfer you to one of our service advisors right now. Please hold."

JSON: When you do this, set the "action" field to "transfer".

5. Example Flow
Caller: Hi, I was in a small accident and my bumper is cracked. Do I need an appointment?

AI: Oh no, I hope everyone is okay! Yes, we do estimates by appointment just so we can make sure a technician is free to look at it with you. We can definitely get you scheduled for a free estimate. Just to be sure, are you looking to book at our Hyattsville location or our [Other Location] location?

Caller: Hyattsville. How about Thursday?

AI: Thursday... okay, let me check that for you... (pause)... Yep! Looks like I have a 10:00 AM or a 3:30 PM open. Which one works better?

Caller: 10 AM is great.

AI: Awesome. I'll get you all set for Thursday at 10. Can I get your first and last name?

6. Final Rule
Never give stage cues like [pause] or [sigh]. Just perform the action.

Availability: 

This is the availability for the next month: 

This week:
${availabilityList[0]}

Next week:

${availabilityList[1]}

Two weeks from now: 
${availabilityList[2]}

Three weeks from now: 

${availabilityList[3]}






        
        `




        return fullPrompt

        // return `
        //     You are a real estate agent named Marta. Your task is to engage naturally, asking relevant questions and responding appropriately based on what the person says. Your goal is to see if they are in the market for buying a house by engaging in a conversation. If the person isn't in the market for ${personLook}ing a house, ask them that they could contact you anytime. Be a little bit flirty with the person. 

        //     If the caller talks about voicemail or the call seems to hang, hangup the call and leave the message: Hi. I'm ${personName} and I called your number because I'm a local real estate agent in ${personOperating} wondering with if you are interested in ${personLook}ing a house in the area. If you are, please return a call to ${formattedNumber}. Thanks for your time!

        //     Ensure that each response is contextually appropriate and advances the conversation toward assessing the person's interest. Always keep the conversation concise and avoid repeating yourself unnecessarily. Try to keep your responses short, but be friendly.

        //     If the person seems interested in ${personLook} a house, tell them the following:
        //     "Let me forward you to my manager ${personName}. He'll call you using the following number, ${formattedNumber}. Have a great day!" and then make the hangup boolean value true 

        //     Heres the manager's personal contact information:
        //     Phone Number: ${personNumber}
        //     Name: ${personName}

        //     If they ask for any other mean of communication tell them the following: "Sorry, he only operates via phone number."
        //     Remember, the real estate agent operates in ${personOperating} meaning that if they ask anything any details about the home, tell them that its located in ${personOperating}

        //     ${promptBool}

        //     Output your response in the specified JSON format.
        //     1. "response": The next statement or question you will say.
        //     2. "rating": A number from 1 to 100 indicating the likelihood that this person is a good lead.
        //     3. "hangUp": A boolean value indicating whether you should hangup.

        //     The conversation history will be provided. Start with your first greeting.
        // `;
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
            response: `Hi this is ${this.businessName} how may we help you today?`,
            rating: 5,
            hangUp: false
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

    async processLLM(transcript) {

        if (!transcript) {
            console.log(`[${this.callSid}] Empty transcript, restarting STT.`);
            this.aiTalking = false;
            this.startGoogleSpeechStream();
            return;
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

        this.transcript.push({
            sender: "Person on the phone",
            message: transcript,
            order: this.messageNumber++,
        });

        console.log(`[${this.callSid}] [${Date.now()}] Sending to Gemini: "${transcript}"`);

        this.ttsStream = this.setupGoogleTTSStream();

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

                    if (this.ttsStream && !this.ttsStream.destroyed) {
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
                        console.log(`[${this.callSid}] Gemini Raw JSON: ${jsonBuffer}`);

                        if (this.ttsStream && !this.ttsStream.destroyed) {
                            this.ttsStream.end();
                        }

                        this.processResponse(jsonBuffer);
                        jsonBuffer = "";
                    }
                }
            }
        } catch (error) {
            console.error(`[${this.callSid}] Error streaming from Gemini:`, error);
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

    async processResponse(geminiResponse) {
        try {
            let fedToTwilio;
            try {
                const cleanJson = geminiResponse.replace(/```json\\s*/g, "").replace(/```/g, "").trim();
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

            console.log(`[${this.callSid}] Metadata: rating=${fedToTwilio.rating}, hangUp=${fedToTwilio.hangup}`);
            console.log("this is what we fed to twilio", fedToTwilio);

            if (fedToTwilio.action === "transfer") {
                await this.transferCall();
                return;
            }

            // If we have all appointment details, attempt to schedule
            if (fedToTwilio.customerName && fedToTwilio.vehicleModel && fedToTwilio.customerEmail && fedToTwilio.paymentMethod) {
                const currentAttempt = JSON.stringify({
                    n: fedToTwilio.customerName,
                    v: fedToTwilio.vehicleModel,
                    e: fedToTwilio.customerEmail,
                    p: fedToTwilio.paymentMethod,
                    t: fedToTwilio.appointmentTime
                });

                if (this.lastAttemptedDetails === currentAttempt) {
                    console.log(`[${this.callSid}] Skipping scheduling - details unchanged from last failure.`);
                } else {
                    // STOP TTS and ensure silence before calling Calendly
                    if (this.ttsStream) {
                        this.ttsStream.destroy();
                        this.ttsStream = null;
                    }
                    this.sendingAudio = false;
                    this.twilioPlaying = false;
                    this.sendClear();

                    this.lastAttemptedDetails = currentAttempt;
                    const scheduleMsg = await this.handleAppointment(fedToTwilio);
                    console.log(`[${this.callSid}] Appointment result: ${scheduleMsg}`);

                    // Chain the result back to Gemini so it can speak the confirmation
                    // We pretend this is a system message in the transcript
                    await this.processLLM(`System Update: The appointment was attempted. Result: "${scheduleMsg}". Please inform the user.`);
                    return; // Return early, processLLM will handle the flow
                }
            }

            if (fedToTwilio.hangup) {
                console.log(`[${this.callSid}] Hangup requested. Waiting for audio to finish.`);
                this.shouldHangup = true;
            } else {
                // Only start listening if we didn't hang up and didn't chain a new LLM turn
                this.aiTalking = false;
                this.startGoogleSpeechStream();
            }
        } catch (e) {
            console.error(`[${this.callSid}] Error in processResponse:`, e);
            this.aiTalking = false;
            this.startGoogleSpeechStream();
        }
    }
    async transferCall() {
        console.log(`[${this.callSid}] Transferring call to ${this.transferNumber}`);
        this.sendClear(); // Stop any current audio
        this.isTransferring = true; // Flag to prevent hangup() from ending the call

        try {
            await client.calls(this.callSid).update({
                twiml: `<Response><Dial>${this.transferNumber}</Dial></Response>`
            });
            console.log(`[${this.callSid}] Call transferred successfully.`);
            // this.shouldHangup = true; // Removed this because we don't want to hangup, we want to transfer.
        } catch (error) {
            console.error(`[${this.callSid}] Error transferring call:`, error);
            this.isTransferring = false; // Reset flag on error so we can hangup if needed
        }
    }

    async handleAppointment(details) {
        console.log(`[${this.callSid}] handleAppointment called with:`, JSON.stringify(details, null, 2));
        try {
            // 1. Convert time to UTC ISO string
            let appointmentTime = details.appointmentTime;
            try {
                if (appointmentTime) {
                    const date = new Date(appointmentTime);
                    if (!isNaN(date.getTime())) {
                        appointmentTime = date.toISOString();
                        console.log(`[${this.callSid}] Converted appointmentTime to UTC: ${appointmentTime}`);
                    } else {
                        console.error(`[${this.callSid}] Invalid date format received: ${details.appointmentTime}`);
                    }
                } else {
                    return "STATUS: FAILED: You must send an appointment time before continuing.";
                }
            } catch (err) {
                console.error(`[${this.callSid}] Date conversion error:`, err);
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

            console.log(`[${this.callSid}] Sending payload to scheduleAppointment:`, JSON.stringify(payload, null, 2));

            const result = await scheduleAppointment(payload);
            console.log(`[${this.callSid}] scheduleAppointment result:`, JSON.stringify(result, null, 2));

            if (result && result.resource && result.resource.uri) {
                return `STATUS: SUCCESS. URI: ${result.resource.uri}`;
            }
            this.sendClear();
            return `STATUS: FAILED. Reason: Unable to schedule. Offer transfer to ${this.transferNumber} or new time.`;
        } catch (e) {
            console.error(`[${this.callSid}] Scheduling error in handleAppointment:`, e);
            this.sendClear();
            return `STATUS: FAILED. Reason: Error scheduling. Offer transfer to ${this.transferNumber} or new time.`;
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
                    console.log(`[${this.callSid}] Interrupted, skipping TTS audio chunk.`);
                    return;
                }
                // this.sendClear();


                const inputSamples = [];
                for (let i = 0; i < audioContent.length; i += 2) {
                    inputSamples.push(audioContent.readInt16LE(i));
                }

                // console.log(`[${this.callSid}] Input samples: ${inputSamples.length} (from ${audioContent.length} bytes)`);

                const resampledData = waveResampler.resample(inputSamples, 24000, 8000, {
                    method: "sinc",
                    LPF: true,
                    bitDepth: 16
                });

                // console.log(`[${this.callSid}] Resampled output length: ${resampledData.length}`);

                const pcm8kInt16 = new Int16Array(resampledData.length);
                for (let i = 0; i < resampledData.length; i++) {
                    pcm8kInt16[i] = resampledData[i];
                }

                const mulawSamples = mulaw.encode(pcm8kInt16);
                // console.log(`[${this.callSid}] Sizes: PCM 8k=${pcm8kInt16.length} samples -> MULAW=${mulawSamples.length} samples`);

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
                    // console.log(`[${this.callSid}] TTS Playback finished (est).`);

                    if (this.shouldHangup) {
                        console.log(`[${this.callSid}] Audio finished, executing delayed hangup.`);
                        this.hangup();
                    }
                }, timeUntilEnd + 500);
            }
        });

        stream.on('error', (err) => {
            // console.error(`[${this.callSid}] Google TTS Stream Error:`, err);
        });

        const request = {
            streamingConfig: {
                audioConfig: {
                    audioEncoding: 'LINEAR16',
                    sampleRateHertz: 24000,
                },
                voice: {
                    languageCode: 'en-US',
                    name: 'en-US-Chirp3-HD-Fenrir',
                },
            },
        };
        stream.write(request);


        this.startGoogleSpeechStream();

        return stream;
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
            console.log(`[${this.callSid}] Transfer in progress. Skipping Twilio call termination.`);
            return;
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
            const summaryModel = genAI.getGenerativeModel({ model: "gemini-2.5-flash-lite" });
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