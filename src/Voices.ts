import * as speech from '@google-cloud/speech';
import { TextToSpeechClient } from '@google-cloud/text-to-speech';
import * as waveResampler from 'wave-resampler';
import { mulaw } from 'alawmulaw';
import fs from 'fs';
import type { Call } from './Call';

export class Voices {
  call:                Call;
  callSid:             string;
  googleSpeechClient:  speech.SpeechClient;
  ttsClient:           TextToSpeechClient;
  googleSpeechStream:  ReturnType<speech.SpeechClient['streamingRecognize']> | null;
  ttsStream:           ReturnType<TextToSpeechClient['streamingSynthesize']> | null;
  backgroundAudio:     Buffer | null;
  backgroundInterval:  ReturnType<typeof setInterval> | null;

  constructor(parentCall: Call) {
    this.call               = parentCall;
    this.callSid            = parentCall.callSid;
    this.googleSpeechClient = new speech.SpeechClient();
    this.ttsClient          = new TextToSpeechClient();
    this.googleSpeechStream = null;
    this.ttsStream          = null;
    this.backgroundAudio    = null;
    this.backgroundInterval = null;

    try {
      this.backgroundAudio = fs.readFileSync('ulawOfficeAmbience.wav');
    } catch (_) {
      console.error(`[${this.callSid}] Could not load background audio file.`);
    }
  }

  startGoogleSpeechStream(): void {
    if (this.googleSpeechStream) {
      this.googleSpeechStream.destroy();
      this.googleSpeechStream = null;
    }

    console.log(`[${this.callSid}] Starting new Google STT stream.`);

    this.googleSpeechStream = this.googleSpeechClient
      .streamingRecognize({
        config: {
          encoding:        'MULAW' as const,
          sampleRateHertz: 8000,
          languageCode:    'en-US',
        },
        interimResults: true,
      })
      .on('error', (error: Error) => {
        console.error(`[${this.callSid}] STT Error:`, error);
      })
      .on('data', (data: { results: Array<{ alternatives: Array<{ transcript: string }>; isFinal: boolean }> }) => {
        const result = data.results[0];
        if (result && result.alternatives[0]) {
          const transcript = result.alternatives[0].transcript.trim();

          if ((this.call.sendingAudio || this.call.twilioPlaying) && transcript.length > 0) {
            console.log(`[${this.callSid}] User interrupting AI (STT): "${transcript}"`);
            this.call.interrupted      = true;
            this.call.shouldHangup     = false;
            this.call.sendingAudio     = false;
            this.call.twilioPlaying    = false;

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
            this.call.shouldHangup         = false;
            this.call.isTransferring       = false;
            this.call.sendClear();
          }

          if (result.isFinal) {
            console.log(`[${this.callSid}] [${Date.now()}] STT Final: "${transcript}"`);
            this.call.timeWhenUserHasFinishedSpeaking = process.hrtime.bigint();

            if (this.call.speechTimeout) {
              clearTimeout(this.call.speechTimeout);
              this.call.speechTimeout = null;
            }
            this.call.userSpeaking  = false;
            this.call.messageNumber += 1;
            void this.call.processLLM(transcript);
          } else if (transcript.length > 2 && (this.call.sendingAudio || this.call.twilioPlaying)) {
            console.log(`[${this.callSid}] Interrupting because of interim results`);
            this.call.interrupted   = true;
            this.call.sendingAudio  = false;
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
            this.call.shouldHangup         = false;
            this.call.sendClear();
          }
        }
      });
  }

  stopGoogleSpeechStream(): void {
    if (this.googleSpeechStream) {
      console.log(`[${this.callSid}] Stopping Google STT stream.`);
      this.googleSpeechStream.end();
    }
  }

