require("dotenv").config();



// date is a time


// we will hardcode the calendly event key;
let eventType = "";
async function getCurrentUser() {
    try {
        // console.log("this is the schedule", process.env.CALENDLY_API_KEY);

        const response = await fetch(`https://api.calendly.com/users/me`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.CALENDLY_API_KEY}`,
            }
        });
        console.log("status code", response.status);
        return await response.json();
    } catch (e) {

        console.log("there was an error in collecting schedules", e)
    }

}

async function getX(organizationId) {
    try {
        // console.log("this is the schedule", process.env.CALENDLY_API_KEY);
        console.log('org id', organizationId);
        const response = await fetch(`https://api.calendly.com/event_types?count=99&organization=${organizationId}&active=true`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.CALENDLY_API_KEY}`,
            }
        });
        console.log("status code", response.status);
        return await response.json();
    } catch (e) {

        console.log("there was an error in collecting schedules", e)
    }
}


async function getEventAvailability(_, eventTypeUri, startDate) {
    try {
        // 1. Calculate a start and end time (exact 7 day window)
        const start = new Date(startDate);
        console.log("start date", start);
        const end = new Date(start);
        end.setDate(end.getDate() + 7);
        console.log("startTime", start.toISOString());
        console.log("endTime", end.toISOString());

        // 2. Query string parameters
        const params = new URLSearchParams({
            // user: userUri,
            event_type: eventTypeUri,
            start_time: start.toISOString(),
            end_time: end.toISOString()
        });

        console.log("Fetching availability for:", params);

        const response = await fetch(`https://api.calendly.com/event_type_available_times?${params}`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.CALENDLY_API_KEY}`,
            }
        });

        console.log("2. API Status Code:", response.status);
        if (response.status !== 200) {
            console.log("Error status:", response.status);
            console.log(await response.text()); // Print error details
            return;
        }

        const data = await response.json();

        // --- ADD THIS LOG ---
        console.log("RAW DATA FROM CALENDLY:", JSON.stringify(data, null, 2));

        function convertToEstISO(dateString) {
            const date = new Date(dateString);

            // 1. Get the wall-clock time in New York as a string
            const estString = date.toLocaleString("en-US", { timeZone: "America/New_York" });

            // 2. Parse that string back into a Date object
            // (This creates a "fake" UTC date that actually holds EST values)
            const estDate = new Date(estString);

            // 3. Return ISO string
            // This outputs: "2025-12-12T13:00:00.000Z" (where 13:00 is the EST time)
            return estDate.toISOString();
        }
        // --------------------
        if (data.collection) {

            data.collection = data.collection.filter(slot => slot.status === "available");

            data.collection = data.collection.map((slot) => {
                return {
                    ...slot, // Keep other properties
                    start_time: convertToEstISO(slot.start_time)
                };
            });


        }



        // console.log("this is the data that was returned for that time period", data)
        return data;
    } catch (e) {
        console.log("There was an error in collecting availability", e);
    }
}

async function scheduleAppointment(eventData) {
    // console.log("scheduleAppointment called with:", JSON.stringify(eventData, null, 2));
    try {
        const { email, name, phone, model, make, insuranceClaim, appointmentTime } = eventData;

        // 1. You must know the Event Type URI (e.g. "The 30 Min Service Call")
        // You can get this from GET /event_types
        const EVENT_TYPE_URI = eventType;

        const payload = {
            event_type: EVENT_TYPE_URI,
            start_time: appointmentTime, // Must be in UTC ISO format (e.g., "2025-10-25T14:30:00Z")
            // timezone: "America/New_York",
            invitee: {
                email: email,
                name: name,
                timezone: "America/New_York",
                // phone: phone,
                text_reminder_number: phone,
                // "text_reminder_number" is usually not settable directly via API unless mapped to a question
                // But you can pass custom answers for your questions:
            },
            questions_and_answers: [
                { "question": "Model", "answer": model, "position": 0 },
                { "question": "Make", "answer": make, "position": 1 },
                { "question": "Insurance Claim", "answer": insuranceClaim, "position": 2 }
            ]
        };

        console.log("Sending payload to Calendly:", JSON.stringify(payload, null, 2));

        const response = await fetch(`https://api.calendly.com/invitees`, { // CHANGED ENDPOINT
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${process.env.CALENDLY_API_KEY}`
            },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            const errorData = await response.json();
            console.error("Calendly API Error:", JSON.stringify(errorData, null, 2));
            throw new Error(JSON.stringify(errorData));
        }

        const responseData = await response.json();
        // console.log("Calendly API Success:", JSON.stringify(responseData, null, 2));
        return responseData;
    } catch (e) {
        console.log("Error creating scheduled event:", e);
        return { error: e.message || "Unknown error occurred" };
    }
}



// async function testFunction() {

//     const x = await getAvailability(7);
//     console.log(x);
//     console.log("uri is", eventType)

//     const y = await scheduleAppointment({
//         email: "marac@sniphomes.com",
//         name: "marac",
//         phone: "+1 301-123-3212",
//         model: "model",
//         make: "make",
//         insuranceClaim: "insuranceClaim",
//         appointmentTime: "2025-12-12T18:30:00.000000Z",
//     })
//     console.log(y)
// }

// testFunction();

async function getAvailability(startDate) {
    // 1. Get User
    console.log("This is what startDate looks like", startDate)
    const user = await getCurrentUser();
    const userUri = user.resource.uri; // We need the full URI (https://api...)
    const organizationUrl = user.resource.current_organization;

    // 2. Get Event Types
    const clientSchedules = await getX(organizationUrl);

    // 3. Find the specific Event Type
    const nameOfEvent = "Quattro Autobody";
    const targetEvent = clientSchedules.collection.find(event => event.name === nameOfEvent);
    console.log("target event", targetEvent);
    if (!targetEvent) {
        console.log("Event type not found!");
        return;
    }

    const eventTypeUri = targetEvent.uri; // Keep the full URI
    eventType = eventTypeUri;

    // 4. Get Available Slots (Corrected Logic)
    console.log("this is userUri", userUri);
    console.log("eventType URI", eventTypeUri);
    console.log("startDate", startDate)
    const availability = await getEventAvailability(userUri, eventTypeUri, startDate);
    // console.log("Available Slots:", JSON.stringify(availability, null, 2));
    return availability;
    // console.log("Available Slots:", JSON.stringify(availability, null, 2));
}

// testFunction();
// async function testFunction() {
//     const today = new Date();

//     const week0 = new Date(today.getTime() + 30 * 60000); // Add 30 minutes buffer
//     console.log(await getAvailability(week0));
//     // console.log(await getAvailability(12));
// }

// testFunction();



module.exports = { getAvailability, scheduleAppointment };
