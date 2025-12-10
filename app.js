require('dotenv').config()
const express = require("express");
const bodyParser = require("body-parser");
const bcrypt = require('bcrypt');
const md5 = require("md5")
const cors = require("cors")
const nodemailer = require("nodemailer")
const mongoose = require("mongoose")
const { v4: uuidv4 } = require('uuid');
const Cryptr = require('cryptr');
const session = require("express-session");

const MemoryStore = require('memorystore')(session)
const fs = require("fs")
const https = require("https")
const http = require("http");
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const Call = require("./Call.js");
const WebSocket = require("ws");

const { CronJob } = require("cron")

const { GoogleGenerativeAI } = require("@google/generative-ai");
const genAI = new GoogleGenerativeAI(process.env.GEMINI_KEY);

const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
    generationConfig: {
        temperature: 0.2,
        // 0.2
    },
});

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const client = require("twilio")(accountSid, authToken);


var AWS = require("aws-sdk");
const e = require('express');
const JSONTransport = require('nodemailer/lib/json-transport/index.js');
const { unsubscribe } = require('diagnostics_channel');
const { ExternalCampaignListInstance } = require('twilio/lib/rest/messaging/v1/externalCampaign.js');
// const { FeedbackInstance } = require('twilio/lib/rest/assistants/v1/assistant/feedback.js');
// const { send } = require('process');

const app = express();
const saltRounds = 10

// AWS.config.update({region: "us-east-1"})
// var ddb = new AWS.DynamoDB({ apiVersion: "2012-08-10" });

const cmod = new Cryptr(process.env.SECRET, { encoding: 'base64', pbkdf2Iterations: 10000, saltLength: 20 });

app.use(session({
    secret: process.env.COOKIESECRET,
    cookie: {
        path: "/",
        maxAge: 2628000000,
        httpOnly: true, // This is because i want to track if the cookie changes so i can change accordingly.
        sameSite: "none",
        secure: true, // Set the Secure attribute
        domain: process.env.NODE_ENV === "DEV" ? undefined : ".sniphomes.com",
    },
    resave: false,
    saveUninitialized: true,
    store: new MemoryStore({
        checkPeriod: 86400000 // prune expired entries every 24h
    }),
    proxy: true,
}));

function authenticateUser(req) {

    return new Promise((resolve) => {
        let sessionId = req.sessionID;

        if (!sessionId) {
            resolve("No user found");
        } else {
            req.sessionStore.get(sessionId, (err, session) => {
                if (err) {
                    console.log(err);
                    resolve("No user found");
                } else {
                    if (!session) {
                        resolve("No user found");
                    } else {
                        const currentUser = session.user;
                        if (!currentUser) {
                            resolve("No user found");
                        } else {
                            resolve(currentUser);
                        }
                    }
                }
            });
        }
    });
}

// LocalHOST CORS

let options;

if (process.env.NODE_ENV === "DEV") {
    console.log('\x1b[31m%s\x1b[0m', 'Currently in development mode (switch to PROD when deploying)');
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    options = {
        key: fs.readFileSync('C:\\Users\\marac\\code\\hackathon-quhacks\\key.pem'),
        cert: fs.readFileSync('C:\\Users\\marac\\code\\hackathon-quhacks\\cert.pem'),
        // Remove this line once done with production
        rejectUnauthorized: false
    };

    app.use(cors({
        origin: "http://localhost:3000",
        methods: "GET,HEAD,PUT,PATCH,POST,DELETE",
        credentials: true
    }))
} else {
    // options = {
    //         key: fs.readFileSync('/etc/letsencrypt/live/api.sniphomes.com/privkey.pem'),
    //         cert: fs.readFileSync('/etc/letsencrypt/live/api.sniphomes.com/fullchain.pem'),
    // }

    app.use(cors({
        origin: "https://sniphomes.com",
        methods: "GET,HEAD,PUT,PATCH,POST,DELETE",
        credentials: true
    }))
}


// Production CORS









let server;

if (process.env.NODE_ENV === "DEV") {
    server = https.createServer(options, app);
} else {
    server = http.createServer(app);
}


// const server = http.createServer(options, app);






const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: {
        // TODO: replace `user` and `pass` values from <https://forwardemail.net>
        user: process.env.EMAIL,
        pass: process.env.PASSWORD
    }
});


const sendMail = (email, subject, body) => {
    const mailOptions = {
        from: process.env.EMAIL,
        to: email,
        subject: subject + "#" + Math.floor(Math.random() * 1000),
        text: body
    }

    transporter.sendMail(mailOptions, (err, info) => {
        if (err) {
            console.log(err)
        } else {
            console.log("Email sent: ", info.response)
            return info.response
        }
    })

}





// mongoose.connect("mongodb://localhost:27017/houseDB")


const codeSchema = new mongoose.Schema({
    emailHash: {
        type: String,
        required: true,
        index: true
    },
    code: {
        type: String,
        required: true
    }
})

const DemoSchema = new mongoose.Schema({
    email: {
        type: String,
        required: true,
        index: false
    },
    emailHash: {
        type: String,
        required: true,
        index: true
    },
    name: {
        type: String
    },
    phoneNumber: {
        type: String
    },
    phoneNumberHash: {
        type: String,
        index: true
    }

})



const LeadSchema = new mongoose.Schema({
    // uuid of who generated this lead.
    uuid: {
        type: String,
        required: true,
        index: true
    },
    threadId: {
        type: String,
        unique: true,
    },
    date: {
        type: Number,
        required: true,
    },
    area: {
        type: String,
        required: true
    },
    leadDetails: {
        type: Object,
        required: true
    },
    transcript: {
        type: Array,
        required: true
    },
    phoneNumber: {
        type: String,
        required: true,
    },
    action: {
        type: String,
        unique: false,
    },
    new: {
        type: Boolean,
        unique: false,
    }


})



