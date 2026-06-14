export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
    res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
        const { audioBase64 } = req.body;

        if (!audioBase64) {
            throw new Error("No audio data provided");
        }

        // Base64 ko wapas binary Buffer mein convert karna
        const buffer = Buffer.from(audioBase64, 'base64');
        const blob = new Blob([buffer], { type: 'audio/webm' });
        
        const fd = new FormData();
        fd.append('file', blob, 'voicenote.webm');
        fd.append('model', 'whisper-large-v3');
        fd.append('temperature', '0.0');
        
        // Jaisa tune bola, sirf Urdu ke liye mana kiya hai, baaki sab allowed hai
        fd.append('prompt', 'Please transcribe the audio accurately. Do not use Urdu script under any circumstances.');

        const response = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.GROQ_API_KEY}` // Yahan teri Vercel wali chupi hui key use hogi
            },
            body: fd
        });

        const data = await response.json();
        
        if (!response.ok) {
            throw new Error(data.error?.message || "Groq Transcription Error");
        }

        res.status(200).json(data);
    } catch (error) {
        console.error("Transcription Error:", error);
        res.status(500).json({ error: error.message || "Failed to transcribe audio" });
    }
}
