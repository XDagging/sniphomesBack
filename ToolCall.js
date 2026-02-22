const { getAvailability, scheduleAppointment } = require("./calendly");
const { fromZonedTime } = require('date-fns-tz');

class ToolCall {
    constructor(parentCall) {
        this.call = parentCall;
        this.callSid = parentCall.callSid;
    }

    parsingAppointmentTimeToReadableFormat(appointmentTime) {
        const newDate = new Date(appointmentTime).toLocaleString("en-US", {
            year: "numeric",
            month: "long",
            day: "numeric",
            hour: "numeric",
            minute: "numeric",
            hour12: true,
            timeZone: "America/New_York",
        });
        console.log(`[${this.callSid}] Parsed date: ${newDate}`);
        return newDate;
    }

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

    async checkValid(fedToTwilio) {
        try {
            console.log(`[${this.callSid}] --- checkValid ---`);
            console.log(`[${this.callSid}] Input: ${fedToTwilio.appointmentTime}`);

            const isDirectMatch = this.call.availableSlots.some(slot => {
                return slot === fedToTwilio.appointmentTime ||
                    new Date(slot).getTime() === new Date(fedToTwilio.appointmentTime).getTime();
            });

            if (isDirectMatch) {
                console.log(`[${this.callSid}] ✅ Direct match found (Fake UTC preserved). Valid.`);
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

    validateTimeSlot(inputTime, fromAction = false) {
        if (!this.call.availableSlots || this.call.availableSlots.length === 0) {
            console.error(`[${this.callSid}] Validation Failed: NO AVAILABLE SLOTS loaded.`);
            return { isValid: false, formattedTime: null };
        }

        try {
            const inputDate = new Date(inputTime);
            const inputTimestamp = inputDate.getTime();

            const directMatch = this.call.availableSlots.find(slot => {
                return slot === inputTime || new Date(slot).getTime() === inputTimestamp;
            });

            if (directMatch) {
                console.log(`[${this.callSid}] ✅ Direct match found in validateTimeSlot: ${directMatch}`);
                return { isValid: true, formattedTime: directMatch };
            }

            console.log(`[${this.callSid}] No direct match, validating via conversion...`);
            const formattedTime = !fromAction ? this.convertEstToRealUtc(inputTime) : inputTime;
            const targetTimestamp = new Date(formattedTime).getTime();

            const match = this.call.availableSlots.find(slot => {
                const slotTimestamp = new Date(slot).getTime();
                const diff = Math.abs(slotTimestamp - targetTimestamp);
                return diff < 60000;
            });

            if (match) {
                console.log(`[${this.callSid}] ✅ MATCH FOUND: ${match}`);
                return { isValid: true, formattedTime: match };
            } else {
                console.log(`[${this.callSid}] ❌ NO MATCH FOUND in ${this.call.availableSlots.length} slots.`);
                return { isValid: false, formattedTime: formattedTime };
            }
        } catch (e) {
            console.error(`[${this.callSid}] Validation Error:`, e);
            return { isValid: false, formattedTime: null };
        }
    }

    async handleAppointment(details) {
        console.log(`[${this.callSid}] handleAppointment called with: `, JSON.stringify(details, null, 2));
        try {
            let appointmentTime = details.appointmentTime;
            if (appointmentTime) {
                appointmentTime = this.convertEstToRealUtc(appointmentTime);
                console.log(`[${this.callSid}] Resulting UTC Time: ${appointmentTime}`);
            } else {
                return "STATUS: FAILED: You must send an appointment time before continuing.";
            }

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
            const today = new Date();

            const weekOne = await getAvailability(Math.floor(today.getTime() / 1000));
            const weekTwo = await getAvailability(Math.floor((today.getTime() + 7 * 24 * 60 * 60 * 1000) / 1000));
            const weekThree = await getAvailability(Math.floor((today.getTime() + 14 * 24 * 60 * 60 * 1000) / 1000));
            const weekFour = await getAvailability(Math.floor((today.getTime() + 21 * 24 * 60 * 60 * 1000) / 1000));


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
