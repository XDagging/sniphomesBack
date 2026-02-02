
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require("@google/generative-ai");
const genAI = new GoogleGenerativeAI(process.env.GEMINI_KEY);


// This should only handle the gemini calls.
class BrainService {

    

    cutAudio() {
        console.log("We are cutting the audio now!")
    }


    callLLM(transcript) {

        

        if (!transcript) {
             console.log(`[${this.callSid}] Empty transcript, restarting STT.`);
            this.aiTalking = false;
            this.startGoogleSpeechStream();
            return;
        } else if (this.currentlyCheckingAvailability) {
            console.log(`[${this.callSid}] Currently checking availability, skipping STT.`);
            return;
        }
    }





    

    


    
}