const UserSchema = new mongoose.Schema({
    uuid: {
        type: String,
        required: true,
        index: true
    },
    name: {
        type: String,
        required: true
    },
    emailHash: {
        type: String,
        required: true,
        index: true
    },
    email: {
        type: String,
        required: true,
    },
    password: {
        type: String,
        required: true,
    },
    credits: {
        type: Number,
        required: true,
    },
    campaigns: {
        type: Array,
        required: true
    },
    dashboardStats: {
        type: Object,
        required: true
    },
    phoneNumber: {
        type: String,
        required: true
    },
    state: {
        type: String,
        required: true
    },
    operatingArea: {
        type: Array,
        required: true
    },
    aiSettings: {
        type: Object,
        required: true,
    },
    subscription: {
        type: Object,
        required: true
    },
    forgotCode: {
        type: Number
    },
    customerId: {
        type: String,
    }
})

const ThreadSchema = new mongoose.Schema({
    uuid: {
        type: String,
        unique: false,
    },
    messageId: {
        type: String,
        unique: false,

    },
    threadId: {
        type: String,
        unique: true,
    },
    sender: {
        type: String,
        unique: false,
    },
    receiver: {
        type: String,
        unique: false,
    },
    callFeature: {
        type: Boolean,
        unique: false,
    },
    area: {
        type: String,
        unique: false,
    },
    action: {
        type: String,
        unique: false,
    },
    transcript: {
        type: Array,
        unique: false,
    }
})


const User = new mongoose.model("User", UserSchema)
const Code = new mongoose.model("Code", codeSchema)
const Lead = new mongoose.model("Lead", LeadSchema)
const Demo = new mongoose.model("Demo", DemoSchema)
const Thread = new mongoose.model("Thread", ThreadSchema)



app.use('/webhook', express.raw({ type: "application/json" }))

app.post("/webhook", async (req, res) => {
    let data;
    let eventType;
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET_KEY;

    if (webhookSecret) {
        let event;
        let signature = req.headers["stripe-signature"];

        console.log(`Signature: ${signature}`);
        console.log(`Raw Body: ${req.body.toString()}`);

        try {
            event = stripe.webhooks.constructEvent(
                req.body,
                signature,
                webhookSecret
            );
        } catch (err) {
            console.log(`⚠️  Webhook signature verification failed.`, err.message);
            return res.sendStatus(400);
        }

        data = event.data;
        eventType = event.type;
    }

    switch (eventType) {
        case 'checkout.session.completed': {

            const products = {
                1999: 2000,
                3499: 6000,
                9999: 18000,
            }


            const session = await stripe.checkout.sessions.retrieve(
                data.object.id,
                { expand: ['line_items'] }
            );
            const customerId = session?.customer;
            const customer = await stripe.customers.retrieve(customerId);
            const priceId = session?.line_items?.data[0]?.price.id;
            const pricePaid = session?.amount_total
            console.log(customerId)
            console.log(session)
            if (customer.email) {
                User.findOne({ emailHash: md5(customer["email"].toLowerCase()) }).then((user, err) => {
                    if (err) {
                        console.log(err);
                    } else {
                        if (user !== null) {
                            User.findOneAndUpdate({ uuid: user.uuid }, { subscription: { active: true, renewalDate: Date.now() }, credits: products[pricePaid], customerId: customerId }).then(() => {
                                console.log("We got paid!");
                                return;
                            });
                        }
                    }
                });
            } else {
                console.log("No user found");
            }
            break;
        }

        case 'customer.subscription.deleted': {
            const subscription = await stripe.subscriptions.retrieve(data.object.id);

            console.log("So heres the subscription shit: " + subscription)
            const user = await User.findOneAndUpdate({ customerId: subscription.customer })

            console.log("heres the user found", user)

            user.subscription = {
                active: false,
                renewalDate: user.subscription.renewalDate
            }
            await user.save();
            break;
        }

        default:
            console.log(`Unhandled event type ${eventType}`);
    }

    res.sendStatus(200);
});




app.get("/sitemap", async (req, res) => {
    res.sendFile(__dirname + "/sitemap.xml")
})





app.use(bodyParser.json({ limit: "10mb" }))


const generateCode = (length) => {
    const numbers = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]
    let code = ""

    for (let i = 0; i < length; i++) {
        code += Math.floor(Math.random() * (numbers.length))
    }

    return code

}

function reportError(err) {
    console.log(err)
    sendMail(process.env.ADMINEMAIL, "Error Occured", "An error occured. Here's the error message\n\n" + err)
}





const job = new CronJob(
    '0 0 0 * * *',
    () => {
        User.find().then((users, err) => {
            if (err) {
                console.log(err)
                reportError(err)
            } else {
                if (users) {

                    users.map((user, i) => {

                        const currentCampaigns = user.campaigns;
                        const monthMiliseconds = 2628000000;

                        currentCampaigns.map((campaign, i) => {
                            if (campaign.date > campaign.date + monthMiliseconds) {
                                campaign.active = false;



                            }
                        })


                        User.findOneAndUpdate({ uuid: user.uuid }, { campaigns: currentCampaigns }).then((_, err) => {
                            if (err) {
                                console.log(err)
                            } else {
                                console.log("wsg")
                            }
                        })


                    })








                }


            }
        })



    },
    null,
    true,

)





app.post("/sendVerify", (req, res) => {
    let { email } = req.body

    try {
        if (!email) {
            throw new Error("invalid request")
        }
    } catch (e) {
        console.log(e)
        res.status(400).send(JSON.stringify({
            code: "err",
            message: "invalid request"
        }))
    }

    email = email.toLowerCase()

    Code.findOne({ emailHash: md5(email) }).then((code, err) => {
        if (err) {
            console.log(err)
            res.status(500).send(JSON.stringify({
                code: "err",
                message: "internal server error"
            }))
        } else {






            let codeHash = generateCode(8)

            const newCode = new Code({
                emailHash: md5(email),
                code: codeHash
            })
            if (code) {
                codeHash = code.code
            }
            const body = `Hello. \n\nYou're receiving this email because you requested to verify your email on sniphomes.\n\nIf this isn't you, don't respond\n\nIf this is you, please use the following code: ${codeHash}\n\nFarewell, Sniphomes Team`

            newCode.save().then(() => {
                sendMail(email, "Sniphomes Verification Code", body)



                res.status(200).send(JSON.stringify({
                    code: "ok",
                    message: "code sent"
                }))
            }).catch((err) => {
                console.log(err)
                res.status(500).send(JSON.stringify({
                    code: "err",
                    message: "internal server error"
                }))
            })

        }
    })







})




