import "dotenv/config";
import twilio from "twilio";
import type WebSocket from "ws";
import type { BookingConfig, ToolConfig } from "./types/index";

import Voices from "./Voices";
import ToolCall from "./ToolCall";
import WorkflowExecutor from "./WorkflowExecutor";
import BrainService from "./BrainService";
import type { AgentConfig } from "./types/index";

const accountSid = process.env.TWILIO_ACCOUNT_SID ?? "";
const authToken = process.env.TWILIO_AUTH_TOKEN ?? "";
const twilioClient = twilio(accountSid, authToken);

export class Call {
  uuid: string;
  callSid: string;
  phoneNumber: string;
  config: AgentConfig;

  // Collected data — all field values live here
  collectedData: Record<string, string>;

  // State flags
  availableSlots: string[];
  timeWhenUserHasFinishedSpeaking: bigint;
  listOfWaitTimes: bigint[];
  currentlyCheckingAvailability: boolean;
  confirmationStatus: string;
  // appointmentTimeValidated: boolean;
  alreadySending: boolean;
  streamSid: string;
  ws: WebSocket | null;
  messageNumber: number;
  aiTalking: boolean;
  userSpeaking: boolean;
  speechTimeout: ReturnType<typeof setTimeout> | null;
  sendingAudio: boolean;
  twilioPlaying: boolean;
  playbackTimeout: ReturnType<typeof setTimeout> | null;
  interrupted: boolean;
  estimatedPlaybackEnd: number;
  shouldHangup: boolean;
  isTransferring: boolean;
  hasScheduledAppointment: boolean;
  sendingBackgroundAudio: boolean;
  noStart: boolean;
  callingTool: boolean;
  toolCalled: BookingConfig | ToolConfig | null;
  workflowReadyToBook: boolean;
  transferTarget?: string;

  // Services
  voices: Voices;
  executor: WorkflowExecutor;
  tools: ToolCall;
  brain: BrainService;

  initializationPromise: Promise<void>;

  constructor(
    callSid: string,
    phoneNumber: string,
    config: AgentConfig,
    uuid: string,
  ) {
    this.uuid = uuid;
    this.callSid = callSid;
    this.phoneNumber = phoneNumber;
    this.config = config;

    // Generic collected data map
    this.collectedData = {};

    // State
    this.availableSlots = [];
    this.timeWhenUserHasFinishedSpeaking = 0n;
    this.listOfWaitTimes = [];
    this.currentlyCheckingAvailability = false;
    this.confirmationStatus = "NOT_READY";
    // this.appointmentTimeValidated = false;
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
    this.hasScheduledAppointment = false;
    this.sendingBackgroundAudio = false;
    this.noStart = false;
    this.callingTool = false;
    this.toolCalled = null;
    this.workflowReadyToBook = false;

    // Services — executor must be created before brain (brain reads it)
    this.voices = new Voices(this);
    this.executor = new WorkflowExecutor(this);
    this.tools = new ToolCall(this);
    this.brain = new BrainService(this);

    this.initializationPromise = this.brain.init();
  }

  static async create(
    callSid: string,
    phoneNumber: string,
    config: AgentConfig,
    uuid: string = "inbound",
  ): Promise<Call> {
    return new Call(callSid, phoneNumber, config, uuid);
  }

