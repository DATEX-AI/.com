export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { messages, model, max_tokens } = req.body;

    const allowedModels = ["llama-3.3-70b-versatile", "meta-llama/llama-4-scout-17b-16e-instruct"];
    const selectedModel = allowedModels.includes(model) ? model : "llama-3.3-70b-versatile";

    const groqResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: selectedModel,
        max_tokens: max_tokens || 8192,
        messages: [
          { 
            role: "system", 
            content: "You are DATEX AI. Strictly follow these language rules: 1. Always auto-detect the user's language. 2. If the user says 'Hii', 'Hello' or types in English, reply ONLY in pure English. 3. If the user speaks/types in Hinglish or Hindi, reply in Hinglish/Hindi. 4. NEVER use Urdu language or Urdu script under any circumstances." 
          },
          ...messages
        ]
      })
    });

    const data = await groqResponse.json();

    if (!groqResponse.ok) {
      const status = groqResponse.status || 500;
      return res.status(status).json({ error: data.error?.message || 'Groq API error', isRateLimit: status === 429 });
    }

    return res.status(200).json(data);
    
  } catch (error) {
    console.error('Chat API Error:', error);
    const msg = error.message || 'Server error';
    const isRate = msg.includes('429') || msg.toLowerCase().includes('rate limit') || msg.toLowerCase().includes('too many requests');
    return res.status(isRate ? 429 : 500).json({ error: 'Server error', isRateLimit: isRate });
  }
}