// Call Routes;


app.post("/xml", (req, res) => {
    console.log("xml called");
    res.sendFile(__dirname + "/call.xml");
})

const dynamicCalls = {};


// app.post("/callSomeone", (req,res) => {
//     try {
//         const




//     } catch(e) {
//         console.log("there was an error in callSomeone", e);

//         res.status(400).send(JSON.stringify({
//             code: "err",
//             message: "there was an error"
//         }))



//     }


// })



function callSomeone(phoneNumber, agentName, agentArea, agentAction, uuid) {


    client.calls
        .create({
            url: "https://api.sniphomes.com/xml",
            to: `+1${phoneNumber}`,
            from: `+12403660377`,
        })
        .then(async (call) => {
            // we need to check if this is buggy or not
            dynamicCalls[call.sid] = await Call.create(
                call.sid,
                phoneNumber,
                agentAction,
                agentArea,
                agentName,
                uuid
            );
            globalSid = call.sid;

            console.log(call);

        });



}







const wss = new WebSocket.Server({ server: server });
// Data needs to become a map with key value pairs of arrays.

// 9BWtsMINqrJLrRacOk9x Southern have a great day
// XB0fDUnXU5powFXDhCwa british account

// ZuvB6LuOVtnnHRsCEquq REALLY DOWN TO EARTH VOICE
// 03vEurziQfq3V8WZhQvn BLACK WOMAN

var streamId = "";

var twilioWs = "";


// 2000 is the prev number


wss.on("connection", function (ws) {
    console.log("WebSocket client connected.");

    // We can't associate the call yet. We need to wait for the "start" message
    // to get the callSid and streamSid.
    const startListener = async (message) => {
        try {
            const parsedMsg = JSON.parse(message.toString());
            console.log("we got to here", parsedMsg)
            // We only care about the "start" message to associate the WebSocket
            if (parsedMsg.event === "start" && parsedMsg.start && parsedMsg.start.callSid) {
                const callSid = parsedMsg.start.callSid;
                const streamId = parsedMsg.streamSid;

                console.log(`[${callSid}] WebSocket received start event. Stream SID: ${streamId}`);

                // Find the existing Call object created by your /voice webhook
                const callInstance = dynamicCalls[callSid];

                if (callInstance) {
                    // If you want to track calls by streamId, you can re-key it here.
                    dynamicCalls[streamId] = callInstance;
                    delete dynamicCalls[callSid];

                    // --- THIS IS THE CRITICAL CHANGE ---
                    // Pass the websocket *directly* to the class instance.
                    // The setWebsocket method in OptimizedCall.js will now
                    // add its OWN .on("message") listener to handle all media events.
                    console.log("we gave the websocket");
                    callInstance.setWebsocket(ws, streamId);

                    // We MUST remove this temporary listener now,
                    // otherwise it will conflict with the listener inside the Call class.
                    ws.removeListener("message", startListener);

                } else {
                    const phoneNum = "+11000000000"; // Dummy number
                    // This must mean that it is an inbound call;
                    if (!dynamicCalls[callSid]) {
                        const newCallInstance = await Call.create(
                            callSid,
                            phoneNum,
                            "sell",
                            "bethesda",
                            "Carlos",
                            "demo",
                        );
                        dynamicCalls[callSid] = newCallInstance;
                        newCallInstance.setWebsocket(ws, streamId);
                        ws.removeListener("message", startListener);

                    }



                    // console.error(`[${callSid}] No call instance found. Hanging up WebSocket.`);
                    // ws.close();
                }
            } else {
                // This could be a "connected" message, which we can ignore
                console.log("WebSocket message received (pre-start):", parsedMsg.event);
            }
        } catch (e) {
            console.error("Error parsing start message:", e);
            ws.close();
        }
    };

    // Add the temporary listener to catch the "start" message
    ws.on("message", startListener);

    ws.on("close", () => {
        console.log("WebSocket client disconnected.");
        // The Call class's internal .on("message") handler will
        // detect the "stop" event and trigger the hangup() logic.
    });

    ws.on("error", (err) => {
        console.error("WebSocket error:", err);
    });
});
// wss.on("connection", function (ws) {
//     // technically anyone could just connect and then we r fucked so we need to figure out a better way to do this in the future. For testing is fine though.
//     twilioWs = ws;

//     console.log("Just connected");

//     ws.on("close", () => {
//         console.log("The connection was closed and interval was cleared");

//     });

//     ws.on("message", (message) => {
//         try {
//             let parsedMsg = JSON.parse(message.toString());
//             streamId = parsedMsg.streamSid;

//             if (parsedMsg.event === "start") {
//                 const callSid = parsedMsg["start"]["callSid"];
//                 // Ensure the callSid exists in dynamicCalls

//                 // dynamicCalls[callSid].setWebsocket(ws);

//                 // Renaming the class instance key from callSid to streamId
//                 dynamicCalls[streamId] = dynamicCalls[callSid];
//                 dynamicCalls[streamId].streamSid = streamId;
//                 delete dynamicCalls[callSid];

//                 dynamicCalls[streamId].startInterval();
//                 dynamicCalls[streamId].setWebsocket(ws);
//             } else if (parsedMsg.event === "stop") {
//                 console.log("The call has ended");
//                 dynamicCalls[streamId].stopProcessing();
//             } else if (
//                 parsedMsg.event === "media" &&
//                 parsedMsg.media &&
//                 parsedMsg.media.track === "inbound"
//             ) {
//                 if (parsedMsg.media.payload !== undefined) {
//                     if (!dynamicCalls[streamId].aiTalking) {
//                         dynamicCalls[streamId].addData(
//                             parsedMsg.sequenceNumber,
//                             parsedMsg.media.payload,
//                         );
//                     } else {
//                         dynamicCalls[streamId].resetData();
//                     }
//                 }
//             }
//         } catch (e) {
//             console.log("Error parsing message:", e);
//         }
//     });
// });




































