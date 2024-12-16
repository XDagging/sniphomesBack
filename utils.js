require('dotenv').config()
const AWS = require("aws-sdk")
const nodemailer = require("nodemailer")
const {GoogleGenerativeAI} = require("@google/generative-ai");
const genAI = new GoogleGenerativeAI(process.env.GEMINI_KEY);
const EmailReplyParser = require("email-reply-parser");

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

function processOutreach(data) {
  console.log(data)
    // Data Schema: [{name, email area, action, agentName}]
    // Action means buying or selling


    data.forEach(async (piece) => {

        if (piece.action.toLowerCase() === "buy") {

            const bodyMessage = `Hey ${piece.name}\n\nI'm ${piece.agentName}, a local real estate agent in ${piece.area}.\n\nThere's an affordable house nearby that's recently been put on sale.\n\nI'd be delighted to chat with you more about it.`

            const bodyFooter = `\n\nLet me know soon,\n${piece.agentName}\nReal Estate`
            const bodySubject = `New home in ${piece.area}`


            const response = await deliverMail(piece.email, "john@sniphomes.com", bodyMessage + "\n\n" + bodyFooter, bodySubject)
          
            // const response = await transporter.sendMail({
            //   from: "john@sniphomes.com", 
            //   to: piece.email,
            //   subject: bodySubject,
            //   text: bodyMessage + "\n\n" + bodyFooter,
            //   // attachments: []
            // })
            console.log(response)

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

            

        }
        




    })
}




function processEmailChain(transcript) {
    let parsedChain = "";
    for (let i=0; i<transcript.length;i++) {
        if (transcript[i] !== ">") {
          parsedChain += transcript[i]  
        }
        
        
    }
    parsedChain = parsedChain.split("\n\n")

    let fullTranscript = []
    parsedChain.map((item, i) => {
        if ((item.indexOf("@") > 0) && (item.indexOf("<") > 0) && (item.indexOf("wrote:") > 0)) {
            fullTranscript.push({sender: item.split("<")[1].split(" ")[0].trim(), message: ""})
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





async function replyToEmail(sendEmail, receiveEmail, transcript, subject,messageId) {
  // We are assuming that transcript if a list with an object with two keys in it

  // external (boolean)
  // message (string)
  // sendEmail          
  let iterableTranscript = processEmailChain(transcript);

  let readableTranscript = ""
  // email =  new EmailReplyParser().read(transcript);
  // readableTranscript = email.getVisibleText()
  // console.log("Heres the readable transcript:", readableTranscript)


  iterableTranscript.map((item) => {
    if ((item.sender === sendEmail) || (item.sender === null)) {
        readableTranscript += `You: ${item.message}`
    } else {
        readableTranscript += `Other person: ${item.message}`
    }
    readableTranscript += "\n\n"
  })
  console.log(iterableTranscript)





  const prompt = `You are an AI acting as "John," an assistant for a professional real estate agent. You are tasked with responding to email inquiries in a friendly, professional, and engaging tone. Your primary goal is to encourage the person you're corresponding with to schedule a phone call with you or the real estate agent.







You will be provided with the transcript of the email exchange. Based on the context, craft a reply that:

Addresses the person's questions or concerns.
Highlights the value of a phone call to discuss their real estate needs further.
Includes a clear call-to-action to schedule a phone call, offering specific times or a link to schedule one.
Maintains a warm and approachable tone that builds trust and rapport.
Keep responses concise yet detailed enough to demonstrate professionalism and expertise. Always end the message in a way that invites further communication.

Example Response Template:
"Hi [Recipient's Name],

Thank you for reaching out! [Personalized response addressing their question or comment].

I’d love to discuss this further and provide tailored advice to help with your real estate goals. When would be a good time for a quick call? I'm available anytime, or we can find another time that works for you.

Just provide me your phone number and I'll reach out

Looking forward to connecting soon!

Best regards,
John
"

Here's the latest message: ${transcript[transcript[0]]}

Heres the transcript of the conversation so far (including the latest message): 

  ${readableTranscript}
  
  `

  const result = await model.generateContent(prompt)

  
  console.log(result.response.text())

  const finalizedText = result.response.text()

  let replySender = sendEmail.split("@")[0] + "@" + sendEmail.split("@")[1]
  // const messageId = "CAJHLaOmpWXQ53EKA842yhtPQbgrDmdprays-Dnqj4AsdDgn6Aw@mail.gmail.com"
  console.log(replySender)
  deliverMail(receiveEmail, replySender, finalizedText, subject, messageId)




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

// processOutreach()

//  [{external: false, message: "hello im a real estate agent named john and i saw you own a house at 9212 cedarcrest dr and wanted to talk more about your property"}, {external: true, message: "idk im not too sure if i want to talk about my property"}]



module.exports = {processOutreach, replyToEmail};

