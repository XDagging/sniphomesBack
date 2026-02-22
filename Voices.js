const speech = require("@google-cloud/speech");
const { TextToSpeechClient } = require("@google-cloud/text-to-speech");
const waveResampler = require('wave-resampler');
const { mulaw } = require('alawmulaw');
const fs = require("fs");

class Voices {
    constructor(parentCall) {
        this.call = parentCall;
        this.callSid = parentCall.callSid;
        this.googleSpeechClient = new speech.SpeechClient();
        this.ttsClient = new TextToSpeechClient(process.env.GOOGLE_SPEECH_TO_TEXT_KEY);
        this.googleSpeechStream = null;
        this.ttsStream = null;
        this.backgroundAudio = null;
        this.backgroundInterval = null;

        try {
            this.backgroundAudio = fs.readFileSync("ulawOfficeAmbience.wav");
        } catch (e) {
            console.error(`[${this.callSid}] Could not load background audio file.`);
        }
    }

    startGoogleSpeechStream() {
        if (this.googleSpeechStream) {
            this.googleSpeechStream.destroy();
            this.googleSpeechStream = null;
        }

        console.log(`[${this.callSid}] Starting new Google STT stream.`);

        this.googleSpeechStream = this.googleSpeechClient
            .streamingRecognize({
                config: {
                    encoding: "MULAW",
                    sampleRateHertz: 8000,
                    languageCode: "en-US",
                },
                interimResults: true,
            })
            .on("error", (error) => {
                console.error(`[${this.callSid}] STT Error:`, error);
            })
            .on("data", (data) => {
                const result = data.results[0];
                if (result && result.alternatives[0]) {
                    const transcript = result.alternatives[0].transcript.trim();

                    if ((this.call.sendingAudio || this.call.twilioPlaying) && transcript.length > 0) {
                        // if (this.call.shouldHangup) {
                        //     console.log(`[${this.callSid}] Hangup pending. Ignoring interruption: "${transcript}"`);
                        //     return;
                        // }

                        console.log(`[${this.callSid}] User interrupting AI (STT): "${transcript}"`);
                        this.call.interrupted = true;
                        this.call.shouldHangup = false;
                        this.call.sendingAudio = false;
                        this.call.twilioPlaying = false;

                        this.stopBackgroundAudio();

                        if (this.call.playbackTimeout) {
                            clearTimeout(this.call.playbackTimeout);
                            this.call.playbackTimeout = null;
                        }

                        if (this.ttsStream) {
                            this.ttsStream.destroy();
                            this.ttsStream = null;
                        }

                        this.call.estimatedPlaybackEnd = 0;
                        this.call.shouldHangup = false;
                        this.call.isTransferring = false;

                        this.call.sendClear();
                    }

                    if (result.isFinal) {
                        console.log(`[${this.callSid}] [${Date.now()}] STT Final: "${transcript}"`);
                        this.call.timeWhenUserHasFinishedSpeaking = process.hrtime.bigint();

                        if (this.call.speechTimeout) {
                            clearTimeout(this.call.speechTimeout);
                            this.call.speechTimeout = null;
                        }
                        this.call.userSpeaking = false;
                        this.call.messageNumber += 1;
                        this.call.processLLM(transcript);
                    } else if (transcript.length > 2 && (this.call.sendingAudio || this.call.twilioPlaying)) {
                        console.log(`[${this.callSid}] Interrupting because of interim results`);
                        this.call.interrupted = true;
                        this.call.sendingAudio = false;
                        this.call.twilioPlaying = false;

                        if (this.call.playbackTimeout) {
                            clearTimeout(this.call.playbackTimeout);
                            this.call.playbackTimeout = null;
                        }

                        if (this.ttsStream) {
                            this.ttsStream.destroy();
                            this.ttsStream = null;
                        }

                        this.call.estimatedPlaybackEnd = 0;
                        this.call.shouldHangup = false;
                        this.call.sendClear();
                    }
                }
            });
    }

    stopGoogleSpeechStream() {
        if (this.googleSpeechStream) {
            console.log(`[${this.callSid}] Stopping Google STT stream.`);
            this.googleSpeechStream.end();
        }
    }