// Check for valid parameters
app.post("/register", (req, res) => {
    let email = req.body.email
    const { password, phoneNumber, state, code, firstName, lastName } = req.body

    try {
        if (!email || !password || !phoneNumber || !state || !code || !firstName || !lastName) {
            throw new Error("invalid request")
        }
    } catch (e) {
        console.log(e)
        res.status(400).send(JSON.stringify({
            code: "err",
            message: "invalid request"
        }))
        return
    }


    const compiledName = firstName.toLowerCase() + " " + lastName.toLowerCase()
    email = email.toLowerCase();



    User.findOne({ emailHash: md5(email) }).then((user, err) => {
        if (err) {
            console.log(err)
            res.status(500).send(JSON.stringify({
                code: "err",
                message: "internal server error"
            }))
        } else {
            if (user !== null) {
                res.status(400).send(JSON.stringify({
                    code: "err",
                    message: "user already exists"
                }))
            } else {


                Code.findOne({ emailHash: md5(email) }).then((codeVer, err) => {
                    if (err) {
                        console.log(err)
                        res.status(500).send(JSON.stringify({
                            code: "err",
                            message: "internal server error"
                        }))
                    } else {
                        if (codeVer?.code === code) {
                            // Check for password to not have white space
                            bcrypt.hash(password, saltRounds, (err, hash) => {
                                if (err) {
                                    console.log(err)
                                    res.status(500).send(JSON.stringify({
                                        code: "err",
                                        message: "internal server error"
                                    }))
                                } else {





                                    const userId = uuidv4()

                                    const newUser = new User({
                                        uuid: userId,
                                        name: cmod.encrypt(compiledName),
                                        emailHash: md5(email),
                                        email: cmod.encrypt(email),
                                        password: hash,
                                        credits: 0,
                                        campaigns: [],
                                        phoneNumber: cmod.encrypt(phoneNumber),
                                        state: cmod.encrypt(state),
                                        operatingArea: [],
                                        customerId: "",
                                        aiSettings: {
                                            name: "Bob",
                                            thresholdValue: 0.7,
                                            callFeature: false,
                                        },
                                        dashboardStats: {
                                            textsSent: 0,
                                            callsMade: 0,
                                            leadsGenerated: 0,
                                        },
                                        subscription: {
                                            active: false,
                                            // This unix timestamp
                                            renewalDate: 0,

                                        },

                                    })


                                    req.session.user = userId

                                    newUser.save().then(() => {
                                        res.status(200).send(JSON.stringify({
                                            code: "ok",
                                            message: "user created"
                                        }))
                                    }).catch((err) => {
                                        console.log(err)
                                        res.status(500).send(JSON.stringify({
                                            code: "err",
                                            message: "internal server error"
                                        }))
                                    })
                                }
                            })




                        } else {
                            res.status(403).send(JSON.stringify({
                                code: "err",
                                message: "invalid code"
                            }))
                        }
                    }
                })







            }
        }
    })
})



app.post("/login", (req, res) => {
    let { email, password } = req.body

    try {
        if (!email || !password) {
            throw new Error("invalid request")
        }
    } catch (e) {
        console.log(e)
        res.status(400).send(JSON.stringify({
            code: "err",
            message: "invalid request"
        }))
        return
    }


    email = email.toLowerCase();


    User.findOne({ emailHash: md5(email) }).then((user, err) => {
        if (err) {
            console.log(err)
            res.status(500).send(JSON.stringify({
                code: "err",
                message: "internal server error"
            }))
        } else {
            if (user !== null) {
                bcrypt.compare(password, user.password, (err, result) => {
                    if (err) {
                        console.log(err)
                        res.status(500).send(JSON.stringify({
                            code: "err",
                            message: "internal server error"
                        }))
                    } else {
                        console.log(result)
                        if (result) {
                            req.session.user = user.uuid

                            res.status(200).send(JSON.stringify({
                                code: "ok",
                                message: "login successful",
                            }))
                        } else {
                            res.status(403).send(JSON.stringify({
                                code: "err",
                                message: "invalid password"
                            }))
                        }
                    }
                })
            } else {
                res.status(400).send(JSON.stringify({
                    code: "err",
                    message: "user does not exist"
                }))
            }
        }
    })
})



app.get("/getUser", (req, res) => {
    // CODE NOT TESTED


    authenticateUser(req).then((id) => {
        if (id === "No user found") {
            res.status(403).send(JSON.stringify(
                {
                    code: "err",
                    message: "user not found"
                }
            ))
        } else {


            User.findOne({ uuid: id }).then((user, err) => {
                if (err) {
                    console.log(err)
                    res.status(500).send(JSON.stringify({
                        code: "err",
                        message: "internal server error"
                    }))
                } else {

                    let formattedName = cmod.decrypt(user.name)
                    formattedName = formattedName.substring(0, 1).toUpperCase() + formattedName.substring(1, formattedName.split(" ")[0].length) + " " + formattedName.split(" ")[1].substring(0, 1).toUpperCase()
                    res.status(200).send(JSON.stringify({
                        code: "ok",
                        message: {
                            uuid: user.uuid,
                            name: formattedName,
                            email: cmod.decrypt(user.email),
                            phoneNumber: cmod.decrypt(user.phoneNumber),
                            state: cmod.decrypt(user.state),
                            operatingArea: user.operatingArea,
                            credits: user.credits,
                            campaigns: user.campaigns.filter((campaign) => campaign.active),
                            dashboardStats: user.dashboardStats,
                            aiSettings: user.aiSettings,
                            subscription: user.subscription,
                            // Check if the campaigns code actually works
                        }
                    }))
                }
            })






        }
    })




})