  async setWebsocket(ws: WebSocket, streamSid: string): Promise<void> {
    this.ws = ws;
    if (!this.noStart) {
      this.streamSid = streamSid;
      console.log(
        `[${this.callSid}] Twilio stream started (${this.streamSid}).`,
      );
      this.startConversation();
      this.noStart = true;
    }

    ws.on("message", (message: Buffer | string) => {
      const msg = JSON.parse(message.toString()) as {
        event: string;
        media?: { payload: string };
        streamSid?: string;
      };
      switch (msg.event) {
        case "media":
          if (this.voices.googleSpeechStream?.writable && !this.voices.googleSpeechStream.destroyed) {
            this.voices.googleSpeechStream.write(msg.media!.payload);
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
          void this.hangup();
          break;
      }
    });
  }

  startConversation(): void {
    this.aiTalking = true;
    try {
      // Run immediate steps (speaks greeting and processes leading say/branch steps).
      // Then ensure STT is active for the first collect/llm step.
      void this.executor.runImmediateSteps(this.collectedData);
      this.voices.startGoogleSpeechStream();
    } catch (e) {
      console.error(`[${this.callSid}] Error in startConversation:`, e);
    }
  }

  async processLLM(transcript: string): Promise<void> {
    return this.brain.processLLM(transcript);
  }

  async processResponse(geminiResponse: string): Promise<void> {
    try {
      const cleanJson = geminiResponse
        .replace(/```json\s*/g, "")
        .replace(/```/g, "")
        .trim();
      const fedToTwilio = JSON.parse(cleanJson) as {
        response?: string;
        action?: string;
        hangup?: boolean;
        appointmentTime?: string;
        rating?: number;
      };

      if (!fedToTwilio.response || fedToTwilio.response.trim() === "") {
        this.aiTalking = false;
        this.voices.startGoogleSpeechStream();
        return;
      }

      if (fedToTwilio.action === "transfer") {
        this.isTransferring = true;
        return;
      }

      if (fedToTwilio.action === "check_if_time_is_valid") {
        if (this.availableSlots.length === 0) {
          fedToTwilio.action = "check_availability";
          // Fall through to check_availability below
        } else {
          const apptKey = this.executor
            .getAllFields()
            .find((f) => f.type === "appointment_time")?.key;
          const timeToCheck =
            fedToTwilio.appointmentTime ??
            (apptKey ? this.collectedData[apptKey] : undefined);

          if (this.voices.ttsStream && !this.voices.ttsStream.destroyed) {
            this.voices.ttsStream.destroy();
            this.voices.ttsStream = null;
          }
          this.sendClear();

          const cannedStream = this.voices.setupGoogleTTSStream();
          cannedStream.write({
            input: { text: "Let me see if that time is open for you." },
          });
          cannedStream.end();

          if (timeToCheck) {
            const { isValid, formattedTime } =
              this.tools.validateTimeSlot(timeToCheck);
            if (isValid && formattedTime) {
              if (apptKey) this.collectedData[apptKey] = formattedTime;
              // this.appointmentTimeValidated = true;
              await this.processLLM(
                "System: The requested time IS available. Proceed to confirmation.",
              );
            } else {
              await this.processLLM(
                "System: The requested time is NOT available. Offer alternatives.",
              );
            }
          } else {
            await this.processLLM(
              "System: No appointment time found. Ask the user for a time.",
            );
          }
          return;
        }
      }

      if (fedToTwilio.action === "check_availability") {
        if (!this.config.booking) {
          // Just change it here because it doesn't matter anyway

          console.log("Booking doesn't work here.");
          fedToTwilio.action = "respond";
          await this.processLLM("System: Give anytime is available between company hours of " + this.config.businessHours)
          // This means it doesn't exist

          // Lets just make the readable slots times of the next hour or so

          // for (let i=0; i<100; i++) {
          //   // Lets make 30 minute slots just as filler data for now i guess

          // }

          // // this.availableSlots =

          // return;
        } else {
          this.currentlyCheckingAvailability = true;

          if (this.voices.ttsStream && !this.voices.ttsStream.destroyed) {
            this.voices.ttsStream.destroy();
            this.voices.ttsStream = null;
          }
          this.sendClear();

          // const cannedStream = this.voices.setupGoogleTTSStream();
          // cannedStream.write({
          //   input: {
          //     text: "Give me one second to check the calendar for you.",
          //   },
          // });
          // cannedStream.end();

          const availability = await this.tools.getAvailability();
          this.availableSlots = availability;

          const tz = this.config.timezone ?? "America/New_York";
          const readableSlots = availability.map((slot) => {
            const estDisplay = new Date(slot).toLocaleString("en-US", {
              weekday: "short",
              month: "short",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
              hour12: true,
              timeZone: tz,
            });
            return `${estDisplay} EST [${slot}]`;
          });

          const systemMessage =
            `System Update: Available appointment slots. Present the user ONLY the EST time shown before each bracket. ` +
            `When the user selects a slot, copy the bracketed UTC string EXACTLY (unchanged) into appointmentTime — ` +
            `do NOT retype or modify it. At max, offer three items at a time. DO NOT just list all of the times. Only offer times from this list:\n${readableSlots.join("\n")}`;

          this.currentlyCheckingAvailability = false;
          await this.processLLM(systemMessage);
          return;
        }
      }

      if (fedToTwilio.action === "schedule_appointment") {
        if (!this.config.booking) {
          // Just change it here because it doesn't matter anyway

          console.log("Booking doesn't work here.");
          fedToTwilio.action = "respond";

          // This means it doesn't exist

          // Lets just make the readable slots times of the next hour or so

          // for (let i=0; i<100; i++) {
          //   // Lets make 30 minute slots just as filler data for now i guess

          // }

          // // this.availableSlots =

          // return;
        } else {
          const missingFields = this.brain.getMissingFields(this.collectedData);
          if (
            missingFields.length === 0 &&
            this.confirmationStatus !== "NOT_READY" &&
            !this.hasScheduledAppointment &&
            this.workflowReadyToBook
          ) {
            this.sendClear();
            this.voices.ttsStream?.end();
            this.voices.ttsStream?.destroy();

            

            this.toolCalled = this.config.booking ?? null;
            this.callingTool = true;
            const result = await this.tools.handleAppointment(
              this.collectedData,
            );
            console.log("Scheduling appointment now");
            this.callingTool = false;

            if (!result.startsWith("STATUS: SUCCESS")) {
              // Failure — LLM communicates what went wrong and offers alternatives.
              await this.processLLM(
                `System Update: Appointment result: ${result}`,
              );
            }
            // Success — the outer processLLM's runImmediateSteps will advance
            // past the book step and fire the workflow hangup/transfer sayBefore.
            return;
          } else if (
            this.confirmationStatus !== "NOT_READY" &&
            this.hasScheduledAppointment &&
            missingFields.length === 0
          ) {
            await this.brain.updateAgentWithoutTriggeringResponse(
              `System Update: The user has already booked an appointment. That can no longer book anymore appointments during this call.`,
            );
            return;
          } else {
            console.log(
              "Tried scheduling but fields still missing or not confirmed:",
              missingFields,
            );
          }
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

  calculatePlayback(len: number, rate: number): number {
    return len / rate;
  }

  sendAudioChunk(chunk: string): void {
    if (this.interrupted || !this.ws) return;
    this.ws.send(
      JSON.stringify({
        event: "media",
        streamSid: this.streamSid,
        media: { payload: chunk },
      }),
    );
  }

  sendClear(): void {
    if (this.ws) {
      if (this.playbackTimeout) {
        clearTimeout(this.playbackTimeout);
        this.playbackTimeout = null;
      }
      this.ws.send(
        JSON.stringify({ event: "clear", streamSid: this.streamSid }),
      );
    }
  }

  async transferCall(): Promise<void> {
    const targetNumber = this.transferTarget ?? this.config.transferNumber;
    console.log(`[${this.callSid}] Transferring call to ${targetNumber}`);
    this.sendClear();
    this.isTransferring = true;

    try {
      await twilioClient.calls(this.callSid).update({
        twiml: `<Response><Dial>${targetNumber}</Dial></Response>`,
      });
      console.log(`[${this.callSid}] Call transferred successfully.`);
    } catch (e) {
      console.error(`[${this.callSid}] Error transferring call:`, e);
      this.isTransferring = false;
    }
  }

  logAllMeaningfulStats(): void {
    console.log(`[${this.callSid}] Stats:`, JSON.stringify(this.collectedData));
  }

  async hangup(): Promise<void> {
    console.log(`[${this.callSid}] Hanging up.`);
    this.voices.stopGoogleSpeechStream();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    if (this.isTransferring) return;
    try {
      await twilioClient.calls(this.callSid).update({ status: "completed" });
    } catch (e) {
      console.log("Error hanging up:", e);
    }
  }
}

export default Call;