  setupGoogleTTSStream(): ReturnType<TextToSpeechClient['streamingSynthesize']> {
    const stream = this.ttsClient.streamingSynthesize();

    stream.on('data', (response: { audioContent?: Buffer }) => {
      this.call.aiTalking    = false;
      this.call.interrupted  = false;
      this.call.sendingAudio = true;
      this.call.twilioPlaying = true;
      const { audioContent } = response;

      if (audioContent && audioContent.length > 0) {
        console.log(`[${this.callSid}] Received audio chunk from Google TTS`, audioContent.length);
        if (this.call.interrupted) return;

        const inputSamples: number[] = [];
        for (let i = 0; i < audioContent.length; i += 2) {
          inputSamples.push(audioContent.readInt16LE(i));
        }

        const resampledData = waveResampler.resample(inputSamples, 24000, 8000, {
          method:   'sinc',
          LPF:      true,
          bitDepth: 16,
        });

        const pcm8kInt16 = new Int16Array(resampledData.length);
        for (let i = 0; i < resampledData.length; i++) {
          pcm8kInt16[i] = resampledData[i];
        }

        const mulawSamples = mulaw.encode(pcm8kInt16);
        const mulawBuffer  = Buffer.from(mulawSamples);
        const audioChunk   = mulawBuffer.toString('base64');
        this.call.sendAudioChunk(audioChunk);

        const durationInMs = (mulawBuffer.length / 8000) * 1000;
        const now          = Date.now();
        this.call.estimatedPlaybackEnd = Math.max(this.call.estimatedPlaybackEnd, now) + durationInMs;

        if (this.call.playbackTimeout) clearTimeout(this.call.playbackTimeout);

        this.call.twilioPlaying = true;
        const timeUntilEnd      = this.call.estimatedPlaybackEnd - now;

        this.call.playbackTimeout = setTimeout(() => {
          if (!this.call.interrupted) this.sendBackgroundAudio();
          this.call.twilioPlaying = false;
          this.call.sendingAudio  = false;

          if (this.call.shouldHangup) {
            console.log(`[${this.callSid}] Audio finished, executing delayed hangup.`);
            void this.call.hangup();
          } else if (this.call.isTransferring) {
            console.log(`[${this.callSid}] Audio finished, executing delayed transfer.`);
            void this.call.transferCall();
          }
        }, timeUntilEnd + 500);
      }
    });

    stream.on('error', (err: Error) => {
      console.error(`[${this.callSid}] Google TTS Stream Error:`, err);
    });

    const voiceName = this.call.config.ttsVoice ?? 'en-US-Chirp3-HD-Puck';

    stream.write({
      streamingConfig: {
        audioConfig: {
          audioEncoding:   'LINEAR16',
          sampleRateHertz: 24000,
        },
        voice: {
          languageCode: 'en-US',
          name:         voiceName,
        },
      },
    });

    this.startGoogleSpeechStream();
    this.ttsStream = stream;
    return stream;
  }

  sendBackgroundAudio(): void {
    if (!this.backgroundAudio) return;

    console.log(`[${this.callSid}] WE ARE SENDING BACKGROUND AUDIO`);
    this.call.alreadySending = true;

    if (this.backgroundInterval) clearInterval(this.backgroundInterval);

    const sampleRate     = 8000;
    const packetDuration = 20;
    const chunkSize      = Math.ceil(sampleRate * (packetDuration / 1000));
    let offset           = 44;

    this.call.sendingAudio          = true;
    this.call.sendingBackgroundAudio = true;

    this.backgroundInterval = setInterval(() => {
      if (this.call.twilioPlaying) {
        this.stopBackgroundAudio();
        return;
      }

      if (offset >= this.backgroundAudio!.length) offset = 44;

      const end        = Math.min(offset + chunkSize, this.backgroundAudio!.length);
      const chunk      = this.backgroundAudio!.slice(offset, end);
      const audioChunk = chunk.toString('base64');
      this.call.sendAudioChunk(audioChunk);
      offset += chunkSize;
    }, packetDuration);
  }

  stopBackgroundAudio(): void {
    if (this.backgroundInterval) {
      clearInterval(this.backgroundInterval);
      this.backgroundInterval = null;
    }
    this.call.sendingAudio          = false;
    this.call.alreadySending        = false;
    this.call.sendingBackgroundAudio = false;
  }
}

export default Voices;
