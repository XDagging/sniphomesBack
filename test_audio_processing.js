const { resample } = require('wave-resampler');
const { mulaw } = require('alawmulaw');

// Simulate 1 second of 24kHz audio (Linear16)
// A simple sine wave at 440Hz
const sampleRateIn = 24000;
const sampleRateOut = 8000;
const duration = 1; // seconds
const frequency = 440; // Hz
const numSamplesIn = sampleRateIn * duration;

// Create input buffer (Linear16)
const inputBuffer = Buffer.alloc(numSamplesIn * 2);
for (let i = 0; i < numSamplesIn; i++) {
    const t = i / sampleRateIn;
    const sample = Math.sin(2 * Math.PI * frequency * t);
    // Convert float [-1, 1] to Int16 [-32768, 32767]
    const int16Sample = Math.max(-32768, Math.min(32767, Math.floor(sample * 32767)));
    inputBuffer.writeInt16LE(int16Sample, i * 2);
}

console.log(`Input Buffer Size: ${inputBuffer.length} bytes`);
console.log(`Input Samples: ${numSamplesIn}`);

// --- PROPOSED FIX LOGIC ---

// 1. Convert Buffer (Linear16) to Int16Array samples
const inputSamples = new Int16Array(
    inputBuffer.buffer,
    inputBuffer.byteOffset,
    inputBuffer.length / 2
);

console.log(`Input Int16Array Length: ${inputSamples.length}`);

// 2. Resample (24k -> 8k)
// Note: wave-resampler expects an array of samples.
// Let's verify what it returns.
try {
    const resampledSamples = resample(inputSamples, sampleRateIn, sampleRateOut);
    console.log(`Resampled Output Type: ${resampledSamples.constructor.name}`);
    console.log(`Resampled Output Length: ${resampledSamples.length}`);

    // Expected output length: 8000 samples
    const expectedLength = sampleRateOut * duration;
    console.log(`Expected Length: ${expectedLength}`);

    if (Math.abs(resampledSamples.length - expectedLength) > 100) {
        console.error("WARNING: Resampled length mismatch!");
    }

    // 3. Encode to Mulaw
    // mulaw.encode expects Int16Array. 
    // If resample returns a normal Array or Float32Array, we might need to cast it.
    // Let's check if we need to convert resampledSamples to Int16Array first.

    let samplesForEncoding = resampledSamples;
    if (!(resampledSamples instanceof Int16Array)) {
        console.log("Converting resampled output to Int16Array for encoding...");
        // If it's float, we might need to scale it back if resample normalized it?
        // But wave-resampler usually preserves the range if it's just downsampling.
        // Let's assume it returns numbers in the same range (-32768 to 32767).
        samplesForEncoding = new Int16Array(resampledSamples);
    }

    const mulawSamples = mulaw.encode(samplesForEncoding);
    console.log(`Mulaw Output Type: ${mulawSamples.constructor.name}`);
    console.log(`Mulaw Output Length: ${mulawSamples.length}`);

    // 4. Create Buffer
    const mulawBuffer = Buffer.from(mulawSamples);
    console.log(`Final Buffer Size: ${mulawBuffer.length} bytes`);

    console.log("SUCCESS: Pipeline completed without errors.");

} catch (error) {
    console.error("ERROR in pipeline:", error);
}
