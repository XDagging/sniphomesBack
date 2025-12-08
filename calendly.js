require("dotenv").config();



// date is a time



async function getX(date) {
    try {
        console.log("this is the schedule", process.env.CALENDLY_API_KEY);
        const response = await fetch(`GET https://api.calendly.com/scheduled_events`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.CALENDLY_API_KEY}`,
            }
        });     
        console.log("status code", response.status);
        return await response.json();         
    } catch(e) {
        console.log("there was an error in collecting schedules")
    }
}


async function getSchedules(date) {
    try {
        console.log("this is the schedule", process.env.CALENDLY_API_KEY);
    const response = await fetch(`https://api.calendly.com/user_availability_schedules`, {
        method: 'GET',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.CALENDLY_API_KEY}`,

        }
    });     
    console.log("status code", response.status);
    return await response.json();         
    } catch(e) {
        console.log("there was an error in collecting schedules")
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


async function testFunction() {
    console.log(getX());
    // console.log(await getSchedules());


}

testFunction();