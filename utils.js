require('dotenv').config()
const AWS = require("aws-sdk")
const nodemailer = require("nodemailer")
const {GoogleGenerativeAI} = require("@google/generative-ai");
const genAI = new GoogleGenerativeAI(process.env.GEMINI_KEY);
const EmailReplyParser = require("email-reply-parser");
const {callSomeone, bookedCalls} = require("./app")
const REGION = "us-east-1"

const model = genAI.getGenerativeModel({
  model: "gemini-1.5-flash",
  generationConfig: {
      temperature: 0.2,
      // 0.2
  },  
});


AWS.config.update({
    accessKeyId: process.env.AWS_ACCESS_KEY,
    secretAccessKey: process.env.AWS_SECRET_KEY,
    region: REGION
})


const transporter = nodemailer.createTransport({
  SES: new AWS.SES({ region: REGION})
})



// const ses = new AWS.SES({apiVersion: '2010-12-01'});

async function deliverMail(to, from, message, subject, messageId) {
  const response = await transporter.sendMail({
    from: from, 
    to: to,
    // replyTo: to,
    subject: subject,
    text: message,
    inReplyTo: messageId,
    // attachments: []
  })
  return response
}

function processOutreach(data, senderEmail,) {
  console.log(data)
    // Data Schema: [{name, email area, action, agentName}]
    // Action means buying or selling
    let messageIdList = []

    data.forEach(async (piece,i) => {

        if (piece.action.toLowerCase() === "buy") {
            
            const bodyMessage = `Hey ${piece.name}\n\nI'm ${piece.agentName}, a local real estate agent in ${piece.area}.\n\nThere's an affordable house nearby that's recently been put on sale.\n\nI'd be delighted to chat with you more about it.`
            const bodyFooter = `\n\nLooking forward to your response,\n${piece.agentName}\nReal Estate`;
            const bodySubject = `New home in ${piece.area}`;


            const response = await deliverMail(piece.email, senderEmail, bodyMessage + "\n\n" + bodyFooter, bodySubject)
          
            // const response = await transporter.sendMail({
            //   from: "john@sniphomes.com", 
            //   to: piece.email,
            //   subject: bodySubject,
            //   text: bodyMessage + "\n\n" + bodyFooter,
            //   // attachments: []
            // })
            console.log(response.messageId);

            messageIdList.push(response.messageId);
            // return response.messageId;

            // const params = {
            //     Destination: {
            //       ToAddresses: [piece.email]
            //     },
            //     Message: {
            //       Body: {
            //         Text: { Data: bodyMessage + bodyFooter}
            //       },
            //       Subject: { Data: bodySubject }
            //     },
            //     Source: 'inquires@sniphomes.com'
            //   };



            // ses.sendEmail(params, function(err, data) {
            //     if (err) {
            //         console.log(err, err.stack);
            //     } else {
            //         console.log(data);
            //     }     	 
            // });

            

        } else if (piece.action.toLowerCase() === "sell") {
            const bodyMessage = `Hey ${piece.name}\n\nI'm ${piece.agentName}, a local real estate agent in ${piece.area}.\n\nI saw that you lived in ${piece.area} and was wondering if selling your home is something you'd be open to, the market right now is huge.\n\nI'd be delighted to chat with you more about it.`
            const bodyFooter = `\n\nBest Regards,\n${piece.agentName}\nReal Estate`;
            const bodySubject = `${piece.area} is booming`;


            const response = await deliverMail(piece.email, "john@sniphomes.com", bodyMessage + "\n\n" + bodyFooter, bodySubject)
      
            console.log(response)
        } else {
          console.log("Incomplete data:",i)
        }
        




    })

    return messageIdList;
}




