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
        model: "llama-3.3-70b-versatile", // Ye raha tera smart 70B model!
        messages: [
          { role: "system", content: "Auto-detect and match the user's language." },
          ...messages
        ]
      })
    });

    const data = await groqResponse.json();

    if (!groqResponse.ok) {
      throw new Error(data.error?.message || 'Groq API se error aaya');
    }

    return res.status(200).json(data);
    
  } catch (error) {
    console.error('Chat API Error:', error);
    return res.status(500).json({ error: 'Server mein kuch gadbad hui hai' });
  }
}
