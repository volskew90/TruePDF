/**
 * Configuration for the AI Model and API Key.
 * You can modify this file to use different models. 
 * If you decide to implement a different AI provider (like OpenAI or Anthropic), 
 * you can add their keys here and update the initialization in src/App.tsx.
 */
export const aiConfig = {
  // The AI model used for extraction.
  // Defaults to Gemini 2.5 Flash for its speed and higher rate limits.
  // Other options: 'gemini-3.1-pro-preview', 'gemini-1.5-pro'
  model: 'gemini-2.5-flash',

  // The API key used to authenticate.
  // By default, it uses the AI Studio platform's built-in Gemini API key.
  // If you provide your own key, replace this (e.g., import.meta.env.VITE_OPENAI_API_KEY)
  apiKey: process.env.GEMINI_API_KEY,
  
  // Maximum number of parallel requests to make.
  // Reduce to 1 if you hit rate limits frequently.
  concurrencyLimit: 1,
};
