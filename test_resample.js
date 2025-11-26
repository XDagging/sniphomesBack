const waveResampler = require('wave-resampler');

// Simulate 1 second of 24kHz audio (16-bit mono)
// 24000 samples * 2 bytes/sample = 48000 bytes
const sampleRate = 24000;
const targetRate = 8000;
const numSamples = 24000;
const byteLength = numSamples * 2;

const buffer = Buffer.alloc(byteLength);
// Fill with some dummy data (e.g. silence or pattern)
for (let i = 0; i < numSamples; i++) {
    buffer.writeInt16LE(i % 32767, i * 2);
}

console.log('--- Test 1: Raw Buffer Input ---');
try {
    const output = waveResampler.resample(buffer, sampleRate, targetRate, {
        method: "sinc",
        LPF: true,
        bitDepth: 16
    });
    console.log('Output Type:', output.constructor.name);
    console.log('Output Length:', output.length);
    if (output.length > 0) {
        console.log('First few bytes/samples:', output.slice(0, 10));
    }
    // Expected samples: 8000
    // If output is Buffer, length should be 16000 bytes.
    // If output is Array/Int16Array, length should be 8000.
} catch (e) {
    console.error('Error:', e.message);
}

console.log('\n--- Test 2: Int16Array Input ---');
try {
    const int16Input = new Int16Array(buffer.buffer, buffer.byteOffset, numSamples);
    const output = waveResampler.resample(int16Input, sampleRate, targetRate, {
        method: "sinc",
        LPF: true,
        bitDepth: 16
    });
    console.log('Output Type:', output.constructor.name);
    console.log('Output Length:', output.length);
    if (output.length > 0) {
        console.log('First few samples:', output.slice(0, 10));
    }
} catch (e) {
    console.error('Error:', e.message);
}

console.log('\n--- Test 3: Array of Numbers Input ---');
try {
    const arrayInput = [];
    for (let i = 0; i < numSamples; i++) {
        arrayInput.push(buffer.readInt16LE(i * 2));
    }
    const output = waveResampler.resample(arrayInput, sampleRate, targetRate, {
        method: "sinc",
        LPF: true,
        bitDepth: 16
    });
    console.log('Output Type:', output.constructor.name);
    console.log('Output Length:', output.length);
} catch (e) {
    console.error('Error:', e.message);
}