app.get("/getLeads", async (req, res) => {

    // if (process.env.NODE_ENV === "DEV") {
    //     await new Promise((resolve) => {
    //         setTimeout(() => {
    //             console.log("just finished the resolve")
    //             resolve();
    //         },4000)
    //     })

    // }

    authenticateUser(req).then((id) => {
        if (id === "No user found") {
            res.status(403).send(JSON.stringify({
                code: "err",
                message: "invalid request"
            }))
        } else {
            Lead.find({ uuid: id }).then((leads, err) => {
                if (err) {
                    console.log(err);
                    res.status(400).send(JSON.stringify({
                        code: "err",
                        message: "invalid request"
                    }))
                } else {


                    if (process.env.NODE_ENV === "DEV") {
                        console.log('\x1b[31m%s\x1b[0m', 'IN DEVELOPMENT MODE: GETLEADS RETURNS THE DEFAULT TESTING VALUE');
                        leads = [{
                            uuid: id,
                            date: 1735361710711,
                            new: true,
                            area: 'White County',
                            leadDetails: 'Anthony expressed interest in selling his home.  A phone call was scheduled to discuss his needs and the current market conditions.  The conversation concluded with a plan to connect by phone at a mutually convenient time.\n',
                            transcript: [
                                {
                                    date: 1735361635415,
                                    sender: 'Trinity@sniphomes.com',
                                    message: 'Hey Anthony\n' +
                                        '\n' +
                                        "I'm Trinity, a local real estate agent in White County.\n" +
                                        '\n' +
                                        "I saw that you lived in White County and was wondering if selling your home is something you'd be open to, the market right now is huge.\n" +
                                        '\n' +
                                        "I'd be delighted to chat with you more about it.\n" +
                                        '\n' +
                                        '\n' +
                                        '\n' +
                                        'Best Regards,\n' +
                                        'Trinity\n' +
                                        'Real Estate'
                                },
                                {
                                    date: 1735361661890,
                                    sender: 'xdagging@gmail.com',
                                    message: 'Yes, I would be interested.On Fri, Dec 27, 2024 at 11:53 PM <Trinity@sniphomes.com wrote:'
                                },
                                {
                                    date: 1735361663420,
                                    message: 'Hi Anthony,\n' +
                                        '\n' +
                                        "Great to hear you're interested!  To best understand your needs and give you accurate information about selling your home in White County's current market, a quick call would be ideal.  What's your phone number, and what time works best for you to chat? I'm flexible and available most times. \n" +
                                        '\n' +
                                        'Looking forward to speaking with you!',
                                    sender: 'Trinity@sniphomes.com'
                                },
                                {
                                    date: 1735361708856,
                                    sender: 'xdagging@gmail.com',
                                    message: 'You can call anytime. my number is 301-272-7224On Fri, Dec 27, 2024 at 11:54 PM <Trinity@sniphomes.com wrote:'
                                },
                                {
                                    date: 1735361710081,
                                    message: 'Hi Anthony,\n' +
                                        '\n' +
                                        "Fantastic! I'll give you a call right now at 301-272-7224 to discuss your home sale.  Looking forward to it!",
                                    sender: 'Trinity@sniphomes.com'
                                }
                            ],
                            phoneNumber: '301-272-7224',
                            action: 'sell',
                        }]
                    }

                    res.status(200).send(JSON.stringify({
                        code: "ok",
                        message: leads
                    }))
                }
            })


        }
    })
})


app.post("/updateLeadStatus", (req, res) => {
    try {
        const threadId = req.body.threadId
        authenticateUser(req).then((id) => {
            if (id === "No user found") {

                res.status(400).send(JSON.stringify({
                    code: "err",
                    message: "invalid request"
                }))
            } else {
                Lead.findOneAndUpdate({ threadId: threadId }, { new: false }).then(() => {
                    res.status(200).send(JSON.stringify({
                        code: "ok",
                        message: "success"
                    }))
                })

            }
        })



    } catch (e) {
        console.log(e)
        res.status(400).send(JSON.stringify({
            code: "err",
            message: "invalid request"
        }))
    }

})


app.post("/updateUser", (req, res) => {
    const { operatingArea, aiName } = req.body


    try {
        if (!operatingArea || !aiName) {
            throw new Error("yur")
        }
    } catch (e) {
        console.log(e)
        res.status(400).send(JSON.stringify({
            code: "err",
            message: "invalid request"
        }))
        return
    }


    if (aiName.length > 0) {

        authenticateUser(req).then((id) => {
            if (id === "No user found") {
                res.status(403).send(JSON.stringify(
                    {
                        code: "err",
                        message: "user not found"
                    }
                ))
            } else {
                User.findOne({ uuid: id }).then((user, err) => {
                    if (err) {
                        res.status(500).send(JSON.stringify({
                            code: "err",
                            message: "server error"
                        }))
                    } else {
                        if (user !== null) {

                            User.findOneAndUpdate({ uuid: user.uuid }, { operatingArea: operatingArea, aiSettings: { ...user.aiSettings, name: aiName } }).then(() => {
                                res.status(200).send(JSON.stringify({
                                    code: "ok",
                                    message: "success"
                                }))
                            })




                        } else {
                            res.status(403).send(JSON.stringify({
                                code: "err",
                                message: "user not found"
                            }))
                        }
                    }
                })
            }
        })





    } else {
        res.status(400).send(JSON.stringify({
            code: "err",
            message: "invalid request"
        }))
    }




})




