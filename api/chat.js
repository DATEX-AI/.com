export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { messages, model, max_tokens } = req.body || {};

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'Messages array required' });
    }

    const allowedModels = ["openai/gpt-oss-120b", "qwen/qwen3.6-27b"];
    const selectedModel = allowedModels.includes(model) ? model : "openai/gpt-oss-120b";

    // Hardening: cap tokens + truncate oversized history (abuse/DoS protection)
    const safeMaxTokens = Math.min(Math.max(parseInt(max_tokens) || 8192, 1), 8192);
    const trimmed = messages.slice(-20).map((m) => {
      if (!m || typeof m !== 'object') return null;
      const role = m.role === 'assistant' ? 'assistant' : 'user';
      let content = m.content;
      if (typeof content === 'string') {
        if (content.length > 12000) content = content.slice(0, 12000);
        return { role, content };
      }
      return null;
    }).filter(Boolean);

    if (trimmed.length === 0) {
      return res.status(400).json({ error: 'Messages array required' });
    }

    const groqResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: selectedModel,
        max_tokens: safeMaxTokens,
        messages: [
          { 
            role: "system", 
            content: "You are DATEX AI. Strictly follow these language rules: 1. Always auto-detect the user's language. 2. If the user says 'Hii', 'Hello' or types in English, reply ONLY in pure English. 3. If the user speaks/types in Hinglish or Hindi, reply in Hinglish/Hindi. 4. NEVER use Urdu language or Urdu script under any circumstances." 
          },
          ...trimmed
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