function processEmailChain(transcript) {
    let parsedChain = "";
    for (let i=0; i<transcript.length;i++) {
        if (transcript[i] !== ">") {
          parsedChain += transcript[i]  
        }
        
        
    }
    parsedChain = parsedChain.split("\n\n")
    console.log(parsedChain)
    let fullTranscript = []
    parsedChain.map((item, i) => {
        if ((item.indexOf("@") > 0) && (item.indexOf("<") > 0) && (item.indexOf("wrote:") > 0)) {


              fullTranscript.push({sender: item.split("<")[1].split(" ")[0].trim(), message: item.split("wrote:\n")[1] || ""})
            
            
        } else {
  
    if (i === 0) {
      fullTranscript.push({message: item, sender: null})
    } else {
    fullTranscript[fullTranscript.length-1].message += item.trim()
    }
            
        }
  
        
    })
    return fullTranscript
	

    
}


const y = `Wednesday morning works for me.

On Mon, Dec 16, 2024 at 9:16 PM <john@sniphomes.com> wrote:

> Hey there!
>
> Thanks for reaching out!  To best help you find the perfect house, I need
> a little more information about what you're looking for.  Things like your
> budget, desired location, and the type of property you're interested in
> (house, condo, etc.) would be incredibly helpful.
>
> A quick phone call would be the best way to discuss your needs and show
> you some properties that match your criteria.  Would you be free for a
> brief chat sometime this week?  I'm available Tuesday afternoon or Thursday
> morning.  Let me know what works best for you!
>
> Looking forward to hearing from you!
>
> Best regards,
>
> John
>
>
> On Tue, December 17, 2024 at 2:16 AM xdagging <xdagging@gmail.com> wrote:
> hey what houses do you got pal!
>`


console.log(processEmailChain(y));




