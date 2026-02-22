require("dotenv").config();
// const { getAvailability } = require("./calendly");
const fs = require("fs");

// Import Services
const Voices = require("./Voices");
const ToolCall = require("./ToolCall");
const BrainService = require("./call_brain");

// Twilio Setup
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

        // State
        this.availableSlots = [];
        this.timeWhenUserHasFinishedSpeaking = 0n;
        this.listOfWaitTimes = [];
        this.currentlyCheckingAvailability = false;
        this.confirmationStatus = "NOT_READY";
        this.appointmentTimeValidated = false;
        this.pendingTimeCheck = null;
        this.alreadySending = false;
        this.streamSid = "";
        this.ws = null;
        this.messageNumber = 0;
        this.aiTalking = false;
        this.userSpeaking = false;
        this.speechTimeout = null;
        this.sendingAudio = false;
        this.twilioPlaying = false;
        this.playbackTimeout = null;
        this.interrupted = false;
        this.estimatedPlaybackEnd = 0;
        this.shouldHangup = false;
        this.isTransferring = false;
        this.transferNumber = "301-272-7224";
        this.hasScheduledAppointment = false;
        this.noStart = false;

        // Appointment Fields
        this.customerName = null;
        this.vehicleModel = null;
        this.customerEmail = null;
        this.paymentMethod = null;
        this.appointmentTime = null;

        // Initialize Services
        this.voices = new Voices(this);
        this.tools = new ToolCall(this);
        this.brain = new BrainService(this);

        this.initializationPromise = this.brain.init();
    }

    static async create(callSid, phoneNumber, agentAction, agentLocation, agentName, uuid) {
        const instance = new Call(callSid, phoneNumber, agentAction, agentLocation, agentName, uuid);
        return instance;
    }

    async setWebsocket(ws, streamSid) {
        this.ws = ws;
        if (!this.noStart) {
            this.streamSid = streamSid;
            console.log(`[${this.callSid}] Twilio stream started (${this.streamSid}).`);
            this.voices.startGoogleSpeechStream();
            this.startConversation();
            this.noStart = true;
        }

        this.ws.on("message", (message) => {
            const msg = JSON.parse(message);
            switch (msg.event) {
                case "media":
                    if (this.voices.googleSpeechStream && this.voices.googleSpeechStream.writable) {
                        this.voices.googleSpeechStream.write(msg.media.payload);
                        this.userSpeaking = true;
                        if (this.speechTimeout) clearTimeout(this.speechTimeout);
                        this.speechTimeout = setTimeout(() => {
                            if (this.userSpeaking) {
                                console.log(`[${this.callSid}] Silence detected.`);
                                this.userSpeaking = false;
                                if (!this.sendingAudio) this.voices.stopGoogleSpeechStream();
                            }
                        }, 500);
                    }
                    break;
                case "stop":
                    this.hangup();
                    break;
            }
        });
    }

    async startConversation() {
        this.aiTalking = true;
        const initialResponseJSON = {
            thought: "Initial greeting.",
            conversation_state: "gathering_data",
            response: `Hi this is ${this.businessName} how may we help you today?`,
            rating: 5,
            hangup: false,
            action: "respond"
        };

        try {
            const stream = this.voices.setupGoogleTTSStream();
            stream.write({ input: { text: initialResponseJSON.response } });
            stream.end();
            this.processResponse(JSON.stringify(initialResponseJSON));
        } catch (e) {
            console.error(`[${this.callSid}] Error in startConversation:`, e);
        }
    }

    async processLLM(transcript) {
        return this.brain.processLLM(transcript);
    }



    async processResponse(geminiResponse) {
        try {
            const cleanJson = geminiResponse.replace(/```json\s*/g, "").replace(/```/g, "").trim();
            const fedToTwilio = JSON.parse(cleanJson);

            if (!fedToTwilio.response || fedToTwilio.response.trim() === "") {
                this.aiTalking = false;
                this.voices.startGoogleSpeechStream();
                return;
            }

            this.rating = fedToTwilio.rating;

            // Handle Actions
            if (fedToTwilio.action === "transfer") {
                this.isTransferring = true;
                return;
            }



            if (fedToTwilio.action === "check_availability") {
                this.currentlyCheckingAvailability = true;

                // Stop Gemini TTS stream first to prevent voice overlap with canned response
                if (this.voices.ttsStream && !this.voices.ttsStream.destroyed) {
                    this.voices.ttsStream.destroy();
                    this.voices.ttsStream = null;
                }
                this.sendClear();

                // --- CANNED RESPONSE ---
                const cannedResponse = "Give me one second to check the calendar for you.";
                const stream = this.voices.setupGoogleTTSStream();
                stream.write({ input: { text: cannedResponse } });
                stream.end();

                // const today = new Date();
                const availability = await this.tools.getAvailability();


                // console.log("This is week one", weekOne)
                // console.log("This is week two", weekTwo)
                // console.log("This is week three", weekThree)
                // console.log("This is week four", weekFour)
                // const totalAvailability = weekOne.concat(weekTwo).concat(weekThree).concat(weekFour)
                const systemMessage = `System Update: Available slots: ${JSON.stringify(availability)}. Offer options.`;
                this.currentlyCheckingAvailability = false;
                await this.processLLM(systemMessage);
                return;
            }

            if (fedToTwilio.action === "check_if_time_is_valid") {
                const timeToCheck = fedToTwilio.appointmentTime || this.appointmentTime;

                // Stop Gemini TTS stream first to prevent voice overlap with canned response
                if (this.voices.ttsStream && !this.voices.ttsStream.destroyed) {
                    this.voices.ttsStream.destroy();
                    this.voices.ttsStream = null;
                }
                this.sendClear();

                // --- CANNED RESPONSE ---
                const cannedResponse = "Let me see if that time is open for you.";
                const stream = this.voices.setupGoogleTTSStream();
                stream.write({ input: { text: cannedResponse } });
                stream.end();

                const { isValid, formattedTime } = this.tools.validateTimeSlot(timeToCheck, true);
                if (isValid) {
                    this.appointmentTime = formattedTime;
                    this.appointmentTimeValidated = true;
                    await this.processLLM("System: The requested time IS available. Proceed to confirmation.");
                } else {
                    await this.processLLM("System: The requested time is NOT available. Offer alternatives.");
                }
                return;
            }

            if (fedToTwilio.action === "schedule_appointment") {
                if (this.customerName && this.vehicleModel && this.customerEmail && this.appointmentTime && this.confirmationStatus !== "NOT_READY") {
                    const result = await this.tools.handleAppointment({
                        customerName: this.customerName,
                        vehicleModel: this.vehicleModel,
                        customerEmail: this.customerEmail,
                        paymentMethod: this.paymentMethod,
                        appointmentTime: this.appointmentTime
                    });
                    console.log("we are scheduling an appointment right now")
                    await this.processLLM(`System Update: Appointment result: ${result}`);
                    return;
                } else {
                    console.log("We tried scheduling an appointment here")
                }
            }

            if (fedToTwilio.hangup) {
                this.shouldHangup = true;
            } else {
                this.aiTalking = false;
                this.voices.startGoogleSpeechStream();
            }
        } catch (e) {
            console.error(`[${this.callSid}] Error in processResponse:`, e);
            this.aiTalking = false;
            this.voices.startGoogleSpeechStream();
        }
    }

    calculatePlayback(len, rate) { return len / rate; }

    sendAudioChunk(chunk) {
        if (this.interrupted || !this.ws) return;
        this.ws.send(JSON.stringify({
            event: "media",
            streamSid: this.streamSid,
            media: { payload: chunk }
        }));
    }

    sendClear() {
        if (this.ws) {
            if (this.playbackTimeout) {
                clearTimeout(this.playbackTimeout);
                this.playbackTimeout = null;
            }
            this.ws.send(JSON.stringify({ event: "clear", streamSid: this.streamSid }));
        }
    }

    async transferCall() {
        console.log(`[${this.callSid}] Transferring call to ${this.transferNumber}`);

        this.sendClear();

        this.isTransferring = true;

        try {
            await client.calls(this.callSid).update({
                twiml: `<Response><Dial>${this.transferNumber}</Dial></Response>`
            });
            console.log(`[${this.callSid}] Call transferred successfully.`);
        } catch (e) {
            console.error(`[${this.callSid}] Error transferring call: `, error);
            this.isTransferring = false; // Reset flag on error so we can hangup if needed

        }
        // Twilio transfer logic here...
    }

    logAllMeaningfulStats() {
        console.log(`[${this.callSid}] Stats: Name=${this.customerName}, Email=${this.customerEmail}, Time=${this.appointmentTime}`);
    }

    async hangup() {
        console.log(`[${this.callSid}] Hanging up.`);
        this.voices.stopGoogleSpeechStream();
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        if (this.isTransferring) return;
        try {
            await client.calls(this.callSid).update({ status: "completed" });
        } catch (e) {
            console.log("There was an error when attemtping to hangup:", e)
        }
    }
}

module.exports = Call;