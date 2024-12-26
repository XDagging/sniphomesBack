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
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const Call = require("./Call.js");
const WebSocket = require("ws");

const {GoogleGenerativeAI} = require("@google/generative-ai");
const genAI = new GoogleGenerativeAI(process.env.GEMINI_KEY);

const model = genAI.getGenerativeModel({
    model: "gemini-1.5-flash",
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
        httpOnly: true , // This is because i want to track if the cookie changes so i can change accordingly.
        sameSite: "none",
        secure: true, // Set the Secure attribute
    },
    resave: false,
    saveUninitialized: true,
    store: new MemoryStore({
        checkPeriod: 86400000 // prune expired entries every 24h
    }), 
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
    options = {
            key: fs.readFileSync('/etc/letsencrypt/live/api.sniphomes.com/privkey.pem'),
            cert: fs.readFileSync('/etc/letsencrypt/live/api.sniphomes.com/fullchain.pem'),
    }

    app.use(cors({
        origin: "https://sniphomes.com",
        methods: "GET,HEAD,PUT,PATCH,POST,DELETE",
        credentials: true
    }))
}


// Production CORS









const server = https.createServer(options, app);
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
        subject: subject + "#" + Math.floor(Math.random()*1000),
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





mongoose.connect("mongodb://localhost:27017/houseDB")


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
    messageId: {
        type: String,
        unique: false,

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
    }
})


const User = new mongoose.model("User", UserSchema)
const Code = new mongoose.model("Code", codeSchema)
const Lead = new mongoose.model("Lead", LeadSchema)
const Demo = new mongoose.model("Demo", DemoSchema)
const Thread = new mongoose.model("Thread", ThreadSchema)



app.use('/webhook', express.raw({ type:"application/json"}))

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




app.get("/sitemap", async(req,res) => {
    res.sendFile(__dirname + "/sitemap.xml")
})





app.use(bodyParser.json({limit: "10mb"}))


const generateCode = (length) => {
    const numbers = [0,1,2,3,4,5,6,7,8,9]
    let code = ""

    for (let i=0; i<length; i++) {
        code += Math.floor(Math.random() * (numbers.length-1))
    }

    return code
    
}