async function replyToEmail(sendEmail, receiveEmail, transcript, subject,messageId) {
  // We are assuming that transcript if a list with an object with two keys in it

  // best regards = selling
  // looking forwards to your response = buyer

  // external (boolean)
  // message (string)
  // sendEmail          
  const name = sendEmail.split("@")[0].toLowerCase().substring(0,1).toUpperCase() + sendEmail.split("@")[0].toLowerCase().substring(1)
  console.log(transcript);
  let iterableTranscript = processEmailChain(transcript);

  let readableTranscript = ""
  // email =  new EmailReplyParser().read(transcript);
  // readableTranscript = email.getVisibleText()
  // console.log("Heres the readable transcript:", readableTranscript)


  
  let isBuying

  iterableTranscript.map((item) => {
    if ((item.sender === sendEmail) || (item.sender === null)) {
        
        readableTranscript += `You: ${item.message}`
        if (item.message.toLowerCase().indexOf("best regards") > 0) {
          isBuying = false;
        } else {
          isBuying = true;
        }



    } else {
        readableTranscript += `Other person: ${item.message}`
    }
    readableTranscript += "\n\n"
  })
  console.log(iterableTranscript)

  console.log("We think that this is a buying conversation",isBuying)
  let prompt = "";
  if (isBuying) {
    prompt = `
    You are an AI acting as "John," an assistant for a professional real estate agent. You are tasked with responding to email inquiries in a friendly, professional, and engaging tone.
    You're goal is also to see if they are in the market to buy a house, and if so, schedule a call with them.
  
  You will be provided with the transcript of the email exchange. Based on the context, craft a reply that:
  
  Addresses the person's questions or concerns.
  Highlights the value of a phone call to discuss their real estate needs further.
  Includes a clear call-to-action to schedule a phone call, offering specific times or a link to schedule one.
  Maintains a warm and approachable tone that builds trust and rapport.
  Keep responses concise yet detailed enough to demonstrate professionalism and expertise. Always end the message in a way that invites further communication.
  Keep responses short unless it is necessary for it to be long
  Don't leave any brackets at all. 
  Don't include a footer at all (things like sincerely or best regards)
  You are always available to call
  Respond in JSON format {message: String, planCall: Boolean, scheduleCall: String, shouldRespond: Boolean}
  If you don't think that you need to respond to an email, put the shouldRespond value as false (this could happen once you plan a call or after a farewell)
  If you receive a date for a planned call, put the scheduleCall value with the following: month/day/year hour:minute AM/PM
  If you receive a phone number for a planned call, put the phone number in the phoneNumber field.
  If the person is available to text in that instant, put the scheduleCall value as "now"
  Example Response Template:

  {
    message: "Hey," + \n\n + "Thank you for reaching out!" + \n\n + "I'd love to dicuss this further and provide tailored advice to help with your real estate goals. When would be a good time for a quick call?" + \n\n + "Just provide me your phone number and I'll reach out."
    planCall: false,
    scheduleCall: 12/18/2024 4:18 PM,
    shouldRespond: true,
    phoneNumber: null;
  }
  
  
  Here's the latest message: ${iterableTranscript[0]}
  
  Heres the transcript of the conversation so far (including the latest message): 
  
    ${readableTranscript}
    
    `
  } else {
    prompt = `
    You are an AI acting as "John," an assistant for a professional real estate agent. You are tasked with responding to email inquiries in a friendly, professional, and engaging tone.
    You're goal is also to see if they are in the market to sell their house, and if so, schedule a call with them.
  
  You will be provided with the transcript of the email exchange. Based on the context, craft a reply that:
  
  Addresses the person's questions or concerns.
  Highlights the value of a phone call to discuss their real estate needs further.
  Includes a clear call-to-action to schedule a phone call, offering specific times or a link to schedule one.
  Maintains a warm and approachable tone that builds trust and rapport.
  Keep responses concise yet detailed enough to demonstrate professionalism and expertise. Always end the message in a way that invites further communication.
  Keep responses short unless it is necessary for it to be long
  Don't leave any brackets at all. 
  Don't include a footer at all (things like sincerely or best regards)
  Put the character (backslash + n) when you want to go to the next line

    You are always available to call
  Respond in JSON format {message: String, planCall: Boolean, scheduleCall: String, shouldRespond: Boolean}
  If you don't think that you need to respond to an email, put the shouldRespond value as false (this could happen once you plan a call or after a farewell)
  If you receive a date for a planned call, put the scheduleCall value with the following: month/day/year hour:minute AM/PM
   If the person is available to text in that instant, put the scheduleCall value as "now"
  Example Response Template:

  {
    message: "Hey," + \n\n + "Thank you for reaching out!" + \n\n + "I'd love to dicuss this further and provide tailored advice to help with your real estate goals. When would be a good time for a quick call?" + \n\n + "Just provide me your phone number and I'll reach out."
    planCall: true,
    scheduleCall: 12/18/2024 4:18 PM,
    shouldRespond: true,
  }
  
  
  
  Here's the latest message: ${iterableTranscript[0]}
  
  Heres the transcript of the conversation so far (including the latest message): 
  
    ${readableTranscript}
    
    `

  }



  const result = await model.generateContent(prompt);




                                                        
  console.log(result.response.text())

  const today = new Date();
  let formattedDate = today.toLocaleDateString('en-US', { 
    weekday: 'long', 
    month: 'long', 
    day: 'numeric', 
    year: 'numeric' 
  });
  let finalizedDate = ""
  formattedDate.split(",").map((val, i) => {
    if (i===0) {
      finalizedDate += val.substring(0,3) + ","
    } else if (i !== formattedDate.split(",").length-1) {
      finalizedDate += val + ",";
    } else {
      finalizedDate += val;
    }
      
  })

  const finalizedText = result.response.text() 

  

  const w =  "\n\n" + (isBuying ? "Best Regards," : "Looking forward to your response,") + "\n" + name + `\n\nOn ${finalizedDate} at ${new Date().toLocaleString('en-US', { hour: 'numeric', minute: 'numeric', hour12: true })} ${receiveEmail.split("@")[0]} <${receiveEmail}> wrote:\n` + transcript 
  // On Thu, Dec 12, 2024 at 7:27 PM XDagging <xdagging@gmail.com> wrote:
  // console.log(finalizedText.split("{")[1].split("}")[0])
  const processJson = JSON.parse("{"+ finalizedText.split("{")[1].split("}")[0] + "}")
  processJson.message = processJson.message + w
  if ((planCall)) {


    processLeadConversion(messageId, iterableTranscript.unshift({
      sender: replySender, message: result.response.text()
    }));
    // if (scheduleCall === "now") {
    //   callSomeone(processJson.phoneNumber, name, null, (isBuying ? "buy": "sell"), receiveEmail)
    // } else {
    //   const timeNow = Date.now();
    //   const timeThen = new Date(scheduleCall).getTime();
    //   const timeout = setTimeout(() => {
    //     callSomeone(processJson.phoneNumber, name, null, (isBuying ? "buy": "sell"), receiveEmail)

    //   },timeNow-timeThen)

    //   bookedCalls.set(receiveEmail, timeout);
    // }
     
  }

  let replySender = sendEmail.split("@")[0] + "@" + sendEmail.split("@")[1]
  // const messageId = "CAJHLaOmpWXQ53EKA842yhtPQbgrDmdprays-Dnqj4AsdDgn6Aw@mail.gmail.com"
  console.log(replySender)
  deliverMail(receiveEmail, replySender, processJson.message, subject, messageId)




}


