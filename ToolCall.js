const { getAvailability, scheduleAppointment } = require("./calendly");
const { fromZonedTime } = require('date-fns-tz');

class ToolCall {
    constructor(parentCall) {
        this.call = parentCall;
        this.callSid = parentCall.callSid;
    }

    // parsingAppointmentTimeToReadableFormat(appointmentTime) {
    //     const newDate = new Date(appointmentTime).toLocaleString("en-US", {
    //         year: "numeric",
    //         month: "long",
    //         day: "numeric",
    //         hour: "numeric",
    //         minute: "numeric",
    //         hour12: true,
    //         timeZone: "America/New_York",
    //     });
    //     console.log(`[${this.callSid}] Parsed date: ${newDate}`);
    //     return newDate;
    // }

    convertEstToRealUtc(estDateString) {
        if (estDateString && estDateString.length > 0) {
            const cleanIso = estDateString.replace('Z', '');
            const utcDate = fromZonedTime(cleanIso, 'America/New_York');
            return utcDate.toISOString();
        }
        return "";
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
    parsingAppointmentTimeToReadableFormat(appointmentTime) {
        // Appointment time is in UNIX format (seconds since epoch)
        // 2026-01-29T14:30:00.000Z

        const newDate = new Date(appointmentTime).toLocaleString("en-US", {
            year: "numeric",
            month: "long",
            day: "numeric",
            hour: "numeric",
            minute: "numeric",
            hour12: true,
            timeZone: "America/New_York",
        });

        console.log("This is the parsed date", newDate);

        return newDate;
    }

    async checkValid(fedToTwilio) {
        try {
            console.log(`[${this.callSid}] --- checkValid ---`);
            console.log(`[${this.callSid}] Input: ${fedToTwilio.appointmentTime}`);

            const isDirectMatch = this.call.availableSlots.some(slot => {
                return slot === fedToTwilio.appointmentTime ||
                    new Date(slot).getTime() === new Date(fedToTwilio.appointmentTime).getTime();
            });

            if (isDirectMatch) {
                console.log(`[${this.callSid}] ✅ Direct match found. Valid.`);
                return true;
            }

            console.log(`[${this.callSid}] No direct match, trying conversion...`);
            const rawTime = this.convertEstToRealUtc(fedToTwilio.appointmentTime);
            const targetTimestamp = new Date(rawTime).getTime();

            const isValidSlot = this.call.availableSlots.some(slot => {
                const slotTimestamp = new Date(slot).getTime();
                return slotTimestamp === targetTimestamp;
            });

            if (isValidSlot) {
                console.log(`[${this.callSid}] ✅ Conversion match found.`);
                return true;
            } else {
                console.log(`[${this.callSid}] ❌ No match found (Direct or Converted).`);
                return false;
            }
        } catch (e) {
            console.error(`[${this.callSid}] Error in checkValid:`, e);
            return false;
        }
    }

    validateTimeSlot(inputTime) {
        if (!this.call.availableSlots || this.call.availableSlots.length === 0) {
            console.error(`[${this.callSid}] Validation Failed: NO AVAILABLE SLOTS loaded.`);
            return { isValid: false, formattedTime: null };
        }

        try {
            const inputTimestamp = new Date(inputTime).getTime();

            // Step 1: Direct match — handles case where inputTime is already real UTC
            // (e.g. re-validating this.call.appointmentTime which was set from a previous validation)
            const directMatch = this.call.availableSlots.find(slot => {
                return slot === inputTime || Math.abs(new Date(slot).getTime() - inputTimestamp) < 60000;
            });

            if (directMatch) {
                console.log(`[${this.callSid}] ✅ Direct match found in validateTimeSlot: ${directMatch}`);
                return { isValid: true, formattedTime: directMatch };
            }

            // Step 2: Convert from EST (AI sends EST wall-clock with Z) to real UTC, then match.
            // The AI expresses times as EST local hours with a Z suffix (or no suffix).
            // convertEstToRealUtc strips Z and treats the remainder as America/New_York time.
            console.log(`[${this.callSid}] No direct match, converting EST→UTC and retrying...`);
            const realUtc = this.convertEstToRealUtc(inputTime);
            const realTimestamp = new Date(realUtc).getTime();

            const match = this.call.availableSlots.find(slot => {
                return Math.abs(new Date(slot).getTime() - realTimestamp) < 60000;
            });

            if (match) {
                console.log(`[${this.callSid}] ✅ MATCH FOUND after EST→UTC conversion: ${match}`);
                return { isValid: true, formattedTime: match };
            } else {
                console.log(`[${this.callSid}] ❌ NO MATCH FOUND in ${this.call.availableSlots.length} slots.`);
                return { isValid: false, formattedTime: realUtc };
            }
        } catch (e) {
            console.error(`[${this.callSid}] Validation Error:`, e);
            return { isValid: false, formattedTime: null };
        }
    }

    async handleAppointment(details) {
        console.log(`[${this.callSid}] handleAppointment called with: `, JSON.stringify(details, null, 2));
        try {
            const appointmentTime = details.appointmentTime;
            if (!appointmentTime) {
                return "STATUS: FAILED: You must send an appointment time before continuing.";
            }
            // appointmentTime is already real UTC — it was set from validateTimeSlot which
            // returns the matched slot string directly from availableSlots (real UTC).
            console.log(`[${this.callSid}] Sending UTC time to Calendly: ${appointmentTime}`);

            const payload = {
                email: details.customerEmail,
                name: details.customerName,
                phone: this.call.phoneNumber || "000-000-0000",
                model: details.vehicleModel || "N/A",
                make: "N/A",
                insuranceClaim: details.paymentMethod || "unknown",
                appointmentTime: appointmentTime
            };

            const result = await scheduleAppointment(payload);
            console.log(`[${this.callSid}] scheduleAppointment result: `, JSON.stringify(result, null, 2));

            if (result && result.resource && result.resource.uri) {
                return `STATUS: SUCCESS.URI: ${result.resource.uri} `;
            }

            let errorReason = "Unable to schedule.";
            if (result && result.error) {
                errorReason = `Error from Calendly: ${result.error} `;
            }

            this.call.sendClear();
            return `STATUS: FAILED.Reason: ${errorReason} Offer transfer to ${this.call.transferNumber} or new time.`;
        } catch (e) {
            console.error(`[${this.callSid}] Scheduling error in handleAppointment: `, e);
            this.call.sendClear();
            return `STATUS: FAILED.Reason: Error scheduling(${e.message}).Offer transfer to ${this.call.transferNumber} or new time.`;
        }
    }

    async getAvailability() {
        try {

            const today = new Date(Date.now() + 10000);

            const weekOne = await getAvailability(today.toISOString());
            const weekTwo = await getAvailability(new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString());
            const weekThree = await getAvailability(new Date(today.getTime() + 14 * 24 * 60 * 60 * 1000).toISOString());
            const weekFour = await getAvailability(new Date(today.getTime() + 21 * 24 * 60 * 60 * 1000).toISOString());



            const slots = weekOne.concat(weekTwo, weekThree, weekFour);
            this.call.availableSlots = slots;
            return slots;
        } catch (e) {
            console.error(`[${this.callSid}] Error getting availability:`, e);
            return [];
        }
    }
}

module.exports = ToolCall;