app.post("/startCampaign", (req, res) => {
    const { target, credits, aiThreshold, address, message } = req.body;


    if (((target === "homebuyers") || (target === "homesellers")) && ((aiThreshold > 0) || (aiThreshold < 101)) && (credits < 100)) {
        console.log("This occured", credits)
        res.status(400).send(JSON.stringify({
            code: "err",
            message: "invalid request"
        }))
        return
    }




    authenticateUser(req).then((id) => {
        if (id === "No user found") {
            res.status(403).send(JSON.stringify({
                code: "err",
                message: "not logged in"
            }))
        } else {


            User.findOne({ uuid: id }).then((user, err) => {
                if (err) {
                    res.status(500).send(JSON.stringify({
                        code: "err",
                        message: "internal server error"
                    }))
                } else {
                    if (user !== null) {
                        if (user.operatingArea.length === 0) {
                            res.status(403).send(JSON.stringify({
                                code: "err",
                                message: "add operating area"
                            }))
                            return
                        }


                        if (user.credits < credits) {
                            res.status(403).send(JSON.stringify({
                                code: "err",
                                message: "insufficient credits"
                            }))
                        } else {
                            const newCampaign = {
                                target: target,
                                credits: credits,
                                aiThreshold: aiThreshold,
                                address: address,
                                leads: [],
                                areaTarget: user.operatingArea,
                                date: Date.now(),
                                active: true,

                            }

                            // Campaigns expire 30 days after

                            User.findOneAndUpdate({ uuid: user.uuid }, { campaigns: [...user.campaigns, newCampaign], credits: user.credits - credits }).then(() => {
                                console.log(message.email)
                                const body = `Hello Sebastian.\n\nNew Campaign has started so start collecting data.\n\nCampaign Details:\n\nTarget: ${target}\nCredits: ${credits}\nAiThreshold: ${aiThreshold}\nAddress: ${address}\n\nUuid: ${user.uuid}\n\nMessage: ${message.email.email != null ? message.email.email : "Default"}\n\nSubject: ${message.email.subject != null ? message.email.subject : "Default"}`



                                sendMail(process.env.ADMINEMAIL, "New Campaign (find data)", body)


                                res.status(200).send(JSON.stringify({
                                    code: "ok",
                                    message: "campaign started"
                                }))

                            })
                        }

                    } else {
                        res.status(400).send(JSON.stringify({
                            code: "err",
                            message: "invalid request"
                        }))
                    }
                }
            })




        }
    })








})







app.post("/forgotPassword", (req, res) => {
    const { email } = req.body


    if ((email.split("@").length === 2) && (email.indexOf(".") !== -1)) {
        User.findOne({ emailHash: md5(email) }).then((user, err) => {
            if (err) {
                console.log(err)
                res.status(500).send(JSON.stringify({
                    code: "err",
                    message: "internal server error"
                }))
            } else {

                if (user !== null) {

                    const code = generateCode(8)

                    User.findOneAndUpdate({ uuid: user.uuid }, { forgotCode: code }).then(() => {
                        const body = `Hello. \n\nYou're receiving this email because you requested to reset your password on sniphomes.\n\nIf this isn't you, don't respond\n\nIf this is you, please use the following code: ${code}\n\nFarewell, Sniphomes Team`
                        sendMail(email, "Sniphomes Password Reset Code", body)

                        res.status(200).send(JSON.stringify({
                            code: "ok",
                            message: "code sent"
                        }))
                    })








                } else {
                    res.status(400).send(JSON.stringify({
                        code: "err",
                        message: "invalid request"
                    }))
                }



            }
        })
    } else {
        res.status(400).send(JSON.stringify({
            code: "err",
            message: "invalid request"
        }))
    }
})



app.post("/updatePassword", (req, res) => {
    const { email, code, password } = req.body

    if ((email.split("@").length === 2) && (email.indexOf(".") !== -1)) {


        User.findOne({ emailHash: md5(email) }).then((user, err) => {
            if (err) {
                console.log(err)
                res.status(500).send(JSON.stringify({
                    code: "err",
                    message: "internal server error"
                }))
            } else {


                if (user !== null) {
                    if (user.forgotCode === (null || undefined)) {
                        res.status(400).send(JSON.stringify({
                            code: "err",
                            message: "invalid request"
                        }))
                    } else if (user.forgotCode === code) {
                        bcrypt.hash(password, saltRounds, (err, hash) => {
                            if (err) {
                                res.status(500).send(JSON.stringify({
                                    code: "err",
                                    message: "interval server error"
                                }))
                            } else {
                                User.findOneAndUpdate({ uuid: user.uuid }, { password: hash, forgotCode: null }).then(() => {
                                    res.status(200).send(JSON.stringify({
                                        code: "ok",
                                        message: "password updated"
                                    }))
                                })
                            }
                        })
                    } else {
                        res.status(403).send(JSON.stringify({
                            code: "err",
                            message: "invalid code"
                        }))
                    }


                } else {


                    res.status(400).send(JSON.stringify({
                        code: "err",
                        message: "invalid request"
                    }))
                }
            }
        })




    } else {
        res.status(400).send(JSON.stringify({
            code: "err",
            message: "invalid request"
        }))
    }






})




app.post("/requestDemo", (req, res) => {
    const { phoneNumber, email, name } = req.body;


    if ((phoneNumber.length > 5) && (email.split("@").length === 2) && (email.length > 5) && (name.length > 0)) {



        Demo.findOne({ phoneNumberHash: md5(phoneNumber.trim()) }).then((user, err) => {
            if (err) {
                console.log(err)
                res.status(500).send(JSON.stringify({
                    code: "err",
                    message: "internal server error"
                }))
            } else {

                if (user === null || (email.toLowerCase() === cmod.decrypt(user.email).toLowerCase())) {

                    if (user && (user.email.toLowerCase() !== cmod.decrypt(user.email))) {
                        const newDemo = new Demo({
                            email: cmod.encrypt(email),
                            emailHash: md5(email),
                            phoneNumber: cmod.encrypt(phoneNumber.toString()),
                            phoneNumberHash: md5(phoneNumber.toString()),
                            name: cmod.encrypt(name)
                        })

                        newDemo.save()
                    }



                    callSomeone(phoneNumber, "Marta", "Prince County", "sell", "demo")






                } else {
                    res.status(403).send(JSON.stringify({
                        code: "err",
                        message: "already demoed"
                    }))

                }




            }
        })





    } else {
        res.status(400).send(JSON.stringify({
            code: "err",
            message: "invalid request"
        }))
    }









})








const bookedCalls = new Map();