app.post("/sendVerify", (req,res) => {
    let {email} = req.body

    try {
        if (!email) {
            throw new Error("invalid request")
        }
    } catch(e) {
        console.log(e)
        res.status(400).send(JSON.stringify({
            code: "err",
            message: "invalid request"
        }))
    }

    email = email.toLowerCase()

    Code.findOne({emailHash: md5(email)}).then((code,err) => {
        if (err) {
            console.log(err)
            res.status(500).send(JSON.stringify({
                code: "err",
                message: "internal server error"
            }))
        } else {
            
           
    



                let codeHash =generateCode(8)

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


app.post("/xml", (req,res) => {
    console.log("xml called");
    res.sendFile(__dirname + "/call.xml");
})

const dynamicCalls = {};


function callSomeone(phoneNumber, agentName, agentArea, agentAction, uuid) {


    client.calls
        .create({
            url: "https://api.sniphomes.com/xml",
            to: `+1${phoneNumber}`,
            from: `+12403660377`,
        })
        .then((call) => {
            dynamicCalls[call.sid] = new Call(
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
    // technically anyone could just connect and then we r fucked so we need to figure out a better way to do this in the future. For testing is fine though.
    twilioWs = ws;

    console.log("Just connected");

    ws.on("close", () => {
        console.log("The connection was closed and interval was cleared");
        
    });

    ws.on("message", (message) => {
        try {
            let parsedMsg = JSON.parse(message.toString());
            streamId = parsedMsg.streamSid;

            if (parsedMsg.event === "start") {
                const callSid = parsedMsg["start"]["callSid"];
                // Ensure the callSid exists in dynamicCalls

                // dynamicCalls[callSid].setWebsocket(ws);

                // Renaming the class instance key from callSid to streamId
                dynamicCalls[streamId] = dynamicCalls[callSid];
                dynamicCalls[streamId].streamSid = streamId;
                delete dynamicCalls[callSid];

                dynamicCalls[streamId].startInterval();
                dynamicCalls[streamId].setWebsocket(ws);
            } else if (parsedMsg.event === "stop") {
                console.log("The call has ended");
                dynamicCalls[streamId].stopProcessing();
            } else if (
                parsedMsg.event === "media" &&
                parsedMsg.media &&
                parsedMsg.media.track === "inbound"
            ) {
                if (parsedMsg.media.payload !== undefined) {
                    if (!dynamicCalls[streamId].aiTalking) {
                        dynamicCalls[streamId].addData(
                            parsedMsg.sequenceNumber,
                            parsedMsg.media.payload,
                        );
                    } else {
                        dynamicCalls[streamId].resetData();
                    }
                }
            }
        } catch (e) {
            console.log("Error parsing message:", e);
        }
    });
});




































// Check for valid parameters
app.post("/register", (req,res) => {
    let email = req.body.email
    const {password, phoneNumber, state, code, firstName, lastName} = req.body

    try {
        if (!email || !password || !phoneNumber || !state || !code || !firstName || !lastName) {
            throw new Error("invalid request")
        }
    } catch(e) {
        console.log(e)
        res.status(400).send(JSON.stringify({
            code: "err",
            message: "invalid request"
        }))
        return
    }


    const compiledName = firstName + " " + lastName
    email = email.toLowerCase();



    User.findOne({email: md5(email)}).then((user,err) => {
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
                

                Code.findOne({emailHash: md5(email)}).then((codeVer,err) => {
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



app.post("/login", (req,res) => {
    let {email, password} = req.body

    try {
        if (!email || !password) {
            throw new Error("invalid request")
        }
    } catch(e) {
        console.log(e)
        res.status(400).send(JSON.stringify({
            code: "err",
            message: "invalid request"
        }))
        return
    }


    email = email.toLowerCase();
    

    User.findOne({emailHash: md5(email)}).then((user,err) => {
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



app.get("/getUser" , (req,res) => {
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
            

            User.findOne({uuid: id}).then((user,err) => {
                if (err) {
                    console.log(err)
                    res.status(500).send(JSON.stringify({
                        code: "err",
                        message: "internal server error"
                    }))
                } else {

                    let formattedName = cmod.decrypt(user.name)
                    formattedName = formattedName.substring(0,1).toUpperCase() + formattedName.substring(1,formattedName.split(" ")[0].length)+ " "+formattedName.split(" ")[1].substring(0,1).toUpperCase()
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
                            campaigns: user.campaigns,
                            dashboardStats: user.dashboardStats,
                            aiSettings: user.aiSettings,
                            subscription: user.subscription,
                        }
                    }))
                }
            })






        }
    })




})




app.post("/updateUser", (req,res) => {
    const {operatingArea, aiName} = req.body


    try {
        if (!operatingArea || !aiName) {
            throw new Error("yur")
        }
    } catch(e) {
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
                User.findOne({uuid: id}).then((user,err) => {
                    if (err) {
                        res.status(500).send(JSON.stringify({
                            code: "err",
                            message: "server error"
                        }))
                    } else {
                        if (user !== null) {

                            User.findOneAndUpdate({uuid: user.uuid}, {operatingArea: operatingArea, aiSettings: {...user.aiSettings, name: aiName}}).then(() => {
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

        



    }  else {
        res.status(400).send(JSON.stringify({
            code: "err",
            message: "invalid request"
        }))
    }




})




app.post("/startCampaign", (req,res) => {
    const {target, credits, aiThreshold, address} = req.body;


    if (((target === "homebuyers") || (target === "homesellers")) && ((aiThreshold > 0) || (aiThreshold < 101)) && (credits > 100)) {
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


            User.findOne({uuid: id}).then((user,err) => {
                if (err) {
                    res.status(500).send(JSON.stringify({
                        code: "err",
                        message: "internal server error"
                    }))
                } else {
                    if (user !== null) {
                        

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
                                areaTarget: user.operatingArea
                            }

                            User.findOneAndUpdate({uuid: user.uuid}, {campaigns: [...user.campaigns, newCampaign], credits: user.credits - credits}).then(() => {
                                
                                const body = `Hello Sebastian.\n\nNew Campaign has started so start collecting data.\n\nCampaign Details:\n\nTarget: ${target}\nCredits: ${credits}\nAiThreshold: ${aiThreshold}\nAddress: ${address}`



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







app.post("/forgotPassword", (req,res) => {
    const {email} = req.body


    if ((email.split("@").length === 2) && (email.indexOf(".") !== -1)) {
        User.findOne({emailHash: md5(email)}).then((user,err) => {
            if (err) {
                console.log(err)
                res.status(500).send(JSON.stringify({
                    code: "err",
                    message: "internal server error"
                }))
            } else {

                if (user !== null) {

                    const code = generateCode(8)

                    User.findOneAndUpdate({uuid: user.uuid}, {forgotCode: code}).then(() => {
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



app.post("/updatePassword", (req,res) => {
    const {email, code, password} = req.body

    if ((email.split("@").length === 2) && (email.indexOf(".") !== -1)) {


        User.findOne({ emailHash: md5(email)}).then((user,err) => {
            if (err) {
                console.log(err)
                res.status(500).send(JSON.stringify({
                    code: "err",
                    message: "internal server error"
                }))
            } else {
                

                if (user !== null) {
                    if (user.forgotCode === (null||undefined)) {
                        res.status(400).send(JSON.stringify({
                            code: "err",
                            message: "invalid request"
                        }))
                    } else if (user.forgotCode === code) {
                        bcrypt.hash(password, saltRounds, (err,hash) => {
                            if (err) {
                                res.status(500).send(JSON.stringify({
                                    code: "err",
                                    message: "interval server error"
                                }))
                            } else {
                                User.findOneAndUpdate({uuid: user.uuid}, {password: hash, forgotCode: null}).then(() => {
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




app.post("/requestDemo", (req,res) => {
    const {phoneNumber, email, name} = req.body;


    if ((phoneNumber.length > 5) && (email.split("@").length === 2) && (email.length > 5) && (name.length > 0)) {
        


        Demo.findOne({phoneNumberHash: md5(phoneNumber.trim())}).then((user,err) => {
            if (err) {
                console.log(err)
                res.status(500).send(JSON.stringify({
                    code: "err",
                    message: "internal server error"
                }))
            } else {
            
                if (user === null) {
                    const newDemo = new Demo({
                        email: cmod.encrypt(email),
                        emailHash: md5(email),
                        phoneNumber: cmod.encrypt(phoneNumber.toString()),
                        phoneNumberHash: md5(phoneNumber.toString()),
                        name: cmod.encrypt(name)
                    })

                    newDemo.save()


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




// Demo Testing:


app.post("/internalEmail", (req,res) => {
    const {replyToEmail} = require("./utils.js")
    const internalCredential = req.body.credential || null;
    console.log(internalCredential)
    console.log(process.env.RECEIVE_CREDENTIAL)
    if (internalCredential === process.env.RECEIVE_CREDENTIAL) {
        try {

       
            
            const {message, sender, receiver, messageId, subject, originalMessageId} = req.body;
    
            if (message || sender || receiver || subject || originalMessageId) { 
                const queryOriginalId = originalMessageId.substring(1, originalMessageId.length-1)
                // replace RE with the actualy subject later but for now this is fine
                console.log("heres the query messageId:", queryOriginalId)
                Thread.findOne({messageId: queryOriginalId}).then(async(val,err) => {
                    if (err) {
                        console.log(err);
                        res.status(400).send(JSON.stringify(
                            {
                                code: "err",
                                message: "invalid request"
                            }
                        ))
                    } else {
                        console.log("heres the old thread,", val);
                        console.log("heres the new messageId", messageId)
                        
                        const response = await replyToEmail(receiver, sender, message, subject, messageId);
                        console.log("response", response.mail)

                        




                        val.messageId = response.mail.messageId.substring(1,response.mail.messageId.length-1);
                        await val.save();
                        if (response.scheduleCall) {
                            processOutreach(val.messageId, response.transcript);
                        }


                    }
                })


                

                
    
    
            } else {
                res.status(400).send(JSON.stringify({
                    code: "err",
                    message: "invalid request"
                }))
            }
    
    
    
    
    
    
    
        } catch(e) {
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




app.post('/doOutreach', async (req,res) => {
    try {
        const {internalCredential, uuid, data, area} = req.body;
        const {processOutreach} = require("./utils.js")
        console.log(internalCredential)
        // console.log(processLeadConversion)
        // const uuid = req.body.uuid;
        // const data = req.body.data;


        // Data is a list with json

        // 




        if (internalCredential === process.env.RECEIVE_CREDENTIAL) {

            User.findOne({uuid: uuid}).then(async (user,err) => {
                if (err) {
                    console.log(err)
                    res.status(400).send(JSON.stringify({
                        code: "err",
                        message: "invalid request"
                    }))
                } else {
                    if (user) {
                        const senderEmail = user.aiSettings.name + "@sniphomes.com";
                        processOutreach(data, senderEmail, user.aiSettings.name, user.uuid).then((idList) => {
                            console.log("idList",idList)
                            idList.map((id,i) => {

                                const messageId = id.substring(1, id.length-1)
                            const newThread = new Thread({
                                messageId: messageId,
                                sender: senderEmail,
                                receiver: data[i].email,
                                callFeature: user.aiSettings.callFeature,
                                area: area,

                            })

                            newThread.save()

                            })

                            res.status(200).send(JSON.stringify({
                                code: "ok",
                                message: "success"
                            }))
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
        




        





    } catch(e) {
        console.log(e)
        res.status(404).send(JSON.stringify({
            code: "err",
            message: "not found"
        }))
    }
})


async function summarizeLeadDetails(transcript, email) {

    let readableTranscript = "";
    for (let i=transcript.length-1; i>0; i--) {
        if (email === transcript[i].sender) {
            readableTranscript += "Me: " + transcript[i].message
        } else {
            readableTranscript += "Other Person: " + transcript[i].message;
        }
        readableTranscript += "\n\n"
        
    }

    const content = await model.generateContent("You will be provided an email transcript of a conversation. I want you to pinpoint a 3 sentence summary of the conversation (especially the conclusion of the conversation). These conversations are real estate cold emails so don't mention that as the person reading the summary will already have that context.")
    return content;
}




function processLeadConversion(messageId, transcript) {
    if (messageId) {    

        Thread.findOne({messageId: messageId}).then(async(thread, err) => {
            if (err) {
                console.log(err)
                return err
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

                        const newLead = new Lead({
                            uuid: thread.uuid,
                            date: new Date.now(),
                            area: thread.area,
                            leadDetails: leadDetails,
                            transcript: transcript,
                        });

                        newLead.save();

                        return;
                
                    }
                    
                } else {
                    console.log("Message Id is invalid");
                    return;

                }
            }
        })



    } else {
        console.log("Process Lead Conversion went wrong")
        return
    }



}







app.get("/", (req,res) => {
    res.send("Hello world")
})






server.listen(process.env.PORT, (req,res) => {
    console.log("Listening on port ", process.env.PORT);
})








// exports.processLeadConversion = processLeadConversion;
module.exports = {processLeadConversion}