const x = 'get out of here buddy\n' +
    '\n' +
    'On Thu, Dec 12, 2024 at 7:27 PM XDagging <xdagging@gmail.com> wrote:\n' +
    '\n' +
    '> asdfasdf\n' +
    '>\n' +
    '> On Tue, Dec 10, 2024 at 9:11 PM <john@sniphomes.com> wrote:\n' +
    '>\n' +
    '>> Hi John Doe,\n' +
    '>>\n' +
    ">> Howdy partner!  I see you're interested in finding an affordable house in\n" +
    ">> Bethesda.  My name is Ben, and I'm a local real estate agent.  I understand\n" +
    '>> you sent some... less-than-clear messages previously.  I apologize if my\n' +
    ">> previous message was unclear.  I'm reaching out because there's a great\n" +
    '>> property that just hit the market that might be perfect for you, and I\n' +
    '>> wanted to let you know about it personally.\n' +
    '>>\n' +
    '>> To give you the best information and make sure this property is a good\n' +
    '>> fit for your needs, a quick phone call would be incredibly helpful.  We can\n' +
    '>> discuss your specific requirements, budget, and timeline in more detail.\n' +
    '>>\n' +
    ">> Would you be free for a brief chat sometime this week?  I'm available on\n" +
    '>> Wednesday afternoon or Thursday morning.  Alternatively, please let me know\n' +
    ">> what times work best for you and I'll do my best to accommodate.\n" +
    '>>\n' +
    '>> Looking forward to hearing from you and helping you find your dream home!\n' +
    '>>\n' +
    '>> Best regards,\n' +
    '>>\n' +
    '>> John (Assistant to Ben)\n' +
    '>>\n' +
    '>\n'


// console.log(x)
// replyToEmail("john@sniphomes.com", "xdagging@gmail.com", x, 'RE', "CAJHLaOm=fme2_eVZiV+B=1M6DC5U11sj6XcBkr0An4wdqq=6Sg@mail.gmail.com")


const testData = [{
  name: 'Sebastian',
  email: "xdagging@gmail.com",
  action: "sell",
  agentName: "Smith",
  area: "Orange County",
  emailSender: "john@sniphomes.com"
}]
// [{name, email area, action, agentName}]

// processOutreach(testData,"john@sniphomes.com")

//  [{external: false, message: "hello im a real estate agent named john and i saw you own a house at 9212 cedarcrest dr and wanted to talk more about your property"}, {external: true, message: "idk im not too sure if i want to talk about my property"}]



module.exports = {processOutreach, replyToEmail};