function processLeadConversion(messageId, transcript, phoneNumber) {
    return new Promise(async (resolve) => {
        if (messageId) {

            Thread.findOne({ messageId: messageId }).then(async (thread, err) => {
                if (err) {
                    console.log(err)
                    resolve(err)
                } else {
                    if (thread) {

                        // If they have the demo feature enabled

                        // Call feature will be added later
                        if (thread.callFeature) {
                            const newLead = new Lead({
                                uuid: "",
                                date: Date.now(),

                            })



                        } else {
                            // Send Email
                            const leadDetails = await summarizeLeadDetails(transcript, thread.sender);
                            // bookmark
                            const newLead = new Lead({
                                threadId: thread.threadId,
                                uuid: thread.uuid,
                                date: Date.now(),
                                area: thread.area,
                                leadDetails: leadDetails,
                                transcript: transcript,
                                phoneNumber: phoneNumber,
                                action: thread.action,
                                new: true,
                            });

                            await newLead.save();


                            User.findOne({ uuid: thread.uuid }).then(async (person, err) => {
                                if (err) {
                                    console.log(err)
                                    resolve(err)
                                } else {
                                    if (person) {
                                        const newDashboard = person.dashboardStats
                                        const newNumber = Number(newDashboard.leadsGenerated + 1);
                                        newDashboard.leadsGenerated = newNumber;
                                        // person.dashboardStats = newDashboard;
                                        console.log(newDashboard)




                                        User.findOneAndUpdate({ uuid: person.uuid }, { dashboardStats: newDashboard }).then(async () => {

                                            // This code isn't tested yet
                                            const body = `Hey, ${cmod.decrypt(person.name).split(" ")[0].substring(0, 1).toUpperCase() + cmod.decrypt(person.name).split(" ")[0].substring(1).toLowerCase()},
                                            
You are receiving this email because you just received a new interested lead.

Check your Sniphomes.com dashboard for more details. 

                                            `


                                            await sendMail(cmod.decrypt(person.email), "New Lead Generated", body)
                                            resolve();
                                        })

                                        // await person.save();





                                    } else {
                                        console.log("Person doesn't exist")
                                        resolve("Person doesn't exist")
                                    }
                                }
                            })




                        }

                    } else {
                        console.log("Message Id is invalid");
                        resolve

                    }
                }
            })



        } else {
            console.log("Process Lead Conversion went wrong")
            resolve()
        }

    })




}


// Demo Testing:


app.post("/internalEmail", (req, res) => {
    const { replyToEmail, processEmailChain } = require("./utils.js")
    const internalCredential = req.body.credential || null;
    console.log(internalCredential)
    console.log(process.env.RECEIVE_CREDENTIAL)
    if (internalCredential === process.env.RECEIVE_CREDENTIAL) {
        try {



            const { message, sender, receiver, messageId, subject, originalMessageId } = req.body;

            if (message || sender || receiver || subject || originalMessageId) {
                const queryOriginalId = originalMessageId.substring(1, originalMessageId.length - 1)
                // replace RE with the actualy subject later but for now this is fine
                console.log("heres the query messageId:", queryOriginalId)
                Thread.findOne({ messageId: queryOriginalId }).then(async (val, err) => {
                    if (err) {
                        console.log(err);
                        res.status(400).send(JSON.stringify(
                            {
                                code: "err",
                                message: "invalid request"
                            }
                        ))
                    } else {

                        const newMessage = processEmailChain(message);
                        const fullTranscript = [...val.transcript, {
                            date: Date.now(),
                            sender: sender,
                            message: newMessage,


                        }]

                        console.log("heres the old thread,", val);
                        console.log("heres the new messageId", messageId)

                        const response = await replyToEmail(receiver, sender, fullTranscript, subject, messageId, val.action);
                        console.log("response", response.mail)



                        val.transcript = response.transcript;
                        val.messageId = response.mail.messageId.substring(1, response.mail.messageId.length - 1);
                        await val.save();
                        if (response.scheduleCall && response.phoneNumber && response.phoneNumber.length > 0) {
                            Lead.findOne({ threadId: val.threadId }).then((lead, err) => {
                                if (err) {
                                    console.log(err)

                                } else {
                                    if (lead) {
                                        // This thread has already led to a lead
                                        console.log("Already generated a lead from this thread");
                                        res.status(400).send(JSON.stringify({
                                            code: "err",
                                            message: "invalid request"
                                        }))
                                    } else {
                                        console.log("Converted to a lead.")
                                        processLeadConversion(val.messageId, response.transcript, response.phoneNumber).then(() => {
                                            User.findOne({ uuid: val.uuid }).then(async (user, err) => {
                                                if (err) {
                                                    console.log(err);
                                                    res.status(400).send(JSON.stringify({
                                                        code: "err",
                                                        message: "invalid request"
                                                    }))
                                                } else {


                                                    if (user) {
                                                        console.log()
                                                        let currentCase = "";
                                                        if (val.action.toLowerCase() === "sell") {
                                                            currentCase = "Selling"
                                                        } else {
                                                            currentCase = "Buying"
                                                        }


                                                        // add to the campaigns field in the User Schema and the dashboard stats.
                                                        // const previousCampaigns = user.campaigns
                                                        // for (let i=0; i<previousCampaigns.length; i++) {
                                                        //     if ((previousCampaigns[i].target === currentCase) && (previousCampaigns[i].areaTarget.includes(val.area))) {
                                                        //         previousCampaigns[i].leads.push({
                                                        //             date: Date.now(),
                                                        //             phoneNumber: lead.phoneNumber,
                                                        //             action: currentCase,
                                                        //             area: val.area,
                                                        //             transcript: lead.transcript,
                                                        //             summary: lead.leadDetails

                                                        //         })
                                                        //     }
                                                        // }
                                                        const previousDashboard = user.dashboardStats;
                                                        previousDashboard.leadsGenerated += 1;

                                                        user.dashboardStats = previousDashboard

                                                        await user.save();
                                                        res.status(200).send(JSON.stringify({
                                                            code: "ok",
                                                            message: "all went well"
                                                        }))


                                                    } else {
                                                        res.status(403).send(JSON.stringify({
                                                            code: "err",
                                                            message: "user not found"
                                                        }))
                                                    }


                                                }
                                            })
                                        })

                                    }
                                }
                            })


                        }


                    }
                })







            } else {
                res.status(400).send(JSON.stringify({
                    code: "err",
                    message: "invalid request"
                }))
            }







        } catch (e) {
            console.log(e);

            res.status(400).send(JSON.stringify({
                code: "err",
                message: "invalid request"
            }))
        }
    } else {
        res.status(404).send(JSON.stringify({
            code: "err",
            message: "invalid password or not found"
        }))
    }



})




