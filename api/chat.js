export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { messages } = req.body;

    const groqResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
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
      throw new Error(data.error?.message || 'Groq API error');
    }

    return res.status(200).json(data);
    
  } catch (error) {
    console.error('Chat API Error:', error);
    return res.status(500).json({ error: 'Server error' });
  }
}