    setupGoogleTTSStream() {
        const stream = this.ttsClient.streamingSynthesize();

        stream.on('data', (response) => {
            this.call.aiTalking = false;
            this.call.interrupted = false;
            this.call.sendingAudio = true;
            this.call.twilioPlaying = true;
            const { audioContent } = response;

            if (audioContent && audioContent.length > 0) {
                console.log(`[${this.callSid}] Received audio chunk from Google TTS`, audioContent.length);
                if (this.call.interrupted) return;

                const inputSamples = [];
                for (let i = 0; i < audioContent.length; i += 2) {
                    inputSamples.push(audioContent.readInt16LE(i));
                }

                const resampledData = waveResampler.resample(inputSamples, 24000, 8000, {
                    method: "sinc",
                    LPF: true,
                    bitDepth: 16
                });

                const pcm8kInt16 = new Int16Array(resampledData.length);
                for (let i = 0; i < resampledData.length; i++) {
                    pcm8kInt16[i] = resampledData[i];
                }

                const mulawSamples = mulaw.encode(pcm8kInt16);
                const mulawBuffer = Buffer.from(mulawSamples);
                const audioChunk = mulawBuffer.toString("base64");
                this.call.sendAudioChunk(audioChunk);

                const durationInSec = this.call.calculatePlayback(mulawBuffer.length, 8000);
                const durationInMs = durationInSec * 1000;

                const now = Date.now();
                this.call.estimatedPlaybackEnd = Math.max(this.call.estimatedPlaybackEnd, now) + durationInMs;

                if (this.call.playbackTimeout) {
                    clearTimeout(this.call.playbackTimeout);
                }
                this.call.twilioPlaying = true;

                const timeUntilEnd = this.call.estimatedPlaybackEnd - now;

                this.call.playbackTimeout = setTimeout(() => {
                    if (!this.call.interrupted) {
                        this.sendBackgroundAudio();
                    }
                    this.call.twilioPlaying = false;
                    this.call.sendingAudio = false;

                    if (this.call.shouldHangup) {
                        console.log(`[${this.callSid}] Audio finished, executing delayed hangup.`);
                        this.call.hangup();
                    } else if (this.call.isTransferring) {
                        console.log(`[${this.callSid}] Audio finished, executing delayed transfer.`);
                        this.call.transferCall();
                    }
                }, timeUntilEnd + 500);
            }
        });

        stream.on('error', (err) => {
            console.error(`[${this.callSid}] Google TTS Stream Error:`, err);
        });

        const request = {
            streamingConfig: {
                audioConfig: {
                    audioEncoding: 'LINEAR16',
                    sampleRateHertz: 24000,
                },
                voice: {
                    languageCode: 'en-US',
                    name: 'en-US-Chirp3-HD-Puck',
                },
            },
        };
        stream.write(request);
        this.startGoogleSpeechStream();
        this.ttsStream = stream;
        return stream;
    }

    sendBackgroundAudio() {
        if (!this.backgroundAudio) return;

        console.log(`[${this.callSid}] WE ARE SENDING BACKGROUND AUDIO`);
        this.call.alreadySending = true;

        if (this.backgroundInterval) {
            clearInterval(this.backgroundInterval);
        }

        const sampleRate = 8000;
        const packetDuration = 20;
        const chunkSize = Math.ceil(sampleRate * (packetDuration / 1000));
        let offset = 44;

        this.call.sendingAudio = true;
        this.call.sendingBackgroundAudio = true;

        this.backgroundInterval = setInterval(() => {
            if (this.call.twilioPlaying) {
                this.stopBackgroundAudio();
                return;
            }

            if (offset >= this.backgroundAudio.length) {
                offset = 44;
            }

            const end = Math.min(offset + chunkSize, this.backgroundAudio.length);
            const chunk = this.backgroundAudio.slice(offset, end);
            const audioChunk = chunk.toString("base64");
            this.call.sendAudioChunk(audioChunk);
            offset += chunkSize;

        }, packetDuration);
    }

    stopBackgroundAudio() {
        if (this.backgroundInterval) {
            clearInterval(this.backgroundInterval);
            this.backgroundInterval = null;
        }
        this.call.sendingAudio = false;
        this.call.alreadySending = false;
        this.call.sendingBackgroundAudio = false;
    }
}

module.exports = Voices;
