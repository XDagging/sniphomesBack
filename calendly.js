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

        // Keep real UTC times — conversion to EST happens only at the display layer
        if (data.collection) {
            data.collection = data.collection.filter(slot => slot.status === "available");
        }



        console.log("this is the data that was returned for that time period", data)
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

    const parsedData = []

    for (let i = 0; i < availability.collection.length; i++) {
        parsedData.push(availability.collection[i].start_time);
    }



    // We should convert this to just what we want


    // console.log("Available Slots:", JSON.stringify(availability, null, 2));
    return parsedData;
    // console.log("Available Slots:", JSON.stringify(availability, null, 2));
}



module.exports = { getAvailability, scheduleAppointment };
