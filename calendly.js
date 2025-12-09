require("dotenv").config();



// date is a time


// we will hardcode the calendly event key;

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
    } catch(e) {

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
    } catch(e) {

        console.log("there was an error in collecting schedules", e)
    }
}


async function getEventAvailability(userUri, eventTypeUri, daysAhead) {
    try {
        // 1. Calculate a start and end time (e.g., next 7 days)
        const now = new Date();
        now.setDate(now.getDate() + daysAhead)
        const nextWeek = new Date();


        nextWeek.setDate(now.getDate() + 6);

        // 2. Query string parameters
        const params = new URLSearchParams({
            user: userUri,
            event_type: eventTypeUri,
            start_time: now.toISOString(),
            end_time: nextWeek.toISOString()
        });

        console.log("Fetching availability for:", eventTypeUri);

        const response = await fetch(`https://api.calendly.com/event_type_available_times?${params}`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.CALENDLY_API_KEY}`,
            }
        });

        if (response.status !== 200) {
            console.log("Error status:", response.status);
            console.log(await response.text()); // Print error details
            return;
        }

        return await response.json();
    } catch (e) {
        console.log("There was an error in collecting availability", e);
    }
}

async function createEvent(eventData) {
    try {

        const {email, name, phone, model, make, insuranceClaim, eventId} = eventData;

        const payload = {
            email: email,
            name: name,
            timezone: "America/New_York",
            text_reminder_number: phone,
            questions_and_answers: [
                {
                    "question": "Model",
                    "answer": model,
                    "position": 1
                },
                {
                    "question": "Make",
                    "answer": make,
                    "position": 2
                },
                {
                    "question": "Insurance Claim",
                    "answer": insuranceClaim,
                    "position": 3
                }
            ]
        }
        
        const response = await fetch(`https://api.calendly.com/`, {
            "method": "POST",
            "Content-Type": "application/json",
            "body": JSON.stringify(payload), 
            "Authorization": `Bearer ${process.env.CALENDLY_API_KEY}`,
        })

        return response.json();

    } catch(e) {

        console.log("there was an error in creating event");
        return;




    }


}


async function getAvailability(daysInAdvance) {
    // 1. Get User
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

    // 4. Get Available Slots (Corrected Logic)
    const availability = await getEventAvailability(userUri, eventTypeUri, daysInAdvance);
    return availability;
    // console.log("Available Slots:", JSON.stringify(availability, null, 2));
}

// testFunction();
// async function testFunction() {
//     console.log(await getAvailability(5));
//     console.log(await getAvailability(12));
// }

// testFunction();



module.exports = getAvailability;
