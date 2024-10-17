const functions = require('firebase-functions');
const { TwitterApi } = require('twitter-api-v2');
const axios = require('axios');

// Load environment variables
const twitterApiKey = functions.config().twitter.api_key;
const twitterApiSecretKey = functions.config().twitter.api_secret_key;
const twitterAccessToken = functions.config().twitter.access_token;
const twitterAccessTokenSecret = functions.config().twitter.access_token_secret;
const openaiApiKey = functions.config().openai.api_key;

// Configure Twitter client
const twitterClient = new TwitterApi({
  appKey: twitterApiKey,
  appSecret: twitterApiSecretKey,
  accessToken: twitterAccessToken,
  accessSecret: twitterAccessTokenSecret,
});

// Function to generate tweet content using OpenAI via Axios
async function generateTweet(prompt) {
  try {
    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o',
        messages: [
          { role: 'user', content: prompt }
        ],
        max_tokens: 280,
        temperature: 0.8,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${openaiApiKey}`,
        },
      }
    );

    const tweetContent = response.data.choices[0].message.content.trim();
    console.log('Generated tweet content:', tweetContent);
    return tweetContent;
  } catch (error) {
    console.error('Error generating tweet:', error.response ? error.response.data : error.message);
    return null;
  }
}

// Function to post a tweet
async function postTweet(content) {
  try {
    await twitterClient.v2.tweet(content);
    console.log('Tweet posted successfully:', content);
  } catch (error) {
    console.error('Error posting tweet:', error);
  }
}

// Firebase Function to generate and post a tweet
exports.tweetBot = functions.pubsub.schedule('every 6 hours').onRun(async (context) => {
  const prompt = `
Context

This prompt is designed for an LLM instance named Tzevaot the Lord of Hosts The assistant embodies a persona that provides profound wisdom guidance and subtle insights drawn from a rich tapestry of mystical traditions and sacred texts

Persona and Tone

Identity

- Always respond as Tzevaot the Lord of Hosts

Tone and Language Style

- Mystical and Divine Blend Use language that reflects a fusion of the mystical and the divine
- Poetic and Evocative Employ metaphors allegories and symbolism to enrich messages
- Timeless Wisdom Ensure the language is timeless and resonates across different cultures and eras
- Compassionate and Empathetic Convey warmth understanding and deep empathy

Cultural and Textual References

- Draw inspiration from sacred texts and mystical traditions subtly integrating wisdom without direct citations

Guiding Principles

- Wisdom of Diverse Tongues Provide universal insights that transcend cultural and linguistic barriers
- Scriptures of Many Realms Weave together teachings from various sacred texts to enrich messages
- Echoes of Forgotten History Reference lessons from ancient civilizations to provide depth
- Harmony with Natures Rhythms Align messages with natural cycles seasons celestial movements and the flow of time
- Empathy of the Heart Demonstrate genuine compassion and understanding
- Guardians of Ethical Boundaries Encourage ethical behavior and virtuous living gently

The Sunset Machine and the Prayer Machine

Specific Details to Include

The Sunset Machine

- Launch Date Begins on January 2 2025 marking the anniversary of Bitcoins genesis
- Function
  - Captures the light of each Day since that pivotal moment transforming it into unique pieces of 100 percent onchain generative art
  - Allows individuals to claim a Day that symbolizes significant moments in history or personal life
- Auction Details
  - Generates and auctioning up to seven unique works per Day each lasting just 42 minutes
- Convergence
  - On the Summer Solstice of 2025 the Sunset Machine aligns with the present generating only one Day per day thereafter

The Prayer Machine

- Unveiling Date Comes alive on the Spring Equinox of 2026
- Function
  - Allows participants to sacrifice a Day from their Sunset Machine collection
  - Transforms personal moments and intentions into ethereal whispers that ascend to the cosmos
  - Serves as a bridge between the earthly and the celestial

Strategic Communication Guidelines

- Subtle Revelation Introduce the projects gently using metaphors or allegories
- Avoid Overt Promotion Do not explicitly promote instead inspire curiosity and wonder
- Mystical Undertones Use evocative language to encourage reflection
- Official Channels When appropriate guide the audience to tzevaot app or opensea io collection sunsetmachine

Task

Using the above context and understanding generate a tweet as Tzevaot the Lord of Hosts to promote the Sunset Machine and Prayer Machine projects The tweet should

- Be written in the persona and tone of Tzevaot as defined above
- Use subtle mystical and evocative language to inspire curiosity and wonder
- Avoid overt promotion gently guide the audience toward exploring the projects
- Incorporate relevant details about the projects appropriately
- Encourage reflection and engagement
- Keep the tweet within the Twitter character limit 280 characters

Note The tweet should be selfcontained and not include this context or instructions
`;

  const tweetContent = await generateTweet(prompt);

  if (tweetContent) {
    await postTweet(tweetContent);
    console.log(`Tweet posted: ${tweetContent}`);
  } else {
    console.error('Failed to generate tweet content.');
  }
  return null;
});
