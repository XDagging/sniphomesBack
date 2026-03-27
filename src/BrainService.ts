import {
  GoogleGenerativeAI,
  HarmCategory,
  HarmBlockThreshold,
  type GenerativeModel,
  type ChatSession,
} from '@google/generative-ai';
import { StreamParser } from './StreamParser';
import type { Call } from './Call';
import type { WorkflowExecutor } from './WorkflowExecutor';
import type { AgentConfig, FieldDefinition, ValidationRule } from './types/index';

// ─── Field Validation ─────────────────────────────────────────────────────────

function validateFieldValue(fieldDef: FieldDefinition, value: string): boolean {
  if (!fieldDef.validations || fieldDef.validations.length === 0) return true;

  for (const rule of fieldDef.validations) {
    switch (rule.type) {
      case 'email': {
        const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
        if (!emailRegex.test(value)) return false;
        break;
      }
      case 'noSymbols':
        if (/[^a-zA-Z\s'-.]/u.test(value)) return false;
        break;
      case 'phone':
        if (!/^[\d\s\-+()]+$/.test(value)) return false;
        break;
      case 'regex':
        if (!new RegExp((rule as ValidationRule & { pattern: string }).pattern).test(value)) return false;
        break;
      case 'minLength':
        if (value.length < (rule as ValidationRule & { value: number }).value) return false;
        break;
      case 'maxLength':
        if (value.length > (rule as ValidationRule & { value: number }).value) return false;
        break;
    }
  }
  return true;
}

// ─── BrainService ─────────────────────────────────────────────────────────────

export class BrainService {
  private call:            Call;
  private callSid:         string;
  private config:          AgentConfig;
  private executor:        WorkflowExecutor;
  private genAI:           GoogleGenerativeAI;
  private model:           GenerativeModel | null;
  private chat:            ChatSession | null;
  private isProcessingLLM: boolean;

  private safetySettings = [
    { category: HarmCategory.HARM_CATEGORY_HARASSMENT,        threshold: HarmBlockThreshold.BLOCK_NONE },
    { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,       threshold: HarmBlockThreshold.BLOCK_NONE },
    { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
    { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
  ];

  constructor(parentCall: Call) {
    this.call            = parentCall;
    this.callSid         = parentCall.callSid;
    this.config          = parentCall.config;
    this.executor        = parentCall.executor;
    this.genAI           = new GoogleGenerativeAI(process.env.GEMINI_KEY ?? '');
    this.model           = null;
    this.chat            = null;
    this.isProcessingLLM = false;

    this.initModel();
  }

  // ─── Dynamic Gemini schema ────────────────────────────────────────────────

  private buildSchema(): Record<string, unknown> {
    const fieldProperties: Record<string, unknown> = {};

    for (const field of this.executor.getAllFields()) {
      if (field.type === 'appointment_time') {
        fieldProperties[field.key] = {
          type: 'STRING',
          description:
            "The exact UTC ISO string from the bracketed portion of the available slots list — copy it character-for-character (e.g. '2026-02-22T18:00:00.000Z'). ONLY include when the user has explicitly chosen a specific slot from the list this turn. Do NOT generate, retype, or infer a time — copy the bracket string exactly.",
        };
      } else if (field.type === 'enum' && field.enumValues) {
        fieldProperties[field.key] = {
          type:        'STRING',
          enum:        field.enumValues,
          description: field.description,
        };
      } else {
        const validHints = field.validations?.map(v => v.message).join('. ') ?? '';
        fieldProperties[field.key] = {
          type:        'STRING',
          description: field.description + (validHints ? ` ${validHints}.` : ''),
        };
      }
    }

    return {
      type: 'OBJECT',
      properties: {
        thought: {
          type:        'STRING',
          description:
            'Internal reasoning. ONE sentence. Decide what to do next based on missing fields or user intent. Do NOT say "user said..." just reason.',
        },
        conversation_state: {
          type: 'STRING',
          enum: ['answering_general_question', 'gathering_data', 'confirming_details'],
          description: 'Current state of the conversation.',
        },
        extracted_data: {
          type:        'OBJECT',
          description: 'ONLY include fields if you are 100% CERTAIN. Omit if unknown.',
          properties:  fieldProperties,
        },
        response: {
          type:        'STRING',
          description: 'Text to speak to the user. Do NOT include actions here.',
        },
        rating:  { type: 'NUMBER' },
        hangup:  { type: 'BOOLEAN' },
        action:  {
          type: 'STRING',
          enum: ['respond', 'hangup', 'transfer', 'check_availability', 'check_if_time_is_valid', 'schedule_appointment'],
        },
      },
      required: ['thought', 'conversation_state', 'response', 'rating', 'hangup'],
    };
  }

  private initModel(): void {
    const modelName = this.config.geminiModel ?? 'gemini-2.5-flash-lite';

    this.model = this.genAI.getGenerativeModel({
      model: modelName,
      generationConfig: {
        temperature:      0.1,
        responseMimeType: 'application/json',
        responseSchema:   this.buildSchema() as Parameters<typeof this.genAI.getGenerativeModel>[0]['generationConfig'] extends undefined ? never : NonNullable<Parameters<typeof this.genAI.getGenerativeModel>[0]['generationConfig']>['responseSchema'],
      },
      safetySettings: this.safetySettings,
    });
  }

  async init(): Promise<void> {
    const systemPrompt = this.buildSystemPrompt();
    const greeting     = this.executor.getGreeting() ?? `Hi this is ${this.config.businessName}, how may we help you today?`;

    this.chat = this.model!.startChat({
      history: [
        { role: 'user',  parts: [{ text: systemPrompt }] },
        {
          role:  'model',
          parts: [{
            text: JSON.stringify({
              thought:            'Initial greeting.',
              conversation_state: 'gathering_data',
              response:           greeting,
              rating:             5,
              hangup:             false,
              action:             'respond',
            }),
          }],
        },
      ],
    });
  }

  // ─── Dynamic system prompt ────────────────────────────────────────────────

  private buildSystemPrompt(): string {
    const cfg = this.config;
    const tz  = cfg.timezone ?? 'America/New_York';

    const currentDateTime = new Date(Date.now()).toLocaleString('en-US', {
      timeZone:  tz,
      weekday:   'long',
      year:      'numeric',
      month:     'long',
      day:       'numeric',
      hour:      'numeric',
      minute:    '2-digit',
      hour12:    true,
    });

    const allFields    = this.executor.getAllFields();
    const nonApptFields = allFields.filter(f => f.type !== 'appointment_time');
    const collectionOrder = nonApptFields.map(f => f.label).join(' -> ');

    const validationRules = allFields
      .filter(f => f.validations && f.validations.length > 0)
      .map(f => `- **${f.label}**: ${f.validations!.map(v => v.message).join('. ')}`)
      .join('\n');

    const conditionalRules = this.executor.getConditionalRules()
      .map(({ field, condition }) => {
        if ('equals' in condition) {
          return `- **${field.label}**: Only collect if ${condition.field} is "${condition.equals}".`;
        } else if ('notEquals' in condition) {
          return `- **${field.label}**: Only collect if ${condition.field} is NOT "${condition.notEquals}".`;
        } else {
          return `- **${field.label}**: Only collect if ${condition.field} is one of [${(condition as { field: string; in: string[] }).in.join(', ')}].`;
        }
      })
      .join('\n');

    const extraRules = cfg.additionalRules?.map(r => `- ${r}`).join('\n') ?? '';

    return `
IDENTITY: You are ${cfg.agentName}, the AI Receptionist for "${cfg.businessName}".
GOAL: ${cfg.businessDescription}. Sound 100% human.

[BUSINESS RULES]
- LOCATION: ${cfg.businessLocation}.
${cfg.landmarks ? `- Nearby Landmarks: ${cfg.landmarks}` : ''}
- HOURS: ${cfg.businessHours}.
- Current Date/Time (${tz}): ${currentDateTime}
- SERVICES: ${cfg.services.join(', ')}.
${cfg.pricingPolicy ? `- PRICING: ${cfg.pricingPolicy}` : ''}
${extraRules}

[STATE MACHINE LOGIC]
1. STATE: "answering_general_question"
   - TRIGGER: User asks about price, services, location, hours, or "are you a robot?".
2. STATE: "gathering_data"
   - TRIGGER: User wants to book or gives details.
   - ORDER: ${collectionOrder}
   - **RULE**: Ask for only ONE piece of information at a time. Do not overwhelm the user.
3. STATE: "confirming_details"
   - TRIGGER: All fields are known.
   - **CRITICAL RULE**: You MUST have checked availability (action: "check_availability" or "check_if_time_is_valid") before you can confirm a time. Never confirm a time you haven't recently verified.
4. State: "schedule_appointment"
   - TRIGGER: All data filled out and user confirmed.

${validationRules ? `[FIELD VALIDATION RULES]\n${validationRules}` : ''}

${conditionalRules ? `[CONDITIONAL FIELD RULES]\n${conditionalRules}` : ''}

[HARDENED EXTRACTION RULES]
- **extracted_data**: ONLY include keys if provided this turn.
- **NO GUESSING**.
- **MISSING DATA**: OMIT the key if unknown.

[CRITICAL INSTRUCTIONS]
1. NO HALLUCINATIONS.
2. NO REPETITION.
3. INTERRUPTIONS: STOP talking.
4. NO PLACEHOLDERS.
5. **ONE QUESTION PER TURN**: Never ask for two fields in the same turn. Break it up.

[STYLE]
- Concise. Friendly. Professional.
`;
  }

  // ─── Missing fields logic ─────────────────────────────────────────────────

  getMissingFields(collectedData: Record<string, string>): string[] {
    const missing: string[] = [];
    // Use active fields (follows current branch path) instead of all fields.
    for (const field of this.executor.getActiveFields(collectedData)) {
      if (!field.required) continue;
      if (!collectedData[field.key]) missing.push(field.key);
    }
    return missing;
  }

  // ─── LLM Processing ───────────────────────────────────────────────────────

  async processLLM(transcript: string): Promise<void> {
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

    const isSystemCall = transcript.toLowerCase().includes('system');
    if (this.isProcessingLLM && !isSystemCall) {
      console.log(`[${this.callSid}] LLM already processing, ignoring: "${transcript.substring(0, 60)}"`);
      return;
    }
    if (!isSystemCall) this.isProcessingLLM = true;

    if (transcript.toLowerCase().includes('system update')) {
      console.log(`[${this.callSid}] System update detected, sending clear`);
      this.call.sendClear();
    }

    this.call.aiTalking = true;
    this.call.voices.stopGoogleSpeechStream();

    try {
      const collectedData = this.call.collectedData;
      const missingFields = this.getMissingFields(collectedData);

      const apptKey   = this.executor.getAllFields().find(f => f.type === 'appointment_time')?.key;
      const apptTime  = apptKey ? collectedData[apptKey] : null;

      const aptDisplayEst = apptTime
        ? new Date(apptTime).toLocaleString('en-US', {
            weekday:  'short',
            month:    'short',
            day:      'numeric',
            hour:     'numeric',
            minute:   '2-digit',
            hour12:   true,
            timeZone: this.config.timezone ?? 'America/New_York',
          }) + ' EST'
        : 'UNKNOWN';

      const knownDataStr = this.executor.getAllFields()
        .map(f => `${f.label}=${collectedData[f.key] ?? '?'}`)
        .join(', ');

      const stepContext = this.executor.getStepContext();

      const systemContext = `
[INTERNAL STATE]
MISSING_FIELDS: ${missingFields.length > 0 ? missingFields.join(', ') : 'NONE - Ready to Schedule'}
CURRENT_APPOINTMENT_TIME: ${aptDisplayEst}
KNOWN_DATA: ${knownDataStr}
${stepContext ? `${stepContext}\n` : ''}
[PRIORITY DECISION LOGIC]
1. **CHECK AVAILABILITY**: If user asks about times, set 'action': "check_availability".
2. **BOOKING**: If MISSING_FIELDS is "NONE - Ready to Schedule" and confirmed, set 'action': "schedule_appointment".
3. **GATHERING**: If fields missing, ask for next.
4. **CONFIRMATION**: If MISSING_FIELDS is NONE, transition to "confirming_details".
`;

      const augmentedTranscript = `${systemContext}\n\nUser says: "${transcript}"`;
      console.log(`[${this.callSid}] Augmented Transcript: \n${augmentedTranscript}`);

      const result = await this.chat!.sendMessageStream(augmentedTranscript);
      const stream = result.stream;
      const parser = new StreamParser();

      // ── Audio buffering vs. streaming ─────────────────────────────────────
      // When we're in confirmation-pending state (workflowReadyToBook +
      // PENDING_USER_APPROVAL), the next user turn will almost certainly trigger
      // schedule_appointment. We buffer audio text instead of streaming it to TTS
      // so we can discard it if a tool call fires — preventing the LLM's "Great,
      // booking now!" from playing over the booking process.
      // For all other turns we stream normally (lazy TTS, minimal latency).
      const mightSchedule =
        !isSystemCall &&
        this.call.workflowReadyToBook &&
        this.call.confirmationStatus === 'PENDING_USER_APPROVAL';

      const audioBuffer: string[] = [];
      let ttsReady   = false;
      let firstToken = true;

      for await (const chunk of stream) {

        if (this.call.callingTool && this.call.toolCalled && (this.call.toolCalled as unknown as { speakBeforeAction: boolean }).speakBeforeAction) {
          // Stop streaming — tool call is running and prefers silence.
          this.call.sendClear();
          if (ttsReady) {
            this.call.voices.ttsStream?.end();
            this.call.voices.ttsStream?.destroy();
          }
          return;
        }

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

        if (newAudioText.length > 0) {
          if (mightSchedule) {
            // Hold audio until we know the action after seeing the complete object.
            audioBuffer.push(newAudioText);
          } else {
            if (!ttsReady) {
              // Create TTS stream lazily on the first audio token so it doesn't
              // time out while waiting for Gemini to produce its first token.
              this.call.voices.ttsStream = this.call.voices.setupGoogleTTSStream();
              ttsReady = true;
            }
            console.log(`[${this.callSid}] Streaming TTS: "${newAudioText}"`);
            this.call.voices.ttsStream!.write({ input: { text: newAudioText } });
            this.call.messageNumber += 1;
          }
        }

        if (completeObject) {
          await this.processBrainResponse(completeObject, isSystemCall);

          // Flush or discard the audio buffer now that we know the action.
          if (mightSchedule && audioBuffer.length > 0) {
            // Discard if: a tool call was triggered (callingTool), OR a canned
            // response already set up its own TTS stream.
            const shouldDiscard =
              this.call.callingTool ||
              this.call.hasScheduledAppointment ||
              this.call.voices.ttsStream !== null;

            if (!shouldDiscard) {
              this.call.voices.ttsStream = this.call.voices.setupGoogleTTSStream();
              ttsReady = true;
              for (const text of audioBuffer) {
                console.log(`[${this.callSid}] Flushing buffered TTS: "${text}"`);
                this.call.voices.ttsStream!.write({ input: { text } });
                this.call.messageNumber += 1;
              }
            } else {
              console.log(`[${this.callSid}] Audio buffer discarded (tool call or canned response).`);
            }
          }
        }
      }

      if (this.call.voices.ttsStream) {
        console.log(`[${this.callSid}] Response finished, ending TTS stream.`);
        this.call.voices.ttsStream.end();
        this.call.voices.ttsStream = null;
      }

      // After a real user turn, run any remaining immediate steps
      // (e.g. after booking completes, advance past book to hangup/transfer).
      // afterTurn was already called inside processBrainResponse.
      if (!isSystemCall) {
        await this.executor.runImmediateSteps(this.call.collectedData);
      }

    } catch (e) {
      console.error(`[${this.callSid}] Error in processLLM:`, e);
      this.call.aiTalking = false;
      this.call.voices.startGoogleSpeechStream();
      if (this.call.voices.ttsStream) {
        this.call.voices.ttsStream.destroy();
        this.call.voices.ttsStream = null;
      }
    } finally {
      if (!isSystemCall) this.isProcessingLLM = false;
    }
  }

  // ─── Brain response processing ────────────────────────────────────────────

  private resetStatus = (): void => {
    if (this.call.confirmationStatus === 'PENDING_USER_APPROVAL') {
      this.call.confirmationStatus = 'NOT_READY';
      console.log(`[${this.callSid}] Data changed during confirmation — resetting to NOT_READY.`);
    }
  };

  async processBrainResponse(completeObject: Record<string, unknown>, isSystemCall = false): Promise<void> {
    const parsed = completeObject as Record<string, unknown> & {
      extracted_data?:    Record<string, string>;
      conversation_state?: string;
      action?:            string;
      appointmentTime?:   string;
    };
    let shouldUseCannedResponse = false;
    let cannedMessage           = '';

    const collectedData = this.call.collectedData;

    // ── Extract and validate each field ──────────────────────────────────────
    if (parsed.extracted_data) {
      for (const field of this.executor.getAllFields()) {
        const value = parsed.extracted_data[field.key];
        if (!value) continue;

        if (field.type === 'appointment_time') {
          


          const { isValid, formattedTime } = this.call.tools.validateTimeSlot(value);
          if (isValid && formattedTime) {
            if (formattedTime !== collectedData[field.key]) {
              collectedData[field.key] = formattedTime;
              // this.call.appointmentTimeValidated = false;
              this.resetStatus();
              console.log(`[${this.callSid}] 🟢 Time Extraction (new): ${formattedTime}`);
            }
          } else if (this.call.availableSlots.length === 0) {
            parsed.action = 'check_availability';
          }
        } else {
          if (value !== collectedData[field.key]) {
            if (validateFieldValue(field, value)) {
              collectedData[field.key] = value;
              this.resetStatus();
              console.log(`[${this.callSid}] 🟢 Extracted ${field.key}: ${value}`);
            } else {
              console.log(`[${this.callSid}] ❌ Invalid ${field.key} rejected: ${value}`);
            }
          }
        }
      }
    }

    // ── Advance workflow state eagerly (before confirmation check) ────────────
    // This ensures workflowReadyToBook is set on the same turn the last field
    // is collected, so the canned confirmation fires immediately rather than
    // letting the LLM's own response play first.
    if (!isSystemCall) {
      this.executor.afterTurn(collectedData);
      this.executor.advanceStateOnly(collectedData);
    }

    // ── Compute state ─────────────────────────────────────────────────────────
    const missingFields = this.getMissingFields(collectedData);
    const apptKey       = this.executor.getAllFields().find(f => f.type === 'appointment_time')?.key;
    const hasApptField  = !!apptKey;
    const apptTime      = apptKey ? collectedData[apptKey] : null;

    // ── Hallucination guard ───────────────────────────────────────────────────
    if (parsed.conversation_state === 'confirming_details') {
      if (missingFields.length > 0) {
        const missingFieldDef = this.executor.getAllFields().find(f => f.key === missingFields[0]);
        console.log(`[${this.callSid}] 🛑 HALLUCINATION GUARD: Missing ${missingFields.join(', ')}`);
        shouldUseCannedResponse = true;
        cannedMessage           = `I apologize, I missed your ${missingFieldDef?.label ?? missingFields[0]}. Could you please repeat it?`;
      } else {
        this.call.logAllMeaningfulStats();
      }
    }

    // ── Drive toward confirmation (only when workflow has reached book step) ──
    if (missingFields.length === 0 && this.call.confirmationStatus !== 'PENDING_USER_APPROVAL') {
      if (!this.call.workflowReadyToBook) {
        // Workflow hasn't reached the book step yet — let the LLM respond normally.
        await this.call.processResponse(JSON.stringify(parsed));
        return;
      }

      if (hasApptField && this.call.availableSlots.length === 0) {
        console.log(`[${this.callSid}] All fields present but no slots loaded. Forcing check_availability.`);
        parsed.action = 'check_availability';
      } 
      // else if (hasApptField && !this.callappointmentTimeValidated.) {
      //   console.log(`[${this.callSid}] All fields present but time not validated. Forcing check_if_time_is_valid.`);
      //   parsed.action          = 'check_if_time_is_valid';
      //   parsed.appointmentTime = apptTime ?? undefined;
      // } 
      else {
        // All ready — build dynamic confirmation message
        const apptReadable = apptTime
          ? this.parsingAppointmentTimeToReadableFormat(apptTime)
          : 'UNKNOWN';

        const spellOutFunction = (value: string): string => {
          let newString = '';
          for (let i = 0; i < value.length; i++) {
            newString += value[i];
            if (i - 1 !== value.length) newString += ' ';
          }
          return newString;
        };

        // Summarise only the active (branch-resolved) non-appointment fields.
        const activeFields = this.executor.getActiveFields(collectedData);
        const fieldSummaries = activeFields
          .filter(f => f.type !== 'appointment_time' && (f.required || collectedData[f.key]))
          .map(f => `${f.label}: ${f.spellOut ? spellOutFunction(collectedData[f.key] ?? 'UNKNOWN') : collectedData[f.key] ?? 'UNKNOWN'}`)
          .join(', ');

        cannedMessage = hasApptField
          ? `Okay, just to confirm, I have you set for an appointment on ${apptReadable}. ${fieldSummaries}. Is this all correct?`
          : `Okay, just to confirm, here's what I have: ${fieldSummaries}. Is this all correct?`;
        shouldUseCannedResponse = true;
        this.call.confirmationStatus = 'PENDING_USER_APPROVAL';

        await this.updateAgentWithoutTriggeringResponse(
          "System: User has NOT confirmed yet. I asked them to confirm details. Wait for 'Yes'.",
        );
      }
    }

    // ── Deliver canned response if needed ─────────────────────────────────────
    if (shouldUseCannedResponse) {
      if (this.call.voices.ttsStream && !this.call.voices.ttsStream.destroyed) {
        this.call.voices.ttsStream.destroy();
      }
      this.call.voices.ttsStream = null;
      this.call.sendClear();

      const cannedStream = this.call.voices.setupGoogleTTSStream();
      cannedStream.write({ input: { text: cannedMessage } });
      cannedStream.end();

      await this.updateAgentWithoutTriggeringResponse(cannedMessage);
      
      // Lets make an appointment special here, we can fix this later

      if (parsed.action === "check_availability") {
        await this.call.processResponse(JSON.stringify(parsed));
      }

      return;
    }

    await this.call.processResponse(JSON.stringify(parsed));
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  parsingAppointmentTimeToReadableFormat(appointmentTime: string): string {
    const newDate = new Date(appointmentTime).toLocaleString('en-US', {
      year:     'numeric',
      month:    'long',
      day:      'numeric',
      hour:     'numeric',
      minute:   'numeric',
      hour12:   true,
      timeZone: this.config.timezone ?? 'America/New_York',
    });
    console.log('Parsed date:', newDate);
    return newDate;
  }

  formatEmail(customerEmail: string): string {
    return customerEmail.split('').join(' ');
  }

  async updateAgentWithoutTriggeringResponse(newMessage: string): Promise<void> {
    try {
      await this.chat!.sendMessage(newMessage);
      console.log(`[${this.callSid}] History updated silently.`);
    } catch (e) {
      console.error(`[${this.callSid}] Failed to update history silently:`, e);
    }
  }
}

export default BrainService;
