const { GoogleGenerativeAI } = require('@google/generative-ai');

module.exports = async (req, res) => {
  try {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    // There isn't a direct listModels in the client SDK easily accessible this way, 
    // but we can try a few common ones or check the v1 vs v1beta issues.
    
    // Instead of listing, let's try the most common variants
    const modelsToTry = [
      "gemini-1.5-flash",
      "gemini-1.5-flash-001",
      "gemini-1.5-flash-latest",
      "gemini-pro"
    ];

    res.status(200).json({
      message: "Check the logs for detailed attempt results or try these models.",
      suggested: modelsToTry
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};