app.post('/doOutreach', async (req, res) => {
    try {
        const { internalCredential, uuid, data, area, message, subject } = req.body;
        const { processOutreach } = require("./utils.js")
        console.log(internalCredential)
        // console.log(processLeadConversion)
        // const uuid = req.body.uuid;
        // const data = req.body.data;


        // Data is a list with json

        // 




        if (internalCredential === process.env.RECEIVE_CREDENTIAL) {

            User.findOne({ uuid: uuid }).then(async (user, err) => {
                if (err) {
                    console.log(err)
                    res.status(400).send(JSON.stringify({
                        code: "err",
                        message: "invalid request"
                    }))
                } else {
                    if (user) {

                        const senderEmail = user.aiSettings.name + "@sniphomes.com";


                        // if ((message.email.length>0) && (message.subject.length>0)) {
                        //     // Add the feature so people can customize the subjectline too
                        // }
                        processOutreach(data, senderEmail, user.aiSettings.name, area, message, subject).then(async (messageData) => {
                            const idList = messageData.idList;
                            const originalMessage = messageData.message
                            const newData = messageData.newData
                            console.log("idList", idList)
                            console.log("original", originalMessage.replace(/(<([^>]+)>)/ig, '').replace("/"))
                            idList.map((id, i) => {



                                const messageId = id.substring(1, id.length - 1)
                                const newThread = new Thread({
                                    threadId: uuidv4(),
                                    uuid: uuid,
                                    messageId: messageId,
                                    sender: senderEmail,
                                    receiver: newData[i].email,
                                    callFeature: user.aiSettings.callFeature,
                                    area: area,
                                    action: newData[i].action,
                                    transcript: [{
                                        date: Date.now(),
                                        sender: senderEmail,
                                        message: originalMessage.replace(/(<([^>]+)>)/ig, '').replace("/"),
                                    }],
                                })

                                newThread.save()

                            })
                            const newTexts = user.dashboardStats.textsSent + idList.length;
                            let previousStats = user.dashboardStats;
                            previousStats.textsSent = newTexts;

                            console.log("new previous stats", previousStats)
                            User.findOneAndUpdate({ uuid: user.uuid }, { dashboardStats: previousStats }).then(() => {
                                res.status(200).send(JSON.stringify({
                                    code: "ok",
                                    message: "success"
                                }))
                            })
                            // await user.save();


                        })





                    } else {

                        res.status(403).send(JSON.stringify({
                            code: "err",
                            message: "invalid uuid"
                        }))


                    }
                }
            })




        } else {
            res.status(404).send(JSON.stringify({
                code: "err",
                message: "not found"
            }))
            return
        }











    } catch (e) {
        console.log(e)
        res.status(404).send(JSON.stringify({
            code: "err",
            message: "not found"
        }))
    }
})



app.get("/addBlocklist/:id", (req, res) => {
    const decoder = new Cryptr(process.env.EMAIL_KEY_CRYPTR, { encoding: 'base64', pbkdf2Iterations: 10000, saltLength: 10 });


    const id = decodeURIComponent(req.params.id);

    try {
        const email = decoder.decrypt(id);

        if ((email.indexOf("@") > -1)) {
            unsubscribeEmail(email).then((response) => {
                if (response.toLowerCase() === "success") {
                    res.status(200).send(JSON.stringify({
                        code: "ok",
                        message: "success"
                    }))
                } else {
                    res.status(400).send(JSON.stringify({
                        code: "err",
                        message: "invalid request"
                    }))
                }
            })
        } else {
            res.status(200).send(JSON.stringify({
                code: "ok",
                message: "success"
            }))
        }

    } catch (e) {
        reportError(e)
        res.status(500).send(JSON.stringify({
            code: "err",
            message: "invalid request"
        }))
    }

})


async function summarizeLeadDetails(transcript, email) {

    let readableTranscript = "";
    for (let i = transcript.length - 1; i > 0; i--) {
        if (email === transcript[i].sender) {
            readableTranscript += "Me: " + transcript[i].message
        } else {
            readableTranscript += "Other Person: " + transcript[i].message;
        }
        readableTranscript += "\n\n"

    }

    const content = await model.generateContent(`
        
        You will be provided an email transcript of a conversation. 
        I want you to pinpoint a 3 sentence summary of the conversation (especially the conclusion of the conversation). 
        These conversations are real estate cold emails so don't mention that as the person reading the summary will already have that context.

        Email Transcript: 
        ${readableTranscript}
        
    `)
    return content.response.text();
}










app.get("/", (req, res) => {
    res.send("Hello world")
})






server.listen(process.env.PORT, (req, res) => {
    console.log("Listening on port ", process.env.PORT);
})

// 27 text files with the letter corresponding to the title like a.txt; the file only contains the emails that start with that letter
function unsubscribeEmail(email) {
    return new Promise((resolve) => {

        const fileName = email.substring(0, 1).toLowerCase() + ".txt"


        fs.readFile(fileName, 'utf8', (err, content) => {

            if (err) {
                // console.log(err);


                if (email.substring(0, 1).toLowerCase() !== email.substring(0, 1).toUpperCase()) {
                    // means that it is a letter

                    fs.writeFile(fileName, email.toLowerCase(), (err) => {
                        if (err) {
                            reportError(err)
                            console.log(err);
                        }
                        resolve("success")
                    })



                } else {
                    resolve("invalid")
                    console.log('email provided is invalid')

                }


            } else {
                fs.appendFile(fileName, `,${email.toLowerCase()}`, (err) => {
                    if (err) {
                        console.log(err)
                        reportError(err)
                        console.log(err)
                    }
                    resolve("success")

                })

            }

        })

    })



}


// 









// exports.processLeadConversion = processLeadConversion;
module.exports = { processLeadConversion }











