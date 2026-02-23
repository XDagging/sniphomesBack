import { fromZonedTime } from 'date-fns-tz';
import { getAvailability, scheduleAppointment } from './Calendly';
import type { Call } from './Call';
import type { CalendlySchedulePayload } from './types/index';

export class ToolCall {
  private call:    Call;
  private callSid: string;

  constructor(parentCall: Call) {
    this.call    = parentCall;
    this.callSid = parentCall.callSid;
  }

  // Convert a UTC ISO string to a normalised UTC ISO string (no-op normalisation).
  convertUtcToEst(utcDateString: string): string {
    if (!utcDateString) throw new Error('Empty date string provided to convertUtcToEst');
    const cleanIso = utcDateString.replace('Z', '');
    const utcDate  = fromZonedTime(cleanIso, 'UTC');
    return utcDate.toISOString();
  }

  // Convert an EST local datetime string (no Z suffix) to a real UTC ISO string.
  convertEstToRealUtc(estDateString: string): string {
    if (!estDateString) return '';
    const cleanIso = estDateString.replace('Z', '');
    const utcDate  = fromZonedTime(cleanIso, 'America/New_York');
    return utcDate.toISOString();
  }

  validateTimeSlot(inputTime: string): { isValid: boolean; formattedTime: string | null } {
    if (!this.call.availableSlots || this.call.availableSlots.length === 0) {
      console.error(`[${this.callSid}] Validation Failed: NO AVAILABLE SLOTS loaded.`);
      return { isValid: false, formattedTime: null };
    }

    try {
      // Primary: exact string match.
      const exactMatch = this.call.availableSlots.find(slot => slot === inputTime);
      if (exactMatch) {
        console.log(`[${this.callSid}] ✅ Exact match: ${exactMatch}`);
        return { isValid: true, formattedTime: exactMatch };
      }

      // Fuzzy fallback: Z-suffix UTC strings only (handles minor formatting differences).
      if (inputTime && inputTime.endsWith('Z')) {
        const inputTs    = new Date(inputTime).getTime();
        const fuzzyMatch = this.call.availableSlots.find(
          slot => Math.abs(new Date(slot).getTime() - inputTs) < 60000,
        );
        if (fuzzyMatch) {
          console.log(`[${this.callSid}] ✅ Fuzzy UTC match: ${fuzzyMatch}`);
          return { isValid: true, formattedTime: fuzzyMatch };
        }
      }

      console.log(`[${this.callSid}] ❌ No match for "${inputTime}" in ${this.call.availableSlots.length} slots.`);
      return { isValid: false, formattedTime: null };
    } catch (e) {
      console.error(`[${this.callSid}] Validation Error:`, e);
      return { isValid: false, formattedTime: null };
    }
  }

  async handleAppointment(collectedData: Record<string, string>): Promise<string> {
    console.log(`[${this.callSid}] handleAppointment called`);
    try {
      const booking = this.call.config.booking;

      if (!booking) {
        return 'STATUS: SUCCESS. No external booking needed.';
      }

      const apptKey         = this.call.executor.getAllFields().find(f => f.type === 'appointment_time')?.key;
      const appointmentTime = apptKey ? collectedData[apptKey] : null;

      if (!appointmentTime) {
        return 'STATUS: FAILED: You must send an appointment time before continuing.';
      }

      console.log(`[${this.callSid}] Sending UTC time to Calendly: ${appointmentTime}`);

      const emailKey = booking.inviteeFieldMapping.email;
      const nameKey  = booking.inviteeFieldMapping.name;
      const phoneKey = booking.inviteeFieldMapping.phone;

      const email = collectedData[emailKey] ?? '';
      const name  = collectedData[nameKey]  ?? '';
      const phone = phoneKey
        ? (collectedData[phoneKey] ?? this.call.phoneNumber ?? '000-000-0000')
        : (this.call.phoneNumber ?? '000-000-0000');

      const questionsAndAnswers = booking.questionMapping.map(q => ({
        question: q.question,
        answer:   q.fieldKey ? (collectedData[q.fieldKey] ?? q.default ?? 'N/A') : (q.default ?? 'N/A'),
        position: q.position,
      }));

      const payload: CalendlySchedulePayload = {
        email,
        name,
        phone,
        appointmentTime,
        questionsAndAnswers,
      };

      const result = await scheduleAppointment(payload);
      console.log(`[${this.callSid}] scheduleAppointment result:`, JSON.stringify(result, null, 2));

      const r = result as { resource?: { uri?: string }; error?: string };
      if (r.resource?.uri) {
        this.call.hasScheduledAppointment = true;
        return `STATUS: SUCCESS.URI: ${r.resource.uri}`;
      }

      const errorReason = r.error ? `Error from Calendly: ${r.error}` : 'Unable to schedule.';
      this.call.sendClear();
      return `STATUS: FAILED.Reason: ${errorReason} Offer transfer to ${this.call.config.transferNumber} or new time.`;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[${this.callSid}] Scheduling error in handleAppointment:`, e);
      this.call.sendClear();
      return `STATUS: FAILED.Reason: Error scheduling (${msg}). Offer transfer to ${this.call.config.transferNumber} or new time.`;
    }
  }

  async getAvailability(): Promise<string[]> {
    try {
      const booking = this.call.config.booking;
      if (!booking) {
        console.log(`[${this.callSid}] No booking configured — no slots to fetch.`);
        return [];
      }

      const eventName = booking.eventName;
      const today     = new Date(Date.now() + 10000);

      const [weekOne, weekTwo, weekThree, weekFour] = await Promise.all([
        getAvailability(today.toISOString(), eventName),
        getAvailability(new Date(today.getTime() + 7  * 24 * 60 * 60 * 1000).toISOString(), eventName),
        getAvailability(new Date(today.getTime() + 14 * 24 * 60 * 60 * 1000).toISOString(), eventName),
        getAvailability(new Date(today.getTime() + 21 * 24 * 60 * 60 * 1000).toISOString(), eventName),
      ]);

      const slots = [...weekOne, ...weekTwo, ...weekThree, ...weekFour].map(val =>
        this.convertUtcToEst(val),
      );

      this.call.availableSlots = slots;
      return slots;
    } catch (e) {
      console.error(`[${this.callSid}] Error getting availability:`, e);
      return [];
    }
  }
}

export default ToolCall;
